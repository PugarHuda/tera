import golden from "../../../golden/scenarios.json";
import { spec } from "@/lib/openapi";
import { POST as mcp } from "../api/mcp/route";
import { SITE } from "../sitemap";
import { STRIPE_API_VERSION } from "@/lib/stripe-parity";

// llms.txt (llmstxt.org) for AI agents, built from the sources it describes so it cannot drift: the golden
// scenarios, the OpenAPI document and the MCP server's own tools/list, resources/list and prompts/list.
export const dynamic = "force-static";

type Item = { name: string; title?: string; description?: string; uri?: string; uriTemplate?: string };

async function list(method: string): Promise<Item[]> {
  const res = await mcp(
    new Request(`${SITE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    }),
  );
  const text = await res.text();
  const json = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  const r = json.result;
  return r.tools ?? r.resources ?? r.resourceTemplates ?? r.prompts;
}

const first = (s = "") => s.split(/(?<=\.)\s/)[0];

export async function GET() {
  const scenarios = golden.scenarios as { timeline?: unknown; status: string; rules?: string[] }[];
  const timelines = scenarios.filter((s) => s.timeline);
  const verified = timelines.filter((s) => s.status === "verified").length;
  const rules = new Set(scenarios.flatMap((s) => s.rules ?? []));
  const [tools, resources, templates, prompts] = await Promise.all(["tools/list", "resources/list", "resources/templates/list", "prompts/list"].map(list));
  const endpoints = Object.entries(spec.paths as Record<string, Record<string, { summary?: string }>>).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => `- ${method.toUpperCase()} ${path}: ${op.summary ?? ""}`),
  );
  const body = `# Tera

> Stripe-parity pricing simulator. Send a catalog (prices, coupons, tax rates) and a customer timeline; get every invoice to the cent, exactly as Stripe would bill it, in classic and flexible billing mode. ${verified} of ${timelines.length} golden timeline scenarios are verified against real Stripe test clocks (Stripe API ${STRIPE_API_VERSION}). Tera never moves money; its Stripe features use a test-mode key only.

Amounts are integers in the currency's minor unit (cents; yen for JPY). Dates are ISO-8601 UTC. ${scenarios.length} golden scenarios cite ${rules.size} billing rules (${[...rules].sort((a, b) => +a.slice(1) - +b.slice(1)).join(", ")}), defined in the PRD.

## API

- [OpenAPI document](${SITE}/api/openapi.json): every endpoint and schema
- [Interactive reference](${SITE}/reference)
${endpoints.join("\n")}

## MCP

- [Setup](${SITE}/mcp-setup): \`claude mcp add --transport http tera ${SITE}/api/mcp\`
${tools.map((t) => `- Tool \`${t.name}\`: ${first(t.description)}`).join("\n")}
${[...resources.filter((r) => !/^tera:\/\/scenarios\/S\d+$/.test(r.uri ?? "")), ...templates].map((r) => `- Resource \`${r.uri ?? r.uriTemplate}\`: ${first(r.description ?? r.title ?? r.name)}`).join("\n")}
${prompts.map((p) => `- Prompt \`${p.name}\`: ${first(p.description)}`).join("\n")}

## Docs

- [PRD and billing rules](https://github.com/PugarHuda/tera/blob/main/docs/PRD.md)
- [Golden scenarios](https://github.com/PugarHuda/tera/blob/main/golden/scenarios.json)
- [Stripe parity evidence](${SITE}/parity)
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
