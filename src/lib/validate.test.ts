import { describe, expect, it } from "vitest";
import { migrate } from "./billing";
import { csvBlob, toCsv } from "./csv";
import { decodeTimeline, encodeTimeline } from "./share";
import { BadRequest, defaultCatalog, parseCatalog, parseMigration, parseTimeline } from "./validate";

const sub = { at: "2027-01-01T00:00:00Z", type: "subscribe", price: "pro_m" };
const price = { currency: "usd", unit_amount: 100, interval: "month" };

describe("parseCatalog", () => {
  it("defaults to the golden catalog", () => expect(parseCatalog(undefined)).toBe(defaultCatalog));
  it.each([
    [{ prices: { p: price }, coupons: { OFF: { amount_off: 500, duration: "once" } } }, "currency must be a 3-letter ISO code for amount_off"],
    [{ prices: { p: price }, coupons: { OFF: { percent_off: 10, amount_off: 5, duration: "once" } } }, "exactly one of percent_off or amount_off"],
    [{ prices: { p: price }, coupons: { OFF: { percent_off: 101, duration: "once" } } }, "percent_off must be in (0, 100]"],
    [{ prices: { p: price }, coupons: { OFF: { percent_off: 10, duration: "repeating" } } }, "duration_in_months must be 1-120"],
    [{ prices: { p: price }, tax_rates: { vat: { percentage: 100, behavior: "exclusive" } } }, "percentage must be in [0, 100)"],
    [{ prices: { p: { ...price, interval: "week" } } }, 'interval must be "month" or "year"'],
    [{ prices: { m: { currency: "usd", interval: "month", usage_type: "metered", tiers: [{ up_to: 10, unit_amount_decimal: "1" }] } } }, "end with up_to: null"],
    [{ prices: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}`, price])) }, "limited to 50"],
  ])("rejects %j", (catalog, message) => expect(() => parseCatalog(catalog)).toThrow(message));
  it("accepts an amount_off coupon with its currency", () =>
    expect(() => parseCatalog({ prices: { p: price }, coupons: { OFF: { amount_off: 500, currency: "usd", duration: "once" } } })).not.toThrow());
});

describe("parseTimeline", () => {
  it.each([
    [[], "non-empty array"],
    [[{ ...sub, at: "0202-01-01" }], "1970 or later"],
    [[{ ...sub, type: "teleport" }], "type must be one of"],
    [[{ at: sub.at, type: "change_price", price: "pro_m" }], "first event must be subscribe or start_trial"],
    [[sub, { at: "2027-02-01T00:00:00Z", type: "change_quantity", quantity: 0 }], "positive integer"],
    [[sub, { at: "2038-01-02T00:00:00Z", type: "advance_to" }], "at most 10 years"],
    [[{ ...sub, trial_days: 731 }], "trial_days must be 1-730"],
    [[{ ...sub, billing_mode: "elastic" }], "billing_mode must be one of"],
    [Array.from({ length: 101 }, () => sub), "limited to 100 events"],
  ])("rejects %j", (timeline, message) => expect(() => parseTimeline(timeline)).toThrow(message));
  it("throws BadRequest, which the API maps to 400", () => expect(() => parseTimeline("x")).toThrow(BadRequest));
});

describe("migrate (R9)", () => {
  it("counts annual prices as amount / 12 per customer, rounded half up", () => {
    const r = migrate(parseMigration({ unit_amount: 29900, new_unit_amount: 35900, grandfather: false, interval: "year", customers: [1, { name: "Acme", seats: 3 }] }));
    expect(r.per_customer.map((c) => [c.name, c.mrr_before, c.mrr_after])).toEqual([
      ["customer 1", 2492, 2992],
      ["Acme", 7475, 8975],
    ]);
    expect(r).toMatchObject({ affected: 2, mrr_before: 9967, mrr_after: 11967, mrr_delta: 2000 });
  });
  it("grandfathering leaves every existing customer unchanged", () => {
    const r = migrate(parseMigration({ unit_amount: 2900, new_unit_amount: 3900, grandfather: true, customers: [1, 5] }));
    expect(r).toMatchObject({ affected: 0, mrr_delta: 0 });
  });
  it("rejects a total that would lose cents in a double", () =>
    expect(() => parseMigration({ unit_amount: 1e9, new_unit_amount: 1e9, grandfather: false, customers: [1e6, 1e6] })).toThrow("at most 1e15"));
});

describe("share links and CSV at the limits", () => {
  it("encodes a 100-event timeline without overflowing the call stack", () => {
    const long = [sub, ...Array.from({ length: 99 }, (_, i) => ({ at: `2027-01-${String((i % 28) + 2).padStart(2, "0")}T00:00:00Z`, type: "change_quantity", quantity: i + 1, coupon: "x".repeat(40) }))];
    expect(decodeTimeline(encodeTimeline(long as never))).toEqual(long);
  });
  it("quotes a carriage return so a row cannot split in Excel", () => expect(toCsv([{ name: "a\rb" }])).toBe('name\n"a\rb"\n'));
  it("starts the download with a UTF-8 byte order mark", async () => {
    const bytes = new Uint8Array(await csvBlob("name\nZoë\n").arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
