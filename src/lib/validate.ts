// Input validation for the public API (trust boundary). Throws BadRequest with a human message.
import golden from "../../golden/scenarios.json";
import type { Catalog, TimelineEvent } from "./billing";

export class BadRequest extends Error {}

export const defaultCatalog = golden.catalog as unknown as Catalog;

export const EVENT_TYPES = [
  "subscribe",
  "start_trial",
  "change_price",
  "change_quantity",
  "apply_coupon",
  "report_usage",
  "cancel_at_period_end",
  "advance_to",
] as const;

const MAX_EVENTS = 100;
const MAX_SPAN_MS = 10 * 366 * 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z)?$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, min = 0, max = 1e12): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;

function fail(msg: string): never {
  throw new BadRequest(msg);
}

export function parseCatalog(x: unknown): Catalog {
  if (x === undefined) return defaultCatalog;
  if (!isObj(x) || !isObj(x.prices)) fail("catalog.prices must be an object");
  for (const [id, p] of Object.entries(x.prices)) {
    const at = `catalog.prices.${id}`;
    if (!isObj(p)) fail(`${at} must be an object`);
    if (typeof p.currency !== "string" || !/^[a-z]{3}$/i.test(p.currency)) fail(`${at}.currency must be a 3-letter ISO code`);
    if (p.interval !== "month" && p.interval !== "year") fail(`${at}.interval must be "month" or "year"`);
    if (p.usage_type === "metered") {
      if (!Array.isArray(p.tiers) || p.tiers.length === 0) fail(`${at}.tiers required for metered prices`);
      let prev = 0;
      p.tiers.forEach((t: unknown, i: number) => {
        if (!isObj(t) || typeof t.unit_amount_decimal !== "string" || !(Number(t.unit_amount_decimal) >= 0))
          fail(`${at}.tiers[${i}].unit_amount_decimal must be a non-negative decimal string`);
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
      if (pct && !(typeof c.percent_off === "number" && c.percent_off > 0 && c.percent_off <= 100)) fail(`${at}.percent_off must be in (0, 100]`);
      if (!pct && !isInt(c.amount_off, 1)) fail(`${at}.amount_off must be a positive integer`);
      if (!["once", "repeating", "forever"].includes(c.duration as string)) fail(`${at}.duration must be once, repeating or forever`);
      if (c.duration === "repeating" && !isInt(c.duration_in_months, 1, 120)) fail(`${at}.duration_in_months must be 1-120`);
    }
  }
  if (x.tax_rates !== undefined) {
    if (!isObj(x.tax_rates)) fail("catalog.tax_rates must be an object");
    for (const [id, r] of Object.entries(x.tax_rates)) {
      const at = `catalog.tax_rates.${id}`;
      if (!isObj(r) || !(typeof r.percentage === "number" && r.percentage >= 0 && r.percentage < 100)) fail(`${at}.percentage must be in [0, 100)`);
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
    if (typeof e.at !== "string" || !ISO.test(e.at) || Number.isNaN(Date.parse(e.at))) fail(`${at}.at must be an ISO-8601 UTC date`);
    if (!EVENT_TYPES.includes(e.type as (typeof EVENT_TYPES)[number])) fail(`${at}.type must be one of ${EVENT_TYPES.join(", ")}`);
    if (e.quantity !== undefined && !isInt(e.quantity, 0, 1e9)) fail(`${at}.quantity must be a non-negative integer`);
    if (e.trial_days !== undefined && !isInt(e.trial_days, 1, 730)) fail(`${at}.trial_days must be 1-730`);
    if (e.type === "change_quantity" && !isInt(e.quantity, 1, 1e9)) fail(`${at}.quantity must be a positive integer`);
    if (["subscribe", "start_trial", "change_price"].includes(e.type as string) && typeof e.price !== "string") fail(`${at}.price is required`);
    if (e.type === "apply_coupon" && typeof e.coupon !== "string") fail(`${at}.coupon is required`);
    return Date.parse(e.at);
  });
  if (Math.max(...times) - Math.min(...times) > MAX_SPAN_MS) fail("timeline may span at most 10 years");
  const first = (x as TimelineEvent[]).reduce((a, e, i) => (times[i] < times[a] ? i : a), 0);
  if (!["subscribe", "start_trial"].includes((x as TimelineEvent[])[first].type)) fail("the first event must be subscribe or start_trial");
  return x as TimelineEvent[];
}

export function parseMigration(x: unknown) {
  if (!isObj(x)) fail("body must be an object");
  if (!isInt(x.unit_amount, 1)) fail("unit_amount must be a positive integer");
  if (!isInt(x.new_unit_amount, 1)) fail("new_unit_amount must be a positive integer");
  if (typeof x.grandfather !== "boolean") fail("grandfather must be a boolean");
  if (!Array.isArray(x.customers) || x.customers.length > 100_000 || !x.customers.every((q) => isInt(q, 1, 1e6)))
    fail("customers must be an array of positive seat counts (max 100000)");
  return x as { unit_amount: number; new_unit_amount: number; grandfather: boolean; customers: number[] };
}

export function badRequest(e: unknown) {
  if (e instanceof BadRequest || e instanceof SyntaxError) return Response.json({ error: e.message }, { status: 400 });
  // Engine domain errors (unknown price/coupon, event before subscribe) are the caller's fault too.
  if (e instanceof Error && e.constructor === Error) return Response.json({ error: e.message }, { status: 422 });
  throw e;
}
