// Input validation for the public API (trust boundary). Throws BadRequest with a human message.
import golden from "../../golden/scenarios.json";
import { BILLING_MODES, PRORATION_BEHAVIORS, TRIAL_END_BEHAVIORS, type Catalog, type TimelineEvent, type migrate } from "./billing";

export class BadRequest extends Error {}
class TooLarge extends BadRequest {}

// A timeline of 100 events or a 100,000-customer migration is well under 4 MB; anything bigger is refused before parsing.
const MAX_BODY = 4_000_000;
export async function readJson(req: Request): ReturnType<Request["json"]> {
  if (Number(req.headers.get("content-length")) > MAX_BODY) throw new TooLarge("request body is limited to 4 MB");
  const body = await req.text();
  if (body.length > MAX_BODY) throw new TooLarge("request body is limited to 4 MB");
  return JSON.parse(body);
}

export const defaultCatalog = golden.catalog as unknown as Catalog;

/** Golden scenarios citing a rule (such as R6) and with every word of q in the title; both optional. */
export function findScenarios(rule?: string | null, q?: string | null) {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return golden.scenarios.filter(
    (s) => (!rule || s.rules.some((r) => r.toLowerCase() === rule.trim().toLowerCase())) && words.every((w) => s.title.toLowerCase().includes(w)),
  );
}

export const EVENT_TYPES = [
  "subscribe",
  "start_trial",
  "change_price",
  "change_quantity",
  "apply_coupon",
  "report_usage",
  "cancel_at_period_end",
  "resume",
  "end_trial",
  "cancel_now",
  "reset_anchor",
  "remove_coupon",
  "cancel_at",
  "pause",
  "adjust_balance",
  "advance_to",
] as const;

const MAX_EVENTS = 100;
const ID = /^[A-Za-z0-9_]{1,40}$/;
const MAX_SPAN_MS = 10 * 366 * 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z)?$/;
// 1970-2099: a half-typed year (0002, 0202) is not a date a subscription can have, and year 9999 renders as
// "+010000-01" once a period crosses into year 10000.
// Date.parse rolls 2027-02-30 over to 03-02; a date that does not exist on the calendar is rejected instead.
const isDate = (v: unknown): v is string =>
  typeof v === "string" && ISO.test(v) && Date.parse(v) >= 0 && Date.parse(v) < Date.UTC(2100, 0, 1) && new Date(v).toISOString().slice(0, 10) === v.slice(0, 10);
// ISO 4217 codes this runtime knows (Stripe rejects made-up ones such as "zzz"), minus the ones no Stripe account can
// use (probed in test mode, 2026-10). BHD, KWD, GHS and the like stay: Stripe takes them once the account has a bank
// account in that currency, and a push without one returns Stripe's own message.
const RETIRED = new Set(["bgn", "hrk"]);
const NOT_ON_STRIPE = new Set([...RETIRED, "cuc", "cup", "ern", "iqd", "irr", "kpw", "lyd", "mru", "sdg", "ssp", "stn", "syp", "tmt", "ves", "xdr", "xsu", "zwg", "zwl"]);
const CURRENCIES = new Set(Intl.supportedValuesOf("currency").map((c) => c.toLowerCase()));
const isCurrency = (v: unknown): v is string => typeof v === "string" && CURRENCIES.has(v.toLowerCase()) && !NOT_ON_STRIPE.has(v.toLowerCase());
const currencyError = (at: string, v: unknown) =>
  typeof v === "string" && RETIRED.has(v.toLowerCase())
    ? `${at} ${v.toLowerCase()} was retired for eur; Stripe no longer accepts it`
    : typeof v === "string" && NOT_ON_STRIPE.has(v.toLowerCase())
      ? `${at} ${v.toLowerCase()} is not a currency Stripe supports`
      : `${at} must be an ISO 4217 currency code such as usd`;
// Stripe's decimal limits: percent_off takes two decimals, a tax rate's percentage four.
const places = (n: number, max: number) => Number(n.toFixed(max)) === n;
// Stripe's unit_amount_decimal: a plain decimal with at most 12 places (no "Infinity", "1e400" or "0x10").
const DECIMAL = /^\d{1,15}(\.\d{1,12})?$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, min = 0, max = 1e12): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;

function fail(msg: string): never {
  throw new BadRequest(msg);
}

