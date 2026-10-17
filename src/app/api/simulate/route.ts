import { formatMoney, simulate } from "@/lib/billing";
import { badRequest, parseCatalog, parseTimeline } from "@/lib/validate";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const catalog = parseCatalog(body?.catalog);
    const timeline = parseTimeline(body?.timeline);
    const locale = typeof body?.locale === "string" ? body.locale : "en-US";
    const result = simulate(catalog, timeline);
    return Response.json({
      ...result,
      invoices: result.invoices.map((i) => ({ ...i, total_display: formatMoney(i.total, i.currency, locale) })),
    });
  } catch (e) {
    return badRequest(e);
  }
}
