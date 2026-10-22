// Unknown /api paths answer JSON like the rest of the API, not the HTML 404 page. The routes next to this one win.
const notFound = (req: Request) =>
  Response.json({ error: `No API route ${new URL(req.url).pathname}; see /api/openapi.json` }, { status: 404 });
export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE, notFound as OPTIONS };
