# Phase 11C — Stage 3 Final Audit: Remaining Production Trust Boundaries

Status: READ-ONLY AUDIT COMPLETE — no source modified, no patches, nothing committed
> **Historical record.** Phase 11C is COMPLETE and RATIFIED (2026-07-14, committed as `713d9bf`) — see [PHASE11C_FINAL_ACCEPTANCE.md](PHASE11C_FINAL_ACCEPTANCE.md). Future hardening: [PHASE12_CHARTER.md](PHASE12_CHARTER.md).
Date: 2026-07-13
Baseline: Batch 1 (GAP A, distributed decision-bus admission) + Batch 2 (GAP B,
control-plane store admission), both accepted, both present uncommitted in the
working tree on top of `a2182f9`.
Method: hunk-by-hunk review of the full uncommitted diff (10 modified + 4 new
files), direct source verification of every ingress candidate, and fresh
whole-repo sweeps re-run today: `JSON.parse`, `as <Type>` casts in non-test
worker sources, `process.env`, Prisma read sites (`find*/aggregate/count`),
`readFile*/createReadStream`, and packages-wide ingress patterns
(`JSON.parse|process.env|fetch(|as unknown as`). Full workers test suite
re-executed during this audit: **20 files, 347/347 PASS** (2026-07-13 07:43).

---

## 1. Executive summary

**Verdict: one known, low-severity boundary remains — GAP C, exactly as scoped
in the Stage 3 plan — plus one newly identified guard of the same class
(portfolio-ledger peak-equity read) recommended as a GAP C fold-in. No other
unknown → trusted transition survives in the production runtime.**

- GAP A (Redis pub/sub + BullMQ decision ingress) is **sealed and verified in
  the working tree**: `admitDecisionEvent` is baked into both decision-bus
  factories via spread-then-override, so no production caller can bypass or
  remove it; pub/sub rejects route to `onReject` (log + drop, skip-not-halt —
  the latent ioredis-listener crash is gone); BullMQ admission runs before the
  handler loop and `BusAdmissionError` is translated to `UnrecoverableError`
  (poison job → failed set once, queue keeps draining).
- GAP B (control-plane store reads) is **sealed and verified in the working
  tree**: all four blind casts in `control/store.ts` are replaced by
  reject-only validators built from the canonical `@nexus/control` tuples;
  all evaluator call sites handle `ControlDataError` conservatively (recovery
  stays PROTECTED, resolution leaves the incident OPEN, protection is never
  blocked, boot fallback is logged) and rethrow every non-admission error.
- **Batch 1 and Batch 2 introduced zero business-logic drift** (Section 5):
  the diff is admission plumbing + conservative rejection handling only; both
  admitters are reject-only (same-reference return, proven by tests); the
  sealed Stage 1/2 validators are byte-identical; 347/347 tests pass; PHASE G
  golden snapshots were 10/10 byte-identical in both batch validations.
- Remaining work: **GAP C** — the tick/candle branches of
  `db-quote-transport.ts` still pass unguarded `Number(Decimal)` into
  `quantizePrice` (confirmed live at lines 117 and 124), while the sibling
  orderbook branch guards finite-positive. **New finding of the same class:**
  `portfolio-ledger.ts:84` reads `Number(peak._max.equity)` from a DB
  aggregate unguarded — opt-in ledger tier, no trading impact (risk drawdown
  is journal-sourced and finite-guarded), one-line guard, recommended for the
  same rider.
- Everything else is already sealed, intentionally safe, or explicitly parked
  on the Future Hardening list (ingestion REST casts, web governance-body
  brittleness, web display-tier Json reads) — none of it crosses an
  unvalidated process boundary into a fail-closed production path.

**Recommendation: GAP C only (with the one-line portfolio-ledger fold-in),
then Stage 3 complete.** No additional batch is required.

---

## 2. Complete ingress inventory

Every path by which bytes produced outside the running worker process (or
outside its typed in-process object graph) enter the runtime. Classification
legend: **SEALED** (Batch 1/2 or an earlier stage) · **SAFE** (intentionally
safe by construction) · **GAP C** (remaining Stage 3 work) · **OOS**
(out of scope for Phase 11C, tracked on Future Hardening).

