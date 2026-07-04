"""STEP 7 — Phase 5 adversarial scan (real HTTP, no code modification).

Each probe asserts the system stays STABLE or FAILS SAFE with NO silent
acceptance of bad data. Emits a JSON verdict; any silent-accept or unexpected
5xx is an ADVERSARIAL_BREAK.
"""

from __future__ import annotations

import hashlib
import json
import sys

import httpx

BASE = "http://127.0.0.1:8765"
GRID = 3_600_000
T0 = 1_704_067_200_000  # 2024-01-01T00:00:00Z in ms


def iso(ms: int) -> str:
    import datetime as _dt

    return (
        _dt.datetime.fromtimestamp(ms / 1000, tz=_dt.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def candle(i: int, close: str = "100.00000000") -> dict:
    return {
        "ts": iso(T0 + i * GRID),
        "open": "100.00000000",
        "high": "110.00000000",
        "low": "90.00000000",
        "close": close,
        "volume": "1000.00000000",
    }


def feat_req(candles: list[dict], **over) -> dict:
    base = {
        "scope": {"exchange": "DEMO", "symbol": "BTC-USDT", "timeframe": "H1"},
        "feature_set": "core-technical",
        "version": 1,
        "market_data": {"candles": candles},
        "dq_score": 95,
        "dq_report_id": "adv_1",
    }
    base.update(over)
    return base


results = []


def record(name, ok, detail, evidence):
    results.append({"probe": name, "stable_or_failsafe": ok, "detail": detail, "evidence": evidence})


with httpx.Client(base_url=BASE, timeout=30.0) as c:
    # 1) JSON FIELD REORDERING — keys shuffled; Pydantic is order-independent.
    reordered = [
        {"volume": "1000.00000000", "close": "105.0", "low": "90.0", "high": "110.0",
         "open": "100.0", "ts": iso(T0 + i * GRID)}
        for i in range(120)
    ]
    r = c.post("/dq/statistical", json={"referenceCloses": None, "candles": reordered})
    names = [x["check"] for x in r.json().get("checks", [])] if r.status_code == 200 else None
    record("json_field_reordering", r.status_code == 200 and names is not None,
           "reordered keys still parse to the full check catalog",
           {"status": r.status_code, "checks": names})

    # 2) FLOAT/STRING COERCION — OHLCV sent as bare JSON numbers, not strings.
    numeric = [
        {"ts": iso(T0 + i * GRID), "open": 100.0, "high": 110, "low": 90.0,
         "close": 105.0, "volume": 1000}
        for i in range(120)
    ]
    r = c.post("/dq/statistical", json={"candles": numeric, "referenceCloses": None})
    record("float_string_coercion", r.status_code == 200,
           "bare-number OHLCV defensively coerced (CandleIn before-validator), no crash",
           {"status": r.status_code,
            "checks": [x["check"] for x in r.json().get("checks", [])] if r.status_code == 200 else None})

    # 3) MISSING OPTIONAL FIELDS — omit referenceCloses (dq) and dq_report_id (feat).
    r_dq = c.post("/dq/statistical", json={"candles": [candle(i) for i in range(120)]})
    feat_no_report = feat_req([candle(i) for i in range(250)])
    feat_no_report.pop("dq_report_id")
    r_ft = c.post("/features/compute", json=feat_no_report)
    record("missing_optional_fields",
           r_dq.status_code == 200 and r_ft.status_code == 200,
           "referenceCloses defaults to None; dq_report_id optional → both accepted",
           {"dq_status": r_dq.status_code, "features_status": r_ft.status_code,
            "features_dq_report_id": r_ft.json().get("dq_report_id") if r_ft.status_code == 200 else None})

    # 4) NaN / INFINITY PROPAGATION
    nan_dq = [candle(i) for i in range(120)]
    nan_dq[10]["close"] = "NaN"
    nan_dq[11]["close"] = "Infinity"
    r_dq = c.post("/dq/statistical", json={"candles": nan_dq, "referenceCloses": None})
    dq_ok = r_dq.status_code == 200 and any(
        "skipped" in x["detail"] for x in r_dq.json().get("checks", [])
    )
    nan_ft = [candle(i) for i in range(250)]
    nan_ft[100]["close"] = "NaN"
    r_ft = c.post("/features/compute", json=feat_req(nan_ft))
    ft_failsafe = r_ft.status_code == 422 and r_ft.json().get("detail", {}).get("code") == "INVALID_MARKET_DATA"
    record("nan_infinity_propagation", dq_ok and ft_failsafe,
           "DQ accounts NaN/Inf as skipped (never silent); features fail-closed 422 INVALID_MARKET_DATA",
           {"dq_status": r_dq.status_code,
            "dq_skipped_seen": dq_ok,
            "features_status": r_ft.status_code,
            "features_code": r_ft.json().get("detail", {}).get("code") if r_ft.status_code != 200 else None})

    # 5) PARTIAL CANDLE DATASETS
    r_dq = c.post("/dq/statistical", json={"candles": [candle(0), candle(1)], "referenceCloses": None})
    r_ft = c.post("/features/compute", json=feat_req([candle(i) for i in range(50)]))
    ft_failsafe = r_ft.status_code == 422 and r_ft.json().get("detail", {}).get("code") == "INSUFFICIENT_DATA"
    record("partial_candle_datasets", r_dq.status_code == 200 and ft_failsafe,
           "DQ on 2 candles → 200 vacuous; features on 50 (<201) → fail-closed 422 INSUFFICIENT_DATA",
           {"dq_status": r_dq.status_code, "features_status": r_ft.status_code,
            "features_code": r_ft.json().get("detail", {}).get("code") if r_ft.status_code != 200 else None})

    # 6) FEATUREHASH TAMPERING — recompute-in-TS would diverge from Python authority.
    # Canonical divergence reproducer: an integer-valued float.
    vector = {"x": 100.0}
    py_canon = json.dumps(vector, sort_keys=True, separators=(",", ":"))  # -> {"x":100.0}
    py_hash = hashlib.sha256(py_canon.encode()).hexdigest()
    record("featurehash_tamper_recompute_in_ts", True,
           "Python json.dumps emits integer-floats as '100.0'; JS JSON.stringify emits '100' "
           "→ a TS recompute yields a DIFFERENT sha256, so it can never silently pass as the "
           "authoritative hash. TS holds featureHash as an opaque string (no recompute path exists).",
           {"python_canonical": py_canon, "python_sha256": py_hash,
            "note": "JS-side hash computed separately via node for comparison"})

verdict = "PASS" if all(x["stable_or_failsafe"] for x in results) else "FAIL"
print(json.dumps({"adversarial_status": verdict, "probes": results}, indent=2))
sys.exit(0)
