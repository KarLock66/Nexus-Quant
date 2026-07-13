# Phase 11C — Stage 3 Batch 1 Implementation Plan: Distributed Decision-Bus Admission

Status: AWAITING APPROVAL (no code changed in this pass)
Date: 2026-07-12
Scope: **GAP A only** (Stage 3 Plan §2) — Redis pub/sub + BullMQ decision-bus admission.
Out of scope for this batch: GAP B (control store), GAP C (db-quote guards) — later batches.
Parent plan: `AI_OS/PHASE11C_STAGE3_PLAN.md` (§3 "Bus admission", §4 file list rows 1, 3–6, 10, 12).

---

## 1. Current vulnerability path (how untrusted payloads enter the runtime)

Two deserialization edges convert bytes from Redis into a fully trusted `DecisionEvent`
with **zero validation** — both via a blind TypeScript cast, which is a compile-time
assertion with no runtime effect:

### Path 1 — Redis pub/sub (broadcast, at-most-once)

```
any process with Redis access
  → PUBLISH nexus.bus.decision '<arbitrary bytes>'
  → RedisChannelBus.ensureSubscriber() message listener   redis-bus.ts:88-98
      event = JSON.parse(message) as E                    redis-bus.ts:92   ← trust boundary, no admission
  → dispatch(event) → every subscribed handler
  → createPersistenceSubscriber handler                   execution/subscribers/persistence-subscriber.ts:36-37
  → persistEngineSignal(prisma, event.signal)             signal/persistence.ts:41,43
      new Prisma.Decimal(signal.confidence)               ← throws on garbage
      signal.strategyParams as Prisma.InputJsonValue      ← blind cast into a Json column
```

### Path 2 — BullMQ durable queue (at-least-once, retried)

```
any process with Redis access (or a corrupted/legacy queue entry)
  → Queue.add on queue nexus.bus.decision
  → Worker processor in buildDecisionBus                  index.ts:327-329
      await process(job.data as DecisionEvent)            index.ts:328     ← trust boundary, no admission
  → BullMqBus.ensureWorker handler loop                   bullmq-bus.ts:84-93
  → same persistence sink as Path 1
```

### Concrete failure modes (all verified against source)

1. **Latent crash (pub/sub, live today):** `buildDecisionBus` constructs
   `createRedisDecisionBus(publisher)` with **no options** (`index.ts:307`), so
   `RedisChannelBus` uses its default `onError`, which **throws**
   (`redis-bus.ts:65-70`). Non-JSON bytes on the channel hit the `JSON.parse` catch
   (`redis-bus.ts:93-95`) and call that throwing `onError` from **inside the ioredis
   `message` listener** — an uncaught synchronous exception in an event-emitter
   callback, i.e. process crash territory, triggerable by any Redis client.
2. **Queue poisoning (BullMQ):** a payload like
   `{"signal":{"confidence":"garbage",...}}` reaches
   `new Prisma.Decimal("garbage")` which throws; the job is never acked; BullMQ
   redelivers it **forever** (the worker is created with default options — no
   attempts cap, `index.ts:324-331`). One malformed job wedges the durable queue.
3. **Silent ledger corruption (both paths):** a well-formed-but-out-of-domain
   payload (e.g. `side: "UP"`, `decision: "MAYBE"`, confidence `"0.95"` instead of
   the quantized `"0.9500"`, or lineage ids pointing at nothing) is persisted
   verbatim into `EngineSignal`. The decision/portfolio layers aggregate this
   table **VERBATIM by design** (never recomputed), so a forged row propagates
   untraceably into decisions.

### Why the in-process bus is NOT affected

The default in-process bus (`createDecisionBus`) passes the same in-memory object
from the orchestrator (which already runs Stage 1's `malformedSignalReason` before
publishing, `orchestrator.ts:330`) to subscribers — same type, same process, no
serialization boundary. It needs and gets no admission.

Only the **decision** channel crosses Redis/BullMQ in production
(`index.ts:293-336`). The execution/market Redis/BullMQ factories are referenced
only by `bus/bus.test.ts` — so Batch 1 ships **one concrete admitter** and generic
plumbing, per parent plan §7.

---

## 2. Exact files involved

