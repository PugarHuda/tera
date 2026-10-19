import { migrate } from "@/lib/billing";
import { badRequest, methodNotAllowed, parseMigration, readJson } from "@/lib/validate";

export const GET = methodNotAllowed("POST");

export async function POST(req: Request) {
  try {
    return Response.json(migrate(parseMigration(await readJson(req))));
  } catch (e) {
    return badRequest(e);
  }
}
