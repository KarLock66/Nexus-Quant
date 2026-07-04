# CONTEXT — Stable Project Facts

## Project Description

**Nexus Quant** — an explainable, deterministic, risk-first quant research, signal
intelligence & risk governance platform for BTC/ETH spot, perpetual futures, and
options across Deribit (primary), Binance (secondary), Bybit (tertiary).

It analyzes, signals, evaluates, backtests, and monitors. **It never trades.** The
human is the final decision maker. Priority order: capital preservation > risk >
data integrity > robustness > explainability > consistency > profitability.

**Demo Mode** (`DEMO_MODE=true`): the full platform runs on a deterministic seeded
synthetic connector with zero exchange credentials or network access.

### Repository layout (pnpm + Turborepo monorepo)

```
apps/web              Next.js 15 (App Router) — UI + BFF API (/api/v1/*), SSE, governance
services/ingestion    TypeScript — exchange connectors, Stage-A DQ, persistence, backfill
services/quant        Python 3.12 FastAPI — Stage-B statistical DQ, features, indicators,
                      backtesting, sizing math. Stateless; returns numbers, never decisions.
services/workers      TypeScript (BullMQ/Redis) — pipeline orchestration, AI agents, monitors
packages/db           Prisma schema + Timescale SQL + seed
packages/core         Domain logic incl. the 6-gate chain (packages/core/gates)
packages/events       Canonical event definitions (Redis pub/sub + BullMQ)
docs/architecture     Approved architecture package (00-overview … 05-roadmap)
```

Infra: PostgreSQL 16 + TimescaleDB, Redis 7, Docker Compose. Remote:
https://github.com/KarLock66/Nexus-Quant (git identity: KarLock66 noreply — keep it).

## Architecture Constraints (binding — approved 2026-06-12 with 7 modifications)

1. **Gate chain decisions live ONLY in `packages/core/gates`.** Python returns numbers
   only; it never decides pass/fail, never writes domain state.
2. **AI is explanatory/advisory only.** `confidenceAdjustment <= 0` (enforced by DB
   CHECK in `packages/db/prisma/timescale.sql`). AI never alters numeric outputs.
3. **Risk-mode de-escalation requires human approval** — return an ApprovalRequest,
   never act directly.
4. **Fail-closed**: data outage / detector trip / DQ degradation freezes signal
   generation; never degrade silently.
5. **DQ Gateway is the single entry point for market data**; Feature Store admission
   requires DQ score ≥ 90; nothing downstream reads raw unvalidated data.
6. **Reproducibility quintuple** on every signal/backtest/AI analysis: `datasetHash`,
   `featureHash`, `strategyVersion`, `promptVersion`, `modelVersion` (+ LLM
   temperature & seed).
7. **Build order follows docs/architecture/05-roadmap.md** — phases end with
   acceptance criteria; module-by-module, never monolithic.

## Coding Rules

- **Do not redesign architecture unless explicitly requested.** The architecture
  package in `docs/architecture/` is approved; deviations need human approval first.
- **Do not scan the entire repository unless required.** Use TASK.md "Active Files"
  and targeted reads/greps. Token Preservation Rules in `AI_OS/TOKEN_BUDGET.md` bind
  in every mode: inspect `package.json` / `README.md` / `app/` / `src/` first, and
  request permission before expanding scope beyond them.
- **Use minimal diffs.** Touch only what the current step requires.
- **Preserve existing structure** — directory layout, naming, module boundaries.
- **Follow TASK.md as source of truth** for what to work on.
- Every numeric module ships with hand-verified fixture tests before integration.
- No code path may bypass the gate chain.
- TypeScript: strict mode, workspace packages via `@nexus/*`. Python: typed, Pydantic
  schemas in `app/schemas`, routers in `app/api`.

## Execution Constraints (environment)

- **Windows 11, no Docker installed** — `docker compose`, DB migrate/seed against a
  real Postgres are UNVERIFIED locally. Flag this; don't claim acceptance that needs them.
- **Python 3.14 local, but quant targets 3.12** (Docker, for TA-Lib/vectorbt compat).
  Local pytest runs on 3.14 — fine for pure-Python tests.
- pnpm installed via `npm -g` (corepack EPERM); native builds need allowBuilds approval
  in `pnpm-workspace.yaml`; Next.js standalone output is opt-in via
  `NEXT_OUTPUT_STANDALONE=1` (symlink EPERM locally).
- Verify with: `pnpm build`, `pnpm typecheck`, `python -m pytest` (in services/quant).
