"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney, type Catalog, type Coupon, type Interval, type Price, type TaxRate } from "@/lib/billing";
import { encodeCatalog } from "@/lib/share";
import { BadRequest, parseCatalog } from "@/lib/validate";

const CURRENCIES = ["usd", "eur", "gbp", "jpy"];
const STORAGE_KEY = "tera.builder.catalog";
const digits = (currency: string) => new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;

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

// Major units in the form, minor units in the catalog. Returns the first problem in plain words.
function toCatalog(rows: Rows, fixed: Record<string, Price>): { catalog?: Catalog; error?: string } {
  const prices: Record<string, Price> = { ...fixed };
  for (const r of rows.prices) {
    const d = digits(r.currency);
    if (d === 0 && /[.,]/.test(r.amount)) return { error: `${r.id}: ${r.currency.toUpperCase()} has no minor unit, so the amount cannot have decimals` };
    const minor = Math.round(Number(r.amount) * 10 ** d);
    if (!r.amount.trim() || !Number.isFinite(minor) || Math.abs(Number(r.amount) * 10 ** d - minor) > 1e-6)
      return { error: `${r.id}: "${r.amount}" is not a valid ${r.currency.toUpperCase()} amount` };
    if (prices[r.id]) return { error: `Price id ${r.id} is used twice` };
    prices[r.id] = { currency: r.currency, unit_amount: minor, interval: r.interval };
  }
  const coupons: Record<string, Coupon> = {};
  for (const r of rows.coupons) {
    const v = Number(r.value);
    coupons[r.code] = {
      duration: r.duration,
      ...(r.duration === "repeating" ? { duration_in_months: Number(r.months) } : {}),
      ...(r.kind === "percent" ? { percent_off: v } : { amount_off: Math.round(v * 10 ** digits(r.currency)), currency: r.currency }),
    };
  }
  const tax_rates: Record<string, TaxRate> = Object.fromEntries(rows.taxes.map((r) => [r.id, { percentage: Number(r.percentage), behavior: r.behavior }]));
  try {
    return { catalog: parseCatalog({ prices, coupons, tax_rates }) };
  } catch (e) {
    return { error: e instanceof BadRequest ? e.message : String(e) };
  }
}

type PushResult = { prices: Record<string, string>; coupons: Record<string, string>; taxRates: Record<string, string>; dashboard: string };

export function Builder({ reference }: { reference: Catalog }) {
  const [rows, setRows] = useState<Rows>(() => toRows(reference));
  const [push, setPush] = useState<{ busy: boolean; result?: PushResult; error?: string }>({ busy: false });

  // Per-viewer convenience: keep the draft across reloads (never required for correctness).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // Loaded after hydration on purpose: reading it during render would mismatch the server HTML.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setRows(JSON.parse(saved));
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    } catch {}
  }, [rows]);

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
                {CURRENCIES.map((c) => (
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
                {CURRENCIES.map((x) => (
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
          <p role="alert" className="text-red-600" data-testid="builder-error">
            {error}
          </p>
        ) : (
          <p className="text-sm text-green-700" data-testid="builder-valid">
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
          <button type="button" className="btn-ghost" onClick={() => setRows(toRows(reference))}>
            Reset to reference catalog
          </button>
        </div>
        {push.error && (
          <p role="alert" className="text-sm text-red-600">
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
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
