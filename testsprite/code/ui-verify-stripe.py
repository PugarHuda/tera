import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Simulator: 'Verify in Stripe' replays an edited timeline ...":
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

        # @@ts-step {"i": 1, "type": "action", "action": "act", "selector": null, "desc": "await page.goto(APP + \"/simulator\")", "input": null, "field": null}
        await page.goto(APP + "/simulator")
        # @@ts-step {"i": 2, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_test_id(\"scenario-select\").select_option(\"S01\")", "input": null, "field": null}
        await page.get_by_test_id("scenario-select").select_option("S01")
        # @@ts-step {"i": 3, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"golden-badge\")).to_contain_text(\"Matches golden expected\")", "input": null, "field": null}
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        # @@ts-step {"i": 4, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_label(\"Event 1 quantity\").fill(\"2\")", "input": null, "field": null}
        await page.get_by_label("Event 1 quantity").fill("2")
        # @@ts-step {"i": 5, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_label(\"Event 1 quantity\").blur()", "input": null, "field": null}
        await page.get_by_label("Event 1 quantity").blur()
        # @@ts-step {"i": 6, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"golden-badge\")).to_have_count(0)  # an edited timeline is no longer a golden one", "input": null, "field": null}
        await expect(page.get_by_test_id("golden-badge")).to_have_count(0)  # an edited timeline is no longer a golden one
        # @@ts-step {"i": 7, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_test_id(\"verify-stripe\").click()", "input": null, "field": null}
        await page.get_by_test_id("verify-stripe").click()
        check = page.get_by_test_id("stripe-check")
        # @@ts-step {"i": 8, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(check).to_contain_text(\"Matches Stripe\", timeout=150000)", "input": null, "field": null}
        await expect(check).to_contain_text("Matches Stripe", timeout=150000)
        # @@ts-step {"i": 9, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(check).to_contain_text(re.compile(r\"clock_\\w+\"))", "input": null, "field": null}
        await expect(check).to_contain_text(re.compile(r"clock_\w+"))

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
