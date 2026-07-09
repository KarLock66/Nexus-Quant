"""FastAPI entrypoint.

Routers land per phase:
  Phase 1: /dq/statistical, /features/compute  (live)
  Phase 2: /sizing/calculate
  Phase 3: /indicators/compute, /regime/classify
  Phase 4: /backtest, /walkforward, /montecarlo, /stress, /metrics/compute
  Phase 7: /portfolio/correlation, /portfolio/allocate, /capacity/assess
"""

from datetime import datetime, timezone

from fastapi import FastAPI

from app import __version__
from app.api.dq import router as dq_router
from app.api.features import router as features_router
from app.security import require_secret_configured

# Fail-closed: a deployment that marks the shared secret REQUIRED
# (QUANT_REQUIRE_SECRET) must provide it, or the process refuses to boot.
require_secret_configured()

app = FastAPI(
    title="Nexus Quant Service",
    version=__version__,
    description=(
        "Internal computation service for Nexus Quant. "
        "Network-isolated; returns numbers, never decisions."
    ),
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi import Request


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    print("❌ VALIDATION ERROR:", exc.errors())
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()}
    )

app.include_router(dq_router)
app.include_router(features_router)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "quant",
        "version": __version__,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
