import { describe, expect, it } from "vitest";
import { migrate, simulate } from "./billing";
import { csvBlob, parseCustomers, toCsv } from "./csv";
import { decodeTimeline, encodeTimeline } from "./share";
import { BadRequest, defaultCatalog, findScenarios, parseCatalog, parseLocale, parseMigration, parseTimeline } from "./validate";

const sub = { at: "2027-01-01T00:00:00Z", type: "subscribe", price: "pro_m" };
const price = { currency: "usd", unit_amount: 100, interval: "month" };

describe("parseCatalog", () => {
  it("defaults to the golden catalog", () => expect(parseCatalog(undefined)).toBe(defaultCatalog));
  it.each([
    [{ prices: { p: price }, coupons: { OFF: { amount_off: 500, duration: "once" } } }, "currency is required for amount_off"],
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
    [[{ ...sub, at: "0202-01-01" }], "from 1970 to 2099"],
    [[{ ...sub, at: "9999-12-01T00:00:00Z" }], "from 1970 to 2099"],
    [[{ ...sub, type: "teleport" }], "type must be one of"],
    [[sub, { at: "2026-12-01T00:00:00Z", type: "change_price", price: "pro_m" }], "chronological order"],
    [[{ ...sub, type: "subscribe", trial_end_behavior: "cancel" }], "only for start_trial"],
    [[{ ...sub, type: "start_trial", trial_days: 7, trial_end_behavior: "charge" }], "trial_end_behavior must be one of"],
    [[sub, { at: "2027-02-01T00:00:00Z", type: "change_quantity", quantity: 0 }], "whole number from 1"],
    [[sub, { at: "2038-01-02T00:00:00Z", type: "advance_to" }], "at most 10 years"],
    [[{ ...sub, trial_days: 731 }], "trial_days must be 1-730"],
    [[{ ...sub, billing_mode: "elastic" }], "billing_mode must be one of"],
    [Array.from({ length: 101 }, () => sub), "limited to 100 events"],
  ])("rejects %j", (timeline, message) => expect(() => parseTimeline(timeline)).toThrow(message));
  it("throws BadRequest, which the API maps to 400", () => expect(() => parseTimeline("x")).toThrow(BadRequest));
});

