import os
import requests

BASE_URL = os.environ.get("TERA_BASE_URL", "https://tera-orpin-three.vercel.app")
SUB = {"at": "2027-01-01T00:00:00Z", "type": "subscribe", "price": "starter_m"}

CASES = {
    "amount_off coupon in another currency": ([{**SUB, "price": "starter_m_eur", "coupon": "TENOFF3"}], "currency"),
    "currency switch mid-subscription": ([SUB, {"at": "2027-01-17T00:00:00Z", "type": "change_price", "price": "basic_m_jpy"}], "currency"),
    "second subscribe while active": ([SUB, {"at": "2027-01-10T00:00:00Z", "type": "subscribe", "price": "pro_m"}], "already"),
    "usage on a licensed price": ([SUB, {"at": "2027-01-10T00:00:00Z", "type": "report_usage", "quantity": 10}], "metered"),
    "change after cancellation": (
        [SUB, {"at": "2027-01-10T00:00:00Z", "type": "cancel_at_period_end"}, {"at": "2027-03-01T00:00:00Z", "type": "change_price", "price": "pro_m"}],
        "canceled",
    ),
    "unknown price": ([{**SUB, "price": "gold"}], "unknown price"),
}


def test_stripe_rejected_timelines_return_422_with_a_reason() -> None:
    for name, (timeline, needle) in CASES.items():
        res = requests.post(f"{BASE_URL}/api/simulate", json={"timeline": timeline}, timeout=30)
        assert res.status_code == 422, f"{name}: expected 422, got {res.status_code} {res.text[:200]}"
        error = res.json().get("error", "")
        assert needle in error.lower(), f"{name}: error {error!r} does not mention {needle!r}"


def test_malformed_input_returns_400() -> None:
    bad = {
        "empty timeline": {"timeline": []},
        "bad date": {"timeline": [{**SUB, "at": "next tuesday"}]},
        "negative quantity": {"timeline": [{**SUB, "quantity": -1}]},
        "first event not subscribe": {"timeline": [{"at": "2027-01-01T00:00:00Z", "type": "advance_to"}]},
    }
    for name, body in bad.items():
        res = requests.post(f"{BASE_URL}/api/simulate", json=body, timeout=30)
        assert res.status_code == 400, f"{name}: expected 400, got {res.status_code}"
    raw = requests.post(f"{BASE_URL}/api/simulate", data="{not json", headers={"Content-Type": "application/json"}, timeout=30)
    assert raw.status_code == 400, f"malformed JSON: expected 400, got {raw.status_code}"


test_stripe_rejected_timelines_return_422_with_a_reason()
test_malformed_input_returns_400()
