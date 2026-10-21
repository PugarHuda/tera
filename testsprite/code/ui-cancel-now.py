import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Simulator: immediate cancel (S46) ...":
# every step asserts exact values instead of leaving the outcome to the run-time AI judge.

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

        # @@ts-step {"i":1,"type":"action","action":"navigate","selector":null,"desc":"Navigate to https://tera-orpin-three.vercel.app/simulator","input":"https://tera-orpin-three.vercel.app/simulator","field":null}
        await page.goto("https://tera-orpin-three.vercel.app/simulator")
        await page.wait_for_load_state("domcontentloaded")

        # @@ts-step {"i":2,"type":"action","action":"select","selector":"[data-testid=scenario-select]","desc":"Load golden scenario S46","input":"S46","field":null}
        await page.get_by_test_id("scenario-select").select_option("S46")
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")

        # @@ts-step {"i":3,"type":"assertion","action":"assert","selector":null,"desc":"S46 timeline has a 'Cancel immediately' event and exactly three invoices with no proration lines","input":null,"field":null}
        await expect(page.get_by_label("Event 3 type")).to_have_value("cancel_now")
        await expect(page.locator("[data-testid^=invoice-][data-testid$=-total]")).to_have_count(3)
        for n, total in [(1, "$79.00"), (2, "$29.00"), (3, "$29.00")]:
            await expect(page.get_by_test_id(f"invoice-{n}-total")).to_have_text(total)
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("2027-02-01")
        await expect(page.get_by_text(re.compile("Unused time|Remaining time"))).to_have_count(0)
        await expect(page.get_by_test_id("sub-status")).to_contain_text("active")

        # @@ts-step {"i":4,"type":"action","action":"select","selector":"[aria-label='Event 3 type']","desc":"Change the 'Cancel immediately' event to 'End trial now'","input":"end_trial","field":null}
        await page.get_by_label("Event 3 type").select_option("end_trial")

        # @@ts-step {"i":5,"type":"assertion","action":"assert","selector":"[data-testid=sim-error]","desc":"The engine refuses end_trial on a subscription that is not trialing","input":null,"field":null}
        await expect(page.get_by_test_id("sim-error")).to_contain_text("end_trial needs a subscription in trial")
        await expect(page.get_by_test_id("golden-badge")).to_have_count(0)

        # @@ts-step {"i":6,"type":"action","action":"select","selector":"[aria-label='Event 3 type']","desc":"Restore 'Cancel immediately'; the golden badge returns","input":"cancel_now","field":null}
        await page.get_by_label("Event 3 type").select_option("cancel_now")
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$29.00")

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
