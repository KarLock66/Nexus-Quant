# Nexus Quant — System Architecture Overview

> Status: DRAFT — pending human approval. No code is generated until this package is approved.

## 1. Mission

An explainable, deterministic, risk-first quantitative intelligence platform for BTC/ETH
spot, perpetual futures, and options across Binance, Deribit, and Bybit. The platform
analyzes, signals, evaluates, tests, and monitors. It never trades. The human is the
final decision maker.

## 2. Architectural Principles

| # | Principle | Architectural consequence |
| --- | --- | --- |
| 1 | Capital preservation first | Risk Engine and Position Sizing are upstream *gates*, not downstream reports. A signal that fails a risk gate is never persisted as actionable. |
| 2 | Data integrity before intelligence | The Data Quality Gateway is the single entry point for all market data. Nothing downstream may read raw, unvalidated data. |
| 3 | Determinism & reproducibility | Every signal, backtest, and AI analysis records the full reproducibility quintuple — `datasetHash`, `featureHash`, `strategyVersion`, `promptVersion`, `modelVersion` — plus LLM `temperature` and `seed`. Re-running with the same inputs yields the same outputs; the LLM layer is *explanatory only* and never alters numeric outputs. |
| 4 | Explainability | Every signal carries machine-checkable gate results plus human-readable reasoning, failure conditions, and invalidation points. |
| 5 | Human-in-the-loop governance | All strategy/parameter changes flow through an approval workflow with a complete audit trail. AI proposes; humans approve. |
| 6 | Fail-closed | On data outage, detector trip, or degraded quality score, the system freezes signal generation rather than degrading silently. |

## 3. Module-to-Service Mapping

The seven engines map onto five deployable services plus shared packages:

| Engine (spec) | Service | Runtime |
| --- | --- | --- |
| M5 Data Quality & Sanitization Gateway | `services/ingestion` (validation stage) + `services/quant` (statistical checks) | TypeScript workers + Python |
| FS Feature Store (between M5 and M1) | `services/quant` (computation) + Postgres (versioned snapshots) | Python |
| M8 Market Regime Engine | `services/quant` (classification) + regime worker | Python + TypeScript |
| M1 Signal Execution Engine | `services/workers` (orchestration) + `services/quant` (computation) | TypeScript + Python |
| M2 AI Research & Intelligence Engine (multi-agent) | `services/workers` (agent orchestrator, Claude API) | TypeScript |
| M3 Backtesting & Dynamic Calibration | `services/quant` (VectorBT/Backtrader) + calibration worker | Python + TypeScript |
| M4 Position Sizing Engine | `services/quant` (math) + limits enforcement in `packages/core` | Python + TypeScript |
| M9 Portfolio Construction Engine | `services/quant` (correlation, risk budgeting, allocation) | Python + TypeScript |
| M10 Strategy Capacity Planner | `services/quant` (OR/optimization) + capacity worker | Python + TypeScript |
| M6 Performance Analytics Dashboard | `apps/web` | Next.js 15 |
| M7 Strategy Governance Engine | `apps/web` API + Postgres | Next.js + Prisma |
| Derivatives Defense Framework | `services/workers` (risk monitors) | TypeScript + Python |

### Deployable units

1. **`apps/web`** — Next.js 15 (App Router). UI + BFF API (`/api/v1/*`), SSE streaming, auth, governance workflows, exports.
2. **`services/quant`** — Python 3.12 FastAPI. Indicators (TA-Lib), regime detection, backtesting (VectorBT primary, Backtrader for event-driven validation), walk-forward, Monte Carlo, stress tests, position-sizing math, statistical DQ checks (drift, outliers). Stateless: reads Postgres/Redis, returns results; never writes domain state directly.
3. **`services/ingestion`** — TypeScript workers. Exchange connectors (Binance, Deribit, Bybit; REST backfill + WebSocket live), normalization to canonical symbols, structural DQ validation, persistence, gap detection/repair.
4. **`services/workers`** — TypeScript (BullMQ on Redis). Signal pipeline orchestrator, AI research orchestrator, calibration scheduler, defense-framework monitors (volatility shock, ETH options risk, black swan), alerting, cron jobs.
5. **Infrastructure** — PostgreSQL 16 (TimescaleDB extension for candle hypertables), Redis 7 (cache + BullMQ queues + pub/sub for realtime), Docker Compose.

## 4. Event-Driven Backbone

Redis pub/sub channels + BullMQ queues (chosen over Kafka: single-node deployment,
ordering needs are per-symbol, and BullMQ gives retries/dead-letter for free).

Canonical events (defined in `packages/events`):

