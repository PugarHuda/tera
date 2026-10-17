import { describe, expect, it } from "vitest";
import golden from "../../golden/scenarios.json";
import type { Catalog, TimelineEvent } from "./billing";
import { decodeCatalog, decodeTimeline, encodeCatalog, encodeJson, encodeTimeline } from "./share";

it("round-trips every golden timeline through a share link", () => {
  for (const s of golden.scenarios as Array<{ timeline?: TimelineEvent[] }>)
    if (s.timeline) expect(decodeTimeline(encodeTimeline(s.timeline))).toEqual(s.timeline);
});

it("rejects tampered or garbage links instead of throwing", () => {
  expect(decodeTimeline("not-base64-json")).toBeNull();
  expect(decodeTimeline(Buffer.from('[{"at":"x","type":"subscribe"}]').toString("base64url"))).toBeNull();
});

describe("custom catalogs in links", () => {
  const catalog = golden.catalog as unknown as Catalog;
  it("round-trips a catalog", () => expect(decodeCatalog(encodeCatalog(catalog))).toEqual(catalog));
  it("rejects invalid catalogs instead of trusting the URL", () => {
    expect(decodeCatalog(encodeJson({ prices: {} }))).toBeNull();
    expect(decodeCatalog(encodeJson({ prices: { "bad id!": { currency: "usd", unit_amount: 100, interval: "month" } } }))).toBeNull();
    expect(decodeCatalog(encodeJson({ prices: { p: { currency: "usd", unit_amount: -5, interval: "month" } } }))).toBeNull();
  });
});
