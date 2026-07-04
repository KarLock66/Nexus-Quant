"""Shared-secret guard for the internal quant API.

The service is network-isolated (Docker network); the shared secret is a
defense-in-depth second factor, not the primary boundary. When
QUANT_SERVICE_SHARED_SECRET is unset (local dev / demo mode), the check is a
no-op so the platform stays runnable without configuration.
"""

import hmac
import os

from fastapi import Header, HTTPException


def verify_internal_secret(
    x_internal_secret: str | None = Header(default=None),
) -> None:
    expected = os.environ.get("QUANT_SERVICE_SHARED_SECRET", "")
    if not expected:
        return
    if x_internal_secret is None or not hmac.compare_digest(
        x_internal_secret, expected
    ):
        raise HTTPException(status_code=401, detail="invalid internal secret")
