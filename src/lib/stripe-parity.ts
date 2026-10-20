// FR4/FR5: replay a timeline in Stripe test mode with test clocks and compare invoices line by line.
// Server-only: needs STRIPE_SECRET_KEY (test mode). Never import from client components.
import Stripe from "stripe";
import { createHash } from "node:crypto";
import type { Catalog, Coupon, Invoice, SimulationResult, TimelineEvent, Webhook } from "./billing";

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

/** The webhook event types Tera predicts; others (charges, payment intents, customer.updated, customer.discount.*) are
 * not compared. */
export const WEBHOOK_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoiceitem.created",
] as const;

/** Replay a timeline against Stripe and return the invoices Stripe produced; with `events`, also the webhook events each
 * timeline event caused (the clock advance up to it included), oldest first. */
export async function replayInStripe(stripe: Stripe, catalog: Catalog, timeline: TimelineEvent[], opts: { events?: boolean } = {}) {
  const ids = await pushCatalogOnce(stripe, catalog);
  const events = [...timeline].sort((a, b) => sec(a.at) - sec(b.at));
  const start = sec(events[0].at);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start, name: `tera ${new Date().toISOString()}` });
  // R22: a trial with an end behavior is the no-card case; the card is added when the customer resumes.
  const noCard = events.some((e) => e.trial_end_behavior);
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    name: "Tera parity customer",
    ...(noCard ? {} : { payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } }),
  });

  // Events are read after each step from a cursor: the account's newest event before this customer existed.
  const steps: string[][] = [];
  let cursor = opts.events ? (await stripe.events.list({ limit: 1 })).data[0]?.id : undefined;
  const mine = (o: { customer?: unknown; id?: unknown }) => o.customer === customer.id || (o.customer as { id?: string } | null)?.id === customer.id;
  const collect = async () => {
    await sleep(1500); // events are written just after the API call returns
    const fresh: Stripe.Event[] = [];
    for await (const ev of stripe.events.list({ limit: 100, ...(cursor ? { ending_before: cursor } : {}) })) fresh.push(ev);
    fresh.sort((a, b) => a.created - b.created);
    if (fresh.length) cursor = fresh[fresh.length - 1].id;
    steps.push(fresh.filter((ev) => (WEBHOOK_TYPES as readonly string[]).includes(ev.type) && mine(ev.data.object as never)).map((ev) => ev.type));
  };

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
          // Stripe defaults new subscriptions to flexible; Tera's default (and every pre-R16 golden) is classic.
          billing_mode: { type: e.billing_mode ?? "classic" },
          customer: customer.id,
          items: [{ price: ids.prices[e.price!], ...(catalog.prices[e.price!].usage_type === "metered" ? {} : { quantity: e.quantity ?? 1 }) }],
          ...(e.coupon ? { discounts: [{ coupon: ids.coupons[e.coupon] }] } : {}),
          ...(e.tax_rate ? { default_tax_rates: [ids.taxRates[e.tax_rate]] } : {}),
          ...(e.type === "start_trial" ? { trial_end: at + (e.trial_days ?? 0) * 86_400 } : {}),
          ...(e.trial_end_behavior ? { trial_settings: { end_behavior: { missing_payment_method: e.trial_end_behavior } } } : {}),
          ...(e.billing_cycle_anchor ? { billing_cycle_anchor: sec(e.billing_cycle_anchor), proration_behavior: e.proration_behavior ?? "create_prorations" } : {}),
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
      case "resume":
        // The local copy is stale once a trial ended into a pause on the clock (R22).
        sub = await stripe.subscriptions.retrieve(sub!.id);
        if (sub.status === "paused" && noCard) {
          const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
          await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
        }
        // R21: a paused subscription resumes through its own endpoint; paid at once with the customer's card.
        // Classic (paused by R22) rejects payment_behavior.
        sub =
          sub.status === "paused"
            ? await stripe.subscriptions.resume(sub.id, {
                ...(sub.billing_mode?.type === "flexible" ? { payment_behavior: "resume_on_payment_success" as const } : {}),
                billing_cycle_anchor: { type: e.billing_cycle_anchor === "unchanged" ? "unchanged" : "now" },
                ...(e.proration_behavior ? { proration_behavior: e.proration_behavior } : {}),
              })
            : await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
        break;
      case "pause":
        // proration_behavior maps onto pause's billing knobs: none = no unused-time credit, always_invoice = invoice it now.
        sub = await stripe.subscriptions.pause(sub!.id, {
          type: "subscription",
          bill_for: { unused_time_from: { type: e.proration_behavior === "none" ? "none" : "now" } },
          invoicing_behavior: e.proration_behavior === "always_invoice" ? "invoice" : "pending_invoice_item",
        });
        break;
      case "end_trial":
        sub = await stripe.subscriptions.update(sub!.id, { trial_end: "now" });
        break;
      case "reset_anchor":
        sub = await stripe.subscriptions.update(sub!.id, { billing_cycle_anchor: { type: "now" }, proration_behavior: e.proration_behavior ?? "create_prorations" });
        break;
      case "cancel_at":
        sub = await stripe.subscriptions.update(sub!.id, { cancel_at: sec(e.cancel_at!), proration_behavior: e.proration_behavior ?? "create_prorations" });
        break;
      case "remove_coupon":
        sub = await stripe.subscriptions.update(sub!.id, { discounts: "" });
        break;
      case "cancel_now":
        // proration_behavior maps to Stripe's cancel params: always_invoice = prorate + invoice_now (final invoice
        // with the unused-time credit), create_prorations = prorate only; omitted/none = Stripe's default.
        sub = await stripe.subscriptions.cancel(
          sub!.id,
          e.proration_behavior === "always_invoice" ? { prorate: true, invoice_now: true } : e.proration_behavior === "create_prorations" ? { prorate: true } : {},
        );
        break;
      case "adjust_balance":
        // R23: a customer balance transaction, in the subscription's currency.
        await stripe.customers.createBalanceTransaction(customer.id, {
          amount: e.amount!,
          currency: catalog.prices[events.find((x) => x.price)!.price!].currency,
        });
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
    if (opts.events) await collect();
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
  return { clockId: clock.id, customerId: customer.id, invoices: out, events: steps };
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

