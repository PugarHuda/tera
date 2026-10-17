// MCP server (Streamable HTTP): lets coding agents run Tera's billing engine as tools.
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import golden from "../../../../golden/scenarios.json";
import { formatMoney, migrate, simulate } from "@/lib/billing";
import { BadRequest, EVENT_TYPES, defaultCatalog, parseMigration, parseTimeline } from "@/lib/validate";

const event = z.object({
  at: z.string().describe("ISO-8601 UTC timestamp, e.g. 2027-01-17T00:00:00Z"),
  type: z.enum(EVENT_TYPES),
  price: z.string().optional().describe(`Price id: ${Object.keys(defaultCatalog.prices).join(", ")}`),
  quantity: z.number().int().optional(),
  coupon: z.string().optional().describe(`Coupon code: ${Object.keys(defaultCatalog.coupons ?? {}).join(", ")}`),
  tax_rate: z.string().optional().describe(`Tax rate id: ${Object.keys(defaultCatalog.tax_rates ?? {}).join(", ")}`),
  trial_days: z.number().int().optional(),
  proration_behavior: z.enum(["create_prorations", "always_invoice"]).optional(),
});

const text = (t: string, data?: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: data === undefined ? t : `${t}\n\n${JSON.stringify(data, null, 2)}` }],
  isError,
});

// Domain errors are the caller's to fix, so they come back as tool errors instead of protocol failures.
function guard<A>(fn: (a: A) => ReturnType<typeof text>) {
  return async (a: A) => {
    try {
      return fn(a);
    } catch (e) {
      if (e instanceof BadRequest || e instanceof Error) return text(`Rejected: ${e.message}`, undefined, true);
      throw e;
    }
  };
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "simulate_timeline",
      {
        title: "Simulate a customer's invoices",
        description:
          "Run a customer timeline (subscribe, trials, upgrades, coupons, tax, usage, cancellation) through Tera's Stripe-parity billing engine and return every invoice to the cent. Amounts are integers in minor units.",
        inputSchema: z.object({ timeline: z.array(event).min(1), locale: z.string().optional() }),
      },
      guard(({ timeline, locale }) => {
        const result = simulate(defaultCatalog, parseTimeline(timeline));
        const summary = result.invoices
          .map((i, n) => `Invoice ${n + 1} ${i.date}: total ${formatMoney(i.total, i.currency, locale)}`)
          .join("\n");
        return text(`Status: ${result.status}\n${summary}`, result);
      }),
    );

    server.registerTool(
      "plan_price_migration",
      {
        title: "Preview the MRR impact of a price change",
        description: "Given the current and new monthly unit price (minor units), a grandfathering flag and seats per customer, return affected customers and MRR before/after/delta.",
        inputSchema: z.object({
          unit_amount: z.number().int(),
          new_unit_amount: z.number().int(),
          grandfather: z.boolean(),
          customers: z.array(z.number().int()),
        }),
      },
      guard((input) => {
        const r = migrate(parseMigration(input));
        return text(`MRR ${formatMoney(r.mrr_before, "usd")} -> ${formatMoney(r.mrr_after, "usd")} (${r.affected} customers affected)`, r);
      }),
    );

    server.registerTool(
      "list_golden_scenarios",
      {
        title: "List hand-derived golden billing scenarios",
        description: "The reference scenarios (with expected invoices derived by hand from Stripe's rules) that Tera is tested against.",
        inputSchema: z.object({}),
      },
      guard(() => text(golden.scenarios.map((s) => `${s.id} ${s.title}`).join("\n"))),
    );

    server.registerTool(
      "get_golden_scenario",
      {
        title: "Get one golden scenario",
        description: "Timeline, expected invoices and the hand math for a golden scenario id such as S05.",
        inputSchema: z.object({ id: z.string() }),
      },
      guard(({ id }) => {
        const s = golden.scenarios.find((x) => x.id.toLowerCase() === id.toLowerCase());
        if (!s) throw new BadRequest(`Scenario ${id} not found`);
        return text(`${s.id} ${s.title}`, s);
      }),
    );
  },
  { serverInfo: { name: "tera", version: "0.1.0" } },
);

export { handler as GET, handler as POST, handler as DELETE };
