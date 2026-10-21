import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Simulator: S05 lists the webhook events Stripe sent for it ...":
# each group must hold exactly the events a Stripe test clock sent for S05 (golden/parity/S05.json -> webhooks).

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

        # @@ts-step {"i":2,"type":"action","action":"select","selector":"[data-testid=scenario-select]","desc":"Load golden scenario S05","input":"S05","field":null}
        await page.get_by_test_id("scenario-select").select_option("S05")
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")

        # @@ts-step {"i":3,"type":"action","action":"click","selector":"[data-testid=webhooks] summary","desc":"Expand 'Webhook events Stripe sends (9)'","input":null,"field":null}
        await expect(page.get_by_test_id("webhooks").locator("summary")).to_have_text("Webhook events Stripe sends (9)")
        await page.get_by_test_id("webhooks").locator("summary").click()

        # @@ts-step {"i":4,"type":"assertion","action":"assert","selector":"[data-testid^=webhooks-]","desc":"Each timeline event lists exactly the webhooks Stripe sent for it","input":null,"field":null}
        expected = {
            1: ["2027-01-01 customer.subscription.created (active)", "2027-01-01 invoice.created → invoice 1", "2027-01-01 invoice.finalized → invoice 1", "2027-01-01 invoice.paid → invoice 1"],
            2: ["2027-01-17 customer.subscription.updated (active)", "2027-01-17 invoiceitem.created", "2027-01-17 invoiceitem.created"],
            3: ["2027-02-01 invoice.created → invoice 2", "2027-02-01 customer.subscription.updated (active)"],
        }
        for n, events in expected.items():
            items = page.get_by_test_id(f"webhooks-{n}").locator("ul > li")
            await expect(items).to_have_count(len(events))
            got = sorted([t.strip() for t in await items.all_inner_texts()])
            assert got == sorted(events), f"event {n}: {got}"
        await expect(page.get_by_test_id("webhooks")).not_to_contain_text("invoice.paid → invoice 2")

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
