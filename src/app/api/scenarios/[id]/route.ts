import golden from "../../../../../golden/scenarios.json";

export async function GET(_req: Request, ctx: RouteContext<"/api/scenarios/[id]">) {
  const { id } = await ctx.params;
  const scenario = golden.scenarios.find((s) => s.id.toLowerCase() === id.toLowerCase());
  if (!scenario) return Response.json({ error: `Scenario ${id} not found` }, { status: 404 });
  return Response.json({ ...scenario, catalog: golden.catalog });
}
