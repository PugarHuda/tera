import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { migrate } from "./billing";
import { catalogFromStripe, migrationBase } from "./stripe-parity";
import { parseCatalog, parseMigration } from "./validate";

const price = { id: "price_seat", unit_amount: 1200, currency: "usd", recurring: { interval: "month" } } as Stripe.Price;
const sub = (status: string, customer: unknown, quantity: number | null, priceId = "price_seat") =>
  ({ status, customer, items: { data: [{ price: { id: priceId }, quantity }] } }) as unknown as Stripe.Subscription;

describe("migrationBase (FR3 import from Stripe)", () => {
  it("keeps live subscriptions, names customers, and counts what it leaves out", () => {
    const base = migrationBase(price, [
      sub("active", { id: "cus_1", name: "Acme Inc", email: "a@acme.test" }, 12),
      sub("trialing", { id: "cus_2", name: null, email: "ops@globex.test" }, 3),
      sub("past_due", { id: "cus_3", name: "", email: null }, 1),
      sub("paused", "cus_4", 2),
      sub("active", { id: "cus_5", deleted: true }, 4),
      sub("canceled", { id: "cus_6", name: "Gone" }, 9),
      sub("incomplete", { id: "cus_7", name: "Never paid" }, 9),
      sub("active", { id: "cus_8", name: "No seats" }, 0),
      sub("active", { id: "cus_9", name: "Other price" }, 5, "price_other"),
    ]);
    expect(base).toEqual({
      price: "price_seat",
      unit_amount: 1200,
      currency: "usd",
      interval: "month",
      customers: [
        { name: "Acme Inc", seats: 12 },
        { name: "ops@globex.test", seats: 3 },
        { name: "cus_3", seats: 1 },
        { name: "cus_4", seats: 2 },
        { name: "cus_5", seats: 4 },
      ],
      skipped: 4,
    });
    // Feeds the planner as is: 22 seats x $12 -> $15.
    const r = migrate(parseMigration({ unit_amount: base.unit_amount, new_unit_amount: 1500, grandfather: false, interval: base.interval, customers: base.customers }));
    expect([r.mrr_before, r.mrr_after, r.affected]).toEqual([26400, 33000, 5]);
  });
});

const sp = (lookup_key: string | null, product: string, unit_amount: number, interval = "month", extra: object = {}) =>
  ({ id: `price_${product}`, lookup_key, product: { name: product }, unit_amount, currency: "usd", billing_scheme: "per_unit", recurring: { interval, interval_count: 1, usage_type: "licensed" }, ...extra }) as unknown as Stripe.Price;

describe("catalogFromStripe (FR5 import)", () => {
  it("gives pushed objects their Tera id back, names the rest, and skips what Tera does not model", () => {
    const { catalog, skipped } = catalogFromStripe(
      [
        sp("tera_team_seat_m_0123456789", "Tera team_seat_m", 1500),
        sp("tera_team_seat_m_abcdefabcd", "Tera team_seat_m", 1200), // an older push of the same id
        sp(null, "Pro plan", 29900, "year"),
        sp(null, "Pro plan", 2900),
        sp(null, "Pro plan", 3900), // same name, another price: kept as its own id
        sp(null, "Every 3 months", 5000, "month", { recurring: { interval: "month", interval_count: 3, usage_type: "licensed" } }),
        sp(null, "API calls", 0, "month", { billing_scheme: "tiered", unit_amount: null }),
      ],
      [
        { id: "TERA_LAUNCH20_0123456789", name: "LAUNCH20", valid: true, duration: "repeating", duration_in_months: 3, percent_off: 20 },
        { id: "Z4OV52SU", name: "Ten off", valid: true, duration: "once", percent_off: null, amount_off: 1000, currency: "usd" },
        { id: "LAUNCH20", name: "LAUNCH20", valid: true, duration: "repeating", duration_in_months: 3, percent_off: 20 }, // an exact copy
        { id: "LAUNCH20B", name: "LAUNCH20", valid: true, duration: "once", percent_off: 20 }, // same name, other terms
        { id: "expired", name: null, valid: false, duration: "once", percent_off: 50 },
      ] as unknown as Stripe.Coupon[],
      [
        { display_name: "VAT", percentage: 20, inclusive: true, active: true },
        { display_name: "tera_us_sales", percentage: 8.25, inclusive: false, active: true }, // an older push without the hash
        { display_name: "tera_us_sales_0123456789", percentage: 8.25, inclusive: false, active: true },
      ] as unknown as Stripe.TaxRate[],
    );
    expect(catalog).toEqual({
      prices: {
        team_seat_m: { currency: "usd", unit_amount: 1500, interval: "month" },
        Pro_plan_y: { currency: "usd", unit_amount: 29900, interval: "year" },
        Pro_plan_m: { currency: "usd", unit_amount: 2900, interval: "month" },
        Pro_plan_m_2: { currency: "usd", unit_amount: 3900, interval: "month" },
      },
      coupons: {
        LAUNCH20: { duration: "repeating", duration_in_months: 3, percent_off: 20 },
        LAUNCH20_2: { duration: "once", percent_off: 20 },
        Ten_off: { duration: "once", amount_off: 1000, currency: "usd" },
      },
      tax_rates: { VAT_20: { percentage: 20, behavior: "inclusive" }, us_sales: { percentage: 8.25, behavior: "exclusive" } },
    });
    expect(skipped).toEqual({ prices: 3, coupons: 2, tax_rates: 1 });
    expect(() => parseCatalog(catalog)).not.toThrow();
  });
});
