"""Nexus Quant computation service.

Stateless FastAPI sidecar. Returns measurements; never makes risk
decisions - pass/fail decisions belong exclusively to the TypeScript
gate layer (packages/core/gates).
"""

__version__ = "0.1.0"
