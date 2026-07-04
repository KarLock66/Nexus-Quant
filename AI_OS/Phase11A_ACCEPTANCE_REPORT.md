# Phase 11A — Final Acceptance Report

**Date:** 2026-07-04 · **Branch:** `remediation/step8-featurehash-reproducibility` (UNCOMMITTED)
**Gate type:** independent acceptance — verification only; no code was optimized, refactored, redesigned, or extended. One temporary harness driver (`phase3-only.ts`) was created to run the SSE validation phase in isolation and deleted afterwards.
**Scope:** Exchange → Ingestion → Market Data → Feature Engine → Strategy Evaluation → Signal Generation → Execution → Portfolio Ledger → Dashboard → Control Plane → Replay → Recovery.

All evidence below was produced **in this acceptance session** (re-run, not inherited from prior reports), on this machine, against ephemeral real infrastructure (TimescaleDB + Redis + quant Feature Store containers), except where explicitly marked as carried-forward prior evidence.

---

## 1. Executive Summary

The platform satisfies its architectural objectives. Every re-runnable validation was re-run and is green: whole-repo TypeScript, ESLint, **853 unit/integration tests**, whole-repo production build, production compose config (fail-closed both directions), all five committed migrations plus the Timescale registration, **all 8 phases of the CI Runtime Execution Harness against live Postgres + Redis** (concurrency/no-duplicates, SIGKILL restart idempotency, replay determinism, order lifecycle + reconciliation, journal durability + tamper-evident recovery, risk gate + kill-switch persistence, pagination, SSE resume), **three end-to-end pipeline runs sealed with `Replay(signal) == original` MATCH** through the real Python feature authority, production startup validation in both fail-closed directions and the pass direction, and a **live double-boot of the real worker** proving portfolio-ledger persistence, journal replay, and peak-equity recovery across a restart.

Two classes of open items prevent an unconditional acceptance: (a) the four **external** dependencies that cannot be closed in code (venue credentials, funded account, host secrets, second operator identity), and (b) three **process-level** findings surfaced by this gate itself — the composed CI harness has mutually incompatible phase preconditions on a fresh database (its off-machine GitHub job cannot currently go green as written), ESLint coverage is web-only, and the entire production completion remains uncommitted on a working branch.

**Decision: ACCEPTED WITH CONDITIONS** (§16).

---

## 2. Architecture Acceptance

| Item | Status | Evidence (this session) |
|---|---|---|
| Deterministic execution | **VERIFIED** | Harness Phase 4 PASS (pure engine, persistence, replay deterministic for identical inputs); determinism suites inside the 853 green tests (execution-core 64, execution-adapter 109 incl. byte-identical serialization, trading-plan 44, signal engine); 3× e2e replay MATCH with quantized confidence |
| Replay determinism | **VERIFIED** | 3× `e2e:pipeline` SEALED: BTC-USDT H1 (`replayResult:"MATCH"`), ETH-USDT H1 (MATCH), BTC-USDT H4 (MATCH) — every artifact reloaded FROM the database, featureHash never recomputed in TS, datasetHash compared opaquely |
| Fail-closed behavior | **VERIFIED** | Exercised at every layer this session: prod compose refuses without `POSTGRES_PASSWORD`; `start:prod` exits 1 on DEMO_MODE leak and on misconfigured real broker; `buildBroker`/`buildMarketDataProvider`/`buildExecution` refuse forward on any missing prerequisite (source-verified [index.ts:172-251,390-498](../services/workers/src/index.ts)); orchestrator skips tick without lineage; recovery halts on tamper; control `canTrade()` blocks on null/unknown/stale |
| Event sourcing integrity | **VERIFIED** | Harness Phase 7 PASS (append-only journal, restart rebuild, fail-closed recovery, continuity); durability tests prove halts on tampered position/account snapshots (integrity), divergent results (reconcile), and non-contiguous seq; journal-THEN-commit at the single commit point |
| Zero hidden mutable state | **VERIFIED** | Market/portfolio state is fold-reconstructed from journals (Phase 7 replay: 2 records → identical state); adapter state threaded through `AdapterSession` (stateless const singletons, 109 tests); risk halt is a journal projection; kill switch is DB-backed; live restart run 2 rebuilt state from disk alone |

