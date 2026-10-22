import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Pricing builder: JPY rejects decimals ...":
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

        # @@ts-step {"i": 1, "type": "action", "action": "act", "selector": null, "desc": "await page.goto(APP + \"/builder\")", "input": null, "field": null}
        await page.goto(APP + "/builder")
        # @@ts-step {"i": 2, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_role(\"button\", name=\"Reset to reference catalog\").click()", "input": null, "field": null}
        await page.get_by_role("button", name="Reset to reference catalog").click()
        # @@ts-step {"i": 3, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"builder-valid\")).to_contain_text(\"Catalog is valid: 10 prices, 4 coupons, 2 tax rates.\")", "input": null, "field": null}
        await expect(page.get_by_test_id("builder-valid")).to_contain_text("Catalog is valid: 10 prices, 4 coupons, 2 tax rates.")
        # @@ts-step {"i": 4, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_label(\"Price 1 currency\").select_option(\"jpy\")", "input": null, "field": null}
        await page.get_by_label("Price 1 currency").select_option("jpy")
        # @@ts-step {"i": 5, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_label(\"Price 1 amount\").fill(\"29.5\")", "input": null, "field": null}
        await page.get_by_label("Price 1 amount").fill("29.5")
        # @@ts-step {"i": 6, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"builder-error\")).to_contain_text(\"starter_m: JPY has no minor unit, so the amount cannot have decimals\")", "input": null, "field": null}
        await expect(page.get_by_test_id("builder-error")).to_contain_text("starter_m: JPY has no minor unit, so the amount cannot have decimals")
        # @@ts-step {"i": 7, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_label(\"Price 1 amount\").fill(\"4500\")", "input": null, "field": null}
        await page.get_by_label("Price 1 amount").fill("4500")
        # @@ts-step {"i": 8, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_label(\"Price 1 id\").fill(\"starter_jpy\")", "input": null, "field": null}
        await page.get_by_label("Price 1 id").fill("starter_jpy")
        # @@ts-step {"i": 9, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"builder-error\")).to_have_count(0)", "input": null, "field": null}
        await expect(page.get_by_test_id("builder-error")).to_have_count(0)
        # @@ts-step {"i": 10, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_test_id(\"simulate-catalog\").click()", "input": null, "field": null}
        await page.get_by_test_id("simulate-catalog").click()
        # @@ts-step {"i": 11, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_text(\"Using a custom catalog from the Pricing Builder\")).to_be_visible()", "input": null, "field": null}
        await expect(page.get_by_text("Using a custom catalog from the Pricing Builder")).to_be_visible()
        # @@ts-step {"i": 12, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"scenario-select\")).to_have_count(0)", "input": null, "field": null}
        await expect(page.get_by_test_id("scenario-select")).to_have_count(0)
        # @@ts-step {"i": 13, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-1-total\")).to_have_text(\"\u00a54,500\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-1-total")).to_have_text("¥4,500")

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
