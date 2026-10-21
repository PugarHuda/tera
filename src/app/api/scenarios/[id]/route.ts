import golden from "../../../../../golden/scenarios.json";
import { methodNotAllowed, preflight } from "@/lib/validate";

export async function GET(_req: Request, ctx: RouteContext<"/api/scenarios/[id]">) {
  const { id } = await ctx.params;
  const scenario = golden.scenarios.find((s) => s.id.toLowerCase() === id.toLowerCase());
  if (!scenario) return Response.json({ error: `Scenario ${id} not found` }, { status: 404 });
  return Response.json({ ...scenario, catalog: golden.catalog });
}
export const POST = methodNotAllowed("GET");
export const OPTIONS = preflight("GET");
export { POST as PUT, POST as PATCH, POST as DELETE };
