import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Migration planner: default $29 -> $39 ...":
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

        # @@ts-step {"i": 1, "type": "action", "action": "act", "selector": null, "desc": "await page.goto(APP + \"/migrate\")", "input": null, "field": null}
        await page.goto(APP + "/migrate")
        # @@ts-step {"i": 2, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_role(\"heading\", name=\"Price migration planner\")).to_be_visible()", "input": null, "field": null}
        await expect(page.get_by_role("heading", name="Price migration planner")).to_be_visible()
        # @@ts-step {"i": 3, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"affected\")).to_have_text(\"3\")", "input": null, "field": null}
        await expect(page.get_by_test_id("affected")).to_have_text("3")
        # @@ts-step {"i": 4, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"mrr-before\")).to_have_text(\"$145.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("mrr-before")).to_have_text("$145.00")
        # @@ts-step {"i": 5, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"mrr-after\")).to_have_text(\"$195.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("mrr-after")).to_have_text("$195.00")
        # @@ts-step {"i": 6, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"mrr-delta\")).to_have_text(\"+$50.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("mrr-delta")).to_have_text("+$50.00")

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
