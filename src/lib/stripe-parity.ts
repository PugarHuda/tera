// FR4/FR5: replay a timeline in Stripe test mode with test clocks and compare invoices line by line.
// Server-only: needs STRIPE_SECRET_KEY (test mode). Never import from client components.
import Stripe from "stripe";
import { createHash } from "node:crypto";
import type { Catalog, Invoice, TimelineEvent } from "./billing";

// Stripe objects are keyed by id + a hash of their definition: same definition -> reused, changed definition -> new object.
const key = (prefix: string, id: string, def: unknown) => `${prefix}_${id}_${createHash("sha256").update(JSON.stringify(def)).digest("hex").slice(0, 10)}`;

export const STRIPE_API_VERSION = "2026-09-30.endive";

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  if (!key.startsWith("sk_test_")) throw new Error("Parity checks only run with a test-mode key (sk_test_…)");
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion, maxNetworkRetries: 3 });
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MONTH = 28 * 86_400; // advances are capped at 2 intervals of the shortest price; stay well under

/** FR5: create Tera's catalog in Stripe once (lookup keys / ids make it idempotent). */
export async function pushCatalog(stripe: Stripe, catalog: Catalog) {
  const prices: Record<string, string> = {};
  const wanted = Object.entries(catalog.prices);
  const lookup = Object.fromEntries(wanted.map(([id, p]) => [id, key("tera", id, p)]));
  const existing = await stripe.prices.list({ lookup_keys: Object.values(lookup), limit: 100 });
  for (const [id, k] of Object.entries(lookup)) {
    const found = existing.data.find((p) => p.lookup_key === k);
    if (found) prices[id] = found.id;
  }
  let meterId: string | null = null;
  for (const [id, p] of wanted) {
    if (p.usage_type === "metered") meterId ??= await ensureMeter(stripe);
    if (prices[id]) continue;
    const created =
      p.usage_type === "metered"
        ? await stripe.prices.create({
            lookup_key: lookup[id],
            currency: p.currency,
            recurring: { interval: p.interval, usage_type: "metered", meter: meterId! },
            billing_scheme: "tiered",
            tiers_mode: "graduated",
            tiers: (p.tiers ?? []).map((t) => ({ up_to: t.up_to ?? "inf", unit_amount_decimal: Stripe.Decimal.from(t.unit_amount_decimal) })),
            product_data: { name: `Tera ${id}` },
          })
        : await stripe.prices.create({
            lookup_key: lookup[id],
            currency: p.currency,
            unit_amount: p.unit_amount!,
            recurring: { interval: p.interval },
            product_data: { name: `Tera ${id}` },
          });
    prices[id] = created.id;
  }

  const coupons: Record<string, string> = {};
  for (const [code, c] of Object.entries(catalog.coupons ?? {})) {
    const id = key("TERA", code, c);
    try {
      await stripe.coupons.retrieve(id);
    } catch {
      await stripe.coupons.create({
        id,
        name: code,
        duration: c.duration,
        ...(c.duration === "repeating" ? { duration_in_months: c.duration_in_months } : {}),
        ...(c.percent_off != null ? { percent_off: c.percent_off } : { amount_off: c.amount_off, currency: c.currency }),
      });
    }
    coupons[code] = id;
  }

  const taxRates: Record<string, string> = {};
  const listed = await stripe.taxRates.list({ active: true, limit: 100 });
  for (const [id, r] of Object.entries(catalog.tax_rates ?? {})) {
    const name = key("tera", id, r);
    const found = listed.data.find((t) => t.display_name === name);
    taxRates[id] = found
      ? found.id
      : (await stripe.taxRates.create({ display_name: name, percentage: r.percentage, inclusive: r.behavior === "inclusive" })).id;
  }
  return { prices, coupons, taxRates, meterId };
}

// Concurrent replays share one push per catalog so they never race to create the same lookup key.
const pushes = new Map<string, ReturnType<typeof pushCatalog>>();
export function pushCatalogOnce(stripe: Stripe, catalog: Catalog) {
  const k = JSON.stringify(catalog);
  if (!pushes.has(k)) pushes.set(k, pushCatalog(stripe, catalog).catch((e) => (pushes.delete(k), Promise.reject(e))));
  return pushes.get(k)!;
}

export const METER_EVENT = "tera_api_calls";

