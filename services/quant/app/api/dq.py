"""POST /dq/statistical — Stage-B statistical DQ checks.

Returns per-check measurements and deduction magnitudes ONLY. The
report-level score and PASSED/FAILED verdict are computed exclusively by
the TypeScript DQ gateway (services/ingestion/src/dq/score.ts). The caller
fail-closes on any non-200 (pinned stage_b_unavailable deduction), so this
endpoint never needs to degrade gracefully — a crash IS the degraded path.
"""

from fastapi import APIRouter, Depends

from app.dq import run_statistical_checks
from app.schemas.dq import (
    StatisticalCheckOut,
    StatisticalRequest,
    StatisticalResponse,
)
from app.security import verify_internal_secret

router = APIRouter(
    prefix="/dq",
    tags=["dq"],
    dependencies=[Depends(verify_internal_secret)],
)


@router.post("/statistical", response_model=StatisticalResponse)
def statistical(req: StatisticalRequest) -> StatisticalResponse:
    closes: list[str | float] = [c.close for c in req.candles]
    volumes: list[str | float] = [c.volume for c in req.candles]
    results = run_statistical_checks(closes, volumes, req.referenceCloses)
    return StatisticalResponse(
        checks=[
            StatisticalCheckOut(
                check=r.check,
                passed=r.passed,
                deduction=r.deduction,
                detail=r.detail,
            )
            for r in results
        ]
    )
