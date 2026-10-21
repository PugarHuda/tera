import { describe, expect, it } from "vitest";
import { minorOf } from "./money";
import { encodeJson } from "./share";
import { BadRequest, STRIPE_CURRENCIES, badRequest, findScenarios, methodNotAllowed, parseCatalog, parseCurrency, parseLocale, parseMigration, parseTimeline, readJson } from "./validate";

// Each case here pins a rule that Stryker (stryker.config.json) showed could be deleted with every other test still
// green: the boundaries of the trust boundary, one value either side.
const price = { currency: "usd", unit_amount: 100, interval: "month" };
const cat = (extra: object) => () => parseCatalog({ prices: { p: price }, ...extra });
const sub = { at: "2027-01-01T00:00:00Z", type: "subscribe", price: "p" };
const tl = (...events: object[]) => () => parseTimeline([sub, ...events]);
const mig = (extra: object) => () => parseMigration({ unit_amount: 100, new_unit_amount: 200, grandfather: false, customers: [1], ...extra });
const status = (e: unknown) => badRequest(e).status;

describe("catalog", () => {
  it("needs an object with an object of prices", () => {
    for (const x of [[], "x", { prices: [] }, { prices: null }]) expect(() => parseCatalog(x)).toThrow("catalog.prices must be an object");
    expect(() => parseCatalog({ prices: { p: 5 } })).toThrow("catalog.prices.p must be an object");
  });
  it("takes exactly 50 prices", () => {
    const prices = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, price]));
    expect(() => parseCatalog({ prices: prices(50) })).not.toThrow();
    expect(() => parseCatalog({ prices: prices(51) })).toThrow("limited to 50");
  });
  it("accepts licensed and metered usage types", () => {
    expect(() => parseCatalog({ prices: { p: { ...price, usage_type: "licensed" } } })).not.toThrow();
  });
  it("checks metered tiers one by one", () => {
    const m = (tiers: unknown) => () => parseCatalog({ prices: { m: { currency: "usd", interval: "month", usage_type: "metered", tiers } } });
    const last = { up_to: null, unit_amount_decimal: "1" };
    expect(m([])).toThrow("tiers required");
    expect(m(undefined)).toThrow("tiers required");
    expect(m([5, last])).toThrow("tiers[0].unit_amount_decimal");
    expect(m([{ up_to: 5, unit_amount_decimal: 1 }, last])).toThrow("tiers[0].unit_amount_decimal");
    expect(m([{ up_to: 5, unit_amount_decimal: "1e3" }, last])).toThrow("tiers[0].unit_amount_decimal");
    expect(m([{ up_to: 5, unit_amount_decimal: "1" }, { up_to: 5, unit_amount_decimal: "1" }, last])).toThrow("must ascend");
    expect(m([{ up_to: 5, unit_amount_decimal: "0.5" }, { up_to: 6, unit_amount_decimal: "1" }, last])).not.toThrow();
  });
  it("checks each coupon", () => {
    expect(cat({ coupons: [] })).toThrow("catalog.coupons must be an object");
    expect(cat({ coupons: { C: 1 } })).toThrow("catalog.coupons.C must be an object");
    expect(cat({ coupons: { C: { percent_off: 0, duration: "once" } } })).toThrow("percent_off must be in (0, 100]");
    expect(cat({ coupons: { C: { percent_off: "10", duration: "once" } } })).toThrow("percent_off must be in (0, 100]");
    expect(cat({ coupons: { C: { percent_off: 100.01, duration: "once" } } })).toThrow("percent_off must be in (0, 100]");
    expect(cat({ coupons: { C: { percent_off: 100, duration: "once" } } })).not.toThrow();
    expect(cat({ coupons: { C: { percent_off: 0.01, duration: "once" } } })).not.toThrow();
    expect(cat({ coupons: { C: { amount_off: 0, currency: "usd", duration: "once" } } })).toThrow("amount_off must be a positive integer");
    expect(cat({ coupons: { C: { percent_off: 10, duration: "weekly" } } })).toThrow("duration must be once, repeating or forever");
    const c = parseCatalog({ prices: { p: price }, coupons: { C: { amount_off: 500, currency: "USD", duration: "once" } } });
    expect(c.coupons!.C.currency).toBe("usd");
  });
  it("checks each tax rate", () => {
    expect(cat({ tax_rates: [] })).toThrow("catalog.tax_rates must be an object");
    expect(cat({ tax_rates: { t: 5 } })).toThrow("percentage must be in [0, 100)");
    expect(cat({ tax_rates: { t: { percentage: -1, behavior: "exclusive" } } })).toThrow("percentage must be in [0, 100)");
    expect(cat({ tax_rates: { t: { percentage: 100, behavior: "exclusive" } } })).toThrow("percentage must be in [0, 100)");
    expect(cat({ tax_rates: { t: { percentage: "8", behavior: "exclusive" } } })).toThrow("percentage must be in [0, 100)");
    expect(cat({ tax_rates: { t: { percentage: 0, behavior: "exclusive" } } })).not.toThrow();
    expect(cat({ tax_rates: { t: { percentage: 8, behavior: "both" } } })).toThrow("behavior must be inclusive or exclusive");
  });
  it("names retired and unsupported currencies, and lists only the ones Stripe takes", () => {
    expect(() => parseCatalog({ prices: { p: { ...price, currency: "bgn" } } })).toThrow("bgn was retired for eur");
    expect(() => parseCatalog({ prices: { p: { ...price, currency: "CUP" } } })).toThrow("cup is not a currency Stripe supports");
    expect(() => parseCatalog({ prices: { p: { ...price, currency: "zzz" } } })).toThrow("must be an ISO 4217 currency code");
    expect(STRIPE_CURRENCIES).toContain("usd");
    expect(STRIPE_CURRENCIES).toContain("jpy");
    expect(STRIPE_CURRENCIES).not.toContain("bgn");
    expect(STRIPE_CURRENCIES).not.toContain("cup");
  });
});

