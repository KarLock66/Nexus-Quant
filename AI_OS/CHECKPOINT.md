# CHECKPOINT — Resume Point

> Update this file before every pause. Next session resumes from here in one read.

> NOTE (realigned 2026-06-21): this file had drifted to "Phase 3 latest". Reality
> (git log + memory `nexus-quant-project-state.md`): Phases 1–6 are SEALED and
> Phase 7 is now implemented + verified. The per-step Phase 3 detail is preserved
> below the line as history; the live state is the Phase 7 section.

## Last Completed Step

**FINAL PRODUCTION COMPLETION — all four remaining production blockers eliminated
and E2E-verified on live infra** (2026-07-04; uncommitted, branch
`remediation/step8-featurehash-reproducibility`). See
`AI_OS/FINAL_PRODUCTION_COMPLETION_REPORT.md` for the full evidence table.

Delivered: (1) Deribit private-API order transport (`market/deribit-order-transport.ts`,
linear USDC perps, IOC market orders, round-down sizing, honest shortfall CANCELLED,
label recovery for ambiguous failures) behind the sealed `createRealBroker` seam with a
fail-closed `buildBroker()` boot gate; (2) persistent portfolio & equity ledger
(`market/portfolio-ledger.ts`, `PORTFOLIO_LEDGER=on`, per-tick PortfolioSnapshot,
peak-equity restart continuity — dashboard portfolio card now real); (3) strategy
governance register→approve→activate (`lib/governance-actions.ts` + 3 operator-token
routes; four-eyes, immutable reviews, single-ACTIVE-per-strategy, all audited
in-transaction); (4) production deployment runtime (`docker/docker-compose.prod.yml`
zero-demo topology + migrate gate + restart policies; `start.prod.ts` broker check).

Verification: repo typecheck/build green; **853 tests green** (230 workers / 180 web;
all 796 prior tests byte-for-byte); live E2E: governance full path over HTTP incl.
negatives, ledger persisting against live Deribit marks with paper fills, restart
recovery exact (78 records + peak equity), real-broker fail-closed boot, venue
metadata validated against the real Deribit API. Remaining external dependencies
ONLY: Deribit credentials (test→live), funded account, prod host secrets, second
operator identity.

### Earlier — Phase 10C-1 (still valid; this builds on top)

**PHASE 10C-1 — Production Actionable Decision Engine. COMPLETE + LIVE-SEALED
(QUALIFIED PASS)** (2026-06-29; uncommitted, branch
`remediation/step8-featurehash-reproducibility`).

Turns the information terminal (Phases 10A-1/10A-2 Trading Decision Center, SEALED) into a
DECISION terminal: every signal now answers *Should I trade? · Can I trade? · Why? · What
is the exact plan? · What breaks it?* — WITHOUT changing any signal logic. ADDITIVE-ONLY:
new pure package `@nexus/trading-plan` + two new web routes + a new `DecisionTerminal`
component on `/signals` ABOVE the untouched 10A-2 `TradingTerminal`. `TradingDecision`
stays the single source of truth; nothing already computed is recomputed.

New package `@nexus/trading-plan` (pure, IO-free, clock-injected, deterministic,
fail-closed): `deriveFacts` (one shared derivation; reads decision Measures verbatim) →
`buildDecisionSummary` (Action verdict), `buildExecutionChecklist` (10 PASS/FAIL/UNKNOWN),
`buildRiskChecklist` (REAL/DERIVED/ESTIMATED/UNAVAILABLE), `buildInvalidation` (9
triggers), `buildTradeReadiness` (0–100, documented weights sum 100). Web tier:
`lib/trade-plan.ts` (reuses `getTradingDecisions`/`getRuntimeStateView`/`getKillSwitch`,
fail-closed kill default), routes `api/v1/signals/{trade-plan,readiness}` (ApiEnvelope,
force-dynamic, nodejs), `components/decision-terminal.tsx` (5 panels, reuses console-ui +
terminal-viz; no chart libs).