export type WebhookDiff = { event: number; type: string; tera: number; stripe: number };

/** Per timeline event, how many of each webhook type Tera predicts and Stripe sent (order within a step is not compared:
 * Stripe writes several events in the same second). */
export function diffWebhooks(tera: Webhook[], stripe: string[][]): WebhookDiff[] {
  const diffs: WebhookDiff[] = [];
  stripe.forEach((all, event) => {
    const sent = all.filter((t) => (WEBHOOK_TYPES as readonly string[]).includes(t)); // recordings may hold more types
    const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
    const [t, s] = [count(tera.filter((w) => w.event === event).map((w) => w.type)), count(sent)];
    for (const type of new Set([...t.keys(), ...s.keys()])) if (t.get(type) !== s.get(type)) diffs.push({ event, type, tera: t.get(type) ?? 0, stripe: s.get(type) ?? 0 });
  });
  return diffs;
}

/** Replay in Stripe and diff against Tera's invoices and webhook events (the caller has already simulated and validated). */
export async function liveParity(catalog: Catalog, timeline: TimelineEvent[], sim: SimulationResult) {
  const tera = sim.invoices;
  const wait = lastLiveRun + COOLDOWN_MS - Date.now();
  if (wait > 0) throw new Cooldown(Math.ceil(wait / 1000));
  const stripe = stripeClient(); // a missing key is a config error, not a run that holds the cooldown
  lastLiveRun = Date.now();
  const replay = await replayInStripe(stripe, catalog, timeline, { events: true });
  const diffs = diffInvoices(tera, replay.invoices);
  const hookDiffs = diffWebhooks(sim.webhooks, replay.events);
  return {
    match: diffs.length === 0,
    diffs,
    tera,
    stripe: replay.invoices,
    webhooks: { match: hookDiffs.length === 0, diffs: hookDiffs, stripe: replay.events },
    test_clock: replay.clockId,
    ran_at: new Date().toISOString(),
  };
}

