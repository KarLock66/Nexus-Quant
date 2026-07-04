"""Stage-B statistical data-quality checks (M5, Python side).

Catalog and pinned weights — the four checks sum to 15, exactly the
`stage_b_unavailable` deduction the TypeScript client applies when this
service is unreachable, so Stage B costs the same whether it is down or
fully failing:

    price_outliers             6   MAD modified-z on log returns, |z| > 10
    volume_anomaly             4   MAD modified-z on log1p(volume), |z| > 10
    distribution_drift         3   two-sample KS between window halves
    cross_exchange_divergence  2   |close/reference - 1| > 1% on any bar

This module returns measurements and per-check deductions only. The
report-level PASSED/FAILED decision (score >= 90) is made exclusively by
the TypeScript DQ gateway (services/ingestion/src/dq).
"""

from app.dq.checks import (
    STAGE_B_WEIGHTS,
    StatisticalCheckResult,
    run_statistical_checks,
)

__all__ = [
    "STAGE_B_WEIGHTS",
    "StatisticalCheckResult",
    "run_statistical_checks",
]
