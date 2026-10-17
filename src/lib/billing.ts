// Tera billing engine. Pure, deterministic, no I/O. Rules: docs/PRD.md §4.

export type Interval = "month" | "year";

export type Tier = { up_to: number | null; unit_amount_decimal: string };

export type Price = {
  currency: string;
  unit_amount?: number;
  interval: Interval;
  usage_type?: "licensed" | "metered";
  billing_scheme?: "per_unit" | "tiered";
  tiers?: Tier[];
};

export type Coupon = {
  percent_off?: number;
  amount_off?: number;
  currency?: string;
  duration: "once" | "repeating" | "forever";
  duration_in_months?: number;
};

export type TaxRate = { percentage: number; behavior: "inclusive" | "exclusive" };

export type Catalog = {
  prices: Record<string, Price>;
  coupons?: Record<string, Coupon>;
  tax_rates?: Record<string, TaxRate>;
};

export type TimelineEvent = {
  at: string;
  type:
    | "subscribe"
    | "start_trial"
    | "change_price"
    | "change_quantity"
    | "apply_coupon"
    | "report_usage"
    | "cancel_at_period_end"
    | "advance_to";
  price?: string;
  quantity?: number;
  coupon?: string;
  tax_rate?: string;
  trial_days?: number;
  proration_behavior?: "create_prorations" | "always_invoice";
};

export type InvoiceLine = { description: string; amount: number; proration: boolean };

