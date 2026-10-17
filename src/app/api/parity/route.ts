import golden from "../../../../golden/scenarios.json";
import evidence from "../../../../golden/parity/index.json";
import { simulate, type Catalog, type TimelineEvent } from "@/lib/billing";
import { checkLiveLimits, Cooldown, liveParity } from "@/lib/stripe-parity";
import { badRequest, BadRequest, defaultCatalog, parseCatalog, parseTimeline } from "@/lib/validate";

export const maxDuration = 300;

// GET: the recorded evidence for every verified scenario (no Stripe call).
export function GET() {
  return Response.json(evidence.map(({ id, title, verified_at, match, diffs, test_clock }) => ({ id, title, verified_at, match, diffs, test_clock })));
}

// Body: { scenario: "S05" } for a golden scenario, or { timeline, catalog? } for your own.
function parseBody(body: unknown): { id: string; catalog: Catalog; timeline: TimelineEvent[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.timeline !== undefined) {
    const timeline = parseTimeline(b.timeline);
    try {
      checkLiveLimits(timeline);
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
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
  try {
    return Response.json({ id: input.id, ...(await liveParity(input.catalog, input.timeline, tera)) });
  } catch (e) {
    if (e instanceof Cooldown) return Response.json({ error: e.message }, { status: 429, headers: { "retry-after": String(e.retryAfter) } });
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
