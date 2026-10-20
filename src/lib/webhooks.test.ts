import { describe, expect, it } from "vitest";
import golden from "../../golden/scenarios.json";
import evidence from "../../golden/parity/index.json";
import { simulate, type Catalog, type TimelineEvent } from "./billing";
import { diffWebhooks } from "./stripe-parity";

// The webhook events Stripe sent for each golden timeline, recorded per step by scripts/verify-golden.mts from a real test
// clock. Tera's predicted events must match them type for type and count for count.
const catalog = golden.catalog as unknown as Catalog;
const recorded = (evidence as { id: string; webhooks?: string[][] }[]).filter((r) => r.webhooks);

describe("webhook events match Stripe's recorded ones", () => {
  it("has recordings for the golden timelines", () => expect(recorded.length).toBeGreaterThan(100));
  for (const r of recorded) {
    const s = golden.scenarios.find((x) => x.id === r.id) as { title: string; timeline: TimelineEvent[] };
    it(`${r.id} ${s.title}`, () => expect(diffWebhooks(simulate(catalog, s.timeline).webhooks, r.webhooks!)).toEqual([]));
  }
});

describe("webhook timing", () => {
  const sub = { at: "2027-01-01T00:00:00Z", type: "subscribe" as const, price: "pro_m" };
  it("dates trial_will_end three days before the trial ends", () => {
    const { webhooks } = simulate(catalog, [{ ...sub, type: "start_trial", trial_days: 14 }, { at: "2027-02-01T00:00:00Z", type: "advance_to" }]);
    expect(webhooks.find((w) => w.type === "customer.subscription.trial_will_end")).toEqual({ event: 1, date: "2027-01-12", type: "customer.subscription.trial_will_end", status: "trialing" });
  });
  it("sends trial_will_end for a trial of three days or less once the clock moves, not with the call (Stripe probe)", () => {
    const short = simulate(catalog, [{ ...sub, type: "start_trial", trial_days: 2 }, { at: "2027-01-10T00:00:00Z", type: "advance_to" }]).webhooks;
    expect(short.filter((w) => w.type === "customer.subscription.trial_will_end").map((w) => w.event)).toEqual([1]);
  });
  it("sends nothing for the renewal draft the timeline ends on (Stripe has not finalized it yet)", () => {
    const { webhooks } = simulate(catalog, [sub, { at: "2027-02-01T00:00:00Z", type: "advance_to" }]);
    expect(webhooks.filter((w) => w.event === 1).map((w) => w.type)).toEqual(["invoice.created", "customer.subscription.updated"]);
  });
  it("names the invoice each invoice event is about, in the order invoices are listed", () => {
    const { webhooks } = simulate(catalog, [sub, { at: "2027-03-01T00:00:00Z", type: "advance_to" }]);
    expect(webhooks.filter((w) => w.type.startsWith("invoice.")).map((w) => `${w.type} ${w.invoice}`)).toEqual([
      "invoice.created 1", "invoice.finalized 1", "invoice.paid 1", "invoice.created 2", "invoice.finalized 2", "invoice.paid 2", "invoice.created 3",
    ]);
  });
});
