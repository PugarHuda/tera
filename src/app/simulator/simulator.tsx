"use client";

import { useState } from "react";
import { BILLING_MODES, PRORATION_BEHAVIORS, TRIAL_END_BEHAVIORS, formatMoney, simulate, type Catalog, type Invoice, type TimelineEvent, type Webhook } from "@/lib/billing";
import { csvBlob, toCsv } from "@/lib/csv";
import { encodeTimeline } from "@/lib/share";
import { parseTimeline } from "@/lib/validate";

export type Scenario = { id: string; title: string; timeline?: TimelineEvent[]; expect?: { total: number }[] };
type EventType = TimelineEvent["type"];
type Field = "price" | "quantity" | "coupon" | "tax_rate" | "trial_days" | "proration_behavior" | "billing_mode" | "cancel_at" | "billing_cycle_anchor" | "trial_end_behavior" | "amount";

const FIELDS: Record<EventType, Field[]> = {
  subscribe: ["price", "quantity", "coupon", "tax_rate", "billing_mode", "billing_cycle_anchor", "proration_behavior"],
  start_trial: ["price", "trial_days", "quantity", "tax_rate", "billing_mode", "trial_end_behavior"],
  change_price: ["price", "quantity", "proration_behavior"],
  change_quantity: ["quantity", "proration_behavior"],
  apply_coupon: ["coupon"],
  report_usage: ["quantity"],
  cancel_at_period_end: [],
  resume: ["billing_cycle_anchor", "proration_behavior"],
  end_trial: [],
  cancel_now: ["proration_behavior"],
  reset_anchor: ["proration_behavior"],
  remove_coupon: [],
  cancel_at: ["cancel_at", "proration_behavior"],
  pause: ["proration_behavior"],
  adjust_balance: ["amount"],
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
  resume: "Resume (undo cancel, or unpause)",
  end_trial: "End trial now",
  cancel_now: "Cancel immediately",
  reset_anchor: "Reset billing anchor to now",
  remove_coupon: "Remove coupon",
  cancel_at: "Cancel on a date",
  pause: "Pause (flexible mode)",
  adjust_balance: "Adjust customer balance (minor units, negative = credit)",
  advance_to: "Advance clock to",
};
const LOCALES = ["en-US", "de-DE", "ja-JP", "en-GB"];
// R21: resuming a paused subscription restarts the cycle now (Stripe's default) or keeps the old anchor.
const RESUME_ANCHORS = ["now", "unchanged"];

const day = (iso: string) => iso.slice(0, 10);
// A date input reports every keystroke: "0002-02-10" while the year is being typed. The field keeps what is typed
// and only a whole date from 1970 to 2099 is committed; a controlled input would snap back and eat the keystrokes.
const typedDate = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= "1970" && v < "2100" ? `${v}T00:00:00Z` : null);

