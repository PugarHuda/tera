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

// R16: Stripe defaults new subscriptions to flexible (API 2025-09-30.clover+); classic stays the engine default.
export const BILLING_MODES = ["classic", "flexible"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

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
    | "resume"
    | "end_trial"
    | "cancel_now"
    | "reset_anchor"
    | "remove_coupon"
    | "cancel_at"
    | "pause"
    | "adjust_balance"
    | "advance_to";
  price?: string;
  quantity?: number;
  coupon?: string;
  tax_rate?: string;
  trial_days?: number;
  proration_behavior?: ProrationBehavior;
  /** subscribe: first billing date (Stripe `billing_cycle_anchor`), ISO-8601 UTC; the time before it is prorated (R20).
   *  resume of a paused subscription: "now" (default, a new period starts) or "unchanged" (R21). */
  billing_cycle_anchor?: string;
  /** cancel_at: when the subscription ends (Stripe `cancel_at`), ISO-8601 UTC. */
  cancel_at?: string;
  /** subscribe / start_trial: Stripe's billing mode for the new subscription (default classic). */
  billing_mode?: BillingMode;
  /** adjust_balance: a customer balance transaction in minor units; negative is a credit, positive a debit (R23). */
  amount?: number;
  /** start_trial: the customer has no card, and Stripe's trial_settings.end_behavior.missing_payment_method decides
   *  what happens when the trial ends: "cancel" or "pause" (R22). Omitted, the trial ends into a paid period. */
  trial_end_behavior?: TrialEndBehavior;
};

export const TRIAL_END_BEHAVIORS = ["cancel", "pause"] as const;
export type TrialEndBehavior = (typeof TRIAL_END_BEHAVIORS)[number];

export const PRORATION_BEHAVIORS = ["create_prorations", "always_invoice", "none"] as const;
export type ProrationBehavior = (typeof PRORATION_BEHAVIORS)[number];

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
  status: "active" | "trialing" | "paused" | "canceled" | "none";
  canceled_at: string | null;
};

const DAY = 86_400_000;

// R18: Stripe's minimum charge per currency, in minor units (docs.stripe.com/currencies). ponytail: keyed by the
// invoice currency; Stripe applies the settlement currency's minimum after conversion, exact when they match.
const MIN_CHARGE: Record<string, number> = {
  usd: 50, aed: 200, aud: 50, brl: 50, cad: 50, chf: 50, czk: 1500, dkk: 250, eur: 50, gbp: 30, hkd: 400, huf: 17500,
  inr: 50, jpy: 50, krw: 50, mxn: 1000, myr: 200, nok: 300, nzd: 50, pln: 200, ron: 200, sek: 300, sgd: 50, thb: 1000, zar: 50,
};
export const minimumCharge = (currency: string) => MIN_CHARGE[currency.toLowerCase()] ?? 50;

// R1: round half away from zero (Math.round rounds -0.5 toward +inf).
export const roundMinor = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
// R6: the tax in one amount, rounded once (half away from zero).
const taxOf = (amount: number, r: TaxRate) => roundMinor((amount * r.percentage) / (r.behavior === "exclusive" ? 100 : 100 + r.percentage));
// R3: Stripe prorates the unit price to a 12-place decimal first, then multiplies by quantity and the paid rate,
// so `(qty × unit × rate − off) × num/den` is rounded once but from that decimal: 7900 × 19/30 = 5003.333333333333,
// and 3 seats at 75% credit 11257.4999… → 11257, not 11258 (fuzz seed 21001, S55). Exact BigInt arithmetic.
const MAX_AMOUNT = 1e12;
const E12 = 10n ** 12n;
const divRound = (a: bigint, b: bigint) => (a < 0n ? -1n : 1n) * ((2n * (a < 0n ? -a : a) + b) / (2n * b));
const divFloor = (a: bigint, b: bigint) => (a < 0n ? -((-a + b - 1n) / b) : a / b);

// R6 inclusive tax, Stripe's "invoice level" tax rounding (docs.stripe.com/billing/taxes/tax-rates#rounding): each
// line's taxable amount, amount / (1 + rate), is kept to 12 decimals (rounded down), the taxable amounts are summed,
// the rate is applied to that sum, and the result is rounded once, half away from zero. The 12-decimal floor decides
// ties: 1019 + 7900 -> 849.1666… + 6583.3333… = 7432.4999…, tax 1486 (fuzz seed 70012), while 387 = -322.5 + 645
// is a true tie, 65 (S90); -32258 + 51613 + 64000 JPY sums to 69462.4999…, tax 13892 (S93), in either billing mode.
function inclusiveTax(amounts: number[], percentage: number): number {
  const p = BigInt(Math.round(percentage * 1e4)); // ponytail: Stripe allows 4 decimals on a percentage
  const base = 100n * 10_000n;
  const taxable = amounts.reduce((sum, a) => sum + divFloor(BigInt(a) * E12 * base, base + p), 0n);
  return Number(divRound(taxable * p, base * E12));
}
export function prorated(item: { unit: number; qty: number }, paid: { rate: number; off: number }, num: number, den: number): number {
  const [n, d] = [BigInt(num), BigInt(den)];
  const unit = divRound(BigInt(item.unit) * n * E12, d); // unit × f, 12 decimals
  const rate = BigInt(Math.round(paid.rate * 1e6)); // ponytail: percent_off with ≤4 decimals is exact
  const off = divRound(BigInt(Math.round(paid.off)) * n * E12 * 1_000_000n, d);
  return Number(divRound(unit * BigInt(item.qty) * rate - off, E12 * 1_000_000n));
}