| File | Action | Change |
|---|---|---|
| `services/workers/src/bus/admission.ts` | **create** | `BusAdmissionError` + `admitDecisionEvent(v: unknown): DecisionEvent` + local guards |
| `services/workers/src/pipeline/validate.ts` | modify (additive) | export new context-free `malformedSignalStructureReason(v: unknown): string \| null`; **all existing exports byte-identical** |
| `services/workers/src/bus/redis-bus.ts` | modify | optional `admit?` / `onReject?` in `RedisChannelBusOptions`; route parse/admit failures to `onReject`; wire `admitDecisionEvent` in `createRedisDecisionBus` |
| `services/workers/src/bus/bullmq-bus.ts` | modify | optional `admit?` param; run before the handler loop, throw propagates un-wrapped; wire in `createBullMqDecisionBus` |
| `services/workers/src/index.ts` | modify (buildDecisionBus only) | redis: pass `onReject` logger; bullmq: catch `instanceof BusAdmissionError` in the Worker processor → rethrow bullmq `UnrecoverableError` |
| `services/workers/src/bus/admission.test.ts` | **create** | validator unit tests |
| `services/workers/src/bus/bus.test.ts` | extend | bridge admission behavior on the existing fakes |

No schema changes. No package changes. No web changes. No new dependencies
(`bullmq` already provides `UnrecoverableError`; it is imported inside the existing
dynamic `import("bullmq")` in `buildDecisionBus`, so the in-process default path
still never loads bullmq).

---

## 3. Existing assumptions being removed / preserved

**Removed (the vulnerability):**
- `redis-bus.ts:92` assumes any JSON on the channel is a valid `E`.
- `index.ts:328` assumes any BullMQ `job.data` is a valid `DecisionEvent`.
- `persistence-subscriber.ts` / `persistEngineSignal` assume their input already
  satisfies the `GeneratedSignal` contract (true for in-process, false for distributed).

**Preserved (contracts that must not move):**
- `PubSubBus<E>` public interface (`bus/types.ts:26-31`) — unchanged; `admit` is a
  construction-time option, not an interface change.
- The sealed Stage 1 validator `malformedSignalReason` — **byte-identical**; the new
  `malformedSignalStructureReason` is a separate export reusing the same private
  `CONFIDENCE_RE` / `DECISION_SET` constants (`pipeline/validate.ts:39-41`), so
  wire format and enum domain have exactly one source each.
- In-process bus and every Phase 1–6 test — untouched (`admit` is optional and the
  in-process bus never receives one).
- Redis `onError` keeps its existing meaning (handler-failure during dispatch);
  admission failures get the **new, separate** `onReject` channel. Test
  `bus.test.ts` currently asserts default-`onError` *handler* rethrow semantics
  only — parse-failure behavior moves to `onReject` deliberately (parent plan
  regression risk 3).
- Event wire format unchanged — no version bump needed. `lineage.tickId` stays
  optional (`execution/types.ts:60`), so in-flight pre-deploy jobs still pass.

---

## 4. Proposed minimal patch

### 4a. `bus/admission.ts` (new)

```ts
export class BusAdmissionError extends Error {
  readonly code = "MALFORMED_BUS_EVENT";
  constructor(message: string) { ... this.name = "BusAdmissionError"; }
}

export function admitDecisionEvent(v: unknown): DecisionEvent
```

`admitDecisionEvent` treats `v` as `unknown` and checks, throwing
`BusAdmissionError` with a specific reason on first failure:

1. **Top level:** plain object with `signal`, `decision`, `lineage` plain objects;
   `execution` is `null` or a plain object with `status ∈ {PENDING, SKIPPED}` and
   `detail: string` (matches `ExecutionPlan`, `execution/types.ts:47-50`).
2. **signal:** delegated to the new `malformedSignalStructureReason(v)` — structural
   contract of `GeneratedSignal` (`signal/types.ts:47-59`): `symbol`, ids and
   hashes non-empty strings; `side`/`decision` ∈ `DECISION_SET` (LONG|SHORT|FLAT);
   `confidence` matches `CONFIDENCE_RE` (`/^[01]\.\d{4}$/`) and ∈ [0,1];
   `strategyParams` a plain object (guarantees the `Prisma.InputJsonValue` cast at
   `persistence.ts:43` is sound — per-key numeric semantics stay the strategy
   layer's concern, mirroring Stage 1's treatment of `features`).
3. **decision:** `action` ∈ {ENTER, HOLD, STAND_ASIDE} via the established
   flags-object pattern (`Record<DecisionAction, true>` → `ReadonlySet`, exactly as
   `ORDER_EVENT_KIND_FLAGS` in `market/event-store.ts:108-117`) — compiler-enforced
   drift-proofing against `DecisionAction`; `side` ∈ `DECISION_SET`;
   `confidence` matches `CONFIDENCE_RE`; `rationale` is a string (type-checked
   only, not non-empty — parent plan regression risk 1).
4. **lineage:** `strategyVersionId`, `featureSnapshotId`, `dqReportId`,
   `datasetHash`, `featureHash`, `executionStrategyId` non-empty strings;
   `executionStrategyVersion` a finite integer (`Number.isInteger`); `tickId`
   **absent or** non-empty string (back-compat with in-flight jobs).