### 2.1 Worker runtime (services/workers) — the Stage 3 surface

| # | Ingress | Boundary | Classification |
|---|---|---|---|
| W1 | Redis pub/sub decision channel | `bus/redis-bus.ts:120` `JSON.parse` → `admit` → handlers; rejects → `onReject` (log+drop) | **SEALED — Batch 1** |
| W2 | BullMQ durable decision job | `bus/bullmq-bus.ts` `admit` before handler loop; `index.ts:338-350` `BusAdmissionError` → `UnrecoverableError` | **SEALED — Batch 1** |
| W3 | Redis/BullMQ execution & market bridges | generic factories, admission-optional | **SAFE** — not instantiated in production (`index.ts` builds only the decision bus; sole other consumer is `bus/bus.test.ts`); plumbing accepts an `admit` codec the day they go distributed |
| W4 | `RuntimeStateTransition.state/previousState` (String cols) | `control/store.ts:62-64, 77-84` `assertValidRuntimeState` | **SEALED — Batch 2** |
| W5 | `RuntimeStateTransition.affectedComponents` + `Incident.affectedComponents` (Json cols) | `control/store.ts:88-92, 192-196` `admitControlComponents` (no silent filtering; null → `[]` preserved) | **SEALED — Batch 2** |
| W6 | `ControlKillSwitch` row | `control/store.ts:23-32` | **SAFE** — consumed columns are schema-typed (`engaged` Boolean, `actor/reason` String?, `engagedAt` DateTime?); no Json, no domain-enum cast, no coercion |
| W7 | `ProtectionEvent` rows | `control/store.ts:134-137` (id only), `:167-183` (returned as plain strings) | **SAFE** — `getActiveProtectionEvents` performs no domain cast and has **no worker consumer** (grep: sole hit is its own definition; web reads the table via its own tier) |
| W8 | `Incident.startedAt` | `control/store.ts:220` (DateTime col, duration calc) | **SAFE** — schema-typed, single field |
| W9 | Audit-log write→read-back | `control/recovery.ts:45` (selects `id` of a row it just wrote) | **SAFE** — round-trip liveness probe, no payload trusted |
| W10 | `StrategyVersion` governance row | `pipeline/orchestrator.ts:160` `assertValidStrategyVersionRow` before the Json cast | **SEALED — Stage 1** (f468b9b) |
| W11 | `FeatureSnapshot` + `dqReport` rows | `pipeline/orchestrator.ts` `assertValidSnapshotRow` | **SEALED — Stage 1** |
| W12 | `FeatureSetDefinition` row | `pipeline/orchestrator.ts:133-135` | **SAFE** — `select: { id: true }` only; the id is used as an FK filter, never as domain data |
| W13 | Market JSONL journal | `market/event-store.ts:271-297` `assertValidMarketJournalRecord` → `JournalCorruptionError` → UNARMED | **SEALED — Stage 2** (a2182f9) |
| W14 | Risk JSONL journal | `risk/events.ts:192-219` `assertValidRiskJournalRecord` → `RiskJournalCorruptionError` → HALTED | **SEALED — Stage 2** |
| W15 | DB quote — orderbook branch | `db-quote-transport.ts:103-111` `Number.isFinite && > 0` | **SAFE** (guarded) |
| W16 | **DB quote — tick & candle branches** | `db-quote-transport.ts:117, 124` — unguarded `Number(...)` → `quantizePrice` | **GAP C** — confirmed still open (Section 4.1) |
| W17 | **Portfolio-ledger peak equity** | `portfolio-ledger.ts:84` — unguarded `Number(peak._max.equity)` from a Prisma aggregate | **GAP C fold-in candidate (new)** — same class as W16 (Section 4.2) |
| W18 | EngineSignal P2002 race read-back | `signal/persistence.ts:72-93` | **SAFE** — reads back the row the identical deterministic writer just created (idempotency resolution); schema-typed columns; used for id/log/publish payload, not trading input |
| W19 | Quant feature HTTP response | `features/client.ts:51-98` object-level guards → `FeatureComputeError`; DQ floor + allowlists in `consumer.ts` | **SAFE** — per-value numbers deliberately opaque (hash discipline); non-finite values throw `StrategyInputError` at point of use (`replay/strategy.ts:63`) — the Stage 1-ratified design |
| W20 | Deribit order REST/RPC responses | `deribit-order-transport.ts:206-342` structural + finite-positive guards → `DeribitOrderError` | **SAFE** (sealed pre-Stage-3, fail-closed) |
| W21 | Deribit env config incl. `DERIBIT_INSTRUMENT_MAP` JSON | `deribit-order-transport.ts:569-606` | **SAFE** — parse failure or bad shape lands in `missing[]` → `{ok:false}` → execution UNARMED (fail-closed); verified today |
| W22 | Env: `SIGNAL_TICK_MS`, `BUS_BACKEND`, `MARKET_BROKER`, `CONTROL_PLANE`, `RISK_ENGINE`, `MARKET_DATA_SOURCE`, journal paths, ledger identity | `index.ts:76-80` (finite + ≥1000), `bus/types.ts:44-46` (allowlist, default inprocess), `index.ts:142` (allowlist), exact-match `"on"`/`"realtime"` flags, `portfolio-ledger.ts:133-150` (trimmed strings w/ defaults) | **SAFE** — allowlisted or guarded; unknown values fail toward the conservative default (off/in-process/unarmed) |
| W23 | Fixture JSON loads | `signal/fixtures.ts:28`, `replay/fixtures.ts:26` (`readFileSync` + cast) | **OOS** — imported exclusively by `*.test.ts` (grep-verified); never loaded by the production entrypoint |
| W24 | CI/CLI harness casts | `ci/*.ts`, `cli/e2e-pipeline.ts` | **OOS** — non-production entrypoints, fail loudly in harness (plan §Future Hardening, unchanged) |
| W25 | Order-event reducer casts | `market/order.ts:148, 219` | **SAFE** — not ingress: an in-process state machine folding typed `OrderEvent`s, itself fail-closed (`OrderTransitionError` on any illegal stream) |
| W26 | Reconciliation side cast | `market/reconcile.ts:57` | **SAFE** — not ingress: `PortfolioState` is in-process folded state; the function's whole purpose is fail-closed cross-checking |

