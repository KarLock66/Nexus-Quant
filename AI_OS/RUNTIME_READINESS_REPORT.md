# Runtime Readiness Report — Zero-Demo Runtime Completion

**Date:** 2026-07-04 · **Branch:** `remediation/step8-featurehash-reproducibility`
**Objective:** Remove every demo/synthetic dependency from the production trading runtime, preserve demo behavior exclusively behind the explicit `DEMO_MODE` flag, fail closed when a production dependency is missing, and verify the full chain end-to-end on live market data.

---

## 1. Audit method

Full-repo sweep for `demo | mock | seed | PAGE-TEST | fake | placeholder | synthetic` (742 occurrences / 141 files), then a stage-by-stage trace of the runtime:

```
Exchange → Ingestion → Market Data → Feature Snapshot → Strategy Evaluation
→ Signal Generation → Execution → Positions → Portfolio → Dashboard
```

Occurrences in tests, CI seal harnesses, and docs are legitimate and were left untouched. Findings below cover only **production execution paths**.

## 2. Stage-by-stage disposition

| Stage | Production implementation | Demo/synthetic path | Disposition |
|---|---|---|---|
| Exchange | Deribit + Binance connectors (public endpoints) | `DEMO` connector (seeded PRNG) | Already fail-closed: selecting the DEMO venue without `DEMO_MODE=true` refuses to start (`services/ingestion/src/lib/env.ts`) |
| Ingestion | `runLiveIngestion` daemon (WS candles/ticks/orderbook + REST flow) | `demo-ingest` CLI wrote synthetic rows into shared market tables **without any gate** | **FIXED** — CLI now refuses to run unless `DEMO_MODE=true` |
| Market data (marks) | `DbQuoteTransport` → `RealtimeProvider` (orderbook → tick → candle, 60s staleness fail-closed) | **No venue filter** — fresh DEMO rows could become the production mark | **FIXED** — DEMO venue excluded from every mark query unless `allowDemoVenue` (wired from `DEMO_MODE`); + 2 new tests |
| Market data (default) | `MARKET_DATA_SOURCE=realtime` | **Silent default** was `demoMarketDataProvider()` (fixed synthetic quotes) for any armed broker | **FIXED** — no source configured + no `DEMO_MODE` ⇒ execution stays **UNARMED** (fail-closed, signals still flow, CRITICAL log) |
| Feature snapshots | Ingestion bridge → quant `/features/compute` (Python authority, featureHash) | DEMO-lineage snapshots share the same `featureSetId` | **FIXED** — production tick excludes `exchange=DEMO` snapshots from signal generation (`orchestrator.ts`) |
| Strategy evaluation | `resolvePersistedLineage` (newest ACTIVE StrategyVersion) | `ensureSignalDemoChain` bootstrap | Already gated behind `DEMO_MODE`; production skips fail-closed when no lineage exists |
| Signal generation | Pure engine + lineage verification + idempotent persistence | — | Clean |
| Execution | Paper/simulated brokers; `RealBroker` is interface-only (throws) | Demo quotes as marks (see above) | Marks fixed; real venue routing remains a blocker (§5.1) |
| Positions / Portfolio | In-memory event-sourced state + optional NDJSON journals | — | **Not persisted to DB** — blocker (§5.2) |
| Dashboard / APIs | Prisma reads of persisted truth; DEMO rows excluded or explicitly labeled (`market-price.ts`, `dashboard.ts`) | Test fixtures (`terminal-fixtures.ts` etc.) | Fixtures are imported **only by tests**; no runtime use. Clean |

## 3. Changes applied

1. **`services/workers/src/market/db-quote-transport.ts`** — DEMO-venue rows excluded from orderbook/tick/candle mark queries by default; `allowDemoVenue` opt-in wired from `DEMO_MODE`. Tests added in `db-quote-transport.test.ts`.
2. **`services/workers/src/index.ts`** — `buildMarketDataProvider()` no longer silently defaults to demo quotes: realtime → real marks; `DEMO_MODE` → demo quotes (logged); otherwise `undefined` and `buildExecution()` leaves execution unarmed (fail-closed).
3. **`services/workers/src/pipeline/orchestrator.ts`** — production ticks (no demo opt-in) exclude `exchange=DEMO` FeatureSnapshots from signal generation.
4. **`services/ingestion/src/cli/demo-ingest.ts`** — refuses to run without `DEMO_MODE=true` (it writes synthetic rows into the shared market tables).
5. **`scripts/start.prod.ts`** — new required `demo-mode` check: production startup validation **fails** while `DEMO_MODE` is enabled.
6. **`docker/quant.Dockerfile`** — pinned the ADR-0001 determinism env (`OMP_NUM_THREADS` etc.). The production quant image previously **could not boot** (entrypoint fail-closed on the missing vars; only the dev image and CI compose had them).
7. **`.env.example`** — `DEMO_MODE=false` default; removed unused `NEXT_PUBLIC_DEMO_MODE`; added a documented production-runtime block (`INGEST_EXCHANGE=DERIBIT`, `MARKET_BROKER`, `MARKET_DATA_SOURCE=realtime`, journals, `RISK_ENGINE`, `CONTROL_PLANE`).
8. **Local `.env` + `packages/db/.env`** — flipped `DEMO_MODE=true → false`. **Root cause worth knowing:** `@prisma/client` auto-loads `.env` (dotenv), so any service importing `@nexus/db` silently inherited `DEMO_MODE=true` even when the shell env was clean. The `start.prod.ts` check now catches this class of leak.