5. **Verbatim cross-checks:** `lineage.featureSnapshotId === signal.featureSnapshotId`,
   same for `strategyVersionId`, `dqReportId`, `datasetHash`, `featureHash` — a
   forged event cannot claim lineage its signal does not carry.

On success it returns the same value, now typed `DecisionEvent` — the **only**
place in the distributed path where `unknown` becomes the trusted type.

Local `isPlainObject` / `isNonEmptyString` are duplicated into the module,
matching the deliberate Stage 1/2 per-module-duplication convention (parent plan
"Helper policy"; centralization stays on Future Hardening).

### 4b. `pipeline/validate.ts` (additive only)

New export `malformedSignalStructureReason(v: unknown): string | null` — the
context-free structural subset of the checks in `malformedSignalReason` (enums,
confidence format/range, non-empty ids/hashes, `strategyParams` plain-object) with
**no ctx cross-checks** (there is no snapshot/DQ/version context at the bus edge —
the verbatim checks that ARE possible there, lineage↔signal, live in
`admitDecisionEvent`). Existing `malformedSignalReason` and both `assertValid*`
functions remain byte-identical — Stage 1 stays sealed.

### 4c. `bus/redis-bus.ts`

```ts
export interface RedisChannelBusOptions {
  onError?: (err: unknown, channel: string) => void;      // unchanged: handler failures
  admit?: (v: unknown) => unknown;                        // deserialization admission
  onReject?: (detail: string, channel: string) => void;   // admission failures
}
```

In `ensureSubscriber`'s message listener: `JSON.parse` failures AND `admit` throws
both route to `onReject` (default: `log("error", ...)` via the module's existing
`errMsg` import — **drop, never throw**), then `return` — the subscription keeps
consuming (skip-not-halt: at-most-once broadcast has nothing to retry). This also
fixes latent crash mode 1: parse failures no longer reach the throwing default
`onError`. `onError` keeps exclusively its dispatch/handler-failure role.

`createRedisDecisionBus` bakes in `admit: admitDecisionEvent` (caller-supplied
options may add `onReject`/`onError` but cannot remove admission). The execution/
market factories and the generic `RedisChannelBus` stay admission-optional.

### 4d. `bus/bullmq-bus.ts`

`BullMqBus` constructor gains an optional `admit?: (v: unknown) => E` (trailing
parameter — existing constructions compile unchanged). In `ensureWorker`'s
processor, `admit` runs on the raw job data **before the handler loop**, and its
throw propagates **un-wrapped** (not wrapped in the "handler failed" `Error`), so
the caller's processor can distinguish `BusAdmissionError` from a transient
handler failure. Placement before the loop is the only one that both fixes the
retry-forever mode and survives a second subscriber (parent plan §3, rejected
alternatives). `createBullMqDecisionBus` bakes in `admitDecisionEvent`.

### 4e. `index.ts` — `buildDecisionBus` only

- **redis branch:** pass `onReject: (detail, channel) => log("error", "decision bus event rejected (malformed — dropped)", { channel, detail, category: "INFRA" })` to `createRedisDecisionBus`.
- **bullmq branch:** the Worker processor wraps `process(job.data)` (cast removed;
  `process` accepts the raw value because admission now happens inside the bus) in:

  ```ts
  try { await process(job.data); }
  catch (err) {
    if (err instanceof BusAdmissionError) throw new UnrecoverableError(err.message);
    throw err;
  }
  ```

  `UnrecoverableError` comes from the same dynamic `import("bullmq")` already in
  this function — the translation lives where the real bullmq module is loaded,
  keeping the bridge module bullmq-free. Result: a malformed job goes **straight
  to the failed set** (payload retained for forensics), zero retries, queue keeps
  draining; a *transient* handler failure (e.g. DB down) still rethrows plainly
  and keeps at-least-once retry semantics — behavior there is unchanged.

### Why this does not alter business logic

- Admission is **structural rejection only**: a well-formed event is returned
  unmodified (no defaults filled, no fields normalized, no transformation), so
  every event that flows today — all produced by `orchestrator.ts` after Stage 1's
  stricter contextual check — passes byte-identically. Deterministic replay and
  PHASE G golden snapshots are unaffected by construction: any snapshot drift
  would itself be a defect.
- Trading logic, execution-core, portfolio, and risk code paths are untouched —
  the diff is confined to the two bridge modules, one additive export, the
  `buildDecisionBus` wiring, and tests.
- The persistence sink is unchanged: admission upstream now guarantees what it
  blindly assumed (`confidence` parses into `Prisma.Decimal`, `strategyParams` is
  a plain object).

---

## 5. Validation strategy (how tests prove invalid messages are rejected)

### Unit — `bus/admission.test.ts` (new; mirrors Stage 1 `validate.test.ts` style: one happy-path fixture builder, one rejection per family)

