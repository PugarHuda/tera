import { Suspense } from "react";
import golden from "../../golden/scenarios.json";
import type { Catalog } from "@/lib/billing";
import type { TimelineEvent } from "@/lib/billing";
import { decodeCatalog, decodeTimeline } from "@/lib/share";
import { Simulator, type Scenario } from "./simulator";

const scenarios = golden.scenarios as unknown as Scenario[];
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function Home({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Customer timeline simulator</h1>
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
  // A custom catalog has its own price ids, so golden scenarios do not apply; start with its first price.
  const firstPrice = custom ? Object.keys(custom.prices)[0] : null;
  const starter: TimelineEvent[] | null = firstPrice
    ? [
        { at: "2027-01-01T00:00:00Z", type: "subscribe", price: firstPrice },
        { at: "2027-03-01T00:00:00Z", type: "advance_to" },
      ]
    : null;
  return (
    <>
      {((t !== undefined && !shared) || (c !== undefined && !custom)) && (
        <p role="alert" data-testid="share-error" className="card mb-6 border-red-500 text-red-600">
          This shared link is invalid or corrupted, so the default scenario was loaded instead.
        </p>
      )}
      {custom && (
        <p className="card mb-6 text-sm" data-testid="custom-catalog-banner">
          Using a custom catalog from the Pricing Builder ({Object.keys(custom.prices).length} prices). Golden scenarios are hidden because they
          use the reference catalog. <a className="underline" href="/">Back to the reference catalog</a>
        </p>
      )}
      <Simulator
        catalog={custom ?? (golden.catalog as unknown as Catalog)}
        catalogParam={custom && typeof c === "string" ? c : undefined}
        scenarios={custom ? [] : scenarios}
        initialScenarioId={shared || custom ? undefined : (scenarioId ?? "S05")}
        initialTimeline={shared ?? starter ?? undefined}
      />
    </>
  );
}
