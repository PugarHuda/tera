import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "MCP setup page lists the live tools served by /api/mcp":
# every step asserts exact values instead of leaving the outcome to the run-time AI judge.

APP = "https://tera-orpin-three.vercel.app"


async def invoice_totals(page):
    return await page.locator("[data-testid^=invoice-][data-testid$=-total]").all_inner_texts()


async def event_index(page, value):
    """1-based number of the first timeline event whose type select has this value."""
    values = await page.locator("select[aria-label^='Event '][aria-label$=' type']").evaluate_all("els => els.map(e => e.value)")
    assert value in values, f"no {value} event in {values}"
    return values.index(value) + 1


async def run_test():
    pw = None
    browser = None
    context = None

    try:
        pw = await async_api.async_playwright().start()
        browser = await pw.chromium.launch(headless=True, args=["--window-size=1280,720", "--disable-dev-shm-usage", "--ipc=host", "--single-process"])
        context = await browser.new_context()
        context.set_default_timeout(15000)
        page = await context.new_page()

        # @@ts-step {"i": 1, "type": "action", "action": "act", "selector": null, "desc": "await page.goto(APP)", "input": null, "field": null}
        await page.goto(APP)
        # @@ts-step {"i": 2, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_role(\"link\", name=\"MCP\", exact=True).click()", "input": null, "field": null}
        await page.get_by_role("link", name="MCP", exact=True).click()
        tools = page.get_by_test_id("mcp-tools")
        for name in ["simulate_timeline", "verify_timeline_in_stripe", "plan_price_migration", "plan_stripe_price_migration", "import_stripe_catalog",
                     "push_catalog_to_stripe", "create_share_link", "list_golden_scenarios", "get_golden_scenario", "get_parity_evidence"]:
            # @@ts-step {"i": 3, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(tools).to_contain_text(name)", "input": null, "field": null}
            await expect(tools).to_contain_text(name)
        # @@ts-step {"i": 4, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_text(\"claude mcp add --transport http tera\").first).to_be_visible()", "input": null, "field": null}
        await expect(page.get_by_text("claude mcp add --transport http tera").first).to_be_visible()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
