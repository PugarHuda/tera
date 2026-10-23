import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Simulator: one-off charges bill with the renewal, discounted and taxed; a coupon never discounts a one-off credit (S133, S137)":
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
        # @@ts-step {"i": 2, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_test_id(\"scenario-select\").select_option(\"S133\")", "input": null, "field": null}
        await page.get_by_test_id("scenario-select").select_option("S133")
        # @@ts-step {"i": 3, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"golden-badge\")).to_contain_text(\"Matches golden expected\")", "input": null, "field": null}
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        # S133 by hand: FOREVER25 and tax10_ex. 01-01: 7900 - 1975 = 5925, tax 592.5 -> 593, total 6518.
        # @@ts-step {"i": 4, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-1-total\")).to_have_text(\"$65.18\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-1-total")).to_have_text("$65.18")
        # 02-01: the 1000 item joins the 7900 renewal: 8900 - 2225 = 6675, tax 667.5 -> 668, total 7343.
        # @@ts-step {"i": 5, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2\")).to_contain_text(\"Invoice 2 \u00b7 2027-02-01\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("Invoice 2 · 2027-02-01")
        # @@ts-step {"i": 6, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-line-1\")).to_contain_text(\"$10.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-line-1")).to_contain_text("$10.00")
        # @@ts-step {"i": 7, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-line-2\")).to_contain_text(\"$79.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-line-2")).to_contain_text("$79.00")
        # @@ts-step {"i": 8, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-discount\")).to_have_text(\"-$22.25\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-discount")).to_have_text("-$22.25")
        # @@ts-step {"i": 9, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-tax\")).to_have_text(\"$6.68\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-tax")).to_have_text("$6.68")
        # @@ts-step {"i": 10, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-total\")).to_have_text(\"$73.43\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$73.43")
        # @@ts-step {"i": 11, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_test_id(\"scenario-select\").select_option(\"S137\")", "input": null, "field": null}
        await page.get_by_test_id("scenario-select").select_option("S137")
        # @@ts-step {"i": 12, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"golden-badge\")).to_contain_text(\"Matches golden expected\")", "input": null, "field": null}
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        # S137 by hand: lines 2000, -1000, 7900; FOREVER25 takes 25% of the positive lines only: 2475, total 8900 - 2475 = 6425.
        # @@ts-step {"i": 13, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-line-1\")).to_contain_text(\"$20.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-line-1")).to_contain_text("$20.00")
        # @@ts-step {"i": 14, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-line-2\")).to_contain_text(\"-$10.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-line-2")).to_contain_text("-$10.00")
        # @@ts-step {"i": 15, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-line-3\")).to_contain_text(\"$79.00\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-line-3")).to_contain_text("$79.00")
        # @@ts-step {"i": 16, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-discount\")).to_have_text(\"-$24.75\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-discount")).to_have_text("-$24.75")
        # @@ts-step {"i": 17, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2-total\")).to_have_text(\"$64.25\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$64.25")

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
