import { BadRequest, badRequest, methodNotAllowed, parseCatalog, readJson } from "@/lib/validate";
import { pushCatalogOnce, stripeClient } from "@/lib/stripe-parity";

export const maxDuration = 120;
export const GET = methodNotAllowed("POST");

// FR5: create (or reuse) the catalog's products, prices, coupons and tax rates in Stripe test mode.
let lastPush = 0;
const COOLDOWN_MS = 10_000;

export async function POST(req: Request) {
  let catalog;
  try {
    const body = await readJson(req);
    // parseCatalog(undefined) is the golden catalog; a push must say what it creates in Stripe.
    if (body?.catalog === undefined) throw new BadRequest("catalog is required");
    catalog = parseCatalog(body.catalog);
  } catch (e) {
    return badRequest(e);
  }
  const wait = lastPush + COOLDOWN_MS - Date.now();
  if (wait > 0) return Response.json({ error: `Pushed moments ago; retry in ${Math.ceil(wait / 1000)}s` }, { status: 429 });
  try {
    const stripe = stripeClient(); // a missing key is a config error, not a push that holds the cooldown
    lastPush = Date.now();
    const ids = await pushCatalogOnce(stripe, catalog);
    return Response.json(ids);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