// R7: usage-based prices bill from a Stripe Meter (sum of reported values per period).
async function ensureMeter(stripe: Stripe) {
  const meters = await stripe.billing.meters.list({ status: "active", limit: 100 });
  const found = meters.data.find((m) => m.event_name === METER_EVENT);
  if (found) return found.id;
  const m = await stripe.billing.meters.create({
    display_name: "Tera API calls",
    event_name: METER_EVENT,
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
  });
  return m.id;
}

// Meter events aggregate asynchronously; wait until Stripe has counted them before the period closes.
async function waitForUsage(stripe: Stripe, meterId: string, customer: string, from: number, to: number, expected: number) {
  for (let i = 0; i < 90; i++) {
    const s = await stripe.billing.meters.listEventSummaries(meterId, { customer, start_time: from, end_time: to });
    const total = s.data.reduce((a, x) => a + x.aggregated_value, 0);
    if (total >= expected) return;
    await sleep(2000);
  }
  throw new Error(`Stripe did not aggregate ${expected} metered units in time`);
}

async function advance(stripe: Stripe, clockId: string, from: number, to: number) {
  for (let t = from; t < to; ) {
    t = Math.min(to, t + MONTH);
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: t });
    for (let i = 0; i < 120; i++) {
      const c = await stripe.testHelpers.testClocks.retrieve(clockId);
      if (c.status === "ready") break;
      if (c.status === "internal_failure") throw new Error(`Test clock ${clockId} failed while advancing`);
      await sleep(1000);
    }
  }
}

export type ParityInvoice = Pick<Invoice, "date" | "currency" | "subtotal" | "discount" | "tax" | "total"> & {
  lines: { description: string; amount: number; proration: boolean }[];
  amount_due: number;
  starting_balance: number;
  id: string;
};

/** Replay a timeline against Stripe and return the invoices Stripe produced. */
export async function replayInStripe(stripe: Stripe, catalog: Catalog, timeline: TimelineEvent[]) {
  const ids = await pushCatalogOnce(stripe, catalog);
  const events = [...timeline].sort((a, b) => sec(a.at) - sec(b.at));
  const start = sec(events[0].at);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start, name: `tera ${new Date().toISOString()}` });
  const customer = await stripe.customers.create({ test_clock: clock.id, name: "Tera parity customer", payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } });

  let now = start;
  let sub: Stripe.Subscription | null = null;
  let usage = { from: start, total: 0 };
  for (const e of events) {
    const at = sec(e.at);
    const periodEnd = sub?.items.data[0].current_period_end;
    if (usage.total > 0 && periodEnd && at >= periodEnd) {
      // Summaries are minute-aligned windows; the closing period's window ends exactly at period end.
      await waitForUsage(stripe, ids.meterId!, customer.id, usage.from, periodEnd, usage.total);
      usage = { from: periodEnd, total: 0 };
    }
    if (at > now) {
      await advance(stripe, clock.id, now, at);
      now = at;
    }
    switch (e.type) {
      case "subscribe":
      case "start_trial":
        sub = await stripe.subscriptions.create({
          // R12: Tera models Stripe's classic billing mode (new subscriptions default to flexible since 2025).
          billing_mode: { type: "classic" },
          customer: customer.id,
          items: [{ price: ids.prices[e.price!], ...(catalog.prices[e.price!].usage_type === "metered" ? {} : { quantity: e.quantity ?? 1 }) }],
          ...(e.coupon ? { discounts: [{ coupon: ids.coupons[e.coupon] }] } : {}),
          ...(e.tax_rate ? { default_tax_rates: [ids.taxRates[e.tax_rate]] } : {}),
          ...(e.type === "start_trial" ? { trial_end: at + (e.trial_days ?? 0) * 86_400 } : {}),
        });
        break;
      case "change_price":
      case "change_quantity": {
        const item = sub!.items.data[0];
        sub = await stripe.subscriptions.update(sub!.id, {
          items: [
            {
              id: item.id,
              ...(e.type === "change_price"
                ? { price: ids.prices[e.price!], ...(e.quantity !== undefined && catalog.prices[e.price!].usage_type !== "metered" ? { quantity: e.quantity } : {}) }
                : { quantity: e.quantity }),
            },
          ],
          proration_behavior: e.proration_behavior ?? "create_prorations",
        });
        break;
      }
      case "apply_coupon":
        sub = await stripe.subscriptions.update(sub!.id, { discounts: [{ coupon: ids.coupons[e.coupon!] }] });
        break;
      case "cancel_at_period_end":
        sub = await stripe.subscriptions.update(sub!.id, { cancel_at_period_end: true });
        break;
      case "report_usage":
        // The meter event carries the test clock's time, so it lands in the simulated period.
        await stripe.billing.meterEvents.create({
          event_name: METER_EVENT,
          timestamp: at,
          payload: { stripe_customer_id: customer.id, value: String(e.quantity ?? 0) },
        });
        usage.total += e.quantity ?? 0;
        break;
      case "advance_to":
        break;
    }
  }

  const invoices = await stripe.invoices.list({ customer: customer.id, limit: 100, expand: ["data.lines"] });
  const out: ParityInvoice[] = invoices.data
    .sort((a, b) => a.created - b.created)
    .map((inv) => ({
      id: inv.id!,
      date: day(inv.created),
      currency: inv.currency,
      lines: inv.lines.data.map((l) => ({
        description: l.description ?? "",
        amount: l.amount,
        proration: Boolean(l.parent?.subscription_item_details?.proration ?? l.parent?.invoice_item_details?.proration),
      })),
      subtotal: inv.subtotal,
      discount: (inv.total_discount_amounts ?? []).reduce((a, d) => a + d.amount, 0),
      tax: (inv.total_taxes ?? []).reduce((a, t) => a + t.amount, 0),
      total: inv.total,
      amount_due: inv.amount_due,
      starting_balance: inv.starting_balance,
    }));
  return { clockId: clock.id, customerId: customer.id, invoices: out };
}