export type Invoice = {
  date: string;
  currency: string;
  period_start: string;
  period_end: string;
  lines: InvoiceLine[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  /** R10: customer balance before this invoice (negative = credit, Stripe convention). */
  starting_balance: number;
  /** What the card is charged: total minus available credit, never below zero. */
  amount_due: number;
};

export type SimulationResult = {
  invoices: Invoice[];
  status: "active" | "trialing" | "canceled" | "none";
  canceled_at: string | null;
};

const DAY = 86_400_000;

// R1: round half away from zero (Math.round rounds -0.5 toward +inf).
export const roundMinor = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

const toDate = (iso: string) => new Date(iso).getTime();
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// R2: same day next interval, clamped to month length but keeping the anchor day.
export function addInterval(t: number, interval: Interval, anchorDay: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear() + (interval === "year" ? 1 : 0);
  const m = d.getUTCMonth() + (interval === "month" ? 1 : 0);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(anchorDay, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

type Sub = {
  priceId: string;
  quantity: number;
  anchorDay: number;
  periodStart: number;
  periodEnd: number;
  status: "active" | "trialing" | "canceled";
  cancelAtPeriodEnd: boolean;
  coupon: { code: string; remaining: number } | null;
  /** R5: share of list price the current amount was last charged at (period invoice or proration debit). */
  paidRate: number;
  taxRate: TaxRate | null;
  pending: InvoiceLine[];
  usage: number;
};

type Draft = { at: number; periodStart: number; periodEnd: number; lines: InvoiceLine[] };

export function simulate(catalog: Catalog, timeline: TimelineEvent[]): SimulationResult {
  const invoices: Invoice[] = [];
  let sub: Sub | null = null;
  let draft: Draft | null = null;
  let canceledAt: number | null = null;
  let balance = 0; // R10: customer credit balance carried between invoices

  const price = (id: string) => {
    const p = catalog.prices[id];
    if (!p) throw new Error(`Unknown price: ${id}`);
    return p;
  };
  const taxRate = (id: string) => {
    const r = catalog.tax_rates?.[id];
    if (!r) throw new Error(`Unknown tax rate: ${id}`);
    return r;
  };
  const licensedAmount = (s: Sub) => {
    const p = price(s.priceId);
    return p.usage_type === "metered" ? 0 : (p.unit_amount ?? 0) * s.quantity;
  };

  // Draft invoices stay editable until time moves past them (a same-instant coupon still applies).
  const finalize = () => {
    if (!draft || !sub) return;
    const subtotal = draft.lines.reduce((a, l) => a + l.amount, 0);
    // R5: proration lines are not discountable (they were already priced at the discounted rate).
    const discountable = draft.lines.filter((l) => !l.proration).reduce((a, l) => a + l.amount, 0);
    let discount = 0;
    if (sub.coupon && sub.coupon.remaining > 0 && discountable > 0) {
      const c = catalog.coupons![sub.coupon.code];
      discount = c.percent_off != null ? roundMinor((discountable * c.percent_off) / 100) : Math.min(c.amount_off ?? 0, discountable);
      sub.coupon.remaining -= 1;
    }
    if (discountable > 0) {
      const c = discount > 0 ? catalog.coupons![sub.coupon!.code] : null;
      sub.paidRate = c?.percent_off != null ? 1 - c.percent_off / 100 : 1;
    }
    const taxable = subtotal - discount;
    let tax = 0;
    let total = taxable;
    const r = sub.taxRate;
    if (r && taxable > 0) {
      if (r.behavior === "exclusive") {
        tax = roundMinor((taxable * r.percentage) / 100);
        total = taxable + tax;
      } else {
        tax = roundMinor((taxable * r.percentage) / (100 + r.percentage));
      }
    }
    // R10: a negative invoice becomes credit; credit is consumed by later invoices.
    const starting_balance = balance;
    const amount_due = Math.max(0, total + starting_balance);
    balance = Math.min(0, total + starting_balance);
    invoices.push({
      date: isoDay(draft.at),
      currency: price(sub.priceId).currency,
      period_start: isoDay(draft.periodStart),
      period_end: isoDay(draft.periodEnd),
      lines: draft.lines,
      subtotal,
      discount,
      tax,
      total,
      starting_balance,
      amount_due,
    });
    draft = null;
  };

  // Renewal invoices stay drafts until time moves on; invoices Stripe creates during an API call
  // (subscription creation, always_invoice, interval change) are finalized immediately.
  const openInvoice = (s: Sub, at: number, lines: InvoiceLine[], immediate = false) => {
    draft = { at, periodStart: s.periodStart, periodEnd: s.periodEnd, lines };
    if (immediate) finalize();
  };

  // R7: one line per tier, each rounded once.
  const usageLines = (s: Sub): InvoiceLine[] => {
    const tiers = price(s.priceId).tiers ?? [];
    let floor = 0;
    return tiers.map((t, i) => {
      const cap = t.up_to ?? Infinity;
      const units = Math.max(0, Math.min(s.usage, cap) - floor);
      floor = cap;
      return { description: `Usage tier ${i + 1}: ${units} units`, amount: roundMinor(units * Number(t.unit_amount_decimal)), proration: false };
    });
  };

  const renewUntil = (t: number) => {
    while (sub && sub.status !== "canceled" && sub.periodEnd <= t) {
      finalize();
      const s: Sub = sub;
      const at = s.periodEnd;
      if (s.cancelAtPeriodEnd) {
        s.status = "canceled";
        canceledAt = at;
        break;
      }
      const p = price(s.priceId);
      const lines = [...s.pending];
      if (p.usage_type === "metered") lines.push(...usageLines(s));
      else lines.push({ description: `${s.priceId} × ${s.quantity}`, amount: licensedAmount(s), proration: false });
      s.pending = [];
      s.usage = 0;
      s.status = "active";
      s.periodStart = at;
      s.periodEnd = addInterval(at, p.interval, s.anchorDay);
      openInvoice(s, at, lines);
    }
  };

  // R3: credit unused time on the old amount, charge remaining time on the new one.
  // R5: the credit refunds the rate the current amount was actually charged at (its percent_off coupon, even a
  // used-up "once"); the remaining time is priced at the percent_off coupon still active, and becomes the new paid rate.
  const prorate = (s: Sub, at: number, oldAmount: number, newAmount: number): InvoiceLine[] => {
    const remaining = s.periodEnd - at;
    const period = s.periodEnd - s.periodStart;
    const c = s.coupon && s.coupon.remaining > 0 ? catalog.coupons![s.coupon.code] : null;
    const rate = c?.percent_off != null ? 1 - c.percent_off / 100 : 1;
    const lines = [
      { description: "Unused time", amount: -roundMinor((oldAmount * s.paidRate * remaining) / period), proration: true },
      { description: "Remaining time", amount: roundMinor((newAmount * rate * remaining) / period), proration: true },
    ];
    s.paidRate = rate;
    return lines;
  };

  const events = [...timeline].sort((a, b) => toDate(a.at) - toDate(b.at));

  for (const e of events) {
    const at = toDate(e.at);
    if (draft && at > (draft as Draft).at) finalize();
    renewUntil(at);
    if (draft && at > (draft as Draft).at) finalize();

    switch (e.type) {
      case "subscribe":
      case "start_trial": {
        if (sub && (sub as Sub).status !== "canceled") throw new Error("Customer already has an active subscription (one subscription per customer)");
        const p = price(e.price!);
        const trial = e.type === "start_trial";
        const periodEnd = trial ? at + (e.trial_days ?? 0) * DAY : addInterval(at, p.interval, new Date(at).getUTCDate());
        sub = {
          priceId: e.price!,
          quantity: e.quantity ?? 1,
          anchorDay: new Date(trial ? periodEnd : at).getUTCDate(),
          periodStart: at,
          periodEnd,
          status: trial ? "trialing" : "active",
          cancelAtPeriodEnd: false,
          coupon: null,
          paidRate: 1,
          taxRate: e.tax_rate ? taxRate(e.tax_rate) : null,
          pending: [],
          usage: 0,
        };
        if (e.coupon) applyCoupon(sub, e.coupon);
        openInvoice(sub, at, [{ description: trial ? "Trial" : `${e.price} × ${sub.quantity}`, amount: trial ? 0 : licensedAmount(sub), proration: false }], true);
        break;
      }
      case "change_price":
      case "change_quantity": {
        const s = active(e.type);
        if (e.type === "change_price" && price(e.price!).currency !== price(s.priceId).currency)
          throw new Error(`Cannot switch currency (${price(s.priceId).currency} -> ${price(e.price!).currency}) on a subscription`);
        if (s.status === "trialing") {
          // R4: nothing was paid during the trial, so there is nothing to prorate; the new terms bill at trial end.
          if (e.type === "change_price") [s.priceId, s.quantity] = [e.price!, e.quantity ?? 1];
          else s.quantity = e.quantity!;
          break;
        }
        const oldAmount = licensedAmount(s);
        const oldInterval = price(s.priceId).interval;
        // R13: like Stripe, a new price without a quantity resets the item to quantity 1.
        if (e.type === "change_price") [s.priceId, s.quantity] = [e.price!, e.quantity ?? 1];
        else s.quantity = e.quantity!;
        const p = price(s.priceId);
        const newAmount = licensedAmount(s);
        if (p.interval !== oldInterval) {
          // R3: interval change resets the anchor and invoices now.
          const credit = prorate(s, at, oldAmount, 0)[0];
          s.periodStart = at;
          s.anchorDay = new Date(at).getUTCDate();
          s.periodEnd = addInterval(at, p.interval, s.anchorDay);
          openInvoice(s, at, [...s.pending, credit, { description: `${s.priceId} × ${s.quantity}`, amount: newAmount, proration: false }], true);
          s.pending = [];
        } else {
          const lines = prorate(s, at, oldAmount, newAmount);
          if (e.proration_behavior === "always_invoice") openInvoice(s, at, lines, true);
          else s.pending.push(...lines);
        }
        break;
      }
      case "apply_coupon":
        applyCoupon(active(e.type), e.coupon!);
        break;
      case "report_usage": {
        const s = active(e.type);
        if (price(s.priceId).usage_type !== "metered") throw new Error(`report_usage needs a metered price; ${s.priceId} is licensed`);
        s.usage += e.quantity ?? 0;
        break;
      }
      case "cancel_at_period_end":
        active(e.type).cancelAtPeriodEnd = true;
        break;
      case "advance_to":
        break;
    }
  }
  finalize();

  function active(type: string): Sub {
    if (!sub) throw new Error(`${type} before subscribe`);
    if (sub.status === "canceled") throw new Error(`${type} after the subscription was canceled on ${isoDay(canceledAt!)}`);
    return sub;
  }

  function applyCoupon(s: Sub, code: string) {
    const c = catalog.coupons?.[code];
    if (!c) throw new Error(`Unknown coupon: ${code}`);
    const currency = price(s.priceId).currency;
    if (c.amount_off != null && c.currency && c.currency.toLowerCase() !== currency.toLowerCase())
      throw new Error(`Coupon ${code} is in ${c.currency.toUpperCase()} but the subscription bills in ${currency.toUpperCase()} (currency mismatch)`);
    if (s.coupon?.code === code) return; // R5/I3: idempotent
    const remaining = c.duration === "once" ? 1 : c.duration === "repeating" ? (c.duration_in_months ?? 1) : Infinity;
    s.coupon = { code, remaining };
  }

  const finalSub = sub as Sub | null;
  return {
    invoices,
    status: finalSub ? finalSub.status : "none",
    canceled_at: canceledAt ? isoDay(canceledAt) : null,
  };
}

// R9. A customer is a seat count or a named account; annual prices count toward MRR as round(amount / 12) per customer.
export type MigrationCustomer = number | { name: string; seats: number };

export function migrate(input: {
  unit_amount: number;
  new_unit_amount: number;
  grandfather: boolean;
  customers: MigrationCustomer[];
  interval?: Interval;
}) {
  const months = input.interval === "year" ? 12 : 1;
  const mrr = (unit: number, seats: number) => roundMinor((unit * seats) / months);
  const per_customer = input.customers.map((c, i) => {
    const { name, seats } = typeof c === "number" ? { name: `customer ${i + 1}`, seats: c } : c;
    const mrr_before = mrr(input.unit_amount, seats);
    const mrr_after = input.grandfather ? mrr_before : mrr(input.new_unit_amount, seats);
    return { name, seats, mrr_before, mrr_after, mrr_delta: mrr_after - mrr_before };
  });
  const sum = (k: "mrr_before" | "mrr_after") => per_customer.reduce((a, c) => a + c[k], 0);
  const mrr_before = sum("mrr_before");
  const mrr_after = sum("mrr_after");
  return {
    affected: per_customer.filter((c) => c.mrr_delta !== 0).length,
    mrr_before,
    mrr_after,
    mrr_delta: mrr_after - mrr_before,
    per_customer,
  };
}

// R1 display: minor units → locale string; zero-decimal currencies show no separator (I4).
export function formatMoney(amount: number, currency: string, locale = "en-US"): string {
  const f = new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() });
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
  return f.format(amount / 10 ** digits);
}