**Verification of changes:** full monorepo suite green — 17/17 turbo tasks, including workers 194/194, ingestion 74/74, web 159/159.

## 4. End-to-end verification (live data, `DEMO_MODE=false`)

Stack: TimescaleDB + Redis + quant (rebuilt image) via docker compose; base seed (`pnpm db:seed` — reference/config data only); one **operator-registered** ACTIVE StrategyVersion (`createdBy: operator:runtime-readiness`); live ingestion daemon against **Deribit**; workers with `MARKET_BROKER=paper`, `MARKET_DATA_SOURCE=realtime`.

| Evidence | Result |
|---|---|
| Fresh market data | 480 H1 candles, 186 ticks, 381 orderbook snapshots, 1,370 funding rows — all `exchange=DERIBIT`, freshest rows seconds old |
| Data quality | 291 real DQ reports, score 98 `PASSED` |
| Feature snapshots | `core-technical@v1` computed by the quant service from 240 live candles per symbol, real `featureHash`, `exchange=DERIBIT` |
| Strategy evaluation | Lineage resolved to the operator strategy (`cmr5k8l2o0002uq2kequvc68l`) — **no demo chain invoked** (`demoBootstrap:false`) |
| Signals | `EngineSignal` rows persisted with `lineageValid:true`, `origin: DERIBIT` (BTC-PERP LONG 0.1935, ETH-PERP LONG 0.2205) |
| Execution | Paper fills marked against **live Deribit marks** (`demoVenueAdmitted:false`) — BTC avg 62,617.71 → 62,623.97 tracking the real feed tick-to-tick |
| Positions/portfolio | In-memory adapter state advanced per tick (`filled:2` per tick); **not persisted** (see §5.2) |
| Dashboard | `/api/v1/dashboard/overview`: latest signals `origin:"DERIBIT"`, production strategy registry `total:1/active:1` with demo counted separately, live DQ timestamp; `portfolio:null` (truthful — no snapshot writer exists) |
| Portfolio terminal | `/api/v1/portfolio/summary` derived from real served decisions: 2 candidates, status `BLOCKED` (control plane not armed — correct fail-closed) |
| Negative test | `pnpm start:prod` with `DEMO_MODE=true` → `✗ STARTUP FAILED — required component(s) down: demo-mode` |

## 5. Remaining blockers for continuous live trading

1. **No real venue order routing.** `resolveBroker("real")` returns the interface-only stub (fail-closed throw); `createRealBroker(transport)` exists but no venue order transport (Deribit private API, auth, order lifecycle) is implemented. Until then, only paper/simulated execution is possible. *(Phase 11A2 execution-adapter foundation is the seam to build on.)*
2. **Executed positions/portfolio are not persisted.** Nothing writes `PortfolioSnapshot` (or any position table) — execution state lives in the in-memory adapter plus the opt-in NDJSON journals. The dashboard portfolio card is permanently `null` and equity/drawdown risk limits (DAILY_DD etc.) have no persisted portfolio series to evaluate against.
3. **No production strategy-registration path.** `StrategyVersion` rows are created only by the demo chain and an e2e CLI. The governance/approval flow does not create or activate strategies; verification required a manual operator script. A governed register→approve→activate path is needed.
4. **Deployment topology is demo-only.** `docker/docker-compose.yml` runs every app service with `DEMO_MODE:"true"` and no production compose/profile exists for the live daemons (ingestion, workers, web). Redis is mapped to host port 6380 while `.env.example` documents 6379. A production profile with `INGEST_EXCHANGE=DERIBIT`, `MARKET_DATA_SOURCE=realtime`, journals, `RISK_ENGINE=on`, `CONTROL_PLANE=on` and restart policies is required for continuous operation.
5. **Risk engine + control plane are default-off.** They work (sealed in Phases 8/9.7) but continuous live trading must run with both armed and with durable journal paths; the verification run exercised neither (portfolio API correctly reported `BLOCKED`).
6. **Feature coverage is a single set.** Only `core-technical@v1` (H1) is computed live; options/flow/regime/risk feature-set definitions exist but have no live computation path, so strategies are limited to one signal family.
7. **Ops hygiene on Windows hosts.** Prisma's dotenv auto-load can resurrect `DEMO_MODE` from any stray `.env` (now caught by `start:prod`); WinNAT port-reservation for 5432 must stay excluded for the DB to bind.

## 6. Conclusion

Every stage of the runtime now either uses the real production implementation or fails closed; synthetic behavior exists solely behind an explicit `DEMO_MODE=true` opt-in, and production startup validation refuses to pass while that flag is set. The chain Exchange → Dashboard was demonstrated live on Deribit data with zero demo participation. The platform is **signal-ready and paper-execution-ready in production mode**; continuous live trading is blocked on real order routing (§5.1), persisted portfolio state (§5.2), and a governed strategy-registration path (§5.3).
