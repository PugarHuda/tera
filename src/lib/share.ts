// FR6: timelines (and custom catalogs) travel in the URL as base64url(JSON), so a shared link replays the exact same invoices.
import type { Catalog, TimelineEvent } from "./billing";
import { parseCatalog, parseTimeline } from "./validate";

export function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  // Spreading every byte into fromCharCode overflows the call stack on long timelines; go in chunks.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const encodeTimeline = (timeline: TimelineEvent[]) => encodeJson(timeline);
export const encodeCatalog = (catalog: Catalog) => encodeJson(catalog);

const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// Server-side only. Return null for anything that does not validate (never trust a URL).
export function decodeTimeline(t: string): TimelineEvent[] | null {
  try {
    return parseTimeline(decode(t));
  } catch {
    return null;
  }
}

export function decodeCatalog(c: string): Catalog | null {
  try {
    return parseCatalog(decode(c));
  } catch {
    return null;
  }
}
