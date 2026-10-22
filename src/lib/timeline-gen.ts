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
  const cancels = r() < 0.25;
  if (cancels) {
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
  // R21: flexible subscriptions are sometimes paused (credit pending, invoiced or none) and resumed later, with the
  // cycle restarting or the old anchor kept. Drawn only in flexible mode, so classic seeds stay reproducible.
  if (mode === "flexible" && first.type === "subscribe" && !cancels && r() < 0.35) {
    t += step(1, 20);
    events.push({ at: at(), type: "pause", proration_behavior: pick([undefined, undefined, "always_invoice", "none"] as const) });
    t += step(1, 45);
    const resume: TimelineEvent = { at: at(), type: "resume" };
    if (r() < 0.5) resume.billing_cycle_anchor = "unchanged";
    events.push(resume);
  }
  t += int(35, 70) * 86_400_000;
  events.push({ at: at(), type: "advance_to" });
  // R23: a customer balance credit or debit somewhere in the timeline. Drawn last, so earlier draws (and the
  // timelines of seeds from before R23) are unchanged apart from this event.
  if (r() < 0.3) {
    const i = int(1, events.length - 1);
    // A day after the event before it: an adjustment in the same second as an immediate cancellation lands on its
    // final invoice in Stripe, an ordering this generator does not aim at.
    const when = Date.parse(events[i - 1].at) + 86_400_000;
    const amount = pick([-1, 1]) * int(1, 200) * 100;
    if (when < Date.parse(events[i].at)) events.splice(i, 0, { at: new Date(when).toISOString().replace(".000", ""), type: "adjust_balance", amount });
  }
  // R21 (S115, S117), drawn last for the same reason: a coupon applied while paused, and an unchanged resume moved onto
  // a billing date (the anchor's day and time in the resume's month) when nothing has moved the anchor.
  const p = events.findIndex((e) => e.type === "pause");
  if (p >= 0 && events[p + 1]?.type === "resume") {
    const [pause, resume] = [Date.parse(events[p].at), Date.parse(events[p + 1].at)];
    if (r() < 0.3 && resume - pause > 2 * 86_400_000)
      events.splice(p + 1, 0, { at: new Date(pause + 86_400_000).toISOString().replace(".000", ""), type: "apply_coupon", coupon: pick(g.coupons) });
    const res = events.find((e) => e.type === "resume")!;
    const moved = events.some((e) => e.type === "reset_anchor") || first.billing_cycle_anchor;
    if (r() < 0.4 && res.billing_cycle_anchor === "unchanged" && !moved) {
      const a = new Date(first.at), d = new Date(res.at);
      const on = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, a.getUTCDate(), a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds());
      if (new Date(on).getUTCDate() === a.getUTCDate() && on < Date.parse(events.at(-1)!.at) - 86_400_000 && !events.some((e) => e !== res && Date.parse(e.at) > Date.parse(res.at) && Date.parse(e.at) <= on && e.type !== "advance_to"))
        res.at = new Date(on).toISOString().replace(".000", "");
    }
  }
  return events;
}

// R7: a metered (graduated tiers) subscription with usage across one to three periods, sometimes a coupon or tax, a
// switch to or from a licensed price (classic only: flexible rejects it) and a cancellation.
export function generateMetered(seed: number, mode: BillingMode = "classic"): TimelineEvent[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  let t = Date.UTC(pick([2027, 2028]), int(0, 5), int(1, 28));
  const at = () => new Date(t).toISOString().replace(".000", "");
  const startsMetered = mode === "flexible" || r() < 0.7;
  const first: TimelineEvent = { at: at(), type: "subscribe", price: startsMetered ? "api_metered_m" : pick(["starter_m", "pro_m"]) };
  if (mode === "flexible") first.billing_mode = mode;
  if (r() < 0.3) first.coupon = pick(["SAVE20", "FOREVER25", "TENOFF3"]);
  if (r() < 0.3) first.tax_rate = pick(["tax10_ex", "vat20_in"]);
  const events = [first];
  let metered = startsMetered;
  const usage = () => metered && events.push({ at: at(), type: "report_usage", quantity: pick([0, int(1, 1000), int(1001, 10000), int(10001, 30000)]) });
  for (let i = int(1, 3); i > 0; i--) {
    t += int(2, 25) * 86_400_000;
    usage();
  }
  if (mode === "classic" && r() < 0.4) {
    t += int(1, 20) * 86_400_000;
    metered = !metered;
    events.push({ at: at(), type: "change_price", price: metered ? "api_metered_m" : pick(["starter_m", "pro_m"]) });
    t += int(1, 10) * 86_400_000;
    usage();
  }
  if (r() < 0.35) {
    t += int(1, 15) * 86_400_000;
    const c: TimelineEvent = { at: at(), type: r() < 0.5 ? "cancel_now" : "cancel_at_period_end" };
    if (c.type === "cancel_now" && r() < 0.6) c.proration_behavior = "always_invoice";
    events.push(c);
  }
  t += int(35, 70) * 86_400_000;
  events.push({ at: at(), type: "advance_to" });
  return events;
}

// R22: a trial with no card that ends canceled or paused; a paused one is resumed later (classic only with the old
// anchor, R22) and sometimes changed afterwards. Plan changes during the trial bill nothing until it ends.
export function generateNoCard(seed: number, mode: BillingMode = "classic"): TimelineEvent[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const g = r() < 0.8 ? GROUPS[0] : GROUPS[1];
  let t = Date.UTC(pick([2027, 2028]), int(0, 5), int(1, 28));
  const at = () => new Date(t).toISOString().replace(".000", "");
  const days = int(7, 30);
  const trialEnd = t + days * 86_400_000;
  const first: TimelineEvent = { at: at(), type: "start_trial", price: pick(g.prices), quantity: int(1, 5), trial_days: days, trial_end_behavior: pick(["cancel", "pause"] as const) };
  if (mode === "flexible") first.billing_mode = mode;
  if (r() < 0.4) first.tax_rate = pick(["tax10_ex", "vat20_in"]);
  if (r() < 0.3) first.coupon = pick(g.coupons);
  const events = [first];
  if (r() < 0.4) {
    t += int(1, days - 1) * 86_400_000;
    events.push(r() < 0.5 ? { at: at(), type: "change_quantity", quantity: int(1, 8) } : { at: at(), type: "change_price", price: pick(g.prices) });
  }
  t = trialEnd;
  if (first.trial_end_behavior === "pause") {
    t += int(1, 60) * 86_400_000;
    events.push({ at: at(), type: "resume", ...(mode === "classic" || r() < 0.5 ? { billing_cycle_anchor: "unchanged" } : {}) });
    for (let i = int(0, 2); i > 0; i--) {
      t += int(3, 40) * 86_400_000;
      events.push(r() < 0.5 ? { at: at(), type: "change_quantity", quantity: int(1, 8) } : { at: at(), type: "change_price", price: pick(g.prices) });
    }
  }
  t += int(35, 70) * 86_400_000;
  events.push({ at: at(), type: "advance_to" });
  return events;
}