### 2.2 Ingestion (services/ingestion) — untouched by Stage 3, re-verified today

| # | Ingress | Boundary | Classification |
|---|---|---|---|
| I1 | Exchange WS frames | `deribit.ts:1161`, `binance.ts:729` — envelope cast, every consumed field finite-guarded before emit (drop/skip on fail) | **SAFE** (effectively protected; verified in the Stage 3 planning audit, files unchanged since — clean git status) |
| I2 | Exchange REST bodies | `binance.ts:288` `res.json() as T`; `deribit.ts:522-550` envelope error/result checks then `result as T` | **OOS — Future Hardening (Medium)** (Section 4.3) |
| I3 | Stage-B DQ HTTP | `dq/stage-b-client.ts:150` per-element structural checks → fail-closed INFRA deduction | **SAFE** |
| I4 | Quant feature HTTP | `features/client.ts:85` — same guarded decode pattern as W19 | **SAFE** |
| I5 | Env | `lib/env.ts` — required vars throw; allowlists; `parsePositiveInt` | **SAFE** |

### 2.3 Web (apps/web) — untouched by Stage 3, load-bearing items re-verified today

| # | Ingress | Boundary | Classification |
|---|---|---|---|
| B1 | All `/api/v1/*` requests | `middleware.ts` + `requireOperatorSession` — signed cookie + registry re-check → 401/403 | **SAFE** (fail-closed; the B1 gate) |
| B2 | Session cookie | `lib/session.ts:100-121` — HMAC `crypto.subtle.verify` runs **before** `JSON.parse`, then per-claim guards, then expiry | **SAFE** (re-verified today: verify-then-parse order confirmed) |
| B3 | Operator registry env | `lib/operator-registry.ts:31-68` — per-entry type/emptiness guards; malformed JSON → empty registry → nothing authenticates | **SAFE** (fail-closed by construction) |
| B4 | Governance POST body | `governance/strategies/route.ts:36` — `readJsonObject` then blind spread cast, **fully re-validated field-by-field** in `registerStrategyVersion` → `GovernanceValidationError` → 400 | **OOS — Future Hardening (Medium)**: currently fail-closed, brittle-by-construction (protection lives in a different module than the cast) |
| B5 | Query params / SSE reconnect cursor | `lib/api-validate.ts`, `signals/stream/route.ts` — regex/bounds → 400 | **SAFE** |
| B6 | DB Json → decision-support projections | `trading-decision.ts:127, 148, 206, 217` — `strategyParams`/`features` Json casts | **OOS — Future Hardening (Low)**: DB-tier source written exclusively by the workers (admitted at write time by Stage 1 + GAP A); display/decision-support tier, not the order path |
| B7 | SSE/fetch client consumers | `signal-feed.tsx`, `use-polled-resource.ts` | **OOS** — same-origin own API, display tier |

