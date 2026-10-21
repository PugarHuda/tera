// Interactive API reference rendered by Scalar from our own OpenAPI document (with a "try it" client).
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tera API reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.75.0/dist/browser/standalone.js"></script>
    <script>
      // Tera's accent, and muted text / method badges darkened to WCAG AA contrast (axe flagged Scalar's defaults).
      const customCss = ".light-mode{--scalar-color-accent:#b31004;--scalar-color-3:#6b6b6b;--scalar-color-green:#047857}.dark-mode{--scalar-color-accent:#f6a04a;--scalar-color-3:#9a9a9a}";
      Scalar.createApiReference("#app", { url: "/api/openapi.json", theme: "default", hideClientButton: false, customCss });
      // Scalar's scrolling code and schema blocks cannot take keyboard focus (axe scrollable-region-focusable).
      new MutationObserver(() => document.querySelectorAll(".overflow-x-auto:not([tabindex])").forEach((e) => (e.tabIndex = 0))).observe(document.body, { childList: true, subtree: true });
    </script>
  </body>
</html>`;

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.scalar.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function GET() {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp } });
}
