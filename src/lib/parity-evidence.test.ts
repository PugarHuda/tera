import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import golden from "../../golden/scenarios.json";
import { simulate, type Catalog, type TimelineEvent } from "./billing";
import { diffInvoices, type ParityInvoice } from "./stripe-parity";

// The invoices Stripe produced for each golden timeline, recorded from a real test clock by scripts/verify-golden.mts.
// The engine must still reproduce them with the same diff the live replay uses (amounts, proration flags, totals,
// balances), so an engine change is checked against Stripe's receipts, not only against the hand-derived values.
const timelines = golden.scenarios.filter((s) => "timeline" in s) as unknown as { id: string; title: string; timeline: TimelineEvent[]; catalog?: Catalog }[];

describe("engine reproduces Stripe's recorded invoices", () => {
  for (const s of timelines) {
    it(`${s.id} ${s.title}`, () => {
      const recorded = JSON.parse(readFileSync(`golden/parity/${s.id}.json`, "utf8")) as { stripe: ParityInvoice[] };
      expect(diffInvoices(simulate(s.catalog ?? (golden.catalog as unknown as Catalog), s.timeline).invoices, recorded.stripe)).toEqual([]);
    });
  }
});