// FR3 from Stripe: the migration planner's customer base, read from the subscriptions on one price of the connected
// (test-mode) account instead of a typed or CSV seat list.
const PRICE_ID = /^price_[A-Za-z0-9]{1,64}$/;
const LIVE_STATUSES = new Set<string>(["active", "trialing", "past_due", "unpaid", "paused"]);
const MAX_SUBSCRIPTIONS = 100_000; // the planner's own limit (validate.ts)

/** Per-seat recurring prices the planner models: licensed, per unit, every one month or one year. */
function migratable(p: Stripe.Price): boolean {
  const r = p.recurring;
  return !!r && r.usage_type === "licensed" && r.interval_count === 1 && (r.interval === "month" || r.interval === "year") && p.billing_scheme === "per_unit" && (p.unit_amount ?? 0) > 0;
}

/** Active prices the planner can import from, newest first (Stripe's order), at most 200. */
export async function migratablePrices(stripe: Stripe) {
  const out: { id: string; name: string; lookup_key: string | null; unit_amount: number; currency: string; interval: "month" | "year" }[] = [];
  for await (const p of stripe.prices.list({ active: true, type: "recurring", limit: 100, expand: ["data.product"] })) {
    if (!migratable(p)) continue;
    const product = p.product;
    const name = typeof product === "object" && !product.deleted ? product.name : typeof product === "string" ? product : product.id;
    out.push({ id: p.id, name, lookup_key: p.lookup_key, unit_amount: p.unit_amount!, currency: p.currency, interval: p.recurring!.interval as "month" | "year" });
    if (out.length >= 200) break;
  }
  return out;
}

/** The planner's input from Stripe subscriptions on `price`: one customer per live subscription, its item's quantity as seats. */
export function migrationBase(price: Stripe.Price, subscriptions: Stripe.Subscription[]) {
  const customers: { name: string; seats: number }[] = [];
  let skipped = 0;
  for (const s of subscriptions) {
    const item = s.items.data.find((i) => i.price.id === price.id);
    // Canceled or never-paid (incomplete) subscriptions are not migrated; a quantity-0 item has no seats to reprice.
    if (!LIVE_STATUSES.has(s.status) || !item || !(item.quantity! >= 1)) {
      skipped++;
      continue;
    }
    const c = s.customer;
    const name = typeof c === "string" ? c : c.deleted ? c.id : c.name || c.email || c.id;
    customers.push({ name, seats: item.quantity! });
  }
  return { price: price.id, unit_amount: price.unit_amount!, currency: price.currency, interval: price.recurring!.interval as "month" | "year", customers, skipped };
}

/** Thrown for a price id the planner cannot import (callers map it to 400). */
export class NotMigratable extends Error {}

export async function subscribersOf(stripe: Stripe, priceId: string) {
  if (!PRICE_ID.test(priceId)) throw new NotMigratable("price must be a Stripe price id such as price_1Abc…");
  const price = await stripe.prices.retrieve(priceId);
  if (!migratable(price))
    throw new NotMigratable(`${priceId} is not a per-seat price the planner models (licensed, per unit, every month or year)`);
  const subscriptions: Stripe.Subscription[] = [];
  // Every status, so the skipped count is honest; expanded customers give names instead of cus_ ids.
  for await (const s of stripe.subscriptions.list({ price: priceId, status: "all", limit: 100, expand: ["data.customer"] })) {
    if (subscriptions.push(s) > MAX_SUBSCRIPTIONS) throw new NotMigratable(`${priceId} has more than ${MAX_SUBSCRIPTIONS} subscriptions`);
  }
  return migrationBase(price, subscriptions);
}

