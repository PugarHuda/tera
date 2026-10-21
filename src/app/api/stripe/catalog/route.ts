import { methodNotAllowed, preflight } from "@/lib/validate";
import { stripeCatalog, stripeClient } from "@/lib/stripe-parity";

export const maxDuration = 60;

// FR5 the other way: GET the connected test-mode account's prices, coupons and tax rates as a Tera catalog
// ({ catalog, skipped }), ready for /api/simulate or the builder. Test-mode keys only (stripeClient).
export async function GET() {
  let stripe;
  try {
    stripe = stripeClient();
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
  try {
    return Response.json(await stripeCatalog(stripe));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
export const POST = methodNotAllowed("GET");
export const OPTIONS = preflight("GET");
export { POST as PUT, POST as PATCH, POST as DELETE };
