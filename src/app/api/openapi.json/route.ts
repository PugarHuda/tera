import { spec } from "@/lib/openapi";

export function GET() {
  return Response.json(spec);
}
