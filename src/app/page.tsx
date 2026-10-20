import Link from "next/link";
import golden from "../../golden/scenarios.json";
import evidence from "../../golden/parity/index.json";
import { formatMoney, simulate, type Catalog, type TimelineEvent } from "@/lib/billing";

// Everything on this page is computed: the hero invoice and its webhooks come from the engine (S05, the upgrade on day
// 17 of 31), the numbers from the Stripe test-clock evidence that src/lib/webhooks.test.ts and CI hold Tera to.
const catalog = golden.catalog as unknown as Catalog;
const s05 = golden.scenarios.find((s) => s.id === "S05") as unknown as { timeline: TimelineEvent[] };
const sim = simulate(catalog, s05.timeline);
const upgrade = sim.invoices[1];
const hooks = sim.webhooks.filter((w) => w.invoice === 2 || (w.event === 1 && w.type !== "invoice.created"));
const records = evidence as { match: boolean; stripe: unknown[]; webhooks?: string[][] }[];
const proof = [
  [`${records.filter((r) => r.match).length} / ${records.length}`, "timelines replayed in real Stripe test clocks match Tera to the cent"],
  [records.reduce((n, r) => n + r.stripe.length, 0).toLocaleString("en-US"), "Stripe invoices compared line by line"],
  [records.reduce((n, r) => n + (r.webhooks?.flat().length ?? 0), 0).toLocaleString("en-US"), "webhook events Stripe sent, every one predicted"],
];
const usd = (x: number) => formatMoney(x, "usd", "en-US");

const features = [
  {
    eyebrow: "Simulator",
    title: "Every invoice, before your customer sees it.",
    body: "Upgrades, seat changes, coupons, trials, taxes, pauses, cancellations: put a customer through them on a timeline and read each invoice to the cent, with the webhook events Stripe sends for it.",
    href: "/simulator",
    cta: "Open the simulator",
    items: ["Classic and flexible billing mode", "Proration, credit balance, minimum charge", "Webhook events per step", "Share link and CSV export"],
  },
  {
    eyebrow: "Pricing builder",
    title: "Your catalog, or the one already in Stripe.",
    body: "Type prices, coupons and tax rates, or import the connected test account's catalog, then simulate on it. Push it back to Stripe test mode idempotently.",
    href: "/builder",
    cta: "Build a catalog",
    items: ["USD, EUR, GBP, JPY and every currency Stripe takes", "Graduated metered tiers", "Two-way Stripe sync"],
  },
  {
    eyebrow: "Migration planner",
    title: "Who pays more when the price changes.",
    body: "Move a customer base to a new price and see the MRR impact, grandfathering and each account's difference, from a CSV or the live subscriptions in Stripe.",
    href: "/migrate",
    cta: "Plan a migration",
    items: ["MRR before and after", "Annual prices counted monthly", "Import from Stripe or CSV"],
  },
];

const why = [
  ["Proven, not claimed", "Every golden scenario is replayed against Stripe with test clocks; a single cent of difference fails CI."],
  ["Tests that run themselves", "TestSprite, Playwright journeys and a Stripe differential fuzzer run on every pull request."],
  ["Built for agents", "An MCP server with 10 tools, an OpenAPI 3.1 REST API and llms.txt, all on this deployment."],
  ["Stripe's undocumented rules", "12-decimal unit proration, invoice-level tax rounding, the renewal draft hour: found by fuzzing, written down."],
];

