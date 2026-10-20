import type { Metadata } from "next";
import golden from "../../../golden/scenarios.json";
import type { Catalog } from "@/lib/billing";
import { Builder } from "./builder";

export const metadata: Metadata = { title: "Pricing builder · Tera" };

export default function BuilderPage() {
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Pricing builder</h1>
      <p className="mb-6 max-w-2xl opacity-70">
        Design plans, coupons and tax rates, simulate customers on them, then push the exact same catalog to Stripe test mode.
      </p>
      <Builder reference={golden.catalog as unknown as Catalog} stripeLive={!!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")} />
    </>
  );
}