Verification: **trading-plan 44 + trading-decision 37 + web 102 + workers 192 = 375 tests
green**; whole-repo typecheck + `pnpm -r build` green; sealed packages byte-for-byte
(37/192 unchanged → zero regression). **Live seal** on real Postgres+Redis+quant: 5
migrations + Timescale applied, demo seed-42 ingested (BTC/ETH-USDT H1/H4/D1, DQ 100), 4
e2e-pipeline runs SEALED with replay=MATCH (BTC-USDT H1 FLAT, ETH-USDT H1 **LONG**), all
**7 APIs HTTP 200** (decisions/ranking/consensus/trade-plan/readiness/runtime-state +
/signals), force-dynamic live-recompute confirmed, provenance audit **PASS** (0 NaN / 0
undefined / 0 Infinity / 0 invalid-provenance / 0 fail-open / 0 fabricated; null↔UNAVAILABLE
upheld). A 9-agent adversarial review (SSoT · determinism · fail-closed · provenance ·
sealed · API) returned **5/6 dimensions clean**; 1 confirmed finding fixed (minDqScore now
imports sealed `@nexus/core MIN_DATA_QUALITY_SCORE` instead of a re-typed `90`), 2 rejected
as false positives.

QUALIFIED because (documented, carried-forward gaps, not defects): the demo has no live
sub-minute book (orderbook/tick) and candles are hourly-bucketed, so the sealed
`market-price` freshness rule (≤60s) yields a null mark → directional risk LEVELS fail
closed to UNAVAILABLE live; the directional-ALLOWED-with-levels path (REAL/DERIVED risk
numbers, all-PASS checklist, READY band) is proven by the unit suite, not the live UI.
Runtime stayed BOOTING (no control-plane worker loop driving HEALTHY within freshness
bands), so live actions are correctly fail-closed to NO_TRADE. Live browser DOM is INFERRED
(no headless browser) from SSR-200 + render tests + valid live API data. NOT committed.

10C-1 invariants: TradingDecision consumed VERBATIM (direction/confidence/levels/scores/
R:R/statuses/ages never recomputed); the pure engine reads NO clock for its logic
(freshness comes off the decision) → replay-safe; every missing source fails closed to
UNKNOWN/UNAVAILABLE/null/NOT_APPLICABLE (never PASS/ALLOWED/NaN/fabricated); readiness is
gating/approval/freshness-aware (distinct from sealed 10A-2 setupGrade which is
quality-only). Do NOT fold trade-plan logic into the sealed decision engine.

### Earlier — Phase 9.7 (still valid; 10A/10C build on top)

**PHASE 9.7 — Production Control Plane. COMPLETE + LIVE-SEALED** (2026-06-26;
uncommitted, branch `remediation/step8-featurehash-reproducibility`).

Adds the CONTROL layer on top of Phase 9.6 visibility: a deterministic 8-state runtime
machine, a fail-closed `canTrade()` engine that really blocks the live worker, a
DB-backed global kill switch, automated protection → verified recovery, operator
runbooks, an incident timeline, and an immutable audit trail, on `/control`. ADDITIVE /
opt-in (`CONTROL_PLANE=on`) / default-OFF: with it off, Phases 1–9 are byte-for-byte
(185/185 sealed workers tests unchanged); `execution/stage.ts` is NOT edited — the
control gate composes ahead of the Phase-8 risk gate at boot in `index.ts`.

Verification: control 43 + workers 192 + web 44 = **279 tests green**; whole-repo
typecheck + web build green; migration `20260625000000_phase97_control_plane` applied;
**live seal SEALED (11 steps A–K)** on real Postgres+Redis+quant — DB/quant/feature/
kill → BLOCKED; recovery verified → resumed; kill survives restart; control-off path
still fills; PROTECTED→kill→resume closes the incident MANUAL_RESUME. A 10-agent
adversarial review (fail-closed, determinism, regression, no-mock, state-machine, audit,
permission) returned 5 dimensions clean, 1 finding rejected, 2 confirmed — both fixed
and re-verified.