- Happy path: fully-formed `DecisionEvent` fixture → returned as-is (same reference).
- `tickId` **omitted** → passes (back-compat is a tested guarantee, not an accident).
- Rejections (each asserts `BusAdmissionError`, `.code === "MALFORMED_BUS_EVENT"`,
  and a message fragment naming the offending field):
  - non-object (`null`, string, array), missing `signal` / `decision` / `lineage`
  - bad `signal.side` / `signal.decision` (e.g. `"UP"`), bad `decision.action` (e.g. `"YOLO"`)
  - malformed confidence: `"0.95"` (not quantized), `"2.0000"` (out of range), `0.95` (number, not string), `"garbage"` (the exploit fixture from the parent plan)
  - `execution.status` not PENDING|SKIPPED; `execution` a non-null non-object
  - missing/empty lineage id; non-integer / non-finite `executionStrategyVersion`
  - lineage↔signal mismatch (each of the five cross-checked fields)
  - `strategyParams` not a plain object (array, null, scalar)

### Behavior — `bus/bus.test.ts` (existing in-memory fakes, no live Redis)

- **Redis bridge** with `admit: admitDecisionEvent` + `onReject` spy:
  - raw non-JSON bytes published → `onReject` called, handler **not** invoked, no throw escapes the fake's listener (crash mode 1 fixed)
  - valid-JSON-wrong-shape (the previously **silent** case) → rejected, handler not invoked
  - **next valid event still delivered** after a rejection (skip-not-halt)
- **BullMQ bridge** with `admit`:
  - malformed job → admission throw propagates un-wrapped out of the processor → lands in the fake's `failed` set
  - subsequent valid job processes normally (poison pill does not block the queue)
  - handler (non-admission) throw still surfaces as the wrapped "handler failed" error (retry semantics preserved)

### Regression gate

1. `pnpm test` in `services/workers` — all 852 TS tests stay green; Stage 1/2
   suites (`pipeline/validate.test.ts`, `orchestrator.test.ts`, `durability.test.ts`,
   `risk.test.ts`) prove sealed stages untouched.
2. `pnpm typecheck` / lint — strict TS clean (no new `any`; `unknown` narrowed only
   through guards).
3. `ci:harness` — ALL PHASES PASS; PHASE G golden snapshots byte-identical
   (admission adds rejection only, never transformation — drift is a defect).

---

## 6. Regression risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Over-strict guards reject legitimate events | `tickId` optional; `rationale`/`detail` type-checked only (not non-empty); `confidence` uses the exact `CONFIDENCE_RE` the producer's `quantizeConfidence` emits; `strategyParams` checked as plain-object only (matches what persistence needs), not per-key. The producer path already passes Stage 1's stricter contextual check before publishing. |
| 2 | BullMQ backlog across deploy | Pre-Stage-3 jobs have today's shape → pass admission. An already-poisoned retrying job becomes a one-time `UnrecoverableError` failed-set entry — intended; note in rollout. |
| 3 | Redis parse-error semantics change (throwing `onError` → `onReject`+drop) | Deliberate — the old behavior is the latent crash bug. `bus.test.ts` currently exercises default-`onError` only for *handler* failures, which keep identical semantics; new tests pin the `onReject` path. |
| 4 | Bridge generics stay usable by tests (`Payload` fixtures) | `admit` optional on both generic classes; only the **decision** factories bake it in. Existing bridge tests compile and pass unchanged. |
| 5 | In-process bus / Phase 1–6 tests | Untouched — no interface change, no admission on the in-process bus (same-type, same-process trust domain). |
| 6 | Dynamic-import coupling for `UnrecoverableError` | Confined to the existing `import("bullmq")` in `buildDecisionBus`; in-process default path still never loads bullmq. |

---

## 7. Reviewer checklist (acceptance criteria mapping)

1. **How untrusted payloads enter:** §1 — two byte-level entry paths with exact
   file:line trust boundaries (`redis-bus.ts:92`, `index.ts:328`) and the sink
   that makes them dangerous (`persistence.ts:41,43`).
2. **Where validation occurs:** §4 — inside the bridge delivery path, before the
   handler loop, bound automatically in the two decision-bus factories; the single
   `unknown → DecisionEvent` conversion point is `admitDecisionEvent`.
3. **Why business logic is unchanged:** §4 (final subsection) — reject-only, no
   transformation; well-formed events pass by reference; diff confined to bridges +
   wiring; replay/golden snapshots invariant by construction.
4. **How tests prove rejection:** §5 — per-family rejection units incl. the
   `"garbage"` confidence exploit fixture, plus behavioral skip-not-halt (redis)
   and poison-pill-to-failed-set (bullmq) proofs on the existing fakes.

---

**STOP — awaiting approval. No source code has been modified.**
