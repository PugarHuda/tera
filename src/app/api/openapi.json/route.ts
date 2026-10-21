import { spec } from "@/lib/openapi";
import { methodNotAllowed, preflight } from "@/lib/validate";

export function GET() {
  return Response.json(spec);
}
export const POST = methodNotAllowed("GET");
export const OPTIONS = preflight("GET");
export { POST as PUT, POST as PATCH, POST as DELETE };