Phase 9.7 invariants (bind control & protection): the `@nexus/control` core is PURE +
clock-injected (one source of truth for worker enforcement AND web display); EVERY gate
FAILS CLOSED (null/blocked/error/stale-snapshot → deny); the kill switch is DB-backed +
ALWAYS audited and NEVER auto-cleared (operator resume only); protection conditions
auto-recover ONLY after concrete verification; the audit log is append-only (insert-only
in code). Do NOT fold control logic into sealed phases.

---

## (History) PHASE 9 — Real Market Data Integration

**PHASE 9 — Real Market Data Integration. CODE COMPLETE + verified green; runtime
seal gated off-machine** (uncommitted, branch `remediation/step8-featurehash-reproducibility`).

Replaces the demo feed with REAL exchange data flowing through the EXISTING runtime
(`Exchange → adapter → DQ → Features → Signals → Risk → Execution (paper)`). Built as
ADDITIVE / opt-in / default-OFF extensions — the SEALED worker signal tick
(`pipeline/orchestrator.ts`) is UNCHANGED; the worker reads "latest FeatureSnapshot per
symbol by ts desc", so real snapshots supersede the demo bootstrap with no worker edit.
Deliverables:

- **DB (additive)** — `MarketTick` + `OrderbookSnapshot` tables + `TradeSide` enum;
  migration `20260622000000_phase9_market_tick_orderbook`; Timescale hypertable
  registration. Composite PKs include `ts` (idempotent + hypertable-ready).
- **Connectors** — NEW `connectors/binance.ts` (Binance USDⓈ-M: REST klines/funding/OI/
  LSR×3/depth + WS aggTrade/bookTicker/markPrice/kline); EXTENDED `deribit.ts` streamLive
  (ticker + trades channels → mark/best-bid-ask/funding/trade ticks); `connectors/index.ts`
  `resolveConnector` (demo|deribit|binance; bybit fail-closed). `LiveHandlers` gains
  optional `onTrade`/`onQuote`/`onFunding` (+ `NormalizedTick`/`NormalizedQuote`) — candle-
  only callers unchanged.
- **Persistence** — `persistence/ticks.ts`: `upsertTicks` (createMany skipDuplicates on the
  tick PK — idempotent under reconnect) + `upsertOrderbookSnapshots` (upsert on
  (exchange,symbol,ts)). Same fail-closed/decimal discipline as `persistence/index.ts`.
- **Feature bridge** — `features/{client,bridge,index}.ts`: admitted candle window →
  POST quant `/features/compute` → upsert one `FeatureSnapshot` (opaque featureHash
  VERBATIM). Faithful mirror of the sealed workers feature consumer (the ONE documented
  smell; shared-lib extraction is a follow-up).
- **Live daemon** — `pipeline/live.ts` (bootstrap warm-up via `runBackfill` + an opt-in
  `onCandlesValidated` feature hook → live WS: candle→upsert+recompute, trade→batch tick,
  quote→throttled orderbook, funding→upsert; periodic REST flow poll; graceful close);
  replaced `index.ts` (Phase-0 skeleton → daemon, DEFAULT venue = DEMO/offline);
  `cli/live-ingest.ts`; env (`INGEST_EXCHANGE`/alias `CONNECTOR_EXCHANGE`,
  `INGEST_LIVE_TIMEFRAME`, `INGEST_FLOW_POLL_MS`); events (`DATA_TICK_INGESTED`,
  `DATA_ORDERBOOK_INGESTED`).
- **Opt-in real marks** — `market/db-quote-transport.ts` `DbQuoteTransport` (polled DB-
  backed marks for execution; FAIL-CLOSED freshness bound — a stale feed yields null →
  no order); wired in worker boot via `MARKET_DATA_SOURCE=realtime` (default-off =
  byte-for-byte Phase 6/7/8).
