# Phase 11C — Stage 3 Batch 1 Implementation Report: Distributed Decision-Bus Admission

Status: COMPLETE — implemented, tested, NOT committed (per instruction)
Date: 2026-07-13
Scope executed: **GAP A only** (distributed decision bus), per the approved
`AI_OS/PHASE11C_STAGE3_BATCH1_IMPLEMENTATION_PLAN.md`.

---

## 1. Security boundary fixed

**Before:** two deserialization edges converted untrusted bytes from Redis into a
fully trusted `DecisionEvent` with zero runtime validation:

- Pub/sub: `redis-bus.ts` did `JSON.parse(message) as E` inside the ioredis
  `message` listener — and non-JSON bytes routed into the *throwing* default
  `onError`, an uncaught exception any Redis client could trigger (latent crash).
- Durable queue: `index.ts` did `job.data as DecisionEvent` — a payload like
  `{"signal":{"confidence":"garbage"}}` reached `new Prisma.Decimal("garbage")`
  in the persistence sink, the job never acked, and BullMQ retried it forever
  (queue poisoning). A well-formed-but-out-of-domain payload was silently
  persisted into the `EngineSignal` ledger that the decision layer aggregates
  VERBATIM.

**After:** all inbound distributed decision-bus messages are treated as `unknown`
first. `admitDecisionEvent` (new `bus/admission.ts`) is the single
`unknown → DecisionEvent` conversion point, baked into both decision-bus
factories so no production caller can bypass it:

- **Pub/sub path:** JSON-parse failures AND admission failures route to a new
  `onReject` channel (default and wired behavior: log + DROP, keep consuming —
  skip-not-halt). The latent crash mode is gone as a side effect: rejection never
  throws from the ioredis listener. `onError` retains exclusively its
  handler-failure semantics.
- **BullMQ path:** admission runs on raw job data BEFORE the handler loop; its
  `BusAdmissionError` propagates un-wrapped and `buildDecisionBus` translates it
  to bullmq's `UnrecoverableError` — a poison job goes straight to the failed set
  once (payload retained for forensics) and the queue keeps draining. Transient
  handler failures still rethrow plainly (at-least-once retry unchanged).

Admission is **reject-only**: a well-formed event is returned as the same
reference, unmodified — no defaults, no normalization, no transformation. Checks:
top-level shape; signal via new context-free `malformedSignalStructureReason`
(enums, quantized-confidence format + [0,1] range, non-empty ids/hashes,
`strategyParams` plain object); `decision.action/side/confidence/rationale`;
`execution` null or `{status: PENDING|SKIPPED, detail: string}`; lineage ids
non-empty, `executionStrategyVersion` finite integer, `tickId` optional
(back-compat, tested); and the five lineage↔signal verbatim cross-checks
(strategyVersionId, featureSnapshotId, dqReportId, datasetHash, featureHash).

## 2. Files changed

| File | Action | Content |
|---|---|---|
| `services/workers/src/bus/admission.ts` | created | `BusAdmissionError` (`.code = "MALFORMED_BUS_EVENT"`), `admitDecisionEvent`, local `isPlainObject`/`isNonEmptyString` (per-module-duplication convention), `DECISION_ACTION_FLAGS` (compiler-enforced against `DecisionAction`) |
| `services/workers/src/pipeline/validate.ts` | modified (additive) | new export `malformedSignalStructureReason(v: unknown)`; `CONFIDENCE_RE` made `export const` (see deviations); **`malformedSignalReason` and both `assertValid*` functions byte-identical — Stage 1 sealed** |
| `services/workers/src/bus/redis-bus.ts` | modified | `RedisChannelBusOptions<E>` gains `admit?`/`onReject?`; message listener routes parse/admit failures to `onReject` (default log+drop); `createRedisDecisionBus` bakes in `admitDecisionEvent` (spread-then-override — callers cannot remove it) |
| `services/workers/src/bus/bullmq-bus.ts` | modified | optional trailing `admit?` constructor param; runs before handler loop, throw propagates un-wrapped; `createBullMqDecisionBus` bakes in `admitDecisionEvent` |
| `services/workers/src/bus/index.ts` | modified | barrel-exports `admission.js` |
| `services/workers/src/index.ts` | modified (`buildDecisionBus` only) | redis branch passes `onReject` → `log("error", ..., category: "INFRA")`; bullmq processor catches `BusAdmissionError` → rethrows `UnrecoverableError` (imported from the existing dynamic `import("bullmq")` — in-process default path still never loads bullmq) |
| `services/workers/src/ci/seal-phase8-runtime.ts` | modified (see deviations) | STEP A wire round-trip probe upgraded from a `{signal:{},...}` stub to a structurally valid `DecisionEvent` |
| `services/workers/src/bus/admission.test.ts` | created | 30 tests — happy path (same-reference return, JSON round-trip, tickId omitted, execution null) + one rejection per family incl. the `"garbage"` confidence exploit fixture and all five cross-check mismatches |
| `services/workers/src/bus/bus.test.ts` | extended | 4 new behavioral tests on the existing fakes (below); `FakeQueue` additionally records the thrown error per failed job to pin un-wrapped vs wrapped propagation |

Not touched: trading logic, execution-core, portfolio, risk, control, web, schema,
in-process bus, all sealed Stage 1/2 validators. No new dependencies.

## 3. Test results

All commands run from `services/workers` (or repo root where noted), 2026-07-13.

