# TASK — Active Work

## Current Task

**Phase 11B — Production data integrity lock (zero-synthetic runtime).** COMPLETE
(2026-07-04). One cohesive change across backend / pipeline / API / frontend / CI:

- **A. Demo elimination:** DEMO_MODE and every synthetic injection path REMOVED
  from the runtime (demo signal chain, demo seed, demo-ingest CLI, demo quote
  provider + the `MarketExecutionAdapter` silent default, demo connector out of
  the registry, DEMO-venue admission opt-ins). CI/test fixtures now live in
  `services/workers/src/ci/fixtures.ts` + `services/ingestion/src/ci/` — never
  importable from a production boot path. `start:prod` fails if a legacy
  DEMO_MODE/DEMO_SEED flag is even present in the env.
- **B. Pipeline determinism lock:** `runSignalPipelineTick` THROWS
  `PipelineDataError` on missing lineage/snapshots (no fallback), iterates in
  total (ts,id)+symbol order, and fingerprints its exact input (`inputHash`,
  sha256) every tick.
- **C. featureHash envelope v2 (quant):** hash = sha256(canonical JSON of
  {as_of_ts (last-candle ts), feature_set, version, logic_hash, features}) —
  binds normalized data + versioned pipeline logic (`FEATURE_PIPELINE_LOGIC_HASH`
  over the pinned-numerics descriptor) + the deterministic tick timestamp; no
  env/clock/parallelism dependence. Goldens regenerated; 10-run regression +
  env/clock-immunity + ts-canonicalization tests added (quant 35 green).
- **D. API contract:** every `/api/v1/signals/*` JSON route returns
  {status, data|null, error|null, meta{source, timestamp, featureHash}} via
  `apps/web/src/lib/api-envelope.ts`; nextCursor moved to meta; no partial
  success, no silent empties. SSE stream keeps explicit `stream-error` frames.
- **E/F. Frontend + health truth:** demo-seed instructions and DEMO_MODE
  branches removed (market-price venue filter now unconditional); system
  monitoring never injects a synthetic connector row; /ops/health remains pure
  infra probes (DB/Redis/quant/ingestion/workers).
- **G. Golden snapshot gate:** `ci:golden` (also PHASE G inside `ci:harness`):
  10× reset→tick→snapshot must be byte-identical (counters, rows, provenance,
  inputHash). Verified live against a disposable TimescaleDB: 10/10 identical.

Verification: repo typecheck green; all package builds green (db `prisma
generate` skipped locally only because the running dev stack holds the engine
DLL; its tsc half verified); 852 TS tests + 35 quant tests green; full
`ci:harness` (phases 1,2,4,G,6,7,8 + HTTP 5,3) run against a disposable DB.

---

## (History) FINAL PRODUCTION COMPLETION

**FINAL PRODUCTION COMPLETION — four remaining blockers eliminated.** COMPLETE +
E2E-VERIFIED on live infra (2026-07-04), UNCOMMITTED on branch
`remediation/step8-featurehash-reproducibility`. Full report:
`AI_OS/FINAL_PRODUCTION_COMPLETION_REPORT.md`.

1. **Real broker** — `services/workers/src/market/deribit-order-transport.ts`
   (Deribit private JSON-RPC, LINEAR USDC perps, market+IOC, round-DOWN lot sizing,
   honest CANCELLED on shortfall, overfill→throw, label-based ambiguous-failure
   recovery, OAuth2 cached auth, DERIBIT_ENV default test) behind the sealed
   `createRealBroker` seam; boot gate `buildBroker()` in workers `index.ts`
   (real requires: no DEMO_MODE + realtime marks + journal + creds, else UNARMED).
   27 tests; every emitted stream satisfies sealed `reduceOrder`.
2. **Persistent portfolio** — `market/portfolio-ledger.ts` (`PORTFOLIO_LEDGER=on`):
   per-tick PortfolioSnapshot (equity/exposure/drawdown/positions) derived VERBATIM
   from sealed valuateAccount; peak-equity recovery across restarts; init-failure →
   unarmed. 9 tests. Verified live: dashboard portfolio card now real; restart
   replayed 78 journal records with exact peak continuity.
