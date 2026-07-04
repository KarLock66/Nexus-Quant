# Nexus Quant — API Design

> Status: DRAFT — pending human approval.

Two API surfaces:

1. **Public BFF API** — Next.js route handlers under `/api/v1/*`. Consumed by the UI
   (and exportable for programmatic use). Auth required (session cookie or PAT).
2. **Internal Quant API** — Python FastAPI (`services/quant`), reachable only on the
   Docker network. Pure computation; no auth beyond network isolation + shared secret
   header; never exposed publicly.

## 1. Conventions (BFF)

- **Envelope:**
  - Success: `{ "data": …, "meta": { pagination?, generatedAt } }`
  - Error: `{ "error": { "code": "RISK_LIMIT_BREACHED", "message": …, "details": … } }`
- **Pagination:** cursor-based — `?cursor=&limit=` → `meta.pagination = { nextCursor, hasMore }`.
- **Filtering:** flat query params (`?symbol=BTC-USDT&status=ACTIVE&from=&to=`).
- **Versioning:** URI version (`/api/v1`); breaking changes → `/api/v2`.
- **Mutation semantics:** every mutating endpoint accepts an `Idempotency-Key` header
  and writes an `AuditLog` row; governance mutations additionally require a `reason`
  field in the body (400 without it).
- **Status codes:** 200/201, 202 (queued async job), 400 validation, 401/403, 404,
  409 (state-machine violation, e.g. approving a non-PENDING request), 422
  (domain-rule rejection, e.g. RR < 2), 429, 500.

## 2. BFF Endpoints by Module

