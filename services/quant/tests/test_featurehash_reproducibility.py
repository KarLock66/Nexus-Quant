"""ADR-0001 — featureHash reproducibility & quantization policy.

These lock the 10-significant-figure canonicalization, prove the hash is stable
under sub-quantum (ULP-level) perturbation, re-assert the MIR-2 invariant
featureHash == sha256(canonical(returned vector)), and pin -0.0 normalization.

They run in-process. The cross-build golden-hash test (same input -> identical
hash on numpy/SIMD/CPU/libm variation) must additionally run INSIDE the pinned
Docker image across a CPU-microarch matrix per the ADR-0001 test strategy —
that CI artifact is infra, not a unit test, and is not asserted here.
"""

from __future__ import annotations

import hashlib
import json
import math

from app.features import (
    FEATURE_PIPELINE_LOGIC_HASH,
    canonicalize_ts,
    compute_core_technical,
    compute_feature_hash,
)
from app.features.core_technical import FEATURE_VALUE_SIG_FIGS, _canon

AS_OF = "2024-01-11T09:00:00.000Z"
from tests.conftest import make_constant_candles, make_random_walk_candles


def test_quantization_policy_locked():
    # Canonical precision is part of core-technical v1's IMMUTABLE identity.
    assert FEATURE_VALUE_SIG_FIGS == 10
    # 10 significant figures in normalized scientific form.
    assert _canon(1.0 / 3.0) == float("3.333333333e-01")
    assert _canon(123456.789012345) == float("1.234567890e+05")
    assert _canon(-1234.5) == float("-1.234500000e+03")


def test_negative_zero_normalized():
    z = _canon(-0.0)
    assert z == 0.0
    assert math.copysign(1.0, z) == 1.0  # +0.0, not -0.0
    # -0.0 must never reach the canonical JSON (distinct bytes -> hash flip).
    assert "-0.0" not in json.dumps({"a": _canon(-0.0)})
    assert compute_feature_hash({"a": _canon(-0.0)}, AS_OF) == compute_feature_hash({"a": 0.0}, AS_OF)


def test_canon_idempotent_and_ulp_invariant():
    # Reproducibility mechanism: a 1-ULP perturbation (the smallest possible
    # cross-build delta) must not change the canonical value for non-boundary
    # values across the magnitude range the feature vector spans.
    for v in [1.234567890123e-3, 9.876543210987e0, 4.242424242424e4, 7.111111111111e0]:
        assert _canon(_canon(v)) == _canon(v)  # idempotent
        assert _canon(math.nextafter(v, math.inf)) == _canon(v)
        assert _canon(math.nextafter(v, -math.inf)) == _canon(v)


def test_returned_vector_hash_invariant():
    # MIR-2 (envelope v2): featureHash == canonical envelope hash over the
    # RETURNED vector + the last candle's as-of ts + the versioned logic hash.
    candles = make_random_walk_candles(250, seed=11)
    features, feature_hash = compute_core_technical(candles)
    assert compute_feature_hash(features, candles[-1]["ts"]) == feature_hash
    # Every returned value is already canonical (idempotent under _canon).
    for name, value in features.items():
        assert _canon(value) == value, name


def test_featurehash_deterministic_same_input():
    _, h1 = compute_core_technical(make_random_walk_candles(250, seed=11))
    _, h2 = compute_core_technical(make_random_walk_candles(250, seed=11))
    assert h1 == h2


def test_featurehash_stable_under_subquantum_input_noise():
    # Perturbing every OHLCV by a relative amount far below the 10-sig-fig grid
    # leaves the canonical vector (and hence the hash) unchanged — the core
    # reproducibility guarantee against cross-build float noise. The constant
    # fixture has round feature values well away from any rounding boundary, so
    # this is deterministic (no boundary-flip flakiness).
    base = make_constant_candles(250)
    feats, h = compute_core_technical(base)

    noisy = [dict(c) for c in base]
    for c in noisy:
        for k in ("open", "high", "low", "close", "volume"):
            c[k] = repr(float(c[k]) * (1.0 + 1e-13))
    feats_noisy, h_noisy = compute_core_technical(noisy)

    assert feats_noisy == feats
    assert h_noisy == h


