import { findScenarios, methodNotAllowed } from "@/lib/validate";

export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  return Response.json(findScenarios(params.get("rule"), params.get("q")).map(({ id, title, status, rules }) => ({ id, title, status, rules })));
}
export const POST = methodNotAllowed("GET");
export { POST as PUT, POST as PATCH, POST as DELETE };
