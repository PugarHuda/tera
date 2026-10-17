"use client";

import { useState } from "react";
import { formatMoney, migrate } from "@/lib/billing";

const toMinor = (s: string) => Math.round(Number(s) * 100);

export function Planner() {
  const [oldPrice, setOldPrice] = useState("29.00");
  const [newPrice, setNewPrice] = useState("39.00");
  const [grandfather, setGrandfather] = useState(false);
  const [seats, setSeats] = useState("1, 1, 3");

  const customers = seats.split(/[\s,]+/).filter(Boolean).map(Number);
  const error =
    !(toMinor(oldPrice) > 0) || !(toMinor(newPrice) > 0)
      ? "Prices must be positive amounts."
      : customers.some((q) => !Number.isInteger(q) || q < 1)
        ? "Seat counts must be positive whole numbers."
        : null;
  const report = error ? null : migrate({ unit_amount: toMinor(oldPrice), new_unit_amount: toMinor(newPrice), grandfather, customers });
  const usd = (x: number) => formatMoney(x, "usd");

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <form className="card space-y-4" onSubmit={(e) => e.preventDefault()}>
        <label className="block text-sm">
          Current monthly price (USD)
          <input className="input mt-1 w-full" inputMode="decimal" value={oldPrice} onChange={(e) => setOldPrice(e.target.value)} />
        </label>
        <label className="block text-sm">
          New monthly price (USD)
          <input className="input mt-1 w-full" inputMode="decimal" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={grandfather} onChange={(e) => setGrandfather(e.target.checked)} />
          Grandfather existing customers (keep them on the current price)
        </label>
        <label className="block text-sm">
          Customer base: seats per customer, comma separated
          <textarea className="input mt-1 w-full" rows={3} value={seats} onChange={(e) => setSeats(e.target.value)} />
        </label>
      </form>

      <section aria-label="Impact report" className="card">
        {error || !report ? (
          <p role="alert" className="text-red-600" data-testid="migrate-error">
            {error}
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-y-3">
            <dt className="opacity-70">Customers affected</dt>
            <dd className="text-right font-mono" data-testid="affected">{report.affected}</dd>
            <dt className="opacity-70">MRR before</dt>
            <dd className="text-right font-mono" data-testid="mrr-before">{usd(report.mrr_before)}</dd>
            <dt className="opacity-70">MRR after</dt>
            <dd className="text-right font-mono" data-testid="mrr-after">{usd(report.mrr_after)}</dd>
            <dt className="opacity-70">MRR change</dt>
            <dd className="text-right font-mono font-semibold" data-testid="mrr-delta">
              {report.mrr_delta >= 0 ? "+" : ""}
              {usd(report.mrr_delta)}
            </dd>
          </dl>
        )}
        <p className="mt-4 text-xs opacity-60">Existing customers move at their next renewal, without proration (rule R9).</p>
      </section>
    </div>
  );
}
