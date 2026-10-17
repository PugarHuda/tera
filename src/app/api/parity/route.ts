import golden from "../../../../golden/scenarios.json";
import evidence from "../../../../golden/parity/index.json";
import { simulate, type Catalog, type TimelineEvent } from "@/lib/billing";
import { diffInvoices, replayInStripe, stripeClient } from "@/lib/stripe-parity";
import { badRequest, BadRequest, defaultCatalog, parseCatalog, parseTimeline } from "@/lib/validate";

export const maxDuration = 300;

// GET: the recorded evidence for every verified scenario (no Stripe call).
export function GET() {
  return Response.json(evidence.map(({ id, title, verified_at, match, diffs, test_clock }) => ({ id, title, verified_at, match, diffs, test_clock })));
}

// A live replay creates real test-mode objects and advances a test clock, so it is throttled and,
// for custom timelines, kept small enough to finish inside maxDuration.
let lastLiveRun = 0;
const COOLDOWN_MS = 30_000;
const LIVE_MAX_EVENTS = 15;
const LIVE_MAX_SPAN_MS = 2 * 366 * 86_400_000;

// Body: { scenario: "S05" } for a golden scenario, or { timeline, catalog? } for your own.
function parseBody(body: unknown): { id: string; catalog: Catalog; timeline: TimelineEvent[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.timeline !== undefined) {
    const timeline = parseTimeline(b.timeline);
    if (timeline.length > LIVE_MAX_EVENTS) throw new BadRequest(`a live Stripe replay is limited to ${LIVE_MAX_EVENTS} events`);
    const times = timeline.map((e) => Date.parse(e.at));
    if (Math.max(...times) - Math.min(...times) > LIVE_MAX_SPAN_MS) throw new BadRequest("a live Stripe replay may span at most 2 years");
    return { id: "custom", catalog: b.catalog === undefined ? defaultCatalog : parseCatalog(b.catalog), timeline };
  }
  const id = typeof b.scenario === "string" ? b.scenario.toUpperCase() : "";
  const scenario = golden.scenarios.find((s) => s.id === id);
  if (!scenario || !("timeline" in scenario)) throw new BadRequest("send { scenario: <golden id with a timeline, e.g. S05> } or { timeline, catalog? }");
  return { id, catalog: golden.catalog as unknown as Catalog, timeline: scenario.timeline as TimelineEvent[] };
}

export async function POST(req: Request) {
  let input, tera;
  try {
    input = parseBody(await req.json());
    tera = simulate(input.catalog, input.timeline).invoices; // R11: what Tera rejects never reaches Stripe
  } catch (e) {
    return badRequest(e);
  }
  const wait = lastLiveRun + COOLDOWN_MS - Date.now();
  if (wait > 0)
    return Response.json(
      { error: `A live Stripe replay ran moments ago; retry in ${Math.ceil(wait / 1000)}s` },
      { status: 429, headers: { "retry-after": String(Math.ceil(wait / 1000)) } },
    );
  lastLiveRun = Date.now();

  try {
    const replay = await replayInStripe(stripeClient(), input.catalog, input.timeline);
    const diffs = diffInvoices(tera, replay.invoices);
    return Response.json({ id: input.id, match: diffs.length === 0, diffs, tera, stripe: replay.invoices, test_clock: replay.clockId, ran_at: new Date().toISOString() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
