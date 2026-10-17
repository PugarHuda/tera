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


def test_live_replay_only_accepts_golden_ids() -> None:
    for body in ({"scenario": "S99"}, {"scenario": "S24"}, {}):
        res = requests.post(f"{BASE_URL}/api/parity", json=body, timeout=30)
        assert res.status_code == 400, f"{body}: expected 400, got {res.status_code}"


test_every_timeline_scenario_has_matching_stripe_evidence()
test_live_replay_only_accepts_golden_ids()
