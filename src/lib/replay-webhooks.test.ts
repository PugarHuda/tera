import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
// Plain .mjs served from public/ for users to download.
import { replay, signature } from "../../public/replay-webhooks.mjs";

// The replay script's signatures must pass Stripe's own verification, as a real webhook handler runs it.
const stripe = new Stripe("sk_test_unused");
const secret = "whsec_tera_replay_test";
const events = [
  { step: 0, id: "evt_1", object: "event", api_version: "2026-09-30.endive", created: 1798761600, type: "invoice.paid", livemode: false, data: { object: { id: "in_1", object: "invoice", total: 2900 } } },
  { step: 1, id: "evt_2", object: "event", api_version: "2026-09-30.endive", created: 1798761601, type: "customer.subscription.updated", livemode: false, data: { object: { id: "sub_1", object: "subscription", status: "active" } } },
];

describe("public/replay-webhooks.mjs", () => {
  it("signs each event so stripe.webhooks.constructEvent accepts it, in order and without Tera's step field", async () => {
    const received: { type: string; step: unknown }[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          const event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"] as string, secret);
          received.push({ type: event.type, step: (event as unknown as { step?: unknown }).step });
          res.writeHead(200).end();
        } catch {
          res.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks`;
    try {
      expect(await replay(events, url, secret)).toEqual([
        { id: "evt_1", type: "invoice.paid", status: 200 },
        { id: "evt_2", type: "customer.subscription.updated", status: 200 },
      ]);
      expect(received).toEqual([{ type: "invoice.paid", step: undefined }, { type: "customer.subscription.updated", step: undefined }]);
      // A handler with another endpoint's secret rejects them: the signature really depends on the secret.
      expect((await replay(events, url, "whsec_other")).map((r: { status: number }) => r.status)).toEqual([400, 400]);
    } finally {
      server.close();
    }
  });

  it("matches Stripe's documented scheme: v1 is HMAC-SHA256 of `t.payload`", () => {
    const header = signature('{"id":"evt_1"}', secret, 1798761600);
    expect(header).toMatch(/^t=1798761600,v1=[0-9a-f]{64}$/);
    expect(stripe.webhooks.generateTestHeaderString({ payload: '{"id":"evt_1"}', secret, timestamp: 1798761600 })).toBe(header);
  });
});