```
data.candle.ingested        { exchange, symbol, timeframe, ts }
data.quality.report         { reportId, scope, score, status }
signal.candidate.created    { candidateId, strategyVersionId }
signal.published            { signalId }            // passed ALL gates
signal.rejected             { candidateId, failedGates[] }
risk.event.raised           { riskEventId, type, severity }
risk.mode.changed           { from, to, reason }
calibration.deviation       { strategyVersionId, metric, expected, actual }
governance.approval.requested { approvalId, kind }
system.health.degraded      { component, detail }
```

Realtime UI updates: workers publish to Redis pub/sub → Next.js SSE endpoint fans out
to the browser.

## 5. Engine Specifications (binding contracts)

### M5 — Data Quality Gateway (first in every pipeline)

Two-stage validation. **Stage A (structural, ingestion-time, TypeScript):** schema
conformance, missing values, duplicate records, timestamp monotonicity/alignment,
symbol consistency, exchange-outage detection (heartbeat gaps). **Stage B (statistical,
Python):** extreme outliers (MAD-based, cross-exchange price cross-check), data drift
(rolling distribution tests), volume anomalies.

Output: `DataQualityReport` with score 0–100 computed as weighted deductions per failed
check, plus a diagnostic payload. **Hard rule: any signal pipeline run reads the latest
report for its (exchange, symbol, timeframe) scope; score < 90 → pipeline aborts with
`signal.rejected(failedGates: [DATA_QUALITY])` and a diagnostic report.**

### FS — Feature Store (between M5 and M1)

All features consumed by the Regime Engine, Signal Engine, AI agents, and backtests
are computed once, versioned, and persisted — never recomputed ad hoc per consumer.

- `FeatureSetDefinition` (name + version + declarative spec) defines *what* is
  computed; changing the spec creates a new version, never mutates an old one.
- `FeatureSnapshot` stores the computed vector per (symbol, timeframe, ts,
  featureSetVersion) with a `featureHash` (sha256 of the canonicalized vector) and a
  mandatory link to the `DataQualityReport` that admitted its inputs.
- **Hard rule:** a `FeatureSnapshot` can only be written from data with DQ ≥ 90;
  signals and analyses reference the snapshot ID + `featureHash`, guaranteeing every
  downstream artifact is traceable to the exact feature values it saw.
- Backtests consume the same store (point-in-time correct reads only — no lookahead),
  eliminating train/serve skew between research and live signal generation.

### M8 — Market Regime Engine (dedicated module)

Regime taxonomy (canonical enum, used platform-wide):

`TRENDING_BULL · TRENDING_BEAR · RANGE_BOUND · HIGH_VOL · LOW_VOL · PANIC · EUPHORIA`

- Classifies per (symbol, timeframe) from Feature Store snapshots: trend/momentum
  features → directional regimes; realized+implied vol features → vol regimes;
  joint extreme detection (drawdown velocity, funding, sentiment) → PANIC/EUPHORIA.
- Output: `RegimeSnapshot { regime, probabilities, evidence, featureSnapshotId }` —
  probabilities and evidence persisted so every regime call is auditable.
- Consumers: M1 MARKET_REGIME gate (strategy declares valid regimes), M4 sizing
  (regime-conditional vol inputs), defense framework (PANIC corroborates detectors),
  M9 allocation (regime-conditional correlation), dashboards.
- PANIC and EUPHORIA are *risk regimes*: no strategy may declare them valid unless
  explicitly approved through governance with documented rationale.

### M1 — Signal Execution Engine

Pipeline (orchestrated by `services/workers`, computed by `services/quant`):

```
DQ gate (>=90) → Feature Store (versioned snapshot) → Regime Engine (M8)
→ strategy evaluation → candidate signal → gate chain → publish or reject
```

Gate chain (ALL must pass; results stored per-gate on the signal):

| Gate | Rule |
| --- | --- |
| DATA_QUALITY | DQ score ≥ 90 for every input dataset |
| RISK_REWARD | expected RR ≥ 2.0 (computed from entry/SL/TP) |
| POSITION_SIZE | M4 returns an approved size > 0 within all `RiskLimit`s, M9 risk budgets / concentration caps, and M10 capacity (portfolio, margin, risk) |
| MARKET_REGIME | strategy's declared valid regimes (M8 taxonomy) include the current `RegimeSnapshot` regime |
| VOLATILITY_FILTER | realized & implied vol within strategy's declared bounds; no active vol-shock event |
| RISK_MODE | system risk mode is NORMAL or ELEVATED (never RISK_OFF/FROZEN) |

