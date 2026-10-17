"use client";

import { useState } from "react";
import { formatMoney, type Invoice } from "@/lib/billing";

type StripeInvoice = { id: string; date: string; currency: string; lines: { description: string; amount: number; proration: boolean }[]; total: number };
type Evidence = { verified_at: string; match: boolean; test_clock: string; stripe: StripeInvoice[] } | null;
type Live = { match: boolean; diffs: { invoice: number; field: string }[]; stripe: StripeInvoice[]; test_clock: string; ran_at: string };

export function ParityRow({ id, title, tera, record }: { id: string; title: string; tera: Invoice[]; record: Evidence }) {
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stripe = live?.stripe ?? record?.stripe ?? null;
  const match = live ? live.match : record?.match;

  const rerun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/parity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: id }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setLive(body);
      setOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="card" data-testid={`parity-${id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`badge ${match ? "badge-ok" : match === false ? "badge-bad" : ""}`} data-testid={`parity-${id}-badge`}>
          {match ? "✅ Match" : match === false ? "❌ Diff" : "— Not replayable"}
        </span>
        <button type="button" className="mr-auto text-left font-medium" onClick={() => setOpen(!open)} aria-expanded={open}>
          {id} · {title}
        </button>
        {record && <span className="text-xs opacity-60">verified {record.verified_at.slice(0, 10)}</span>}
        {record && (
          <button type="button" className="btn-ghost border border-current/20 text-xs" onClick={rerun} disabled={busy} data-testid={`parity-${id}-rerun`}>
            {busy ? "Replaying in Stripe…" : "Re-run live in Stripe"}
          </button>
        )}
      </div>
      {!record && <p className="mt-2 text-xs opacity-60">Metered usage needs Stripe meter events, which are not replayed against test clocks yet.</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {live && (
        <p className="mt-2 text-xs opacity-70" data-testid={`parity-${id}-live`}>
          Live replay at {live.ran_at.slice(11, 19)} UTC on test clock <code>{live.test_clock}</code>: {live.match ? "identical" : `${live.diffs.length} difference(s)`}
        </p>
      )}
      {open && stripe && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs opacity-60">
              <th className="font-normal">Invoice</th>
              <th className="font-normal">Tera lines</th>
              <th className="font-normal">Stripe lines</th>
              <th className="text-right font-normal">Tera total</th>
              <th className="text-right font-normal">Stripe total</th>
            </tr>
          </thead>
          <tbody>
            {tera.map((t, i) => {
              const s = stripe[i];
              const m = (x: number) => formatMoney(x, t.currency);
              return (
                <tr key={i} className="border-t border-current/10 align-top">
                  <td className="py-1">{t.date}</td>
                  <td className="font-mono text-xs">{t.lines.map((l) => m(l.amount)).join(" ")}</td>
                  <td className="font-mono text-xs">{s ? s.lines.map((l) => m(l.amount)).join(" ") : "—"}</td>
                  <td className="text-right font-mono">{m(t.total)}</td>
                  <td className={`text-right font-mono ${s && s.total !== t.total ? "text-red-600" : ""}`}>{s ? m(s.total) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </li>
  );
}