3. **Strategy governance** — `apps/web/src/lib/governance-actions.ts` + 3
   operator-token routes (register / review approvals/[id] / versions/[id]/retire):
   fail-closed field validation, DRAFT+PENDING only on register, FOUR-EYES review,
   immutable decisions, single-ACTIVE-per-strategy on approve, demo actors refused,
   every transition audited in-transaction. 21 tests + full live HTTP E2E.
4. **Production deployment** — `docker/docker-compose.prod.yml` (zero-demo, migrate
   one-shot gate, restart policies, journals volume, all gates armed, required
   secrets fail-closed) + `start.prod.ts` broker check + `.env.example` prod block.

Verification: repo typecheck+build green; **853 tests green** (workers 230, web 180,
rest unchanged); compose config valid; governance/ledger/restart/fail-closed all
E2E-verified against live Postgres+Redis+quant+Deribit data. Remaining EXTERNAL
dependencies only: Deribit API credentials (test then live), funded account,
production host + secrets, second operator identity for four-eyes.

---

## (History) Phase 10C-1

**Phase 10C-1 — Production Actionable Decision Engine.** COMPLETE + LIVE-SEALED
(QUALIFIED PASS) (2026-06-29), UNCOMMITTED on branch
`remediation/step8-featurehash-reproducibility`. Makes the Trading Decision Center
(Phases 10A-1/10A-2, SEALED) ACTIONABLE: a new pure package `@nexus/trading-plan`
derives, per signal, an action verdict (Should/Can I trade · Why), a 10-item execution
checklist, a risk checklist (max-loss/capital/R/distance/ATR%/reward%/hold/category), a
9-trigger invalidation list, and a 0–100 readiness score — all from the served
`TradingDecision` (SSoT, consumed verbatim), reshaped on-read, recomputing nothing.
ADDITIVE-ONLY: new `DecisionTerminal` on `/signals` above the untouched 10A-2 terminal,
two new `api/v1/signals/{trade-plan,readiness}` routes; sealed packages byte-for-byte.

### Phase 10C-1 active files

New: `packages/trading-plan/` (pure: types, util, facts, summary, execution-checklist,
risk-checklist, invalidation, readiness, plan, index + 6 test files = 44 tests);
web `lib/trade-plan(.ts,-types,-client,-contract.test)`, `components/decision-terminal.tsx`
(+ `decision-terminal.render.test.ts`), routes `app/api/v1/signals/{trade-plan,readiness}/`.
Modified (additive): `app/(dashboard)/signals/page.tsx` (mount DecisionTerminal),
`apps/web/package.json` (+`@nexus/trading-plan`), `packages/trading-plan/package.json`
(+`@nexus/core` for the sealed MIN_DATA_QUALITY_SCORE floor — adversarial-review fix).

### Phase 10C-1 status

COMPLETE + LIVE-SEALED (QUALIFIED). 375 tests green (trading-plan 44 / trading-decision 37
/ web 102 / workers 192); repo typecheck + build green; all 7 signal/control APIs HTTP 200
on a real Postgres+Redis+quant stack; provenance audit PASS (0 NaN/undefined/invalid/
fabricated; null↔UNAVAILABLE upheld); 9-agent adversarial review 5/6 clean + 1 fix + 2
rejected. QUALIFIED gaps (carried forward, not defects): demo has no live book → marks
stale → live directional risk LEVELS are UNAVAILABLE (REAL/DERIVED path proven by unit
tests); runtime BOOTING → live actions fail-closed to NO_TRADE; browser DOM INFERRED (no
headless browser). NOT committed (repo convention: commit on explicit request only).

---

### Earlier — Phase 9.7 (still valid; 10A/10C build on top)

**Phase 9.7 — Production Control Plane.** COMPLETE + LIVE-SEALED (2026-06-26),
UNCOMMITTED on branch `remediation/step8-featurehash-reproducibility`. Turns the
monitored runtime into a self-protecting one: a deterministic runtime state machine
(8 states), a fail-closed `canTrade()` permission engine that really blocks the live
worker, a DB-backed global kill switch, automated protection → verified recovery,
operator runbooks, an incident timeline, and an immutable audit trail, on a new
`/control` page. ADDITIVE / opt-in (`CONTROL_PLANE=on`) / default-OFF — Phases 1–9 are
byte-for-byte unchanged when off (`execution/stage.ts` NOT edited; the control gate
composes ahead of the Phase-8 risk gate at boot).

### Phase 9.7 active files

