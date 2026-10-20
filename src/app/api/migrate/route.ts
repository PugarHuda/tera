import { migrate } from "@/lib/billing";
import { badRequest, methodNotAllowed, parseMigration } from "@/lib/validate";

export const GET = methodNotAllowed("POST");

export async function POST(req: Request) {
  try {
    return Response.json(migrate(parseMigration(await req.json())));
  } catch (e) {
    return badRequest(e);
  }
}
