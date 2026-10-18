// Seeded random customer timelines, shared by the Stripe differential fuzzer (scripts/fuzz-parity.mts)
// and the local invariant property test (billing.test.ts).
import type { BillingMode, TimelineEvent } from "./billing";

// mulberry32: tiny deterministic PRNG so a failing case is reproducible from its seed.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const GROUPS = [
  { prices: ["starter_m", "pro_m", "team_seat_m", "pro_y"], coupons: ["SAVE20", "FOREVER25", "TENOFF3", "FIFTYOFF"] },
  { prices: ["basic_m_jpy", "premium_m_jpy"], coupons: ["SAVE20", "FOREVER25"] },
];

export function generate(seed: number, mode: BillingMode = "classic"): TimelineEvent[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const g = r() < 0.8 ? GROUPS[0] : GROUPS[1];
  // Month-end anchors (29th-31st, Feb 29 in 2028) and non-midnight times (Stripe prorates by the second).
  const [year, month] = [pick([2027, 2028]), int(0, 5)];
  let t = r() < 0.3 ? Date.UTC(year, month + 1, 0) : Date.UTC(year, month, int(1, 28));
  const clock = r() < 0.3; // events at random times of day
  const step = (lo: number, hi: number) => int(lo, hi) * 86_400_000 + (clock ? int(0, 86_399) * 1000 : 0);
  const at = () => new Date(t).toISOString().replace(".000", "");
  const first: TimelineEvent = { at: at(), type: r() < 0.2 ? "start_trial" : "subscribe", price: pick(g.prices), quantity: int(1, 5) };
  if (mode === "flexible") first.billing_mode = mode; // after the draws above, so classic seeds stay reproducible
  if (first.type === "start_trial") first.trial_days = int(7, 30);
  else if (r() < 0.5) first.coupon = pick(g.coupons);
  if (r() < 0.4) first.tax_rate = pick(["tax10_ex", "vat20_in"]);
  // R20: some subscriptions bill on a fixed day within the first period (prorated now, or not with "none").
  if (first.type === "subscribe" && !first.price!.includes("metered") && r() < 0.2) {
    first.billing_cycle_anchor = new Date(t + int(1, 27) * 86_400_000).toISOString().replace(".000", "");
    if (r() < 0.3) first.proration_behavior = "none";
  }
  const events = [first];
  if (first.type === "start_trial" && r() < 0.5) {
    t += step(1, first.trial_days! - 1);
    events.push({ at: at(), type: "end_trial" });
  }
  for (let i = int(1, 3); i > 0; i--) {
    t += step(3, 40);
    const kind = pick(["change_quantity", "change_price", "change_price", "apply_coupon", "reset_anchor", "remove_coupon"] as const);
    const e: TimelineEvent = { at: at(), type: kind };
    if (kind === "change_quantity") e.quantity = int(1, 8);
    if (kind === "change_price") {
      e.price = pick(g.prices);
      if (r() < 0.6) e.quantity = int(1, 5);
    }
    if (kind === "apply_coupon") e.coupon = pick(g.coupons);
    if (kind !== "apply_coupon" && kind !== "remove_coupon") e.proration_behavior = pick([undefined, undefined, "always_invoice", "none"]);
    events.push(e);
  }
  if (r() < 0.25) {
    t += step(1, 20);
    events.push({ at: at(), type: r() < 0.3 ? "cancel_now" : "cancel_at_period_end" });
    // R17: half the immediate cancellations refund the unused time (prorate + invoice_now).
    if (events.at(-1)!.type === "cancel_now" && r() < 0.5) events.at(-1)!.proration_behavior = "always_invoice";
    // R19: some scheduled cancellations are on a date (this period or a later one) instead of the period end.
    else if (events.at(-1)!.type === "cancel_at_period_end" && r() < 0.4) {
      const c = events.at(-1)!;
      [c.type, c.cancel_at] = ["cancel_at", new Date(t + step(2, 70)).toISOString().replace(".000", "")];
      if (r() < 0.3) c.proration_behavior = "none";
    }
    if (events.at(-1)!.type === "cancel_at_period_end" && r() < 0.4) {
      t += step(1, 5);
      events.push({ at: at(), type: "resume" });
    }
  }
  t += int(35, 70) * 86_400_000;
  events.push({ at: at(), type: "advance_to" });
  return events;
}
