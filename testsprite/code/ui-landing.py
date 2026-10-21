import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "Landing page: the hero invoice is S05's computed upgrade invoice ...":
# every step asserts exact values (S05's invoice 2 as Stripe billed it) instead of leaving the outcome to the AI judge.

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

        # @@ts-step {"i":1,"type":"action","action":"navigate","selector":null,"desc":"Navigate to https://tera-orpin-three.vercel.app","input":"https://tera-orpin-three.vercel.app","field":null}
        await page.goto("https://tera-orpin-three.vercel.app")
        await page.wait_for_load_state("domcontentloaded")

        # @@ts-step {"i":2,"type":"assertion","action":"assert","selector":"h1","desc":"The headline","input":null,"field":null}
        await expect(page.get_by_role("heading", level=1)).to_have_text("Change your pricing without breaking a single invoice.")

        # @@ts-step {"i":3,"type":"assertion","action":"assert","selector":"[data-testid=landing-invoice]","desc":"The hero is S05's invoice 2: $103.20 = -$14.03 + $38.23 + $79.00, and its invoice.created webhook","input":null,"field":null}
        hero = page.get_by_test_id("landing-invoice")
        await expect(hero).to_contain_text("Invoice 2 · 2027-02-01")
        for text in ["$103.20", "Unused time", "-$14.03", "Remaining time", "$38.23", "pro_m × 1", "$79.00", "invoice.created → invoice 2"]:
            await expect(hero).to_contain_text(text)

        # @@ts-step {"i":4,"type":"assertion","action":"assert","selector":"[data-testid=proof]","desc":"The parity count reads N / N with N >= 100","input":null,"field":null}
        proof = await page.get_by_test_id("proof").inner_text()
        m = re.search(r"(\d+) / (\d+)", proof)
        assert m and m.group(1) == m.group(2) and int(m.group(1)) >= 100, f"parity count: {proof!r}"
        assert "match Tera to the cent" in proof

        # @@ts-step {"i":5,"type":"action","action":"click","selector":"[data-testid=landing-cta]","desc":"Click 'Open the simulator'","input":null,"field":null}
        await page.get_by_test_id("landing-cta").click()

        # @@ts-step {"i":6,"type":"assertion","action":"assert","selector":"[data-testid=scenario-select]","desc":"The simulator opens on S05 with its invoices","input":null,"field":null}
        await expect(page).to_have_url(re.compile(r"/simulator$"))
        await expect(page.get_by_role("heading", level=1)).to_have_text("Customer timeline simulator")
        await expect(page.get_by_test_id("scenario-select")).to_have_value("S05")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$103.20")

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
