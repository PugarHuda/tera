import { badRequest, parseCatalog } from "@/lib/validate";
import { pushCatalogOnce, stripeClient } from "@/lib/stripe-parity";

export const maxDuration = 120;

// FR5: create (or reuse) the catalog's products, prices, coupons and tax rates in Stripe test mode.
let lastPush = 0;
const COOLDOWN_MS = 10_000;

export async function POST(req: Request) {
  let catalog;
  try {
    catalog = parseCatalog((await req.json())?.catalog);
  } catch (e) {
    return badRequest(e);
  }
  const wait = lastPush + COOLDOWN_MS - Date.now();
  if (wait > 0) return Response.json({ error: `Pushed moments ago; retry in ${Math.ceil(wait / 1000)}s` }, { status: 429 });
  lastPush = Date.now();
  try {
    const ids = await pushCatalogOnce(stripeClient(), catalog);
    return Response.json({ prices: ids.prices, coupons: ids.coupons, taxRates: ids.taxRates });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