### Signals (M1)
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/signals` | List; filters: symbol, state, status, regime, strategyVersionId, from/to |
| GET | `/api/v1/signals/:id` | Full signal incl. gate results, AI analyses, sizing calc, outcome |
| POST | `/api/v1/signals/generate` | 202 — manually trigger pipeline for `{symbol, timeframe, strategyVersionId}`; returns jobId. Subject to ALL gates — manual trigger cannot bypass anything |
| GET | `/api/v1/signals/:id/lineage` | Dataset hashes, DQ report, feature snapshot, prompt versions |

### AI Agents (M2)
| GET | `/api/v1/research/analyses` | List analyses; filter by symbol/signal/agent/flagged |
| POST | `/api/v1/research/run` | 202 — run agents for a symbol `{agents?: [RESEARCH,RISK,OPTIONS,GOVERNANCE]}` (advisory output only) |
| GET | `/api/v1/research/analyses/:id` | Layers, thesis, why-may-fail, risks, invalidation conditions + full reproducibility metadata (modelVersion, promptVersion, temperature, seed, hashes) |

### Feature Store (FS) & Regime (M8)
| GET | `/api/v1/features/sets` | Feature-set definitions + versions |
| GET | `/api/v1/features/snapshots` | `?symbol&timeframe&from&to&featureSet` — point-in-time feature vectors |
| GET | `/api/v1/regime/current` | `?symbol&timeframe` — current regime + probabilities + evidence |
| GET | `/api/v1/regime/history` | Regime timeline for charting/audit |

### Backtesting & Calibration (M3)
| POST | `/api/v1/backtests` | 202 — queue backtest `{strategyVersionId, config}` |
| GET | `/api/v1/backtests` / `/:id` | Status + metrics + equity curve |
| POST | `/api/v1/backtests/:id/walk-forward` | 202 — queue WF analysis |
| POST | `/api/v1/backtests/:id/monte-carlo` | 202 — queue MC `{iterations, method}` |
| POST | `/api/v1/backtests/:id/stress` | 202 — queue scenario `{scenario | syntheticConfig}` |
| GET | `/api/v1/calibration/reports` | Expected-vs-actual reports; `breached=true` filter |

### Position Sizing (M4)
| POST | `/api/v1/position-sizing/calculate` | Synchronous calc `{method, inputs}`; returns size, exposure, portfolio risk, per-limit checks (incl. M9 budgets/concentration + M10 capacity), `approved` |
| GET | `/api/v1/risk/limits` / PUT `/api/v1/risk/limits/:key` | Read/update hard limits (PUT requires reason; ADMIN role; audit-logged) |

### Portfolio Construction (M9)
| GET | `/api/v1/portfolio-construction/correlation` | Latest matrix `?window&method&regime`; history |
| GET/PUT | `/api/v1/portfolio-construction/risk-budgets` `/:scope` | Budgets per strategy/asset/regime (PUT requires reason; audit-logged) |
| POST | `/api/v1/portfolio-construction/allocation-plans` | 202 — compute proposal `{portfolioId, method}` |
| GET | `/api/v1/portfolio-construction/allocation-plans` `/:id` | Proposals; applying one requires approval workflow |

### Strategy Capacity (M10)
| GET | `/api/v1/capacity/current` | Latest CapacityAssessment: portfolio/margin/risk capacity + utilization |
| GET | `/api/v1/capacity/assessments` | History |
| GET | `/api/v1/capacity/prioritization` | Latest signal ranking: scores, components, admitted vs CAPACITY_DEFERRED, binding constraints |

### Data Quality (M5)
| GET | `/api/v1/data-quality/reports` | Filter by exchange/symbol/timeframe/status |
| GET | `/api/v1/data-quality/reports/:id` | Full check breakdown + diagnostics |
| POST | `/api/v1/data-quality/validate` | 202 — on-demand validation of a scope/window |

### Market Data (Phase 1)
| GET | `/api/v1/market/candles` | `?exchange&symbol&timeframe&from&to` — OHLCV series |
| GET | `/api/v1/market/options/chain` | `?underlying&exchange=DERIBIT&ts?` — latest (or as-of) chain: aggregates + strike-level contracts (expiry, strike, IV, greeks, OI, volume, bid/ask) |
| GET | `/api/v1/market/flow` | `?symbol&from&to` — funding rate, OI + OI delta, long/short ratio time series |

### Portfolio & Analytics (M6)
| GET | `/api/v1/portfolio` / `/:id/snapshots` | Overview + time series |
| GET | `/api/v1/analytics/equity-curve` | `?portfolioId&from&to&resolution` |
| GET | `/api/v1/analytics/drawdown` | Drawdown curve + max-DD episodes |
| GET | `/api/v1/analytics/monthly-returns` | Heatmap matrix |
| GET | `/api/v1/analytics/rolling` | `?metric=sharpe|volatility&window=30d` |
| GET | `/api/v1/analytics/trade-distribution` | R-multiple / PnL histograms |
| GET | `/api/v1/analytics/attribution` | Per-strategy / per-symbol contribution |
| GET | `/api/v1/analytics/benchmark` | vs BTC / ETH buy-and-hold |
| GET | `/api/v1/analytics/strategy-health` | Composite health score per active strategy |
| POST | `/api/v1/exports` | 202 — `{report, format: csv|json|pdf}` → download URL |

### Governance (M7)
| GET/POST | `/api/v1/strategies` | Registry |
| GET | `/api/v1/strategies/:id/versions` | Version history with diffs |
| POST | `/api/v1/strategies/:id/versions` | New version (mandatory: description, hypothesis, entry/exit logic, risk rules, failure conditions) |
| POST | `/api/v1/strategy-versions/:id/transition` | `{to, reason}` — state machine enforced; 409 on illegal transition |
| GET/POST | `/api/v1/approvals` | Approval queue |
| POST | `/api/v1/approvals/:id/decision` | `{decision: APPROVED|REJECTED, note}` — requester ≠ reviewer enforced |
| GET | `/api/v1/audit-logs` | Filter by entity/actor/action/time |

### Risk & Defense
| GET | `/api/v1/risk/events` | Detector events; filter type/severity/resolved |
| GET | `/api/v1/risk/mode` | Current mode + history |
| POST | `/api/v1/risk/mode` | `{mode, reason}` — escalation immediate; de-escalation from RISK_OFF/FROZEN creates an ApprovalRequest instead of acting (202) |
| GET/PUT | `/api/v1/risk/detectors` `/:detector` | Detector configs (PUT audit-logged) |

### System
| GET | `/api/v1/system/health` | Per-component status (db, redis, quant svc, connectors, queues) |
| GET | `/api/v1/system/jobs` | JobRun history; queue depths |
| GET | `/api/v1/alerts` / POST `/:id/read` | Alert inbox |

### Realtime (SSE)
`GET /api/v1/stream?channels=signals,risk,prices,system`
→ named events: `signal.published`, `signal.rejected`, `risk.event`,
`risk.mode.changed`, `price.tick`, `dq.report`, `job.update`. Heartbeat every 15s;
`Last-Event-ID` resume supported.

## 3. Internal Quant API (FastAPI)

All request/response bodies validate against JSON Schemas in
`packages/core/contracts` (Pydantic models generated from them).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/indicators/compute` | `{candles_ref | window, indicators[]}` → raw indicator values |
| POST | `/features/compute` | `{scope, feature_set, version, market_data}` → computed feature vector + canonical `featureHash`. **Quant is stateless:** the TS caller (workers) verifies DQ ≥ 90 *before* calling and persists the `FeatureSnapshot` *after* — Python computes, TypeScript owns admission + persistence |
| POST | `/regime/classify` | `{feature_snapshot_id}` → `{regime (7-state), probabilities, evidence}` |
| POST | `/dq/statistical` | Stage-B checks → `{checks[], deductions}` |
| POST | `/sizing/calculate` | `{method, portfolio_value, risk_per_trade, stop_distance, volatility}` → `{position_size, max_exposure, portfolio_risk_pct}` (numbers only — limit approval happens in TS gate layer) |
| POST | `/portfolio/correlation` | `{assets, window, method, regime?}` → matrix |
| POST | `/portfolio/allocate` | `{portfolio_state, risk_budgets, correlation_ref, method}` → allocation proposal + risk contributions |
| POST | `/capacity/assess` | `{portfolio_state, limits, budgets, candidate_signals[]}` → capacity dims + deterministic prioritization ranking |
| POST | `/backtest/run` | Long-running; worker polls `/backtest/:id/status` or receives callback |
| POST | `/walkforward/run` | |
| POST | `/montecarlo/run` | |
| POST | `/stress/run` | |
| POST | `/metrics/compute` | Shared performance-metrics module (same code path as backtests) |
| GET | `/health` | Liveness/readiness |

