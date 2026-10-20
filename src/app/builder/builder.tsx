"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney, type Catalog, type Coupon, type Interval, type Price, type TaxRate } from "@/lib/billing";
import { digits, minorOf } from "@/lib/money";
import { encodeCatalog } from "@/lib/share";
import { BadRequest, parseCatalog } from "@/lib/validate";

const CURRENCIES = ["usd", "eur", "gbp", "jpy"];
const STORAGE_KEY = "tera.builder.catalog";
// An imported Stripe catalog may use any currency; it stays selectable next to the usual four.
const currencyOptions = (c: string) => (CURRENCIES.includes(c) ? CURRENCIES : [...CURRENCIES, c]);

type PriceRow = { id: string; currency: string; amount: string; interval: Interval };
type CouponRow = { code: string; kind: "percent" | "amount"; value: string; currency: string; duration: Coupon["duration"]; months: string };
type TaxRow = { id: string; percentage: string; behavior: TaxRate["behavior"] };
type Rows = { prices: PriceRow[]; coupons: CouponRow[]; taxes: TaxRow[] };

function toRows(c: Catalog): Rows {
  return {
    prices: Object.entries(c.prices)
      .filter(([, p]) => p.usage_type !== "metered")
      .map(([id, p]) => ({ id, currency: p.currency, amount: String((p.unit_amount ?? 0) / 10 ** digits(p.currency)), interval: p.interval })),
    coupons: Object.entries(c.coupons ?? {}).map(([code, k]) => ({
      code,
      kind: k.percent_off != null ? "percent" : "amount",
      value: String(k.percent_off ?? (k.amount_off ?? 0) / 10 ** digits(k.currency ?? "usd")),
      currency: k.currency ?? "usd",
      duration: k.duration,
      months: String(k.duration_in_months ?? 3),
    })),
    taxes: Object.entries(c.tax_rates ?? {}).map(([id, r]) => ({ id, percentage: String(r.percentage), behavior: r.behavior })),
  };
}

const PLAIN = /^\d+(\.\d+)?$/; // no "0x10", "1e3", "Infinity" or blanks

// Major units in the form, minor units in the catalog. Returns the first problem in plain words.
function toCatalog(rows: Rows, fixed: Record<string, Price>): { catalog?: Catalog; error?: string } {
  // Rows first, in the order shown (the simulator starts on the first price); kept metered prices after them.
  // Null-prototype maps: an id "__proto__" becomes a real key the validator rejects, not a silently dropped entry.
  const prices: Record<string, Price> = Object.create(null);
  for (const r of rows.prices) {
    const minor = minorOf(r.amount, r.currency, r.id);
    if (typeof minor === "string") return { error: minor };
    if (Object.hasOwn(prices, r.id) || Object.hasOwn(fixed, r.id)) return { error: `Price id ${r.id} is used twice` };
    prices[r.id] = { currency: r.currency, unit_amount: minor, interval: r.interval };
  }
  Object.assign(prices, fixed);
  const coupons: Record<string, Coupon> = Object.create(null);
  for (const r of rows.coupons) {
    if (Object.hasOwn(coupons, r.code)) return { error: `Coupon code ${r.code} is used twice` };
    if (r.kind === "percent" && !PLAIN.test(r.value.trim())) return { error: `${r.code}: "${r.value}" is not a percentage` };
    const off = r.kind === "amount" ? minorOf(r.value, r.currency, r.code) : 0;
    if (typeof off === "string") return { error: off };
    coupons[r.code] = {
      duration: r.duration,
      ...(r.duration === "repeating" ? { duration_in_months: Number(r.months) } : {}),
      ...(r.kind === "percent" ? { percent_off: Number(r.value) } : { amount_off: off, currency: r.currency }),
    };
  }
  const tax_rates: Record<string, TaxRate> = Object.create(null);
  for (const r of rows.taxes) {
    if (Object.hasOwn(tax_rates, r.id)) return { error: `Tax rate id ${r.id} is used twice` };
    if (!PLAIN.test(r.percentage.trim())) return { error: `${r.id}: "${r.percentage}" is not a percentage` };
    tax_rates[r.id] = { percentage: Number(r.percentage), behavior: r.behavior };
  }
  try {
    return { catalog: parseCatalog({ prices, coupons, tax_rates }) };
  } catch (e) {
    return { error: e instanceof BadRequest ? e.message : String(e) };
  }
}

