"""Pydantic schemas for the internal quant API.

Hand-written to match docs/architecture/03-api-design.md; the
packages/core/contracts JSON-Schema generation pipeline lands in a later
phase, at which point these modules become generated artifacts.
"""

from app.schemas.dq import (
    CandleIn,
    StatisticalCheckOut,
    StatisticalRequest,
    StatisticalResponse,
)
from app.schemas.features import (
    FeatureComputeRequest,
    FeatureComputeResponse,
    FeatureScope,
    MarketData,
)

__all__ = [
    "CandleIn",
    "StatisticalCheckOut",
    "StatisticalRequest",
    "StatisticalResponse",
    "FeatureComputeRequest",
    "FeatureComputeResponse",
    "FeatureScope",
    "MarketData",
]