- **Seal harness + CI** — `ci/seal-phase9-runtime.ts` (STEP A–H: connected/bootstrap,
  live ticks+orderbook, DQ PASSED, real FeatureSnapshot, real worker → EngineSignal from
  the real snapshot through Risk→paper Execution, persistence, idempotent restart, no
  divergence); offline-deterministic (DEMO) + `PHASE9_LIVE=1` (Deribit+Binance) modes;
  quant added to `docker-compose.ci.yml`; gated `phase9-seal` `workflow_dispatch` job.

Verification (this machine): `pnpm -r build` ✅, `pnpm -r typecheck` ✅, vitest ingestion
**74/74** ✅ (incl. failure injection: malformed-tick WS drop, idempotency-under-reconnect,
DB-failure fail-closed), vitest workers **185/185** ✅ (**181 sealed byte-for-byte** + 4 new
DbQuoteTransport staleness tests — **Phase 1–8 no regression**). Adversarial review (16-agent
workflow, 6 dimensions): 2 fail-closed findings CONFIRMED + FIXED (DbQuoteTransport staleness
bound; Binance drop-on-missing-ts) + 1 entrypoint-default deviation FIXED (daemon defaults to
offline DEMO); determinism / idempotency / sealed-regression / wiring / duplication dimensions
clean.

**PHASE 9 RUNTIME SEAL — gated off-machine (NOT run here).** The quant Feature Store (DQ
Stage-B + `/features/compute`) is required and its container is DIGEST-PINNED (fail-closed
until the reproducibility bootstrap); the host venv lacks TA-Lib (and is Py 3.14, not 3.12),
and Docker was not running. Running quant on the host would violate the "no host dependency"
reproducibility rule. So the live/offline runtime seal runs via the gated CI `phase9-seal`
job (postgres+redis+quant compose). Verdict pending that run → **PHASE 9 UNSEALED** locally
(code complete + all deterministic/regression checks green).

---

**PHASE 8 — Risk & Capital Control System. COMPLETE + verified green (PHASE 8 SEALED)**
(uncommitted, branch `remediation/step8-featurehash-reproducibility`).

New PURE, deterministic, fail-closed layer between Signals and Execution
(`services/workers/src/risk/`), built as MINIMAL, opt-in, default-OFF extensions — no
sealed Phase 1–7 code path changes (the 151 prior workers tests stay byte-for-byte
green). Deliverables:

- **Capital model** (`risk/capital.ts`) — immutable `CapitalSnapshot` (accountEquity,
  availableCash, used/availableMargin, unrealized/realizedPnL, gross/netExposure)
  DERIVED via the SEALED Phase 6 `valuateAccount` (frozen, deterministic, replay-safe).
- **Position sizer** (`risk/sizer.ts`) — 5 deterministic modes (FIXED_QUANTITY,
  FIXED_NOTIONAL, PERCENT_OF_EQUITY, VOLATILITY_ADJUSTED, RISK_PER_TRADE); fail-safe
  zero size on bad input (never NaN).
- **Exposure engine** (`risk/exposure.ts`) — gross/net/long/short/leverage/utilization.
- **Pre-trade gate** (`risk/gate.ts`) — six fail-closed checks (max position size, max
  notional, max leverage, margin availability, daily-loss, concentration = notional/
  equity); insolvency (equity ≤ 0) blocks; no soft failures.
- **Kill switch** (`risk/kill-switch.ts` + `state.ts`) — 7 triggers (daily-loss,
  drawdown, leverage, market-data-stale, recovery-failure, journal-integrity, exchange-
  connectivity); halt is a journal projection (survives restart, no auto recovery).
- **Risk events** (`risk/events.ts`) — append-only `RiskEventStore` (in-memory + JSONL),
  mirroring the Phase 7 durability semantics; the 8 required event types.
