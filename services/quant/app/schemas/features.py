"""Request/response models for POST /features/compute.

Contract per docs/architecture/03-api-design.md: request
`{scope, feature_set, version, market_data}` (snake_case, like every internal
quant endpoint) plus the admitting DQ report's score/id. Response carries the
computed vector and the canonical `featureHash` (doc-pinned key name).

Quant is stateless: the TypeScript caller verifies DQ >= 90 BEFORE calling
and persists the FeatureSnapshot AFTER. The dq_score here only enables the
service's defense-in-depth refusal — it is never the primary admission gate.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.dq import CandleIn


class FeatureScope(BaseModel):
    exchange: str
    symbol: str
    timeframe: str
    # When provided, must equal the last candle's ts — guards against the
    # caller mislabelling a snapshot's point-in-time (lookahead protection).
    ts: datetime | None = None


class MarketData(BaseModel):
    candles: list[CandleIn]


class FeatureComputeRequest(BaseModel):
    scope: FeatureScope
    feature_set: str
    version: int
    market_data: MarketData
    dq_score: int = Field(ge=0, le=100)
    dq_report_id: str | None = None


class FeatureComputeResponse(BaseModel):
    feature_set: str
    version: int
    as_of_ts: datetime
    features: dict[str, float]
    featureHash: str
    input_candle_count: int
    dq_report_id: str | None = None
