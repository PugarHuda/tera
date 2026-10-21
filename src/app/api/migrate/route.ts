import { migrate } from "@/lib/billing";
import { badRequest, methodNotAllowed, preflight, parseMigration, readJson } from "@/lib/validate";

export const GET = methodNotAllowed("POST");
export const OPTIONS = preflight("POST");
export { GET as PUT, GET as PATCH, GET as DELETE };

export async function POST(req: Request) {
  try {
    return Response.json(migrate(parseMigration(await readJson(req))));
  } catch (e) {
    return badRequest(e);
  }
}
