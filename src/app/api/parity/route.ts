import golden from "../../../../golden/scenarios.json";
import evidence from "../../../../golden/parity/index.json";
import { simulate, type Catalog, type TimelineEvent } from "@/lib/billing";
import { diffInvoices, replayInStripe, stripeClient } from "@/lib/stripe-parity";

export const maxDuration = 300;

// GET: the recorded evidence for every verified scenario (no Stripe call).
export function GET() {
  return Response.json(evidence.map(({ id, title, verified_at, match, diffs, test_clock }) => ({ id, title, verified_at, match, diffs, test_clock })));
}

// A live replay creates real test-mode objects, so it is limited to golden scenarios and throttled.
let lastLiveRun = 0;
const COOLDOWN_MS = 30_000;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const id = typeof body?.scenario === "string" ? body.scenario.toUpperCase() : "";
  const scenario = golden.scenarios.find((s) => s.id === id);
  if (!scenario || !("timeline" in scenario)) return Response.json({ error: "scenario must be a golden scenario id with a timeline, e.g. S05" }, { status: 400 });
  const wait = lastLiveRun + COOLDOWN_MS - Date.now();
  if (wait > 0)
    return Response.json(
      { error: `A live Stripe replay ran moments ago; retry in ${Math.ceil(wait / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(wait / 1000)) } },
    );
  lastLiveRun = Date.now();

  const catalog = golden.catalog as unknown as Catalog;
  const timeline = scenario.timeline as TimelineEvent[];
  try {
    const tera = simulate(catalog, timeline).invoices;
    const replay = await replayInStripe(stripeClient(), catalog, timeline);
    const diffs = diffInvoices(tera, replay.invoices);
    return Response.json({ id, match: diffs.length === 0, diffs, tera, stripe: replay.invoices, test_clock: replay.clockId, ran_at: new Date().toISOString() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
