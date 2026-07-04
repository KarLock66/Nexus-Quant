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

import json
import math

from app.features import compute_core_technical, compute_feature_hash
from app.features.core_technical import FEATURE_VALUE_SIG_FIGS, _canon
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
    assert compute_feature_hash({"a": _canon(-0.0)}) == compute_feature_hash({"a": 0.0})


def test_canon_idempotent_and_ulp_invariant():
    # Reproducibility mechanism: a 1-ULP perturbation (the smallest possible
    # cross-build delta) must not change the canonical value for non-boundary
    # values across the magnitude range the feature vector spans.
    for v in [1.234567890123e-3, 9.876543210987e0, 4.242424242424e4, 7.111111111111e0]:
        assert _canon(_canon(v)) == _canon(v)  # idempotent
        assert _canon(math.nextafter(v, math.inf)) == _canon(v)
        assert _canon(math.nextafter(v, -math.inf)) == _canon(v)


def test_returned_vector_hash_invariant():
    # MIR-2: featureHash == sha256(canonical JSON of the RETURNED vector).
    candles = make_random_walk_candles(250, seed=11)
    features, feature_hash = compute_core_technical(candles)
    assert compute_feature_hash(features) == feature_hash
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
