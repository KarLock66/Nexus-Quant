# Nexus Quant — Monorepo Folder Structure

> Status: DRAFT — pending human approval.

pnpm workspaces + Turborepo. Python service is workspace-adjacent (own venv/uv,
shares contracts via `packages/core/contracts` JSON Schemas).

```
nexus-quant/
├── apps/
│   └── web/                              # Next.js 15 — UI + BFF API
│       ├── src/
│       │   ├── app/
│       │   │   ├── (dashboard)/
│       │   │   │   ├── page.tsx                  # Dashboard (overview)
│       │   │   │   ├── signals/                  # Signal Center
│       │   │   │   ├── research/                 # Research Lab
│       │   │   │   ├── backtesting/              # Backtesting Studio
│       │   │   │   ├── risk/                     # Risk Engine
│       │   │   │   ├── portfolio/                # Portfolio Analytics
│       │   │   │   ├── governance/               # Strategy Governance
│       │   │   │   └── system/                   # System Monitoring
│       │   │   ├── api/v1/                       # BFF route handlers
│       │   │   │   ├── signals/
│       │   │   │   ├── research/
│       │   │   │   ├── features/
│       │   │   │   ├── regime/
│       │   │   │   ├── backtests/
│       │   │   │   ├── position-sizing/
│       │   │   │   ├── portfolio-construction/
│       │   │   │   ├── capacity/
│       │   │   │   ├── data-quality/
│       │   │   │   ├── portfolio/
│       │   │   │   ├── analytics/
│       │   │   │   ├── strategies/
│       │   │   │   ├── approvals/
│       │   │   │   ├── audit-logs/
│       │   │   │   ├── risk/
│       │   │   │   ├── system/
│       │   │   │   └── stream/                   # SSE endpoint
│       │   │   └── auth/
│       │   ├── components/
│       │   │   ├── ui/                           # shadcn/ui primitives
│       │   │   ├── charts/                       # equity, drawdown, heatmaps…
│       │   │   ├── signals/
│       │   │   ├── risk/
│       │   │   └── governance/
│       │   ├── lib/                              # api client, sse client, formatters
│       │   ├── hooks/
│       │   └── server/                           # server-only: services, auth, sse hub
│       └── package.json
│
├── services/
│   ├── ingestion/                        # TS — exchange connectors + Stage-A DQ
│   │   ├── src/
│   │   │   ├── connectors/{binance,deribit,bybit}/
│   │   │   ├── normalize/                        # canonical symbol & schema mapping
│   │   │   ├── validation/                       # structural DQ checks (Stage A)
│   │   │   ├── backfill/                         # historical REST backfill jobs
│   │   │   ├── live/                             # WebSocket consumers
│   │   │   └── persistence/
│   │   └── package.json
│   │
│   ├── workers/                          # TS — BullMQ orchestration
│   │   ├── src/
│   │   │   ├── pipelines/signal/                 # M1 orchestrator + gate chain
│   │   │   ├── pipelines/regime/                 # M8 regime refresh orchestration
│   │   │   ├── pipelines/capacity/               # M10 capacity assessment cycle
│   │   │   ├── agents/                           # M2 multi-agent orchestrator (Claude API)
│   │   │   │   ├── research/
│   │   │   │   ├── risk/
│   │   │   │   ├── options/
│   │   │   │   └── governance/
│   │   │   ├── pipelines/calibration/            # M3 expected-vs-actual
│   │   │   ├── monitors/volatility-shock/        # defense framework
│   │   │   ├── monitors/options-risk/
│   │   │   ├── monitors/black-swan/
│   │   │   ├── monitors/health/
│   │   │   ├── alerts/
│   │   │   └── schedules/                        # cron definitions
│   │   └── package.json
│   │
│   └── quant/                            # Python 3.12 — FastAPI
│       ├── app/
│       │   ├── api/                              # /indicators /features /regime /backtest
│       │   │   │                                 # /walkforward /montecarlo /stress /sizing
│       │   │   │                                 # /portfolio /capacity /dq /metrics
│       │   ├── indicators/                       # TA-Lib wrappers, market structure
│       │   ├── features/                         # FS: feature-set defs, snapshot compute, hashing
│       │   ├── regime/                           # M8: dedicated regime engine (7-state taxonomy)
│       │   ├── backtest/{vectorbt_engine,backtrader_engine}/
│       │   ├── simulation/                       # monte carlo, stress scenarios
│       │   ├── sizing/                           # fixed-frac, kelly, atr, vol-target
│       │   ├── portfolio_construction/           # M9: correlation, risk budgets, allocation
│       │   ├── capacity/                         # M10: capacity dims, signal prioritization
│       │   ├── dq/                               # Stage-B statistical checks
│       │   ├── metrics/                          # SHARED perf metrics module
│       │   └── schemas/                          # pydantic, generated from contracts
│       ├── tests/
│       └── pyproject.toml
│
├── packages/
│   ├── db/                               # Prisma schema, client, migrations, seed
│   │   └── prisma/schema.prisma
│   ├── core/                             # shared domain layer (TS)
│   │   ├── src/{types,gates,risk-limits,constants}/
│   │   └── contracts/                            # JSON Schemas (TS⇄Python source of truth)
│   ├── events/                           # event names + payload types + publisher/consumer helpers
│   └── config/                           # shared tsconfig/eslint/tailwind presets
│
├── docker/
│   ├── docker-compose.yml                        # postgres+timescale, redis, services
│   ├── docker-compose.dev.yml
│   └── {web,ingestion,workers,quant}.Dockerfile
│
├── docs/
│   ├── architecture/                             # this package
│   ├── adr/                                      # decision records
│   └── runbooks/                                 # ops: outage, risk-off, restore
│
├── scripts/                              # dev bootstrap, db reset, backfill CLI
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## Conventions

- **Dependency direction:** `apps/*` and `services/*` may depend on `packages/*`;
  packages never depend on apps/services; no service imports another service (events
  or HTTP only).
- **`packages/core/contracts`** holds JSON Schemas for every cross-language payload
  (SignalCandidate, GateResult, BacktestRequest/Result, SizingRequest/Result,
  DQReport). TS types and Pydantic models are both generated from these — single
  source of truth.
- **Risk gates live in `packages/core/gates`** so the same gate code runs in the
  signal pipeline and in API-side validation; Python never decides gate pass/fail,
  it only supplies numbers.
- All services read configuration from environment + `DetectorConfig`/`RiskLimit`
  tables; no thresholds hardcoded.