Signal object (canonical, see `packages/core`): `state` (STRONG_BUY…STRONG_SELL),
`confidence` (0–1), `risk_score` (0–100), `volatility_score`, `liquidity_score`,
`market_regime`, `expected_rr`, `entry`, `stop_loss`, `take_profit`,
`invalidation_point`, `reasoning`, `failure_conditions[]`, full gate results, and the
reproducibility set (`datasetHash`, `featureHash` + `featureSnapshotId`,
`strategyVersion`). Signals expire (TTL per timeframe) and transition ACTIVE →
INVALIDATED / TARGET_HIT / STOPPED / EXPIRED (or CAPACITY_DEFERRED via M10) for
calibration tracking.

### M2 — AI Research & Intelligence Engine (multi-agent)

Four specialized agents orchestrated by `services/workers`, each with its own
versioned prompt templates, output schema, and scope:

| Agent | Scope | Output |
| --- | --- | --- |
| **Research Agent** | Technical + sentiment + macro layers | Thesis, why-signal-exists, why-may-fail, invalidation conditions |
| **Risk Agent** | Cross-checks every candidate against risk events, regime, limits, correlation | Risk enumeration, confidence-reduction recommendation, manual-review flag |
| **Options Agent** | Derivatives layer: IV surface, skew, PCR, gamma exposure, funding | Options-structure risks, IV-crush/event-vol warnings, hedging context |
| **Governance Agent** | Calibration deviations, strategy drift, audit anomalies | Parameter/strategy review proposals routed into the M7 approval queue |

Agents receive *only validated Feature Store snapshots and persisted domain records*
— never raw data. Each agent's output is schema-validated before persistence as an
`AIAnalysis` row recording the full reproducibility set: `modelVersion`,
`promptVersion`, `temperature`, `seed`, `featureHash`, `datasetHash`. Agent
disagreement (e.g., Research bullish, Risk flags) automatically sets
REQUIRES_MANUAL_REVIEW. **All agents are advisory: they can lower confidence or flag
for review; they can never raise confidence, alter prices/levels, bypass a gate, or
approve anything.**

### M3 — Backtesting & Dynamic Calibration

- Backtests: VectorBT (fast vectorized sweeps) with Backtrader cross-validation for
  approved candidates (guards against vectorization artifacts like same-bar fills).
- Walk-forward: rolling in-sample/out-of-sample windows; parameters chosen in-sample
  only, reported out-of-sample only.
- Monte Carlo: trade-order resampling + block bootstrap of returns; report drawdown
  and ruin-probability distributions.
- Stress tests: replay named historical windows (e.g., Mar 2020, May 2021, FTX Nov
  2022) + synthetic shocks (gap %, vol multiplier, liquidity haircut).
- Metrics: CAGR, Sharpe, Sortino, Profit Factor, Max Drawdown, Win Rate, Recovery
  Factor — computed in one shared Python module so backtest and live analytics agree.
- Calibration: scheduled worker compares expected (backtest) vs realized (signal
  outcome) distributions per strategy version. Deviation beyond thresholds emits
  `calibration.deviation` and creates a **proposal** (parameter review / strategy
  review / risk adjustment) routed through M7 approval. **Never auto-deploys.**

### M4 — Position Sizing Engine

Methods: Fixed Fractional, Kelly (fractional Kelly, capped), ATR-based, Volatility
Targeting. Inputs: portfolio value, risk-per-trade, stop distance, volatility.
Outputs: position size, max exposure, resulting portfolio risk.

Hard limits enforced as *data* (rows in `RiskLimit`), not code constants: daily /
weekly / monthly drawdown limits, max portfolio exposure, max correlated exposure
(BTC-ETH correlation bucket). Limit breach → size = 0 → POSITION_SIZE gate fails.

### M9 — Portfolio Construction Engine

Sits above per-signal sizing: M4 answers "how big is this trade", M9 answers "how do
all exposures fit together".

- **Correlation Matrix:** rolling correlation across held/candidate exposures
  (BTC/ETH spot, perps, options proxies), multiple windows, regime-conditional
  variants; persisted as `CorrelationMatrixSnapshot` for audit.
- **Risk Budgeting:** total portfolio risk decomposed into budgets per strategy /
  asset / regime bucket (`RiskBudget` rows); a new position must fit its bucket's
  remaining budget or the POSITION_SIZE gate fails with `RISK_BUDGET_EXCEEDED`.
- **Exposure Allocation:** target allocation plans (`AllocationPlan`) computed from
  risk budgets + correlation (e.g., ERC-style risk parity as default method);
  proposals only — applying a plan is a human action.
- **Concentration Controls:** hard caps on single-asset, single-strategy,
  single-exchange, and correlated-cluster exposure; evaluated inside the
  POSITION_SIZE gate alongside `RiskLimit`s.

