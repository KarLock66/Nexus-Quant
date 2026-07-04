"""POST /dq/statistical — contract, catalog, fail-closed and determinism.

The wire contract these tests pin is owned by
services/ingestion/src/dq/stage-b-client.ts: every check must serialize as
{check: str, passed: bool, deduction: finite number, detail: str} or the TS
client discards the whole response as malformed (costing 15 points).
"""

from __future__ import annotations

import math

from fastapi.testclient import TestClient

from app.dq import STAGE_B_WEIGHTS
from tests.conftest import make_random_walk_candles

CATALOG = [
    "price_outliers",
    "volume_anomaly",
    "distribution_drift",
    "cross_exchange_divergence",
]


def post(client: TestClient, candles: list[dict[str, str]], reference=None):
    res = client.post(
        "/dq/statistical",
        json={"candles": candles, "referenceCloses": reference},
    )
    assert res.status_code == 200, res.text
    return res.json()["checks"]


def by_name(checks: list[dict], name: str) -> dict:
    found = [c for c in checks if c["check"] == name]
    assert len(found) == 1, f"expected exactly one {name}, got {len(found)}"
    return found[0]


def test_catalog_weights_sum_to_stage_b_unavailable_deduction():
    # 15 = STAGE_B_UNAVAILABLE_DEDUCTION (services/ingestion/src/dq/stage-b-client.ts):
    # Stage B fully failing costs exactly as much as Stage B being down.
    assert sum(STAGE_B_WEIGHTS.values()) == 15


def test_clean_fixture_passes_all_checks_with_client_compatible_shape(client):
    checks = post(client, make_random_walk_candles(300))
    assert [c["check"] for c in checks] == CATALOG
    for c in checks:
        # Exact shape the TS client validates before accepting the response.
        assert isinstance(c["check"], str)
        assert isinstance(c["passed"], bool)
        assert isinstance(c["deduction"], (int, float))
        assert math.isfinite(c["deduction"])
        assert isinstance(c["detail"], str)
        assert c["passed"] is True
        assert c["deduction"] == 0


def test_injected_price_outlier_fails_with_scaled_deduction(client):
    candles = make_random_walk_candles(300)
    # Data-error-grade bad print on the LAST close: exactly one return affected.
    candles[-1]["close"] = f"{float(candles[-1]['close']) * 10:.8f}"
    checks = post(client, candles)

    outliers = by_name(checks, "price_outliers")
    assert outliers["passed"] is False
    assert outliers["deduction"] == 2  # 1 outlier x PER_OUTLIER_DEDUCTION
    assert "1 outlier(s)" in outliers["detail"]


def test_interior_bad_print_costs_two_returns(client):
    candles = make_random_walk_candles(300)
    candles[150]["close"] = f"{float(candles[150]['close']) * 10:.8f}"
    checks = post(client, candles)
    # The spike-up and snap-back returns are both outliers.
    assert by_name(checks, "price_outliers")["deduction"] == 4


def test_injected_volume_anomaly_fails(client):
    candles = make_random_walk_candles(300)
    candles[42]["volume"] = "1000000000.00000000"
    checks = post(client, candles)

    anomaly = by_name(checks, "volume_anomaly")
    assert anomaly["passed"] is False
    assert anomaly["deduction"] == 2
    assert by_name(checks, "price_outliers")["passed"] is True


def test_stuck_feed_triggers_distribution_drift(client):
    candles = make_random_walk_candles(400)
    frozen = candles[199]["close"]
    for c in candles[200:]:  # stuck price feed: second half never moves
        c["close"] = frozen
        c["open"] = frozen
        c["high"] = f"{float(frozen) * 1.001:.8f}"
        c["low"] = f"{float(frozen) * 0.999:.8f}"
    checks = post(client, candles)

    drift = by_name(checks, "distribution_drift")
    assert drift["passed"] is False
    assert drift["deduction"] == STAGE_B_WEIGHTS["distribution_drift"]


def test_cross_exchange_divergence_null_reference_passes_vacuously(client):
    checks = post(client, make_random_walk_candles(100), reference=None)
    cross = by_name(checks, "cross_exchange_divergence")
    assert cross["passed"] is True
    assert "no reference" in cross["detail"]


def test_cross_exchange_divergence_fires_beyond_one_percent(client):
    candles = make_random_walk_candles(100)
    reference = [f"{float(c['close']):.8f}" for c in candles]
    for i in range(5):  # 2% off on five bars
        reference[i] = f"{float(reference[i]) * 1.02:.8f}"
    checks = post(client, candles, reference=reference)

    cross = by_name(checks, "cross_exchange_divergence")
    assert cross["passed"] is False
    assert cross["deduction"] == STAGE_B_WEIGHTS["cross_exchange_divergence"]

    # Matching reference passes.
    checks = post(client, candles, reference=[c["close"] for c in candles])
    assert by_name(checks, "cross_exchange_divergence")["passed"] is True


def test_reference_length_mismatch_fails_closed(client):
    candles = make_random_walk_candles(100)
    checks = post(client, candles, reference=["100.0"] * 50)
    cross = by_name(checks, "cross_exchange_divergence")
    assert cross["passed"] is False
    assert "length mismatch" in cross["detail"]


def test_unparseable_rows_never_500(client):
    candles = make_random_walk_candles(100)
    candles[10]["close"] = "NaN"
    candles[11]["volume"] = "-5"
    checks = post(client, candles)  # 200 asserted inside post()
    assert [c["check"] for c in checks] == CATALOG
    assert "skipped 1" in by_name(checks, "price_outliers")["detail"]


def test_bare_numeric_ohlcv_accepted(client):
    res = client.post(
        "/dq/statistical",
        json={
            "candles": [
                {
                    "ts": "2024-01-01T00:00:00.000Z",
                    "open": 100.0,
                    "high": 110,
                    "low": 90.0,
                    "close": 105.0,
                    "volume": 1000,
                }
            ],
            "referenceCloses": None,
        },
    )
    assert res.status_code == 200, res.text


def test_identical_payloads_get_identical_responses(client):
    candles = make_random_walk_candles(300)
    body = {"candles": candles, "referenceCloses": None}
    first = client.post("/dq/statistical", json=body)
    second = client.post("/dq/statistical", json=body)
    assert first.json() == second.json()


def test_shared_secret_enforced_when_configured(client, monkeypatch):
    monkeypatch.setenv("QUANT_SERVICE_SHARED_SECRET", "s3cret")
    body = {"candles": make_random_walk_candles(10), "referenceCloses": None}

    assert client.post("/dq/statistical", json=body).status_code == 401
    assert (
        client.post(
            "/dq/statistical", json=body, headers={"X-Internal-Secret": "wrong"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/dq/statistical", json=body, headers={"X-Internal-Secret": "s3cret"}
        ).status_code
        == 200
    )
