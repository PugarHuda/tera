// Replays golden scenarios in Stripe test mode (test clocks) and records the evidence.
// Usage: node scripts/verify-golden.mts [--mark] [S05 S10 ...]   (needs STRIPE_SECRET_KEY in .env.local)
// --mark flips matching scenarios to status "verified" in golden/scenarios.json (and back to "draft" on a diff).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { simulate, type Catalog, type TimelineEvent } from "../src/lib/billing.ts";
import { diffInvoices, replayInStripe, stripeClient, STRIPE_API_VERSION } from "../src/lib/stripe-parity.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const golden = JSON.parse(readFileSync("golden/scenarios.json", "utf8"));
const catalog = golden.catalog as Catalog;
const args = process.argv.slice(2);
const mark = args.includes("--mark");
const wanted = new Set(args.filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase()));
const results: Record<string, boolean> = {};
const scenarios = golden.scenarios.filter((s: { id: string; timeline?: unknown }) => s.timeline && (wanted.size === 0 || wanted.has(s.id)));
const stripe = stripeClient();

async function run(s: { id: string; title: string; timeline: TimelineEvent[] }) {
  const tera = simulate(catalog, s.timeline).invoices;
  try {
    const replay = await replayInStripe(stripe, catalog, s.timeline);
    const diffs = diffInvoices(tera, replay.invoices);
    const record = { id: s.id, title: s.title, verified_at: new Date().toISOString(), stripe_api_version: STRIPE_API_VERSION, match: diffs.length === 0, diffs, test_clock: replay.clockId, customer: replay.customerId, stripe: replay.invoices };
    results[s.id] = diffs.length === 0;
    writeFileSync(`golden/parity/${s.id}.json`, JSON.stringify(record, null, 2) + "\n");
    console.log(`${s.id} ${diffs.length === 0 ? "MATCH" : "DIFF"} ${s.title}`);
    for (const d of diffs) console.log(`   invoice ${d.invoice} ${d.field}: tera=${JSON.stringify(d.tera)} stripe=${JSON.stringify(d.stripe)}`);
  } catch (e) {
    results[s.id] = false;
    console.log(`${s.id} SKIP ${(e as Error).message}`);
  }
}

const queue = [...scenarios];
await Promise.all(Array.from({ length: 3 }, async () => { for (let s; (s = queue.shift()); ) await run(s); }));

if (mark) {
  for (const s of golden.scenarios) {
    if (!(s.id in results)) continue;
    s.status = results[s.id] ? "verified" : "draft";
    if (results[s.id]) s.parity = `golden/parity/${s.id}.json`;
    else delete s.parity;
  }
  writeFileSync("golden/scenarios.json", JSON.stringify(golden, null, 2) + "\n");
  console.log(`marked ${Object.values(results).filter(Boolean).length}/${Object.keys(results).length} verified`);
}

// One bundle the app imports statically (no runtime fs reads on Vercel).
const records = readdirSync("golden/parity")
  .filter((f) => /^S\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(`golden/parity/${f}`, "utf8")));
writeFileSync("golden/parity/index.json", JSON.stringify(records, null, 2) + "\n");

// Non-zero exit when any replayed scenario differs from (or failed in) Stripe, so CI can gate on it.
process.exitCode = Object.values(results).every(Boolean) ? 0 : 1;
