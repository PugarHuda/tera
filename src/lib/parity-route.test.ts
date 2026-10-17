import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/parity/route";

// Only the rejection paths: none of these may reach Stripe.
const post = (body: unknown) => POST(new Request("http://x/api/parity", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const sub = { at: "2027-01-01T00:00:00Z", type: "subscribe", price: "pro_m" };

describe("POST /api/parity validation", () => {
  it("rejects malformed JSON and unknown golden ids with 400", async () => {
    expect((await post("{")).status).toBe(400);
    expect((await post({ scenario: "S999" })).status).toBe(400);
  });
  it("caps custom live replays at 15 events and 2 years", async () => {
    const many = Array.from({ length: 16 }, (_, i) => (i === 0 ? sub : { at: `2027-02-${String(i).padStart(2, "0")}T00:00:00Z`, type: "advance_to" }));
    expect((await post({ timeline: many })).status).toBe(400);
    expect((await post({ timeline: [sub, { at: "2029-02-01T00:00:00Z", type: "advance_to" }] })).status).toBe(400);
  });
  it("returns 422 for timelines Tera rejects (R11) before calling Stripe", async () => {
    expect((await post({ timeline: [{ ...sub, price: "nope" }] })).status).toBe(422);
  });
});
