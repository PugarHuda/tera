import { expect, it } from "vitest";
import golden from "../../../golden/scenarios.json";
import { GET } from "./route";

it("llms.txt is built from the live sources: every MCP tool, every endpoint, the real scenario count", async () => {
  const text = await (await GET()).text();
  for (const tool of ["simulate_timeline", "verify_timeline_in_stripe", "import_stripe_catalog", "plan_stripe_price_migration"]) expect(text).toContain(`\`${tool}\``);
  for (const ep of ["POST /api/simulate", "GET /api/stripe/catalog", "GET /api/migrate/stripe"]) expect(text).toContain(ep);
  const timelines = golden.scenarios.filter((s) => "timeline" in s).length;
  expect(text).toContain(`of ${timelines} golden timeline scenarios`);
  expect(text).toContain(`${golden.scenarios.length} golden scenarios`);
});
