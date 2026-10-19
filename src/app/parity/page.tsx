import type { Metadata } from "next";
import golden from "../../../golden/scenarios.json";
import evidence from "../../../golden/parity/index.json";
import { simulate, type Catalog, type TimelineEvent } from "@/lib/billing";
import { ParityRow } from "./parity-row";

export const metadata: Metadata = { title: "Stripe parity · Tera" };

const catalog = golden.catalog as unknown as Catalog;

export default function ParityPage() {
  const rows = golden.scenarios
    .filter((s) => "timeline" in s)
    .map((s) => ({
      id: s.id,
      title: s.title,
      tera: simulate(catalog, (s as unknown as { timeline: TimelineEvent[] }).timeline).invoices,
      record: evidence.find((e) => e.id === s.id) ?? null,
    }));
  const verified = rows.filter((r) => r.record?.match).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold">Stripe parity</h1>
        <p className="max-w-3xl opacity-70">
          Every golden scenario is replayed in a Stripe test-mode account with test clocks (classic or flexible billing mode, as each scenario sets it; API{" "}
          <code>2026-09-30.endive</code>) and compared line by line with Tera&apos;s engine.
        </p>
        <p className="mt-3 text-lg font-semibold" data-testid="parity-summary">
          {verified} / {rows.length} scenarios match Stripe to the cent
        </p>
      </div>
      <ol className="space-y-3">
        {rows.map((r) => (
          <ParityRow key={r.id} {...r} live={!!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")} />
        ))}
      </ol>
    </div>
  );
}
