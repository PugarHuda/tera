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
    let discount = 0;
    if (sub.coupon && sub.coupon.remaining > 0 && subtotal > 0) {
      const c = catalog.coupons![sub.coupon.code];
      discount = c.percent_off != null ? roundMinor((subtotal * c.percent_off) / 100) : Math.min(c.amount_off ?? 0, subtotal);
      sub.coupon.remaining -= 1;
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
    });
    draft = null;
  };

  const openInvoice = (s: Sub, at: number, lines: InvoiceLine[]) => {
    draft = { at, periodStart: s.periodStart, periodEnd: s.periodEnd, lines };
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
  const prorate = (s: Sub, at: number, oldAmount: number, newAmount: number): InvoiceLine[] => {
    const remaining = s.periodEnd - at;
    const period = s.periodEnd - s.periodStart;
    return [
      { description: "Unused time", amount: -roundMinor((oldAmount * remaining) / period), proration: true },
      { description: "Remaining time", amount: roundMinor((newAmount * remaining) / period), proration: true },
    ];
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
          taxRate: e.tax_rate ? taxRate(e.tax_rate) : null,
          pending: [],
          usage: 0,
        };
        if (e.coupon) applyCoupon(sub, e.coupon);
        openInvoice(sub, at, [{ description: trial ? "Trial" : `${e.price} × ${sub.quantity}`, amount: trial ? 0 : licensedAmount(sub), proration: false }]);
        break;
      }
      case "change_price":
      case "change_quantity": {
        if (!sub) throw new Error(`${e.type} before subscribe`);
        const s: Sub = sub;
        const oldAmount = licensedAmount(s);
        const oldInterval = price(s.priceId).interval;
        if (e.type === "change_price") s.priceId = e.price!;
        else s.quantity = e.quantity!;
        const p = price(s.priceId);
        const newAmount = licensedAmount(s);
        if (p.interval !== oldInterval) {
          // R3: interval change resets the anchor and invoices now.
          const credit = prorate(s, at, oldAmount, 0)[0];
          s.periodStart = at;
          s.anchorDay = new Date(at).getUTCDate();
          s.periodEnd = addInterval(at, p.interval, s.anchorDay);
          openInvoice(s, at, [...s.pending, credit, { description: `${s.priceId} × ${s.quantity}`, amount: newAmount, proration: false }]);
          s.pending = [];
        } else {
          const lines = prorate(s, at, oldAmount, newAmount);
          if (e.proration_behavior === "always_invoice") openInvoice(s, at, lines);
          else s.pending.push(...lines);
        }
        break;
      }
      case "apply_coupon":
        if (!sub) throw new Error("apply_coupon before subscribe");
        applyCoupon(sub, e.coupon!);
        break;
      case "report_usage":
        if (!sub) throw new Error("report_usage before subscribe");
        sub.usage += e.quantity ?? 0;
        break;
      case "cancel_at_period_end":
        if (!sub) throw new Error("cancel before subscribe");
        sub.cancelAtPeriodEnd = true;
        break;
      case "advance_to":
        break;
    }
  }
  finalize();

  function applyCoupon(s: Sub, code: string) {
    const c = catalog.coupons?.[code];
    if (!c) throw new Error(`Unknown coupon: ${code}`);
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