function DateField({ label, value, onCommit }: { label: string; value: string | undefined; onCommit: (iso: string | null) => void }) {
  const [draft, setDraft] = useState(value ? day(value) : "");
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    // The timeline changed from outside (scenario load, share link): show it.
    setShown(value);
    setDraft(value ? day(value) : "");
  }
  // What is typed and what the invoices use must not silently differ (a blank, half-typed or pre-1970 date).
  const stale = value !== undefined && draft !== day(value);
  return (
    <span className="inline-flex flex-col">
      <input
        type="date"
        className="input"
        aria-label={label}
        aria-invalid={stale || undefined}
        value={draft}
        onChange={(ev) => {
          setDraft(ev.target.value);
          const iso = typedDate(ev.target.value);
          if (iso || ev.target.value === "") onCommit(iso);
        }}
      />
      {stale && (
        <span role="alert" className="mt-0.5 text-xs text-red-700 dark:text-red-400">
          Not a valid calendar date from 1970 to 2099; still using {day(value)}
        </span>
      )}
    </span>
  );
}

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
  stripeLive = true,
}: {
  catalog: Catalog;
  scenarios: Scenario[];
  initialScenarioId?: string;
  initialTimeline?: TimelineEvent[];
  /** Encoded custom catalog, kept in share links so they replay with the same prices. */
  catalogParam?: string;
  /** False when the deployment has no test-mode Stripe key: a live replay cannot run. */
  stripeLive?: boolean;
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
    | { state: "running" }
    | {
        state: "done";
        match: boolean;
        diffs: { invoice: number; field: string; tera: unknown; stripe: unknown }[];
        clock: string;
        count: number;
        webhooks: { match: boolean; diffs: { event: number; type: string; tera: number; stripe: number }[]; sent: number; payloads: unknown[] };
      }
    | { state: "error"; error: string }
    | null
  >(null);

  const scenario = playable.find((s) => s.id === scenarioId);
  // An edited scenario is no longer that scenario (its label and CSV name would claim golden numbers it does not show);
  // reverting the edits makes it the scenario again.
  const shownId = scenario?.timeline && sameTimeline(timeline, scenario.timeline) ? scenarioId : "";

  // React Compiler memoizes this; it only re-runs when catalog or timeline change.
  const outcome = ((): { error: string; result?: undefined } | { result: ReturnType<typeof simulate>; error?: undefined } => {
    for (let i = 1; i < timeline.length; i++)
      if (timeline[i].at < timeline[i - 1].at) return { error: `Event ${i + 1} is before event ${i}: keep the timeline in chronological order.` };
    if (timeline.length === 0) return { error: "Add a subscribe event to start." };
    try {
      // Same checks as the API (dates, 10-year span, …) before the engine runs: an unchecked year 0202 meant
      // 21,901 renewals and a frozen tab (found by a keyboard-typing E2E test).
      return { result: simulate(catalog, parseTimeline(timeline)) };
    } catch (e) {
      // The API counts events from 0 (timeline[1]); the page numbers them from 1.
      // Engine messages name event types by their API ids; the page shows its own labels.
      const ids = new RegExp(`\\b(${Object.keys(LABEL).join("|")})\\b`, "g");
      return {
        error: (e as Error).message.replace(/timeline\[(\d+)\]\.?/g, (_, n) => `Event ${Number(n) + 1} `).replace(ids, (t) => `"${LABEL[t as EventType]}"`),
      };
    }
  })();

  // The address bar always replays what is on screen, so a reload or Back keeps the user's edits.
  const keepInUrl = (q: string) => history.replaceState(null, "", `/simulator?${q}${catalogParam ? `&c=${catalogParam}` : ""}`);
  const load = (id: string) => {
    setScenarioId(id);
    setTimeline(playable.find((s) => s.id === id)?.timeline ?? []);
    setShareUrl("");
    setStripeCheck(null);
    keepInUrl(`s=${id}`);
  };
  const edit = (next: TimelineEvent[]) => {
    setTimeline(next);
    setShareUrl("");
    setStripeCheck(null);
    // Only a timeline a reload can decode goes in the URL; a half-typed one keeps the last good link.
    // An emptied timeline drops the link, so a reload does not bring back the events just deleted.
    if (!next.length) keepInUrl("t=");
    try {
      if (parseTimeline(next).length) keepInUrl(`t=${encodeTimeline(next)}`);
    } catch {}
  };
  const verifyInStripe = async () => {
    setStripeCheck({ state: "running" });
    try {
      const post = () => fetch("/api/parity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeline, catalog }) });
      let res = await post();
      // Another visitor's live replay holds the Stripe cooldown: wait it out once instead of reporting a failure.
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after")) || 10, 60) * 1000));
        res = await post();
      }
      const body = await res.json();
      if (!res.ok) return setStripeCheck({ state: "error", error: body.error ?? `HTTP ${res.status}` });
      const hooks = body.webhooks;
      setStripeCheck({
        state: "done",
        match: body.match,
        diffs: body.diffs,
        clock: body.test_clock,
        count: body.stripe.length,
        webhooks: { match: hooks.match, diffs: hooks.diffs, sent: hooks.stripe.flat().length, payloads: hooks.payloads },
      });
    } catch (e) {
      setStripeCheck({ state: "error", error: (e as Error).message });
    }
  };
  const share = async () => {
    const url = `${location.origin}/simulator?t=${encodeTimeline(timeline)}${catalogParam ? `&c=${catalogParam}` : ""}`;
    setShareUrl(url);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard can be blocked; the link is still shown below for manual copy.
    }
  };
  const exportCsv = () => {
    const rows = outcome.result!.invoices.map((inv, i) => ({
      invoice: i + 1,
      date: inv.date,
      currency: inv.currency,
      lines: inv.lines.map((l) => `${l.description} ${l.amount}`).join("; "),
      subtotal: inv.subtotal,
      discount: inv.discount,
      tax: inv.tax,
      total: inv.total,
      starting_balance: inv.starting_balance,
      amount_due: inv.amount_due,
    }));
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(csvBlob(toCsv(rows))),
      download: `tera-invoices${shownId ? `-${shownId}` : ""}.csv`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // The events the test clock really sent, full payloads, to replay into a webhook handler's tests.
  const exportPayloads = (payloads: unknown[], clock: string) => {
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([JSON.stringify(payloads, null, 2)], { type: "application/json" })),
      download: `stripe-webhooks-${clock}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
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
          <h2 id="timeline-h" className="mr-auto text-2xl font-medium">
            Customer timeline
          </h2>
          {playable.length > 0 && (
            <label className="max-w-full text-sm">
              <span className="block text-xs opacity-70">Load scenario</span>
              <select data-testid="scenario-select" className="input" value={shownId} onChange={(e) => load(e.target.value)}>
                {!shownId && <option value="">{scenarioId ? "Custom (edited)" : "Custom (shared link)"}</option>}
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
              <label className="max-w-full text-sm">
                <span className="block text-xs opacity-70">Date</span>
                <DateField label={`Event ${i + 1} date`} value={e.at} onCommit={(at) => at && update(i, { at })} />
              </label>
              <label className="max-w-full text-sm">
                <span className="block text-xs opacity-70">Event</span>
                <select
                  className="input"
                  aria-label={`Event ${i + 1} type`}
                  value={e.type}
                  onChange={(ev) => {
                    // Fields the new type does not show must not keep billing: a hidden coupon on a trial was still applied.
                    const type = ev.target.value as EventType;
                    const kept = FIELDS[type].filter((f) => e[f] !== undefined && !(f === "billing_cycle_anchor" && (type === "resume") !== (e.type === "resume")));
                    // A trial needs a length (Stripe starts none without trial_period_days): start from 14 days.
                    const trial = type === "start_trial" && !kept.includes("trial_days") ? { trial_days: 14 } : {};
                    edit(timeline.map((x, j) => (j === i ? { at: x.at, type, ...Object.fromEntries(kept.map((f) => [f, x[f]])), ...trial } : x)));
                  }}
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
                  <span className="block text-xs opacity-70">{f.replaceAll("_", " ")}</span>
                  {f === "cancel_at" || (f === "billing_cycle_anchor" && e.type !== "resume") ? (
                    <DateField label={`Event ${i + 1} ${f}`} value={e[f]} onCommit={(v) => update(i, { [f]: v ?? undefined })} />
                  ) : f === "quantity" || f === "trial_days" || f === "amount" ? (
                    <input
                      type="number"
                      min={f === "amount" ? undefined : 0}
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
                      {(f === "price" ? prices : f === "coupon" ? coupons : f === "tax_rate" ? taxes : f === "billing_mode" ? BILLING_MODES : f === "billing_cycle_anchor" ? RESUME_ANCHORS : f === "trial_end_behavior" ? TRIAL_END_BEHAVIORS : PRORATION_BEHAVIORS).map((o) => (
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
                onClick={() => {
                  edit(timeline.filter((_, j) => j !== i));
                  // Focus would land on the next row's delete button, so a second Enter deletes that event too.
                  document.querySelector<HTMLElement>("[data-testid=add-event]")?.focus();
                }}
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
          disabled={timeline.length >= 100}
          title={timeline.length >= 100 ? "A timeline is limited to 100 events" : undefined}
          onClick={() => {
            const last = timeline.at(-1);
            const at = last ? new Date(Date.parse(last.at) + 30 * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z" : "2027-01-01T00:00:00Z";
            edit([...timeline, last ? { at, type: "advance_to" } : { at, type: "subscribe", price: prices[0] }]);
          }}
        >
          + Add event
        </button>
        <button type="button" className="btn-ghost ml-2 mt-3 border border-current/20" data-testid="share-button" disabled={timeline.length === 0} onClick={share}>
          Copy share link
        </button>
        <button
          type="button"
          className="btn-ghost ml-2 mt-3 border border-current/20"
          data-testid="verify-stripe"
          disabled={!stripeLive || !!outcome.error || stripeCheck?.state === "running"}
          title={stripeLive ? undefined : "This deployment has no Stripe test-mode key (STRIPE_SECRET_KEY)"}
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
                      {d.invoice ? `invoice ${d.invoice} ` : ""}{d.field}: Tera {JSON.stringify(d.tera)} · Stripe {JSON.stringify(d.stripe)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {stripeCheck.state === "done" && (
              <p className="mt-2" data-testid="stripe-check-webhooks">
                {stripeCheck.webhooks.match ? (
                  <>
                    <span className="badge badge-ok">✅ Webhooks match</span> Stripe sent the {stripeCheck.webhooks.sent} webhook event
                    {stripeCheck.webhooks.sent === 1 ? "" : "s"} Tera predicts.
                  </>
                ) : (
                  <>
                    <span className="badge badge-bad">❌ Webhooks differ</span>
                    <span className="mt-1 block font-mono text-xs">
                      {stripeCheck.webhooks.diffs.map((d) => `event ${d.event + 1} ${d.type}: Tera ${d.tera} · Stripe ${d.stripe}`).join("; ")}
                    </span>
                  </>
                )}
                {stripeCheck.webhooks.payloads.length > 0 && (
                  <button
                    type="button"
                    className="btn-ghost mt-1 block border border-current/20 text-xs"
                    data-testid="export-stripe-webhooks"
                    onClick={() => exportPayloads(stripeCheck.webhooks.payloads, stripeCheck.clock)}
                  >
                    Download the {stripeCheck.webhooks.payloads.length} events Stripe sent (JSON, full payloads)
                  </button>
                )}
                {stripeCheck.webhooks.payloads.length > 0 && (
                  <span className="mt-1 block text-xs opacity-80" data-testid="replay-hint">
                    Replay them into your handler, signed with your endpoint secret as Stripe signs them:{" "}
                    <code className="break-all">
                      STRIPE_WEBHOOK_SECRET=whsec_… node <a className="underline" href="/replay-webhooks.mjs" download>replay-webhooks.mjs</a> stripe-webhooks-
                      {stripeCheck.clock}.json http://localhost:3000/api/webhooks
                    </code>
                  </span>
                )}
              </p>
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
          <h2 id="invoices-h" className="mr-auto text-2xl font-medium">
            Invoices
          </h2>
          {golden !== null && (
            <span data-testid="golden-badge" className={`badge ${golden ? "badge-ok" : "badge-bad"}`}>
              {golden ? "✅ Matches golden expected" : "❌ Differs from golden expected"}
            </span>
          )}
          <label className="max-w-full text-sm">
            <span className="block text-xs opacity-70">Locale</span>
            <select data-testid="locale-select" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
              {LOCALES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
        </div>

        <details className="mb-4 text-sm" data-testid="how-to-read">
          <summary className="cursor-pointer opacity-80">How to read these invoices</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 opacity-80">
            <li>Each invoice is what Stripe would charge on that date, to the cent, for the timeline on the left.</li>
            <li>
              Lines marked <em>proration</em> are Stripe&rsquo;s credit for the old plan and charge for the new one when something changes
              mid-period; they are billed on the next invoice unless the event says otherwise.
            </li>
            <li>The green badge means these totals equal the scenario&rsquo;s expected invoices, derived by hand, not by this engine.</li>
            <li>
              <strong>Verify in Stripe</strong> replays this exact timeline in a fresh Stripe test clock and shows any difference, so you can check
              any edit yourself.
            </li>
          </ul>
        </details>

        {outcome.error ? (
          <p role="alert" data-testid="sim-error" className="card border-red-500 text-red-700 dark:text-red-400">
            {outcome.error}
          </p>
        ) : (
          <>
            <p className="mb-3 flex items-center gap-2 text-sm" data-testid="sub-status">
              <span className="opacity-70">
                Status: <strong>{outcome.result!.status}</strong>
                {outcome.result!.canceled_at && ` (canceled ${outcome.result!.canceled_at})`}
              </span>
              {outcome.result!.invoices.length > 0 && (
                <button type="button" className="btn-ghost ml-auto border border-current/20 text-xs" data-testid="export-invoices" onClick={exportCsv}>
                  Export CSV (minor units)
                </button>
              )}
            </p>
            <ol className="space-y-3">
              {outcome.result!.invoices.map((inv, i) => (
                <InvoiceCard key={i} n={i + 1} inv={inv} locale={locale} />
              ))}
            </ol>
            <Webhooks hooks={outcome.result!.webhooks} timeline={timeline} />
          </>
        )}
      </section>
    </div>
  );
}

// The webhook events Stripe sends for the timeline, grouped by the event that causes them, so a webhook handler can be
// tested against the same sequence.
function Webhooks({ hooks, timeline }: { hooks: Webhook[]; timeline: TimelineEvent[] }) {
  if (hooks.length === 0) return null;
  const steps = timeline.map((e, i) => ({ e, i, hooks: hooks.filter((h) => h.event === i) })).filter((s) => s.hooks.length > 0);
  return (
    <details className="card mt-3 text-sm" data-testid="webhooks">
      <summary className="cursor-pointer font-semibold">Webhook events Stripe sends ({hooks.length})</summary>
      <ol className="mt-2 space-y-2">
        {steps.map(({ e, i, hooks }) => (
          <li key={i} data-testid={`webhooks-${i + 1}`}>
            <span className="text-xs opacity-70">
              Event {i + 1} · {LABEL[e.type]} · {e.at.slice(0, 10)}
            </span>
            <ul className="font-mono text-xs">
              {hooks.map((h, j) => (
                <li key={j}>
                  {h.date} {h.type}
                  {h.invoice ? ` → invoice ${h.invoice}` : h.status ? ` (${h.status})` : ""}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  );
}

function InvoiceCard({ n, inv, locale }: { n: number; inv: Invoice; locale: string }) {
  const m = (x: number) => formatMoney(x, inv.currency, locale);
  return (
    <li className="card" data-testid={`invoice-${n}`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="whitespace-nowrap font-medium">
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
                {m(-inv.discount)}
              </td>
            </tr>
          )}
          {/* A credit invoice carries negative tax (R6); shown before what is applied or due. */}
          {inv.tax !== 0 && (
            <tr>
              <td className="opacity-70">Tax{inv.total === inv.subtotal - inv.discount ? " (included)" : ""}</td>
              <td className="text-right font-mono" data-testid={`invoice-${n}-tax`}>
                {m(inv.tax)}
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
          {inv.starting_balance > 0 && (
            <tr>
              <td className="opacity-70">Customer balance owed (a debit, or an amount below the minimum charge carried over)</td>
              <td className="text-right font-mono" data-testid={`invoice-${n}-carried`}>
                +{m(inv.starting_balance)}
              </td>
            </tr>
          )}
          {inv.amount_due !== inv.total && (
            <tr className="font-semibold">
              <td>
                Amount due
                {inv.total < 0
                  ? ` (${m(-inv.total)} added to credit balance)`
                  : inv.amount_due === 0 && inv.total + inv.starting_balance > 0
                    ? ` (${m(inv.total + inv.starting_balance)} is below Stripe's minimum charge, carried to the next invoice)`
                    : ""}
              </td>
              <td className="text-right font-mono" data-testid={`invoice-${n}-amount-due`}>
                {m(inv.amount_due)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </li>
  );
}