**Boundary rule:** Python returns measurements; TypeScript (`packages/core/gates`)
makes pass/fail decisions. This keeps the risk-decision surface in one audited place.

## 4. Core Cross-Language Contracts (excerpt)

```ts
// packages/core/contracts → generated TS + Pydantic
interface SignalCandidate {
  symbol: string; exchange: Exchange; assetType: AssetType; timeframe: Timeframe;
  state: SignalState;
  confidence: number;            // 0–1
  risk_score: number;            // 0–100
  volatility_score: number;
  liquidity_score: number;
  market_regime: MarketRegime;
  expected_rr: number;
  entry: string; stop_loss: string; take_profit: string;   // decimal strings
  invalidation_point: string;
  reasoning: string;
  failure_conditions: string[];
  // reproducibility quintuple
  dataset_hash: string;
  feature_hash: string;
  feature_snapshot_id: string;
  strategy_version_id: string;
  dq_report_id: string;
}

interface GateResult {
  gate: GateType; passed: boolean;
  measured: unknown; threshold: unknown; detail: string;
}
```

## 5. Error Codes (domain)

`DATA_QUALITY_BELOW_THRESHOLD` · `RISK_REWARD_TOO_LOW` · `RISK_LIMIT_BREACHED` ·
`RISK_BUDGET_EXCEEDED` · `CONCENTRATION_CAP_EXCEEDED` · `CAPACITY_EXHAUSTED` ·
`REGIME_NOT_PERMITTED` · `VOLATILITY_FILTER_ACTIVE` · `RISK_MODE_BLOCKS_ACTION` ·
`ILLEGAL_STATE_TRANSITION` · `APPROVAL_REQUIRED` · `SELF_APPROVAL_FORBIDDEN` ·
`REASON_REQUIRED` · `STALE_DATA` · `FEATURE_SNAPSHOT_MISSING`
