import { BadRequest, badRequest, methodNotAllowed, preflight, parseCatalog, readJson } from "@/lib/validate";
import { claimPush, Cooldown, pushCatalogOnce, stripeClient } from "@/lib/stripe-parity";

export const maxDuration = 120;
export const GET = methodNotAllowed("POST");
export const OPTIONS = preflight("POST");
export { GET as PUT, GET as PATCH, GET as DELETE };

// FR5: create (or reuse) the catalog's products, prices, coupons and tax rates in Stripe test mode.

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
  try {
    const stripe = stripeClient(); // a missing key is a config error, not a push that holds the cooldown
    claimPush();
    const ids = await pushCatalogOnce(stripe, catalog);
    return Response.json(ids);
  } catch (e) {
    if (e instanceof Cooldown) return Response.json({ error: e.message }, { status: 429, headers: { "retry-after": String(e.retryAfter) } });
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
