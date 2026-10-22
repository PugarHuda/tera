// OpenAPI 3.1 for the public API. Served at /api/openapi.json and as an MCP resource (tera://openapi.json).
import golden from "../../golden/scenarios.json";
import evidence from "../../golden/parity/index.json";
import { DATE_PATTERN, DECIMAL, EVENT_TYPES, ID, LOCALE, STRIPE_CURRENCIES } from "./validate";
import { BILLING_MODES, PRORATION_BEHAVIORS, TRIAL_END_BEHAVIORS } from "./billing";

// Counted from the recorded evidence so the description never goes stale.
const timelines = golden.scenarios.filter((s) => "timeline" in s).length;
const verified = evidence.filter((e) => e.match).length;

const error = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };

// The schemas below state what src/lib/validate.ts accepts, so a generated client or a schema fuzzer (Schemathesis in
// CI) sees the real contract: a request that breaks these schemas is a 400, and one they allow but that cannot be
// billed (events out of date order, a span over 10 years, tiers that do not ascend, 30 February, a price missing from
// the catalog, an action Stripe rejects) is a 422.
const date = { type: "string", pattern: DATE_PATTERN };
const count = { type: "integer", minimum: 0 };
const rules = { type: "array", items: { type: "string", pattern: "^R\\d+$" } };
const currency = { type: "string", enum: [...STRIPE_CURRENCIES, ...STRIPE_CURRENCIES.map((c) => c.toUpperCase())], description: "ISO 4217, any case; Stripe's form is lowercase" };
const ids = { propertyNames: { pattern: ID.source, not: { const: "__proto__" } } };
const when = (type: string | string[], then: object) => ({ if: { properties: { type: Array.isArray(type) ? { enum: type } : { const: type } }, required: ["type"] }, then });

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "Tera API",
    version: "0.1.0",
    description:
      `Stripe-parity pricing simulator. All amounts are integers in the currency's minor unit (USD cents; JPY yen). Rules R1-R23 in docs/PRD.md (billing_mode classic or flexible). ${verified}/${timelines} golden timeline scenarios verified against Stripe test mode (see /parity).`,
  },
  // Relative: the API is served by the deployment that serves this spec (production or a preview). Public, no auth.
  servers: [{ url: "/" }],
  security: [],
  paths: {
    "/api/simulate": {
      post: {
        operationId: "simulate",
        summary: "Run a customer timeline and return every invoice",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SimulateRequest" },
              example: {
                timeline: [
                  { at: "2027-01-01T00:00:00Z", type: "subscribe", price: "starter_m" },
                  { at: "2027-01-17T00:00:00Z", type: "change_price", price: "pro_m" },
                  { at: "2027-02-01T00:00:00Z", type: "advance_to" },
                ],
              },
            },
          },
        },
        responses: {
          "200": { description: "Invoices", content: { "application/json": { schema: { $ref: "#/components/schemas/SimulationResult" } } } },
          "400": { description: "The body breaks the request schema", content: { "application/json": { schema: error } } },
          "422": {
            description: "Schema-valid but not billable: events out of date order, a day not on the calendar, an unknown price/coupon/tax rate, an event before subscribe, an action Stripe rejects",
            content: { "application/json": { schema: error } },
          },
        },
      },
    },
    "/api/migrate": {
      post: {
        operationId: "previewMigration",
        summary: "Preview the MRR impact of a price change",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["unit_amount", "new_unit_amount", "grandfather", "customers"],
                properties: {
                  unit_amount: { type: "integer", minimum: 1, maximum: 1e12 },
                  new_unit_amount: { type: "integer", minimum: 1, maximum: 1e12 },
                  grandfather: { type: "boolean" },
                  interval: { type: "string", enum: ["month", "year"], default: "month", description: "Annual prices count as amount/12 MRR per customer" },
                  customers: {
                    type: "array",
                    minItems: 1,
                    maxItems: 100000,
                    description: "unit_amount × total seats is at most 1e15 minor units (400 otherwise)",
                    items: {
                      oneOf: [
                        { type: "integer", minimum: 1, maximum: 1000000, description: "Seat count" },
                        {
                          type: "object",
                          required: ["name", "seats"],
                          properties: { name: { type: "string", maxLength: 200, pattern: "\\S" }, seats: { type: "integer", minimum: 1, maximum: 1000000 } },
                        },
                      ],
                    },
                  },
                },
              },
              example: { unit_amount: 2900, new_unit_amount: 3900, grandfather: false, customers: [1, 1, 3] },
            },
          },
        },
        responses: {
          "200": {
            description: "Impact report",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    affected: { type: "integer" },
                    mrr_before: { type: "integer" },
                    mrr_after: { type: "integer" },
                    mrr_delta: { type: "integer" },
                    per_customer: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          seats: { type: "integer" },
                          mrr_before: { type: "integer" },
                          mrr_after: { type: "integer" },
                          mrr_delta: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "The body breaks the request schema", content: { "application/json": { schema: error } } },
          "422": { description: "unit_amount × total seats over 1e15 minor units", content: { "application/json": { schema: error } } },
        },
      },
    },
    "/api/parity": {
      get: {
        operationId: "listParityEvidence",
        summary: "Recorded Stripe test-clock evidence for every golden scenario",
        responses: { "200": { description: "Evidence records", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ParityRecord" } } } } } },
      },
      post: {
        operationId: "replayParity",
        summary: "Replay a golden scenario, or your own timeline and catalog, live in a Stripe test clock and diff it against Tera",
        description: "Custom timelines are limited to 15 events spanning at most 2 years. Timelines Tera rejects (R11) are answered with 422 and never reach Stripe.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              examples: {
                golden: { value: { scenario: "S05" } },
                custom: { value: { timeline: [{ at: "2027-01-01T00:00:00Z", type: "subscribe", price: "pro_m" }, { at: "2027-01-16T00:00:00Z", type: "change_quantity", quantity: 3 }, { at: "2027-02-01T00:00:00Z", type: "advance_to" }] } },
              },
            },
          },
        },
        responses: {
          "200": { description: "match, diffs, tera and stripe invoices, webhooks ({ match, diffs, stripe: the events Stripe sent per timeline event, as `type #invoice` or `type status`; payloads: those events as Stripe sent them, plus step; /replay-webhooks.mjs posts them to an endpoint, signed }), test clock id" },
          "400": { description: "Unknown scenario, malformed timeline or over the live limits", content: { "application/json": { schema: error } } },
          "422": { description: "Tera (and Stripe) reject this timeline", content: { "application/json": { schema: error } } },
          "429": { description: "Another live replay holds the Stripe cooldown", headers: { "retry-after": { schema: { type: "integer" }, description: "Seconds to wait" } }, content: { "application/json": { schema: error } } },
          "502": { description: "Stripe call failed", content: { "application/json": { schema: error } } },
        },
      },
    },
    "/api/stripe/push": {
      post: {
        operationId: "pushCatalogToStripe",
        summary: "Create or reuse a catalog's prices, coupons and tax rates in Stripe test mode",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["catalog"], properties: { catalog: { $ref: "#/components/schemas/Catalog" } } },
              example: { catalog: { prices: { pro_m: { currency: "usd", unit_amount: 7900, interval: "month" } } } },
            },
          },
        },
        responses: {
          "200": {
            description: "Stripe ids per catalog entry",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    prices: { type: "object", additionalProperties: { type: "string" } },
                    coupons: { type: "object", additionalProperties: { type: "string" } },
                    taxRates: { type: "object", additionalProperties: { type: "string" } },
                    meterId: { type: ["string", "null"], description: "Stripe Meter backing metered prices (event name tera_api_calls)" },
                  },
                },
              },
            },
          }, "400": { description: "Missing or invalid catalog", content: { "application/json": { schema: error } } }, "429": { description: "Cooldown", content: { "application/json": { schema: error } } }, "502": { description: "Stripe call failed, or no test-mode key is configured", content: { "application/json": { schema: error } } } },
      },
    },
    "/api/migrate/stripe": {
      get: {
        operationId: "importMigrationFromStripe",
        summary: "Import a migration's customer base from Stripe (test mode)",
        description:
          "Without `price`: the connected account's per-seat recurring prices. With `price`: that price's unit_amount, currency, interval and one customer per live subscription (item quantity as seats), ready for POST /api/migrate.",
        parameters: [{ name: "price", in: "query", schema: { type: "string", example: "price_1Abc" }, description: "A licensed, per-unit, monthly or yearly Stripe price id" }],
        responses: {
          "200": { description: "Prices, or { price, unit_amount, currency, interval, customers: [{ name, seats }], skipped }" },
          "400": { description: "Malformed id, or a price the planner does not model (metered, tiered, other intervals)", content: { "application/json": { schema: error } } },
          "404": { description: "No such price in the connected account", content: { "application/json": { schema: error } } },
          "502": { description: "Stripe API error", content: { "application/json": { schema: error } } },
          "503": { description: "No test-mode Stripe key configured", content: { "application/json": { schema: error } } },
        },
      },
    },
    "/api/stripe/catalog": {
      get: {
        operationId: "importCatalogFromStripe",
        summary: "Import the connected Stripe account's catalog (test mode)",
        description:
          "Active per-seat monthly and yearly prices, valid coupons and active tax rates as a Tera catalog, ready for POST /api/simulate. Objects Tera pushed get their Tera id back; others are named from the lookup key, product, coupon or tax rate name. `skipped` counts what Tera does not model (metered, tiered or other intervals) or what exceeds the catalog limits.",
        responses: {
          "200": {
            description: "The account's catalog, and how many objects of each kind were skipped",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["catalog", "skipped"],
                  properties: {
                    catalog: { $ref: "#/components/schemas/Catalog" },
                    skipped: { type: "object", required: ["prices", "coupons", "tax_rates"], properties: { prices: count, coupons: count, tax_rates: count } },
                  },
                },
              },
            },
          },
          "502": { description: "Stripe API error", content: { "application/json": { schema: error } } },
          "503": { description: "No test-mode Stripe key configured", content: { "application/json": { schema: error } } },
        },
      },
    },
    "/api/scenarios": {
      get: {
        operationId: "listScenarios",
        summary: "List golden scenarios",
        parameters: [
          { name: "rule", in: "query", schema: { type: "string", example: "R6" }, description: "Only scenarios citing this billing rule (R1-R23, see docs/PRD.md)" },
          { name: "q", in: "query", schema: { type: "string", example: "coupon trial" }, description: "Only scenarios whose title contains every word" },
        ],
        responses: { "200": { description: "Scenario summaries", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ScenarioSummary" } } } } } },
      },
    },
    "/api/scenarios/{id}": {
      get: {
        operationId: "getScenario",
        summary: "Get a golden scenario (timeline + hand-derived expected invoices + catalog)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", enum: golden.scenarios.flatMap((s) => [s.id, s.id.toLowerCase()]), example: "S05", description: "Any case" } }],
        responses: { "200": { description: "Scenario", content: { "application/json": { schema: { $ref: "#/components/schemas/Scenario" } } } }, "404": { description: "Not found", content: { "application/json": { schema: error } } } },
      },
    },
  },
  components: {
    schemas: {
      Catalog: {
        type: "object",
        description: "Defaults to the golden catalog (GET /api/scenarios/S01). Ids are 1-40 letters, digits or underscores.",
        required: ["prices"],
        properties: {
          prices: {
            type: "object",
            minProperties: 1,
            maxProperties: 50,
            ...ids,
            additionalProperties: {
              type: "object",
              required: ["currency", "interval"],
              properties: {
                currency,
                interval: { type: "string", enum: ["month", "year"] },
                unit_amount: { description: "Licensed prices: amount per seat in minor units" },
                usage_type: { type: "string", enum: ["licensed", "metered"] },
                tiers: { description: "Metered prices: graduated tiers, ascending, the last with up_to: null" },
              },
              if: { properties: { usage_type: { const: "metered" } }, required: ["usage_type"] },
              then: {
                required: ["tiers"],
                properties: {
                  tiers: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      required: ["up_to", "unit_amount_decimal"],
                      properties: { up_to: { type: ["integer", "null"], minimum: 1, maximum: 1e12 }, unit_amount_decimal: { type: "string", pattern: DECIMAL.source } },
                    },
                  },
                },
              },
              else: { required: ["unit_amount"], properties: { unit_amount: { type: "integer", minimum: 1, maximum: 1e12 } } },
            },
          },
          coupons: {
            type: "object",
            maxProperties: 50,
            ...ids,
            additionalProperties: {
              type: "object",
              required: ["duration"],
              properties: {
                percent_off: { type: "number", exclusiveMinimum: 0, maximum: 100, multipleOf: 0.01, description: "At most two decimals (Stripe's limit)." },
                amount_off: { type: "integer", minimum: 1, maximum: 1e12 },
                currency: { description: "Required with amount_off" },
                duration: { type: "string", enum: ["once", "repeating", "forever"] },
                duration_in_months: { description: "Required with duration repeating: 1-120" },
              },
              oneOf: [{ required: ["percent_off"] }, { required: ["amount_off"] }],
              allOf: [
                { if: { required: ["amount_off"] }, then: { required: ["currency"], properties: { currency } } },
                {
                  if: { properties: { duration: { const: "repeating" } }, required: ["duration"] },
                  then: { required: ["duration_in_months"], properties: { duration_in_months: { type: "integer", minimum: 1, maximum: 120 } } },
                },
              ],
            },
          },
          tax_rates: {
            type: "object",
            maxProperties: 20,
            ...ids,
            additionalProperties: {
              type: "object",
              required: ["percentage", "behavior"],
              properties: {
                percentage: { type: "number", minimum: 0, exclusiveMaximum: 100, multipleOf: 0.0001, description: "At most four decimals (Stripe's limit)." },
                behavior: { type: "string", enum: ["inclusive", "exclusive"] },
              },
            },
          },
        },
      },
      SimulateRequest: {
        type: "object",
        required: ["timeline"],
        properties: {
          catalog: { $ref: "#/components/schemas/Catalog" },
          locale: { type: "string", pattern: LOCALE.source, default: "en-US", description: "Language, optional script and region: en-US, de-DE, zh-Hant-TW" },
          timeline: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            description:
              "Events in date order, spanning at most 10 years. Only advance_to and adjust_balance may come before the subscribe (or start_trial). Prices, coupons and tax rates must exist in the catalog, and actions Stripe rejects or Tera does not model are answered 422.",
            items: { $ref: "#/components/schemas/TimelineEvent" },
          },
        },
      },
      TimelineEvent: {
          type: "object",
          required: ["at", "type"],
          properties: {
            at: { ...date, description: "ISO-8601 UTC day or time, 1970-2099" },
            type: { type: "string", enum: EVENT_TYPES },
            price: { type: "string" },
            quantity: { type: "integer", minimum: 0, maximum: 1000000000, description: "Seats, or usage units for report_usage. change_quantity needs at least 1." },
            coupon: { type: "string" },
            tax_rate: { type: "string" },
            trial_days: { type: "integer", minimum: 1, maximum: 730 },
            proration_behavior: { type: "string", enum: [...PRORATION_BEHAVIORS] },
            billing_cycle_anchor: {
              type: "string",
              description: "subscribe: ISO-8601 first billing date (Stripe billing_cycle_anchor), at most one period ahead (R20). resume of a paused subscription: \"now\" (default) or \"unchanged\" (R21).",
            },
            cancel_at: { ...date, description: "cancel_at events: when the subscription ends (Stripe cancel_at, R19)." },
            billing_mode: {
              type: "string",
              enum: [...BILLING_MODES],
              description: "subscribe/start_trial: Stripe billing mode (default classic). Flexible credits original debits and keeps the anchor (R16).",
            },
            amount: { type: "integer", description: "adjust_balance: customer balance transaction in minor units; negative = credit applied to the next invoice, positive = debit (R23)." },
            trial_end_behavior: {
              type: "string",
              enum: [...TRIAL_END_BEHAVIORS],
              description: "start_trial: the customer has no card, so the trial ends canceled or paused (Stripe trial_settings.end_behavior.missing_payment_method, R22).",
            },
          },
          allOf: [
            when(["subscribe", "start_trial", "change_price"], { required: ["price"] }),
            when("apply_coupon", { required: ["coupon"] }),
            when("change_quantity", { required: ["quantity"], properties: { quantity: { minimum: 1 } } }),
            when("cancel_at", { required: ["cancel_at"] }),
            when("adjust_balance", { required: ["amount"], properties: { amount: { minimum: -1e10, maximum: 1e10, not: { const: 0 } } } }),
            when("resume", { properties: { billing_cycle_anchor: { enum: ["now", "unchanged"] } } }),
            { if: { properties: { type: { const: "resume" } }, required: ["type"] }, else: { properties: { billing_cycle_anchor: date } } },
            { if: { properties: { type: { const: "start_trial" } }, required: ["type"] }, else: { not: { required: ["trial_end_behavior"] } } },
          ],
        },
      ScenarioSummary: {
        type: "object",
        required: ["id", "title", "status", "rules"],
        properties: { id: { type: "string", pattern: "^S\\d+$" }, title: { type: "string" }, status: { type: "string", enum: ["verified", "draft"] }, rules },
      },
      Scenario: {
        description: "A billing timeline with its hand-derived expected invoices, or a migration with its expected report",
        allOf: [
          { $ref: "#/components/schemas/ScenarioSummary" },
          {
            type: "object",
            required: ["catalog"],
            properties: { catalog: { $ref: "#/components/schemas/Catalog" }, timeline: { type: "array", items: { $ref: "#/components/schemas/TimelineEvent" } }, expect: {
                type: "array",
                description: "Hand-derived invoices: date, line amounts and total in minor units",
                items: { type: "object", required: ["date", "total"], properties: { date: { type: "string" }, lines: { type: "array", items: { type: "integer" } }, total: { type: "integer" } } },
              },
              migration: { type: "object", required: ["price", "new_unit_amount", "grandfather", "customers"] },
              expect_report: { type: "object", required: ["affected", "mrr_before", "mrr_after", "mrr_delta"], properties: { affected: count, mrr_before: count, mrr_after: count, mrr_delta: { type: "integer" } } },
            },
            oneOf: [{ required: ["timeline", "expect"] }, { required: ["migration", "expect_report"] }],
          },
        ],
      },
      ParityRecord: {
        type: "object",
        required: ["id", "title", "verified_at", "match", "diffs", "test_clock"],
        properties: {
          id: { type: "string", pattern: "^S\\d+$" },
          title: { type: "string" },
          verified_at: { type: "string", format: "date-time" },
          match: { type: "boolean" },
          diffs: { type: "array", items: { type: "string" } },
          test_clock: { type: "string", pattern: "^clock_" },
        },
      },
      SimulationResult: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "trialing", "paused", "canceled", "none"] },
          canceled_at: { type: ["string", "null"] },
          webhooks: {
            type: "array",
            description:
              "The webhook events Stripe sends for this timeline, verified against the events real test clocks sent for the golden scenarios. Types: customer.subscription.created/updated/deleted/paused/resumed/trial_will_end, invoice.created/finalized/paid, invoiceitem.created. Charges, payment intents, customer.updated and customer.discount.* are not modelled.",
            items: {
              type: "object",
              required: ["event", "date", "type"],
              properties: {
                event: { type: "integer", description: "Index of the timeline event whose step (the clock advance up to it, then the call) sends it" },
                date: { type: "string", description: "Simulated day it fires" },
                type: { type: "string" },
                invoice: { type: "integer", description: "invoice.* events: the invoice the payload is, 1-based in `invoices`" },
                status: { type: "string", enum: ["active", "trialing", "paused", "canceled"], description: "customer.subscription.* events: the subscription status in the payload" },
              },
            },
          },
          invoices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string" },
                currency: { type: "string" },
                period_start: { type: "string" },
                period_end: { type: "string" },
                lines: {
                  type: "array",
                  items: { type: "object", properties: { description: { type: "string" }, amount: { type: "integer" }, proration: { type: "boolean" } } },
                },
                subtotal: { type: "integer" },
                discount: { type: "integer" },
                tax: { type: "integer" },
                total: { type: "integer", description: "May be negative (a downgrade credit)" },
                starting_balance: { type: "integer", description: "Customer balance before this invoice; negative = credit (R10)" },
                amount_due: { type: "integer", minimum: 0, description: "total + starting_balance, never below zero" },
                total_display: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

// Redocly Respect (api-workflows/) checks responses with Ajv's defaultUnevaluatedProperties: false, which makes every
// subschema without its own setting strict, so a conditional branch would reject the properties its parent declares.
// Branches say true explicitly (a no-op for other validators); the objects that declare properties stay strict there.
const BRANCHES = ["if", "then", "else", "not"];
const LISTS = ["allOf", "oneOf", "anyOf"];
function openBranches(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  for (const k of BRANCHES) if (o[k] && typeof o[k] === "object") (o[k] as Record<string, unknown>).unevaluatedProperties ??= true;
  for (const k of LISTS) if (Array.isArray(o[k])) for (const s of o[k]) if (s && typeof s === "object" && !("$ref" in s)) s.unevaluatedProperties ??= true;
  for (const v of Object.values(o)) openBranches(v);
}
openBranches(spec);
