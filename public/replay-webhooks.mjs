#!/usr/bin/env node
// Replays the webhook events a Stripe test clock sent (the JSON Tera's "Verify in Stripe" downloads) into your own
// webhook endpoint, each signed with your endpoint secret exactly as Stripe signs them, so the handler's
// stripe.webhooks.constructEvent accepts them. No dependencies; Node 18+.
//
//   STRIPE_WEBHOOK_SECRET=whsec_... node replay-webhooks.mjs stripe-webhooks-clock_123.json http://localhost:3000/api/webhooks
//
// Events are sent one at a time, in the order Stripe sent them. Exit code 1 if any response is not 2xx.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Stripe's scheme (docs.stripe.com/webhooks#verify-manually): v1 = HMAC-SHA256(secret, `${t}.${payload}`). */
export const signature = (payload, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex")}`;

/** Posts each event (Tera's `step` field removed) and returns one { id, type, status } per event. */
export async function replay(events, url, secret) {
  const results = [];
  for (const event of events) {
    const payload = JSON.stringify({ ...event, step: undefined }); // undefined keys are not serialized
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": signature(payload, secret), "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks) via Tera replay" },
      body: payload,
    });
    results.push({ id: event.id, type: event.type, status: res.status });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, url] = process.argv.slice(2);
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!file || !url || !secret?.startsWith("whsec_")) {
    console.error("usage: STRIPE_WEBHOOK_SECRET=whsec_... node replay-webhooks.mjs <stripe-webhooks.json> <endpoint url>");
    process.exit(2);
  }
  const results = await replay(JSON.parse(readFileSync(file, "utf8")), url, secret);
  for (const r of results) console.log(`${r.status} ${r.type} ${r.id}`);
  process.exitCode = results.every((r) => r.status >= 200 && r.status < 300) ? 0 : 1;
}
