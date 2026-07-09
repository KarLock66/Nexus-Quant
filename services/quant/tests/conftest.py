"""Shared fixtures: TestClient + deterministic candle factories.

All fixtures are network-free and database-free. Candle factories use a
seeded numpy Generator so every run sees byte-identical inputs (the same
discipline as the TS Demo connector's seeded PRNG).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import app

H1 = timedelta(hours=1)
START = datetime(2024, 1, 1, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _no_shared_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    # Default: auth guard is a no-op; auth tests set the env vars explicitly.
    monkeypatch.delenv("QUANT_SERVICE_SHARED_SECRET", raising=False)
    monkeypatch.delenv("QUANT_REQUIRE_SECRET", raising=False)


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def make_random_walk_candles(
    n: int,
    seed: int = 7,
    sigma: float = 0.01,
    start_price: float = 100.0,
) -> list[dict[str, str]]:
    """Ascending H1 candles following a seeded lognormal random walk."""
    rng = np.random.default_rng(seed)
    log_returns = rng.normal(0.0, sigma, n)
    closes = start_price * np.exp(np.cumsum(log_returns))
    opens = np.concatenate(([start_price], closes[:-1]))
    highs = np.maximum(opens, closes) * 1.001
    lows = np.minimum(opens, closes) * 0.999
    volumes = rng.lognormal(np.log(1000.0), 0.3, n)

    out: list[dict[str, str]] = []
    for i in range(n):
        out.append(
            {
                "ts": (START + i * H1).isoformat().replace("+00:00", "Z"),
                "open": f"{opens[i]:.8f}",
                "high": f"{highs[i]:.8f}",
                "low": f"{lows[i]:.8f}",
                "close": f"{closes[i]:.8f}",
                "volume": f"{volumes[i]:.8f}",
            }
        )
    return out


def make_constant_candles(n: int) -> list[dict[str, str]]:
    """Flat fixture with exactly-known feature values (see test_features)."""
    out: list[dict[str, str]] = []
    for i in range(n):
        out.append(
            {
                "ts": (START + i * H1).isoformat().replace("+00:00", "Z"),
                "open": "100.00000000",
                "high": "110.00000000",
                "low": "90.00000000",
                "close": "100.00000000",
                "volume": "1000.00000000",
            }
        )
    return out
