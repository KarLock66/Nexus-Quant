"""POST /features/compute — vector correctness, canonical hash, admission.

Phase 1 acceptance criteria covered here:
  - identical inputs produce identical featureHash across two runs;
  - computation against DQ < 90 data is refused (defense-in-depth — the
    PRIMARY admission gate lives in the TypeScript caller).
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app.features import MIN_CANDLES, compute_feature_hash
from tests.conftest import make_constant_candles, make_random_walk_candles

SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")

EXPECTED_KEYS = {
    "ema_20",
    "ema_50",
    "ema_200",
    "rsi_14",
    "atr_14",
    "realized_vol_30",
    "volume_zscore_100",
    "donchian_upper_20",
    "donchian_lower_20",
    "donchian_mid_20",
}


def make_request(
    candles: list[dict[str, str]],
    dq_score: int = 95,
    feature_set: str = "core-technical",
    version: int = 1,
    scope_ts: str | None = None,
) -> dict:
    scope: dict = {"exchange": "DEMO", "symbol": "BTC-USDT", "timeframe": "H1"}
    if scope_ts is not None:
        scope["ts"] = scope_ts
    return {
        "scope": scope,
        "feature_set": feature_set,
        "version": version,
        "market_data": {"candles": candles},
        "dq_score": dq_score,
        "dq_report_id": "dq_test_1",
    }


def test_computes_full_vector_with_canonical_hash(client: TestClient):
    candles = make_random_walk_candles(250, seed=11)
    res = client.post("/features/compute", json=make_request(candles))
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["feature_set"] == "core-technical"
    assert body["version"] == 1
    assert set(body["features"].keys()) == EXPECTED_KEYS
    assert SHA256_HEX.match(body["featureHash"])
    assert body["input_candle_count"] == 250
    assert body["dq_report_id"] == "dq_test_1"
    # as_of_ts is the LAST candle's open time (point-in-time correctness).
    assert body["as_of_ts"].startswith("2024-01-11T09:00:00")
    # The hash is exactly sha256(canonical JSON of the vector).
    assert body["featureHash"] == compute_feature_hash(body["features"])


def test_constant_series_has_exactly_known_features(client: TestClient):
    res = client.post(
        "/features/compute", json=make_request(make_constant_candles(250))
    )
    assert res.status_code == 200, res.text
    f = res.json()["features"]

    assert f["ema_20"] == 100.0
    assert f["ema_50"] == 100.0
    assert f["ema_200"] == 100.0
    assert f["rsi_14"] == 50.0  # pinned: flat series, no gains, no losses
    assert f["atr_14"] == 20.0  # TR = high - low = 20 on every bar
    assert f["realized_vol_30"] == 0.0
    assert f["volume_zscore_100"] == 0.0  # pinned: zero-variance window
    assert f["donchian_upper_20"] == 110.0
    assert f["donchian_lower_20"] == 90.0
    assert f["donchian_mid_20"] == 100.0


def test_identical_inputs_identical_hash_changed_input_changed_hash(
    client: TestClient,
):
    candles = make_random_walk_candles(250, seed=11)
    first = client.post("/features/compute", json=make_request(candles)).json()
    second = client.post("/features/compute", json=make_request(candles)).json()
    assert first["featureHash"] == second["featureHash"]
    assert first["features"] == second["features"]

    # ADR-0001: features are quantized to 10 sig-figs, so the input change must
    # exceed the quantization grid to move the hash (a sub-quantum change is
    # legitimately absorbed). A relative bump is scale-safe.
    mutated = make_random_walk_candles(250, seed=11)
    mutated[-1]["close"] = f"{float(mutated[-1]['close']) * 1.001:.8f}"
    third = client.post("/features/compute", json=make_request(mutated)).json()
    assert third["featureHash"] != first["featureHash"]


def test_dq_below_90_is_refused_at_exactly_the_boundary(client: TestClient):
    candles = make_random_walk_candles(250, seed=11)

    res = client.post("/features/compute", json=make_request(candles, dq_score=89))
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "DQ_BELOW_MINIMUM"

    res = client.post("/features/compute", json=make_request(candles, dq_score=90))
    assert res.status_code == 200


def test_insufficient_candles_refused(client: TestClient):
    res = client.post(
        "/features/compute",
        json=make_request(make_random_walk_candles(MIN_CANDLES - 1, seed=11)),
    )
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "INSUFFICIENT_DATA"


def test_unknown_feature_set_or_version_refused(client: TestClient):
    candles = make_random_walk_candles(250, seed=11)

    res = client.post(
        "/features/compute", json=make_request(candles, feature_set="core-options")
    )
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "UNKNOWN_FEATURE_SET"

    res = client.post("/features/compute", json=make_request(candles, version=2))
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "UNKNOWN_FEATURE_SET"


def test_scope_ts_mismatch_refused_match_accepted(client: TestClient):
    candles = make_random_walk_candles(250, seed=11)

    res = client.post(
        "/features/compute",
        json=make_request(candles, scope_ts="2030-01-01T00:00:00Z"),
    )
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "SCOPE_TS_MISMATCH"

    res = client.post(
        "/features/compute",
        json=make_request(candles, scope_ts=candles[-1]["ts"]),
    )
    assert res.status_code == 200


def test_non_positive_close_refused(client: TestClient):
    candles = make_random_walk_candles(250, seed=11)
    candles[100]["close"] = "0"
    res = client.post("/features/compute", json=make_request(candles))
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "INVALID_MARKET_DATA"


def test_shared_secret_enforced_when_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("QUANT_SERVICE_SHARED_SECRET", "s3cret")
    body = make_request(make_random_walk_candles(250, seed=11))

    assert client.post("/features/compute", json=body).status_code == 401
    assert (
        client.post(
            "/features/compute", json=body, headers={"X-Internal-Secret": "s3cret"}
        ).status_code
        == 200
    )
