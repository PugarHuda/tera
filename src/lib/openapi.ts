// OpenAPI 3.1 for the public API. Served at /api/openapi.json and as an MCP resource (tera://openapi.json).
import golden from "../../golden/scenarios.json";
import evidence from "../../golden/parity/index.json";
import { EVENT_TYPES } from "./validate";
import { BILLING_MODES, PRORATION_BEHAVIORS, TRIAL_END_BEHAVIORS } from "./billing";

// Counted from the recorded evidence so the description never goes stale.
const timelines = golden.scenarios.filter((s) => "timeline" in s).length;
const verified = evidence.filter((e) => e.match).length;

const error = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "Tera API",
    version: "0.1.0",
    description:
      `Stripe-parity pricing simulator. All amounts are integers in the currency's minor unit (USD cents; JPY yen). Rules R1-R23 in docs/PRD.md (billing_mode classic or flexible). ${verified}/${timelines} golden timeline scenarios verified against Stripe test mode (see /parity).`,
  },
  paths: {
    "/api/simulate": {
      post: {
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
          "400": { description: "Malformed input", content: { "application/json": { schema: error } } },
          "422": { description: "Unknown price/coupon/tax rate or event before subscribe", content: { "application/json": { schema: error } } },
        },
      },
    },
    "/api/migrate": {
      post: {
        summary: "Preview the MRR impact of a price change",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["unit_amount", "new_unit_amount", "grandfather", "customers"],
                properties: {
                  unit_amount: { type: "integer", minimum: 1 },
                  new_unit_amount: { type: "integer", minimum: 1 },
                  grandfather: { type: "boolean" },
                  interval: { type: "string", enum: ["month", "year"], default: "month", description: "Annual prices count as amount/12 MRR per customer" },
                  customers: {
                    type: "array",
                    items: {
                      oneOf: [
                        { type: "integer", minimum: 1, description: "Seat count" },
                        { type: "object", required: ["name", "seats"], properties: { name: { type: "string" }, seats: { type: "integer", minimum: 1 } } },
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
          "400": { description: "Malformed input", content: { "application/json": { schema: error } } },
        },
      },
    },
    "/api/parity": {
      get: { summary: "Recorded Stripe test-clock evidence for every golden scenario", responses: { "200": { description: "Evidence records" } } },
      post: {
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
          "200": { description: "match, diffs, tera and stripe invoices, test clock id" },
          "400": { description: "Unknown scenario, malformed timeline or over the live limits", content: { "application/json": { schema: error } } },
          "422": { description: "Tera (and Stripe) reject this timeline", content: { "application/json": { schema: error } } },
          "429": { description: "Another live replay holds the Stripe cooldown", headers: { "retry-after": { schema: { type: "integer" }, description: "Seconds to wait" } }, content: { "application/json": { schema: error } } },
          "502": { description: "Stripe call failed", content: { "application/json": { schema: error } } },
        },
      },
    },
    "/api/stripe/push": {
      post: {
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
    "/api/scenarios": {
      get: { summary: "List golden scenarios", responses: { "200": { description: "Scenario summaries" } } },
    },
    "/api/scenarios/{id}": {
      get: {
        summary: "Get a golden scenario (timeline + hand-derived expected invoices + catalog)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", example: "S05" } }],
        responses: { "200": { description: "Scenario" }, "404": { description: "Not found", content: { "application/json": { schema: error } } } },
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
            additionalProperties: {
              type: "object",
              required: ["currency", "interval"],
              properties: {
                currency: { type: "string", pattern: "^[a-zA-Z]{3}$" },
                interval: { type: "string", enum: ["month", "year"] },
                unit_amount: { type: "integer", minimum: 1, description: "Licensed prices: amount per seat in minor units" },
                usage_type: { type: "string", enum: ["licensed", "metered"] },
                tiers: {
                  type: "array",
                  description: "Metered prices: graduated tiers, ascending, the last with up_to: null",
                  items: { type: "object", required: ["up_to", "unit_amount_decimal"], properties: { up_to: { type: ["integer", "null"] }, unit_amount_decimal: { type: "string" } } },
                },
              },
            },
          },
          coupons: {
            type: "object",
            maxProperties: 50,
            additionalProperties: {
              type: "object",
              required: ["duration"],
              properties: {
                percent_off: { type: "number", exclusiveMinimum: 0, maximum: 100 },
                amount_off: { type: "integer", minimum: 1 },
                currency: { type: "string", description: "Required with amount_off" },
                duration: { type: "string", enum: ["once", "repeating", "forever"] },
                duration_in_months: { type: "integer", minimum: 1, maximum: 120 },
              },
            },
          },
          tax_rates: {
            type: "object",
            maxProperties: 20,
            additionalProperties: {
              type: "object",
              required: ["percentage", "behavior"],
              properties: { percentage: { type: "number", minimum: 0, exclusiveMaximum: 100 }, behavior: { type: "string", enum: ["inclusive", "exclusive"] } },
            },
          },
        },
      },
      SimulateRequest: {
        type: "object",
        required: ["timeline"],
        properties: {
          catalog: { $ref: "#/components/schemas/Catalog" },
          locale: { type: "string", default: "en-US" },
          timeline: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              required: ["at", "type"],
              properties: {
                at: { type: "string", format: "date-time" },
                type: { type: "string", enum: EVENT_TYPES },
                price: { type: "string" },
                quantity: { type: "integer", minimum: 0, maximum: 1000000000, description: "Seats, or usage units for report_usage. change_quantity needs at least 1." },
                coupon: { type: "string" },
                tax_rate: { type: "string" },
                trial_days: { type: "integer", minimum: 1, maximum: 730 },
                proration_behavior: { type: "string", enum: [...PRORATION_BEHAVIORS] },
                billing_cycle_anchor: { type: "string", description: "subscribe: ISO-8601 first billing date (Stripe billing_cycle_anchor), at most one period ahead (R20). resume of a paused subscription: \"now\" (default) or \"unchanged\" (R21)." },
                cancel_at: { type: "string", format: "date-time", description: "cancel_at events: when the subscription ends (Stripe cancel_at, R19)." },
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
            },
          },
        },
      },
      SimulationResult: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "trialing", "paused", "canceled", "none"] },
          canceled_at: { type: ["string", "null"] },
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