- **Recovery** (`risk/recovery.ts`) — `recoverRiskState` replays the fold; corrupt
  journal → `RiskRecoveryError` (fail-closed).
- **Engine** (`risk/engine.ts`) — halted?→trigger eval→gate→journal; journal-THEN-decide
  so a write failure blocks even a passing check; halt persists in-memory even if the
  journal write fails (capital preservation).
- **Integration** — ONE additive opt-in hook on the SEALED execution stage
  (`execution/stage.ts` `riskGate?`, runs BEFORE the Phase 5 gate — both must pass);
  worker boot wires it via `RISK_ENGINE=on` (+ `RISK_JOURNAL_PATH`). Default-off =
  byte-for-byte Phase 5/6/7. CI harness `ci/phase8-risk.ts` wired into `ci/run-all.ts`.

Verification (real runtime, this machine): `pnpm -r typecheck` ✅, `pnpm -r build` ✅,
vitest workers **181/181** ✅ (151 prior byte-for-byte + 30 new: all 9 required tests —
position/leverage/concentration/margin/daily-loss rejections, kill-switch activation +
persistence, replay + recovery equivalence — plus sizer/exposure/capital determinism and
the integrated-stage block).

**PHASE 8 RUNTIME SEAL: SEALED (real infra).** Docker is now installed (v29.5.3). Brought up
Postgres + Redis (`docker/docker-compose.ci.yml`), `prisma migrate deploy` + seed, and ran a
new 10-step runtime harness `services/workers/src/ci/seal-phase8-runtime.ts` (real Postgres +
Redis + the REAL worker process + real on-disk journals; no mocks). STEP A–J ALL PASS — first
failure NONE, replay mismatch NONE, risk divergence NONE. One correctness alignment surfaced by
the seal (not a redesign): the gate-rejection path now journals the umbrella `RISK_CHECK_FAILED`
in addition to the specific `*_LIMIT_BREACHED` (engine.ts); `checksFailed` counts only the
umbrella (state.ts). 181/181 unit tests + repo typecheck/build re-verified green; ephemeral infra
torn down afterwards.

---

**PHASE 7 — Order & Position Durability + Distribution Bridge. COMPLETE + verified
green** (uncommitted, same branch).

Built as MINIMAL, opt-in, default-OFF extensions — no sealed Phase 1–6 code path
changes when the new options are absent (122/122 prior tests byte-for-byte green):

- **Append-only event store** (`services/workers/src/market/event-store.ts`) —
  `MarketEventStore` interface + `InMemoryMarketEventStore` (test default) +
  `FileMarketEventStore` (durable JSONL, restart-safe, fail-closed on
  non-contiguous seq / mid-file corruption, tolerates a torn trailing line). One
  `MarketJournalRecord` per COMMITTED execution: orderEvents (ORDER_*/FILL_*) +
  result + position + account snapshots.
- **Restart reconstruction** (`market/recovery.ts`) — `recoverMarketState` replays
  the journal through the EXISTING pure folds (`reconstructMarketState` over fills,
  `reconstructPortfolioState` over results) to rebuild Position/Account/Portfolio
  from history alone.
- **Fail-closed recovery** — two gates, either HALTS: (1) integrity (fold recomputed
  from fills must equal the recorded snapshots — tamper-evident); (2) reconcile
  (recovered broker state must reconcile with recovered portfolio). Throw =
  `MarketRecoveryError`; the worker leaves execution UNARMED (signals still flow).
- **Durable commit hook** (`market/stage.ts`, additive) — journal-THEN-commit at the
  single commit point: a write failure rejects and commits NOTHING (disk/memory
  never diverge). Gated on opt-in `eventStore`; absent = Phase 6 exactly.
- **Distributed bus** (`services/workers/src/bus/`) — `RedisChannelBus` (pub/sub
  broadcast) + `BullMqBus` (durable at-least-once) implement the generic `PubSubBus`
  shape; typed factories return the SEALED `EventBus`/`ExecutionBus`/`MarketBus`
  interfaces by structure. Selected via `BUS_BACKEND` + `REDIS_URL`; default
  in-process. Both injectable, unit-tested with in-memory fakes (no live Redis).
