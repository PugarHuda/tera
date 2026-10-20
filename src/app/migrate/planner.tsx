"use client";

import { useState } from "react";
import { formatMoney, migrate, type Interval } from "@/lib/billing";
import { parseMigration } from "@/lib/validate";
import { csvBlob, parseCustomers, toCsv } from "@/lib/csv";

// Minor units per the currency (JPY has none, USD two), as Stripe and formatMoney count them.
const digits = (currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
const CURRENCIES = ["usd", "eur", "gbp", "jpy", "aud", "cad", "sgd", "idr"];
const SAMPLE = "name,seats\nAcme Inc,12\nGlobex,3\nInitech,1\nUmbrella,40";

export function Planner() {
  const [oldPrice, setOldPrice] = useState("29.00");
  const [newPrice, setNewPrice] = useState("39.00");
  const [interval, setInterval] = useState<Interval>("month");
  const [currency, setCurrency] = useState("usd");
  const toMinor = (s: string) => Math.round(Number(s) * 10 ** digits(currency));
  const [grandfather, setGrandfather] = useState(false);
  const [seats, setSeats] = useState("1, 1, 3");

  const parsed = parseCustomers(seats);
  const error =
    !(toMinor(oldPrice) > 0) || !(toMinor(newPrice) > 0)
      ? "Prices must be positive amounts."
      : parsed.errors.length > 0
        ? parsed.errors[0].includes("whole number") && !seats.includes("\n")
          ? "Seat counts must be positive whole numbers."
          : parsed.errors.join(" · ")
        : parsed.customers.length === 0
          ? "Add at least one customer."
          : null;
  // Same limits as the API (Infinity, 1e20 or 20-digit seat counts would print $∞ or inexact sums).
  let report: ReturnType<typeof migrate> | null = null;
  let limit: string | null = null;
  if (!error)
    try {
      report = migrate(parseMigration({ unit_amount: toMinor(oldPrice), new_unit_amount: toMinor(newPrice), grandfather, customers: parsed.customers, interval }));
    } catch (e) {
      limit = /unit_amount must be/.test((e as Error).message) ? "Prices must be positive amounts." : (e as Error).message;
    }
  const usd = (x: number) => formatMoney(x, currency);
  const signed = (x: number) => `${x >= 0 ? "+" : ""}${usd(x)}`;
  const major = (x: number) => x / 10 ** digits(currency);
  const ranked = report ? [...report.per_customer].sort((a, b) => b.mrr_delta - a.mrr_delta || a.name.localeCompare(b.name)) : [];

  const download = () => {
    if (!report) return;
    const csv = toCsv(report.per_customer.map((c) => ({ name: c.name, seats: c.seats, currency, mrr_before: major(c.mrr_before), mrr_after: major(c.mrr_after), mrr_delta: major(c.mrr_delta) })));
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(csvBlob(csv)), download: "tera-migration-impact.csv" });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <form className="card space-y-4" onSubmit={(e) => e.preventDefault()}>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            Current price ({currency.toUpperCase()})
            <input className="input mt-1 w-full" inputMode="decimal" value={oldPrice} onChange={(e) => setOldPrice(e.target.value)} />
          </label>
          <label className="block text-sm">
            New price ({currency.toUpperCase()})
            <input className="input mt-1 w-full" inputMode="decimal" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
          </label>
        </div>
        <label className="block text-sm">
          Currency
          <select className="input mt-1 w-full" value={currency} onChange={(e) => setCurrency(e.target.value)} data-testid="currency-select">
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
                {digits(c) === 0 ? " (no minor unit)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Billing interval
          <select className="input mt-1 w-full" value={interval} onChange={(e) => setInterval(e.target.value as Interval)} data-testid="interval-select">
            <option value="month">Monthly price</option>
            <option value="year">Annual price (MRR = price ÷ 12)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={grandfather} onChange={(e) => setGrandfather(e.target.checked)} />
          Grandfather existing customers (keep them on the current price)
        </label>
        <label className="block text-sm">
          Customer base: seats per customer, comma separated, or a CSV with <code>name,seats</code>
          <textarea className="input mt-1 w-full font-mono text-xs" rows={6} value={seats} onChange={(e) => setSeats(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2 text-sm">
          <label className="btn-ghost cursor-pointer border border-current/20">
            Import CSV file
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              data-testid="csv-file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setSeats(await f.text());
              }}
            />
          </label>
          <button type="button" className="btn-ghost border border-current/20" onClick={() => setSeats(SAMPLE)}>
            Load sample customers
          </button>
        </div>
      </form>

      <section aria-label="Impact report" className="card space-y-4">
        {error || !report ? (
          <p role="alert" className="text-red-600 dark:text-red-400" data-testid="migrate-error">
            {error ?? limit}
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-y-3">
              <dt className="opacity-70">Customers affected</dt>
              <dd className="text-right font-mono" data-testid="affected">{report.affected}</dd>
              <dt className="opacity-70">MRR before</dt>
              <dd className="text-right font-mono" data-testid="mrr-before">{usd(report.mrr_before)}</dd>
              <dt className="opacity-70">MRR after</dt>
              <dd className="text-right font-mono" data-testid="mrr-after">{usd(report.mrr_after)}</dd>
              <dt className="opacity-70">MRR change</dt>
              <dd className="text-right font-mono font-semibold" data-testid="mrr-delta">{signed(report.mrr_delta)}</dd>
              <dt className="opacity-70">ARR change (× 12)</dt>
              <dd className="text-right font-mono" data-testid="arr-delta">{signed(report.mrr_delta * 12)}</dd>
            </dl>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Who pays more</h2>
                <button type="button" className="btn-ghost border border-current/20 text-xs" onClick={download} data-testid="export-csv">
                  Export CSV
                </button>
              </div>
              <table className="w-full text-sm" data-testid="per-customer">
                <thead>
                  <tr className="text-left text-xs opacity-60">
                    <th className="font-normal">Customer</th>
                    <th className="text-right font-normal">Seats</th>
                    <th className="text-right font-normal">MRR now</th>
                    <th className="text-right font-normal">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((c, i) => (
                    <tr key={`${c.name}-${i}`} className="border-t border-current/10">
                      <td className="py-0.5">{c.name}</td>
                      <td className="text-right font-mono">{c.seats}</td>
                      <td className="text-right font-mono">{usd(c.mrr_before)}</td>
                      <td className={`text-right font-mono ${c.mrr_delta > 0 ? "text-red-700 dark:text-red-400" : ""}`}>{signed(c.mrr_delta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="text-xs opacity-60">Existing customers move at their next renewal, without proration (rule R9). Annual prices count as ÷12 MRR per customer.</p>
      </section>
    </div>
  );
}
