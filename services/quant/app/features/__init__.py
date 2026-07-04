"""Feature Store computation (FS, Python side).

Quant computes feature vectors and the canonical featureHash; TypeScript
owns DQ >= 90 admission and FeatureSnapshot persistence. Phase 1 ships the
TECHNICAL domain's `core-technical` v1 set; the other four domains (Options,
Flow, Regime, Risk) land with their data dependencies in later phases.
"""

from app.features.core_technical import (
    FEATURE_PIPELINE_LOGIC_HASH,
    FEATURE_SET_NAME,
    FEATURE_SET_VERSION,
    MIN_CANDLES,
    FeatureComputationError,
    InsufficientDataError,
    InvalidMarketDataError,
    canonicalize_ts,
    compute_core_technical,
    compute_feature_hash,
)

__all__ = [
    "FEATURE_PIPELINE_LOGIC_HASH",
    "FEATURE_SET_NAME",
    "FEATURE_SET_VERSION",
    "MIN_CANDLES",
    "FeatureComputationError",
    "InsufficientDataError",
    "InvalidMarketDataError",
    "canonicalize_ts",
    "compute_core_technical",
    "compute_feature_hash",
]