export default function Landing() {
  return (
    <div className="space-y-24">
      <section className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <p className="eyebrow">Stripe-parity billing simulator</p>
          <h1 className="mb-4 text-5xl leading-[1.05] font-medium sm:text-6xl">Change your pricing without breaking a single invoice.</h1>
          <p className="mb-6 max-w-xl text-lg opacity-75">
            Tera computes every invoice with Stripe&apos;s own billing rules and proves it against real Stripe test clocks, so you see what each
            customer pays before you ship the change.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/simulator" className="btn" data-testid="landing-cta">
              Open the simulator
            </Link>
            <Link href="/parity" className="btn-ghost text-xs font-semibold tracking-wide uppercase">
              See the Stripe proof →
            </Link>
          </div>
        </div>
        <figure className="card relative" aria-label="An invoice computed by Tera" data-testid="landing-invoice">
          <figcaption className="mb-3 text-xs opacity-70">Upgrade on day 17 of 31 · computed by Tera, matched by Stripe</figcaption>
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-medium">Invoice 2 · {upgrade.date}</span>
            <span className="font-mono text-xl font-semibold">{usd(upgrade.total)}</span>
          </div>
          <ul className="space-y-1 border-t border-current/15 pt-2 text-sm">
            {upgrade.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span>
                  {l.description.split(" (")[0]} {l.proration && <span className="badge">proration</span>}
                </span>
                <span className="font-mono">{usd(l.amount)}</span>
              </li>
            ))}
          </ul>
          <ol className="mt-4 space-y-0.5 border-t border-dashed border-current/25 pt-3 font-mono text-xs opacity-80">
            {hooks.map((h, i) => (
              <li key={i}>
                {h.date} {h.type}
                {h.invoice ? ` → invoice ${h.invoice}` : h.status ? ` (${h.status})` : ""}
              </li>
            ))}
          </ol>
        </figure>
      </section>

      <div className="stripes -mx-4 h-10" aria-hidden="true" />

      <ul className="grid gap-3 sm:grid-cols-3" data-testid="proof">
        {proof.map(([n, label]) => (
          <li key={label} className="card">
            <Link href="/parity" className="block">
              <span className="font-serif text-4xl">{n}</span>
              <span className="mt-1 block text-xs opacity-70">{label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <section className="mx-auto max-w-3xl text-center">
        <p className="eyebrow">The problem</p>
        <h2 className="mb-4 text-4xl leading-tight font-medium">A pricing change is a billing change. Most teams ship it blind.</h2>
        <p className="opacity-75">
          Prorations, coupons that run out, tax rounding and anchors that move are where invoices go wrong, and Stripe&apos;s docs leave many of
          those rules unwritten. Tera models them, and every one is backed by a scenario Stripe itself has billed.
        </p>
      </section>

      <section className="space-y-6">
        <div className="text-center">
          <p className="eyebrow">What it does</p>
          <h2 className="text-4xl leading-tight font-medium">From a pricing idea to a verified invoice.</h2>
        </div>
        {features.map((f) => (
          <article key={f.href} className="card grid gap-6 p-6 sm:p-8 md:grid-cols-2">
            <div>
              <p className="eyebrow">{f.eyebrow}</p>
              <h3 className="mb-3 font-serif text-3xl leading-tight">{f.title}</h3>
              <p className="mb-5 text-sm opacity-75">{f.body}</p>
              <Link href={f.href} className="btn">
                {f.cta}
              </Link>
            </div>
            <ul className="self-end text-sm">
              {f.items.map((x) => (
                <li key={x} className="border-b border-dashed border-current/20 py-2 last:border-0">
                  {x}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section>
        <div className="mb-6 text-center">
          <p className="eyebrow">Why Tera</p>
          <h2 className="text-4xl leading-tight font-medium">The difference is that it is checked against Stripe.</h2>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {why.map(([title, body]) => (
            <li key={title} className="card p-6">
              <h3 className="mb-2 font-serif text-2xl">{title}</h3>
              <p className="text-sm opacity-75">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="text-center">
        <p className="eyebrow">Start here</p>
        <h2 className="mb-3 text-4xl leading-tight font-medium">Run your first customer timeline.</h2>
        <p className="mx-auto mb-6 max-w-xl opacity-75">
          No signup. Pick a golden scenario or build your own, then press Verify in Stripe to replay it on a real test clock.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/simulator" className="btn">
            Open the simulator
          </Link>
          <Link href="/mcp-setup" className="btn-ghost text-xs font-semibold tracking-wide uppercase">
            Connect your AI agent →
          </Link>
        </div>
      </section>
    </div>
  );
}
