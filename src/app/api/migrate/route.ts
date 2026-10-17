import { migrate } from "@/lib/billing";
import { badRequest, parseMigration } from "@/lib/validate";

export async function POST(req: Request) {
  try {
    return Response.json(migrate(parseMigration(await req.json())));
  } catch (e) {
    return badRequest(e);
  }
}
