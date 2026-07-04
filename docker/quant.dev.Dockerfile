# LOCAL DEV ONLY — NOT the reproducible seal image.
#
# This image exists solely to ACTIVATE the quant Feature Store for local live
# bring-up (Phase 9.5). It is deliberately NOT a substitute for the sealed,
# digest-pinned, hash-locked `docker/quant.Dockerfile`, which stays fail-closed
# until `bootstrap-reproducibility.yml` resolves its base digest + requirements.lock.
# The reproducibility SEAL must use that image; this one only powers the running
# system. Same app code → same featureHash logic; what differs is the supply-chain
# guarantees (pinned base, --require-hashes, baked determinism self-test).
#
# Only the two live routers (/dq/*, /features/compute) are exercised, which need
# just numpy + scipy (no pandas, no TA-Lib). Determinism env mirrors the sealed
# image so the numerics match.
FROM python:3.12-slim

ENV OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    OMP_DYNAMIC=FALSE \
    OPENBLAS_CORETYPE=Haswell \
    PYTHONHASHSEED=0 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=UTC \
    LC_ALL=C.UTF-8 \
    LANG=C.UTF-8 \
    SOURCE_DATE_EPOCH=0

WORKDIR /srv/quant

# Exact numeric pins (match pyproject) so featureHash numerics align with the
# developed-against versions; fastapi/uvicorn/pydantic for the service surface.
RUN python -m pip install --no-cache-dir --upgrade "pip==24.3.1" \
 && python -m pip install --no-cache-dir \
      "fastapi>=0.115" \
      "uvicorn[standard]>=0.34" \
      "pydantic>=2.11" \
      "numpy==2.4.6" \
      "scipy==1.17.1"

COPY services/quant/app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
