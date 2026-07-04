# syntax=docker/dockerfile:1.7

FROM python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

# Determinism env (ADR-0001): the entrypoint fail-closes when any of these is
# unset, so the image must pin them — mirrors quant.dev.Dockerfile / CI compose.
ENV OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    OMP_DYNAMIC=FALSE \
    OPENBLAS_CORETYPE=Haswell \
    PYTHONHASHSEED=0 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_INPUT=1 \
    TZ=UTC \
    LC_ALL=C.UTF-8 \
    LANG=C.UTF-8

WORKDIR /srv/quant

# 1. ONLY build backend dependency (critical fix)
RUN python -m pip install --no-cache-dir \
    pip==24.3.1 \
    hatchling

# 2. Copy source FIRST (needed for PEP517 build)
COPY services/quant/pyproject.toml ./pyproject.toml
COPY services/quant/requirements.lock ./requirements.lock
COPY services/quant/app ./app
COPY services/quant/tools ./tools
COPY services/quant/goldens ./goldens

# 3. Install hash-locked deps from the committed lock, then the app itself
#    with no re-resolution (ADR-0001: installed env must equal the lock).
#    hatchling is a PEP517 build-time-only backend (not in the lock, never
#    imported at runtime) — removed post-build so the installed env matches
#    the lock exactly.
RUN chmod +x tools/entrypoint.sh \
 && python -m pip install --no-cache-dir --require-hashes -r requirements.lock \
 && python -m pip install --no-cache-dir --no-build-isolation --no-deps . \
 && python -m pip uninstall -y hatchling packaging pathspec pluggy trove-classifiers

# 4. runtime hardening
ENV PIP_NO_INDEX=1 PIP_NO_DEPS=1

ENTRYPOINT ["/srv/quant/tools/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]