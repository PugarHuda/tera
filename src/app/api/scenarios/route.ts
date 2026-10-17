import golden from "../../../../golden/scenarios.json";

export function GET() {
  return Response.json(golden.scenarios.map(({ id, title, status, rules }) => ({ id, title, status, rules })));
}
