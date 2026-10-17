"use client";

import { useState } from "react";
import { formatMoney, simulate, type Catalog, type Invoice, type TimelineEvent } from "@/lib/billing";
import { encodeTimeline } from "@/lib/share";

export type Scenario = { id: string; title: string; timeline?: TimelineEvent[]; expect?: { total: number }[] };
type EventType = TimelineEvent["type"];
type Field = "price" | "quantity" | "coupon" | "tax_rate" | "trial_days" | "proration_behavior";

const FIELDS: Record<EventType, Field[]> = {
  subscribe: ["price", "quantity", "coupon", "tax_rate"],
  start_trial: ["price", "trial_days", "quantity", "tax_rate"],
  change_price: ["price", "quantity", "proration_behavior"],
  change_quantity: ["quantity", "proration_behavior"],
  apply_coupon: ["coupon"],
  report_usage: ["quantity"],
  cancel_at_period_end: [],
  advance_to: [],
};
const LABEL: Record<EventType, string> = {
  subscribe: "Subscribe",
  start_trial: "Start trial",
  change_price: "Change price",
  change_quantity: "Change quantity",
  apply_coupon: "Apply coupon",
  report_usage: "Report usage",
  cancel_at_period_end: "Cancel at period end",
  advance_to: "Advance clock to",
};
const LOCALES = ["en-US", "de-DE", "ja-JP", "en-GB"];

const day = (iso: string) => iso.slice(0, 10);

// Edits that end up back at the scenario's timeline (add then delete, change then revert) count as unedited.
const canonical = (t: TimelineEvent[]) =>
  JSON.stringify(t.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))));
const sameTimeline = (a: TimelineEvent[], b: TimelineEvent[]) => canonical(a) === canonical(b);

