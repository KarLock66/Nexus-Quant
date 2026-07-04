"""POST /features/compute — Feature Store vector computation.

Quant is stateless: the TypeScript caller verifies DQ >= 90 BEFORE calling
and persists the FeatureSnapshot AFTER. The dq_score check here is
defense-in-depth only (mirroring the dual-layer confidenceAdjustment <= 0
constraint): even a buggy caller cannot obtain features from inadmissible
data.

Error codes (HTTP status / detail.code):
    409 DQ_BELOW_MINIMUM      dq_score < 90
    422 UNKNOWN_FEATURE_SET   feature_set/version not served by this build
    422 INSUFFICIENT_DATA     fewer candles than the set's pinned minimum
    422 INVALID_MARKET_DATA   non-finite / non-positive OHLCV input
    422 SCOPE_TS_MISMATCH     scope.ts != last candle ts (lookahead guard)
"""

from fastapi import APIRouter, Depends, HTTPException

from app.constants import MIN_DATA_QUALITY_SCORE
from app.features import (
    FEATURE_SET_NAME,
    FEATURE_SET_VERSION,
    FeatureComputationError,
    compute_core_technical,
)
from app.schemas.features import FeatureComputeRequest, FeatureComputeResponse
from app.security import verify_internal_secret

router = APIRouter(
    prefix="/features",
    tags=["features"],
    dependencies=[Depends(verify_internal_secret)],
)


@router.post("/compute", response_model=FeatureComputeResponse)
def compute(req: FeatureComputeRequest) -> FeatureComputeResponse:
    if req.feature_set != FEATURE_SET_NAME or req.version != FEATURE_SET_VERSION:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "UNKNOWN_FEATURE_SET",
                "message": (
                    f"this build serves only {FEATURE_SET_NAME} "
                    f"v{FEATURE_SET_VERSION}, got {req.feature_set} v{req.version}"
                ),
            },
        )

    if req.dq_score < MIN_DATA_QUALITY_SCORE:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "DQ_BELOW_MINIMUM",
                "message": (
                    f"dq_score {req.dq_score} < {MIN_DATA_QUALITY_SCORE} — "
                    "features may only be computed from admitted data"
                ),
            },
        )

    candles = req.market_data.candles
    if len(candles) == 0:
        raise HTTPException(
            status_code=422,
            detail={"code": "INSUFFICIENT_DATA", "message": "no candles provided"},
        )

    as_of_ts = candles[-1].ts
    if req.scope.ts is not None and req.scope.ts != as_of_ts:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "SCOPE_TS_MISMATCH",
                "message": (
                    f"scope.ts {req.scope.ts.isoformat()} != last candle ts "
                    f"{as_of_ts.isoformat()} — refusing to mislabel point-in-time"
                ),
            },
        )

    try:
        features, feature_hash = compute_core_technical(
            [
                {
                    "open": c.open,
                    "high": c.high,
                    "low": c.low,
                    "close": c.close,
                    "volume": c.volume,
                }
                for c in candles
            ]
        )
    except FeatureComputationError as err:
        raise HTTPException(
            status_code=422,
            detail={"code": err.code, "message": str(err)},
        ) from err

    return FeatureComputeResponse(
        feature_set=FEATURE_SET_NAME,
        version=FEATURE_SET_VERSION,
        as_of_ts=as_of_ts,
        features=features,
        featureHash=feature_hash,
        input_candle_count=len(candles),
        dq_report_id=req.dq_report_id,
    )