export type InvoiceDiff = { invoice: number; field: string; tera: unknown; stripe: unknown };

/** Line-by-line comparison; line order within an invoice is normalised (Stripe orders prorations differently). */
export function diffInvoices(tera: Invoice[], stripe: ParityInvoice[]): InvoiceDiff[] {
  const diffs: InvoiceDiff[] = [];
  if (tera.length !== stripe.length) diffs.push({ invoice: 0, field: "invoice count", tera: tera.length, stripe: stripe.length });
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  for (let i = 0; i < Math.min(tera.length, stripe.length); i++) {
    const t = tera[i];
    const s = stripe[i];
    const checks: Array<[string, unknown, unknown]> = [
      ["date", t.date, s.date],
      ["currency", t.currency, s.currency],
      ["lines", sorted(t.lines.map((l) => l.amount)), sorted(s.lines.map((l) => l.amount))],
      ["subtotal", t.subtotal, s.subtotal],
      ["discount", t.discount, s.discount],
      ["tax", t.tax, s.tax],
      ["total", t.total, s.total],
      ["starting_balance", t.starting_balance, s.starting_balance],
      ["amount_due", t.amount_due, s.amount_due],
    ];
    for (const [field, a, b] of checks) if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ invoice: i + 1, field, tera: a, stripe: b });
  }
  return diffs;
}

// A live replay creates real test-mode objects and advances a test clock, so it is throttled (per instance)
// and custom timelines are kept small enough to finish inside the route's maxDuration.
// No parameter properties: scripts run this file with Node's type stripping, which rejects them.
export class Cooldown extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`A live Stripe replay ran moments ago; retry in ${retryAfter}s`);
    this.retryAfter = retryAfter;
  }
}
export const LIVE_MAX_EVENTS = 15;
const LIVE_MAX_SPAN_MS = 2 * 366 * 86_400_000;
const COOLDOWN_MS = 30_000;
let lastLiveRun = 0;

/** Throws a plain Error for timelines too big to replay live (callers map it to 400). */
export function checkLiveLimits(timeline: TimelineEvent[]) {
  if (timeline.length > LIVE_MAX_EVENTS) throw new Error(`a live Stripe replay is limited to ${LIVE_MAX_EVENTS} events`);
  const times = timeline.map((e) => Date.parse(e.at));
  if (Math.max(...times) - Math.min(...times) > LIVE_MAX_SPAN_MS) throw new Error("a live Stripe replay may span at most 2 years");
}

/** Replay in Stripe and diff against Tera's invoices (the caller has already simulated and validated). */
export async function liveParity(catalog: Catalog, timeline: TimelineEvent[], tera: Invoice[]) {
  const wait = lastLiveRun + COOLDOWN_MS - Date.now();
  if (wait > 0) throw new Cooldown(Math.ceil(wait / 1000));
  lastLiveRun = Date.now();
  const replay = await replayInStripe(stripeClient(), catalog, timeline);
  const diffs = diffInvoices(tera, replay.invoices);
  return { match: diffs.length === 0, diffs, tera, stripe: replay.invoices, test_clock: replay.clockId, ran_at: new Date().toISOString() };
}