describe("findScenarios", () => {
  it("filters by rule and title words, case-insensitively", () => {
    expect(findScenarios().length).toBeGreaterThan(100);
    const r22 = findScenarios("r22");
    expect(r22.length).toBeGreaterThan(0);
    expect(r22.every((s) => s.rules.includes("R22"))).toBe(true);
    expect(findScenarios("R2").some((s) => s.rules.includes("R22") && !s.rules.includes("R2"))).toBe(false); // exact rule, not a prefix
    expect(findScenarios(null, "Flat MONTHLY").map((s) => s.id)).toContain("S01");
    expect(findScenarios("R6", "nothing-like-this")).toEqual([]);
  });
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
    const long = [sub, ...Array.from({ length: 99 }, (_, i) => ({ at: new Date(Date.UTC(2027, 0, 2 + i)).toISOString().replace(".000", ""), type: "change_quantity", quantity: i + 1, coupon: "x".repeat(40) }))];
    expect(decodeTimeline(encodeTimeline(long as never))).toEqual(long);
  });
  it("quotes a carriage return so a row cannot split in Excel", () => expect(toCsv([{ name: "a\rb" }])).toBe('name\n"a\rb"\n'));
  it("starts the download with a UTF-8 byte order mark", async () => {
    const bytes = new Uint8Array(await csvBlob("name\nZoë\n").arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("R21 pause: what Stripe rejects, Tera rejects", () => {
  const flex = { ...sub, billing_mode: "flexible" };
  const run = (timeline: object[]) => () => simulate(defaultCatalog, parseTimeline(timeline));
  it.each([
    [[sub, { at: "2027-01-10T00:00:00Z", type: "pause" }], "flexible billing mode"],
    [[{ ...flex, type: "start_trial", trial_days: 14 }, { at: "2027-01-05T00:00:00Z", type: "pause" }], "during a trial"],
    [[flex, { at: "2027-01-10T00:00:00Z", type: "pause" }, { at: "2027-01-11T00:00:00Z", type: "change_quantity", quantity: 2 }], "while paused"],
    // S115 models an unchanged resume on a billing date; on a shortened month-end one (01-31 -> 02-28) it is not probed.
    [[{ ...flex, at: "2027-01-31T00:00:00Z" }, { at: "2027-02-10T00:00:00Z", type: "pause" }, { at: "2027-02-28T00:00:00Z", type: "resume", billing_cycle_anchor: "unchanged" }], "exactly on a shortened billing date"],
  ])("rejects %j", (timeline, message) => expect(run(timeline)).toThrow(message));
  it("rejects a date as a resume anchor", () =>
    expect(() => parseTimeline([flex, { at: "2027-01-10T00:00:00Z", type: "resume", billing_cycle_anchor: "2027-02-01" }])).toThrow('"now" or "unchanged"'));
  it("a paused subscription renews nothing and reports paused", () => {
    const r = simulate(defaultCatalog, parseTimeline([flex, { at: "2027-01-10T00:00:00Z", type: "pause" }, { at: "2027-06-01T00:00:00Z", type: "advance_to" }]));
    expect(r.status).toBe("paused");
    expect(r.invoices.map((i) => i.date)).toEqual(["2027-01-01"]);
  });
});

describe("found by Playwright QA", () => {
  it.each(["2027-02-30T00:00:00Z", "2027-02-29", "2027-13-01"])("rejects the impossible date %s instead of rolling it over", (at) =>
    expect(() => parseTimeline([{ ...sub, at }])).toThrow("ISO-8601"));
  it("accepts Feb 29 in a leap year", () => expect(() => parseTimeline([{ ...sub, at: "2028-02-29" }])).not.toThrow());
  it.each(["Infinity", "1e400", "0x10", "", " ", "-1"])("rejects the tier unit_amount_decimal %j", (d) =>
    expect(() =>
      parseCatalog({ prices: { m: { currency: "usd", interval: "month", usage_type: "metered", tiers: [{ up_to: null, unit_amount_decimal: d }] } } }),
    ).toThrow("decimal string"));
  it("rejects a made-up currency", () => expect(() => parseCatalog({ prices: { p: { ...price, currency: "zzz" } } })).toThrow("ISO 4217"));
  // Probed in Stripe test mode: no account can price in these; BHD needs a bank account but is a real Stripe currency.
  it("rejects currencies Stripe does not support", () => {
    expect(() => parseCatalog({ prices: { p: { ...price, currency: "bgn" } } })).toThrow("retired for eur");
    expect(() => parseCatalog({ prices: { p: { ...price, currency: "IRR" } } })).toThrow("irr is not a currency Stripe supports");
    expect(() => parseCatalog({ prices: { p: price }, coupons: { O: { amount_off: 5, currency: "ves", duration: "once" } } })).toThrow("not a currency Stripe");
    expect(() => parseCatalog({ prices: { p: { ...price, currency: "bhd" } } })).not.toThrow();
  });
  it("keeps Stripe's decimal limits on percentages", () => {
    const c = (coupons: object, tax_rates: object = {}) => () => parseCatalog({ prices: { p: price }, coupons, tax_rates });
    expect(c({ O: { percent_off: 33.33, duration: "once" } })).not.toThrow();
    expect(c({ O: { percent_off: 33.333, duration: "once" } })).toThrow("at most two decimals");
    expect(c({}, { t: { percentage: 8.8755, behavior: "exclusive" } })).not.toThrow();
    expect(c({}, { t: { percentage: 8.87555, behavior: "exclusive" } })).toThrow("at most four decimals");
  });
  it("rejects __proto__ as an id", () => expect(() => parseCatalog(JSON.parse('{"prices":{"__proto__":{"currency":"usd","unit_amount":1,"interval":"month"}}}'))).toThrow());
  it.each(["x", "", "en_US", 7])("rejects the locale %j with a 400, not a RangeError", (l) => expect(() => parseLocale(l)).toThrow(BadRequest));
  it("keeps a valid locale", () => expect(parseLocale("de-DE")).toBe("de-DE"));
  it("rejects a migration with no customers", () => expect(() => parseMigration({ unit_amount: 1, new_unit_amount: 2, grandfather: false, customers: [] })).toThrow("at least one"));
  it("reads a bare seat list with a negative as a bad list, not a CSV row", () =>
    expect(parseCustomers("1, 2, -3").errors).toEqual(['Item 3: "-3" is not a positive whole number of seats']));
});