const toDate = (iso: string) => new Date(iso).getTime();
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

// R2: same day next interval, clamped to month length but keeping the anchor day.
// R3/R5: a proration charge for num/den of a period, as Stripe prices it with a coupon still active: the gross from
// the 12-decimal prorated unit price, less the discount, each rounded. A percent discount is taken off the *rounded*
// gross: 28542 x 25% = 7135.5 -> 7136 gives 21406 (fuzz 45005); 3135 x 25% = 783.75 -> 784 gives 2351 (S42). An
// amount_off discount is prorated itself: round(1000 x f). Flexible billing mode instead rounds the discount from the
// unrounded gross, like its credits: 865.96 x 25% = 216.49 -> 216 (fuzz seeds 60013, 60105; S88, S89).
export function chargeOf(item: { unit: number; qty: number }, paid: { rate: number; off: number }, num: number, den: number, flexible = false) {
  const gross = prorated(item, FULL_RATE, num, den);
  if (flexible) {
    const discount = prorated(item, { rate: 1 - paid.rate, off: -paid.off }, num, den);
    return { gross, discount, amount: gross - discount };
  }
  const pct = BigInt(Math.round((1 - paid.rate) * 1e6)); // ponytail: percent_off with ≤4 decimals is exact
  const discount = Number(divRound(BigInt(gross) * pct, 1_000_000n)) + prorated({ unit: Math.round(paid.off), qty: 1 }, FULL_RATE, num, den);
  return { gross, discount, amount: gross - discount };
}
const FULL_RATE = { rate: 1, off: 0 };

