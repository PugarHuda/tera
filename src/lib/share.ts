// FR6: a timeline travels in the URL as base64url(JSON), so a shared link replays the exact same invoices.
import type { TimelineEvent } from "./billing";
import { parseTimeline } from "./validate";

export function encodeTimeline(timeline: TimelineEvent[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(timeline));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Server-side only. Returns null for anything that is not a valid timeline (never trust a URL).
export function decodeTimeline(t: string): TimelineEvent[] | null {
  try {
    return parseTimeline(JSON.parse(Buffer.from(t, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}
