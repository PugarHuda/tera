// FR4/FR5: replay a timeline in Stripe test mode with test clocks and compare invoices line by line.
// Server-only: needs STRIPE_SECRET_KEY (test mode). Never import from client components.
import Stripe from "stripe";
import type { Catalog, Invoice, TimelineEvent } from "./billing";

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
  const wanted = Object.entries(catalog.prices).filter(([, p]) => p.usage_type !== "metered");
  const existing = await stripe.prices.list({ lookup_keys: wanted.map(([id]) => `tera_${id}`), limit: 100 });
  for (const p of existing.data) prices[p.lookup_key!.slice(5)] = p.id;
  for (const [id, p] of wanted) {
    if (prices[id]) continue;
    const created = await stripe.prices.create({
      lookup_key: `tera_${id}`,
      currency: p.currency,
      unit_amount: p.unit_amount!,
      recurring: { interval: p.interval },
      product_data: { name: `Tera ${id}` },
    });
    prices[id] = created.id;
  }

  const coupons: Record<string, string> = {};
  for (const [code, c] of Object.entries(catalog.coupons ?? {})) {
    const id = `TERA_${code}`;
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
    const name = `tera_${id}`;
    const found = listed.data.find((t) => t.display_name === name);
    taxRates[id] = found
      ? found.id
      : (await stripe.taxRates.create({ display_name: name, percentage: r.percentage, inclusive: r.behavior === "inclusive" })).id;
  }
  return { prices, coupons, taxRates };
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
  if (timeline.some((e) => e.type === "report_usage")) throw new Error("Metered usage cannot be replayed: Stripe meter events cannot be backdated onto a test clock");
  const ids = await pushCatalog(stripe, catalog);
  const events = [...timeline].sort((a, b) => sec(a.at) - sec(b.at));
  const start = sec(events[0].at);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start, name: `tera ${new Date().toISOString()}` });
  const customer = await stripe.customers.create({ test_clock: clock.id, name: "Tera parity customer", payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } });

  let now = start;
  let sub: Stripe.Subscription | null = null;
  for (const e of events) {
    const at = sec(e.at);
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
          items: [{ price: ids.prices[e.price!], quantity: e.quantity ?? 1 }],
          ...(e.coupon ? { discounts: [{ coupon: ids.coupons[e.coupon] }] } : {}),
          ...(e.tax_rate ? { default_tax_rates: [ids.taxRates[e.tax_rate]] } : {}),
          ...(e.type === "start_trial" ? { trial_end: at + (e.trial_days ?? 0) * 86_400 } : {}),
        });
        break;
      case "change_price":
      case "change_quantity": {
        const item = sub!.items.data[0];
        sub = await stripe.subscriptions.update(sub!.id, {
          items: [{ id: item.id, ...(e.type === "change_price" ? { price: ids.prices[e.price!] } : { quantity: e.quantity }) }],
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
