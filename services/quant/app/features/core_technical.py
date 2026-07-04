"""core-technical v1 feature set (TECHNICAL domain).

Spec source of truth: the seeded FeatureSetDefinition in
packages/db/prisma/seed.ts —

    ema    periods [20, 50, 200]      rsi    period 14 (Wilder)
    atr    period 14 (Wilder)         realized_vol  windowBars 30
    volume_zscore  windowBars 100     donchian      period 20

Pinned numerics (any change here is a NEW feature-set version, never an
edit — FeatureSetDefinitions are immutable):
  - EMA seeded with the SMA of the first `period` closes, then k=2/(period+1).
  - RSI/ATR use Wilder smoothing seeded with the simple mean of the first
    `period` deltas/true-ranges. RSI of a flat series (no gains, no losses)
    is pinned to 50.0; all-gains 100.0; all-losses 0.0.
  - realized_vol_30 = sample std (ddof=1) of the last 30 log returns,
    NOT annualized; reductions use math.fsum (order-invariant, ADR-0001).
  - volume_zscore_100 = (last - mean) / std(ddof=1) over the last 100
    volumes; pinned to 0.0 when the std is 0; reductions use math.fsum.
  - donchian_20: upper = max(high), lower = min(low) over the last 20 bars,
    mid = (upper + lower) / 2.

Reproducibility (ADR-0001): every feature value is canonicalized to 10
significant figures (`float(f"{x:.9e}")`, with -0.0 normalized to 0.0) ONCE at
final vector assembly. The canonical value IS the feature value — the same
quantized dict is hashed, returned, and persisted — so cross-build ULP noise
(numpy / SIMD width / CPU microarch / libm) cannot flip the hash, and
featureHash == sha256(canonical(persisted vector)) holds by construction.

featureHash = sha256 hex over the canonical JSON of the (quantized) feature
vector: keys sorted, separators (",", ":"), allow_nan=False (a non-finite
feature value raises instead of hashing — fail-closed). This module is the
ONLY featureHash implementation platform-wide; TS persists the value verbatim
and never recomputes it.
"""

from __future__ import annotations

import hashlib
import json
import math

import numpy as np

FEATURE_SET_NAME = "core-technical"
FEATURE_SET_VERSION = 1

# ema_200 needs 200 closes; RSI/ATR need period+1 rows; volume_zscore needs
# 100; the binding minimum is ema_200 + one prior close for the first return.
MIN_CANDLES = 201

# ADR-0001: canonical precision for feature values. 10 significant figures
# (":.9e") collapses cross-build ULP noise below the quantization grid while
# preserving every economically meaningful digit (indicators derive from
# 8-decimal OHLCV). IMMUTABLE part of core-technical v1 — changing it is a new
# feature-set version, never an edit.
FEATURE_VALUE_SIG_FIGS = 10


class FeatureComputationError(Exception):
    """Base class — carries a stable machine-readable code."""

    code = "FEATURE_COMPUTATION_ERROR"


class InsufficientDataError(FeatureComputationError):
    code = "INSUFFICIENT_DATA"


class InvalidMarketDataError(FeatureComputationError):
    code = "INVALID_MARKET_DATA"


def _parse_positive(raw: str, field: str, index: int) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError) as err:
        raise InvalidMarketDataError(
            f"candle[{index}].{field} is not numeric: {raw!r}"
        ) from err
    if not math.isfinite(value) or value <= 0.0:
        raise InvalidMarketDataError(
            f"candle[{index}].{field} must be finite and > 0, got {raw!r}"
        )
    return value


def _parse_non_negative(raw: str, field: str, index: int) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError) as err:
        raise InvalidMarketDataError(
            f"candle[{index}].{field} is not numeric: {raw!r}"
        ) from err
    if not math.isfinite(value) or value < 0.0:
        raise InvalidMarketDataError(
            f"candle[{index}].{field} must be finite and >= 0, got {raw!r}"
        )
    return value


def _ema(closes: np.ndarray, period: int) -> float:
    k = 2.0 / (period + 1.0)
    ema = math.fsum(closes[:period].tolist()) / period
    for value in closes[period:]:
        ema = (float(value) - ema) * k + ema
    return ema


def _rsi_wilder(closes: np.ndarray, period: int) -> float:
    deltas = np.diff(closes)
    gains = np.where(deltas > 0.0, deltas, 0.0)
    losses = np.where(deltas < 0.0, -deltas, 0.0)
    avg_gain = math.fsum(gains[:period].tolist()) / period
    avg_loss = math.fsum(losses[:period].tolist()) / period
    for i in range(period, deltas.size):
        avg_gain = (avg_gain * (period - 1) + float(gains[i])) / period
        avg_loss = (avg_loss * (period - 1) + float(losses[i])) / period
    if avg_gain == 0.0 and avg_loss == 0.0:
        return 50.0
    if avg_loss == 0.0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