// A draft saved by an older version (or edited by hand) may lack fields; a missing currency crashed the page.
function normalize(x: Partial<Rows>): Rows {
  const cur = (c: unknown) => (typeof c === "string" && /^[a-z]{3}$/.test(c) ? c : "usd");
  return {
    prices: (Array.isArray(x.prices) ? x.prices : []).map((p) => ({ id: String(p.id ?? ""), currency: cur(p.currency), amount: String(p.amount ?? ""), interval: p.interval === "year" ? "year" : "month" })),
    coupons: (Array.isArray(x.coupons) ? x.coupons : []).map((c) => ({
      code: String(c.code ?? ""),
      kind: c.kind === "amount" ? "amount" : "percent",
      value: String(c.value ?? ""),
      currency: cur(c.currency),
      duration: (["once", "repeating", "forever"] as const).includes(c.duration) ? c.duration : "once",
      months: String(c.months ?? "3"),
    })),
    taxes: (Array.isArray(x.taxes) ? x.taxes : []).map((t) => ({ id: String(t.id ?? ""), percentage: String(t.percentage ?? ""), behavior: t.behavior === "inclusive" ? "inclusive" : "exclusive" })),
  };
}

type PushResult = { prices: Record<string, string>; coupons: Record<string, string>; taxRates: Record<string, string>; meterId: string | null };