// FR5 the other way: the connected test-mode account's catalog as a Tera catalog, so the builder (and the simulator)
// can start from the prices, coupons and tax rates a team already has. Objects Tera pushed get their Tera id back.
const PUSHED = /^(?:tera|TERA)_(\w+?)(?:_[0-9a-f]{10})?$/; // older pushes had no definition hash
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "x";

/** The catalog's limits (validate.ts): 50 prices, 50 coupons, 20 tax rates. */
export function catalogFromStripe(prices: Stripe.Price[], coupons: Stripe.Coupon[], taxRates: Stripe.TaxRate[]) {
  const skipped = { prices: 0, coupons: 0, tax_rates: 0 };
  const catalog: Required<Catalog> = { prices: {}, coupons: {}, tax_rates: {} };
  // First one wins (Stripe lists newest first); another object with the same name gets _2, _3…
  const add = <T,>(into: Record<string, T>, name: string, value: T, max: number, kind: keyof typeof skipped) => {
    if (Object.keys(into).length >= max) return skipped[kind]++;
    const pushed = PUSHED.exec(name)?.[1];
    const base = pushed ?? slug(name);
    // An older push of the same Tera object is superseded by the newer one, and an exact copy is not a second object.
    if (Object.hasOwn(into, base) && (pushed || JSON.stringify(into[base]) === JSON.stringify(value))) return skipped[kind]++;
    let id = base;
    for (let n = 2; Object.hasOwn(into, id); n++) id = `${base}_${n}`;
    into[id] = value;
  };
  for (const p of prices) {
    // Only what the builder edits: per-seat prices every month or year (metered prices need a Stripe Meter id).
    if (!migratable(p)) {
      skipped.prices++;
      continue;
    }
    const product = typeof p.product === "object" && !p.product.deleted ? p.product.name : p.id;
    const name = p.lookup_key ?? `${product}_${p.recurring!.interval === "month" ? "m" : "y"}`;
    add(catalog.prices, name, { currency: p.currency, unit_amount: p.unit_amount!, interval: p.recurring!.interval as "month" | "year" }, 50, "prices");
  }
  for (const c of coupons) {
    const months = c.duration_in_months ?? 0;
    // ponytail: product-restricted coupons (applies_to, only returned when expanded) import as applying to every price.
    if (!c.valid || !["once", "repeating", "forever"].includes(c.duration) || (c.duration === "repeating" && !(months >= 1 && months <= 120)) || (c.percent_off == null && !(c.amount_off && c.currency))) {
      skipped.coupons++;
      continue;
    }
    const kc: Coupon = {
      duration: c.duration as Coupon["duration"],
      ...(c.duration === "repeating" ? { duration_in_months: months } : {}),
      ...(c.percent_off != null ? { percent_off: c.percent_off } : { amount_off: c.amount_off!, currency: c.currency! }),
    };
    add(catalog.coupons, PUSHED.test(c.id) ? c.id : (c.name ?? c.id), kc, 50, "coupons");
  }
  for (const t of taxRates) {
    if (!t.active || !(t.percentage >= 0 && t.percentage < 100)) {
      skipped.tax_rates++;
      continue;
    }
    add(catalog.tax_rates, PUSHED.test(t.display_name) ? t.display_name : `${t.display_name}_${t.percentage}`, { percentage: t.percentage, behavior: t.inclusive ? "inclusive" : "exclusive" }, 20, "tax_rates");
  }
  return { catalog, skipped };
}

export async function stripeCatalog(stripe: Stripe) {
  const all = async <T,>(list: AsyncIterable<T>, max = 500) => {
    const out: T[] = [];
    for await (const x of list) if (out.push(x) >= max) break;
    return out;
  };
  const [prices, coupons, taxRates] = await Promise.all([
    all(stripe.prices.list({ active: true, type: "recurring", limit: 100, expand: ["data.product"] })),
    all(stripe.coupons.list({ limit: 100 })),
    all(stripe.taxRates.list({ active: true, limit: 100 })),
  ]);
  return catalogFromStripe(prices, coupons, taxRates);
}
