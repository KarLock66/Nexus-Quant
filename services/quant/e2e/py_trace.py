"""STEP 6 — Python-side E2E trace + strict comparator (real runtime, no mocks).

Reads the exact request bytes the TS harness sent, re-parses them through the
REAL Pydantic models (authentic parsed_request_object), invokes the REAL
production functions (run_statistical_checks / compute_core_technical) for the
authoritative values, issues its own live HTTP calls to capture raw response
bytes, then runs the STRICT assertions comparing TS-observed vs Python
authoritative and emits the contract verdict JSON.

Trace instrumentation only — imports production modules unmodified.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import httpx

from app.dq import run_statistical_checks
from app.features import compute_core_technical
from app.schemas.dq import StatisticalRequest
from app.schemas.features import FeatureComputeRequest

OUT = Path(r"C:\Users\sh\Nexus Quant\.e2e_out")
BASE = "http://127.0.0.1:8765"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
DQ_CHECK_KEYS = {"check", "passed", "deduction", "detail"}
FEAT_RESP_KEYS = {
    "feature_set",
    "version",
    "as_of_ts",
    "features",
    "featureHash",
    "input_candle_count",
    "dq_report_id",
}

ts_trace = json.loads((OUT / "ts_trace.json").read_text(encoding="utf-8"))
TRACE_ID = ts_trace["trace_id"]


def emit(status, layer, drift, summary, ev_ts=None, ev_py=None):
    print(
        json.dumps(
            {
                "status": status,
                "trace_id": TRACE_ID,
                "failure_layer": layer,
                "drift_type": drift,
                "summary": summary,
                "evidence": {"ts": ev_ts or {}, "python": ev_py or {}},
            },
            indent=2,
        )
    )
    sys.exit(0)


def fail(layer, drift, summary, ev_ts=None, ev_py=None):
    emit("FAIL", layer, drift, summary, ev_ts, ev_py)


py_trace: dict = {"trace_id": TRACE_ID, "dq": {}, "features": {}}

# ── Capture phase: authoritative Python values + live HTTP ──────────────────
with httpx.Client(base_url=BASE, timeout=30.0) as client:
    for name in ["A", "B", "C"]:
        raw = (OUT / f"req_{name}.json").read_bytes()
        model = StatisticalRequest.model_validate_json(raw)  # authentic parse
        c0 = model.candles[0]
        ohlcv_types = {
            f: type(getattr(c0, f)).__name__
            for f in ["close", "open", "high", "low", "volume"]
        }
        closes = [c.close for c in model.candles]
        volumes = [c.volume for c in model.candles]
        direct = run_statistical_checks(closes, volumes, model.referenceCloses)
        direct_serial = [
            {"check": r.check, "passed": r.passed, "deduction": r.deduction, "detail": r.detail}
            for r in direct
        ]
        resp = client.post(
            "/dq/statistical",
            content=raw,
            headers={"Content-Type": "application/json", "X-Trace-Id": TRACE_ID},
        )
        py_trace["dq"][name] = {
            "request_bytes_len": len(raw),
            "ohlcv_types": ohlcv_types,
            "raw_response_bytes_len": len(resp.content),
            "response_keys": sorted(resp.json().keys()),
            "live_checks": resp.json().get("checks"),
            "direct_checks": direct_serial,
        }

    rawf = (OUT / "req_features.json").read_bytes()
    fmodel = FeatureComputeRequest.model_validate_json(rawf)
    fc0 = fmodel.market_data.candles[0]
    f_types = {
        f: type(getattr(fc0, f)).__name__
        for f in ["close", "open", "high", "low", "volume"]
    }
    feats, fhash = compute_core_technical(
        [
            {"open": c.open, "high": c.high, "low": c.low, "close": c.close, "volume": c.volume}
            for c in fmodel.market_data.candles
        ]
    )
    respf = client.post(
        "/features/compute",
        content=rawf,
        headers={"Content-Type": "application/json", "X-Trace-Id": TRACE_ID},
    )
    parsedf = respf.json()
    py_trace["features"] = {
        "request_bytes_len": len(rawf),
        "ohlcv_types": f_types,
        "raw_response_bytes_len": len(respf.content),
        "response_keys": sorted(parsedf.keys()),
        "feature_keys": sorted(parsedf.get("features", {}).keys()),
        "live_featureHash": parsedf.get("featureHash"),
        "direct_featureHash": fhash,
        "computed_features": feats,
    }

(OUT / "py_trace.json").write_text(json.dumps(py_trace, indent=2), encoding="utf-8")

# ── Assertion phase (STOP at first failure, exact layer attribution) ────────

# A1/A5 — contract structure + serialization (DQ)
for name in ["A", "B", "C"]:
    py = py_trace["dq"][name]
    ts_stageB = ts_trace["scenarios"][name]["stageB"]
    if py["response_keys"] != ["checks"]:
        fail("S5", "CONTRACT_FIELD_DRIFT",
             f"dq {name} top-level response keys {py['response_keys']} != ['checks']",
             ev_py={"response_keys": py["response_keys"]})
    for chk in py["live_checks"]:
        if set(chk.keys()) != DQ_CHECK_KEYS:
            fail("S5", "SERIALIZATION_DRIFT",
                 f"dq {name} python check keys {sorted(chk.keys())} != {sorted(DQ_CHECK_KEYS)}",
                 ev_py=chk)
    if [c["check"] for c in ts_stageB] != [c["check"] for c in py["live_checks"]]:
        fail("S6", "CONTRACT_FIELD_DRIFT",
             f"dq {name} TS check names != python live",
             ev_ts=[c["check"] for c in ts_stageB],
             ev_py=[c["check"] for c in py["live_checks"]])
    for chk in ts_stageB:
        if set(chk.keys()) != DQ_CHECK_KEYS:
            fail("S6", "CONTRACT_FIELD_DRIFT",
                 f"dq {name} TS parsed check keys {sorted(chk.keys())}", ev_ts=chk)

# A3 — numeric stability: OHLCV remain strings after Pydantic parse
for name in ["A", "B", "C"]:
    t = py_trace["dq"][name]["ohlcv_types"]
    for fld, tp in t.items():
        if tp != "str":
            fail("S3", "TYPE_COERCION_DRIFT",
                 f"dq {name} OHLCV {fld} parsed as {tp}, expected str", ev_py=t)
for fld, tp in py_trace["features"]["ohlcv_types"].items():
    if tp != "str":
        fail("S3", "TYPE_COERCION_DRIFT",
             f"features OHLCV {fld} parsed as {tp}, expected str",
             ev_py=py_trace["features"]["ohlcv_types"])

# A4(num) — deduction values identical Python(live) vs TS(parsed)
for name in ["A", "B", "C"]:
    live = {c["check"]: c["deduction"] for c in py_trace["dq"][name]["live_checks"]}
    tsb = {c["check"]: c["deduction"] for c in ts_trace["scenarios"][name]["stageB"]}
    direct = {c["check"]: c["deduction"] for c in py_trace["dq"][name]["direct_checks"]}
    for k, v in live.items():
        if float(v) != float(tsb.get(k, -1)):
            fail("S6", "NUMERIC_DRIFT",
                 f"dq {name} deduction {k}: python {v} != ts {tsb.get(k)}",
                 ev_ts=tsb, ev_py=live)
        if float(v) != float(direct.get(k, -1)):
            fail("S4", "NUMERIC_DRIFT",
                 f"dq {name} deduction {k}: live {v} != direct compute {direct.get(k)}",
                 ev_py={"live": live, "direct": direct})

# A2 — featureHash integrity (byte-identical string, never recomputed in TS)
fh_live = py_trace["features"]["live_featureHash"]
fh_direct = py_trace["features"]["direct_featureHash"]
fh_ts = ts_trace["features"]["featureHash"]
if not (isinstance(fh_live, str) and HEX64.match(fh_live)):
    fail("S5", "FEATURE_HASH_DRIFT", f"python live featureHash not 64-hex: {fh_live!r}")
if fh_live != fh_direct:
    fail("S5", "FEATURE_HASH_DRIFT",
         f"live featureHash != direct compute_core_technical hash",
         ev_py={"live": fh_live, "direct": fh_direct})
if fh_ts != fh_live:
    fail("S6", "FEATURE_HASH_DRIFT",
         "TS-observed featureHash != Python authoritative featureHash",
         ev_ts={"featureHash": fh_ts}, ev_py={"featureHash": fh_live})
if ts_trace["features"].get("featureHash_recomputed_in_ts") is not False:
    fail("S6", "FEATURE_HASH_DRIFT", "TS recomputed featureHash (must persist verbatim)")

# A5 — features serialization keys + camelCase preserved
if set(py_trace["features"]["response_keys"]) != FEAT_RESP_KEYS:
    fail("S5", "SERIALIZATION_DRIFT",
         f"features response keys {py_trace['features']['response_keys']} != {sorted(FEAT_RESP_KEYS)}",
         ev_py={"response_keys": py_trace["features"]["response_keys"]})
if "feature_hash" in py_trace["features"]["response_keys"]:
    fail("S5", "SERIALIZATION_DRIFT", "featureHash drifted to snake_case 'feature_hash'")
if set(ts_trace["features"]["response_keys"]) != FEAT_RESP_KEYS:
    fail("S6", "SERIALIZATION_DRIFT",
         f"TS-observed features keys {ts_trace['features']['response_keys']}",
         ev_ts={"response_keys": ts_trace["features"]["response_keys"]})

# A4 — decision consistency: TS scoreChecks matches deduction-implied verdict
decisions = {}
for name in ["A", "B", "C"]:
    merged = ts_trace["scenarios"][name]["merged_checks"]
    expected = max(0, 100 - sum(0 if c["passed"] else c["deduction"] for c in merged))
    exp_status = "PASSED" if expected >= 90 else "FAILED"
    dec = ts_trace["scenarios"][name]["decision"]
    if dec["score"] != expected or dec["status"] != exp_status:
        fail("S7", "DECISION_DRIFT",
             f"dq {name} TS decision {dec} != deduction-implied {expected}/{exp_status}",
             ev_ts=dec, ev_py={"expected_score": expected, "expected_status": exp_status})
    decisions[name] = dec

emit(
    "PASS",
    None,
    None,
    (
        "Real-runtime TS<->Python round-trip verified across 3 DQ scenarios + Feature Store: "
        "contract structure, field-name/casing, OHLCV string preservation (no coercion), "
        "deduction values identical (TS==live==direct), featureHash byte-identical and not "
        "recomputed in TS, and TS scoreChecks decisions consistent with Python deductions."
    ),
    ev_ts={
        "decisions": decisions,
        "featureHash": fh_ts,
        "featureHash_recomputed_in_ts": ts_trace["features"]["featureHash_recomputed_in_ts"],
        "dq_B_stageB_deductions": {
            c["check"]: c["deduction"] for c in ts_trace["scenarios"]["B"]["stageB"]
        },
    },
    ev_py={
        "featureHash_live": fh_live,
        "featureHash_direct": fh_direct,
        "ohlcv_types_dq_A": py_trace["dq"]["A"]["ohlcv_types"],
        "feature_keys": py_trace["features"]["feature_keys"],
        "dq_B_live_deductions": {
            c["check"]: c["deduction"] for c in py_trace["dq"]["B"]["live_checks"]
        },
        "raw_response_bytes_len_dq_A": py_trace["dq"]["A"]["raw_response_bytes_len"],
    },
)