New: `packages/control/` (pure IO-free core: types, thresholds, protection, permission,
state-machine, recovery, startup, runbooks + 43 tests); `services/workers/src/control/`
(probes, store, inputs, startup, recovery, evaluator, gate + 7 tests);
`services/workers/src/ci/seal-phase97-control.ts` (11-step live seal A–K);
`packages/db/prisma/migrations/20260625000000_phase97_control_plane/`;
web `lib/control(+-types,-client)`, `components/control-center.tsx` +
`console-ui.tsx`, `app/(dashboard)/control/page.tsx`, 9 routes under
`app/api/v1/control/*`, `lib/control-contract.test.ts`.
Modified (additive): `schema.prisma` (+5 models), `services/workers/src/index.ts`
(opt-in boot wiring + gate composition), `services/workers/package.json` +
`apps/web/package.json` (+`@nexus/control`), `components/sidebar.tsx` (nav).

### Phase 9.7 status

🟢 DONE — control 43 + workers 192 (185 sealed byte-for-byte) + web 44 = **279 tests
green**; whole-repo typecheck + web build green; migration applied to live DB; **live
seal SEALED (A–K) against real Postgres+Redis+quant**. Adversarial review (7 dims, 10
agents) returned 5 clean / 1 rejected / 2 confirmed; both confirmed fixed + re-verified
(incident MANUAL_RESUME close — seal Step K; gate permission-snapshot age guard — 2 unit
tests). Human-triggered commit pending.

---

## (History) Phase 8 — Risk & Capital Control System

**Phase 8 — Risk & Capital Control System.** COMPLETE + SEALED (Phase 7 entry now
history below; Phases 1–6 sealed). New PURE, deterministic, fail-closed layer between
Signals and Execution (`services/workers/src/risk/`); minimal additive opt-in/default-off
extensions only — no sealed component redesigned.

## Status

🟢 DONE — implemented, verified green (181/181 workers tests, whole-repo build +
typecheck), UNCOMMITTED on branch `remediation/step8-featurehash-reproducibility`.
Human-triggered commit pending.

## Active Files (Phase 8)

New (`services/workers/src/risk/`):
- `types.ts` — all Phase 8 contracts (CapitalSnapshot, SizingConfig/PositionSizing,
  ExposureMetrics, ProposedOrder/OrderProjection, GateVerdict, RiskLimits,
  KillSwitchTrigger/HealthSignals, RiskEventType/RiskJournalRecord, RiskControlState).
- `money.ts` — decimal discipline (reuse + `quantizeRatio` 6dp).
- `capital.ts` — `buildCapitalSnapshot` (Deliverable 1).
- `sizer.ts` — `sizePosition` 5 modes (Deliverable 2).
- `exposure.ts` — `computeExposure` (Deliverable 4).
- `gate.ts` — `projectOrder` + `evaluatePreTrade` + `DEFAULT_RISK_LIMITS` (Deliverable 3).
- `kill-switch.ts` — `evaluateTriggers` + `currentDrawdown` (Deliverable 5).
- `state.ts` — `applyRiskRecord`/`reconstructRiskState`/`initialRiskControlState`.
- `events.ts` — `RiskEventStore` + in-memory + JSONL + `RiskJournalCorruptionError`
  (Deliverable 6).
- `recovery.ts` — `recoverRiskState` + `RiskRecoveryError` (Deliverable 7).
- `engine.ts` — `RiskEngine` orchestration.
- `integration.ts` — `createRiskExecutionGate` (opt-in hook factory).
- `index.ts` — barrel.
- `risk.test.ts` (30) — all 9 required tests + sizer/exposure/capital determinism + integration.
- `ci/phase8-risk.ts` — CI runtime check.

Additive edits (opt-in params; default-off = byte-for-byte Phase 5/6/7):
- `execution/stage.ts` — `RiskGateDecision`/`RiskGateHook` types + optional `riskGate`
  hook (runs before the Phase 5 gate) on `ExecutionStageDeps`/`CreateExecutionStageOptions`.
- `index.ts` (worker boot) — `buildRiskGate` wired via `RISK_ENGINE=on` + `RISK_JOURNAL_PATH`.
- `ci/run-all.ts` — wire `runPhase8` after Phase 7.

## Steps (Phase 8)

