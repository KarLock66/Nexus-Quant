# Final Production Completion Report

**Date:** 2026-07-04 · **Branch:** `remediation/step8-featurehash-reproducibility` (UNCOMMITTED)
**Objective:** Eliminate the four remaining production blockers (Runtime Readiness Report §5) — real broker, persistent portfolio, strategy governance, production deployment runtime — preserving determinism, replay safety, fail-closed behavior, and zero-demo discipline.

---

## 1. Blocker dispositions

### §5.1 Real broker (Deribit private API) — **ELIMINATED (code); live placement gated on credentials**

`services/workers/src/market/deribit-order-transport.ts` — `DeribitOrderTransport implements RealtimeOrderTransport`, plugging into the SEALED `createRealBroker(transport)` seam (broker.ts unchanged).

- **Venue mapping (honest, validated live):** canonical perps route to Deribit **LINEAR USDC perpetuals** (`BTC_USDC-PERPETUAL` / `ETH_USDC-PERPETUAL`), where the venue `amount` is denominated in the BASE coin — the exact unit of `Order.qty`. Confirmed against the real venue API: contract_size 0.0001 BTC / 0.001 ETH, settlement==quote==USDC. **Inverse contracts are REFUSED** at instrument validation (settlement≠quote; their USD amount unit could over-deliver base units past the ordered qty — which the sealed reducer treats as a hard failure). Override map via `DERIBIT_INSTRUMENT_MAP`.
- **Order semantics:** market + `immediate_or_cancel` (no resting order can survive); amount rounded **DOWN** to the venue lot step (never above the risk-approved qty); sub-minimum refused pre-network; deterministic venue label `nx-<orderId>` on every order.
- **Stream mapping:** venue ack/trades map VERBATIM onto the canonical `OrderEvent` stream — the same shape paper/simulated emit — so the sealed `reduceOrder` stays the single fail-closed validator (no separate trust path for "real"). Shortfall terminates with an honest `ORDER_CANCELLED` (never a fabricated FILLED); venue overfill throws (manual reconciliation); rejects map to `ORDER_REJECTED`; an unexpected `open` is cancelled at the venue.
- **Ambiguous-failure recovery:** a timeout/network fault after send re-queries `get_order_state_by_label` + `get_user_trades_by_order` and maps the TRUE venue outcome; only if recovery also fails does it throw, with a CRITICAL manual-reconciliation log.
- **Auth:** OAuth2 client credentials, cached token with early refresh, one re-auth retry on 13009. `DERIBIT_ENV` defaults to the **test** venue; live capital requires the explicit `live`.
- **Boot wiring (`index.ts` `buildBroker`):** `MARKET_BROKER=real` arms ONLY when DEMO_MODE is off ∧ `MARKET_DATA_SOURCE=realtime` ∧ `MARKET_JOURNAL_PATH` set ∧ credentials valid — otherwise CRITICAL log + execution UNARMED (signals still flow). Verified live: bare `MARKET_BROKER=real` boot logged the refusal naming the missing keys and ticked signals-only.
- **Tests:** 27 (streams satisfy reduceOrder; lot rounding; shortfall/reject/IOC/open/overfill/malformed; auth cache + re-auth; label recovery ×3; env config).

### §5.2 Persistent portfolio & equity ledger — **ELIMINATED**

`services/workers/src/market/portfolio-ledger.ts` — `PortfolioLedger`, opt-in `PORTFOLIO_LEDGER=on`.

- Persists a `PortfolioSnapshot` (equity / grossExposure / drawdown / open positions JSON) **every tick**, derived VERBATIM from the sealed `valuateAccount` output + Position map — nothing recomputed. Idempotent upsert on (portfolioId, ts).
- Find-or-creates the `Portfolio` row by name; recovers **peak equity** from the persisted series on boot, so drawdown is continuous across restarts. If the ledger is requested but cannot init, execution stays UNARMED (fail-closed); a per-tick write failure logs CRITICAL and never aborts the pipeline.
- **Verified live** (real Postgres + live Deribit marks + paper fills): snapshots persisting each tick with equity tracking the real feed; dashboard `/api/v1/dashboard/overview` portfolio card now REAL (`{name: production, equity: 1000295.84, exposure: 341900, drawdown: 0.0001}` — previously permanently null). **Restart proven:** kill → relaunch replayed 78 journal records, ledger resumed the SAME portfolio row with `peakEquity: 1000372.75` = the exact pre-restart max, series continued.
- **Tests:** 9 (identity, peak recovery, verbatim persistence, drawdown math, upsert shape, fail-closed propagation, env gating).

### §5.3 Strategy governance — **ELIMINATED**

`apps/web/src/lib/governance-actions.ts` + 3 operator-token-gated routes (register `POST /api/v1/governance/strategies`, review `POST /api/v1/governance/approvals/[id]`, retire `POST /api/v1/governance/versions/[id]/retire`).

