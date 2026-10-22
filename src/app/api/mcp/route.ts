// MCP server (Streamable HTTP): lets coding agents run Tera's billing engine as tools, read its evidence as resources.
import { ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import golden from "../../../../golden/scenarios.json";
import evidence from "../../../../golden/parity/index.json";
import { BILLING_MODES, PRORATION_BEHAVIORS, TRIAL_END_BEHAVIORS, formatMoney, migrate, simulate } from "@/lib/billing";
import { spec } from "@/lib/openapi";
import { encodeCatalog, encodeTimeline } from "@/lib/share";
import { Cooldown, checkLiveLimits, claimPush, liveParity, migratablePrices, pushCatalogOnce, stripeCatalog, stripeClient, subscribersOf } from "@/lib/stripe-parity";
import { BadRequest, EVENT_TYPES, defaultCatalog, findScenarios, parseCatalog, parseCurrency, parseLocale, parseMigration, parseTimeline } from "@/lib/validate";

const event = z.object({
  at: z.string().describe("ISO-8601 UTC timestamp, e.g. 2027-01-17T00:00:00Z"),
  type: z.enum(EVENT_TYPES),
  price: z.string().optional().describe(`Price id: ${Object.keys(defaultCatalog.prices).join(", ")}`),
  quantity: z
    .number()
    .int()
    .min(0)
    .max(1e9)
    .optional()
    .describe("Seats, or usage units for report_usage. On change_price it is the new quantity; omitted means 1, as in Stripe (R13)."),
  coupon: z.string().optional().describe(`Coupon code: ${Object.keys(defaultCatalog.coupons ?? {}).join(", ")}`),
  tax_rate: z.string().optional().describe(`Tax rate id: ${Object.keys(defaultCatalog.tax_rates ?? {}).join(", ")}`),
  trial_days: z.number().int().min(1).max(730).optional(),
  proration_behavior: z
    .enum(PRORATION_BEHAVIORS)
    .optional()
    .describe(
      "none = no proration; the new terms bill from the next renewal (R14). On cancel_now, always_invoice refunds the unused time on a final invoice (Stripe prorate + invoice_now, R17). On pause (flexible only, R21): default credits the unused time on the next invoice, always_invoice invoices the credit now, none credits nothing",
    ),
  billing_cycle_anchor: z
    .string()
    .optional()
    .describe(
      'subscribe: ISO-8601 first billing date, at most one period ahead; the time before it is prorated now unless proration_behavior=none (R20). resume of a paused subscription: "now" (default) or "unchanged" (R21)',
    ),
  cancel_at: z.string().optional().describe("cancel_at only: ISO-8601 UTC date the subscription ends (Stripe cancel_at, R19)"),
  billing_mode: z
    .enum(BILLING_MODES)
    .optional()
    .describe("subscribe/start_trial only. Stripe's default for new subscriptions is flexible; omitted means classic (R16)"),
  amount: z
    .number()
    .int()
    .optional()
    .describe("adjust_balance only: customer balance transaction in minor units; negative is a credit applied to the next invoice, positive a debit (R23)"),
  trial_end_behavior: z
    .enum(TRIAL_END_BEHAVIORS)
    .optional()
    .describe(
      'start_trial only: the customer has no card, so the trial ends canceled or paused (Stripe trial_settings.end_behavior.missing_payment_method, R22). Resume a paused one later; classic needs billing_cycle_anchor "unchanged"',
    ),
});

// A custom catalog goes through the same parser as the REST API: one trust boundary, one set of messages.
const catalog = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Optional custom catalog { prices, coupons?, tax_rates? } in the /api/openapi.json Catalog shape; omitted = the golden catalog (resource tera://catalog)");

const APP = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "tera-orpin-three.vercel.app"}`;
const scenarioById = (id: string) => golden.scenarios.find((x) => x.id.toLowerCase() === id.toLowerCase());
const evidenceSummary = () =>
  evidence.map(({ id, title, verified_at, stripe_api_version, match, diffs, test_clock }) => ({ id, title, verified_at, stripe_api_version, match, diffs, test_clock }));
const json = (uri: URL, data: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] });
const ask = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

// Data goes out twice, as MCP asks: structuredContent for clients that read it (checked against the tool's
// outputSchema by the SDK) and the same JSON in the text for those that do not.
const text = (t: string, data?: object, isError = false) => ({
  content: [{ type: "text" as const, text: data === undefined ? t : `${t}\n\n${JSON.stringify(data, null, 2)}` }],
  ...(data === undefined || Array.isArray(data) ? {} : { structuredContent: data as Record<string, unknown> }),
  isError,
});

// Output schemas: what an agent can rely on without parsing prose. Same field names as POST /api/simulate.
const int = z.number().int();
const invoiceOut = z.object({
  date: z.string(),
  currency: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  lines: z.array(z.object({ description: z.string(), amount: int, proration: z.boolean() })),
  subtotal: int,
  discount: int,
  tax: int,
  total: int.describe("Minor units; negative for a credit"),
  starting_balance: int.describe("Customer balance before this invoice; negative = credit (R10)"),
  amount_due: int.min(0),
  total_display: z.string().describe("total formatted for the requested locale"),
});
const simulationOut = z.object({
  status: z.enum(["active", "trialing", "paused", "canceled", "none"]),
  canceled_at: z.string().nullable(),
  invoices: z.array(invoiceOut),
  webhooks: z.array(
    z.object({
      event: int.describe("Index of the timeline event whose step sends it"),
      date: z.string(),
      type: z.string(),
      invoice: int.optional().describe("invoice.* events: 1-based index in invoices"),
      status: z.enum(["active", "trialing", "paused", "canceled", "none"]).optional(),
    }),
  ),
});
const migrationOut = z.object({
  affected: int,
  mrr_before: int,
  mrr_after: int,
  mrr_delta: int,
  per_customer: z.array(z.object({ name: z.string(), seats: int, mrr_before: int, mrr_after: int, mrr_delta: int })),
});
const scenarioListOut = z.object({ scenarios: z.array(z.object({ id: z.string(), title: z.string(), rules: z.array(z.string()) })) });
const scenarioOut = z.object({ id: z.string(), title: z.string(), rules: z.array(z.string()), expect: z.array(z.record(z.string(), z.unknown())).optional() }).passthrough();

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

const readOnly = { readOnlyHint: true, openWorldHint: false };

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "simulate_timeline",
      {
        title: "Simulate a customer's invoices",
        description:
          "Run a customer timeline (subscribe, trials, upgrades, coupons, tax, usage, cancellation) through Tera's Stripe-parity billing engine and return every invoice to the cent, plus the webhook events Stripe sends for it (per timeline event, to test a webhook handler). Amounts are integers in minor units.",
        inputSchema: z.object({ timeline: z.array(event).min(1), catalog, locale: z.string().optional() }),
        outputSchema: simulationOut,
        annotations: readOnly,
      },
      guard(({ timeline, catalog, locale: tag }) => {
        const locale = parseLocale(tag); // same message as POST /api/simulate
        const result = simulate(parseCatalog(catalog), parseTimeline(timeline));
        const summary = result.invoices
          .map((i, n) => `Invoice ${n + 1} ${i.date}: total ${formatMoney(i.total, i.currency, locale)}, due ${formatMoney(i.amount_due, i.currency, locale)}${i.starting_balance < 0 ? ` (credit applied ${formatMoney(-i.starting_balance, i.currency, locale)})` : ""}`)
          .join("\n");
        const hooks = Object.entries(Object.groupBy(result.webhooks, (w) => w.type)).map(([type, ws]) => `${type} ×${ws!.length}`);
        const invoices = result.invoices.map((i) => ({ ...i, total_display: formatMoney(i.total, i.currency, locale) }));
        return text(`Status: ${result.status}\n${summary}\nWebhook events Stripe sends (${result.webhooks.length}): ${hooks.join(", ")}`, { ...result, invoices });
      }),
    );

    server.registerTool(
      "verify_timeline_in_stripe",
      {
        title: "Replay a timeline in real Stripe and diff it",
        description:
          "Replay a customer timeline (max 15 events, 2 years) in a fresh Stripe test-mode test clock and compare Stripe's invoices with Tera's to the cent. Takes up to a minute; one run per 30 seconds.",
        inputSchema: z.object({ timeline: z.array(event).min(1), catalog }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ timeline, catalog: raw }) => {
        let cat, parsed, tera;
        try {
          cat = parseCatalog(raw);
          parsed = parseTimeline(timeline);
          checkLiveLimits(parsed);
          tera = simulate(cat, parsed);
        } catch (e) {
          return text(`Rejected: ${(e as Error).message}`, undefined, true);
        }
        try {
          const r = await liveParity(cat, parsed, tera);
          const head = r.match
            ? `Matches Stripe: ${r.stripe.length} invoice(s) identical to the cent (test clock ${r.test_clock}).`
            : `Differs from Stripe on ${r.diffs.length} field(s) (test clock ${r.test_clock}).`;
          const hooks = r.webhooks.match
            ? `Webhook events match: ${r.webhooks.stripe.flat().length} sent, the same types, invoices and subscription statuses for every timeline event (full Stripe payloads in webhooks.payloads).`
            : `Webhook events differ: ${r.webhooks.diffs.map((d) => `event ${d.event} ${d.type} Tera ${d.tera}, Stripe ${d.stripe}`).join("; ")}.`;
          return text(`${head}
${hooks}`, { match: r.match, diffs: r.diffs, stripe: r.stripe, webhooks: r.webhooks });
        } catch (e) {
          return text(e instanceof Cooldown ? e.message : `Stripe replay failed: ${(e as Error).message}`, undefined, true);
        }
      },
    );

    server.registerTool(
      "plan_price_migration",
      {
        title: "Preview the MRR impact of a price change",
        description:
          "Given the current and new unit price per seat (minor units of `currency`), the billing interval, a grandfathering flag and seats per customer (a number or { name, seats }), return affected customers and MRR before/after/delta, per customer and in total.",
        inputSchema: z.object({
          unit_amount: z.number().int().min(1).max(1e12),
          new_unit_amount: z.number().int().min(1).max(1e12),
          grandfather: z.boolean(),
          interval: z.enum(["month", "year"]).optional().describe("Annual prices count as amount / 12 MRR per customer"),
          currency: z.string().regex(/^[a-zA-Z]{3}$/).optional().describe("ISO code for the summary line; default usd"),
          customers: z.array(z.union([z.number().int().min(1).max(1e6), z.object({ name: z.string(), seats: z.number().int().min(1).max(1e6) })])),
        }),
        outputSchema: migrationOut,
        annotations: readOnly,
      },
      guard(({ currency: code = "usd", ...input }) => {
        const currency = parseCurrency(code);
        const r = migrate(parseMigration(input));
        return text(`MRR ${formatMoney(r.mrr_before, currency)} -> ${formatMoney(r.mrr_after, currency)} (${r.affected} ${r.affected === 1 ? "customer" : "customers"} affected)`, r);
      }),
    );

    server.registerTool(
      "plan_stripe_price_migration",
      {
        title: "Preview a price change on real Stripe subscriptions",
        description:
          "Read the live subscriptions on a per-seat price in the connected Stripe test-mode account (one customer per subscription, its quantity as seats) and return the MRR impact of moving them to new_unit_amount. Omit stripe_price to list the account's per-seat prices first.",
        inputSchema: z.object({
          stripe_price: z.string().optional().describe("A Stripe price id such as price_1Abc…; omitted = list the prices you can choose from"),
          new_unit_amount: z.number().int().min(1).max(1e12).optional().describe("The new price per seat, minor units of the price's currency"),
          grandfather: z.boolean().optional().describe("Keep existing customers on the current price; default false"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ stripe_price, new_unit_amount, grandfather = false }) => {
        try {
          const stripe = stripeClient();
          if (!stripe_price) {
            const prices = await migratablePrices(stripe);
            return text(prices.map((p) => `${p.id} ${p.name} ${formatMoney(p.unit_amount, p.currency)} / ${p.interval}`).join("\n") || "No per-seat recurring prices in the connected Stripe account", { prices });
          }
          if (new_unit_amount === undefined) throw new BadRequest("new_unit_amount is required with stripe_price");
          const base = await subscribersOf(stripe, stripe_price);
          if (base.customers.length === 0) return text(`No live subscriptions on ${base.price} (${base.skipped} canceled or incomplete): nothing to migrate`, base);
          const r = migrate(parseMigration({ unit_amount: base.unit_amount, new_unit_amount, grandfather, interval: base.interval, customers: base.customers }));
          const n = base.customers.length;
          return text(
            `${n} live ${n === 1 ? "subscription" : "subscriptions"} on ${base.price}: MRR ${formatMoney(r.mrr_before, base.currency)} -> ${formatMoney(r.mrr_after, base.currency)} (${r.affected} affected)`,
            { ...r, currency: base.currency, interval: base.interval, unit_amount: base.unit_amount, skipped: base.skipped },
          );
        } catch (e) {
          return text(`Rejected: ${(e as Error).message}`, undefined, true);
        }
      },
    );

    server.registerTool(
      "import_stripe_catalog",
      {
        title: "Import the connected Stripe account's catalog",
        description:
          "Read the active per-seat prices, valid coupons and active tax rates of the connected Stripe test-mode account as a Tera catalog. Pass it as `catalog` to simulate_timeline or verify_timeline_in_stripe to simulate customers on the prices a team already has.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        try {
          const { catalog, skipped } = await stripeCatalog(stripeClient());
          const line = (kind: string, ids: string[]) => `${kind}: ${ids.join(", ") || "none"}`;
          return text(
            [line("prices", Object.keys(catalog.prices)), line("coupons", Object.keys(catalog.coupons)), line("tax_rates", Object.keys(catalog.tax_rates)), `skipped (older copies, not modelled, or over the limits): ${JSON.stringify(skipped)}`].join("\n"),
            { catalog, skipped },
          );
        } catch (e) {
          return text(`Rejected: ${(e as Error).message}`, undefined, true);
        }
      },
    );

    server.registerTool(
      "list_golden_scenarios",
      {
        title: "List hand-derived golden billing scenarios",
        description:
          "The reference scenarios (with expected invoices derived by hand from Stripe's rules) that Tera is tested against, optionally only those citing a rule or with words in the title.",
        inputSchema: z.object({
          rule: z.string().optional().describe("A billing rule id such as R6 (tax) or R16 (flexible billing mode)"),
          query: z.string().optional().describe('Words that must all appear in the title, such as "coupon trial"'),
        }),
        outputSchema: scenarioListOut,
        annotations: readOnly,
      },
      guard(({ rule, query }) => {
        const found = findScenarios(rule, query);
        return text(found.length ? found.map((s) => `${s.id} ${s.title}`).join("\n") : "No golden scenario matches; omit rule and query to list all", {
          scenarios: found.map(({ id, title, rules }) => ({ id, title, rules })),
        });
      }),
    );

    server.registerTool(
      "get_golden_scenario",
      {
        title: "Get one golden scenario",
        description: "Timeline, expected invoices and the hand math for a golden scenario id such as S05.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: scenarioOut,
        annotations: readOnly,
      },
      guard(({ id }) => {
        const s = scenarioById(id);
        if (!s) throw new BadRequest(`Scenario ${id} not found`);
        return text(`${s.id} ${s.title}`, s);
      }),
    );

    server.registerTool(
      "get_parity_evidence",
      {
        title: "Recorded Stripe evidence for golden scenarios",
        description:
          "The stored result of replaying golden scenarios in Stripe test clocks: match flag, diffs, test clock id, API version and, for one id, Stripe's own invoice ids and lines. No Stripe call.",
        inputSchema: z.object({ id: z.string().optional().describe("Scenario id such as S05; omitted = a summary of all") }),
        annotations: readOnly,
      },
      guard(({ id }) => {
        if (id === undefined) {
          const all = evidenceSummary();
          return text(`${all.filter((e) => e.match).length} / ${all.length} recorded replays match Stripe to the cent`, { scenarios: all });
        }
        const e = evidence.find((x) => x.id.toLowerCase() === id.toLowerCase());
        if (!e) throw new BadRequest(`No Stripe evidence for ${id} (scenarios without a timeline are not replayable)`);
        return text(`${e.id} ${e.match ? "matches" : "differs from"} Stripe (verified ${e.verified_at}, test clock ${e.test_clock})`, e);
      }),
    );

    server.registerTool(
      "create_share_link",
      {
        title: "Open a timeline in the Tera simulator",
        description:
          "Validate a timeline (and optional custom catalog) and return a link that opens it in Tera's web simulator with the same invoices, for a human to inspect or share.",
        inputSchema: z.object({ timeline: z.array(event).min(1), catalog }),
        outputSchema: z.object({ url: z.string().url() }),
        annotations: readOnly,
      },
      guard(({ timeline, catalog: raw }) => {
        const parsed = parseTimeline(timeline);
        const cat = raw === undefined ? null : parseCatalog(raw);
        simulate(cat ?? defaultCatalog, parsed); // a link that only shows an error is not worth sharing
        const url = `${APP}/simulator?t=${encodeTimeline(parsed)}${cat ? `&c=${encodeCatalog(cat)}` : ""}`;
        return text(url, { url });
      }),
    );

    server.registerTool(
      "push_catalog_to_stripe",
      {
        title: "Create a catalog in Stripe test mode",
        description:
          "Create (or reuse, keyed by a hash of each definition) the catalog's products, prices, coupons, tax rates and usage meter in Tera's Stripe TEST-mode account and return the Stripe ids. Never touches live mode.",
        inputSchema: z.object({ catalog: z.record(z.string(), z.unknown()).describe("{ prices, coupons?, tax_rates? } in the /api/openapi.json Catalog shape") }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ catalog: raw }) => {
        let cat;
        try {
          cat = parseCatalog(raw);
        } catch (e) {
          return text(`Rejected: ${(e as Error).message}`, undefined, true);
        }
        try {
          const stripe = stripeClient();
          claimPush();
          const ids = await pushCatalogOnce(stripe, cat);
          return text(`Created or reused ${Object.keys(ids.prices).length} price(s) in Stripe test mode`, ids);
        } catch (e) {
          return text(`Stripe push failed: ${(e as Error).message}`, undefined, true);
        }
      },
    );

    server.registerResource(
      "catalog",
      "tera://catalog",
      { title: "Golden catalog", description: "Prices, coupons and tax rates the golden scenarios (and tools without a catalog) use", mimeType: "application/json" },
      (uri) => json(uri, defaultCatalog),
    );
    server.registerResource("openapi", "tera://openapi.json", { title: "Tera REST API (OpenAPI 3.1)", mimeType: "application/json" }, (uri) => json(uri, spec));
    server.registerResource(
      "parity-evidence",
      "tera://parity",
      { title: "Stripe parity evidence", description: "Match flag, diffs and test clock per replayed golden scenario", mimeType: "application/json" },
      (uri) => json(uri, evidenceSummary()),
    );
    server.registerResource(
      "scenario",
      new ResourceTemplate("tera://scenarios/{id}", {
        list: () => ({
          resources: golden.scenarios.map((s) => ({ uri: `tera://scenarios/${s.id}`, name: s.id, title: s.title, mimeType: "application/json" })),
        }),
        complete: { id: (v) => golden.scenarios.map((s) => s.id).filter((id) => id.toLowerCase().startsWith(v.toLowerCase())) },
      }),
      { title: "Golden scenario", description: "Timeline, hand-derived expected invoices and the math", mimeType: "application/json" },
      (uri, { id }) => {
        const s = scenarioById(String(id));
        if (!s) throw new ResourceNotFoundError(uri.href, `Scenario ${id} not found`);
        return json(uri, s);
      },
    );

    server.registerPrompt(
      "explain_invoice",
      {
        title: "Explain a golden scenario's invoices",
        description: "Walk through every line of a golden scenario's invoices and the Stripe rule behind it",
        // Only timeline scenarios have invoices (S24-style migration scenarios do not).
        argsSchema: z.object({
          id: z
            .string()
            .refine((id) => !!scenarioById(id)?.timeline, "not a golden timeline scenario id (see tera://scenarios)")
            .describe("Golden scenario id, e.g. S05"),
        }),
      },
      ({ id }) =>
        ask(
          `Read resource tera://scenarios/${id} and its Stripe evidence (tool get_parity_evidence, id ${id}). Explain each invoice line by line: the amount, which Stripe rule (R1-R24 in the PRD, see the scenario's math) produces it, and how Stripe's own invoice confirms it. End with what the customer is charged on each date.`,
        ),
    );
    server.registerPrompt(
      "audit_price_change",
      {
        title: "Audit a price change before shipping it",
        description: "Model a price change for existing customers, check the proration a mid-cycle switch causes, and verify it in Stripe",
        argsSchema: z.object({
          from_price: z.string().describe("Current price id in the catalog, e.g. starter_m"),
          to_price: z.string().describe("New price id, e.g. pro_m"),
          customers: z.string().describe("Seats per customer, comma separated, e.g. 1, 3, 10"),
        }),
      },
      ({ from_price, to_price, customers }) =>
        ask(
          [
            `I want to move customers from ${from_price} to ${to_price}. Seats per customer: ${customers}.`,
            "1. Read tera://catalog for both prices' unit amounts and intervals.",
            "2. Call plan_price_migration with grandfather false and with grandfather true, and compare MRR.",
            `3. Call simulate_timeline for one customer who subscribes to ${from_price} on 2027-01-01 and switches to ${to_price} on 2027-01-16, once with proration_behavior create_prorations and once with none, then advance_to 2027-03-01.`,
            "4. Call verify_timeline_in_stripe on the prorated timeline so Stripe confirms the numbers.",
            "5. Recommend one option with the exact amounts, and include a create_share_link link to the timeline.",
          ].join("\n"),
        ),
    );
  },
  { serverInfo: { name: "tera", version: "0.2.0" } },
);

// verify_timeline_in_stripe replays in a Stripe test clock, which can take a minute.
export const maxDuration = 300;

export { handler as GET, handler as POST, handler as DELETE };