export function parseCatalog(x: unknown): Catalog {
  if (x === undefined) return defaultCatalog;
  if (!isObj(x) || !isObj(x.prices)) fail("catalog.prices must be an object");
  const limits: Array<[string, unknown, number]> = [["prices", x.prices, 50], ["coupons", x.coupons ?? {}, 50], ["tax_rates", x.tax_rates ?? {}, 20]];
  for (const [name, obj, max] of limits) {
    const keys = Object.keys(obj as object);
    if (keys.length > max) fail(`catalog.${name} is limited to ${max} entries`);
    const bad = keys.find((k) => !ID.test(k) || k === "__proto__");
    if (bad !== undefined) fail(`catalog.${name} id "${bad}" must be 1-40 letters, digits or underscores`);
  }
  if (Object.keys(x.prices).length === 0) fail("catalog.prices needs at least one price");
  for (const [id, p] of Object.entries(x.prices)) {
    const at = `catalog.prices.${id}`;
    if (!isObj(p)) fail(`${at} must be an object`);
    if (!isCurrency(p.currency)) fail(currencyError(`${at}.currency`, p.currency));
    p.currency = p.currency.toLowerCase(); // Stripe's form: "USD" and "usd" are one currency
    if (p.interval !== "month" && p.interval !== "year") fail(`${at}.interval must be "month" or "year"`);
    if (p.usage_type === "metered") {
      if (!Array.isArray(p.tiers) || p.tiers.length === 0) fail(`${at}.tiers required for metered prices`);
      let prev = 0;
      p.tiers.forEach((t: unknown, i: number) => {
        if (!isObj(t) || typeof t.unit_amount_decimal !== "string" || !DECIMAL.test(t.unit_amount_decimal))
          fail(`${at}.tiers[${i}].unit_amount_decimal must be a non-negative decimal string with at most 12 decimals`);
        const last = i === (p.tiers as unknown[]).length - 1;
        if (last ? t.up_to !== null : !isInt(t.up_to, prev + 1)) fail(`${at}.tiers must ascend and end with up_to: null`);
        prev = t.up_to as number;
      });
    } else if (!isInt(p.unit_amount, 1)) fail(`${at}.unit_amount must be a positive integer in minor units`);
  }
  if (x.coupons !== undefined) {
    if (!isObj(x.coupons)) fail("catalog.coupons must be an object");
    for (const [code, c] of Object.entries(x.coupons)) {
      const at = `catalog.coupons.${code}`;
      if (!isObj(c)) fail(`${at} must be an object`);
      const pct = c.percent_off !== undefined;
      if (pct === (c.amount_off !== undefined)) fail(`${at} needs exactly one of percent_off or amount_off`);
      if (pct && !(typeof c.percent_off === "number" && c.percent_off > 0 && c.percent_off <= 100 && places(c.percent_off, 2)))
        fail(`${at}.percent_off must be in (0, 100] with at most two decimals`);
      if (!pct && !isInt(c.amount_off, 1)) fail(`${at}.amount_off must be a positive integer`);
      // Stripe rejects an amount_off coupon without a currency: catch it here, not as a 502 on push.
      if (!pct && !isCurrency(c.currency)) fail(c.currency === undefined ? `${at}.currency is required for amount_off` : currencyError(`${at}.currency`, c.currency));
      if (!pct) c.currency = (c.currency as string).toLowerCase();
      if (!["once", "repeating", "forever"].includes(c.duration as string)) fail(`${at}.duration must be once, repeating or forever`);
      if (c.duration === "repeating" && !isInt(c.duration_in_months, 1, 120)) fail(`${at}.duration_in_months must be 1-120`);
    }
  }
  if (x.tax_rates !== undefined) {
    if (!isObj(x.tax_rates)) fail("catalog.tax_rates must be an object");
    for (const [id, r] of Object.entries(x.tax_rates)) {
      const at = `catalog.tax_rates.${id}`;
      if (!isObj(r) || !(typeof r.percentage === "number" && r.percentage >= 0 && r.percentage < 100 && places(r.percentage, 4)))
        fail(`${at}.percentage must be in [0, 100) with at most four decimals`);
      if (r.behavior !== "inclusive" && r.behavior !== "exclusive") fail(`${at}.behavior must be inclusive or exclusive`);
    }
  }
  return x as unknown as Catalog;
}

