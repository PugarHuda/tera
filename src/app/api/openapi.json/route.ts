import { EVENT_TYPES } from "@/lib/validate";

const error = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Tera API",
    version: "0.1.0",
    description:
      "Stripe-parity pricing simulator. All amounts are integers in the currency's minor unit (USD cents; JPY yen). Rules R1-R13 in docs/PRD.md. 39/39 golden scenarios verified against Stripe test mode (see /parity).",
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
          "429": { description: "Cooldown" },
          "502": { description: "Stripe call failed" },
        },
      },
    },
    "/api/stripe/push": {
      post: {
        summary: "Create or reuse a catalog's prices, coupons and tax rates in Stripe test mode",
        requestBody: { required: true, content: { "application/json": { example: { catalog: { prices: { pro_m: { currency: "usd", unit_amount: 7900, interval: "month" } } } } } } },
        responses: { "200": { description: "Stripe ids per catalog entry" }, "400": { description: "Invalid catalog", content: { "application/json": { schema: error } } }, "429": { description: "Cooldown" } },
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
      SimulateRequest: {
        type: "object",
        required: ["timeline"],
        properties: {
          catalog: { type: "object", description: "prices, coupons, tax_rates. Defaults to the golden catalog (GET /api/scenarios/S01)." },
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
                quantity: { type: "integer", minimum: 0 },
                coupon: { type: "string" },
                tax_rate: { type: "string" },
                trial_days: { type: "integer", minimum: 1, maximum: 730 },
                proration_behavior: { type: "string", enum: ["create_prorations", "always_invoice"] },
              },
            },
          },
        },
      },
      SimulationResult: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "trialing", "canceled", "none"] },
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

export function GET() {
  return Response.json(spec);
}
