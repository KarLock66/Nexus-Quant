"""ADR-0001 golden-hash tool — reproducibility enforcement (infrastructure only).

This calls the FROZEN feature implementation (app.features.core_technical) and
does not alter its logic, formulas, or hashing. It is the in-container authority
for featureHash reproducibility.

Modes:
  selftest  MIR-2 + in-process idempotence (no committed baseline needed).
            Baked into the Docker image build (fail-closed if non-deterministic).
  emit      Print the featureHash (one line). Used by the cross-env matrix and
            the 100x stability gate.
  check     Recompute and compare against the committed golden baseline.
            HARD FAIL on any mismatch. The CI authority. Use --strict to also
            require byte-equality of the full feature vector (default on).
  generate  Print the canonical golden record JSON to stdout. CI-ONLY bootstrap
            path (redirected into goldens/<input>.golden.json by the gated
            regenerate workflow). Never run locally for an authoritative golden.

All paths resolve inside the container (WORKDIR /srv/quant).
"""

from __future__ import annotations

import json
import pathlib
import sys

from app.features import (
    FEATURE_SET_NAME,
    FEATURE_SET_VERSION,
    compute_core_technical,
    compute_feature_hash,
)

GOLDENS = pathlib.Path(__file__).resolve().parent.parent / "goldens"
INPUT_ID = "core-technical-v1"


def _load_candles(input_id: str) -> list[dict[str, str]]:
    path = GOLDENS / "inputs" / f"{input_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _compute(input_id: str) -> tuple[dict[str, float], str]:
    candles = _load_candles(input_id)
    features, feature_hash = compute_core_technical(candles)
    # MIR-2: featureHash must equal sha256(canonical(returned vector)).
    if compute_feature_hash(features) != feature_hash:
        print("FATAL: MIR-2 violated (hash != sha256(vector))", file=sys.stderr)
        sys.exit(2)
    return features, feature_hash


def _record(input_id: str, features: dict[str, float], feature_hash: str) -> str:
    record = {
        "feature_set": FEATURE_SET_NAME,
        "version": FEATURE_SET_VERSION,
        "input_id": input_id,
        "features": features,
        "featureHash": feature_hash,
    }
    return json.dumps(record, sort_keys=True, separators=(",", ":"))


def _selftest(input_id: str) -> int:
    f1, h1 = _compute(input_id)
    f2, h2 = _compute(input_id)
    if h1 != h2 or f1 != f2:
        print(f"NON-DETERMINISTIC in-process: {h1} != {h2}", file=sys.stderr)
        return 1
    print(f"selftest OK: {h1}")
    return 0


def _emit(input_id: str) -> int:
    _, feature_hash = _compute(input_id)
    print(feature_hash)
    return 0


def _generate(input_id: str) -> int:
    features, feature_hash = _compute(input_id)
    sys.stdout.write(_record(input_id, features, feature_hash))
    return 0


def _check(input_id: str, strict: bool) -> int:
    baseline_path = GOLDENS / f"{input_id}.golden.json"
    if not baseline_path.exists():
        print(
            f"HARD FAIL: golden baseline missing ({baseline_path.name}); "
            "Phase 1 OPEN until the bootstrap workflow commits it",
            file=sys.stderr,
        )
        return 1
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    features, feature_hash = _compute(input_id)
    if baseline.get("featureHash") != feature_hash:
        print(
            f"GOLDEN HASH DRIFT: baseline={baseline.get('featureHash')} "
            f"computed={feature_hash}",
            file=sys.stderr,
        )
        return 1
    if strict and baseline.get("features") != features:
        print("GOLDEN VECTOR DRIFT: feature values differ from baseline", file=sys.stderr)
        return 1
    print(f"golden OK: {feature_hash}")
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: golden.py {selftest|emit|check|generate} [--strict]", file=sys.stderr)
        return 64
    mode = argv[0]
    if mode == "selftest":
        return _selftest(INPUT_ID)
    if mode == "emit":
        return _emit(INPUT_ID)
    if mode == "generate":
        return _generate(INPUT_ID)
    if mode == "check":
        # check is unconditionally strict (hash + full vector byte-equality).
        return _check(INPUT_ID, strict=True)
    print(f"unknown mode: {mode}", file=sys.stderr)
    return 64


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
