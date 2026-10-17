import golden from "../../golden/scenarios.json";
import type { Catalog, TimelineEvent } from "@/lib/billing";
import { Simulator } from "./simulator";

export default function Home() {
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Customer timeline simulator</h1>
      <p className="mb-6 max-w-2xl opacity-70">
        Run a virtual customer through upgrades, coupons, trials and taxes and see every invoice to the cent — computed with
        Stripe&apos;s billing rules, before any real customer sees it.
      </p>
      <Simulator
        catalog={golden.catalog as unknown as Catalog}
        scenarios={golden.scenarios as unknown as { id: string; title: string; timeline?: TimelineEvent[]; expect?: { total: number }[] }[]}
      />
    </>
  );
}
