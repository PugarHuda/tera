import { describe, expect, it } from "vitest";
import { OPTIONS as migrateOptions, POST as migrate } from "@/app/api/migrate/route";
import { GET as scenarioGet, OPTIONS as scenarioOptions } from "@/app/api/scenarios/[id]/route";
import { POST as simulate } from "@/app/api/simulate/route";
import { GET as unknownGet, POST as unknownPost } from "@/app/api/[...path]/route";

// The contract /api/openapi.json states and Schemathesis checks in CI: 400 = the body breaks the published schema,
// 422 = the schema allows it but it cannot be billed.
const post = (route: (r: Request) => Promise<Response>, body: unknown) =>
  route(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) })).then((r) => r.status);
const sub = { at: "2027-01-01T00:00:00Z", type: "subscribe", price: "pro_m" };
const metered = (tiers: object[]) => ({ prices: { m: { currency: "usd", interval: "month", usage_type: "metered", tiers } } });

describe("400 for a schema violation, 422 for a schema-valid request that cannot be billed", () => {
  it.each([
    ["events out of date order", { timeline: [sub, { at: "2026-12-31", type: "advance_to" }] }, 422],
    ["30 February", { timeline: [sub, { at: "2027-02-30", type: "advance_to" }] }, 422],
    ["a span over 10 years", { timeline: [sub, { at: "2037-02-01", type: "advance_to" }] }, 422],
    ["tiers that do not ascend", { catalog: metered([{ up_to: 10, unit_amount_decimal: "1" }, { up_to: 5, unit_amount_decimal: "1" }, { up_to: null, unit_amount_decimal: "1" }]), timeline: [{ ...sub, price: "m" }] }, 422],
    ["an unknown price", { timeline: [{ ...sub, price: "nope" }] }, 422],
    ["month 13", { timeline: [sub, { at: "2027-13-01", type: "advance_to" }] }, 400],
    ["a tier up_to of 0", { catalog: metered([{ up_to: 0, unit_amount_decimal: "1" }, { up_to: null, unit_amount_decimal: "1" }]), timeline: [{ ...sub, price: "m" }] }, 400],
    ["no events", { timeline: [] }, 400],
  ])("simulate: %s", async (_, body, status) => expect(await post(simulate, body)).toBe(status));

  it("migrate: seats × price over 1e15 is 422, no customers is 400", async () => {
    expect(await post(migrate, { unit_amount: 1e9, new_unit_amount: 1e9, grandfather: false, customers: [1e6, 1e6] })).toBe(422);
    expect(await post(migrate, { unit_amount: 1, new_unit_amount: 2, grandfather: false, customers: [] })).toBe(400);
  });
});

describe("OPTIONS and 405 name only the methods a route serves", () => {
  it("lists POST for a POST route and GET, HEAD for a GET route", () => {
    expect(migrateOptions().headers.get("allow")).toBe("POST, OPTIONS");
    expect(scenarioOptions().headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(migrateOptions().status).toBe(204);
  });
  it("still finds a scenario in any case", async () => {
    const res = await scenarioGet(new Request("http://x"), { params: Promise.resolve({ id: "s05" }) } as never);
    expect(res.status).toBe(200);
  });
});

describe("an unknown /api path", () => {
  it("answers a JSON 404, not the HTML page", async () => {
    for (const route of [unknownGet, unknownPost]) {
      const res = route(new Request("http://x/api/simulat", { method: "POST" }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No API route /api/simulat; see /api/openapi.json" });
    }
  });
});
