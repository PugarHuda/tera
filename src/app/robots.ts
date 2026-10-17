import type { MetadataRoute } from "next";
import { SITE } from "./sitemap";

export default function robots(): MetadataRoute.Robots {
  // The API is public but not content; live Stripe replays should never be crawled.
  return { rules: { userAgent: "*", allow: "/", disallow: "/api/" }, sitemap: `${SITE}/sitemap.xml` };
}