- [x] Capital model (immutable, derived, deterministic)
- [x] Position sizer (5 deterministic modes)
- [x] Pre-trade risk gate (6 fail-closed checks)
- [x] Portfolio exposure engine
- [x] Kill switch (7 triggers, no auto recovery, journal-projected)
- [x] Risk event model + append-only store (in-memory + JSONL)
- [x] Recovery (reconstruct risk state from journal, fail-closed)
- [x] Tests (9 required + determinism + integration) + whole-repo verification green
- [ ] Commit (await user)

## Evidence (Phase 8, real runtime)

- `pnpm -r typecheck` exit 0; `pnpm -r build` exit 0
- vitest workers 181/181 (151 prior byte-for-byte + 30 new); position/leverage/
  concentration/margin/daily-loss rejections; kill-switch activation + restart
  persistence (in-mem + JSONL); replay + recovery equivalence; integrated stage blocks
  + approves with one RISK_CHECK_PASSED per fill.
- NOT run here (needs Postgres): `ci:harness` Phase 8.

---

## (History) Phase 7 — Order & Position Durability + Distribution Bridge

COMPLETE (Phases 1–6 sealed). Minimal architecture extensions only; no sealed component
redesigned. Verified green (151/151 workers tests at the time), UNCOMMITTED.

## Active Files (Phase 7)

New:
- `services/workers/src/market/event-store.ts` — `MarketEventStore` + in-memory +
  JSONL file impls; `MarketJournalRecord`/`MarketJournalInput`; `JournalCorruptionError`.
- `services/workers/src/market/recovery.ts` — `recoverMarketState`, `MarketRecoveryError`.
- `services/workers/src/bus/{types,redis-bus,bullmq-bus,index}.ts` — distributed bus.
- `services/workers/src/market/durability.test.ts` (13), `market/realtime.test.ts` (7),
  `bus/bus.test.ts` (9).
- `services/workers/src/ci/phase7-durability.ts` — CI runtime check.

Additive edits (opt-in params; default-off = byte-for-byte Phase 6):
- `market/stage.ts` — `eventStore` / `initialMarketState` / `initialPortfolioMirror`
  options + journal-then-commit hook.
- `market/market-data.ts` — `RealtimeProvider(transport?)` + `RealtimeQuoteTransport`.
- `market/broker.ts` — `createRealBroker(transport)` + `RealtimeOrderTransport`
  (the `RealBroker` interface-only singleton kept for the sealed test).
- `market/index.ts` — export event-store + recovery.
- `execution/stage.ts` — optional `bus` / `portfolioState` on `createExecutionStage`.
- `services/workers/src/index.ts` — boot: `buildDecisionBus` (BUS_BACKEND) +
  `buildExecution` (recover→seed, fail-closed halt).
- `ci/run-all.ts` — wire `runPhase7` after Phase 6.

## Steps

- [x] Append-only event store (interface + in-memory + JSONL file)
- [x] Restart reconstruction via the existing pure folds (recovery.ts)
- [x] Fail-closed recovery gate (integrity + reconcile → halt)
- [x] Durable commit hook (journal-then-commit, opt-in)
- [x] Distributed bus (Redis + BullMQ bridges, opt-in, interfaces preserved)
- [x] Realtime connectors (transport-injected, default-off)
- [x] Worker boot wiring + CI harness phase7
- [x] Tests + whole-repo verification green
- [ ] Commit (await user)

## Evidence (real runtime)

- `pnpm -r typecheck` exit 0; `pnpm -r build` exit 0
- vitest workers 151/151 (122 sealed unchanged + 29 new); restart-rebuild equals live
  state; tampered snapshot + divergent result both HALT (fail-closed); torn-line
  tolerated, mid-file/seq corruption rejected; bus round-trip/fan-out/durable-retry;
  realtime provider+broker drive the unchanged stage to FILLED+reconcile+recover.
- NOT run here (needs Postgres): `ci:harness` Phase 7 (live-DB only).

## Next Action (Phases 7 + 8)

Await the user's call to commit (both phases are uncommitted on the same branch). Do
NOT revisit Phases 1–6 (sealed). Deferred (need approval): live Redis/BullMQ + real
venue transport verification; optional Redis-Streams `MarketEventStore` impl; clock-
based daily-PnL reset for the Phase 8 risk engine; `ci:harness` (6/7/8) on live Postgres.
