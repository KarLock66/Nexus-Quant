#!/usr/bin/env bash
# ADR-0001 — base image digest drift detector (HARD FAIL on drift).
# Compares the digest pinned in docker/quant.Dockerfile against the current
# upstream digest of the python:3.12-slim manifest list. The build itself is
# digest-locked and unaffected; this guards that a re-pin is a deliberate,
# reviewed event (run via the gated bootstrap workflow).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DF="$ROOT/docker/quant.Dockerfile"

# Capture the full hex run with {64,} so an over-length (malformed) digest is
# caught by the exact-64 validation below rather than silently truncated.
PINNED="$(grep -oE 'sha256:[0-9a-f]{64,}' "$DF" | head -1 || true)"
if ! printf '%s' "${PINNED:-}" | grep -qxE 'sha256:[0-9a-f]{64}'; then
  echo "HARD FAIL: no valid 64-hex sha256 digest pinned in $DF (got '${PINNED:-<none>}'); run bootstrap" >&2
  exit 1
fi

CURRENT="$(docker buildx imagetools inspect python:3.12-slim --format '{{json .Manifest.Digest}}' | tr -d '"')"
echo "pinned=$PINNED upstream=$CURRENT"

if [ "$PINNED" != "$CURRENT" ]; then
  echo "HARD FAIL: base image drift — upstream python:3.12-slim moved." >&2
  echo "Re-pin ONLY via a reviewed bootstrap PR that re-validates the golden matrix." >&2
  exit 1
fi
echo "base image digest OK"