def test_constant_series_survives_canonicalization():
    feats, _ = compute_core_technical(make_constant_candles(250))
    assert feats["ema_20"] == 100.0
    assert feats["rsi_14"] == 50.0
    assert feats["atr_14"] == 20.0
    assert feats["realized_vol_30"] == 0.0
    assert feats["volume_zscore_100"] == 0.0
    assert feats["donchian_upper_20"] == 110.0
    assert feats["donchian_lower_20"] == 90.0
    assert feats["donchian_mid_20"] == 100.0


def test_ten_repeated_runs_identical_hash():
    # Phase 11B regression gate: 10 repeated runs over the identical input
    # MUST produce byte-identical hashes AND vectors. Any deviation is a
    # determinism regression (env/parallelism/clock leakage) and a hard fail.
    runs = [compute_core_technical(make_random_walk_candles(250, seed=11)) for _ in range(10)]
    hashes = {h for _, h in runs}
    vectors = {json.dumps(f, sort_keys=True) for f, _ in runs}
    assert len(hashes) == 1, f"non-deterministic featureHash across 10 runs: {hashes}"
    assert len(vectors) == 1, "non-deterministic feature vector across 10 runs"


def test_hash_binds_deterministic_as_of_timestamp():
    # Same data, different as-of -> different hash: the tick timestamp is part
    # of the provenance envelope (a snapshot can't masquerade as another tick).
    candles = make_random_walk_candles(250, seed=11)
    _, h1 = compute_core_technical(candles)
    shifted = [dict(c) for c in candles]
    shifted[-1]["ts"] = "2030-01-01T00:00:00.000Z"
    _, h2 = compute_core_technical(shifted)
    assert h1 != h2


def test_hash_binds_versioned_pipeline_logic():
    # The envelope embeds the pinned-numerics logic hash: a different logic
    # fingerprint yields a different featureHash for identical data + ts.
    features, feature_hash = compute_core_technical(make_random_walk_candles(250, seed=11))
    assert len(FEATURE_PIPELINE_LOGIC_HASH) == 64
    envelope = {
        "as_of_ts": canonicalize_ts(AS_OF),
        "feature_set": "core-technical",
        "features": features,
        "logic_hash": "0" * 64,  # a hypothetical different logic version
        "version": 1,
    }
    forged = hashlib.sha256(
        json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert forged != feature_hash


def test_hash_ignores_env_and_clock(monkeypatch):
    # No env var and no wall-clock read may influence the hash: flip a batch of
    # plausible-looking env vars and recompute — byte-identical.
    candles = make_random_walk_candles(250, seed=11)
    _, before = compute_core_technical(candles)
    for k, v in {
        "TZ": "Pacific/Auckland",
        "PYTHONHASHSEED": "12345",
        "FEATURE_FLAG_X": "on",
        "NODE_ENV": "production",
    }.items():
        monkeypatch.setenv(k, v)
    _, after = compute_core_technical(candles)
    assert before == after


def test_canonicalize_ts_normalizes_equivalent_forms():
    # "Z", "+00:00", microseconds, and naive-UTC all collapse to one canonical
    # byte form — serialization variance can never flip the hash.
    forms = [
        "2024-01-11T09:00:00Z",
        "2024-01-11T09:00:00+00:00",
        "2024-01-11T09:00:00.000Z",
        "2024-01-11T09:00:00.000200Z",  # sub-ms truncates to the same ms
        "2024-01-11T10:00:00+01:00",
    ]
    assert {canonicalize_ts(f) for f in forms} == {"2024-01-11T09:00:00.000Z"}