describe("timeline", () => {
  it("needs objects, with the fields each event type requires", () => {
    expect(() => parseTimeline([sub, 5])).toThrow("timeline[1] must be an object");
    expect(tl({ at: "2027-01-02", type: "change_price" })).toThrow("timeline[1].price is required");
    expect(tl({ at: "2027-01-02", type: "apply_coupon" })).toThrow("timeline[1].coupon is required");
    expect(tl({ at: "2027-01-02", type: "cancel_at" })).toThrow("cancel_at must be an ISO-8601 UTC date");
    expect(tl({ at: "2027-01-02", type: "advance_to", cancel_at: "soon" })).toThrow("cancel_at must be an ISO-8601 UTC date");
    expect(tl({ at: "2027-01-02", type: "adjust_balance", amount: 0 })).toThrow("amount must be a non-zero whole number");
    expect(tl({ at: "2027-01-02", type: "adjust_balance", amount: -500 })).not.toThrow();
  });
  it("bounds quantity at 0 and 1,000,000,000", () => {
    expect(tl({ at: "2027-01-02", type: "report_usage", quantity: -1 })).toThrow("quantity must be a whole number from 0");
    expect(tl({ at: "2027-01-02", type: "report_usage", quantity: 1e9 + 1 })).toThrow("quantity must be a whole number from 0");
    expect(tl({ at: "2027-01-02", type: "report_usage", quantity: 0 })).not.toThrow();
  });
  it("takes now/unchanged only on resume, and a date on any other anchor", () => {
    expect(tl({ at: "2027-01-02", type: "resume", billing_cycle_anchor: "unchanged" })).not.toThrow();
    expect(tl({ at: "2027-01-02", type: "resume", billing_cycle_anchor: "later" })).toThrow('on resume must be "now" or "unchanged"');
    expect(() => parseTimeline([{ ...sub, billing_cycle_anchor: "now" }])).toThrow("billing_cycle_anchor must be an ISO-8601 UTC date");
  });
  it("takes 1970 through 2099", () => {
    expect(() => parseTimeline([{ ...sub, at: "1970-01-01T00:00:00Z" }])).not.toThrow();
    expect(() => parseTimeline([{ ...sub, at: "2099-12-31T23:59:59Z" }])).not.toThrow();
    expect(() => parseTimeline([{ ...sub, at: "2100-01-01" }])).toThrow("from 1970 to 2099");
    expect(() => parseTimeline([{ ...sub, at: 20270101 }])).toThrow("from 1970 to 2099");
  });
  it("finds an out-of-order event anywhere, not only second", () => {
    expect(tl({ at: "2027-03-01", type: "advance_to" }, { at: "2027-02-01", type: "advance_to" })).toThrow("timeline[2].at is before timeline[1].at");
  });
});

