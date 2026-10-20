import { spec } from "@/lib/openapi";
import { methodNotAllowed } from "@/lib/validate";

export function GET() {
  return Response.json(spec);
}
export const POST = methodNotAllowed("GET");
export { POST as PUT, POST as PATCH, POST as DELETE };
