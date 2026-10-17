// Debug aid for a parity diff: replay one timeline (JSON arg) in Stripe and print every invoice line and discount.
// Usage: node --no-warnings scripts/probe-stripe.mts '<timeline json>'
import { existsSync, readFileSync } from "node:fs";
import { simulate, type Catalog } from "../src/lib/billing.ts";
import { replayInStripe, stripeClient } from "../src/lib/stripe-parity.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const catalog = JSON.parse(readFileSync("golden/scenarios.json", "utf8")).catalog as Catalog;
const timeline = JSON.parse(process.argv[2]);
const stripe = stripeClient();
const replay = await replayInStripe(stripe, catalog, timeline);
const tera = simulate(catalog, timeline).invoices;
for (const [i, s] of replay.invoices.entries()) {
  const inv = await stripe.invoices.retrieve(s.id, { expand: ["total_discount_amounts.discount", "lines.data.discounts"] });
  const discounts = (inv.total_discount_amounts ?? []).map((d) => `${d.amount} via ${(d.discount as { source?: { coupon?: { id?: string } }; coupon?: { id: string } }).source?.coupon?.id ?? JSON.stringify(d.discount).slice(0, 80)}`);
  console.log(`#${i + 1} ${s.date} subtotal ${s.subtotal} discount ${s.discount} total ${s.total}  [tera ${tera[i]?.total}]`);
  for (const l of inv.lines.data) console.log(`   ${l.amount}\t${l.description}\tdiscountable=${(l as unknown as { discountable?: boolean }).discountable}\tline-discounts=${JSON.stringify(l.discount_amounts)}`);
  if (discounts.length) console.log(`   discounts: ${discounts.join(", ")}`);
}