describe("migration", () => {
  it("checks each field", () => {
    expect(() => parseMigration([])).toThrow("body must be an object");
    expect(mig({ unit_amount: 0 })).toThrow("unit_amount must be a positive integer");
    expect(mig({ new_unit_amount: 1.5 })).toThrow("new_unit_amount must be a positive integer");
    expect(mig({ grandfather: "no" })).toThrow("grandfather must be a boolean");
    expect(mig({ interval: "week" })).toThrow('interval must be "month" or "year"');
    expect(mig({ interval: "year" })).not.toThrow();
    expect(mig({ customers: "1,2" })).toThrow("customers must be an array");
  });
  it("takes 100,000 customers and no more", () => {
    expect(mig({ customers: Array(100_000).fill(1) })).not.toThrow();
    expect(mig({ customers: Array(100_001).fill(1) })).toThrow("max 100000");
  });
  it("checks every customer, named or not", () => {
    expect(mig({ customers: [1, 0] })).toThrow("customers[1] needs a positive whole number of seats");
    expect(mig({ customers: [1, 1e6 + 1] })).toThrow("customers[1] needs a positive whole number of seats");
    expect(mig({ customers: [{ name: "A", seats: 1 }, { name: "B" }] })).toThrow("customers[1] needs a positive whole number of seats");
    expect(mig({ customers: [{ name: "   ", seats: 1 }] })).toThrow("customers[0].name must be a non-empty string");
    expect(mig({ customers: [{ name: 7, seats: 1 }] })).toThrow("customers[0].name must be a non-empty string");
    expect(mig({ customers: [{ name: "x".repeat(201), seats: 1 }] })).toThrow("customers[0].name must be a non-empty string");
    expect(mig({ customers: [{ name: "x".repeat(200), seats: 1 }] })).not.toThrow();
  });
  it("caps the larger price × total seats at exactly 1e15", () => {
    expect(mig({ unit_amount: 1e9, new_unit_amount: 1e9, customers: [1e6] })).not.toThrow(); // = 1e15
    expect(mig({ unit_amount: 1, new_unit_amount: 1e10, customers: [1e6] })).toThrow("at most 1e15"); // the new price counts
  });
});

describe("request plumbing", () => {
  it("refuses bodies over 4 MB, by header or by length", async () => {
    const big = new Request("http://x", { method: "POST", body: "{}", headers: { "content-length": "4000001" } });
    await expect(readJson(big)).rejects.toThrow("limited to 4 MB");
    await expect(readJson(new Request("http://x", { method: "POST", body: " ".repeat(4_000_001) }))).rejects.toThrow("limited to 4 MB");
    expect(await readJson(new Request("http://x", { method: "POST", body: '{"a":1}' }))).toEqual({ a: 1 });
  });
  it("maps errors to 413, 422, 400 and rethrows its own bugs", async () => {
    const tooLarge = await readJson(new Request("http://x", { method: "POST", body: " ".repeat(4_000_001) })).catch((e) => e);
    expect(status(tooLarge)).toBe(413);
    expect(status(new BadRequest("x"))).toBe(400);
    expect(status(new SyntaxError("x"))).toBe(400);
    expect(status(new Error("Unknown price: x"))).toBe(422);
    expect(await badRequest(new BadRequest("bad")).json()).toEqual({ error: "bad" });
    expect(() => badRequest(new TypeError("a bug"))).toThrow("a bug");
  });
  it("answers 405 with a message and the methods served", async () => {
    const r = methodNotAllowed("POST")();
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST, OPTIONS");
    expect(await r.json()).toEqual({ error: "Method not allowed; use POST" });
  });
  it("normalises currencies and checks locales", () => {
    expect(parseCurrency("USD")).toBe("usd");
    expect(() => parseCurrency("zzz")).toThrow(BadRequest);
    expect(() => parseLocale("en-US-x")).toThrow(BadRequest);
  });
  it("finds scenarios by a padded rule and by words separated by any spaces", () => {
    expect(findScenarios(" r6 ").length).toBe(findScenarios("R6").length);
    expect(findScenarios(null, "  coupon   trial ").map((s) => s.id)).toEqual(findScenarios(null, "coupon trial").map((s) => s.id));
    expect(findScenarios(null, "  coupon   trial ").length).toBeGreaterThan(0);
  });
});

describe("money and share links", () => {
  it("parses typed amounts strictly, in any case of currency code", () => {
    expect(minorOf(" 29 ", "usd", "p")).toBe(2900);
    expect(minorOf("5.5", "ISK", "p")).toMatch(/cannot have decimals/);
    expect(minorOf("1e3", "usd", "p")).toMatch(/not a valid USD amount/);
    expect(minorOf("Infinity", "usd", "p")).toMatch(/not a valid USD amount/);
    expect(minorOf("29.999", "usd", "p")).toMatch(/not a valid USD amount/);
    expect(minorOf("29.99", "usd", "p")).toBe(2999);
  });
  it("encodes payloads larger than one 32 KiB chunk", () => {
    const value = { s: "é".repeat(40_000) };
    const back = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encodeJson(value).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    expect(back).toEqual(value);
  });
});
