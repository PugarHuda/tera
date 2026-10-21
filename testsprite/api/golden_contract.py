import os
import requests

# TestSprite runs this file top to bottom. TERA_BASE_URL lets the same file run against a preview locally.
BASE_URL = os.environ.get("TERA_BASE_URL", "https://tera-orpin-three.vercel.app")
FIELDS = ("total", "discount", "tax", "starting_balance", "amount_due", "period_end")


def test_every_golden_scenario_matches_to_the_cent() -> None:
    listing = requests.get(f"{BASE_URL}/api/scenarios", timeout=30)
    assert listing.status_code == 200, f"GET /api/scenarios -> {listing.status_code}"
    ids = [s["id"] for s in listing.json()]
    assert len(ids) >= 27, f"expected at least 27 golden scenarios, got {len(ids)}"

    checked = 0
    for sid in ids:
        scenario = requests.get(f"{BASE_URL}/api/scenarios/{sid}", timeout=30).json()
        if "timeline" not in scenario:
            continue  # migration scenarios are covered by the migrate test
        res = requests.post(f"{BASE_URL}/api/simulate", json={"timeline": scenario["timeline"]}, timeout=30)
        assert res.status_code == 200, f"{sid}: simulate -> {res.status_code} {res.text[:200]}"
        body = res.json()
        invoices, expected = body["invoices"], scenario["expect"]
        assert [i["date"] for i in invoices] == [e["date"] for e in expected], f"{sid}: invoice dates differ"
        for n, (inv, exp) in enumerate(zip(invoices, expected), start=1):
            if "lines" in exp:
                got = [l["amount"] for l in inv["lines"]]
                assert got == exp["lines"], f"{sid} invoice {n}: lines {got} != {exp['lines']}"
            for f in FIELDS:
                if f in exp:
                    assert inv[f] == exp[f], f"{sid} invoice {n}: {f} {inv[f]} != {exp[f]}"
            # I1 + I6 on every invoice
            assert inv["subtotal"] == sum(l["amount"] for l in inv["lines"]), f"{sid} invoice {n}: subtotal != sum(lines)"
            assert inv["amount_due"] >= 0, f"{sid} invoice {n}: negative amount_due"
            # R18: a positive amount under Stripe's minimum charge (50 cents/yen, 30 pence) is carried, not collected (S69)
            owed = max(0, inv["total"] + inv["starting_balance"])
            carried = 0 < owed < {"gbp": 30}.get(inv["currency"], 50)
            assert inv["amount_due"] == (0 if carried else owed), f"{sid} invoice {n}: amount_due formula"
        expect_status = scenario.get("expect_status")  # "canceled", or with the day: S22 {"2027-02-01": "canceled"}
        if isinstance(expect_status, str):
            assert body["status"] == expect_status, f"{sid}: status {body['status']} != {expect_status}"
        for date, status in (expect_status if isinstance(expect_status, dict) else {}).items():
            assert body["status"] == status, f"{sid}: status {body['status']} != {status}"
            assert body["canceled_at"] == date, f"{sid}: canceled_at {body['canceled_at']} != {date}"
        checked += 1
    assert checked >= 25, f"only {checked} timeline scenarios checked"


test_every_golden_scenario_matches_to_the_cent()
