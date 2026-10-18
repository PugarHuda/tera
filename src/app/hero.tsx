import Link from "next/link";
import golden from "../../golden/scenarios.json";
import evidence from "../../golden/parity/index.json";
import { formatMoney, simulate, type Catalog, type TimelineEvent } from "@/lib/billing";

const catalog = golden.catalog as unknown as Catalog;
const timelines = golden.scenarios.filter((s) => "timeline" in s) as unknown as { id: string; title: string; timeline: TimelineEvent[] }[];
const matched = timelines.filter((s) => evidence.some((e) => e.id === s.id && e.match)).length;
// The device shows real engine output: S05's proration invoice, and the invoice history of the longest verified timeline.
const s05 = simulate(catalog, timelines.find((s) => s.id === "S05")!.timeline).invoices[1];
const longest = timelines
  .filter((s) => evidence.some((e) => e.id === s.id && e.match))
  .map((s) => ({ ...s, invoices: simulate(catalog, s.timeline).invoices }))
  .sort((a, b) => b.invoices.length - a.invoices.length)[0];
const peak = Math.max(...longest.invoices.map((i) => Math.abs(i.total)), 1);

const chips = [
  { icon: "%", label: "Prorations to the cent", pos: "left-0 top-10" },
  { icon: "✓", label: `${matched}/${timelines.length} match Stripe`, pos: "right-0 top-24" },
  { icon: "⏱", label: "Trials & anchors", pos: "-left-4 bottom-24" },
  { icon: "€", label: "Coupons, tax, credit", pos: "right-2 bottom-6" },
];

export function Hero() {
  return (
    <section className="hero mb-12 grid items-center gap-10 lg:grid-cols-2" aria-labelledby="hero-title">
      <div>
        <h1 id="hero-title" className="text-5xl leading-[1.02] font-medium tracking-tight sm:text-6xl lg:text-7xl">
          Bill like Stripe, before Stripe does
        </h1>
        <p className="mt-5 max-w-md opacity-75">
          A pricing simulator that runs a virtual customer through upgrades, trials, coupons and tax, and proves every invoice
          against real Stripe test clocks.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <a href="#simulator" className="btn btn-lg">
            Try the simulator
          </a>
          <Link href="/parity" className="btn-outline">
            See the Stripe evidence
          </Link>
        </div>
      </div>
      <div className="relative mx-auto w-full max-w-md py-6 sm:px-10">
        <figure className="device" aria-label={`Tera engine output for ${longest.id}`}>
          <figcaption className="text-xs opacity-60">Invoice preview · S05</figcaption>
          <p className="mt-1 text-lg font-semibold">Upgrade on day 17</p>
          <ul className="mt-3 space-y-1 font-mono text-sm">
            {s05.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span className="truncate opacity-75">{l.description}</span>
                <span>{formatMoney(l.amount, s05.currency)}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-white/15 pt-1 font-semibold">
              <span>Total</span>
              <span>{formatMoney(s05.total, s05.currency)}</span>
            </li>
          </ul>
          <p className="mt-5 text-xs opacity-60">
            {longest.id} · {longest.invoices.length} invoices, Stripe-verified
          </p>
          <div className="mt-2 flex h-20 items-end gap-1" role="img" aria-label={`Invoice totals for ${longest.title}`}>
            {longest.invoices.map((inv, i) => (
              <span key={i} className="bar" style={{ height: `${Math.max(6, (Math.abs(inv.total) / peak) * 100)}%` }} title={formatMoney(inv.total, inv.currency)} />
            ))}
          </div>
        </figure>
        {chips.map((c) => (
          <p key={c.label} className={`chip absolute hidden sm:flex ${c.pos}`}>
            <span className="chip-icon" aria-hidden>
              {c.icon}
            </span>
            {c.label}
          </p>
        ))}
      </div>
    </section>
  );
}