### 2.4 Packages (packages/*)

Fresh sweep (`JSON.parse|process.env|fetch(|as unknown as` over `packages/*/src`):
the only hits are the `packages/db` Prisma global-singleton idiom and its
`NODE_ENV` dev-cache check. **No package parses external input, reads
configuration into trading logic, or performs network I/O.** Pure, in-type,
replay-safe — N/A.

---

## 3. Trust-boundary inventory (unknown → trusted transitions)

The complete list of places where the production runtime converts untyped/
external data into a trusted domain type, and the mechanism that makes each
conversion earned rather than assumed:

| Transition | Mechanism | Status |
|---|---|---|
| Redis bytes → `DecisionEvent` | `admitDecisionEvent` (bus/admission.ts) — reject-only, baked into factory | SEALED (B1) |
| BullMQ `job.data` → `DecisionEvent` | same admitter, pre-handler; `UnrecoverableError` translation | SEALED (B1) |
| DB String → `RuntimeState` | `assertValidRuntimeState` (control/validate.ts) — canonical-tuple set | SEALED (B2) |
| DB Json → `ControlComponent[]` | `admitControlComponents` — all-or-nothing, null→`[]` | SEALED (B2) |
| DB Json → strategy `parameters` | `assertValidStrategyVersionRow` before cast | SEALED (Stage 1) |
| DB rows → snapshot/DQ pipeline input | `assertValidSnapshotRow` | SEALED (Stage 1) |
| JSONL line → `MarketJournalRecord` | `assertValidMarketJournalRecord` → UNARMED | SEALED (Stage 2) |
| JSONL line → `RiskJournalRecord` | `assertValidRiskJournalRecord` → HALTED | SEALED (Stage 2) |
| Quant HTTP body → `FeatureComputeResult` | `decode()` structural guards; values opaque-by-design w/ point-of-use guard | SAFE (ratified design) |
| Deribit RPC body → order lifecycle | structural + finite-positive guards → `DeribitOrderError` | SAFE |
| Env strings → runtime config | allowlists / finite guards / fail-toward-off defaults | SAFE |
| Session cookie → operator identity | HMAC verify → parse → claim guards → registry re-check | SAFE (web) |
| **DB Decimal → mark price (tick/candle)** | **none — `Number(...)` straight into `quantizePrice`** | **GAP C** |
| **DB Decimal → ledger peak equity** | **none — `Number(peak._max.equity)`** | **GAP C fold-in (new)** |

In-process transitions (engine signal → bus publish, order-event folding,
portfolio reconciliation) are same-process, same-type object passing with their
own fail-closed invariant checks — they are not unknown → trusted conversions.
The in-process bus deliberately takes no admitter (no serialization boundary);
the engine-signal path additionally re-checks `malformedSignalReason` before
publish (Stage 1 defense-in-depth).

---

## 4. Evidence for every remaining finding

### 4.1 GAP C — DB-quote tick/candle finiteness (LOW, planned)

Working tree today, `services/workers/src/market/db-quote-transport.ts`:

```ts
// :103-111 — orderbook branch (GUARDED)
if (Number.isFinite(mark) && mark > 0) {
  return { symbol, ts: ob.ts.toISOString(), price: quantizePrice(mark) };
}
// :116-118 — tick branch (UNGUARDED)
if (tick !== null && fresh(tick.ts)) {
  return { symbol, ts: tick.ts.toISOString(), price: quantizePrice(Number(tick.price)) };
}
// :123-125 — candle branch (UNGUARDED)
if (candle !== null && fresh(candle.ts)) {
  return { symbol, ts: candle.ts.toISOString(), price: quantizePrice(Number(candle.close)) };
}
```

