import type { Metadata } from "next";
import { Planner } from "./planner";

export const metadata: Metadata = { title: "Migration planner · Tera" };

export default function MigratePage() {
  return (
    <>
      <p className="eyebrow">Price changes</p>
      <h1 className="mb-2 text-4xl leading-tight font-medium sm:text-5xl">Price migration planner</h1>
      <p className="mb-6 opacity-70">See what a price change does to MRR before you ship it.</p>
      <Planner stripeLive={!!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")} />
    </>
  );
}