## 3. Runtime Acceptance

| Item | Status | Evidence |
|---|---|---|
| Zero demo participation in production | **VERIFIED** | Source: DEMO venue excluded from mark queries unless `DEMO_MODE` ([db-quote-transport.ts](../services/workers/src/market/db-quote-transport.ts)); `exchange != DEMO` filter on production signal ticks ([orchestrator.ts:170](../services/workers/src/pipeline/orchestrator.ts#L170)); dashboard/market-price exclude DEMO rows; fixtures imported ONLY by tests (verified by import sweep); prod compose sets no DEMO_MODE anywhere |
| DEMO_MODE correctly isolated | **VERIFIED** | `start:prod` with `DEMO_MODE=true` → `✗ STARTUP FAILED — required component(s) down: demo-mode` (exit 1, re-run this session); demo ingest CLI refuses without the flag; demo governance actors refused; `envFlag` strict allow-list |
| Real runtime lineage | **VERIFIED** | Orchestrator resolves persisted lineage only (no fabrication), skips fail-closed when absent; `verifySignalLineage` runs BEFORE persistence and rejects invalid lineage (source + harness P1/P2 `lineageRejected: 0` assertions) |
| Real broker gating | **VERIFIED** | `MARKET_BROKER=real` arms only when DEMO off ∧ realtime marks ∧ journal path ∧ valid credentials — each refusal logged CRITICAL with the exact missing key (source-verified); `start:prod` surfaces the same misconfiguration at startup (re-run: fails naming `DERIBIT_CLIENT_ID, DERIBIT_CLIENT_SECRET, MARKET_DATA_SOURCE=realtime, MARKET_JOURNAL_PATH`) |
| Market data freshness | **VERIFIED** | `DbQuoteTransport` age-checks every candidate row against a 60 s bound; stale → null → no order (source + dedicated staleness tests in workers suite) |
| Strategy lineage integrity | **VERIFIED** | Newest-ACTIVE StrategyVersion resolution with stable ordering; governance is the only production activation path (single-ACTIVE enforced in-transaction); 21 governance tests green |
| Feature lineage integrity | **VERIFIED** | featureHash is Python-sole-authority, carried VERBATIM (e2e runs show real quant-computed hashes, DQ scores 98–100, replay MATCH without recomputation) |

## 4. Execution Acceptance

| Item | Status | Evidence |
|---|---|---|
| Order lifecycle correctness | **VERIFIED** | Harness Phase 6 PASS (order lifecycle, position/account reconstruction, fail-closed reconciliation; 2 orders / 2 fills / 2 symbols, exact account arithmetic); execution-adapter 109 tests (SUBMIT→ACK→FILL→OPEN→CLOSE, gap-free event seq) |
| Replay correctness | **VERIFIED** | Harness Phase 4 PASS + 3× e2e replay MATCH from DB-reloaded artifacts |
| Journal integrity | **VERIFIED** | Phase 7 PASS; fail-closed on non-contiguous seq, mid-file corruption, tampered snapshots (integrity) and divergent folds (reconcile); torn trailing line tolerated |
| Recovery after restart | **VERIFIED** | Live this session: worker run 2 reconstructed state from the run-1 journal (`records:2, fills:2`), risk journal replayed 18 records, ledger resumed the SAME portfolio row; harness Phase 2 (SIGKILL) and Phase 7 (restart rebuild) PASS |
| Duplicate prevention | **VERIFIED** | Phase 1 PASS: 120 concurrent generations across 60 ticks (concurrency 16) collapsed to exactly 2 rows — no duplicates |
| Idempotency | **VERIFIED** | Phase 2 PASS: SIGKILL + restart re-processed the same snapshots, identical row IDs before/after, zero duplicates; ledger upserts on (portfolioId, ts); tick upserts idempotent under reconnect (ingestion suite) |

## 5. Portfolio Acceptance

| Item | Status | Evidence |
|---|---|---|
| PortfolioSnapshot correctness | **VERIFIED** | Live: 9 snapshots persisted (one per tick) for portfolio `acceptance-11a`, equity 1,000,000.00, drawdown 0.0000, derived VERBATIM from sealed `valuateAccount` (source: [portfolio-ledger.ts](../services/workers/src/market/portfolio-ledger.ts) — nothing recomputed) + 9 ledger unit tests |
| Equity recovery | **VERIFIED** | Restart resumed the same Portfolio row (`created:false`, identical `portfolioId`), `peakEquity` recovered from the persisted series |
| Drawdown recovery | **VERIFIED** | Drawdown measured against the RECOVERED running peak (max of persisted series and initial value), continuous across restarts; quantized to DB Decimal(8,4), clamped [0,1] |
| Valuation consistency | **VERIFIED** | Harness P6/P7 account arithmetic exact across reconstruction; recovery reconcile gate (broker ↔ portfolio) fail-closed |
| Persistence correctness | **VERIFIED** | Idempotent upsert on (portfolioId, ts); ledger init failure → execution UNARMED (fail-closed, source-verified); per-tick write failure logs CRITICAL without aborting the pipeline |

## 6. Frontend Acceptance

| Item | Status | Evidence |
|---|---|---|
| Every page backed by production data | **VERIFIED** | 180 web tests green (render + API + provenance); harness Phases 5/3 exercised the real production web server (`next start`) over live DB reads; fixture modules are imported ONLY by tests (import sweep this session); prior live seal: all 7 terminal APIs HTTP 200 with 0 fabricated values |
| Honest empty states | **VERIFIED** | Explicit production empty-state component ([module-page.tsx](../apps/web/src/components/module-page.tsx)); dashboard portfolio card was truthfully `null` before the ledger existed and real after — no invention |
| Honest degraded states | **VERIFIED** | Signal feed carries a connecting/live/polling/error state machine with a stale banner on stream errors (SSE falls back to polling, never fabricates); system health surfaces per-component status |
| Honest loading states | **PARTIALLY VERIFIED** | Loading/degraded handling verified in source and render tests; no live browser DOM session was run in this gate (same limitation the 10C-1 seal documented) |
| No fabricated metrics | **VERIFIED** | Provenance discipline (REAL/DERIVED/ESTIMATED/UNAVAILABLE, null ↔ UNAVAILABLE) enforced by the trading-plan/decision suites (81 tests); prior provenance audit: 0 NaN / 0 fabricated / 0 fail-open |
| No hidden fallbacks | **VERIFIED** | Source sweep: no `Math.random`/mock/placeholder data paths in runtime web code; DEMO rows excluded or explicitly labeled; kill-switch read defaults fail-closed |

## 7. Infrastructure Acceptance

| Item | Status | Evidence |
|---|---|---|
| Docker production stack | **PARTIALLY VERIFIED** | `docker-compose.prod.yml config` valid with secrets; refuses interpolation without `POSTGRES_PASSWORD` (both directions re-run); zero-demo topology, armed gates, journal volume, loopback-only DB, internal-only Redis/quant confirmed by inspection. The full prod topology was NOT booted end-to-end in this session (requires host secrets); the same images/topology were exercised piecewise (quant image built + healthy; node services run against containerized DB/Redis) |
| Migrations | **VERIFIED** | All 5 committed migrations applied cleanly to a fresh TimescaleDB + `timescale.sql` registration applied (this session) |
| Startup ordering | **VERIFIED** | Compose: every daemon gated on `postgres: service_healthy` + `migrate: service_completed_successfully` (+ redis/quant health); one-shot migrate blocks the stack on failure — validated config-level |
| Health checks | **VERIFIED** | pg_isready / redis PING / quant HTTP health defined; quant healthcheck exercised live (`--wait` gated on it); `/api/v1/system/health` + `/api/v1/ops/health` read real component state |
| Restart recovery | **VERIFIED** | `restart: unless-stopped` on every daemon; live worker double-boot proved journal + ledger + risk recovery (§4/§5) |
| Configuration validation | **VERIFIED** | `start:prod` re-run in 3 directions: DEMO leak → exit 1; real-broker misconfig → exit 1 naming exact keys; clean paper/realtime config → exit 0 (degraded only for the not-running web — honest) |
| Secret validation | **VERIFIED** | Compose `:?` on `POSTGRES_PASSWORD`/`OPS_CONTROL_TOKEN`/`NEXTAUTH_SECRET`; operator API without configured token → 503 fail-closed |

## 8. Security Acceptance

| Item | Status | Evidence |
|---|---|---|
| Operator authentication | **VERIFIED** | `requireOperatorAuth`: SHA-256 + `timingSafeEqual` comparison; unset token → 503 (fail-closed), bad token → 401 + WWW-Authenticate; applied to every mutating control/governance/ops route (grep-verified route coverage) |
| Governance workflow | **VERIFIED** | Register → DRAFT + PENDING approval (never activates) → review → ACTIVE with single-ACTIVE-per-strategy, immutable decisions, full audit rows in one transaction; 21 tests green; prior live HTTP E2E incl. all negatives |
| Four-eyes approval | **VERIFIED** | Requester cannot review own deployment ([governance-actions.ts:301-304](../apps/web/src/lib/governance-actions.ts#L301)); re-review refused (immutable) |
| Fail-closed control plane | **VERIFIED** | `canTrade()` blocks on null/unknown/stale/blocked (43 control tests); control gate composes AHEAD of the risk gate; harness P8 proved the gate routes every order and blocks fail-closed |
| Demo isolation | **VERIFIED** | `system:demo` / `demo*` actors refused on the production governance path; §3 runtime isolation |
| Security headers | **VERIFIED** | `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, HSTS w/ includeSubDomains on every response ([next.config.ts](../apps/web/next.config.ts)) |

## 9. Operational Acceptance

| Item | Status | Evidence |
|---|---|---|
| Paper trading readiness | **VERIFIED** | This session ran the full paper loop live twice on real infra (signals → risk gate → paper fills → persisted portfolio series); prod compose default is exactly this configuration |
| Live trading readiness | **PARTIALLY VERIFIED** | Code path complete and fail-closed-verified in both directions (27 transport tests; boot refusal re-run; venue metadata previously validated against the real Deribit API). The first credentialed order on the TEST venue remains blocked on external credentials — no live private-API call has ever executed |
| Recovery procedures | **VERIFIED** | Operator runbooks per failure class in `@nexus/control`; recovery mechanics exercised live (journal replay, peak recovery, risk replay); protection auto-recovers only after concrete verification |
| Kill switch | **VERIFIED** | Harness P8: kill switch persists + recovers across restart; DB-backed, always audited, never auto-cleared; operator-token-gated `/api/v1/control/kill` + `/resume` |
| Monitoring | **VERIFIED** | `/api/v1/system/health`, `/api/v1/ops/{health,metrics,alerts,pipeline,data-flow}` read live component state; `start:prod` emits a machine-readable summary |
| Observability | **VERIFIED** | Structured JSON logs with component/category/severity on every refusal (observed throughout this session); append-only audit trail; incident timeline on `/control` |

## 10. Verification Matrix

| # | Validation | Result | Detail |
|---|---|---|---|
| V1 | TypeScript (whole repo) | ✅ PASS | 13/13 projects, exit 0 |
| V2 | ESLint | ✅ PASS | `turbo run lint` green — **coverage is @nexus/web only** (sole package with a lint script) |
| V3 | Full test suite | ✅ PASS | **853/853**: workers 230 · web 180 · execution-adapter 109 · ingestion 74 · portfolio-intelligence 72 · execution-core 64 · trading-plan 44 · control 43 · trading-decision 37 |
| V4 | Production build | ✅ PASS | `pnpm -r build` exit 0 (incl. Next.js production build) |
| V5 | Prod compose config | ✅ PASS | Fail-closed without secrets; valid with secrets |
| V6 | Migrations + Timescale | ✅ PASS | 5 migrations + timescale.sql onto fresh TimescaleDB |
| V7 | Runtime harness P1 (concurrency/no-dup) | ✅ PASS | 120 generations → 2 rows |
| V8 | Runtime harness P2 (SIGKILL restart) | ✅ PASS | identical IDs pre/post crash |
| V9 | Runtime harness P4 (replay determinism) | ✅ PASS | |
| V10 | Runtime harness P6 (order lifecycle) | ✅ PASS | reconciliation fail-closed |
| V11 | Runtime harness P7 (durability/recovery) | ✅ PASS | journal rebuild + tamper halts |
| V12 | Runtime harness P8 (risk + kill switch) | ✅ PASS | gate routes all, kill persists + recovers |
| V13 | Runtime harness P5 (pagination) | ✅ PASS | cursor == single-query == offset, 27 rows / 3 pages |
| V14 | Runtime harness P3 (SSE resume) | ✅ PASS | run standalone (see F1): backlog 7, Last-Event-ID resume no-dup/no-gap |
| V15 | Replay validation (e2e, real quant) | ✅ PASS | 3/3 SEALED, `replayResult: MATCH`, DQ 98–100 |
| V16 | Runtime validation (`start:prod`) | ✅ PASS | fail/fail/pass in the 3 directions |
| V17 | Recovery validation (live double-boot) | ✅ PASS | journal 2 records + risk 18 records replayed; same portfolio row |
| V18 | Broker validation | ⚠️ PARTIAL | fail-closed boot + config gate re-verified; 27 unit tests; **no credentialed venue call possible** |
| V19 | Portfolio validation (live) | ✅ PASS | 9 snapshots persisted; peak-equity recovery exact |

## 11. VERIFIED Items

Architecture: deterministic execution, replay determinism, fail-closed behavior, event sourcing integrity, zero hidden mutable state.
Runtime: zero demo participation, DEMO_MODE isolation, real runtime lineage, real broker gating, market-data freshness, strategy lineage, feature lineage.
Execution: order lifecycle, replay correctness, journal integrity, restart recovery, duplicate prevention, idempotency.
Portfolio: snapshot correctness, equity recovery, drawdown recovery, valuation consistency, persistence correctness.
Frontend: production-data backing, honest empty states, honest degraded states, no fabricated metrics, no hidden fallbacks.
Infrastructure: migrations, startup ordering, health checks, restart recovery, configuration validation, secret validation.
Security: operator authentication, governance workflow, four-eyes, fail-closed control plane, demo isolation, security headers.
Operational: paper trading readiness, recovery procedures, kill switch, monitoring, observability.

## 12. PARTIALLY VERIFIED Items

1. **Live trading readiness / broker validation** — every gate, mapping, and failure path is code-verified and fail-closed in both directions, but no order has ever been placed through the private Deribit API (blocked on external credentials; first rehearsal must run on `DERIBIT_ENV=test`).
2. **Docker production stack** — compose config validated fail-closed and the components were exercised piecewise (quant image built + healthchecked live; node services against containerized DB/Redis), but the full `docker-compose.prod.yml` topology was not booted end-to-end (requires operator-provisioned host secrets).
3. **Honest loading states (browser DOM)** — verified in source and render tests; no live headless-browser session was run (consistent with how prior seals classified it: INFERRED).

## 13. NOT VERIFIED Items

None. Every checklist item reached at least PARTIALLY VERIFIED.

*(Findings that are defects of the validation infrastructure rather than checklist items are recorded here for the record:)*

- **F1 — Composed CI harness cannot pass on a fresh database.** Phase 1 asserts exactly 2 snapshots considered; Phase 3 (SSE) requires ≥ 3 signals; Phase 5 deletes its own fixtures. On a clean DB the composed `ci:harness` therefore fails Phase 3 (observed), and after any extra signal history exists it fails Phase 1 (observed: "considered 4"). Every phase individually PASSED this session (P3 standalone). The untracked GitHub workflow `ci-runtime-harness.yml` would also fail as written — additionally because it does not export `DEMO_MODE=true` for the in-process phases (observed failure mode: "considered 0"). **Validation-infra defect only; no production code is implicated.**
- **F2 — ESLint coverage is web-only.** Only `@nexus/web` defines a lint script; `turbo run lint` green therefore covers 1 of 13 packages.
- **F3 — Windows host port hazards (operational note).** WinNAT dynamic exclusions cover port 3000 on this host (web bind EACCES; harness run on 3200). The 5432 administered exclusion (documented fix) is in place.

## 14. Remaining External Dependencies

Unchanged from the Final Production Completion Report — none is closable in code:

1. **Deribit API credentials** (`trade` scope) — test venue rehearsal first, then live.
2. **Funded venue account + capital allocation decision** (USDC margin for the default linear instruments; explicit `DERIBIT_ENV=live` flip).
3. **Production host + secrets** — `POSTGRES_PASSWORD`, `OPS_CONTROL_TOKEN`, `NEXTAUTH_SECRET`, `QUANT_SERVICE_SHARED_SECRET` (+ WinNAT exclusions if Windows).
4. **Second operator identity** — four-eyes requires a reviewer distinct from the requester.
5. *(Carried scope decision)* single live feature family (`core-technical@v1` H1); sub-minute market feed absent, so directional risk LEVELS on the live UI remain honestly UNAVAILABLE.

## 15. Production Readiness Score

**93 / 100.**
Deductions: −3 live venue path never exercised with credentials (external); −2 composed CI harness / off-machine gate not green as written (F1); −1 full prod compose topology not booted end-to-end; −1 lint coverage web-only (F2).

## 16. Acceptance Decision

# ACCEPTED WITH CONDITIONS

Every architectural objective of the platform — determinism, replay safety, fail-closed behavior everywhere, event-sourced integrity, zero-demo production runtime, governed strategy lineage, durable recoverable execution, persistent portfolio truth, honest observability, and operator-controlled security — is implemented and was verified by re-run in this session. **Phase 11A is formally declared complete**, subject to the following conditions:

**Conditions (must be tracked; none blocks the declaration):**

1. **External prerequisites before live capital** (§14 items 1–4): test-venue credentialed rehearsal, funding + explicit live flip, host secrets, second operator. Until then the platform is production-ready for **paper trading on real market data** — which is fully verified.
2. **Repair the validation harness composition (F1)** so the off-machine CI gate can seal green: reconcile Phase 1/Phase 3 preconditions and export `DEMO_MODE=true` in the workflow's harness step. No production code change is required.
3. **Commit the branch.** The entire production completion (853 tests' worth of code) exists only in the uncommitted working tree — a single workspace accident can destroy the platform. Committing is the repo's human-triggered convention; this gate flags it as the highest-leverage operational risk.
4. Optional hardening carried as accepted debt: extend lint coverage beyond web (F2); boot the full prod compose once on the target host as part of deployment (§12.2).

Phase 11B is **not** begun. No roadmap items were implemented.

---
*Produced by the Phase 11A independent acceptance gate, 2026-07-04. All ephemeral infrastructure torn down after validation (`docker compose -f docker/docker-compose.ci.yml down -v`).*
