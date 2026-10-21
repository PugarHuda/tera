import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Simulator: resetting the billing anchor (S51) ...":
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
        # @@ts-step {"i": 2, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_test_id(\"scenario-select\").select_option(\"S51\")", "input": null, "field": null}
        await page.get_by_test_id("scenario-select").select_option("S51")
        # @@ts-step {"i": 3, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"golden-badge\")).to_contain_text(\"Matches golden expected\")", "input": null, "field": null}
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        n = await event_index(page, "reset_anchor")
        # @@ts-step {"i": 4, "type": "assertion", "action": "assert", "selector": null, "desc": "assert await invoice_totals(page) == [\"$158.00\", \"$50.97\", \"$158.00\", \"$158.00\"]", "input": null, "field": null}
        assert await invoice_totals(page) == ["$158.00", "$50.97", "$158.00", "$158.00"]
        # @@ts-step {"i": 5, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2\")).to_contain_text(\"Invoice 2 \u00b7 2026-01-11\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("Invoice 2 · 2026-01-11")
        # @@ts-step {"i": 6, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(\"invoice-2\")).to_contain_text(\"-$107.03\")", "input": null, "field": null}
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("-$107.03")
        for i, day in [(3, "2026-02-11"), (4, "2026-03-11")]:
            # @@ts-step {"i": 7, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(f\"invoice-{i}\")).to_contain_text(f\"Invoice {i} \u00b7 {day}\")", "input": null, "field": null}
            await expect(page.get_by_test_id(f"invoice-{i}")).to_contain_text(f"Invoice {i} · {day}")
        # @@ts-step {"i": 8, "type": "action", "action": "act", "selector": null, "desc": "await page.get_by_label(f\"Event {n} type\").select_option(\"remove_coupon\")", "input": null, "field": null}
        await page.get_by_label(f"Event {n} type").select_option("remove_coupon")
        # @@ts-step {"i": 9, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.locator(\"[data-testid^=invoice-][data-testid$=-total]\")).to_have_count(3)", "input": null, "field": null}
        await expect(page.locator("[data-testid^=invoice-][data-testid$=-total]")).to_have_count(3)
        # @@ts-step {"i": 10, "type": "assertion", "action": "assert", "selector": null, "desc": "assert await invoice_totals(page) == [\"$158.00\", \"$158.00\", \"$158.00\"]", "input": null, "field": null}
        assert await invoice_totals(page) == ["$158.00", "$158.00", "$158.00"]
        for i, day in [(1, "2026-01-01"), (2, "2026-02-01"), (3, "2026-03-01")]:
            # @@ts-step {"i": 11, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_test_id(f\"invoice-{i}\")).to_contain_text(f\"Invoice {i} \u00b7 {day}\")", "input": null, "field": null}
            await expect(page.get_by_test_id(f"invoice-{i}")).to_contain_text(f"Invoice {i} · {day}")
        # @@ts-step {"i": 12, "type": "assertion", "action": "assert", "selector": null, "desc": "await expect(page.get_by_text(\"-$107.03\")).to_have_count(0)", "input": null, "field": null}
        await expect(page.get_by_text("-$107.03")).to_have_count(0)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