A corrupt/zero Decimal in `MarketTick.price` or `MarketCandle.close` reaches
`quantizePrice` and becomes the symbol's mark. Non-null Decimal columns written
by the ingestion tier make this improbable — it is the consistency fix the plan
scoped: copy the `:108` guard; tick fails → fall through to candle; candle
fails → `null` (no mark, fail-closed ABSENT). Still a production concern
because the mark feeds live valuation; still LOW because both columns are
non-null and worker/ingestion-written.

### 4.2 NEW — portfolio-ledger peak-equity read (LOW, same class as GAP C)

`services/workers/src/market/portfolio-ledger.ts:80-85`:

```ts
const peak = await this.prisma.portfolioSnapshot.aggregate({
  where: { portfolioId: portfolio.id },
  _max: { equity: true },
});
const recoveredPeak = peak._max.equity !== null ? Number(peak._max.equity) : 0;
this.peakEquity = Math.max(recoveredPeak, this.initialValue);
```

The one DB-to-runtime Decimal read in the worker outside GAP C with no
finiteness guard. Why it was not in the Stage 3 plan's gap list, and why its
severity is LOW:

- **Blast radius is the opt-in ledger only** (`PORTFOLIO_LEDGER=on`,
  default-off). A NaN `recoveredPeak` makes `this.peakEquity` NaN
  (`Math.max(NaN, x)` → NaN); in `record()` the drawdown ternary
  (`this.peakEquity > 0 ? … : 0`) then evaluates **false** on NaN, so the
  persisted drawdown silently reads 0 — a display/ledger corruption, silent
  rather than crashing.
- **No trading impact:** equity/exposure are persisted VERBATIM from the
  in-process market valuation, and the risk engine's drawdown never touches
  `PortfolioSnapshot` — it folds `peakEquity` from the Stage 2-validated risk
  journal, and both `currentDrawdown` (`kill-switch.ts:49-52`) and the
  drawdown trigger (`kill-switch.ts:72`) are explicitly finite-guarded.
- The source column is written only by this same ledger, quantized.

It is, however, exactly the GAP C defect class (unguarded `Number(Decimal)`
from a DB read) and costs one line plus one test. **Recommendation: fold into
the GAP C rider.** If the approver prefers GAP C strictly as planned, this
item goes to Future Hardening (Low) — either disposition leaves no fail-open
path into trading logic.

### 4.3 Deferred items re-confirmed (no status change, all OOS for 11C)

- **Ingestion REST casts** (`binance.ts:288`, `deribit.ts:522-550`): envelope
  error/result checks only, `result as T` unvalidated — re-read today,
  unchanged. Backfill paths; the live WS paths field-guard every value before
  emit. Future Hardening (Medium), deserves its own pass with venue fixtures.
- **Web governance body cast** (`governance/strategies/route.ts:36`): re-read
  today — `readJsonObject` + downstream field-by-field re-validation → 400.
  Fail-closed now, brittle-by-construction. Future Hardening (Medium).
- **Web display-tier Json reads** (`trading-decision.ts`) and same-origin
  SSE/fetch consumers: DB-tier/display-tier, workers-authored source. Low.
- **Harness debt (pre-existing, outside Stage 3):** `ci:harness` HTTP phases
  5/3 need a session bootstrap against the B1 auth gate (flagged Batch 1);
  `seal:phase97` STEP A needs `MARKET_DATA_SOURCE` in its spawn env (flagged
  Batch 2). Neither is a trust boundary; both are validation-harness scope.

---

## 5. Confirmation: Batch 1 + Batch 2 introduced no business-logic drift

Verified four independent ways during this audit:

