import { formatMoney, simulate } from "@/lib/billing";
import { badRequest, methodNotAllowed, preflight, parseCatalog, parseLocale, parseTimeline, readJson } from "@/lib/validate";

export const GET = methodNotAllowed("POST");
export const OPTIONS = preflight("POST");
export { GET as PUT, GET as PATCH, GET as DELETE };

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const catalog = parseCatalog(body?.catalog);
    const timeline = parseTimeline(body?.timeline);
    const locale = parseLocale(body?.locale);
    const result = simulate(catalog, timeline);
    return Response.json({
      ...result,
      invoices: result.invoices.map((i) => ({ ...i, total_display: formatMoney(i.total, i.currency, locale) })),
    });
  } catch (e) {
    return badRequest(e);
  }
}
