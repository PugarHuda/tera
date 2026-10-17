import os
import requests

BASE_URL = os.environ.get("TERA_BASE_URL", "https://tera-orpin-three.vercel.app")


def test_downgrade_credit_is_carried_not_refunded() -> None:
    """R10 / golden S27: a downgrade with always_invoice charges nothing and credits the next invoice."""
    timeline = [
        {"at": "2027-01-01T00:00:00Z", "type": "subscribe", "price": "pro_m"},
        {"at": "2027-01-17T00:00:00Z", "type": "change_price", "price": "starter_m", "proration_behavior": "always_invoice"},
        {"at": "2027-02-01T00:00:00Z", "type": "advance_to"},
    ]
    res = requests.post(f"{BASE_URL}/api/simulate", json={"timeline": timeline}, timeout=30)
    assert res.status_code == 200, res.text
    inv = res.json()["invoices"]
    assert [i["date"] for i in inv] == ["2027-01-01", "2027-01-17", "2027-02-01"]
    assert [l["amount"] for l in inv[1]["lines"]] == [-3823, 1403]
    assert inv[1]["total"] == -2420 and inv[1]["amount_due"] == 0
    assert inv[2]["starting_balance"] == -2420 and inv[2]["total"] == 2900 and inv[2]["amount_due"] == 480


def test_price_change_during_trial_does_not_prorate() -> None:
    """R4 / golden S26: nothing was paid during the trial, so no credit line may appear."""
    timeline = [
        {"at": "2027-01-01T00:00:00Z", "type": "start_trial", "price": "starter_m", "trial_days": 14},
        {"at": "2027-01-05T00:00:00Z", "type": "change_price", "price": "pro_m"},
        {"at": "2027-02-20T00:00:00Z", "type": "advance_to"},
    ]
    inv = requests.post(f"{BASE_URL}/api/simulate", json={"timeline": timeline}, timeout=30).json()["invoices"]
    assert [i["total"] for i in inv] == [0, 7900, 7900], [i["total"] for i in inv]
    assert all(l["amount"] >= 0 for i in inv for l in i["lines"]), "a trial change produced a credit line"


test_downgrade_credit_is_carried_not_refunded()
test_price_change_during_trial_does_not_prorate()