| Gate | Result |
|---|---|
| `vitest run` targeted (`bus/admission.test.ts`, `bus/bus.test.ts`, `pipeline/validate.test.ts`) | **72/72 PASS** (30 + 13 + 29) |
| `pnpm typecheck` (tsc strict, --noEmit) | **clean** |
| `pnpm test` — full workers suite | **19 files, 327/327 PASS** (incl. Stage 1/2 seal suites: `validate.test.ts`, `orchestrator.test.ts`, `durability.test.ts`, `risk.test.ts`) |
| `pnpm test` — monorepo (turbo, repo root) | **17/17 tasks PASS** (workers 327, web 297, packages) |
| `ci:harness` on live disposable Postgres/Redis/quant (docker-compose.ci.yml, migrations deployed) | **PHASE 1, 2, 4, G, 6, 7, 8 all PASS.** PHASE G: **10/10 byte-identical golden snapshots** (snapshotHash `c9714493…`, inputHash `8c4e891f…`) — deterministic replay guarantee intact. HTTP phases (5, 3) did not run: see below. |

New behavioral proofs (in-memory fakes, no live Redis):

- Redis bridge: raw non-JSON bytes AND valid-JSON-wrong-shape (the previously
  silent case) → `onReject` invoked, handler never invoked, **next valid event
  still delivered** (skip-not-halt); admission failure does NOT reach `onError`.
- BullMQ bridge: malformed job → failed set with an **un-wrapped**
  `BusAdmissionError` (what the `UnrecoverableError` translation keys on), next
  valid job processes (poison pill doesn't block); a throwing handler on a VALID
  job still surfaces as the wrapped "handler failed" error (retry semantics
  unchanged).

### ci:harness HTTP phases — pre-existing failure, NOT Batch 1

The harness aborts after the DB phases at "web server ready (GET /signals →
200)": the readiness probe calls `/api/v1/signals` unauthenticated, but the B1
fail-closed operator-session gate (`apps/web/src/middleware.ts`, commits
`3aca85b`/`7578820`) now 401s every sessionless `/api/v1/*` request, and the
harness (`src/ci/`, unchanged since 11B commit `348ef38`) has no login flow.
**Verified pre-existing by control run:** with all Batch 1 changes stashed, clean
HEAD fails at the identical point; with changes applied, every phase up to the
web boot passes. The workers-bus diff is not imported by the web tier. Fixing the
harness probe is web/CI-harness scope — flagged for the Stage 3 wrap-up (or its
own fix), not silently absorbed into Batch 1.

## 4. Assumptions and deviations from the approved plan

1. **`CONFIDENCE_RE` export (small addition beyond the plan's file list):** the
   plan required `decision.confidence` to be checked against the exact producer
   wire format. Rather than duplicate the regex in `admission.ts` (drift risk on
   a wire contract), the existing private constant in `pipeline/validate.ts` was
   made `export const` — no existing export's behavior changed. `DECISION_SET`'s
   equivalent in admission.ts is built from the same canonical `SIGNAL_DECISIONS`
   tuple in `@nexus/core` that validate.ts uses (single source preserved).
2. **`job.data as DecisionEvent` cast kept in `index.ts`** (plan said "cast
   removed"): the cast is now type-level only — runtime admission happens inside
   `BullMqBus` before any handler — and keeping it avoids an untyped `any`
   flowing through the processor. Behaviorally identical to the plan.
3. **`seal-phase8-runtime.ts` probe fix (file not in the plan's list):** STEP A's
   Redis round-trip probe published a `{signal:{}, …}` stub cast to
   `DecisionEvent`. With admission baked into `createRedisDecisionBus`, that stub
   is now (correctly) rejected and dropped, which would break the seal's
   delivery assertion. The probe now publishes a structurally valid FLAT/
   STAND_ASIDE event built from the harness's existing fixture lineage — a
   necessary consequence of sealing the boundary, and a stronger probe (it
   proves delivery *through* admission).
4. **`decision.confidence` also gets the [0,1] range check** (plan literally
   listed only the format check): matches the signal-confidence semantics — the
   regex alone admits `"1.5000"`. Reject-only, cannot affect the producer, whose
   values are quantized into range.
5. Assumption unchanged from the plan: only the decision channel is distributed
   in production; execution/market bridges remain admission-optional generics
   (their tests pass unchanged).

## 5. Remaining Stage 3 work (NOT started, per instruction)

- **Batch 2 — GAP B (control-plane store admission):** `control/validate.ts`
  (`ControlDataError`, `assertValidRuntimeState`, `admitControlComponents` built
  from the canonical tuples in `packages/control`), replace the four blind casts
  in `control/store.ts:62,75-78,175`, conservative handling at the four
  `control/evaluator.ts` call sites (recovery stays PROTECTED on corrupt
  incident; resolution failure leaves incident OPEN; boot fallback logs), plus
  `control/validate.test.ts` and the fail-closed recovery-verification test in
  `control/control.test.ts`.
- **Batch 2/3 rider — GAP C:** finite-positive guards on the tick/candle branches
  of `market/db-quote-transport.ts:117,124` + NaN/zero fall-through tests.
- **Flagged (new, outside Stage 3 plan):** `ci:harness` HTTP phases (5, 3) are
  broken by the B1 auth gate independently of this work — the harness needs a
  session bootstrap (login against the operator registry) or an authenticated
  probe before those phases can pass anywhere.

---

**STOP — Batch 1 complete. Working tree holds the uncommitted diff; Batch 2 not started, awaiting instruction.**
