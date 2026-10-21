import os
import requests

BASE_URL = os.environ.get("TERA_BASE_URL", "https://tera-orpin-three.vercel.app")


def test_every_timeline_scenario_has_matching_stripe_evidence() -> None:
    """FR4: recorded Stripe test-clock evidence exists for every golden timeline scenario and shows no diff."""
    evidence = requests.get(f"{BASE_URL}/api/parity", timeout=30)
    assert evidence.status_code == 200, evidence.status_code
    records = {r["id"]: r for r in evidence.json()}
    timeline_ids = [s["id"] for s in requests.get(f"{BASE_URL}/api/scenarios", timeout=30).json()
                    if "timeline" in requests.get(f"{BASE_URL}/api/scenarios/{s['id']}", timeout=30).json()]
    missing = [i for i in timeline_ids if i not in records]
    assert not missing, f"no Stripe evidence for {missing}"
    for sid in timeline_ids:
        r = records[sid]
        assert r["match"] is True and r["diffs"] == [], f"{sid}: Stripe diff {r['diffs']}"
        assert r["test_clock"].startswith("clock_"), f"{sid}: not replayed on a test clock"


def test_live_replay_rejects_bad_input_before_stripe() -> None:
    """Unknown ids, over-limit custom timelines (400) and timelines Tera rejects (422) never reach Stripe."""
    sub = {"at": "2027-01-01T00:00:00Z", "type": "subscribe", "price": "pro_m"}
    too_many = [sub] + [{"at": f"2027-02-{d:02d}T00:00:00Z", "type": "advance_to"} for d in range(1, 16)]
    too_long = [sub, {"at": "2029-02-01T00:00:00Z", "type": "advance_to"}]
    cases = [
        ({"scenario": "S9999"}, 400), ({"scenario": "S24"}, 400), ({}, 400),
        ({"timeline": too_many}, 400), ({"timeline": too_long}, 400),
        ({"timeline": [{**sub, "price": "nope"}]}, 422),
        ({"timeline": [sub, {"at": "2027-01-10T00:00:00Z", "type": "subscribe", "price": "pro_m"}]}, 422),
    ]
    for body, status in cases:
        res = requests.post(f"{BASE_URL}/api/parity", json=body, timeout=30)
        assert res.status_code == status, f"{body}: expected {status}, got {res.status_code} {res.text[:200]}"
        assert "error" in res.json()


test_every_timeline_scenario_has_matching_stripe_evidence()
test_live_replay_rejects_bad_input_before_stripe()
