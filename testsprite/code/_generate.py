# Writes the hand-written TestSprite UI test code in this folder from the bodies below, with the same browser setup as
# the code TestSprite generates. Each body asserts exact, hand-derived values on data-testids and labels, so a replay
# (`test rerun`, `test flaky`, a schedule) proves the numbers, not only that a page loaded.
#   python testsprite/code/_generate.py   # writes the files and prints "<test id> <file>" per test
#   testsprite test code put <test id> --code-file testsprite/code/<file> --expected-version <current codeVersion>
# `testsprite test run <id>` executes this code; `test rerun` replays the recording of the last agent run instead.
import json
from pathlib import Path

APP = "https://tera-orpin-three.vercel.app"

HEAD = '''import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

# Hand-written replacement for the generated code of "{name}":
# every step asserts exact values instead of leaving the outcome to the run-time AI judge.

APP = "{app}"


async def invoice_totals(page):
    return await page.locator("[data-testid^=invoice-][data-testid$=-total]").all_inner_texts()


async def event_index(page, value):
    """1-based number of the first timeline event whose type select has this value."""
    values = await page.locator("select[aria-label^='Event '][aria-label$=' type']").evaluate_all("els => els.map(e => e.value)")
    assert value in values, f"no {{value}} event in {{values}}"
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

'''

FOOT = '''
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
'''


def scenario(sid):
    return f'''        await page.goto(APP + "/simulator")
        await page.get_by_test_id("scenario-select").select_option("{sid}")
'''


S05_TOTALS = '''        await expect(page.get_by_test_id("invoice-1-total")).to_have_text("$29.00")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$103.20")
        # S05 by hand: 15 of 31 days left on 2027-01-17: -round(2900*15/31) = -14.03, +round(7900*15/31) = 38.23, then 79.00
        for j, amount in [(1, "-$14.03"), (2, "$38.23"), (3, "$79.00")]:
            await expect(page.get_by_test_id(f"invoice-2-line-{j}")).to_contain_text(amount)
'''

MIGRATE = '''        await page.goto(APP + "/migrate")
        await expect(page.get_by_role("heading", name="Price migration planner")).to_be_visible()
'''

GRANDFATHER = MIGRATE + '''        # Seats 1, 1, 3 at $29 -> $39: MRR 5 x 29 = $145.00 -> 5 x 39 = $195.00, +$50.00, 3 customers affected
        await expect(page.get_by_test_id("mrr-delta")).to_have_text("+$50.00")
        box = page.get_by_label(re.compile("Grandfather existing customers"))
        await box.check()
        await expect(page.get_by_test_id("affected")).to_have_text("0")
        await expect(page.get_by_test_id("mrr-after")).to_have_text("$145.00")
        await expect(page.get_by_test_id("mrr-delta")).to_have_text("+$0.00")
        await box.uncheck()
        await expect(page.get_by_test_id("affected")).to_have_text("3")
        await expect(page.get_by_test_id("mrr-delta")).to_have_text("+$50.00")
'''

INVALID_MIGRATION = MIGRATE + '''        old = page.get_by_label("Current price (USD)")
        await old.fill("0")
        await expect(page.get_by_test_id("migrate-error")).to_contain_text("Prices must be positive amounts.")
        await expect(page.get_by_test_id("mrr-delta")).to_have_count(0)
        await old.fill("29.00")
        seats = page.get_by_label(re.compile("Customer base"))
        await seats.fill("1, 2.5")
        await expect(page.get_by_test_id("migrate-error")).to_contain_text("Seat counts must be positive whole numbers.")
        await seats.fill("1, 1, 3")
        await expect(page.get_by_test_id("migrate-error")).to_have_count(0)
        await expect(page.get_by_test_id("mrr-delta")).to_have_text("+$50.00")
'''

OUT_OF_ORDER = scenario("S05") + S05_TOTALS + '''        # Event 2 moved before event 1: refused with a reason, no invoices from a reordered timeline
        await page.get_by_label("Event 2 date").fill("2026-12-01")
        await page.get_by_label("Event 2 date").blur()
        await expect(page.get_by_test_id("sim-error")).to_contain_text("chronological order")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_count(0)
        await page.get_by_label("Event 2 date").fill("2027-01-17")
        await page.get_by_label("Event 2 date").blur()
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$103.20")
'''