export function Builder({ reference, stripeLive = false }: { reference: Catalog; stripeLive?: boolean }) {
  const [rows, setRows] = useState<Rows>(() => toRows(reference));
  const [push, setPush] = useState<{ busy: boolean; result?: PushResult; error?: string }>({ busy: false });
  const [pull, setPull] = useState<{ busy: boolean; note?: string }>({ busy: false });

  // Per-viewer convenience: keep the draft across reloads (never required for correctness).
  // Saving waits for the load: otherwise the first save writes the reference rows over the draft before it is read
  // (React Strict Mode runs the effects twice, found by QA).
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // Loaded after hydration on purpose: reading it during render would mismatch the server HTML.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setRows(normalize(JSON.parse(saved)));
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    } catch {}
  }, [rows, loaded]);

  // Metered (tiered) prices are not editable here; they are carried over unchanged so nothing is silently dropped.
  const metered = useMemo(() => Object.fromEntries(Object.entries(reference.prices).filter(([, p]) => p.usage_type === "metered")), [reference]);
  const { catalog, error } = useMemo(() => toCatalog(rows, metered), [rows, metered]);
  const set = <K extends keyof Rows>(k: K, i: number, patch: Partial<Rows[K][number]>) =>
    setRows((r) => ({ ...r, [k]: r[k].map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const remove = (k: keyof Rows, i: number) => setRows((r) => ({ ...r, [k]: r[k].filter((_, j) => j !== i) }));

  const pushToStripe = async () => {
    if (!catalog) return;
    setPush({ busy: true });
    try {
      const res = await fetch("/api/stripe/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ catalog }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setPush({ busy: false, result: body });
    } catch (e) {
      setPush({ busy: false, error: (e as Error).message });
    }
  };

  const importFromStripe = async () => {
    setPull({ busy: true });
    try {
      const res = await fetch("/api/stripe/catalog");
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const { catalog: c, skipped } = body as { catalog: Catalog; skipped: Record<"prices" | "coupons" | "tax_rates", number> };
      // The builder keeps its metered prices next to the imported ones, so they share the 50-price limit: an account with 50
      // importable prices made a catalog of 51 that failed validation (found by the J2b E2E journey).
      const room = 50 - Object.keys(metered).length;
      const all = Object.keys(c.prices).length;
      const n = Math.min(all, room);
      if (n === 0) throw new Error("no per-seat monthly or yearly prices in the connected account; the catalog was left as it was");
      setRows(toRows({ ...c, prices: Object.fromEntries(Object.entries(c.prices).slice(0, n)) }));
      skipped.prices += all - n;
      const left = skipped.prices + skipped.coupons + skipped.tax_rates;
      setPull({
        busy: false,
        note: `Imported ${n} prices, ${Object.keys(c.coupons ?? {}).length} coupons and ${Object.keys(c.tax_rates ?? {}).length} tax rates from Stripe` +
          (left ? ` (left out: ${skipped.prices} prices, ${skipped.coupons} coupons, ${skipped.tax_rates} tax rates: older copies, over the catalog limits or not modelled by Tera).` : "."),
      });
    } catch (e) {
      setPull({ busy: false, note: `Stripe: ${(e as Error).message}` });
    }
  };

  return (
    <div className="space-y-6">
      <section className="card space-y-3" aria-labelledby="prices-h">
        <h2 id="prices-h" className="font-semibold">Prices</h2>
        {Object.keys(metered).length > 0 && (
          <p className="text-xs opacity-60">
            Metered prices with graduated tiers ({Object.keys(metered).join(", ")}) are kept unchanged and included in the catalog.
          </p>
        )}
        {rows.prices.map((p, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2" data-testid={`price-row-${i}`}>
            <label className="text-sm">
              <span className="block text-xs opacity-70">Price id</span>
              <input className="input w-36 font-mono" aria-label={`Price ${i + 1} id`} value={p.id} onChange={(e) => set("prices", i, { id: e.target.value })} />
            </label>
            <label className="text-sm">
              <span className="block text-xs opacity-70">Currency</span>
              <select className="input" aria-label={`Price ${i + 1} currency`} value={p.currency} onChange={(e) => set("prices", i, { currency: e.target.value })}>
                {currencyOptions(p.currency).map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs opacity-70">Amount</span>
              <input className="input w-28" inputMode="decimal" aria-label={`Price ${i + 1} amount`} value={p.amount} onChange={(e) => set("prices", i, { amount: e.target.value })} />
            </label>
            <label className="text-sm">
              <span className="block text-xs opacity-70">Interval</span>
              <select className="input" aria-label={`Price ${i + 1} interval`} value={p.interval} onChange={(e) => set("prices", i, { interval: e.target.value as Interval })}>
                <option value="month">monthly</option>
                <option value="year">yearly</option>
              </select>
            </label>
            <span className="self-center font-mono text-sm opacity-70" data-testid={`price-row-${i}-preview`}>
              {catalog?.prices[p.id] ? `${formatMoney(catalog.prices[p.id].unit_amount!, p.currency)}/${p.interval === "month" ? "mo" : "yr"}` : ""}
            </span>
            <button type="button" className="btn-ghost ml-auto" aria-label={`Delete price ${i + 1}`} onClick={() => remove("prices", i)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost border border-current/20 text-sm"
          onClick={() => setRows((r) => ({ ...r, prices: [...r.prices, { id: `plan_${r.prices.length + 1}`, currency: "usd", amount: "19.00", interval: "month" }] }))}
        >
          + Add price
        </button>
      </section>

      <section className="card space-y-3" aria-labelledby="coupons-h">
        <h2 id="coupons-h" className="font-semibold">Coupons</h2>
        {rows.coupons.map((c, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="block text-xs opacity-70">Code</span>
              <input className="input w-32 font-mono" aria-label={`Coupon ${i + 1} code`} value={c.code} onChange={(e) => set("coupons", i, { code: e.target.value })} />
            </label>
            <label className="text-sm">
              <span className="block text-xs opacity-70">Type</span>
              <select className="input" aria-label={`Coupon ${i + 1} type`} value={c.kind} onChange={(e) => set("coupons", i, { kind: e.target.value as CouponRow["kind"] })}>
                <option value="percent">% off</option>
                <option value="amount">amount off</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs opacity-70">{c.kind === "percent" ? "Percent" : "Amount"}</span>
              <input className="input w-20" inputMode="decimal" aria-label={`Coupon ${i + 1} value`} value={c.value} onChange={(e) => set("coupons", i, { value: e.target.value })} />
            </label>
            {c.kind === "amount" && (
              <select className="input" aria-label={`Coupon ${i + 1} currency`} value={c.currency} onChange={(e) => set("coupons", i, { currency: e.target.value })}>
                {currencyOptions(c.currency).map((x) => (
                  <option key={x} value={x}>
                    {x.toUpperCase()}
                  </option>
                ))}
              </select>
            )}
            <label className="text-sm">
              <span className="block text-xs opacity-70">Duration</span>
              <select className="input" aria-label={`Coupon ${i + 1} duration`} value={c.duration} onChange={(e) => set("coupons", i, { duration: e.target.value as Coupon["duration"] })}>
                <option value="once">once</option>
                <option value="repeating">repeating</option>
                <option value="forever">forever</option>
              </select>
            </label>
            {c.duration === "repeating" && (
              <label className="text-sm">
                <span className="block text-xs opacity-70">Months</span>
                <input className="input w-16" inputMode="numeric" aria-label={`Coupon ${i + 1} months`} value={c.months} onChange={(e) => set("coupons", i, { months: e.target.value })} />
              </label>
            )}
            <button type="button" className="btn-ghost ml-auto" aria-label={`Delete coupon ${i + 1}`} onClick={() => remove("coupons", i)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost border border-current/20 text-sm"
          onClick={() => setRows((r) => ({ ...r, coupons: [...r.coupons, { code: `PROMO${r.coupons.length + 1}`, kind: "percent", value: "10", currency: "usd", duration: "once", months: "3" }] }))}
        >
          + Add coupon
        </button>
      </section>

      <section className="card space-y-3" aria-labelledby="tax-h">
        <h2 id="tax-h" className="font-semibold">Tax rates</h2>
        {rows.taxes.map((t, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="block text-xs opacity-70">Id</span>
              <input className="input w-32 font-mono" aria-label={`Tax ${i + 1} id`} value={t.id} onChange={(e) => set("taxes", i, { id: e.target.value })} />
            </label>
            <label className="text-sm">
              <span className="block text-xs opacity-70">Percent</span>
              <input className="input w-20" inputMode="decimal" aria-label={`Tax ${i + 1} percent`} value={t.percentage} onChange={(e) => set("taxes", i, { percentage: e.target.value })} />
            </label>
            <label className="text-sm">
              <span className="block text-xs opacity-70">Behavior</span>
              <select className="input" aria-label={`Tax ${i + 1} behavior`} value={t.behavior} onChange={(e) => set("taxes", i, { behavior: e.target.value as TaxRate["behavior"] })}>
                <option value="exclusive">exclusive (added)</option>
                <option value="inclusive">inclusive (in price)</option>
              </select>
            </label>
            <button type="button" className="btn-ghost ml-auto" aria-label={`Delete tax ${i + 1}`} onClick={() => remove("taxes", i)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost border border-current/20 text-sm"
          onClick={() => setRows((r) => ({ ...r, taxes: [...r.taxes, { id: `tax_${r.taxes.length + 1}`, percentage: "11", behavior: "exclusive" }] }))}
        >
          + Add tax rate
        </button>
      </section>

      <section className="card space-y-3">
        {error ? (
          <p role="alert" className="text-red-700 dark:text-red-400" data-testid="builder-error">
            {error}
          </p>
        ) : (
          <p className="text-sm text-green-700 dark:text-green-400" data-testid="builder-valid">
            Catalog is valid: {Object.keys(catalog!.prices).length} prices, {Object.keys(catalog!.coupons ?? {}).length} coupons,{" "}
            {Object.keys(catalog!.tax_rates ?? {}).length} tax rates.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <a
            className={`btn ${catalog ? "" : "pointer-events-none opacity-40"}`}
            href={catalog ? `/?c=${encodeCatalog(catalog)}` : undefined}
            aria-disabled={!catalog}
            data-testid="simulate-catalog"
          >
            Simulate with this catalog
          </a>
          <button type="button" className="btn-ghost border border-current/20" disabled={!catalog || push.busy} onClick={pushToStripe} data-testid="push-stripe">
            {push.busy ? "Pushing to Stripe…" : "Push to Stripe (test mode)"}
          </button>
          {stripeLive && (
            <button type="button" className="btn-ghost border border-current/20" disabled={pull.busy} onClick={importFromStripe} data-testid="pull-stripe">
              {pull.busy ? "Importing from Stripe…" : "Import from Stripe"}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={() => setRows(toRows(reference))}>
            Reset to reference catalog
          </button>
        </div>
        {pull.note && (
          <p className="text-sm opacity-80" role="status" data-testid="pull-note">
            {pull.note}
          </p>
        )}
        {push.error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {push.error}
          </p>
        )}
        {push.result && (
          <div className="text-sm" data-testid="push-result">
            <p className="font-medium">Created or reused in Stripe test mode:</p>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
              {Object.entries(push.result.prices).map(([id, sid]) => (
                <li key={id}>
                  {id} → {sid}
                </li>
              ))}
              {Object.entries(push.result.coupons).map(([id, sid]) => (
                <li key={id}>
                  coupon {id} → {sid}
                </li>
              ))}
              {Object.entries(push.result.taxRates).map(([id, sid]) => (
                <li key={id}>
                  tax {id} → {sid}
                </li>
              ))}
              {push.result.meterId && <li>meter tera_api_calls → {push.result.meterId}</li>}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
