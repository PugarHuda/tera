// Real-user E2E journeys: every step is a click, keyboard typing, a dropdown pick, a file pick or a download,
// never a URL with the answer in it or a value set behind the UI. Expected amounts are hand-derived in the comments.
// Usage: node e2e/user-journeys.mjs <base-url> [video-dir]   (CI: .github/workflows/e2e.yml on every Vercel preview)
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const B = process.argv[2] ?? process.env.BASE_URL;
const out = process.argv[3] ?? mkdtempSync(join(tmpdir(), "tera-e2e-"));
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails++; };
const b = await chromium.launch({ slowMo: 40, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const ctx = await b.newContext({ locale: "en-US", acceptDownloads: true, viewport: { width: 1280, height: 800 }, recordVideo: { dir: out, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const type = async (loc, text) => { await loc.click(); await page.keyboard.press("Control+A"); await page.keyboard.type(text, { delay: 25 }); };
const typeDate = async (loc, mmddyyyy) => { await loc.focus(); await page.keyboard.type(mmddyyyy, { delay: 25 }); };
const total = (n) => page.getByTestId(`invoice-${n}-total`).innerText();
const invoices = () => page.locator("li[data-testid^=invoice-]").count();
// Re-reads the count each time: hydration can re-render the timeline after a first count (a stale "Delete event 6"
// timed out in CI once).
const clearTimeline = async () => {
  await page.getByLabel("Event 1 date").waitFor();
  for (let n; (n = await page.locator("[aria-label^='Delete event']").count()) > 1; ) await page.getByLabel(`Delete event ${n}`).click();
};

// J1 — build a flexible, fixed-billing-day timeline from scratch in the simulator.
// A visitor lands on the landing page, whose hero invoice and numbers are computed, and opens the simulator from it.
await page.goto(B);
ok((await page.getByTestId("landing-invoice").innerText()).includes("$103.20"), "landing hero shows S05's computed upgrade invoice ($103.20)");
ok(/\d+ \/ \d+/.test(await page.getByTestId("proof").innerText()), "landing shows the Stripe parity count");
await page.getByTestId("landing-cta").click();
await page.waitForURL(/\/simulator$/);
await clearTimeline();
await typeDate(page.getByLabel("Event 1 date"), "02102027");
await page.getByLabel("Event 1 price").selectOption("pro_m");
await type(page.getByLabel("Event 1 quantity"), "2");
await page.getByLabel("Event 1 billing_mode").selectOption("flexible");
await typeDate(page.getByLabel("Event 1 billing_cycle_anchor"), "03052027");
// Stub 02-10 -> 03-05 over 02-05 -> 03-05: round(15800*23/28) = 12979.
ok((await total(1)).includes("$129.79"), `stub invoice $129.79 (${await total(1)})`);
await page.getByRole("button", { name: "+ Add event" }).click();
await page.getByLabel("Event 2 type").selectOption("change_quantity");
await typeDate(page.getByLabel("Event 2 date"), "03202027");
await type(page.getByLabel("Event 2 quantity"), "5");
await page.getByRole("button", { name: "+ Add event" }).click();
// 03-05: 15800. 03-20 x5 (16 of 31 days left): credit -round(15800*16/31) = -8155, debit round(39500*16/31) = 20387.
// 04-05: -8155 + 20387 + 39500 = 51732.
ok((await invoices()) === 3, `3 invoices (${await invoices()})`);
ok((await total(2)).includes("$158.00") && (await total(3)).includes("$517.32"), `03-05 $158.00, 04-05 $517.32 (${await total(2)}, ${await total(3)})`);

await page.getByRole("button", { name: "Copy share link" }).click();
const shareUrl = await page.getByTestId("share-url").inputValue();
const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-invoices").click()]);
const csv = readFileSync(await dl.path(), "utf8");
ok(csv.includes("51732") && csv.includes("12979"), "CSV export has the stub and the 04-05 total in minor units");
await page.getByTestId("locale-select").selectOption("de-DE");
ok((await total(3)).replace(/\s/g, " ").includes("517,32"), `de-DE shows 517,32 (${await total(3)})`);

const tab = await ctx.newPage();
await tab.goto(shareUrl);
ok((await tab.getByTestId("invoice-3-total").innerText()).includes("$517.32") && (await tab.getByLabel("Event 1 billing_mode").inputValue()) === "flexible", "shared link reopens the same flexible timeline");
// Links shared before the landing page pointed at /?t=…, /?s=…: they still open the simulator.
await tab.goto(shareUrl.replace("/simulator?", "/?"));
ok(new URL(tab.url()).pathname === "/simulator" && (await tab.getByTestId("invoice-3-total").innerText()).includes("$517.32"), `an old /?t= share link redirects to the simulator (${tab.url().slice(0, 80)})`);
await tab.goto(B + "/?s=S74");
ok(new URL(tab.url()).pathname === "/simulator" && (await tab.getByTestId("scenario-select").inputValue()) === "S74", "an old /?s=S74 link opens S74 in the simulator");
await tab.close();

await page.getByTestId("verify-stripe").click();
await page.getByTestId("stripe-check").waitFor({ timeout: 180000 });
const v = (await page.getByTestId("stripe-check").innerText()).replace(/\s+/g, " ");
ok(/matches stripe/i.test(v), `Verify in Stripe: ${v.slice(0, 100)}`);
ok(/webhooks match/i.test(v), `Verify in Stripe compares webhooks too: ${v.slice(-120)}`);
// The events the test clock sent, downloaded with their full Stripe payloads (fixtures for a webhook handler).
const [hookFile] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-stripe-webhooks").click()]);
const sentEvents = JSON.parse(readFileSync(await hookFile.path(), "utf8"));
ok(sentEvents.length > 0 && sentEvents.every((e) => /^evt_/.test(e.id) && e.data.object.id) && sentEvents.some((e) => e.type === "invoice.paid" && e.data.object.object === "invoice"),
  `downloaded ${sentEvents.length} real Stripe events with payloads (${[...new Set(sentEvents.map((e) => e.type))].join(", ").slice(0, 120)})`);

// FR10 — the webhook events Stripe sends, per timeline event. Event 2's step: the 03-05 renewal (invoice created, finalized,
// paid; subscription updated), then the seat change: a credit and a charge as two invoice items, and the update.
await page.getByText(/Webhook events Stripe sends \(\d+\)/).click();
const hooks2 = await page.getByTestId("webhooks-2").innerText();
ok((hooks2.match(/invoiceitem\.created/g) ?? []).length === 2 && (hooks2.match(/customer\.subscription\.updated/g) ?? []).length === 2 && /2027-03-05 invoice\.paid → invoice \d+/.test(hooks2) && /customer\.subscription\.updated \(active\)/.test(hooks2),
  `webhooks for event 2: 2 invoice items, renewal paid 03-05 naming its invoice, 2 subscription updates (active) (${hooks2.replace(/\s+/g, " ").slice(0, 200)})`);

// J1b — pause and resume a flexible subscription (R21, Stripe API 2026-09-30.endive), all by picking from dropdowns.
await page.getByRole("link", { name: "Simulator" }).click();
await clearTimeline();
await page.getByTestId("locale-select").selectOption("en-US");
await page.getByLabel("Event 1 billing_cycle_anchor").fill(""); // J1 left a first billing date on it
await typeDate(page.getByLabel("Event 1 date"), "01012027");
await page.getByLabel("Event 1 price").selectOption("pro_m");
await type(page.getByLabel("Event 1 quantity"), "1");
await page.getByLabel("Event 1 billing_mode").selectOption("flexible");
await page.getByRole("button", { name: "+ Add event" }).click();
await page.getByLabel("Event 2 type").selectOption("pause");
await typeDate(page.getByLabel("Event 2 date"), "01162027");
await page.getByRole("button", { name: "+ Add event" }).click(); // 30 days later: 02-15
await page.getByLabel("Event 3 type").selectOption("resume");
await page.getByRole("button", { name: "+ Add event" }).click(); // advance to 03-17
// 01-16 pause: credit -round(7900*16/31) = -4077, pending; 02-15 resume restarts the cycle: 7900 - 4077 = 3823; 03-15: 7900.
ok((await invoices()) === 3 && (await total(2)).includes("$38.23") && (await total(3)).includes("$79.00"), `paused, resumed: 3 invoices, $38.23 then $79.00 (${await invoices()}: ${await total(2)}, ${await total(3)})`);
await page.getByLabel("Event 2 proration_behavior").selectOption("always_invoice");
// invoicing_behavior invoice: the credit is its own invoice on 01-16.
ok((await invoices()) === 4 && (await total(2)).includes("-$40.77"), `pause credit invoiced now: -$40.77 (${await total(2)})`);

// J1c — a trial that ends without a card (R22): paused at trial end, resumed later on the old anchor.
await clearTimeline();
await page.getByLabel("Event 1 type").selectOption("start_trial");
await typeDate(page.getByLabel("Event 1 date"), "01102027");
await page.getByLabel("Event 1 price").selectOption("starter_m");
await type(page.getByLabel("Event 1 trial_days"), "14");
await page.getByLabel("Event 1 billing_mode").selectOption(""); // classic
await page.getByLabel("Event 1 trial_end_behavior").selectOption("pause");
await page.getByRole("button", { name: "+ Add event" }).click();
await page.getByLabel("Event 2 type").selectOption("resume");
await typeDate(page.getByLabel("Event 2 date"), "02032027");
await page.getByLabel("Event 2 billing_cycle_anchor").selectOption("unchanged");
await page.getByRole("button", { name: "+ Add event" }).click();
await typeDate(page.getByLabel("Event 3 date"), "04012027");
// Trial ends 01-24 into a pause (no invoice). Resume 02-03, anchor 01-24 kept: 21 of 31 days, round(2900*21/31) = 1965,
// billed with the 02-24 renewal: 4865. 03-24: 2900. Verified in Stripe as S97.
ok((await invoices()) === 3 && (await total(2)).includes("$48.65") && (await total(3)).includes("$29.00"), `trial without a card paused, resumed: $48.65 then $29.00 (${await invoices()}: ${await total(2)}, ${await total(3)})`);
await page.getByLabel("Delete event 2").click();
await page.getByLabel("Event 1 trial_end_behavior").selectOption("cancel");
ok((await invoices()) === 1 && (await total(1)).includes("$0.00"), `trial without a card, cancel: only the $0 trial invoice (${await invoices()})`);

// J1d — a customer balance credit (R23) lowers the next invoice's amount due.
await page.getByLabel("Event 1 trial_end_behavior").selectOption(""); // the trial now ends into a paid period on 01-24
await page.getByLabel("Event 2 type").selectOption("adjust_balance");
await typeDate(page.getByLabel("Event 2 date"), "02012027");
await type(page.getByLabel("Event 2 amount"), "-1000");
await page.getByRole("button", { name: "+ Add event" }).click(); // advance to 03-03
// 01-24: 2900. 02-01 credit -1000. 02-24 renewal 2900 starts from -1000: $19.00 due. Verified in Stripe as S103's rule.
ok((await page.getByTestId("invoice-3-amount-due").innerText()).includes("$19.00"), `balance credit: 02-24 amount due $19.00 (${await page.getByTestId("invoice-3-amount-due").innerText()})`);

// J2 — Pricing builder: add a price by typing, simulate with it.
await page.getByRole("link", { name: "Builder" }).click();
await page.getByRole("button", { name: "+ Add price" }).click();
const n = await page.locator("[data-testid^=price-row-][data-testid$=-preview]").count();
await type(page.getByLabel(`Price ${n} id`), "growth_m");
await type(page.getByLabel(`Price ${n} amount`), "49.50");
ok((await page.getByTestId(`price-row-${n - 1}-preview`).innerText()).includes("49.50"), "builder preview shows $49.50");
await page.getByTestId("simulate-catalog").click();
await page.getByTestId("custom-catalog-banner").waitFor();
await page.getByLabel("Event 1 price").selectOption("growth_m");
ok((await total(1)).includes("$49.50"), `custom price bills $49.50 (${await total(1)})`);

// J2b — Import the connected Stripe test account's catalog into the builder and simulate on it.
await page.getByRole("link", { name: "Builder" }).click();
if (await page.getByTestId("pull-stripe").count()) {
  await page.getByTestId("pull-stripe").click();
  await page.getByTestId("pull-note").filter({ hasText: /Imported|Stripe:/ }).waitFor({ timeout: 30_000 });
  const note = await page.getByTestId("pull-note").innerText();
  ok(/^Imported \d+ prices, \d+ coupons and \d+ tax rates from Stripe/.test(note), `Stripe catalog import: ${note}`);
  ok(await page.getByTestId("builder-valid").isVisible(), "imported catalog is valid");
  await page.getByTestId("simulate-catalog").click();
  await page.getByTestId("custom-catalog-banner").waitFor();
  await page.getByLabel("Event 1 price").selectOption("team_seat_m");
  ok((await total(1)).includes("$12.00"), `Stripe's team_seat_m bills $12.00 a seat (${await total(1)})`);
} else console.log("SKIP J2b: no test-mode Stripe key on this deployment");

// J3 — Migration planner: type prices and seats, grandfather toggle, CSV file pick.
await page.getByRole("link", { name: "Migration" }).click();
await type(page.getByLabel("Current price (USD)"), "10");
await type(page.getByLabel("New price (USD)"), "12");
await type(page.getByRole("textbox", { name: /Customer base/ }), "3, 5, 2");
// 10 seats: $100.00 -> $120.00, +$20.00, 3 affected.
ok((await page.getByTestId("mrr-before").innerText()) === "$100.00" && (await page.getByTestId("mrr-after").innerText()) === "$120.00", "MRR $100.00 -> $120.00");
ok((await page.getByTestId("affected").innerText()) === "3", "3 customers affected");
await page.getByLabel(/Grandfather existing customers/).check();
ok((await page.getByTestId("affected").innerText()) === "0", "grandfathering affects 0");
await page.getByLabel(/Grandfather existing customers/).uncheck();
const f = out + "/customers.csv"; writeFileSync(f, "name,seats\nacme,4\nglobex,6\n");
await page.getByTestId("csv-file").setInputFiles(f);
ok((await page.getByTestId("per-customer").innerText()).includes("globex"), "CSV import lists globex");

// J3b — Import the customer base from the connected Stripe test account (scripts/seed-migration-demo.mts):
// the per-seat team_seat_m price's live subscriptions, 96 seats at $12.00.
if (await page.getByTestId("stripe-import").count()) {
  await page.getByTestId("stripe-import").click();
  const select = page.getByTestId("stripe-price");
  await select.waitFor();
  const seat = await select.locator("option", { hasText: "Tera team_seat_m · $12.00 / month" }).first().getAttribute("value");
  await select.selectOption(seat);
  await page.getByTestId("stripe-note").filter({ hasText: "Imported" }).waitFor({ timeout: 30_000 });
  const note = await page.getByTestId("stripe-note").innerText();
  ok(/Imported \d+ subscriptions on price_/.test(note), `Stripe import: ${note}`);
  ok((await page.getByTestId("per-customer").innerText()).includes("Umbrella Corp"), "Stripe import lists Umbrella Corp (40 seats)");
  ok((await page.getByTestId("mrr-before").innerText()) === "$1,152.00", `Stripe base MRR $1,152.00 (${await page.getByTestId("mrr-before").innerText()})`);
} else console.log("SKIP J3b: no test-mode Stripe key on this deployment");

// J4 — Parity evidence.
await page.getByRole("link", { name: "Stripe parity" }).click();
const summary = await page.getByTestId("parity-summary").innerText();
ok(/^(\d+) \/ \1 scenarios match Stripe/.test(summary), `parity summary: ${summary}`);
await page.getByTestId("parity-S74").getByRole("button", { expanded: false }).first().click();
const row = await page.getByTestId("parity-S74").innerText();
ok((row.match(/\$64\.89/g) ?? []).length >= 2, "S74 expanded: Tera and Stripe both bill the $64.89 stub");
ok(/clock_\w+/.test(await page.getByTestId("parity-S74-evidence").innerText()), "S74 evidence names its Stripe test clock and invoices");

// J5 — API reference and MCP pages.
await page.getByRole("link", { name: "MCP" }).click();
ok((await page.getByTestId("mcp-tools").innerText()).includes("simulate_timeline"), "MCP page lists simulate_timeline");
await page.getByRole("link", { name: "API" }).click();
await page.getByText("POST").first().waitFor({ timeout: 30000 });
ok(/Tera/i.test(await page.title()), `API reference renders (${await page.title()})`);

// J6 — Accessibility: axe-core (WCAG 2.2 AA) on every page and on states a page-load audit never sees (validation
// errors, an imported Stripe catalog, the Stripe price picker, an expanded parity row), in light and dark mode.
// It found the builder's red-600 error text at 4.4:1 on the card background.
for (const colorScheme of ["light", "dark"]) {
  const p = await (await b.newContext({ colorScheme, locale: "en-US" })).newPage();
  const scan = async (label) => {
    const { violations } = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    ok(violations.length === 0, `axe ${colorScheme} ${label}: ${violations.map((v) => `${v.id} ×${v.nodes.length} (${v.nodes[0].target.join(" ")})`).join(", ") || "no WCAG AA violations"}`);
  };
  await p.goto(B); await p.getByTestId("landing-cta").waitFor(); await scan("landing");
  await p.goto(B + "/simulator"); await p.getByTestId("invoice-1-total").waitFor(); await scan("simulator");
  await p.getByLabel("Event 1 quantity").fill("0"); await p.getByRole("alert").first().waitFor(); await scan("simulator, invalid quantity");
  await p.goto(B + "/builder"); await p.getByTestId("builder-valid").waitFor(); await scan("builder");
  await p.getByLabel("Price 1 amount").fill("abc"); await p.getByTestId("builder-error").waitFor(); await scan("builder, invalid amount");
  if (await p.getByTestId("pull-stripe").count()) {
    await p.getByTestId("pull-stripe").click(); await p.getByTestId("pull-note").waitFor({ timeout: 30_000 }); await scan("builder, Stripe catalog imported");
  }
  await p.goto(B + "/migrate"); await p.getByTestId("mrr-before").waitFor(); await scan("migration planner");
  if (await p.getByTestId("stripe-import").count()) {
    await p.getByTestId("stripe-import").click(); await p.getByTestId("stripe-price").waitFor({ timeout: 30_000 }); await scan("migration planner, Stripe prices");
  }
  await p.goto(B + "/parity"); await p.getByTestId("parity-summary").waitFor();
  await p.getByTestId("parity-S74").getByRole("button", { expanded: false }).first().click(); await scan("parity, S74 expanded");
  await p.goto(B + "/mcp-setup"); await p.getByTestId("mcp-tools").waitFor(); await scan("MCP setup");
  // Scalar's default muted text and POST badges were 3.2-4.4:1 (fixed with customCss in src/app/reference/route.ts).
  await p.goto(B + "/reference"); await p.locator(".sidebar-heading-type").first().waitFor({ timeout: 30_000 }); await scan("API reference");
  await p.context().close();
}

// J7 — Small screens and keyboard: no page scrolls sideways at 320 px (the event-type select once pushed the
// simulator to 425 px), and every Tab stop shows a focus indicator (date inputs once showed none).
{
  const p = await (await b.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true })).newPage();
  for (const [path, ready] of [["/", "landing-cta"], ["/simulator", "invoice-1-total"], ["/builder", "builder-valid"], ["/migrate", "mrr-before"], ["/parity", "parity-summary"], ["/mcp-setup", "mcp-tools"]]) {
    await p.goto(B + path); await p.getByTestId(ready).waitFor();
    const [sw, w] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    ok(sw <= w, `320 px: ${path} does not scroll sideways (${sw} / ${w})`);
  }
  await p.context().close();
  const k = await (await b.newContext({ locale: "en-US" })).newPage();
  for (const [path, ready] of [["/", "landing-cta"], ["/simulator", "invoice-1-total"], ["/builder", "builder-valid"], ["/migrate", "mrr-before"]]) {
    await k.goto(B + path); await k.getByTestId(ready).waitFor();
    const unseen = [];
    for (let i = 0; i < 50; i++) {
      await k.keyboard.press("Tab");
      const f = await k.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const s = getComputedStyle(e);
        return { name: e.getAttribute("aria-label") ?? e.textContent?.trim().slice(0, 24) ?? e.tagName, shown: (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none" };
      });
      if (!f) break;
      if (!f.shown) unseen.push(f.name);
    }
    ok(unseen.length === 0, `keyboard: every Tab stop on ${path} shows focus${unseen.length ? ` (not: ${unseen.slice(0, 5).join(", ")})` : ""}`);
  }
  await k.context().close();
}

await ctx.close(); await b.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exitCode = fails ? 1 : 0;
