"""Stage-B statistical check implementations.

Numbers discipline: OHLCV values arrive as decimal strings (the platform-wide
wire format — see services/ingestion/src/connectors/types.ts). Rows that do
not parse to finite positive numbers are excluded from the statistics and
counted in the check detail; penalising them is Stage A's job
(schema_conformance), not Stage B's.

Outlier threshold: the classic Iglewicz–Hoaglin cutoff is |z| > 3.5, but
crypto returns are fat-tailed and a genuine 5-sigma hour must not be scored
as corrupt data. The pinned threshold |z| > 10 separates data-error-grade
prints (exchange glitches, decimal shifts — typically z >> 50) from real
volatility.

Fail-closed: an exception inside any individual check is converted into a
failed check carrying its full weight; the endpoint never silently drops a
check from the catalog.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import stats as scipy_stats

# Pinned catalog weights — MUST sum to 15 (= STAGE_B_UNAVAILABLE_DEDUCTION in
# services/ingestion/src/dq/stage-b-client.ts). test_dq_statistical.py asserts this.
STAGE_B_WEIGHTS = {
    "price_outliers": 6,
    "volume_anomaly": 4,
    "distribution_drift": 3,
    "cross_exchange_divergence": 2,
}

MODIFIED_Z_THRESHOLD = 10.0
PER_OUTLIER_DEDUCTION = 2
# KS-statistic geometry: two zero-centred return distributions cap out near
# D = 0.5 even under extreme variance corruption (both CDFs pass through 0.5
# at zero), so the corruption bar must sit BELOW 0.5. D = 0.35 fires on
# corruption-grade shifts (stuck feed ~= 0.5, unit mix-up ~= 0.46) and passes
# legitimate vol-regime changes (sigma-ratio 3 ~= 0.24). The p-value bound is
# extreme because batch sizes make innocuous differences "significant".
DRIFT_MIN_RETURNS = 60
DRIFT_KS_STAT_THRESHOLD = 0.35
DRIFT_KS_PVALUE_THRESHOLD = 1e-6
DIVERGENCE_PCT_THRESHOLD = 1.0


@dataclass(frozen=True)
class StatisticalCheckResult:
    check: str
    passed: bool
    deduction: float
    detail: str


def _parse_finite(raw: str | float | int) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _modified_zscores(values: np.ndarray) -> np.ndarray:
    """Iglewicz–Hoaglin modified z-scores: 0.6745 * (x - median) / MAD.

    When MAD is 0 (over half the values identical) fall back to the mean
    absolute deviation scaled by 1.2533; when that is also 0 the series is
    constant and every score is 0 by definition.
    """
    median = float(np.median(values))
    abs_dev = np.abs(values - median)
    mad = float(np.median(abs_dev))
    if mad > 0.0:
        return 0.6745 * (values - median) / mad
    mean_ad = float(np.mean(abs_dev))
    if mean_ad > 0.0:
        return (values - median) / (1.2533 * mean_ad)
    return np.zeros_like(values)


def _log_returns(closes: list[str | float | int]) -> tuple[np.ndarray, int]:
    """Log returns between consecutive parseable positive closes.

    Returns (returns, skipped_row_count). A skipped row joins its neighbours
    into one cross-gap return — acceptable for batch statistics, and the skip
    count is surfaced in the check detail.
    """
    valid: list[float] = []
    skipped = 0
    for raw in closes:
        value = _parse_finite(raw)
        if value is None or value <= 0.0:
            skipped += 1
            continue
        valid.append(value)
    if len(valid) < 2:
        return np.empty(0), skipped
    arr = np.array(valid, dtype=np.float64)
    return np.diff(np.log(arr)), skipped


def check_price_outliers(closes: list[str | float | int]) -> StatisticalCheckResult:
    weight = STAGE_B_WEIGHTS["price_outliers"]
    returns, skipped = _log_returns(closes)
    suffix = f"; skipped {skipped} unparseable/non-positive row(s)" if skipped else ""
    if returns.size < 3:
        return StatisticalCheckResult(
            check="price_outliers",
            passed=True,
            deduction=0,
            detail=f"insufficient returns for outlier analysis ({returns.size}){suffix}",
        )
    z = _modified_zscores(returns)
    outliers = int(np.count_nonzero(np.abs(z) > MODIFIED_Z_THRESHOLD))
    passed = outliers == 0
    deduction = 0 if passed else min(weight, outliers * PER_OUTLIER_DEDUCTION)
    worst = float(np.max(np.abs(z)))
    return StatisticalCheckResult(
        check="price_outliers",
        passed=passed,
        deduction=deduction,
        detail=(
            f"{returns.size} returns analyzed, {outliers} outlier(s) with "
            f"|modified z| > {MODIFIED_Z_THRESHOLD:g} (worst {worst:.1f}){suffix}"
        ),
    )


def check_volume_anomaly(volumes: list[str | float | int]) -> StatisticalCheckResult:
    weight = STAGE_B_WEIGHTS["volume_anomaly"]
    valid: list[float] = []
    skipped = 0
    for raw in volumes:
        value = _parse_finite(raw)
        if value is None or value < 0.0:
            skipped += 1
            continue
        valid.append(value)
    suffix = f"; skipped {skipped} unparseable/negative row(s)" if skipped else ""
    if len(valid) < 3:
        return StatisticalCheckResult(
            check="volume_anomaly",
            passed=True,
            deduction=0,
            detail=f"insufficient volumes for anomaly analysis ({len(valid)}){suffix}",
        )
    z = _modified_zscores(np.log1p(np.array(valid, dtype=np.float64)))
    anomalies = int(np.count_nonzero(np.abs(z) > MODIFIED_Z_THRESHOLD))
    passed = anomalies == 0
    deduction = 0 if passed else min(weight, anomalies * PER_OUTLIER_DEDUCTION)
    worst = float(np.max(np.abs(z)))
    return StatisticalCheckResult(
        check="volume_anomaly",
        passed=passed,
        deduction=deduction,
        detail=(
            f"{len(valid)} volumes analyzed, {anomalies} anomaly(ies) with "
            f"|modified z| > {MODIFIED_Z_THRESHOLD:g} on log1p scale (worst {worst:.1f}){suffix}"
        ),
    )


def check_distribution_drift(closes: list[str | float | int]) -> StatisticalCheckResult:
    """Two-sample KS between the first and second half of the return series.

    Detects wholesale distribution changes inside one batch (unit changes,
    decimal shifts, venue symbol swaps) — not ordinary regime drift, hence
    the deliberately extreme thresholds.
    """
    weight = STAGE_B_WEIGHTS["distribution_drift"]
    returns, skipped = _log_returns(closes)
    suffix = f"; skipped {skipped} unparseable/non-positive row(s)" if skipped else ""
    if returns.size < DRIFT_MIN_RETURNS:
        return StatisticalCheckResult(
            check="distribution_drift",
            passed=True,
            deduction=0,
            detail=(
                f"insufficient returns for drift analysis "
                f"({returns.size} < {DRIFT_MIN_RETURNS}){suffix}"
            ),
        )
    half = returns.size // 2
    result = scipy_stats.ks_2samp(returns[:half], returns[half:])
    statistic = float(result.statistic)
    pvalue = float(result.pvalue)
    drifted = (
        statistic > DRIFT_KS_STAT_THRESHOLD and pvalue < DRIFT_KS_PVALUE_THRESHOLD
    )
    return StatisticalCheckResult(
        check="distribution_drift",
        passed=not drifted,
        deduction=weight if drifted else 0,
        detail=(
            f"KS two-sample over {half}+{returns.size - half} returns: "
            f"statistic={statistic:.4f}, pvalue={pvalue:.2e} "
            f"(drift iff statistic > {DRIFT_KS_STAT_THRESHOLD:g} "
            f"and pvalue < {DRIFT_KS_PVALUE_THRESHOLD:g}){suffix}"
        ),
    )


def check_cross_exchange_divergence(
    closes: list[str | float | int],
    reference_closes: list[str | float | int] | None,
) -> StatisticalCheckResult:
    """Per-bar close vs reference-venue close.

    `reference_closes = null` is the documented "no reference available"
    sentinel and passes vacuously. A reference of the WRONG LENGTH is an
    integration bug, not an absence — that fails with full weight
    (fail-closed, never silent).
    """
    weight = STAGE_B_WEIGHTS["cross_exchange_divergence"]
    if reference_closes is None:
        return StatisticalCheckResult(
            check="cross_exchange_divergence",
            passed=True,
            deduction=0,
            detail="no reference closes provided — divergence not assessable",
        )
    if len(reference_closes) != len(closes):
        return StatisticalCheckResult(
            check="cross_exchange_divergence",
            passed=False,
            deduction=weight,
            detail=(
                f"reference length mismatch ({len(reference_closes)} != "
                f"{len(closes)}) — fail-closed"
            ),
        )
    divergent = 0
    compared = 0
    worst_pct = 0.0
    for raw_close, raw_ref in zip(closes, reference_closes):
        close = _parse_finite(raw_close)
        ref = _parse_finite(raw_ref)
        if close is None or ref is None or close <= 0.0 or ref <= 0.0:
            continue
        compared += 1
        pct = abs(close / ref - 1.0) * 100.0
        worst_pct = max(worst_pct, pct)
        if pct > DIVERGENCE_PCT_THRESHOLD:
            divergent += 1
    passed = divergent == 0
    return StatisticalCheckResult(
        check="cross_exchange_divergence",
        passed=passed,
        deduction=0 if passed else weight,
        detail=(
            f"{compared} bars compared, {divergent} divergent beyond "
            f"{DIVERGENCE_PCT_THRESHOLD:g}% (worst {worst_pct:.3f}%)"
        ),
    )


def run_statistical_checks(
    closes: list[str | float | int],
    volumes: list[str | float | int],
    reference_closes: list[str | float | int] | None,
) -> list[StatisticalCheckResult]:
    """Run the full pinned catalog; a check that raises becomes a failed
    check at full weight (mirrors runGateChain in packages/core/gates)."""
    runners = [
        ("price_outliers", lambda: check_price_outliers(closes)),
        ("volume_anomaly", lambda: check_volume_anomaly(volumes)),
        ("distribution_drift", lambda: check_distribution_drift(closes)),
        (
            "cross_exchange_divergence",
            lambda: check_cross_exchange_divergence(closes, reference_closes),
        ),
    ]
    results: list[StatisticalCheckResult] = []
    for name, runner in runners:
        try:
            results.append(runner())
        except Exception as err:  # noqa: BLE001 — fail-closed by design
            results.append(
                StatisticalCheckResult(
                    check=name,
                    passed=False,
                    deduction=STAGE_B_WEIGHTS[name],
                    detail=f"check evaluation error (fail-closed): {err}",
                )
            )
    return results
