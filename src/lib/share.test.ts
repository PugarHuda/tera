import { expect, it } from "vitest";
import golden from "../../golden/scenarios.json";
import type { TimelineEvent } from "./billing";
import { decodeTimeline, encodeTimeline } from "./share";

it("round-trips every golden timeline through a share link", () => {
  for (const s of golden.scenarios as Array<{ timeline?: TimelineEvent[] }>)
    if (s.timeline) expect(decodeTimeline(encodeTimeline(s.timeline))).toEqual(s.timeline);
});

it("rejects tampered or garbage links instead of throwing", () => {
  expect(decodeTimeline("not-base64-json")).toBeNull();
  expect(decodeTimeline(Buffer.from('[{"at":"x","type":"subscribe"}]').toString("base64url"))).toBeNull();
});
