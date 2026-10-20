// Differential fuzzing: random (seeded) timelines are run through Tera and replayed in Stripe test clocks.
// Every diff is a candidate rule gap; a confirmed one becomes a hand-derived golden scenario.
// Usage: node --no-warnings scripts/fuzz-parity.mts [count=12] [seed=1] [classic|flexible]   (needs STRIPE_SECRET_KEY in .env.local)
import { existsSync, readFileSync } from "node:fs";
import { simulate, type BillingMode, type Catalog } from "../src/lib/billing.ts";
import { generate } from "../src/lib/timeline-gen.ts";
import { diffInvoices, replayInStripe, stripeClient } from "../src/lib/stripe-parity.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const catalog = JSON.parse(readFileSync("golden/scenarios.json", "utf8")).catalog as Catalog;
const [count = 12, seed0 = 1] = process.argv.slice(2, 4).map(Number);
const mode = (process.argv[4] ?? "classic") as BillingMode;

const stripe = stripeClient();
const seeds = Array.from({ length: count }, (_, i) => seed0 + i);
let diffsFound = 0;

async function run(seed: number) {
  const timeline = generate(seed, mode);
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
