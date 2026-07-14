# Phase 11C — Stage 3 Plan: Distributed Bus & Control-Plane Admission

Status: PLANNING (no code in this stage's planning pass)
> **Historical record.** Phase 11C is COMPLETE and RATIFIED (2026-07-14, committed as `713d9bf`) — see [PHASE11C_FINAL_ACCEPTANCE.md](PHASE11C_FINAL_ACCEPTANCE.md). Future hardening: [PHASE12_CHARTER.md](PHASE12_CHARTER.md).
Date: 2026-07-12
Prereqs: Stage 1 (f468b9b — pipeline admission), Stage 2 (a2182f9 — journal recovery admission)
Verdict: **Stage 3 is required.** Two unguarded trust boundaries remain in the production worker runtime.

Method: whole-repo runtime-ingress audit via three parallel sweeps — Stage 1/2 coverage map, services/packages ingress sweep (JSON.parse, Prisma Json, process.env, Redis/BullMQ, pub/sub, WS/REST, replay/journal loading, `as` casts), and apps/web ingress sweep (request bodies, query params, SSE, fetch, env, session). Load-bearing findings verified directly against source.

## 1. Runtime Boundary Map

Legend: ✅ Protected (validated, fail-closed) · ⚠️ Fail-Open (unvalidated cast, silent propagation) · ◐ Partial

### Worker runtime (services/workers)

| Source | Boundary | Validation | Trusted domain | Status |
|---|---|---|---|---|
| Prisma `StrategyVersion` row | `orchestrator.ts:160` | `assertValidStrategyVersionRow` → `PipelineDataError` | pipeline params | ✅ Fail-Closed (Stage 1) |
| Prisma `FeatureSnapshot`+`dqReport` rows | `orchestrator.ts:241-255` | `assertValidSnapshotRow` → `PipelineDataError` | inputHash + signal gen | ✅ Fail-Closed (Stage 1) |
| Engine signal (in-process, defense-in-depth) | `orchestrator.ts:330` | `malformedSignalReason` → drop + counter | bus publish | ✅ Fail-Closed per signal (Stage 1) |
| Market JSONL journal file | `market/event-store.ts:297` | `assertValidMarketJournalRecord` → `JournalCorruptionError` → UNARMED | market/portfolio recovery | ✅ Fail-Closed (Stage 2) |
| Risk JSONL journal file | `risk/events.ts:219` | `assertValidRiskJournalRecord` → `RiskJournalCorruptionError` → HALTED | risk recovery | ✅ Fail-Closed (Stage 2) |
| **Redis pub/sub message** | `bus/redis-bus.ts:92` | **NONE — `JSON.parse(message) as E`** | all subscribers (incl. DB persistence) | ⚠️ **Fail-Open** |
| **BullMQ durable job payload** | `index.ts:328` | **NONE — `job.data as DecisionEvent`** | persistence subscriber → Prisma write | ⚠️ **Fail-Open** (garbage `confidence` → `Prisma.Decimal` throw → infinite retry) |
| **Prisma control rows (`state`, `affectedComponents` Json)** | `control/store.ts:62,75-78,175` | **NONE — cast to `RuntimeState` / `ControlComponent[]`** | kill-switch / recovery evaluation | ⚠️ **Fail-Open** |
| Deribit order REST/RPC | `market/deribit-order-transport.ts:206-342` | structural + `finitePositive` guards → `DeribitOrderError` | order lifecycle | ✅ Fail-Closed |
| DB quote Decimals (orderbook branch) | `db-quote-transport.ts:108` | `Number.isFinite && > 0` | mark price | ✅ Protected |
| DB quote Decimals (tick/candle branches) | `db-quote-transport.ts:117,124` | none (unlike sibling branch at :108) | mark price | ◐ Fail-Open (low: non-null Decimal cols) |
| Quant feature HTTP response | `features/client.ts:54` + `consumer.ts` | object-level guards + DQ floor + allowlists → `FeatureComputeError` | feature admission | ✅/◐ (per-value numbers opaque by design; `feature()` throws on non-finite at use, `replay/strategy.ts:63`) |
| `SIGNAL_TICK_MS` env | `index.ts:76-80` | `readTickMs()` finite + ≥1000 guard | tick interval | ✅ Protected (audit note "unguarded" was stale — verified fixed) |
| Env (bus backend, flags, Deribit config) | `index.ts`, `deribit-order-transport.ts:578-585` | allowlists / required-set checks | config | ✅ Protected |
| Control probes (DB/Redis/quant health) | `control/probes.ts`, `control/inputs.ts` | conservative status on any failure | health evaluation | ✅ Fail-Closed |

### Ingestion (services/ingestion)

| Source | Boundary | Validation | Status |
|---|---|---|---|
| Exchange WS frames (Deribit/Binance) | `deribit.ts:1161`, `binance.ts:729` | envelope cast, but **every consumed field** finite-guarded before emit (drop/skip on fail) | ✅ effectively Protected |
| Exchange REST bodies | `binance.ts:288`, `deribit.ts:522-544` | envelope checks only; `result as T` unvalidated | ◐ Partial (Future Hardening) |
| Stage-B DQ HTTP | `dq/stage-b-client.ts:150` | per-element `isStructuralCheck` → fail-closed INFRA deduction | ✅ Fail-Closed |
| Env | `lib/env.ts` | required vars throw; allowlists; `parsePositiveInt` | ✅ Fail-Closed |

### Web (apps/web)

| Source | Boundary | Validation | Status |
|---|---|---|---|
| All `/api/v1/*` requests | `middleware.ts:49-74` + `requireOperatorSession` | signed cookie + registry re-check → 401/403 | ✅ Fail-Closed |
| Mutating POST bodies | route handlers | `readJsonObject` + field guards or downstream `GovernanceValidationError` → 400 | ✅ (one brittle blind cast, see gaps) |
| Query params | `lib/api-validate.ts` | regex/bounds, malformed → 400 | ✅ Fail-Closed |
| SSE reconnect cursor | `signals/stream/route.ts:41-70` | strict parse → 400 | ✅ Fail-Closed |
| Session cookie | `lib/session.ts:109-120` | HMAC verify then field guards | ✅ Fail-Closed |
| Env (secret, operators, rate limits, equity) | `session.ts:35`, `operator-registry.ts`, `login-rate-limit.ts`, `trading-decision.ts:35-37` | fail-closed (no secret ⇒ lockout) / guarded defaults | ✅ |
| SSE client consumer | `signal-feed.tsx:138,157` | try/catch cast, silent drop (same-origin own API) | ◐ cosmetic |
| Packages (`packages/*`) | — | no `JSON.parse` / `process.env` / network ingress in any package src; pure, in-type | ✅ N/A |

## 2. Remaining Admission Gaps

### GAP A — Distributed decision-bus admission — **CRITICAL** → Phase 11C Stage 3

- **Files/functions:** `services/workers/src/bus/redis-bus.ts:92` (`RedisChannelBus.ensureSubscriber`), `services/workers/src/index.ts:328` (`buildDecisionBus` BullMQ processor), sink at `execution/subscribers/persistence-subscriber.ts:36-37` → `signal/persistence.ts:41,43`.
- **Risk:** any process with Redis access (or a corrupted/legacy queue entry) injects an arbitrary object that is dispatched as a trusted, fully-typed `DecisionEvent` and written to the DB.
- **Exploit scenario:** publish `{"signal":{"confidence":"garbage",...}}` on the decision channel → pub/sub: `RedisChannelBus`'s default `onError` **throws from inside the ioredis `message` listener** (`redis-bus.ts:67-70`) → uncaught exception (latent crash bug, live because `buildDecisionBus` passes no `onError`); BullMQ: `new Prisma.Decimal("garbage")` throws → job un-acked → **infinite retry, queue poisoned**. Alternatively, a well-formed-but-out-of-domain `side`/`decision` is silently persisted, corrupting the signal ledger the decision layer aggregates VERBATIM.
- **Current behavior:** `JSON.parse(...) as E` / `job.data as DecisionEvent` — zero admission.
- **Desired behavior:** admission codec at the deserialization edge. Pub/sub: reject + log + counter, drop, keep consuming (skip-not-halt — nothing to retry on at-most-once broadcast). BullMQ: throw `BusAdmissionError` → translated to bullmq `UnrecoverableError` → straight to failed set (payload retained for forensics), zero retries, queue keeps draining.
- Note: only the **decision** channel crosses redis/bullmq in production (`index.ts:293-336`); execution/market redis/bullmq factories are referenced only by `bus/bus.test.ts`.

### GAP B — Control-plane store admission — **HIGH** → Phase 11C Stage 3

- **Files/functions:** `services/workers/src/control/store.ts:62` (`getCurrentState`: `row.state as RuntimeState`), `:75-78` (`getLatestTransition`: state/previousState casts + `affectedComponents as ControlComponent[]` — a Prisma **Json** column), `:175` (`getOpenIncident`: same Json cast).
- **Risk:** corrupt/out-of-domain control rows silently enter kill-switch/recovery evaluation — the one subsystem whose whole contract is fail-closed.
- **Exploit scenario:** a corrupted `Incident.affectedComponents` Json (non-array, or unknown component strings) flows into recovery verification; recovery could be evaluated against a silently-narrowed component set, or an unknown `state` string bypasses state-machine expectations. Today the only backstop is indirect: a downstream throw makes `evaluate()` reject and permission goes stale-closed only after `maxPermissionAgeMs` (≥60s window).
- **Current behavior:** blind casts; `?? []` / `?? "BOOTING"` defaults mask malformation.
- **Desired behavior:** `assertValidRuntimeState` / `admitControlComponents` (throw `ControlDataError`); each evaluator call site handles corruption **conservatively and locally**: recovery-exit verification failure keeps state PROTECTED; incident-resolution failure leaves the incident OPEN (visible); boot fallback logs instead of silently swallowing.

### GAP C — DB-quote finiteness consistency — **LOW** → Phase 11C Stage 3 (4-line rider)

- **File/function:** `services/workers/src/market/db-quote-transport.ts:117,124` (`markFor`, tick & candle branches).
- **Risk/scenario:** corrupt/zero Decimal reaches `quantizePrice` unguarded, while the sibling orderbook branch (`:108`) guards `Number.isFinite && > 0`. Non-null Decimal columns make this improbable — it is a consistency fix.
- **Current → desired:** unguarded `Number(...)` → same finite-positive guard; tick fails → fall through to candle; candle fails → `null` (no mark).

### Closed by verification (no work)

- `SIGNAL_TICK_MS` NaN interval — **already guarded** by `readTickMs()` (`index.ts:76-80`); audit item stale.
- Execution layer journal — **does not exist by design**; portfolio state is rebuilt from `MarketJournalRecord.result`, which Stage 2 already validates (`event-store.ts:173-189` checks exactly the fields `applyResult` consumes).

### Ranked Future Hardening (not Stage 3)

| Rank | Item | Why deferred |
|---|---|---|
| Medium | Ingestion REST `res.json() as T` (`binance.ts:288`, `deribit.ts:522-544`) | WS paths field-guard every value before emit; REST feeds backfill; deserves its own pass with venue fixtures |
| Medium | Web `governance/strategies/route.ts:36` blind body cast | Fully re-validated field-by-field in `registerStrategyVersion` → 400; brittle-by-construction but currently fail-closed |
| Low | Web `trading-decision.ts:148,217` `fs.features` Json cast into sizing | DB-tier source (written by workers), not client ingress |
| Low | Per-value finiteness inside `features` objects (worker + feature client) | Guarded at point of use — `feature()` throws `StrategyInputError` on non-finite (`replay/strategy.ts:63`) |
| Low | `versions/[id]/retire/route.ts:43` leaks `String(err)` | Cosmetic inconsistency with `internalErrorResponse` pattern |
| Low | Centralize `isPlainObject`/`isNonEmptyString` (3×/2× copies today) | Zero behavior change; would touch sealed Stage 1/2 modules |
| — | CLI/CI harness casts (`cli/e2e-pipeline.ts:109,113,380`, `ci/lib.ts:190`, etc.) | **Out of scope** — non-production entrypoints, fail loudly in harness |
| — | Web same-origin fetch/SSE response casts (`use-polled-resource.ts:103`, `signal-feed.tsx:138`) | **Out of scope** — consuming own trusted API, display tier |

## 3. Proposed Stage 3 Architecture (minimal)

**Bus admission — injectable `admit` codec, bound in the typed factories.** Add optional `admit: (v: unknown) => E` to `RedisChannelBus` and `BullMqBus`; `createRedisDecisionBus` / `createBullMqDecisionBus` bake in `admitDecisionEvent`, so every production caller gets admission automatically while the generic bridges (and their in-memory-fake tests) stay event-type-agnostic. Validation runs in the delivery path **before the handler loop** — the only placement that fixes the BullMQ retry-forever mode and survives a second subscriber. Rejected alternatives: per-subscriber validation (misses the processor, breaks on multi-subscriber) and a channel→validator registry (indirection for one live channel).

- New `bus/admission.ts`: `BusAdmissionError` (`.code = "MALFORMED_BUS_EVENT"`) + `admitDecisionEvent(v: unknown): DecisionEvent` — validates top-level shape; `signal` via a new **context-free** `malformedSignalStructureReason(v): string | null` exported from `pipeline/validate.ts` (reuses its `CONFIDENCE_RE`/`DECISION_SET`; the existing ctx-bound `malformedSignalReason` stays byte-identical — Stage 1 remains sealed); `decision.action` ∈ {ENTER, HOLD, STAND_ASIDE} via the established flags-object enum pattern; `lineage` ids non-empty + `executionStrategyVersion` finite integer + `tickId` optional (back-compat with in-flight jobs); verbatim lineage↔signal cross-checks (featureSnapshotId, strategyVersionId, dqReportId, datasetHash, featureHash).
- Redis path: new `onReject?(detail, channel)` option (default: log error, drop); JSON-parse failures and `admit` throws route to `onReject` — also fixes the latent uncaught-throw crash. `onError` keeps handler-failure semantics.
- BullMQ path: `admit` throw propagates un-wrapped; `buildDecisionBus` in `index.ts` catches `instanceof BusAdmissionError` and rethrows bullmq's `UnrecoverableError` (translation lives where the real bullmq module is dynamically imported).
- Sink unchanged: admission guarantees `confidence` parses into `Prisma.Decimal` and `strategyParams` is a plain object; the in-process bus is same-type trusted and takes no `admit`.

**Control store admission — validators + conservative call-site handling.** New `control/validate.ts`: `ControlDataError` (codes `MALFORMED_RUNTIME_STATE` / `MALFORMED_STATE_TRANSITION` / `MALFORMED_INCIDENT`); sets built from the canonical `RUNTIME_STATES` / `CONTROL_COMPONENTS` tuples in `packages/control/src/types.ts:21,52` (drift-proof — the tuple is the type's source); `assertValidRuntimeState(v, ctx)`; `admitControlComponents(v, ctx)` — null → `[]` (preserves current contract), else every element must be a known component, **no silent filtering**. `store.ts` replaces the four casts. Call-site semantics in `control/evaluator.ts`: boot fallback to BOOTING now logs; recovery-exit `getOpenIncident` corruption → `recovery = false`, state stays **PROTECTED**, audit `RECOVERY_FAILED` "incident row corrupt — recovery unverifiable (fail-closed)" (the one site where corruption could previously *upgrade* state); entering PROTECTED with a corrupt open-incident read → open a fresh valid incident (never blocks protection); resolution sites → skip resolution, incident stays OPEN (visible to operator).

**Micro-guard:** `db-quote-transport.ts` tick/candle branches copy the `:108` finite-positive guard.

**Helper policy:** duplicate `isPlainObject`/`isNonEmptyString` into the two new modules, matching the deliberate Stage 1/2 per-module-duplication convention; centralization stays on the Future Hardening list (touching sealed modules for zero behavior change is over-scope).

## 4. File List

| File | Action | Content |
|---|---|---|
| `services/workers/src/bus/admission.ts` | create | `BusAdmissionError`, `admitDecisionEvent`, local guards + `DECISION_ACTION_FLAGS`/set |
| `services/workers/src/control/validate.ts` | create | `ControlDataError`, `assertValidRuntimeState`, `admitControlComponents` |
| `services/workers/src/pipeline/validate.ts` | modify | add exported `malformedSignalStructureReason` (context-free); existing exports untouched |
| `services/workers/src/bus/redis-bus.ts` | modify | `admit?`/`onReject?` options; route parse/admit failures to `onReject`; wire `admitDecisionEvent` in `createRedisDecisionBus` |
| `services/workers/src/bus/bullmq-bus.ts` | modify | `admit?` option; run before handler loop, throw propagates un-wrapped; wire in `createBullMqDecisionBus` |
| `services/workers/src/index.ts` | modify | `buildDecisionBus`: redis `onReject` logging; bullmq `BusAdmissionError` → `UnrecoverableError` translation |
| `services/workers/src/control/store.ts` | modify | replace 4 casts with validators |
| `services/workers/src/control/evaluator.ts` | modify | conservative `ControlDataError` handling at 4 call sites |
| `services/workers/src/market/db-quote-transport.ts` | modify | finite-positive guards on tick/candle branches |
| `services/workers/src/bus/admission.test.ts` | create | validator unit tests |
| `services/workers/src/control/validate.test.ts` | create | validator unit tests |
| `services/workers/src/bus/bus.test.ts` | extend | bridge admission behavior (fakes) |
| `services/workers/src/control/control.test.ts` | extend | fail-closed recovery-verification test |
| `services/workers/src/market/db-quote-transport.test.ts` | extend | NaN/zero fall-through cases |

No schema changes, no package changes, no web changes, no new dependencies.

## 5. Validation Strategy

- **Unit — `bus/admission.test.ts`** (mirrors Stage 1 `validate.test.ts` style: one happy-path fixture builder, one rejection per family): non-object; missing signal/decision/lineage; bad side/decision/action enums; malformed confidence (`"0.95"`, `"2.0000"`, non-string); wrong execution status; missing lineage id; non-integer `executionStrategyVersion`; lineage↔signal mismatch; **`tickId` omitted passes** (back-compat). Assert `BusAdmissionError` + message fragment.
- **Unit — `control/validate.test.ts`**: all `RUNTIME_STATES` pass; unknown/empty/non-string throw with code; components: null→`[]`, `[]` ok, all known ok, one unknown throws, non-array throws.
- **Behavior — `bus/bus.test.ts` (existing fakes, no live Redis)**: redis bridge with `admit`+`onReject` spy — garbage JSON → rejected, handler not invoked, **next valid event still delivered** (skip-not-halt); valid-JSON-wrong-shape → rejected (the previously-silent case). BullMQ bridge — malformed job lands in fake failed set, subsequent valid job processes (poison pill doesn't block).
- **Behavior — `control/control.test.ts`**: evaluator in PROTECTED, protections clear, but `getOpenIncident` throws `ControlDataError` → evaluation does **not** reach HEALTHY.
- **Regression gate:** full `pnpm test` in services/workers (852 TS tests must stay green — Stage 1/2 suites `validate.test.ts`, `orchestrator.test.ts`, `durability.test.ts`, `risk.test.ts` prove sealed stages untouched), then `ci:harness` (PHASE G golden snapshots must be byte-identical — admission adds no transformation, only rejection, so any snapshot drift is a defect).

## 6. Regression Risks

1. **Over-strict guards rejecting legitimate events** — mitigated by design: `tickId` optional, `rationale`/`detail` type-checked only (not non-empty), `confidence` uses the exact quantized format the producer emits verbatim.
2. **BullMQ backlog across deploy** — pre-Stage-3 jobs are the same shape → pass; an already-poisoned retrying job becomes a one-time `UnrecoverableError` failed-set entry (intended; note in rollout).
3. **Redis bridge semantics change** — parse errors move from throwing `onError` (crash) to `onReject`+drop; any test asserting the old behavior updated deliberately.
4. **Legacy control rows** — all writers produce valid enums/arrays; a corrupt row now surfaces as an OPEN incident / PROTECTED hold (visible, conservative) instead of silent passage. Web tier reads the same tables raw for display — cosmetic divergence possible on a corrupt row; explicitly deferred.
5. **In-memory bus and existing phase tests** — untouched: `admit` is optional and the in-process bus never receives one.

## 7. Why this is the smallest correct Stage 3

- It covers **exactly the two remaining fail-open trust boundaries in the production worker runtime** (network/queue → typed event; DB → kill-switch domain) plus one 4-line same-file consistency guard. Nothing else in the audit crosses an unvalidated process boundary into the fail-closed path.
- **One concrete admitter, not three**: only the decision channel is distributed in production; the injectable-codec plumbing makes execution/market channels a two-line follow-up if they ever go distributed, without building validators nobody consumes.
- **Zero changes to sealed Stage 1/2 code paths** (`malformedSignalReason` byte-identical; journal validators untouched), zero schema changes, zero new dependencies, no helper-centralization churn.
- Every deferral is justified by an existing downstream guard, a non-production entrypoint, or a display-only surface — each ranked and parked on the Future Hardening list rather than silently dropped.
