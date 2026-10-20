import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { migrate } from "./billing";
import { migrationBase } from "./stripe-parity";
import { parseMigration } from "./validate";

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