export function Simulator({
  catalog,
  scenarios,
  initialScenarioId,
  initialTimeline,
  catalogParam,
}: {
  catalog: Catalog;
  scenarios: Scenario[];
  initialScenarioId?: string;
  initialTimeline?: TimelineEvent[];
  /** Encoded custom catalog, kept in share links so they replay with the same prices. */
  catalogParam?: string;
}) {
  const playable = scenarios.filter((s) => s.timeline);
  // A shared link that replays a golden scenario exactly is recognised as that scenario.
  const [scenarioId, setScenarioId] = useState(
    initialTimeline ? (playable.find((s) => s.timeline && sameTimeline(s.timeline, initialTimeline))?.id ?? "") : (initialScenarioId ?? ""),
  );
  const [timeline, setTimeline] = useState<TimelineEvent[]>(
    initialTimeline ?? playable.find((s) => s.id === initialScenarioId)?.timeline ?? [],
  );
  const [shareUrl, setShareUrl] = useState("");
  const [locale, setLocale] = useState("en-US");
  // Live check: replay this exact timeline in a Stripe test clock (POST /api/parity).
  const [stripeCheck, setStripeCheck] = useState<
    { state: "running" } | { state: "done"; match: boolean; diffs: { invoice: number; field: string; tera: unknown; stripe: unknown }[]; clock: string; count: number } | { state: "error"; error: string } | null
  >(null);

  const scenario = playable.find((s) => s.id === scenarioId);

  // React Compiler memoizes this; it only re-runs when catalog or timeline change.
  const outcome = ((): { error: string; result?: undefined } | { result: ReturnType<typeof simulate>; error?: undefined } => {
    for (let i = 1; i < timeline.length; i++)
      if (timeline[i].at < timeline[i - 1].at) return { error: `Event ${i + 1} is before event ${i}: keep the timeline in chronological order.` };
    if (timeline.length === 0) return { error: "Add a subscribe event to start." };
    try {
      return { result: simulate(catalog, timeline) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  })();

  const load = (id: string) => {
    setScenarioId(id);
    setTimeline(playable.find((s) => s.id === id)?.timeline ?? []);
    setShareUrl("");
    setStripeCheck(null);
  };
  const edit = (next: TimelineEvent[]) => {
    setTimeline(next);
    setShareUrl("");
    setStripeCheck(null);
  };
  const verifyInStripe = async () => {
    setStripeCheck({ state: "running" });
    try {
      const res = await fetch("/api/parity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeline, catalog }) });
      const body = await res.json();
      if (!res.ok) return setStripeCheck({ state: "error", error: body.error ?? `HTTP ${res.status}` });
      setStripeCheck({ state: "done", match: body.match, diffs: body.diffs, clock: body.test_clock, count: body.stripe.length });
    } catch (e) {
      setStripeCheck({ state: "error", error: (e as Error).message });
    }
  };
  const share = async () => {
    const url = `${location.origin}/?t=${encodeTimeline(timeline)}${catalogParam ? `&c=${catalogParam}` : ""}`;
    setShareUrl(url);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard can be blocked; the link is still shown below for manual copy.
    }
  };
  const update = (i: number, patch: Partial<TimelineEvent>) => edit(timeline.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  const golden =
    scenario?.expect && scenario.timeline && sameTimeline(timeline, scenario.timeline) && outcome.result
      ? outcome.result.invoices.length === scenario.expect.length &&
        outcome.result.invoices.every((inv, i) => inv.total === scenario.expect![i].total)
      : null;

  // Option labels carry the terms (amount, interval, discount) so nobody has to memorise ids.
  const optionLabel = (field: Field, id: string) => {
    if (field === "price") {
      const p = catalog.prices[id];
      return p.usage_type === "metered" ? `${id} — metered, tiered` : `${id} — ${formatMoney(p.unit_amount ?? 0, p.currency)}/${p.interval === "month" ? "mo" : "yr"}`;
    }
    if (field === "coupon") {
      const c = catalog.coupons![id];
      const off = c.percent_off != null ? `${c.percent_off}% off` : `${formatMoney(c.amount_off ?? 0, c.currency ?? "usd")} off`;
      return `${id} — ${off} ${c.duration === "repeating" ? `for ${c.duration_in_months} months` : c.duration}`;
    }
    if (field === "tax_rate") {
      const r = catalog.tax_rates![id];
      return `${id} — ${r.percentage}% ${r.behavior}`;
    }
    return id;
  };
  const prices = Object.keys(catalog.prices);
  const coupons = Object.keys(catalog.coupons ?? {});
  const taxes = Object.keys(catalog.tax_rates ?? {});

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section aria-labelledby="timeline-h" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <h2 id="timeline-h" className="mr-auto text-lg font-semibold">
            Customer timeline
          </h2>
          {playable.length > 0 && (
            <label className="max-w-full text-sm">
              <span className="block text-xs opacity-70">Load scenario</span>
              <select data-testid="scenario-select" className="input" value={scenarioId} onChange={(e) => load(e.target.value)}>
                {!scenarioId && <option value="">Custom (shared link)</option>}
                {playable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} · {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <ol className="space-y-3" data-testid="timeline">
          {timeline.map((e, i) => (
            <li key={i} className="card flex flex-wrap items-end gap-2" data-testid={`event-${i}`}>
              <span className="w-6 self-center text-xs opacity-50">{i + 1}</span>
              <label className="text-sm">
                <span className="block text-xs opacity-70">Date</span>
                <input
                  type="date"
                  className="input"
                  aria-label={`Event ${i + 1} date`}
                  value={day(e.at)}
                  onChange={(ev) => ev.target.value && update(i, { at: `${ev.target.value}T00:00:00Z` })}
                />
              </label>
              <label className="text-sm">
                <span className="block text-xs opacity-70">Event</span>
                <select
                  className="input"
                  aria-label={`Event ${i + 1} type`}
                  value={e.type}
                  onChange={(ev) => update(i, { type: ev.target.value as EventType })}
                >
                  {(Object.keys(FIELDS) as EventType[]).map((t) => (
                    <option key={t} value={t}>
                      {LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              {FIELDS[e.type].map((f) => (
                <label key={f} className="text-sm">
                  <span className="block text-xs opacity-70">{f.replace("_", " ")}</span>
                  {f === "quantity" || f === "trial_days" ? (
                    <input
                      type="number"
                      min={0}
                      className="input w-24"
                      aria-label={`Event ${i + 1} ${f}`}
                      value={e[f] ?? ""}
                      onChange={(ev) => update(i, { [f]: ev.target.value === "" ? undefined : Number(ev.target.value) })}
                    />
                  ) : (
                    <select
                      className="input"
                      aria-label={`Event ${i + 1} ${f}`}
                      value={e[f] ?? ""}
                      onChange={(ev) => update(i, { [f]: ev.target.value || undefined })}
                    >
                      <option value="">—</option>
                      {(f === "price" ? prices : f === "coupon" ? coupons : f === "tax_rate" ? taxes : ["create_prorations", "always_invoice"]).map((o) => (
                        <option key={o} value={o}>
                          {optionLabel(f, o)}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              ))}
              <button
                type="button"
                className="btn-ghost ml-auto"
                aria-label={`Delete event ${i + 1}`}
                data-testid={`delete-event-${i + 1}`}
                onClick={() => edit(timeline.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="btn mt-3"
          data-testid="add-event"
          onClick={() => {
            const last = timeline.at(-1);
            const at = last ? new Date(Date.parse(last.at) + 30 * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z" : "2027-01-01T00:00:00Z";
            edit([...timeline, last ? { at, type: "advance_to" } : { at, type: "subscribe", price: prices[0] }]);
          }}
        >
          + Add event
        </button>
        <button type="button" className="btn-ghost ml-2 mt-3 border border-current/20" data-testid="share-button" onClick={share}>
          Copy share link
        </button>
        <button
          type="button"
          className="btn-ghost ml-2 mt-3 border border-current/20"
          data-testid="verify-stripe"
          disabled={!!outcome.error || stripeCheck?.state === "running"}
          onClick={verifyInStripe}
        >
          {stripeCheck?.state === "running" ? "Replaying in Stripe…" : "Verify in Stripe"}
        </button>
        {stripeCheck && stripeCheck.state !== "running" && (
          <div role="status" data-testid="stripe-check" className="card mt-3 text-sm">
            {stripeCheck.state === "error" ? (
              <span className="text-red-700 dark:text-red-400">Stripe replay failed: {stripeCheck.error}</span>
            ) : stripeCheck.match ? (
              <span>
                <span className="badge badge-ok">✅ Matches Stripe</span> Stripe produced the same {stripeCheck.count} invoice{stripeCheck.count === 1 ? "" : "s"} to
                the cent (test clock <code className="text-xs">{stripeCheck.clock}</code>).
              </span>
            ) : (
              <>
                <span className="badge badge-bad">❌ Differs from Stripe</span>
                <ul className="mt-2 font-mono text-xs">
                  {stripeCheck.diffs.map((d, i) => (
                    <li key={i}>
                      invoice {d.invoice} {d.field}: Tera {JSON.stringify(d.tera)} · Stripe {JSON.stringify(d.stripe)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {shareUrl && (
          <label className="mt-3 block text-sm">
            <span className="block text-xs opacity-70">Link copied — anyone with it sees these exact invoices</span>
            <input readOnly className="input w-full font-mono text-xs" data-testid="share-url" value={shareUrl} onFocus={(e) => e.target.select()} />
          </label>
        )}
      </section>

      <section aria-labelledby="invoices-h" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <h2 id="invoices-h" className="mr-auto text-lg font-semibold">
            Invoices
          </h2>
          {golden !== null && (
            <span data-testid="golden-badge" className={`badge ${golden ? "badge-ok" : "badge-bad"}`}>
              {golden ? "✅ Matches golden expected" : "❌ Differs from golden expected"}
            </span>
          )}
          <label className="text-sm">
            <span className="block text-xs opacity-70">Locale</span>
            <select data-testid="locale-select" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
              {LOCALES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
        </div>

        {outcome.error ? (
          <p role="alert" data-testid="sim-error" className="card border-red-500 text-red-600">
            {outcome.error}
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm opacity-70" data-testid="sub-status">
              Status: <strong>{outcome.result!.status}</strong>
              {outcome.result!.canceled_at && ` (canceled ${outcome.result!.canceled_at})`}
            </p>
            <ol className="space-y-3">
              {outcome.result!.invoices.map((inv, i) => (
                <InvoiceCard key={i} n={i + 1} inv={inv} locale={locale} />
              ))}
            </ol>
          </>
        )}
      </section>
    </div>
  );
}

function InvoiceCard({ n, inv, locale }: { n: number; inv: Invoice; locale: string }) {
  const m = (x: number) => formatMoney(x, inv.currency, locale);
  return (
    <li className="card" data-testid={`invoice-${n}`}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-medium">
          Invoice {n} · {inv.date}
        </span>
        <span className="font-mono text-lg font-semibold" data-testid={`invoice-${n}-total`}>
          {m(inv.total)}
        </span>
      </div>
      <p className="mb-2 text-xs opacity-60">
        Period {inv.period_start} → {inv.period_end} · {inv.currency.toUpperCase()}
      </p>
      <table className="w-full text-sm">
        <tbody>
          {inv.lines.map((l, j) => (
            <tr key={j} data-testid={`invoice-${n}-line-${j + 1}`}>
              <td className="py-0.5">
                {l.description}
                {l.proration && <span className="badge ml-2">proration</span>}
              </td>
              <td className="text-right font-mono">{m(l.amount)}</td>
            </tr>
          ))}
          <tr className="border-t border-current/10">
            <td className="pt-1 opacity-70">Subtotal</td>
            <td className="pt-1 text-right font-mono" data-testid={`invoice-${n}-subtotal`}>
              {m(inv.subtotal)}
            </td>
          </tr>
          {inv.discount > 0 && (
            <tr>
              <td className="opacity-70">Discount</td>
              <td className="text-right font-mono" data-testid={`invoice-${n}-discount`}>
                −{m(inv.discount)}
              </td>
            </tr>
          )}
          {inv.starting_balance < 0 && (
            <tr>
              <td className="opacity-70">Applied credit balance</td>
              <td className="text-right font-mono" data-testid={`invoice-${n}-credit`}>
                {m(Math.max(inv.starting_balance, -Math.max(inv.total, 0)))}
              </td>
            </tr>
          )}
          {inv.amount_due !== inv.total && (
            <tr className="font-semibold">
              <td>Amount due{inv.total < 0 ? ` (${m(-inv.total)} added to credit balance)` : ""}</td>
              <td className="text-right font-mono" data-testid={`invoice-${n}-amount-due`}>
                {m(inv.amount_due)}
              </td>
            </tr>
          )}
          {inv.tax > 0 && (
            <tr>
              <td className="opacity-70">Tax{inv.total === inv.subtotal - inv.discount ? " (included)" : ""}</td>
              <td className="text-right font-mono" data-testid={`invoice-${n}-tax`}>
                {m(inv.tax)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </li>
  );
}
