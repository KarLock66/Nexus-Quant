"""Shared-secret guard for the internal quant API.

The service is network-isolated (Docker network); the shared secret is a
defense-in-depth second factor, not the primary boundary.

FAIL-CLOSED in production: when the deployment marks the secret REQUIRED
(``QUANT_REQUIRE_SECRET`` truthy — the production compose sets it) the service
refuses to start without ``QUANT_SERVICE_SHARED_SECRET``, so the guard can never
silently degrade to a no-op on a live deployment. When neither is set (local
dev), the check is a no-op so the platform stays runnable without configuration.
"""

import hmac
import os

from fastapi import Header, HTTPException

_TRUTHY = {"1", "true", "yes", "on"}


def _secret() -> str:
    return os.environ.get("QUANT_SERVICE_SHARED_SECRET", "").strip()


def _secret_required() -> bool:
    return os.environ.get("QUANT_REQUIRE_SECRET", "").strip().lower() in _TRUTHY


def require_secret_configured() -> None:
    """Startup guard: when the secret is marked REQUIRED it must actually be set,
    or the service refuses to start rather than serve with an open auth guard.
    Called at import time from app.main so a misconfigured production image fails
    fast instead of exposing an unauthenticated internal API."""
    if _secret_required() and _secret() == "":
        raise RuntimeError(
            "QUANT_SERVICE_SHARED_SECRET is required (QUANT_REQUIRE_SECRET is set) "
            "but unset — refusing to start with an unauthenticated internal API"
        )


def verify_internal_secret(
    x_internal_secret: str | None = Header(default=None),
) -> None:
    expected = _secret()
    if not expected:
        # No secret configured. In a REQUIRED deployment this branch is
        # unreachable (require_secret_configured fails startup); reaching it there
        # anyway is a misconfiguration, so refuse rather than admit. In local dev
        # (not required) it is the intended no-op.
        if _secret_required():
            raise HTTPException(status_code=503, detail="internal auth not configured")
        return
    if x_internal_secret is None or not hmac.compare_digest(
        x_internal_secret, expected
    ):
        raise HTTPException(status_code=401, detail="invalid internal secret")