### M10 — Strategy Capacity Planner (APS/OR-inspired)

Treats signal flow as a finite-capacity scheduling problem: capacity is the scarce
resource, signals are jobs competing for it.

- **Capacity dimensions** computed per assessment cycle (`CapacityAssessment`):
  - *Portfolio capacity* — free exposure under max-exposure and concentration caps;
  - *Margin capacity* — free margin under leverage/initial-margin constraints
    (derivatives notional aware);
  - *Risk capacity* — remaining drawdown budget (distance to daily/weekly/monthly
    limits) and unconsumed risk budgets from M9.
- **Signal Prioritization:** when concurrent valid signals exceed capacity, rank by
  deterministic, auditable score (expected RR × confidence × regime fit ÷ marginal
  correlation cost) — greedy allocation under constraints; full ranking + the binding
  constraint recorded per signal. Lower-priority signals are published with status
  `CAPACITY_DEFERRED` rather than silently dropped.
- Capacity exhaustion in any dimension fails the POSITION_SIZE gate for further
  entries — capital preservation outranks opportunity.

### M6 — Performance Analytics Dashboard

Portfolio overview, equity curve, drawdown curve, trade distribution, monthly returns
heatmap, rolling Sharpe/volatility, factor exposure, strategy health score, benchmark
comparison (BTC/ETH buy-and-hold), performance attribution. Exports: CSV, JSON, PDF.
All analytics computed from the same Python metrics module as backtests.

### M7 — Strategy Governance Engine

Strategy registry with immutable versioning. Every `StrategyVersion` must contain:
description, hypothesis, entry logic, exit logic, risk rules, failure conditions —
enforced at the schema level (non-nullable). Lifecycle state machine:

```
DRAFT → BACKTESTING → BACKTEST_APPROVED → PENDING_DEPLOY_APPROVAL → ACTIVE
ACTIVE → PAUSED | DEGRADED | RETIRED        DEGRADED → ACTIVE (re-approval) | RETIRED
```

Both backtest approval and deployment approval are separate human sign-offs. Every
mutation writes an `AuditLog` row (who, what changed — JSON diff, why — mandatory
reason text, when). AI recommendations enter the same approval queue as human changes.

### Derivatives Defense Framework

Continuously-running monitors in `services/workers`, evaluated on every relevant data
event; all thresholds configurable rows in `DetectorConfig`:

| Detector | Triggers | Automatic actions |
| --- | --- | --- |
| BTC Volatility Shock | ATR explosion (ATR > k× rolling median), vol regime shift, liquidity collapse (depth/spread), funding-rate extremes | Raise `risk.event`, scale down M4 sizing factor, raise risk scores, tighten exposure limits, pause new entries (mode → ELEVATED) |
| ETH Options Risk | IV spike, IV-crush setup (event-vol shape), excessive gamma exposure, abnormal PCR | Reduce signal confidence cap, raise risk rating, flag signals REQUIRES_MANUAL_REVIEW |
| Black Swan | Flash crash (return + liquidity joint), exchange failure (connectivity + cross-exchange divergence), stablecoin depeg (USDT/USDC bands), correlation spike | Mode → RISK_OFF or FROZEN, freeze all signal publication, alert user, capital-protection checklist |

System risk mode state machine: `NORMAL ⇄ ELEVATED ⇄ RISK_OFF → FROZEN`. Escalation is
automatic; **de-escalation from RISK_OFF/FROZEN requires human approval** (fail-closed).

## 6. Key Technology Decisions (ADR summary)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Monorepo tooling | pnpm workspaces + Turborepo | Shared types between web/workers/ingestion; single CI |
| Time-series storage | PostgreSQL + TimescaleDB hypertables | One database for domain + market data; continuous aggregates for multi-timeframe candles |
| Event bus | Redis (BullMQ + pub/sub) | Right-sized vs Kafka; retries, scheduling, DLQ built in |
| Quant runtime | Python FastAPI sidecar | Pandas/NumPy/TA-Lib/VectorBT ecosystem is non-negotiable for quant work |
| Node⇄Python contract | OpenAPI-typed HTTP + shared JSON Schemas in `packages/core/contracts` | Deterministic, versioned, language-neutral |
| LLM | Claude API (structured outputs) | Schema-validated explanatory analysis; versioned prompts |
| Realtime UI | SSE (not WebSocket) | One-directional fan-out; simpler infra, works through proxies |
| Auth | Single-operator auth (NextAuth credentials) initially | Platform is single-analyst first; RBAC schema-ready (User.role) |
| Numeric precision | `Decimal` in Postgres/Prisma, `decimal.js` in TS, `float64` only inside Python vector math | No float drift in prices/PnL at rest |
