# Quant computation service (Python 3.12 — vectorbt/TA-Lib compatibility)
FROM python:3.12-slim

WORKDIR /srv/quant

# TA-Lib native library + build tooling land in Phase 1 when the quant
# stack (pandas/numpy/vectorbt/backtrader) is introduced.

COPY services/quant/pyproject.toml ./
COPY services/quant/app ./app

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
