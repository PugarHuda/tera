import { describe, expect, it } from "vitest";
import golden from "../../golden/scenarios.json";
import { formatMoney, migrate, simulate, type Catalog, type TimelineEvent } from "./billing";

type Expected = {
  date: string;
  period_end?: string;
  lines?: number[];
  discount?: number;
  tax?: number;
  total: number;
  starting_balance?: number;
  amount_due?: number;
  display_en?: string;
  display_de?: string;
};

const catalog = golden.catalog as unknown as Catalog;
const nbsp = (s: string) => s.replace(/ /g, " ");

describe("golden scenarios", () => {
  for (const s of golden.scenarios as Array<Record<string, unknown>>) {
    it(`${s.id} ${s.title}`, () => {
      if (s.migration) {
        const m = s.migration as { price: string; new_unit_amount: number; grandfather: boolean; customers: number[] };
        const unit_amount = catalog.prices[m.price].unit_amount!;
        expect(migrate({ ...m, unit_amount })).toEqual(s.expect_report);
        return;
      }
      const result = simulate(catalog, s.timeline as TimelineEvent[]);
      const expected = s.expect as Expected[];
      expect(result.invoices.map((i) => i.date)).toEqual(expected.map((e) => e.date));
      result.invoices.forEach((inv, i) => {
        const e = expected[i];
        if (e.lines) expect(inv.lines.map((l) => l.amount)).toEqual(e.lines);
        if (e.period_end) expect(inv.period_end).toBe(e.period_end);
        if (e.discount !== undefined) expect(inv.discount).toBe(e.discount);
        if (e.tax !== undefined) expect(inv.tax).toBe(e.tax);
        expect(inv.total).toBe(e.total);
        if (e.starting_balance !== undefined) expect(inv.starting_balance).toBe(e.starting_balance);
        if (e.amount_due !== undefined) expect(inv.amount_due).toBe(e.amount_due);
        if (e.display_en) expect(formatMoney(inv.total, inv.currency, "en-US")).toBe(e.display_en);
        if (e.display_de) expect(nbsp(formatMoney(inv.total, inv.currency, "de-DE"))).toBe(e.display_de);
      });
      if (s.expect_status) expect(result.status).toBe("canceled");
    });
  }
});

describe("invariants", () => {
  const timelines = (golden.scenarios as Array<{ timeline?: TimelineEvent[] }>).filter((s) => s.timeline);

  it("I1 totals add up and are integers", () => {
    for (const s of timelines) {
      for (const inv of simulate(catalog, s.timeline!).invoices) {
        const lines = inv.lines.reduce((a, l) => a + l.amount, 0);
        expect(inv.subtotal).toBe(lines);
        const exclusiveTax = inv.total - (inv.subtotal - inv.discount);
        expect([0, inv.tax]).toContain(exclusiveTax);
        for (const n of [inv.subtotal, inv.discount, inv.tax, inv.total]) expect(Number.isInteger(n)).toBe(true);
      }
    }
  });

  it("I2 a credit never exceeds what was paid for the period", () => {
    for (const s of timelines) {
      const paid: number[] = [];
      for (const inv of simulate(catalog, s.timeline!).invoices) {
        const credit = -inv.lines.filter((l) => l.amount < 0).reduce((a, l) => a + l.amount, 0);
        expect(credit).toBeLessThanOrEqual(Math.max(0, ...paid));
        paid.push(inv.lines.filter((l) => l.amount > 0).reduce((a, l) => a + l.amount, 0));
      }
    }
  });

  it("I6 periods are contiguous and amount_due is never negative", () => {
    for (const s of timelines) {
      const invoices = simulate(catalog, s.timeline!).invoices;
      for (const inv of invoices) {
        expect(inv.amount_due).toBeGreaterThanOrEqual(0);
        expect(inv.period_start < inv.period_end).toBe(true);
      }
    }
  });

  it("I5 deterministic", () => {
    for (const s of timelines) expect(simulate(catalog, s.timeline!)).toEqual(simulate(catalog, s.timeline!));
  });
});

describe("rejects timelines Stripe would reject", () => {
  const sub = (price = "starter_m", extra: Partial<TimelineEvent> = {}): TimelineEvent => ({ at: "2027-01-01T00:00:00Z", type: "subscribe", price, ...extra });
  const cases: Array<[string, TimelineEvent[], RegExp]> = [
    ["amount_off coupon in another currency", [sub("starter_m_eur", { coupon: "TENOFF3" })], /currency/i],
    ["switching currency mid-subscription", [sub(), { at: "2027-01-17T00:00:00Z", type: "change_price", price: "basic_m_jpy" }], /currency/i],
    ["a second subscribe while active", [sub(), { at: "2027-01-10T00:00:00Z", type: "subscribe", price: "pro_m" }], /already/i],
    ["usage on a licensed price", [sub(), { at: "2027-01-10T00:00:00Z", type: "report_usage", quantity: 10 }], /metered/i],
    [
      "changes after the subscription ended",
      [sub(), { at: "2027-01-10T00:00:00Z", type: "cancel_at_period_end" }, { at: "2027-03-01T00:00:00Z", type: "change_price", price: "pro_m" }],
      /canceled/i,
    ],
  ];
  for (const [name, timeline, msg] of cases) it(name, () => expect(() => simulate(catalog, timeline)).toThrow(msg));
});
