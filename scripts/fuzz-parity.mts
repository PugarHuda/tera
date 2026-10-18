// Differential fuzzing: random (seeded) timelines are run through Tera and replayed in Stripe test clocks.
// Every diff is a candidate rule gap; a confirmed one becomes a hand-derived golden scenario.
// Usage: node --no-warnings scripts/fuzz-parity.mts [count=12] [seed=1]   (needs STRIPE_SECRET_KEY in .env.local)
import { existsSync, readFileSync } from "node:fs";
import { simulate, type Catalog, type TimelineEvent } from "../src/lib/billing.ts";
import { diffInvoices, replayInStripe, stripeClient } from "../src/lib/stripe-parity.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const catalog = JSON.parse(readFileSync("golden/scenarios.json", "utf8")).catalog as Catalog;
const [count = 12, seed0 = 1] = process.argv.slice(2).map(Number);

// mulberry32: tiny deterministic PRNG so a failing case is reproducible from its seed.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const GROUPS = [
  { prices: ["starter_m", "pro_m", "team_seat_m", "pro_y"], coupons: ["SAVE20", "FOREVER25", "TENOFF3", "FIFTYOFF"] },
  { prices: ["basic_m_jpy", "premium_m_jpy"], coupons: ["SAVE20", "FOREVER25"] },
];

function generate(seed: number): TimelineEvent[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const g = r() < 0.8 ? GROUPS[0] : GROUPS[1];
  let t = Date.UTC(2027, int(0, 5), int(1, 28));
  const at = () => new Date(t).toISOString().replace(".000", "");
  const first: TimelineEvent = { at: at(), type: r() < 0.2 ? "start_trial" : "subscribe", price: pick(g.prices), quantity: int(1, 5) };
  if (first.type === "start_trial") first.trial_days = int(7, 30);
  else if (r() < 0.5) first.coupon = pick(g.coupons);
  if (r() < 0.4) first.tax_rate = pick(["tax10_ex", "vat20_in"]);
  const events = [first];
  if (first.type === "start_trial" && r() < 0.5) {
    t += int(1, first.trial_days! - 1) * 86_400_000;
    events.push({ at: at(), type: "end_trial" });
  }
  for (let i = int(1, 3); i > 0; i--) {
    t += int(3, 40) * 86_400_000;
    const kind = pick(["change_quantity", "change_price", "change_price", "apply_coupon"] as const);
    const e: TimelineEvent = { at: at(), type: kind };
    if (kind === "change_quantity") e.quantity = int(1, 8);
    if (kind === "change_price") {
      e.price = pick(g.prices);
      if (r() < 0.6) e.quantity = int(1, 5);
    }
    if (kind === "apply_coupon") e.coupon = pick(g.coupons);
    if (kind !== "apply_coupon") e.proration_behavior = pick([undefined, undefined, "always_invoice", "none"]);
    events.push(e);
  }
  if (r() < 0.25) {
    t += int(1, 20) * 86_400_000;
    events.push({ at: at(), type: r() < 0.3 ? "cancel_now" : "cancel_at_period_end" });
    if (events.at(-1)!.type === "cancel_at_period_end" && r() < 0.4) {
      t += int(1, 5) * 86_400_000;
      events.push({ at: at(), type: "resume" });
    }
  }
  t += int(35, 70) * 86_400_000;
  events.push({ at: at(), type: "advance_to" });
  return events;
}

const stripe = stripeClient();
const seeds = Array.from({ length: count }, (_, i) => seed0 + i);
let diffsFound = 0;

async function run(seed: number) {
  const timeline = generate(seed);
  let tera;
  try {
    tera = simulate(catalog, timeline).invoices;
  } catch (e) {
    return console.log(`seed ${seed} REJECTED by Tera: ${(e as Error).message}`);
  }
  try {
    const replay = await replayInStripe(stripe, catalog, timeline);
    const diffs = diffInvoices(tera, replay.invoices);
    console.log(`seed ${seed} ${diffs.length ? "DIFF" : "MATCH"} (${tera.length} invoices, ${replay.clockId})`);
    if (diffs.length) {
      diffsFound++;
      console.log(`   timeline ${JSON.stringify(timeline)}`);
      for (const d of diffs) console.log(`   invoice ${d.invoice} ${d.field}: tera=${JSON.stringify(d.tera)} stripe=${JSON.stringify(d.stripe)}`);
    }
  } catch (e) {
    // Stripe refusing a timeline Tera accepted is itself a finding (R11 gap).
    diffsFound++;
    console.log(`seed ${seed} STRIPE ERROR ${(e as Error).message}\n   timeline ${JSON.stringify(timeline)}`);
  }
}

const queue = [...seeds];
await Promise.all(Array.from({ length: 3 }, async () => { for (let s; (s = queue.shift()) !== undefined; ) await run(s); }));
console.log(`${diffsFound} finding(s) in ${count} timelines`);
process.exitCode = diffsFound ? 1 : 0;
