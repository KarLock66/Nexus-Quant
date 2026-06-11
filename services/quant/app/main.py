"""FastAPI entrypoint (Phase 0 skeleton).

Routers land per phase:
  Phase 1: /dq/statistical, /features/compute
  Phase 2: /sizing/calculate
  Phase 3: /indicators/compute, /regime/classify
  Phase 4: /backtest, /walkforward, /montecarlo, /stress, /metrics/compute
  Phase 7: /portfolio/correlation, /portfolio/allocate, /capacity/assess
"""

from datetime import datetime, timezone

from fastapi import FastAPI

from app import __version__

app = FastAPI(
    title="Nexus Quant Service",
    version=__version__,
    description=(
        "Internal computation service for Nexus Quant. "
        "Network-isolated; returns numbers, never decisions."
    ),
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "quant",
        "version": __version__,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
