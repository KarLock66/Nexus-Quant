#!/bin/sh
# ADR-0001 — fail-closed determinism env assertion before the service starts.
set -eu

for v in OMP_NUM_THREADS MKL_NUM_THREADS OPENBLAS_NUM_THREADS NUMEXPR_NUM_THREADS \
         OPENBLAS_CORETYPE PYTHONHASHSEED TZ LC_ALL; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "FATAL: determinism env $v is unset" >&2
    exit 97
  fi
done

[ "$TZ" = "UTC" ] || { echo "FATAL: TZ is not UTC ($TZ)" >&2; exit 97; }
[ "$PYTHONHASHSEED" = "0" ] || { echo "FATAL: PYTHONHASHSEED!=0" >&2; exit 97; }

exec "$@"