LOCALE = scenario("S05") + S05_TOTALS + '''        await page.get_by_test_id("locale-select").select_option("de-DE")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text(re.compile(r"^103,20\\s\\$$"))
        await expect(page.get_by_test_id("invoice-2-line-1")).to_contain_text(re.compile(r"-14,03\\s\\$"))
        await page.get_by_test_id("locale-select").select_option("en-US")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$103.20")
'''

TESTS = {
    "ui-reset-anchor.py": ("2cccee5c-d90b-4dc7-9d0c-2ac61e5ff3a7", "Simulator: resetting the billing anchor (S51) ...", scenario("S51") + '''        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        n = await event_index(page, "reset_anchor")
        assert await invoice_totals(page) == ["$158.00", "$50.97", "$158.00", "$158.00"]
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("Invoice 2 · 2026-01-11")
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("-$107.03")
        for i, day in [(3, "2026-02-11"), (4, "2026-03-11")]:
            await expect(page.get_by_test_id(f"invoice-{i}")).to_contain_text(f"Invoice {i} · {day}")
        await page.get_by_label(f"Event {n} type").select_option("remove_coupon")
        await expect(page.locator("[data-testid^=invoice-][data-testid$=-total]")).to_have_count(3)
        assert await invoice_totals(page) == ["$158.00", "$158.00", "$158.00"]
        for i, day in [(1, "2026-01-01"), (2, "2026-02-01"), (3, "2026-03-01")]:
            await expect(page.get_by_test_id(f"invoice-{i}")).to_contain_text(f"Invoice {i} · {day}")
        await expect(page.get_by_text("-$107.03")).to_have_count(0)
'''),
    "ui-trial-change.py": ("7ba372bf-2683-48bc-95e8-b46d15901fd3", "Simulator: upgrading during a trial (S26) ...", scenario("S26") + '''        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        await expect(page.locator("[data-testid^=invoice-][data-testid$=-total]")).to_have_count(3)
        assert await invoice_totals(page) == ["$0.00", "$79.00", "$79.00"]
        await expect(page.locator(".badge", has_text="proration")).to_have_count(0)
        lines = await page.locator("[data-testid*=-line-]").all_inner_texts()
        assert lines and not any(re.search(r"-\\$", l) for l in lines), lines
'''),
    "ui-credit-balance.py": ("01922f70-7d0b-40a3-8fa1-d4f0556652b6", "Simulator: downgrade credit (S27) ...", scenario("S27") + '''        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("Invoice 2 · 2027-01-17")
        await expect(page.get_by_test_id("invoice-2-line-1")).to_contain_text("-$38.23")
        await expect(page.get_by_test_id("invoice-2-line-2")).to_contain_text("$14.03")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("-$24.20")
        await expect(page.get_by_test_id("invoice-2-amount-due")).to_have_text("$0.00")
        await expect(page.get_by_test_id("invoice-3")).to_contain_text("Invoice 3 · 2027-02-01")
        await expect(page.get_by_test_id("invoice-3-total")).to_have_text("$29.00")
        await expect(page.get_by_test_id("invoice-3-credit")).to_contain_text("-$24.20")
        await expect(page.get_by_test_id("invoice-3-amount-due")).to_have_text("$4.80")
'''),
    "ui-migrate-default.py": ("06eb515a-ae99-47d1-ae7f-ff17389beb56", "Migration planner: default $29 -> $39 ...", MIGRATE + '''        await expect(page.get_by_test_id("affected")).to_have_text("3")
        await expect(page.get_by_test_id("mrr-before")).to_have_text("$145.00")
        await expect(page.get_by_test_id("mrr-after")).to_have_text("$195.00")
        await expect(page.get_by_test_id("mrr-delta")).to_have_text("+$50.00")
'''),
    "ui-migrate-grandfather-toggle.py": ("b9ea281e-9480-4d89-854b-aa92342e462a", "Migration planner: grandfathering toggles ...", GRANDFATHER),
    "ui-migrate-invalid.py": ("813488e6-ced3-4f7f-af0e-759e84acbf01", "Migration planner: non-positive price and bad seat counts ...", INVALID_MIGRATION),
    "ui-builder.py": ("048f474c-eb9a-4012-a50f-63dd022f95f3", "Pricing builder: JPY rejects decimals ...", '''        await page.goto(APP + "/builder")
        await page.get_by_role("button", name="Reset to reference catalog").click()
        await expect(page.get_by_test_id("builder-valid")).to_contain_text("Catalog is valid: 8 prices, 4 coupons, 2 tax rates.")
        await page.get_by_label("Price 1 currency").select_option("jpy")
        await page.get_by_label("Price 1 amount").fill("29.5")
        await expect(page.get_by_test_id("builder-error")).to_contain_text("starter_m: JPY has no minor unit, so the amount cannot have decimals")
        await page.get_by_label("Price 1 amount").fill("4500")
        await page.get_by_label("Price 1 id").fill("starter_jpy")
        await expect(page.get_by_test_id("builder-error")).to_have_count(0)
        await page.get_by_test_id("simulate-catalog").click()
        await expect(page.get_by_text("Using a custom catalog from the Pricing Builder")).to_be_visible()
        await expect(page.get_by_test_id("scenario-select")).to_have_count(0)
        await expect(page.get_by_test_id("invoice-1-total")).to_have_text("¥4,500")
'''),
    "ui-verify-stripe.py": ("c450f052-b403-4f96-bc47-25bb9122d5e2", "Simulator: 'Verify in Stripe' replays an edited timeline ...", scenario("S01") + '''        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        await page.get_by_label("Event 1 quantity").fill("2")
        await page.get_by_label("Event 1 quantity").blur()
        await expect(page.get_by_test_id("golden-badge")).to_have_count(0)  # an edited timeline is no longer a golden one
        await page.get_by_test_id("verify-stripe").click()
        check = page.get_by_test_id("stripe-check")
        await expect(check).to_contain_text("Matches Stripe", timeout=150000)
        await expect(check).to_contain_text(re.compile(r"clock_\\w+"))
'''),
    "ui-pause.py": ("57e74516-8f90-4358-afa4-1fed967215da", "Simulator: pausing a flexible subscription (S80) ...", scenario("S80") + '''        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        n = await event_index(page, "pause")
        await event_index(page, "resume")
        # Paused 2027-01-16 to 2027-02-15: no renewal on 2027-02-01, the -$40.77 unused-time credit rides on the resume invoice
        assert await invoice_totals(page) == ["$79.00", "$38.23", "$79.00"]
        for i, day in [(1, "2027-01-01"), (2, "2027-02-15"), (3, "2027-03-15")]:
            await expect(page.get_by_test_id(f"invoice-{i}")).to_contain_text(f"Invoice {i} · {day}")
        await expect(page.get_by_test_id("invoice-2")).to_contain_text("-$40.77")
        await expect(page.get_by_text(re.compile(r"Invoice \\d+ · 2027-02-01"))).to_have_count(0)
        await page.get_by_label(f"Event {n} proration_behavior").select_option("always_invoice")
        await expect(page.locator("[data-testid^=invoice-][data-testid$=-total]")).to_have_count(4)
        assert await invoice_totals(page) == ["$79.00", "-$40.77", "$79.00", "$79.00"]
        for i, day in [(1, "2027-01-01"), (2, "2027-01-16"), (3, "2027-02-15"), (4, "2027-03-15")]:
            await expect(page.get_by_test_id(f"invoice-{i}")).to_contain_text(f"Invoice {i} · {day}")
'''),
    "ui-trial-no-card.py": ("6ce9ff12-fec6-42a8-83aa-be38544b0191", "Simulator: a trial that ends without a card is paused, then resumed ...", scenario("S97") + '''        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        await expect(page.get_by_label("Event 1 type")).to_have_value("start_trial")
        await expect(page.get_by_label("Event 1 trial_end_behavior")).to_have_value("pause")
        await expect(page.get_by_label("Event 2 type")).to_have_value("resume")
        await expect(page.get_by_label("Event 2 billing_cycle_anchor")).to_have_value("unchanged")
        assert await invoice_totals(page) == ["$0.00", "$48.65", "$29.00"]
        for i, day in [(1, "2027-01-10"), (2, "2027-02-24"), (3, "2027-03-24")]:
            await expect(page.get_by_test_id(f"invoice-{i}")).to_contain_text(f"Invoice {i} · {day}")
        await expect(page.get_by_test_id("invoice-2-line-1")).to_contain_text("$19.65")
        await expect(page.get_by_test_id("invoice-2-line-2")).to_contain_text("$29.00")
        await expect(page.get_by_text(re.compile(r"Invoice \\d+ · 2027-01-24"))).to_have_count(0)
        await page.get_by_test_id("scenario-select").select_option("S96")
        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
        assert await invoice_totals(page) == ["$0.00"]
        await expect(page.get_by_test_id("invoice-1")).to_contain_text("Invoice 1 · 2027-01-10")
'''),
    # Older cloud tests, created from the dashboard before plans lived in testsprite/plans/.
    "ui-out-of-order.py": ("d78a6d51-e98b-4833-ab3b-3c47a7cd22e3", "Timeline simulator shows an error for out-of-order dates", OUT_OF_ORDER),
    "ui-out-of-order-events.py": ("ae61acdf-b2df-4d7a-b48b-57b8136a2f21", "Show an error for out-of-order timeline events", OUT_OF_ORDER),
    "ui-golden-badge.py": ("7c474bd5-dc5a-4266-aea0-7e691aa4b314", "Timeline simulator load scenario switch shows golden badge ...", scenario("S05") + '''        await expect(page.get_by_test_id("golden-badge")).to_have_text("✅ Matches golden expected")
''' + S05_TOTALS + '''        await page.get_by_test_id("scenario-select").select_option("S27")
        await expect(page.get_by_test_id("golden-badge")).to_have_text("✅ Matches golden expected")
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("-$24.20")
'''),
    "ui-grandfather.py": ("76e782fd-5025-4ccb-9e41-88d705b67e8f", "Apply grandfathering in the migration planner", GRANDFATHER),
    "ui-grandfather-mrr.py": ("3c471e99-9cb1-41ca-a551-3ab25cca63b6", "Migration planner with grandfathering keeps MRR unchanged", GRANDFATHER),
    "ui-edit-event.py": ("712061f7-6a13-46fd-b088-47b0ac1476ce", "Edit a timeline event and verify recomputed invoice totals", scenario("S05") + S05_TOTALS + '''        # The upgrade one day earlier, 2027-01-16: 16 of 31 days left, by hand:
        # -round(2900*16/31) = -round(1496.77) = -14.97, +round(7900*16/31) = +round(4077.42) = 40.77, plus 79.00 = 104.80
        await page.get_by_label("Event 2 date").fill("2027-01-16")
        await page.get_by_label("Event 2 date").blur()
        await expect(page.get_by_test_id("invoice-2-total")).to_have_text("$104.80")
        for j, amount in [(1, "-$14.97"), (2, "$40.77"), (3, "$79.00")]:
            await expect(page.get_by_test_id(f"invoice-2-line-{j}")).to_contain_text(amount)
        await expect(page.get_by_test_id("golden-badge")).to_have_count(0)  # an edited timeline is no longer a golden one
'''),
    "ui-migrate-invalid-input.py": ("571aec8c-a24d-496e-ae6f-8002ede422ba", "Show validation for invalid migration planner input", INVALID_MIGRATION),
    "ui-locale.py": ("4a8ea845-999a-4124-8bd6-1622198eb27f", "Switch locale and verify amount formatting", LOCALE),
    "ui-locale-de.py": ("09b27128-0c42-4a81-8042-b947933af9f0", "Timeline simulator locale switch reformats amounts in de-DE", LOCALE),
    "ui-s05-totals.py": ("1fcef436-d9e7-4495-972c-f89ad5f41e80", "Load golden scenario S05 and verify invoice totals", scenario("S05") + '''        await expect(page.get_by_test_id("golden-badge")).to_contain_text("Matches golden expected")
''' + S05_TOTALS + '''        await expect(page.locator("[data-testid^=invoice-][data-testid$=-total]")).to_have_count(2)
'''),
}

def with_steps(body):
    """Marks every page action and assertion as a TestSprite step, so the dashboard lists them and names the one that
    failed (the same `# @@ts-step` comments TestSprite writes into its generated code)."""
    out, i = [], 0
    for line in body.splitlines(keepends=True):
        code = line.strip()
        kind = "assertion" if code.startswith(("await expect(", "assert ")) else "action" if code.startswith(("await page.", "await box.", "await old.", "await seats.")) else None
        if kind:
            i += 1
            indent = line[: len(line) - len(line.lstrip())]
            out.append(f"{indent}# @@ts-step {json.dumps({'i': i, 'type': kind, 'action': 'assert' if kind == 'assertion' else 'act', 'selector': None, 'desc': code[:160], 'input': None, 'field': None})}\n")
        out.append(line)
    return "".join(out)


if __name__ == "__main__":
    here = Path(__file__).parent
    for file, (_, name, body) in TESTS.items():
        (here / file).write_text(HEAD.format(name=name, app=APP) + with_steps(body) + FOOT, encoding="utf-8", newline="\n")
    for file, (tid, _, _) in TESTS.items():
        print(f"{tid} {file}")
