import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { simulate } from "./billing";
import { defaultCatalog } from "./validate";
import golden from "../../golden/scenarios.json";

// The MCP server through the official client SDK, over Streamable HTTP, with the route handler as the network: the
// protocol a coding agent speaks (initialize, tools/list, tools/call, resources, prompts), not the functions behind it.
const client = new Client({ name: "tera-test", version: "1" });
beforeAll(() => client.connect(new StreamableHTTPClientTransport(new URL("http://tera.test/api/mcp"), { fetch: (url, init) => POST(new Request(url, init)) })));
afterAll(() => client.close());

const s05 = golden.scenarios.find((s) => s.id === "S05")! as { timeline: Record<string, unknown>[] };
const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

describe("MCP server over the wire", () => {
  it("lists every tool with annotations, and an output schema on the tools that return data", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_share_link", "get_golden_scenario", "get_parity_evidence", "import_stripe_catalog", "list_golden_scenarios",
      "plan_price_migration", "plan_stripe_price_migration", "push_catalog_to_stripe", "simulate_timeline", "verify_timeline_in_stripe",
    ]);
    for (const t of tools) expect(t.annotations, t.name).toBeDefined();
    for (const t of tools) expect(t.outputSchema, t.name).toMatchObject({ type: "object" });
  });

  it("get_parity_evidence returns the recorded replays as structured content", async () => {
    const all = (await call("get_parity_evidence", {})).structuredContent as { scenarios: { id: string; match: boolean }[] };
    expect(all.scenarios.length).toBeGreaterThanOrEqual(114);
    expect(all.scenarios.find((e) => e.id === "S05")?.match).toBe(true);
    expect((await call("get_parity_evidence", { id: "s05" })).structuredContent).toMatchObject({ id: "S05", match: true });
  });

  it("completes explain_invoice's scenario id with timeline scenarios only", async () => {
    const { completion } = await client.complete({ ref: { type: "ref/prompt", name: "explain_invoice" }, argument: { name: "id", value: "S2" } });
    expect(completion.values).toContain("S23");
    expect(completion.values).not.toContain("S24"); // a migration scenario: no invoices to explain
  });

  it("simulate_timeline returns S05's invoices as structured content, the same numbers as the engine", async () => {
    const r = await call("simulate_timeline", { timeline: s05.timeline, locale: "de-DE" });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as { invoices: { total: number; total_display: string; lines: { amount: number }[] }[]; webhooks: unknown[]; status: string };
    const engine = simulate(defaultCatalog, s05.timeline as never);
    expect(out.invoices.map((i) => i.total)).toEqual(engine.invoices.map((i) => i.total));
    expect(out.invoices[1].total).toBe(10320); // hand-derived: −14.03 + 38.23 + 79.00
    expect(out.invoices[1].lines.map((l) => l.amount)).toEqual([-1403, 3823, 7900]);
    expect(out.invoices[1].total_display).toBe("103,20 $");
    expect(out.webhooks).toHaveLength(engine.webhooks.length);
    expect(out.status).toBe("active");
  });

  it("a rejected timeline is a tool error with the API's message, not a protocol failure", async () => {
    const r = await call("simulate_timeline", { timeline: [{ at: "2027-01-01T00:00:00Z", type: "subscribe", price: "gold" }] });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toBe("Rejected: Unknown price: gold");
    const order = await call("simulate_timeline", { timeline: [s05.timeline[0], { at: "2026-12-31T00:00:00Z", type: "advance_to" }] });
    expect((order.content as { text: string }[])[0].text).toContain("chronological order");
  });

  it("plan_price_migration and create_share_link return structured results", async () => {
    const m = await call("plan_price_migration", { unit_amount: 2900, new_unit_amount: 3900, grandfather: false, customers: [1, 1, 3] });
    expect(m.structuredContent).toMatchObject({ affected: 3, mrr_before: 14500, mrr_after: 19500, mrr_delta: 5000 });
    const link = await call("create_share_link", { timeline: s05.timeline });
    expect((link.structuredContent as { url: string }).url).toMatch(/^https:\/\/.+\/simulator\?t=/);
  });

  it("list_golden_scenarios filters by rule and returns ids and titles", async () => {
    const r = await call("list_golden_scenarios", { rule: "R6" });
    const { scenarios } = r.structuredContent as { scenarios: { id: string; title: string; rules: string[] }[] };
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of scenarios) expect(s.rules).toContain("R6");
  });

  it("get_golden_scenario returns every golden scenario through its output schema", async () => {
    for (const { id } of golden.scenarios) {
      const r = await call("get_golden_scenario", { id: id.toLowerCase() });
      expect(r.isError, id).toBeFalsy();
      expect((r.structuredContent as { id: string }).id).toBe(id);
    }
  });

  it("serves the catalog resource, the scenario template and the prompts", async () => {
    const cat = await client.readResource({ uri: "tera://catalog" });
    expect(JSON.parse((cat.contents[0] as { text: string }).text)).toEqual(defaultCatalog);
    const sc = await client.readResource({ uri: "tera://scenarios/S05" });
    expect(JSON.parse((sc.contents[0] as { text: string }).text).id).toBe("S05");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["audit_price_change", "explain_invoice"]);
  });
});
