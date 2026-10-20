// Seeds the connected Stripe TEST account with a small, real customer base for the migration planner's
// "Import from Stripe" (FR3): subscriptions on test clocks are not listed by Stripe, so replays leave none.
// Idempotent: customers carry metadata tera_demo=1 and are created once.
// Usage: node --no-warnings scripts/seed-migration-demo.mts   (needs STRIPE_SECRET_KEY, sk_test_…, in .env.local)
import { existsSync, readFileSync } from "node:fs";
import type { Catalog } from "../src/lib/billing.ts";
import { pushCatalog, stripeClient } from "../src/lib/stripe-parity.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

// Fictional companies; seats on the per-seat price, a few on the annual plan.
const BASE: [string, string, number][] = [
  ["Acme Inc", "team_seat_m", 12],
  ["Globex", "team_seat_m", 3],
  ["Initech", "team_seat_m", 1],
  ["Umbrella Corp", "team_seat_m", 40],
  ["Hooli", "team_seat_m", 25],
  ["Stark Industries", "team_seat_m", 8],
  ["Wayne Enterprises", "team_seat_m", 5],
  ["Soylent", "team_seat_m", 2],
  ["Pied Piper", "pro_y", 6],
  ["Massive Dynamic", "pro_y", 15],
];

const stripe = stripeClient();
const catalog = JSON.parse(readFileSync("golden/scenarios.json", "utf8")).catalog as Catalog;
const { prices } = await pushCatalog(stripe, catalog);
const existing = new Set((await stripe.customers.search({ query: "metadata['tera_demo']:'1'", limit: 100 })).data.map((c) => c.name));
for (const [name, price, seats] of BASE) {
  if (existing.has(name)) continue;
  const customer = await stripe.customers.create({
    name,
    metadata: { tera_demo: "1" },
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
  });
  await stripe.subscriptions.create({ customer: customer.id, items: [{ price: prices[price], quantity: seats }] });
  console.log(`${name}: ${seats} × ${price} (${prices[price]})`);
}
console.log(`team_seat_m = ${prices.team_seat_m}, pro_y = ${prices.pro_y}`);
