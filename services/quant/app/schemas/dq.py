"""Request/response models for POST /dq/statistical.

Wire contract is owned by services/ingestion/src/dq/stage-b-client.ts:
request `{candles: [{ts, open, high, low, close, volume}], referenceCloses}`
with OHLCV as decimal STRINGS (platform decimal discipline), response
`{checks: [{check, passed, deduction, detail}]}` — the client also accepts a
bare array, but the envelope form matches the API design doc.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class CandleIn(BaseModel):
    ts: datetime
    open: str
    high: str
    low: str
    close: str
    volume: str

    @field_validator("open", "high", "low", "close", "volume", mode="before")
    @classmethod
    def _coerce_numeric_to_string(cls, value: object) -> object:
        # The TS client always sends strings; accept bare numbers defensively.
        if isinstance(value, (int, float)):
            return repr(value)
        return value


class StatisticalRequest(BaseModel):
    candles: list[CandleIn]
    referenceCloses: list[str | float] | None = Field(default=None)


class StatisticalCheckOut(BaseModel):
    check: str
    passed: bool
    deduction: float
    detail: str


class StatisticalResponse(BaseModel):
    checks: list[StatisticalCheckOut]
