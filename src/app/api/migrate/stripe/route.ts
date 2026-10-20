import Stripe from "stripe";
import { methodNotAllowed } from "@/lib/validate";
import { migratablePrices, NotMigratable, stripeClient, subscribersOf } from "@/lib/stripe-parity";

export const maxDuration = 60;

// FR3 from Stripe. GET: the connected test-mode account's per-seat prices. GET ?price=price_…: the planner's input,
// one customer per live subscription on that price. Test-mode keys only (stripeClient), so no live customer data.
export async function GET(req: Request) {
  const price = new URL(req.url).searchParams.get("price");
  let stripe;
  try {
    stripe = stripeClient();
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
  try {
    return Response.json(price === null ? await migratablePrices(stripe) : await subscribersOf(stripe, price));
  } catch (e) {
    if (e instanceof NotMigratable) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof Stripe.errors.StripeInvalidRequestError && e.code === "resource_missing")
      return Response.json({ error: `No such price in the connected Stripe account: ${price}` }, { status: 404 });
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
export const POST = methodNotAllowed("GET");
export { POST as PUT, POST as PATCH, POST as DELETE };