export function addInterval(t: number, interval: Interval, anchorDay: number, count = 1): number {
  const d = new Date(t);
  const y = d.getUTCFullYear() + (interval === "year" ? count : 0);
  const m = d.getUTCMonth() + (interval === "month" ? count : 0);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(anchorDay, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

type Sub = {
  priceId: string;
  quantity: number;
  anchorDay: number;
  periodStart: number;
  periodEnd: number;
  status: "active" | "trialing" | "paused" | "canceled";
  cancelAtPeriodEnd: boolean;
  /** R19: Stripe `cancel_at`, and the proration behavior it was set with. */
  cancelAt: number | null;
  cancelBehavior?: ProrationBehavior;
  /** remaining: invoices a once coupon still discounts; end: when a repeating coupon expires (R5, S50). */
  coupon: { code: string; remaining: number; end: number } | null;
  /** R5: discount the current amount was last charged at (period invoice or proration charge). */
  paid: Paid;
  taxRate: TaxRate | null;
  pending: InvoiceLine[];
  usage: number;
  /** R16: flexible billing mode credits original debits and never resets the anchor on its own. */
  mode: BillingMode;
  /** Billing cycle anchor; flexible aligns a new interval's period to it. */
  anchor: number;
  /** Flexible: what each still-unexpired span was debited (gross and its discount), credited back on a change. */
  debits: Debit[];
  /** Flexible: time already paid for by a debit Stripe will not charge again on resume: the period an unprorated (`none`)
   *  change was made in, or the period a `none` pause did not credit (R21). */
  coveredUntil?: number;
  /** R22: what the trial ends into when the customer has no card. */
  trialEnd?: TrialEndBehavior;
  /** R16: the interval a flexible `none` interval change switched to (see flexibleChange). */
  noneInterval?: Interval;
};

/** A span debited as `item` at discount `paid`; amounts are recomputed from the unit price, like R3. */
type Debit = { start: number; end: number; item: Item; paid: Paid };

type Item = { unit: number; qty: number };

/** A price paid as `amount × rate − off` per period: rate from percent_off, off from amount_off (minor units). */
type Paid = { rate: number; off: number };
const FULL: Paid = { rate: 1, off: 0 };

/** coupon: the subscription discount when the draft was created; Stripe copies it then (fuzz seed 24019, S57). */
type Draft = { at: number; periodStart: number; periodEnd: number; lines: InvoiceLine[]; coupon: Sub["coupon"]; paid?: Paid };

// Stripe finalizes a renewal draft about an hour after creating it; an invoice a change creates in that hour is
// finalized first, so it takes (or leaves) the customer balance before the renewal does (fuzz seed 78026, S105).
const DRAFT_MS = 3_600_000;

export function simulate(catalog: Catalog, timeline: TimelineEvent[]): SimulationResult {
  const invoices: Invoice[] = [];
  let sub: Sub | null = null;
  let draft: Draft | null = null;
  let canceledAt: number | null = null;
  let balance = 0; // R10: customer credit balance carried between invoices

  const price = (id: string) => {
    // Own keys only: "toString" or "constructor" must be unknown, not Object.prototype members.
    const p = Object.hasOwn(catalog.prices, id) ? catalog.prices[id] : null;
    if (!p) throw new Error(`Unknown price: ${id}`);
    return p;
  };
  const taxRate = (id: string) => {
    const r = catalog.tax_rates && Object.hasOwn(catalog.tax_rates, id) ? catalog.tax_rates[id] : null;
    if (!r) throw new Error(`Unknown tax rate: ${id}`);
    return r;
  };
  const item = (s: Sub): Item => {
    const p = price(s.priceId);
    const unit = p.usage_type === "metered" ? 0 : (p.unit_amount ?? 0);
    // Keeps every sum, tax and proration an exact integer in a double (sums of 100 events stay < 2^53).
    if (unit * s.quantity > MAX_AMOUNT) throw new Error(`${s.priceId} × ${s.quantity} exceeds ${MAX_AMOUNT.toLocaleString("en-US")} minor units per period`);
    return { unit, qty: s.quantity };
  };
  const licensedAmount = (s: Sub) => item(s).unit * item(s).qty;

  // Draft invoices finalize once time moves past them, with the discount they were created with: a coupon
  // applied or removed at the renewal instant changes the next invoice, not this one (S57).

  // Invoices are listed in creation order (as Stripe lists them), while the balance runs in finalization order.
  const created = new Map<number, number>();
  const finalize = () => {
    if (!draft || !sub) return;
    const subtotal = draft.lines.reduce((a, l) => a + l.amount, 0);
    // R5: proration lines are not discountable (they were already priced at the discounted rate).
    const discountable = draft.lines.filter((l) => !l.proration).reduce((a, l) => a + l.amount, 0);
    let discount = 0;
    const d = draft.coupon;
    const live = d && d.remaining > 0 && draft.at < d.end ? catalog.coupons![d.code] : null;
    if (live && discountable > 0) {
      const c = live;
      discount = c.percent_off != null ? roundMinor((discountable * c.percent_off) / 100) : Math.min(c.amount_off ?? 0, discountable);
      d!.remaining -= 1;
    }
    // Unless a change in the draft's hour already re-priced the subscription (its own s.paid is newer).
    if (discountable > 0 && (!draft.paid || sub.paid === draft.paid)) {
      const c = discount > 0 ? live : null;
      sub.paid = !c ? FULL : c.percent_off != null ? { rate: 1 - c.percent_off / 100, off: 0 } : { rate: 1, off: discount };
    }
    const taxable = subtotal - discount;
    // The invoice discount spread over its discountable lines (one, in practice), for per-line taxable amounts.
    const share = (l: InvoiceLine) => (discountable === 0 ? 0 : roundMinor((discount * l.amount) / discountable));
    let tax = 0;
    let total = taxable;
    const r = sub.taxRate;
    // R6: a negative (credit) invoice carries negative tax too.
    if (r && taxable !== 0) {
      // Exclusive: one computation on the total (757.7 -> 758, S94); the same invoice-level rule, as every taxable
      // amount is already a whole number.
      tax = r.behavior === "inclusive" ? inclusiveTax(draft.lines.map((l) => (l.proration ? l.amount : l.amount - share(l))), r.percentage) : taxOf(taxable, r);
      if (r.behavior === "exclusive") total = taxable + tax;
    }
    // R10: a negative invoice becomes credit; credit is consumed by later invoices. R18: an amount due below
    // Stripe's minimum charge is not collected; it is carried as a debit balance onto the next invoice (fuzz 41031).
    const starting_balance = balance;
    const owed = Math.max(0, total + starting_balance);
    const carried = owed > 0 && owed < minimumCharge(price(sub.priceId).currency);
    const amount_due = carried ? 0 : owed;
    balance = carried ? owed : Math.min(0, total + starting_balance);
    created.set(invoices.length, draft.at);
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
    const pending = draft;
    if (!immediate) {
      // A renewal draft claims a live "once" coupon when it is created, so a change at the same instant is not
      // discounted by it; the draft keeps its own copy (S57: later coupon changes do not reach it). Seed 61025, S95.
      const claims = s.coupon && s.coupon.remaining !== Infinity && liveCoupon(s, at) && lines.some((l) => !l.proration && l.amount > 0);
      s.paid = { ...s.paid }; // a fresh object, so finalize can tell whether a change re-priced it since
      draft = { at, periodStart: s.periodStart, periodEnd: s.periodEnd, lines, coupon: s.coupon && { ...s.coupon }, paid: s.paid };
      if (claims) s.coupon!.remaining -= 1;
      return;
    }
    draft = { at, periodStart: s.periodStart, periodEnd: s.periodEnd, lines, coupon: s.coupon };
    finalize();
    // A renewal drafted at this same instant stays a draft and finalizes after it (Stripe order), so its
    // amount due can use the credit this invoice creates.
    draft = pending;
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
    // R21: a paused subscription generates no invoices until it resumes.
    while (sub && sub.status !== "canceled" && sub.status !== "paused" && Math.min(sub.periodEnd, sub.cancelAt ?? Infinity) <= t) {
      finalize();
      const s: Sub = sub;
      if (s.cancelAt !== null && s.cancelAt <= s.periodEnd) {
        cancelOn(s, s.cancelAt);
        break;
      }
      const at = s.periodEnd;
      if (s.cancelAtPeriodEnd) {
        // R8: no renewal, but prorations still pending (and metered usage) are billed on a final invoice.
        const final = [...s.pending, ...(price(s.priceId).usage_type === "metered" && s.usage > 0 ? usageLines(s) : [])];
        if (final.length) openInvoice(s, at, final, true);
        s.pending = [];
        s.status = "canceled";
        canceledAt = at;
        break;
      }
      if (s.status === "trialing" && s.trialEnd) {
        // R22: no card when the trial ends: Stripe cancels, or pauses with nothing invoiced (probes T1, T2, S96).
        s.status = s.trialEnd === "cancel" ? "canceled" : "paused";
        if (s.trialEnd === "cancel") canceledAt = at;
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
      s.paid = activeDiscount(s, licensedAmount(s), at); // what this period is charged, before the draft finalizes
      s.debits = [];
      if (s.cancelAt !== null && s.cancelAt < s.periodEnd && p.usage_type !== "metered") {
        // R19: the period that contains cancel_at is billed only up to it, as a proration priced like a
        // "Remaining time" charge (gross and discount rounded apart: 3950 - 988 = 2962), with or without "none".
        const part = chargeParts(s, at, at, s.cancelAt);
        lines.pop();
        lines.push({ description: "Time until cancellation", amount: part.item.unit - part.paid.off, proration: true });
        s.debits.push(part);
        s.periodEnd = s.cancelAt;
      } else debit(s, at);
      openInvoice(s, at, lines);
    }
  };

  /** The discount an active coupon gives an amount (percent → rate, amount_off → off, capped at the amount). */
  const activeDiscount = (s: Sub, amount: number, at: number): Paid => {
    const c = liveCoupon(s, at);
    return !c ? FULL : c.percent_off != null ? { rate: 1 - c.percent_off / 100, off: 0 } : { rate: 1, off: Math.min(c.amount_off ?? 0, amount) };
  };

  // R3: credit unused time on the old amount, charge remaining time on the new one.
  // R5: the credit refunds the net amount the current amount was actually charged (its coupon, even a used-up
  // "once"): round((amount × rate − off) × f). The remaining time is priced with the coupon still active, as
  // list minus discount, each rounded: round(amount × f) − round(discount × f); it becomes what the next credit
  // refunds. f = remaining / period. (Seed-312 fuzz case: the one-step rounding was a cent off.)
  // A "once" coupon that prices that charge is used up by it (the next invoice is not discounted).
  const prorate = (s: Sub, at: number, old: Item, charge = true): InvoiceLine[] => {
    const [num, den] = [s.periodEnd - at, s.periodEnd - s.periodStart];
    const c = liveCoupon(s, at);
    const next = charge ? item(s) : { unit: 0, qty: 0 };
    const newAmount = next.unit * next.qty;
    const now = activeDiscount(s, newAmount, at);
    const lines = [
      { description: "Unused time", amount: 0 - prorated(old, s.paid, num, den), proration: true }, // 0 - x: never -0 ("-$0.00")
      { description: "Remaining time", amount: chargeOf(next, now, num, den).amount, proration: true },
    ];
    if (c?.duration === "once" && newAmount > 0) s.coupon!.remaining = 0;
    s.paid = now;
    return lines;
  };

  const events = [...timeline].sort((a, b) => toDate(a.at) - toDate(b.at));

  for (const e of events) {
    const at = toDate(e.at);
    if (draft && at >= (draft as Draft).at + DRAFT_MS) finalize();
    renewUntil(at);
    if (draft && at >= (draft as Draft).at + DRAFT_MS) finalize();

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
          cancelAt: null,
          coupon: null,
          paid: FULL,
          taxRate: e.tax_rate ? taxRate(e.tax_rate) : null,
          pending: [],
          usage: 0,
          mode: e.billing_mode ?? "classic",
          anchor: trial ? periodEnd : at,
          debits: [],
          ...(trial && e.trial_end_behavior ? { trialEnd: e.trial_end_behavior } : {}),
        };
        if (e.coupon) applyCoupon(sub, e.coupon, at);
        if (e.billing_cycle_anchor !== undefined) {
          anchorAt(sub, at, toDate(e.billing_cycle_anchor), e);
          break;
        }
        if (!trial) debit(sub, at);
        // R16: flexible does not invoice a $0 metered item at creation (S59).
        if (sub.mode === "flexible" && !trial && p.usage_type === "metered") break;
        openInvoice(sub, at, [{ description: trial ? "Trial" : `${e.price} × ${sub.quantity}`, amount: trial ? 0 : licensedAmount(sub), proration: false }], true);
        break;
      }
      case "change_price":
      case "change_quantity": {
        const s = active(e.type);
        if (e.type === "change_price" && price(e.price!).currency !== price(s.priceId).currency)
          throw new Error(`Cannot switch currency (${price(s.priceId).currency} -> ${price(e.price!).currency}) on a subscription`);
        // A change to the same price and quantity is a no-op in Stripe: no prorations, nothing reset.
        // With always_invoice it still sweeps prorations pending from earlier changes into an invoice now (S43).
        if (e.type === "change_price" ? e.price === s.priceId && (e.quantity ?? s.quantity) === s.quantity : e.quantity === s.quantity) {
          // R16: flexible leaves pending items for the next invoice.
          if (s.mode === "classic" && e.proration_behavior === "always_invoice" && s.pending.length) {
            openInvoice(s, at, s.pending, true);
            s.pending = [];
          }
          break;
        }
        if (s.status === "trialing") {
          // R4: nothing was paid during the trial, so there is nothing to prorate; the new terms bill at trial end.
          const trialInterval = price(s.priceId).interval;
          if (e.type === "change_price") [s.priceId, s.quantity] = [e.price!, e.price === s.priceId ? (e.quantity ?? s.quantity) : (e.quantity ?? 1)];
          else s.quantity = e.quantity!;
          // Switching the interval mid-trial makes Stripe issue a fresh $0 trial invoice right away; flexible does
          // that for any change, as a change outside a trial gets its own line (R16).
          if (s.mode === "flexible" || price(s.priceId).interval !== trialInterval) openInvoice(s, at, [{ description: "Trial", amount: 0, proration: false }], true);
          break;
        }
        const old = item(s);
        const oldInterval = price(s.priceId).interval;
        // R13: like Stripe, a *different* price without a quantity resets the item to quantity 1.
        if (e.type === "change_price") [s.priceId, s.quantity] = [e.price!, e.price === s.priceId ? (e.quantity ?? s.quantity) : (e.quantity ?? 1)];
        else s.quantity = e.quantity!;
        const p = price(s.priceId);
        if (s.mode === "flexible") {
          flexibleChange(s, at, p.interval !== oldInterval, e.proration_behavior);
          if (e.proration_behavior === "none") s.coveredUntil = s.periodEnd;
          break;
        }
        if (p.interval !== oldInterval) {
          // R3: interval change resets the anchor and invoices now (R14: with "none", without the credit).
          restartPeriod(s, at, old, e.proration_behavior);
        } else if (e.proration_behavior !== "none") {
          // R14: with "none" nothing is prorated; the new amount bills from the next renewal, and a later
          // proration credits the item as it is then, not what was paid (Stripe probe, S44).
          const lines = prorate(s, at, old);
          if (e.proration_behavior === "always_invoice") openInvoice(s, at, lines, true);
          else s.pending.push(...lines);
        }
        break;
      }
      case "apply_coupon":
        applyCoupon(active(e.type), e.coupon!, at);
        break;
      case "report_usage": {
        const s = active(e.type);
        if (price(s.priceId).usage_type !== "metered") throw new Error(`report_usage needs a metered price; ${s.priceId} is licensed`);
        s.usage += e.quantity ?? 0;
        break;
      }
      case "cancel_at_period_end": {
        const s = active(e.type);
        [s.cancelAtPeriodEnd, s.cancelAt] = [true, null];
        break;
      }
      case "cancel_at": {
        // R19: cancel on a future date. Inside the current period: a final invoice at that date credits the time
        // after it (unless "none"); in a later period: renewals continue and the last one is cut short.
        const s = active(e.type);
        if (s.status === "trialing") throw new Error("cancel_at during a trial is not modelled: use cancel_now or end_trial first");
        const when = toDate(e.cancel_at ?? "");
        if (!(when > at)) throw new Error("cancel_at must be a date after the request");
        [s.cancelAt, s.cancelBehavior, s.cancelAtPeriodEnd] = [when, e.proration_behavior, false];
        break;
      }
      case "resume": {
        const r = active(e.type);
        if (r.status === "paused") {
          resumePaused(r, at, e);
          break;
        }
        // R8: undoing a scheduled cancellation (at period end or cancel_at); the subscription renews as before.
        [r.cancelAtPeriodEnd, r.cancelAt] = [false, null];
        break;
      }
      case "pause": {
        // R21: Stripe's pause (API 2026-09-30.endive) stops invoicing now. Flexible billing mode only, and not in a
        // trial. The period ends now; unused time is credited from each original debit like any flexible credit
        // (pending by default = invoicing_behavior pending_invoice_item; always_invoice = invoice; none =
        // bill_for.unused_time_from none), so a coupon-priced debit refunds net of its discount (S84).
        const s = active(e.type);
        if (s.mode !== "flexible") throw new Error("pause needs flexible billing mode (Stripe rejects pausing a classic subscription)");
        if (s.status === "trialing") throw new Error("pause during a trial: Stripe rejects it; use end_trial first");
        if (price(s.priceId).usage_type === "metered") throw new Error("pause with a metered price is not modelled");
        if (s.cancelAtPeriodEnd || s.cancelAt !== null) throw new Error("pause with a scheduled cancellation is not modelled: resume it first");
        if (e.proration_behavior !== "none") bill(s, at, creditDebits(s, at), e.proration_behavior);
        else s.coveredUntil = Math.max(s.coveredUntil ?? 0, s.periodEnd);
        s.debits = [];
        s.periodEnd = at;
        s.status = "paused";
        break;
      }
      case "end_trial": {
        // R4: ending a trial early (trial_end=now) starts the first paid period now and resets the anchor.
        const s = active(e.type);
        if (s.status !== "trialing") throw new Error("end_trial needs a subscription in trial");
        if (s.trialEnd) throw new Error("end_trial with a trial_end_behavior: the customer has no card to pay the first period");
        s.status = "active";
        s.periodStart = at;
        s.anchorDay = new Date(at).getUTCDate();
        s.periodEnd = addInterval(at, price(s.priceId).interval, s.anchorDay);
        s.paid = activeDiscount(s, licensedAmount(s), at);
        s.anchor = at;
        debit(s, at);
        openInvoice(s, at, [{ description: `${s.priceId} × ${s.quantity}`, amount: licensedAmount(s), proration: false }], true);
        break;
      }
      case "reset_anchor": {
        // R15: billing_cycle_anchor=now starts a full new period today, like an interval change (S51).
        const s = active(e.type);
        if (s.status === "trialing") throw new Error("reset_anchor during a trial: use end_trial");
        if (s.mode === "flexible") flexibleReset(s, at, e.proration_behavior);
        else restartPeriod(s, at, item(s), e.proration_behavior);
        break;
      }
      case "remove_coupon":
        // R5: future invoices are full price; what was already charged (s.paid) still prices the next credit.
        active(e.type).coupon = null;
        break;
      case "cancel_now": {
        // R8: immediate cancellation (Stripe's default: no final invoice, no proration credit). R17: with
        // always_invoice (Stripe prorate + invoice_now) a final invoice now carries the pending prorations and
        // the unused-time credit, priced like any other credit in the mode (classic: what was paid; flexible:
        // each original debit). create_prorations leaves the credit pending on a canceled subscription, unbilled.
        const s = active(e.type);
        if (e.proration_behavior === "always_invoice" && s.status === "active") {
          const lines = [...s.pending, ...(s.mode === "flexible" ? creditDebits(s, at) : [prorate(s, at, item(s), false)[0]])];
          if (lines.length) openInvoice(s, at, lines, true);
        }
        s.status = "canceled";
        s.pending = [];
        canceledAt = at;
        break;
      }
      case "adjust_balance":
        // R23: Stripe customer balance transaction. It changes the balance the next finalized invoice starts from
        // (R10): a credit lowers what is due, a debit is added to it (S103, S104).
        balance += e.amount!;
        break;
      case "advance_to":
        break;
    }
  }
  finalize();

  // R21: resume a paused subscription. billing_cycle_anchor "now" (Stripe's default) starts a new period now and
  // invoices it at once with anything pending, such as the pause credit (S80). "unchanged" keeps the old anchor: the
  // period containing `at` is charged from now to its end as a proration, left pending for the next renewal (S81).
  function resumePaused(s: Sub, at: number, e: TimelineEvent) {
    const anchor = e.billing_cycle_anchor ?? "now";
    if (anchor !== "now" && anchor !== "unchanged") throw new Error('resume of a paused subscription takes billing_cycle_anchor "now" or "unchanged"');
    // R22: a classic subscription is paused only by a trial ending without a card. Resuming it with anchor "now" makes
    // Stripe void the new invoice and leave it paused (probe T2), so only "unchanged" is modelled there.
    if (s.mode === "classic" && anchor === "now") throw new Error('resume of a classic subscription paused at trial end: Stripe voids the invoice an anchor "now" creates; use billing_cycle_anchor "unchanged"');
    s.status = "active";
    const interval = price(s.priceId).interval;
    const covered = s.coveredUntil ?? 0;
    if (anchor === "now") {
      s.periodStart = at;
      s.anchor = at;
      s.anchorDay = new Date(at).getUTCDate();
      s.periodEnd = addInterval(at, interval, s.anchorDay);
      s.paid = activeDiscount(s, licensedAmount(s), at);
      if (covered <= at) {
        debit(s, at);
        openInvoice(s, at, [...s.pending, { description: `${s.priceId} × ${s.quantity}`, amount: licensedAmount(s), proration: false }], true);
        s.pending = [];
        return;
      }
      // Part of the new period is still paid for (a `none` pause or change): nothing is invoiced now; the rest of the
      // period is a pending proration from where that coverage ends (seed 60134: "Time on ... after 24 Mar", S91).
      if (covered < s.periodEnd) charge(s, at, covered, e.proration_behavior);
      return;
    }
    let k = 0;
    while (addInterval(s.anchor, interval, s.anchorDay, k + 1) <= at) k++;
    s.periodStart = addInterval(s.anchor, interval, s.anchorDay, k);
    s.periodEnd = addInterval(s.anchor, interval, s.anchorDay, k + 1);
    if (s.periodStart === at) throw new Error('resume with billing_cycle_anchor "unchanged" exactly on a billing date is not modelled');
    // Open question: with a month-end anchor (day 31, period 06-30 -> 07-31) Stripe charged 8 days as 6295 of 23700,
    // not 8/31 = 6116, and no length fits (probe M1; day 15 prorates normally, M2). Rejected rather than guessed.
    if (s.anchorDay > 28) throw new Error('resume with billing_cycle_anchor "unchanged" on a month-end anchor (day 29-31) is not modelled');
    s.paid = activeDiscount(s, licensedAmount(s), at);
    // Time a debit still pays for is not charged again: after a `none` change or a `none` pause in this period,
    // resuming in it charges nothing (S86, probes Q1, Q5, P3, seed 60105); a later period is charged (S87).
    if (covered < s.periodEnd) charge(s, at, Math.max(at, covered), e.proration_behavior);
  }

  // Resuming: charge [from, period end) as a pending proration (the discount off the unrounded gross, S88).
  function charge(s: Sub, at: number, from: number, behavior: ProrationBehavior | undefined) {
    if (behavior === "none") return;
    const parts = chargeParts(s, at, from, s.periodEnd);
    const line = { description: "Time after resuming", amount: parts.item.unit - parts.paid.off, proration: true };
    // A charge a coupon makes free is still a debit, credited later as a $0 line (S78), and it still uses up a "once"
    // coupon, like any remaining-time charge (R3): the next renewal is not discounted (fuzz seeds 70016, 71010, 71023,
    // 74022; S100, S101).
    if (parts.item.unit !== 0) s.debits.push(parts);
    if (liveCoupon(s, at)?.duration === "once" && parts.item.unit > 0) s.coupon!.remaining = 0;
    bill(s, at, [line], behavior);
  }

  // Credit the unused time (unless "none"), move the anchor to now and invoice the full new period at once.
  function restartPeriod(s: Sub, at: number, old: Item, behavior: ProrationBehavior | undefined) {
    const credit = behavior === "none" ? [] : [prorate(s, at, old, false)[0]];
    s.periodStart = at;
    s.anchorDay = new Date(at).getUTCDate();
    s.periodEnd = addInterval(at, price(s.priceId).interval, s.anchorDay);
    s.paid = activeDiscount(s, licensedAmount(s), at);
    s.anchor = at;
    s.debits = [];
    debit(s, at);
    openInvoice(s, at, [...s.pending, ...credit, { description: `${s.priceId} × ${s.quantity}`, amount: licensedAmount(s), proration: false }], true);
    s.pending = [];
  }

  // R20: a first billing date after the start (Stripe billing_cycle_anchor at creation). The stub from the start is
  // prorated over one interval counted from the start (start 05-31, anchor 06-13: 13 of 05-31 -> 06-30's 30 days,
  // fuzz 45015; start 02-10: 23 of 28) and billed now like a remaining-time charge (S74); a "once" coupon is used up
  // by it. With "none" nothing is billed until the anchor. Stripe rejects an anchor more than one period ahead.
  function anchorAt(s: Sub, at: number, when: number, e: TimelineEvent) {
    const p = price(s.priceId);
    if (e.type !== "subscribe") throw new Error("billing_cycle_anchor is only modelled on subscribe");
    if (p.usage_type === "metered") throw new Error("billing_cycle_anchor with a metered price is not modelled");
    if (!(when > at) || when > addInterval(at, p.interval, new Date(at).getUTCDate()))
      throw new Error("billing_cycle_anchor must be after the start and at most one billing period ahead");
    s.anchor = when;
    s.anchorDay = new Date(when).getUTCDate();
    s.periodEnd = when;
    // Classic: the stub period is as long as one interval from the start, ending on the anchor, so every proration
    // before the anchor divides by that length (S77). Flexible: it is the anchor-aligned period ending on the anchor
    // (start 03-05, anchor 03-22 in 2028: 02-22 -> 03-22 = 29 days, not 31; fuzz seeds 60008, 60015, 60035).
    s.periodStart =
      s.mode === "flexible"
        ? addInterval(when, p.interval, s.anchorDay, -1)
        : when - (addInterval(at, p.interval, new Date(at).getUTCDate()) - at);
    if (e.proration_behavior === "none") return;
    const part = chargeParts(s, at, at, when);
    const amount = part.item.unit - part.paid.off;
    // A stub an amount_off coupon makes free is still invoiced, at $0, and still uses up a "once" coupon (fuzz
    // seed 80012, S106), like a free resume charge (S101).
    if (part.item.unit === 0) return;
    if (liveCoupon(s, at)?.duration === "once") s.coupon!.remaining = 0;
    s.paid = activeDiscount(s, licensedAmount(s), at);
    s.debits.push(part);
    openInvoice(s, at, [{ description: "Time until the first billing date", amount, proration: true }], true);
  }

  // R19: the subscription ends at `when` (its cancel_at). Pending prorations, unbilled usage and (unless "none")
  // the credit for the time after it go on a final invoice dated then (S71).
  function cancelOn(s: Sub, when: number) {
    const credit = s.cancelBehavior !== "none" && when < s.periodEnd ? (s.mode === "flexible" ? creditDebits(s, when) : [prorate(s, when, item(s), false)[0]]) : [];
    const lines = [...s.pending, ...(price(s.priceId).usage_type === "metered" && s.usage > 0 ? usageLines(s) : []), ...credit];
    if (lines.length) openInvoice(s, when, lines, true);
    s.pending = [];
    s.status = "canceled";
    canceledAt = when;
  }

  // Record [start, periodEnd) as debited at the current price and discount (gross and discount apart).
  function debit(s: Sub, start: number) {
    if (licensedAmount(s) === 0) return;
    s.debits.push({ start, end: s.periodEnd, item: item(s), paid: activeDiscount(s, licensedAmount(s), start) });
  }

  // R16: one credit per original debit still covering time after `at` (Stripe: "credit prorations use the original
  // debited amount", S52/S54): gross and discount are rounded apart, each from the 12-decimal prorated unit price,
  // over that debit's own span: 3 × 7900 × 19/30 = 15010 less 25% of it = 3752.4999… → 3752 gives 11258 (S55).
  // Only time up to the item's current period end is credited: after a `none` yearly -> monthly change, a later
  // change credits the yearly debit up to the monthly period end, not to its own end (fuzz 41027).
  function creditDebits(s: Sub, at: number, until = s.periodEnd): InvoiceLine[] {
    const lines = s.debits
      .filter((d) => Math.min(d.end, until) > Math.max(at, d.start))
      .map((d) => {
        const [num, den] = [Math.min(d.end, until) - Math.max(at, d.start), d.end - d.start];
        const amount = prorated(d.item, FULL, num, den) - prorated(d.item, { rate: 1 - d.paid.rate, off: -d.paid.off }, num, den);
        // Kept at 0 too: a debit made free by a coupon is still credited, as a $0 line (fuzz seed 44012).
        const line = { description: "Unused time", amount: 0 - amount, proration: true };
        return line;
      });
    s.debits = [];
    return lines;
  }

  // R16 flexible change: the anchor stays; a new interval takes that interval's period containing `at`, aligned to
  // the anchor (monthly -> yearly on Jan 16 under a Jan 1 anchor bills Jan 1 -> Jan 1, S54). Nothing is invoiced
  // unless always_invoice; with "none" nothing is credited or debited, so the old debit is what a later change credits.
  function flexibleChange(s: Sub, at: number, intervalChanged: boolean, behavior: ProrationBehavior | undefined) {
    const oldEnd = s.periodEnd;
    if (intervalChanged) {
      const interval = price(s.priceId).interval;
      // Not modelled (rejected): switching back, with prorations, to the interval of an earlier `none` interval change.
      // Stripe then charged the new price only to the end of the current shorter period (yearly at 10-17 charged
      // 10-17 -> 10-18 and nothing after), which no rule here explains (fuzz seed 81005).
      if (behavior !== "none" && s.noneInterval === interval)
        throw new Error(`an interval change back to ${interval} with prorations after a "none" change to ${interval} is not modelled (flexible mode)`);
      if (behavior === "none") s.noneInterval = interval;
      let k = 0;
      // Before an R20 first billing date the anchor is still ahead: the aligned period then started before it
      // (start 06-01, anchor 06-24, yearly at 06-09: 2026-06-24 -> 2027-06-24, renewing on the anchor; fuzz 77004).
      while (addInterval(s.anchor, interval, s.anchorDay, k) > at) k--;
      while (addInterval(s.anchor, interval, s.anchorDay, k + 1) <= at) k++;
      s.periodStart = addInterval(s.anchor, interval, s.anchorDay, k);
      s.periodEnd = addInterval(s.anchor, interval, s.anchorDay, k + 1);
    }
    if (behavior === "none") return;
    const credits = creditDebits(s, at, oldEnd);
    const parts = chargeParts(s, at, at, s.periodEnd);
    const charge = { ...prorate(s, at, { unit: 0, qty: 0 })[1], amount: parts.item.unit - parts.paid.off };
    if (charge.amount !== 0) s.debits.push(parts);
    bill(s, at, [...credits, ...(charge.amount !== 0 ? [charge] : [])], behavior);
  }

  // R16 flexible billing_cycle_anchor=now: the credit and debit for the overlap cancel out, so only the time past
  // the old period end is debited, as a proration (S51); "none" bills nothing at all (S52).
  function flexibleReset(s: Sub, at: number, behavior: ProrationBehavior | undefined) {
    const oldEnd = s.periodEnd;
    s.periodStart = at;
    s.anchor = at;
    s.anchorDay = new Date(at).getUTCDate();
    s.periodEnd = addInterval(at, price(s.priceId).interval, s.anchorDay);
    if (behavior === "none" || s.periodEnd <= oldEnd) return;
    const parts = chargeParts(s, at, oldEnd, s.periodEnd);
    const charge = { description: "Remaining time", amount: parts.item.unit - parts.paid.off, proration: true };
    s.debits.push(parts);
    bill(s, at, [charge], behavior);
  }

  // A proration charge at `at` for [from, to) of the current period, kept as its rounded gross and rounded
  // discount: a later credit rounds each of them again (2806 − 702 = 2104; 4/10 of it is 1122 − 281 = 841, not
  // round(841.6), fuzz seed 40005).
  function chargeParts(s: Sub, at: number, from: number, to: number): Debit {
    const [num, den] = [to - from, s.periodEnd - s.periodStart];
    const { gross, discount } = chargeOf(item(s), activeDiscount(s, licensedAmount(s), at), num, den, s.mode === "flexible");
    return { start: from, end: to, item: { unit: gross, qty: 1 }, paid: { rate: 1, off: discount } };
  }

  // always_invoice invoices the lines (and anything pending) now; otherwise they wait for the next invoice.
  function bill(s: Sub, at: number, lines: InvoiceLine[], behavior: ProrationBehavior | undefined) {
    if (behavior === "always_invoice") {
      openInvoice(s, at, [...s.pending, ...lines], true);
      s.pending = [];
    } else s.pending.push(...lines);
  }

  // An invoice exactly at a repeating coupon's end is no longer discounted (3 months = 3 monthly invoices).
  function liveCoupon(s: Sub, at: number): Coupon | null {
    return s.coupon && s.coupon.remaining > 0 && at < s.coupon.end ? catalog.coupons![s.coupon.code] : null;
  }

  function active(type: string): Sub {
    if (!sub) throw new Error(`${type} before subscribe`);
    if (sub.status === "canceled") throw new Error(`${type} after the subscription was canceled on ${isoDay(canceledAt!)}`);
    if (sub.status === "paused" && type !== "resume" && type !== "cancel_now") throw new Error(`${type} while paused is not modelled: resume first`);
    return sub;
  }

  function applyCoupon(s: Sub, code: string, at: number) {
    const c = catalog.coupons && Object.hasOwn(catalog.coupons, code) ? catalog.coupons[code] : null;
    if (!c) throw new Error(`Unknown coupon: ${code}`);
    const currency = price(s.priceId).currency;
    if (c.amount_off != null && c.currency && c.currency.toLowerCase() !== currency.toLowerCase())
      throw new Error(`Coupon ${code} is in ${c.currency.toUpperCase()} but the subscription bills in ${currency.toUpperCase()} (currency mismatch)`);
    // R5/I3: idempotent while the coupon is still active; a used-up coupon applied again starts afresh (as in Stripe).
    if (s.coupon?.code === code && liveCoupon(s, at)) return;
    // A repeating coupon lasts duration_in_months of calendar time from when it is applied, not that many
    // invoices: a yearly -> monthly switch inside the window gets discounted renewals until it ends (S50).
    const end = c.duration === "repeating" ? addInterval(at, "month", new Date(at).getUTCDate(), c.duration_in_months ?? 1) : Infinity;
    s.coupon = { code, remaining: c.duration === "once" ? 1 : Infinity, end };
  }

  const finalSub = sub as Sub | null;
  const order = invoices.map((_, i) => i).sort((a, b) => created.get(a)! - created.get(b)!); // stable: ties keep finalization order
  return {
    invoices: order.map((i) => invoices[i]),
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
