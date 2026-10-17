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
      Scalar.createApiReference("#app", { url: "/api/openapi.json", theme: "default", hideClientButton: false });
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
