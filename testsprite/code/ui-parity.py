import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Stripe parity page: every scenario matches and S05 shows identical Tera and Stripe invoices":
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
        # @@ts-step {"i": 2, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_role(\"link\", name=\"Stripe parity\", exact=True).click()", "input": null, "field": null}
        await page.get_by_role("link", name="Stripe parity", exact=True).click()
        summary = await page.get_by_test_id("parity-summary").inner_text()
        m = re.search(r"(\d+) / (\d+)", summary)
        # @@ts-step {"i": 3, "type": "assertion", "action": "assert", "selector": null, "desc": "assert m and m.group(1) == m.group(2) and int(m.group(1)) >= 40, summary", "input": null, "field": null}
        assert m and m.group(1) == m.group(2) and int(m.group(1)) >= 40, summary
        for sid in ["S05", "S11", "S23", "S27"]:
            # @@ts-step {"i": 4, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(f\"parity-{sid}\")).to_contain_text(\"\u2705 Match\")", "input": null, "field": null}
            await expect(page.get_by_test_id(f"parity-{sid}")).to_contain_text("✅ Match")
        row = page.get_by_test_id("parity-S05")
        await row.get_by_role("button", expanded=False).first.click()
        text = await row.inner_text()
        # @@ts-step {"i": 5, "type": "assertion", "action": "assert", "selector": null, "desc": "assert text.count(\"$103.20\") >= 2, text", "input": null, "field": null}
        assert text.count("$103.20") >= 2, text
        for amount in ["-$14.03", "$38.23", "$79.00"]:
            # @@ts-step {"i": 6, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(row).to_contain_text(amount)", "input": null, "field": null}
            await expect(row).to_contain_text(amount)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
