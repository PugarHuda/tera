import type { MetadataRoute } from "next";

export const SITE = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "tera-orpin-three.vercel.app"}`;

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/simulator", "/builder", "/migrate", "/parity", "/reference", "/mcp-setup", "/llms.txt"].map((p) => ({ url: SITE + p }));
}
