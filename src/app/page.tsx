import { Suspense } from "react";
import golden from "../../golden/scenarios.json";
import type { Catalog } from "@/lib/billing";
import { decodeTimeline } from "@/lib/share";
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

// ?t=<shared timeline> or ?s=<scenario id>; defaults to S05.
async function SimulatorFromUrl({ searchParams }: { searchParams: SearchParams }) {
  const { s, t } = await searchParams;
  const shared = typeof t === "string" ? decodeTimeline(t) : null;
  const scenarioId = typeof s === "string" ? scenarios.find((x) => x.timeline && x.id.toLowerCase() === s.toLowerCase())?.id : undefined;
  return (
    <>
      {t !== undefined && !shared && (
        <p role="alert" data-testid="share-error" className="card mb-6 border-red-500 text-red-600">
          This shared link is invalid or corrupted, so the default scenario was loaded instead.
        </p>
      )}
      <Simulator
        catalog={golden.catalog as unknown as Catalog}
        scenarios={scenarios}
        initialScenarioId={shared ? undefined : (scenarioId ?? "S05")}
        initialTimeline={shared ?? undefined}
      />
    </>
  );
}
