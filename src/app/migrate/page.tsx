import type { Metadata } from "next";
import { Planner } from "./planner";

export const metadata: Metadata = { title: "Migration planner · Tera" };

export default function MigratePage() {
  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Price migration planner</h1>
      <p className="mb-6 opacity-70">See what a price change does to MRR before you ship it.</p>
      <Planner />
    </>
  );
}
