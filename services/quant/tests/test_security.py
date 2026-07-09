"""Fail-closed behavior of the internal auth guard (QUANT_REQUIRE_SECRET).

The happy-path 401/200 header checks live with the routers
(test_dq_statistical, test_features); this file covers the REQUIRED-mode
startup gate and its request-time backstop.
"""

import pytest

from app.security import require_secret_configured

from tests.conftest import make_random_walk_candles


def test_startup_guard_noop_when_not_required(monkeypatch):
    monkeypatch.delenv("QUANT_REQUIRE_SECRET", raising=False)
    monkeypatch.delenv("QUANT_SERVICE_SHARED_SECRET", raising=False)
    require_secret_configured()  # must not raise


@pytest.mark.parametrize("flag", ["1", "true", "YES", " on "])
def test_startup_guard_refuses_required_without_secret(monkeypatch, flag):
    monkeypatch.setenv("QUANT_REQUIRE_SECRET", flag)
    monkeypatch.delenv("QUANT_SERVICE_SHARED_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="QUANT_SERVICE_SHARED_SECRET"):
        require_secret_configured()


def test_startup_guard_treats_blank_secret_as_unset(monkeypatch):
    monkeypatch.setenv("QUANT_REQUIRE_SECRET", "1")
    monkeypatch.setenv("QUANT_SERVICE_SHARED_SECRET", "   ")
    with pytest.raises(RuntimeError):
        require_secret_configured()


@pytest.mark.parametrize("flag", ["", "0", "false", "off"])
def test_startup_guard_ignores_non_truthy_flags(monkeypatch, flag):
    monkeypatch.setenv("QUANT_REQUIRE_SECRET", flag)
    monkeypatch.delenv("QUANT_SERVICE_SHARED_SECRET", raising=False)
    require_secret_configured()  # must not raise


def test_startup_guard_passes_when_required_and_configured(monkeypatch):
    monkeypatch.setenv("QUANT_REQUIRE_SECRET", "1")
    monkeypatch.setenv("QUANT_SERVICE_SHARED_SECRET", "s3cret")
    require_secret_configured()  # must not raise


def test_required_mode_without_secret_refuses_requests(client, monkeypatch):
    # Backstop for the "unreachable" branch: if a REQUIRED process somehow
    # runs with no secret, requests are refused (503) instead of admitted.
    monkeypatch.setenv("QUANT_REQUIRE_SECRET", "1")
    body = {"candles": make_random_walk_candles(10), "referenceCloses": None}
    res = client.post("/dq/statistical", json=body)
    assert res.status_code == 503
    assert res.json()["detail"] == "internal auth not configured"


def test_required_mode_with_secret_still_enforces_header(client, monkeypatch):
    monkeypatch.setenv("QUANT_REQUIRE_SECRET", "1")
    monkeypatch.setenv("QUANT_SERVICE_SHARED_SECRET", "s3cret")
    body = {"candles": make_random_walk_candles(10), "referenceCloses": None}

    assert client.post("/dq/statistical", json=body).status_code == 401
    assert (
        client.post(
            "/dq/statistical", json=body, headers={"X-Internal-Secret": "s3cret"}
        ).status_code
        == 200
    )