- Register: fail-closed validation of EVERY mandatory governance field → Strategy find-or-create + immutable DRAFT StrategyVersion + PENDING `DEPLOY_APPROVAL` + audit rows, all in one transaction. **Never activates.**
- Review: **four-eyes** (requester cannot review own deployment), immutable decisions, approve → DRAFT→ACTIVE with **single-ACTIVE-per-strategy** (other ACTIVE versions PAUSED in the same transaction, each audited) — exactly what the workers' `resolvePersistedLineage` consumes. Reject leaves DRAFT.
- Demo actors (`system:demo` / `demo*`) refused on the production path. All mutations behind `requireOperatorAuth` (403-less fail-closed: 503 unconfigured / 401 bad token).
- **Verified live** through the real web API: 401 without/with-bad token → register 201 (DRAFT+PENDING) → same-actor approve 409 four-eyes → second-actor approve 200 ACTIVE → re-review 409 immutable → v2 approve PAUSED v1 (single active) → retire 200 → DB shows the full 9-row audit trail.
- **Tests:** 21.

### §5.4 (+§5.5) Production deployment runtime — **ELIMINATED**

`docker/docker-compose.prod.yml` — full production topology, zero DEMO_MODE anywhere:

- postgres (loopback-only publish) · redis (internal-only) · quant (internal, healthchecked) · one-shot **migrate** (prisma migrate deploy + timescale.sql, gates every daemon via `service_completed_successfully`) · ingestion (`INGEST_EXCHANGE=DERIBIT`) · workers (**`MARKET_DATA_SOURCE=realtime`, `RISK_ENGINE=on`, `CONTROL_PLANE=on`, `PORTFOLIO_LEDGER=on`, journals on a named volume**, Deribit creds pass-through, broker defaults to paper — `real` requires explicit env) · web (requires `OPS_CONTROL_TOKEN` + `NEXTAUTH_SECRET` at compose level). `restart: unless-stopped` on every daemon; `POSTGRES_PASSWORD` required (`:?` fail-closed). Compose config validated.
- `scripts/start.prod.ts` gained a required **broker check**: `MARKET_BROKER=real` with missing creds/realtime/journal → validation CRITICAL + exit 1 (verified: fails naming the missing keys; passes with them configured). Resolves the Redis port doc mismatch (prod compose is internal-network only).
- `.env.example` documents the full production block (Deribit venue, ledger, compose secrets).

## 2. Invariants preserved

- **Determinism / replay safety:** the transport is the deliberate effectful edge; everything upstream (order derivation) and downstream (reduceOrder, folds, reconciliation, journaling) is the existing sealed pure machinery. Journals record committed venue outcomes verbatim. The ledger derives; it never computes.
- **Fail-closed:** every new path refuses forward on missing/invalid anything (credentials, instrument, lot minimum, malformed payload, ledger init, governance fields, auth) — execution unarmed / request refused, signals always flowing.
- **No demo in production, no mocks, no placeholders:** demo actors refused in governance; prod compose carries no DEMO_MODE; the transport talks to the real venue protocol (fakes exist only in unit tests); nothing returns invented values.
- **Sealed code untouched:** broker.ts / stage.ts / order.ts / risk / control unchanged; wiring is additive in `index.ts` behind opt-in env. All 796 pre-existing tests byte-for-byte green.

## 3. Verification summary

| Check | Result |
|---|---|
| Whole-repo `pnpm -r typecheck` / `build` | ✅ / ✅ |
| Test suites | **853 green** (workers 230 = 194 sealed + 36 new; web 180 = 159 + 21 new; control 43, trading-decision 37, trading-plan 44, ingestion 74, portfolio-intelligence 72, execution-core 64, execution-adapter 109) |
| `docker compose -f docker-compose.prod.yml config` | ✅ |
| Governance E2E (live web + DB) | ✅ full path incl. negatives |
| Ledger E2E (live marks, fills, dashboard) | ✅ |
| Restart recovery (journal + peak equity) | ✅ 78 records replayed, peak exact |
| Real-broker fail-closed boot + start:prod gate | ✅ both directions |
| Venue metadata assumptions vs real Deribit API | ✅ (test + live endpoints) |

## 4. Remaining external dependencies (cannot be implemented in code)

1. **Deribit API credentials** — a client-credentials API key (`trade` scope) for `test.deribit.com` (rehearsal) and, when authorized, `www.deribit.com` (live capital). Everything up to the private call is verified; the first credentialed run on the TEST venue is the remaining rehearsal step (`MARKET_BROKER=real`, `DERIBIT_ENV=test`).
2. **Funded venue account + capital allocation decision** — account funding, margin currency (USDC for the default linear instruments), and the operator's decision to flip `DERIBIT_ENV=live`.
3. **Production host + secrets** — a deployment host for `docker-compose.prod.yml` with operator-provisioned `POSTGRES_PASSWORD`, `OPS_CONTROL_TOKEN`, `NEXTAUTH_SECRET`, `QUANT_SERVICE_SHARED_SECRET` (and the WinNAT 5432 exclusion if the host is Windows).
4. **Second operator identity** — four-eyes review requires a reviewer distinct from the requester; that is an organizational prerequisite, not code.
5. **(Carried forward, unchanged)** sub-hourly feature coverage remains a single set (`core-technical@v1` H1); options/flow/regime feature families have no live computation path yet — a scope decision, not a blocker for the trading loop.

**Conclusion:** every production blocker in code is eliminated and verified end-to-end on live market data with restart-proven persistence. The platform is production-complete pending credentials, capital, and host secrets.