1. **Hunk-by-hunk diff review (today).** The full uncommitted diff (543
   insertions / 47 deletions across 10 modified files, plus 4 new files) was
   read in its entirety:
   - `pipeline/validate.ts` — purely additive: `CONFIDENCE_RE` visibility
     `const` → `export const` and the new context-free
     `malformedSignalStructureReason`. **No hunk touches
     `malformedSignalReason` or either `assertValid*` function — Stage 1
     remains byte-identical.**
   - `bus/redis-bus.ts` / `bus/bullmq-bus.ts` — admission plumbing only.
     Parse/admit failures route to the new `onReject` (log + drop); `onError`
     retains exclusively handler-failure semantics; the BullMQ handler loop,
     retry semantics for valid jobs, and publish paths are untouched.
   - `index.ts` — `buildDecisionBus` only: `onReject` logging on the redis
     branch; `BusAdmissionError → UnrecoverableError` translation on the
     bullmq branch. Transient handler failures rethrow plainly (at-least-once
     retry unchanged); the in-process default path is untouched and still
     never loads bullmq.
   - `control/store.ts` — the four blind casts replaced by validator calls;
     `if (!row) return "BOOTING"` / `null → []` absence contracts preserved
     verbatim; **every writer function byte-identical**.
   - `control/evaluator.ts` — all new behavior is gated on
     `instanceof ControlDataError`; every other error rethrows exactly as
     before (proven by test: `Error("db down")` still propagates out of
     `evaluate()`). The recovery-verification block is re-indented into the
     readable-incident branch but logically identical: same `targets`
     construction, same `verifyRecovery` fan-out, same `recoveryOutcome`,
     same audit payloads.
   - `ci/seal-phase8-runtime.ts` — harness probe upgraded from an invalid stub
     to a structurally valid STAND_ASIDE `DecisionEvent` (a necessary
     consequence of sealing the boundary; harness scope, not production logic).
   - New files (`bus/admission.ts`, `control/validate.ts`, two test files) are
     pure additions with no imports from trading/execution logic.
2. **Reject-only admission, by construction and by test.** Both admitters
   return the admitted value as the **same reference** — no defaults, no
   normalization, no filtering, no repair (`admission.ts:135`,
   `validate.ts:87`; same-reference and no-silent-filtering tests in both new
   suites). Admission can refuse an event; it can never alter one. Aggregation
   therefore remains VERBATIM end-to-end.
3. **Test suites green, re-run during this audit.** `pnpm test` in
   services/workers, 2026-07-13 07:43: **20 files, 347/347 PASS**, including
   every sealed suite (`pipeline/validate.test.ts` 29, `orchestrator.test.ts`
   6, `durability.test.ts` 21, `risk.test.ts` 37, `bus/bus.test.ts` 13,
   `control/control.test.ts` 12). Matches the accepted Batch 2 report exactly.
4. **Determinism gates held in both batch validations** (accepted reports,
   disposable live stack): PHASE G golden snapshots **10/10 byte-identical**
   in Batch 1 and Batch 2 runs; Phase 9.7 seal STEPS B–K passed with admission
   live in every control-store read, including a real worker restart reading
   persisted state through the new validators (STEP I). The two harness
   failures (HTTP phases 5/3; seal97 STEP A) were both proven pre-existing by
   control runs against clean HEAD / pre-batch dist.

---

## 6. Recommendation

**GAP C only — then Stage 3 is complete.** No additional batch is warranted.

Scope for the GAP C rider (unchanged mechanism from the approved plan):

1. `market/db-quote-transport.ts:117, 124` — copy the `:108` finite-positive
   guard to the tick and candle branches (tick fails → fall through to candle;
   candle fails → `null`), plus NaN/zero fall-through tests. (Planned.)
2. **Recommended fold-in (new, this audit):** `market/portfolio-ledger.ts:84`
   — the same finite-positive guard on `recoveredPeak` (non-finite → fall back
   to `0`, i.e. `initialValue` wins via the existing `Math.max`), plus one
   test. Same defect class, one line, keeps the "no unguarded
   `Number(Decimal)` from DB reads" invariant uniform across the worker. If
   declined, park as Future Hardening (Low) — it cannot reach trading logic.

Explicitly **not** Stage 3 (unchanged Future Hardening register): ingestion
REST casts (Medium), web governance-body cast (Medium), web display-tier Json
reads (Low), helper centralization (Low), harness debt (HTTP-phase auth
bootstrap; seal97 STEP A `MARKET_DATA_SOURCE`).

---

**STOP — audit complete. No source modified, nothing committed. GAP C awaits
review/approval of this report before implementation.**
