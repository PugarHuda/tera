import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { pushCatalog } from "./stripe-parity";

// A Stripe account that already has every price, and enforces Stripe's limit of 10 lookup_keys per list call (a catalog
// of 11 prices failed to push with a 400 on lookup_keys before the keys were chunked).
function account() {
  const created: string[] = [];
  const stripe = {
    prices: {
      list: async ({ lookup_keys }: { lookup_keys: string[] }) => {
        if (lookup_keys.length > 10) throw new Error("Invalid array: lookup_keys must have at most 10 elements");
        return { data: lookup_keys.map((k) => ({ id: `price_${k}`, lookup_key: k })) };
      },
      create: async (p: { lookup_key: string }) => (created.push(p.lookup_key), { id: `price_new_${p.lookup_key}` }),
    },
    taxRates: { list: async () => ({ data: [] }) },
  } as unknown as Stripe;
  return { stripe, created };
}

describe("pushCatalog", () => {
  it("finds existing prices of a catalog with more than 10 prices, ten lookup keys at a time", async () => {
    const { stripe, created } = account();
    const prices = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`p${i}`, { currency: "usd", unit_amount: 100 + i, interval: "month" as const }]));
    const ids = await pushCatalog(stripe, { prices });
    expect(Object.keys(ids.prices)).toHaveLength(23);
    expect(Object.values(ids.prices).every((id) => id.startsWith("price_tera_"))).toBe(true);
    expect(created).toEqual([]);
  });
});