def _atr_wilder(
    highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int
) -> float:
    prev_closes = closes[:-1]
    h = highs[1:]
    l = lows[1:]
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev_closes), np.abs(l - prev_closes)))
    atr = math.fsum(tr[:period].tolist()) / period
    for value in tr[period:]:
        atr = (atr * (period - 1) + float(value)) / period
    return atr


def _canon(x: float) -> float:
    """Quantize to FEATURE_VALUE_SIG_FIGS significant figures (normalized
    scientific) and normalize -0.0 -> 0.0 (ADR-0001).

    Applied exactly once at vector assembly so the canonical value is what gets
    hashed AND returned AND persisted — no raw-vs-quantized split (MIR-1/MIR-2).
    `:.9e` = 1 digit before the point + 9 after = 10 significant figures.
    """
    q = float(f"{x:.{FEATURE_VALUE_SIG_FIGS - 1}e}")
    return 0.0 if q == 0.0 else q


def compute_feature_hash(features: dict[str, float]) -> str:
    canonical = json.dumps(
        features, sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def compute_core_technical(
    candles: list[dict[str, str]],
) -> tuple[dict[str, float], str]:
    """Compute the v1 vector as-of the LAST candle in the (ascending) batch.

    `candles` items carry decimal-string OHLCV under keys open/high/low/
    close/volume. Raises InsufficientDataError / InvalidMarketDataError —
    the router maps them to structured 422s.
    """
    if len(candles) < MIN_CANDLES:
        raise InsufficientDataError(
            f"core-technical v1 requires >= {MIN_CANDLES} candles, got {len(candles)}"
        )

    closes = np.array(
        [_parse_positive(c["close"], "close", i) for i, c in enumerate(candles)]
    )
    highs = np.array(
        [_parse_positive(c["high"], "high", i) for i, c in enumerate(candles)]
    )
    lows = np.array(
        [_parse_positive(c["low"], "low", i) for i, c in enumerate(candles)]
    )
    volumes = np.array(
        [_parse_non_negative(c["volume"], "volume", i) for i, c in enumerate(candles)]
    )

    # np.log is the irreducible transcendental (kept); np.diff is exact
    # elementwise subtraction. Reductions use math.fsum for order-invariance
    # (ADR-0001) so accumulation order cannot perturb the result across builds.
    log_returns = np.diff(np.log(closes[-31:])).tolist()
    n_r = len(log_returns)
    mean_r = math.fsum(log_returns) / n_r
    realized_vol = math.sqrt(
        math.fsum((r - mean_r) ** 2 for r in log_returns) / (n_r - 1)
    )

    vol_window = volumes[-100:].tolist()
    n_v = len(vol_window)
    mean_v = math.fsum(vol_window) / n_v
    vol_std = math.sqrt(
        math.fsum((v - mean_v) ** 2 for v in vol_window) / (n_v - 1)
    )
    volume_zscore = 0.0 if vol_std == 0.0 else (vol_window[-1] - mean_v) / vol_std

    donchian_upper = float(np.max(highs[-20:]))
    donchian_lower = float(np.min(lows[-20:]))

    raw: dict[str, float] = {
        "ema_20": _ema(closes, 20),
        "ema_50": _ema(closes, 50),
        "ema_200": _ema(closes, 200),
        "rsi_14": _rsi_wilder(closes, 14),
        "atr_14": _atr_wilder(highs, lows, closes, 14),
        "realized_vol_30": realized_vol,
        "volume_zscore_100": volume_zscore,
        "donchian_upper_20": donchian_upper,
        "donchian_lower_20": donchian_lower,
        "donchian_mid_20": (donchian_upper + donchian_lower) / 2.0,
    }

    # Fail-closed on the RAW values before canonicalization (ADR-0001 order).
    for name, value in raw.items():
        if not math.isfinite(value):
            raise InvalidMarketDataError(
                f"feature {name} is non-finite — refusing to hash/emit (fail-closed)"
            )

    # Canonicalize ONCE (MIR-1): the quantized dict is hashed AND returned, so
    # featureHash == sha256(canonical(persisted vector)) holds (MIR-2).
    features = {name: _canon(value) for name, value in raw.items()}
    return features, compute_feature_hash(features)