export function parseTimeline(x: unknown): TimelineEvent[] {
  if (!Array.isArray(x) || x.length === 0) fail("timeline must be a non-empty array");
  if (x.length > MAX_EVENTS) fail(`timeline is limited to ${MAX_EVENTS} events`);
  const times = x.map((e, i) => {
    const at = `timeline[${i}]`;
    if (!isObj(e)) fail(`${at} must be an object`);
    if (!isDate(e.at)) fail(`${at}.at must be an ISO-8601 UTC date from 1970 to 2099`);
    if (!EVENT_TYPES.includes(e.type as (typeof EVENT_TYPES)[number])) fail(`${at}.type must be one of ${EVENT_TYPES.join(", ")}`);
    if (e.quantity !== undefined && !isInt(e.quantity, 0, 1e9)) fail(`${at}.quantity must be a whole number from 0 to 1,000,000,000`);
    if (e.trial_days !== undefined && !isInt(e.trial_days, 1, 730)) fail(`${at}.trial_days must be 1-730`);
    if (e.type === "change_quantity" && !isInt(e.quantity, 1, 1e9)) fail(`${at}.quantity must be a whole number from 1 to 1,000,000,000`);
    if (["subscribe", "start_trial", "change_price"].includes(e.type as string) && typeof e.price !== "string") fail(`${at}.price is required`);
    if (e.type === "apply_coupon" && typeof e.coupon !== "string") fail(`${at}.coupon is required`);
    if (e.type === "resume") {
      if (e.billing_cycle_anchor !== undefined && e.billing_cycle_anchor !== "now" && e.billing_cycle_anchor !== "unchanged")
        fail(`${at}.billing_cycle_anchor on resume must be "now" or "unchanged"`);
    } else if (e.billing_cycle_anchor !== undefined && !isDate(e.billing_cycle_anchor)) fail(`${at}.billing_cycle_anchor must be an ISO-8601 UTC date`);
    if ((e.cancel_at !== undefined || e.type === "cancel_at") && !isDate(e.cancel_at)) fail(`${at}.cancel_at must be an ISO-8601 UTC date`);
    if (e.proration_behavior !== undefined && !PRORATION_BEHAVIORS.includes(e.proration_behavior as never))
      fail(`${at}.proration_behavior must be one of ${PRORATION_BEHAVIORS.join(", ")}`);
    if (e.billing_mode !== undefined && !BILLING_MODES.includes(e.billing_mode as never)) fail(`${at}.billing_mode must be one of ${BILLING_MODES.join(", ")}`);
    if (e.type === "adjust_balance" && !(isInt(Math.abs(e.amount as number), 1, 1e10) && Number.isInteger(e.amount)))
      fail(`${at}.amount must be a non-zero whole number of minor units (negative = credit), at most 10,000,000,000`);
    if (e.trial_end_behavior !== undefined) {
      if (e.type !== "start_trial") fail(`${at}.trial_end_behavior is only for start_trial`);
      if (!TRIAL_END_BEHAVIORS.includes(e.trial_end_behavior as never)) fail(`${at}.trial_end_behavior must be one of ${TRIAL_END_BEHAVIORS.join(", ")}`);
    }
    return Date.parse(e.at);
  });
  if (Math.max(...times) - Math.min(...times) > MAX_SPAN_MS) fail("timeline may span at most 10 years");
  // Same rule as the simulator page: events in date order, not silently re-sorted. An event before the subscribe is a
  // domain error from the engine (422, FR7).
  for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) fail(`timeline[${i}].at is before timeline[${i - 1}].at: keep events in chronological order`);
  return x as TimelineEvent[];
}

export function parseMigration(x: unknown) {
  if (!isObj(x)) fail("body must be an object");
  if (!isInt(x.unit_amount, 1)) fail("unit_amount must be a positive integer");
  if (!isInt(x.new_unit_amount, 1)) fail("new_unit_amount must be a positive integer");
  if (typeof x.grandfather !== "boolean") fail("grandfather must be a boolean");
  if (x.interval !== undefined && x.interval !== "month" && x.interval !== "year") fail('interval must be "month" or "year"');
  if (!Array.isArray(x.customers) || x.customers.length > 100_000) fail("customers must be an array (max 100000)");
  if (x.customers.length === 0) fail("customers needs at least one customer");
  x.customers.forEach((c: unknown, i: number) => {
    const seats = isObj(c) ? c.seats : c;
    if (!isInt(seats, 1, 1e6)) fail(`customers[${i}] needs a positive whole number of seats`);
    if (isObj(c) && (typeof c.name !== "string" || !c.name.trim() || c.name.length > 200)) fail(`customers[${i}].name must be a non-empty string`);
  });
  // MRR sums must stay exact integers in a double (2^53 ≈ 9e15).
  const seats = (x.customers as unknown[]).reduce((a: number, c) => a + ((isObj(c) ? c.seats : c) as number), 0);
  if (seats * Math.max(x.unit_amount as number, x.new_unit_amount as number) > 1e15) fail("unit_amount × total seats must be at most 1e15 minor units");
  return x as unknown as Parameters<typeof migrate>[0];
}

/** A BCP 47 locale for money formatting; "en_US" or "" would make Intl throw a RangeError (a 500). */
export function parseCurrency(x: unknown): string {
  if (!isCurrency(x)) fail(currencyError("currency", x));
  return x.toLowerCase();
}

export function parseLocale(x: unknown): string {
  if (x === undefined) return "en-US";
  try {
    if (typeof x === "string" && x) {
      new Intl.NumberFormat(x);
      return x;
    }
  } catch {}
  fail('locale must be a BCP 47 language tag such as "en-US" or "de-DE"');
}

export const methodNotAllowed = (allow: string) => () => Response.json({ error: `Method not allowed; use ${allow}` }, { status: 405, headers: { allow } });

export function badRequest(e: unknown) {
  if (e instanceof TooLarge) return Response.json({ error: e.message }, { status: 413 });
  if (e instanceof BadRequest || e instanceof SyntaxError) return Response.json({ error: e.message }, { status: 400 });
  // Engine domain errors (unknown price/coupon, event before subscribe) are the caller's fault too.
  if (e instanceof Error && e.constructor === Error) return Response.json({ error: e.message }, { status: 422 });
  throw e;
}
