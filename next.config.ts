import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// No nonces (they would make every page dynamic). vercel.live is the toolbar on preview deployments.
// Framing is limited to this app and TestSprite's dashboard (clickjacking protection).
const csp = `
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://vercel.live${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data: https://vercel.live https://vercel.com;
  font-src 'self' https://vercel.live;
  connect-src 'self' https://vercel.live wss://ws-us3.pusher.com;
  frame-src https://vercel.live;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'self' https://testsprite.com https://*.testsprite.com;
  upgrade-insecure-requests;
`.replace(/\s{2,}/g, " ").trim();

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The simulator lived at / before the landing page: shared links (?t= timeline, ?s= scenario, ?c= catalog) still open
  // it, with their query passed through.
  async redirects() {
    return ["t", "s", "c"].map((key) => ({ source: "/", has: [{ type: "query" as const, key }], destination: "/simulator", permanent: true }));
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The REST API is public and cookie-less, so any origin may call it from a browser.
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "content-type, mcp-protocol-version, mcp-session-id" },
          { key: "Access-Control-Expose-Headers", value: "retry-after, mcp-session-id" },
        ],
      },
      // /reference serves Scalar from a CDN and sets its own CSP.
      { source: "/((?!reference).*)", headers: [{ key: "Content-Security-Policy", value: csp }] },
    ];
  },
};

export default nextConfig;
