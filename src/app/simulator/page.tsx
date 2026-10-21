import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import golden from "../../../golden/scenarios.json";
import type { Catalog } from "@/lib/billing";
import type { TimelineEvent } from "@/lib/billing";
import { decodeCatalog, decodeTimeline } from "@/lib/share";
import { Simulator, type Scenario } from "./simulator";

const scenarios = golden.scenarios as unknown as Scenario[];
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: "Simulator · Tera" };

export default function SimulatorPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <p className="eyebrow">Stripe-parity billing</p>
      <h1 className="mb-2 text-4xl leading-tight font-medium sm:text-5xl">Customer timeline simulator</h1>
      <p className="mb-6 max-w-2xl opacity-70">
        Run a virtual customer through upgrades, coupons, trials and taxes and see every invoice to the cent — computed with
        Stripe&apos;s billing rules, before any real customer sees it.
      </p>
      <Suspense fallback={<p className="opacity-60">Loading simulator…</p>}>
        <SimulatorFromUrl searchParams={searchParams} />
      </Suspense>
    </>
  );
}

// ?t=<shared timeline>, ?s=<scenario id>, ?c=<custom catalog from the Pricing Builder>; defaults to S05.
async function SimulatorFromUrl({ searchParams }: { searchParams: SearchParams }) {
  const { s, t, c } = await searchParams;
  const custom = typeof c === "string" ? decodeCatalog(c) : null;
  const shared = typeof t === "string" ? decodeTimeline(t) : null;
  const scenarioId = typeof s === "string" ? scenarios.find((x) => x.timeline && x.id.toLowerCase() === s.toLowerCase())?.id : undefined;
  // A custom catalog has its own price ids, so golden scenarios do not apply; start with its first licensed
  // price (a metered one would bill $0 until usage is reported).
  const firstPrice = custom ? (Object.entries(custom.prices).find(([, p]) => p.usage_type !== "metered") ?? Object.entries(custom.prices)[0])[0] : null;
  // A metered-only catalog would bill $0 forever: report some usage so its tiers show.
  const metered = firstPrice !== null && custom!.prices[firstPrice].usage_type === "metered";
  const starter: TimelineEvent[] | null = firstPrice
    ? [
        { at: "2027-01-01T00:00:00Z", type: "subscribe", price: firstPrice },
        ...(metered ? [{ at: "2027-01-15T00:00:00Z", type: "report_usage" as const, quantity: 1000 }] : []),
        { at: "2027-03-01T00:00:00Z", type: "advance_to" },
      ]
    : null;
  return (
    <>
      {typeof s === "string" && !scenarioId && !t && !c && (
        <p role="alert" data-testid="scenario-error" className="card mb-6 border-red-500 text-red-700 dark:text-red-400">
          There is no golden scenario &ldquo;{s}&rdquo;, so S05 was loaded instead.
        </p>
      )}
      {((t !== undefined && !shared) || (c !== undefined && !custom)) && (
        <p role="alert" data-testid="share-error" className="card mb-6 border-red-500 text-red-700 dark:text-red-400">
          This shared link is invalid or corrupted, so the default scenario was loaded instead.
        </p>
      )}
      {custom && (
        <p className="card mb-6 text-sm" data-testid="custom-catalog-banner">
          Using a custom catalog from the Pricing Builder ({Object.keys(custom.prices).length} prices). Golden scenarios are hidden because they
          use the reference catalog. <Link className="underline" href="/simulator">
            Back to the reference catalog
          </Link>
        </p>
      )}
      <Simulator
        // Client-side navigation between links must reset the editor to the new URL's timeline.
        key={`${t}|${c}`}
        catalog={custom ?? (golden.catalog as unknown as Catalog)}
        catalogParam={custom && typeof c === "string" ? c : undefined}
        scenarios={custom ? [] : scenarios}
        initialScenarioId={shared || custom ? undefined : (scenarioId ?? "S05")}
        initialTimeline={shared ?? starter ?? undefined}
        stripeLive={!!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")}
      />
    </>
  );
}