- **Realtime connectors** — `RealtimeProvider(transport?)` and
  `createRealBroker(transport)` give the Phase 6 interface-only stubs REAL,
  transport-injected bodies behind the unchanged abstractions. Default-OFF
  preserved: no transport / the `RealBroker` singleton still throw `interface-only`
  (the sealed tests depend on it). `resolveBroker("real")` still returns the stub.
- **Worker boot** (`market` recover→seed, `bus` selection) + **CI harness**
  (`ci/phase7-durability.ts`, wired into `ci/run-all.ts` after Phase 6).

Verification (real runtime, this machine): `pnpm -r typecheck` ✅, `pnpm -r build`
✅, vitest workers **151/151** ✅ (122 sealed + 29 new: durability 13, bus 9,
realtime 7). NOT run here (needs Postgres): `ci:harness` Phase 7 (live-DB only,
same status as Phases 1–6 harness phases).

## Current Step

Phases 7 AND 8 implemented + verified, UNCOMMITTED. Await user decision to commit
(repo convention is human-triggered commits).

## Next Step

Await authorization. Phases 7 + 8 are opt-in/default-off; nothing is wired live by
default. Open follow-ups (deferred, need approval): (a) live Redis/BullMQ + a real
venue transport are interface-complete but UNEXERCISED here — verify against a live
Redis before relying on the distributed bus; (b) a Redis-Streams `MarketEventStore`
impl (same interface) if the durable backing should move off the local JSONL file;
(c) Phase 8 "daily" PnL is currently the deterministic SESSION window (replay-safe) —
a clock-based calendar-day reset is a deliberate, deferred follow-up; (d) run
`ci:harness` (phases 6/7/8) against live Postgres to seal the runtime side.

## Recovery Instructions

1. Read `AI_OS/TASK.md` for the active file list.
2. No Docker/Postgres/Redis on this machine — verify with `pnpm -r build`/`typecheck`
   and `pnpm --filter @nexus/workers test`. DB + live-infra boundaries are doubled in
   tests; all fold/recovery/order/reconcile LOGIC is real and really executed.
3. Phase 7 invariants (bind durability + recovery): the market layer's pure folds are
   UNCHANGED (recovery only replays them); durability is journal-THEN-commit
   (fail-closed); recovery halts on integrity OR reconcile mismatch; every new path is
   opt-in/default-off so Phases 1–6 stay byte-for-byte.
4. Phase 8 invariants (bind risk & capital control): the layer is PURE + deterministic
   (capital model derives from the SEALED valuateAccount); the gate FAILS CLOSED on every
   check + on insolvency/invalid input; the kill switch is a JOURNAL projection (survives
   restart, no auto recovery); the engine journals-THEN-decides (a write failure blocks
   even a PASS); integration is ONE additive opt-in hook on execution/stage.ts
   (default-off = byte-for-byte). risk/ is self-contained — do NOT fold risk logic into
   sealed phases.
5. Do NOT rerun bootstrap or revisit Phases 1–6 (sealed). Do not rebase/stash/clean —
   the Phase 1 slice + Phase 3/6 deltas live in the working tree per prior checkpoints.

---

## (History) Phase 3 — Signal Engine + Deterministic Decision Verification

Phase 3 (STEPS 15–21) implemented + verified green (commit `ec06ca6`): first-class
`EngineSignal` model, pure deterministic Signal Engine, fail-closed lineage contract,
deterministic verification suite (A–J ×100), replay equivalence (100/100), adversarial
review (4 REAL fixed + proven, 4 FALSE). featureHash Python-sole-authority & frozen;
datasetHash TS-authoritative verbatim. Superseded as "latest" by Phases 4–6 (sealed)
and Phase 7 (above).
