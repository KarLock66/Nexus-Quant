# Phase 11A-2 — Execution Adapter Foundation (Paper Runtime Only)

**Package:** `@nexus/execution-adapter` · **Status:** code-complete + reviewed · **UNCOMMITTED**
**Scope guard:** infrastructure only — NO broker, NO exchange, NO real orders, NO persistence/schema change, NO worker logic, NO UI, NO runtime certification.

---

## 1. Architecture

```
TradingDecision  TradePlan  RuntimeState  KillSwitch
        │
        ▼
Execution Core (SEALED — @nexus/execution-core, unchanged)
   createExecution → ExecutionIntent → ExecutionPlan → ExecutionState (orders/fills/position/audit)
        │  (ExecutionState carried VERBATIM)
        ▼
Execution Adapter (@nexus/execution-adapter — THIS PHASE)
   • pure · deterministic · fail-closed · replay-safe · zero IO
   • translation ONLY — contains NO trading logic
        ├── PaperExecutionAdapter   (deterministic, injected-fill-only)
        ├── NullExecutionAdapter    (always fail-closed)
        └── ExecutionAdapter iface  (future Live adapter attaches here — no contract change)
        │  emits immutable AdapterEvent[]
        ▼
(Mock Execution Sink → Future Worker)   ← NOT built in this phase
```

**Hard invariants (mirrored from the sealed core, verified by review + tests):**
- **No trading logic.** direction / confidence / entry / stop / targets / R:R / readiness / sizing are read off the core `ExecutionState` and consumed **VERBATIM** — never recomputed. The position-open VWAP is delegated to the sealed core's `OPEN`.
- **Pure / deterministic.** No IO, no broker, no `Date.now`, no `Math.random`. The clock is injected on every command (`at`). Identical `(session, command)` → byte-identical result.
- **Fail-closed.** Every rejection carries an explicit `AdapterFailureReason`; nothing is silently admitted; no value is fabricated.
- **No hidden state.** All state lives in the `AdapterSession` threaded through every call. The adapter objects are stateless `const` singletons.
- **Replay-safe.** Stable sorted-key serialization, byte-identical to the core's `normalize` contract.

---

## 2. Lifecycle

The adapter translates a runtime request into one or more **sealed-core reducer commands** and emits exactly the venue-boundary events that resulted. Internal core transitions (`PLANNED` / `ARMED` / `OPENED`) cross no venue boundary and emit **no** adapter event.

| Adapter method | Core command(s) driven | Adapter event emitted |
|---|---|---|
| `submit` | `ARM` (silent) → `SUBMIT` | `SUBMITTED` |
| `submit` (kill) | `KILL` | `CANCELLED` (result `ok:false`) |
| `submit` (unhealthy) | `RUNTIME_UNHEALTHY` | `FAILED` (result `ok:false`, fatal) |
| `acknowledge` | `ACKNOWLEDGE` | `ACKNOWLEDGED` |
| `fill` (entry, partial) | `FILL` | `PARTIAL_FILL` |
| `fill` (entry, complete) | `FILL` → `OPEN` (silent) | `FILLED` |
| `fill` (protective, reduce) | `FILL` | `PARTIAL_FILL` |
| `fill` (protective, flatten) | `FILL` | `FILLED` |
| `cancel` / `cancelAll` | `CANCEL` (execution-scoped) | `CANCELLED` |
| `replace` | — (fail-closed) | none |
| `shutdown` | `CANCEL` if live | `CANCELLED` (then health→SHUTDOWN) |

Happy path (verified end-to-end): `submit → acknowledge → fill(entry) → fill(target) → fill(stop)` yields events `[SUBMITTED, ACKNOWLEDGED, FILLED, PARTIAL_FILL, FILLED]` with gap-free seq `[1,2,3,4,5]` and core status `CLOSED`.

---

## 3. File inventory

```
packages/execution-adapter/
  package.json                 workspace pkg (@nexus/execution-adapter, deps: core, trading-decision,
                               trading-plan, execution-core)
  tsconfig.json                extends config/tsconfig.base.json; excludes tests + fixtures
  src/
    index.ts                   public surface
    types.ts                   AdapterKind/HealthStatus/FailureReason/Error/Event/Session/Result/views
    runtime.ts                 RuntimeContext + fail-closed runtime/kill gate predicates
    commands.ts                AdapterCommand union (Submit/Acknowledge/Fill/Cancel/CancelAll/Replace/Shutdown)
    events.ts                  makeAdapterEvent (deterministic id) + mapCoreEventType (core→venue projection)
    serialization.ts           stableStringify / serializeSession / serializeEvents (sorted keys, replay-safe)
    validation.ts              fail-closed gates (submit/acknowledge/fill/cancel/cancelAll)
    adapter.ts                 ExecutionAdapter interface + pure helpers (fail/emit/driveSilent/driveAndEmit/
                               toResult/buildStatusView/buildHealth)
    paper.ts                   PaperExecutionAdapter (deterministic, injected-fill-only)
    null.ts                    NullExecutionAdapter (always fail-closed)
    factory.ts                 createAdapter (opt-in/default-off) + createSession / createEmptySession
    test-fixtures.ts           deterministic fixtures over the SEALED core public API (excluded from build)
    *.test.ts                  7 suites, 109 tests
```

---

## 4. Adapter contracts

`ExecutionAdapter` (functional; every mutating method is pure, total, returns `AdapterResult`, never throws):

| Method | Signature | Contract |
|---|---|---|
| `submit` | `(session, SubmitCommand) → AdapterResult` | validate → ARM → SUBMIT; sets `submitted`; kill/unhealthy drive terminal + fail-closed |
| `acknowledge` | `(session, AcknowledgeCommand) → AdapterResult` | venue ACK (injected) |
| `fill` | `(session, FillCommand) → AdapterResult` | injected fill VERBATIM; auto-OPEN on full entry |
| `cancel` | `(session, CancelCommand) → AdapterResult` | execution-scoped cancel (see gap G1) |
| `cancelAll` | `(session, CancelAllCommand) → AdapterResult` | execution-scoped cancel |
| `replace` | `(session, ReplaceCommand) → AdapterResult` | **fail-closed** `UNSUPPORTED_OPERATION` (needs live broker) |
| `shutdown` | `(session, ShutdownCommand) → AdapterResult` | cancel-if-live then SHUTDOWN; idempotent |
| `status` | `(session) → AdapterStatusView` | pure read projection |
| `health` | `(session) → AdapterHealth` | pure read projection + `canSubmit` |

`AdapterResult = { ok, session, events, error }` — session always returned (unchanged on reject); `events` are only those emitted by this call.

**Factory (opt-in / default-off):** `createAdapter(config)` returns `PaperExecutionAdapter` **only** when `kind==="PAPER" && enabled===true`; every other configuration (empty, disabled, `LIVE`, `NULL`) falls back to the fail-closed `NullExecutionAdapter`.

---

## 5. Validation matrix

Deterministic first-failing-reason order per gate:

| Gate | Checks (in order) → reason |
|---|---|
| `validateSubmit` | shutdown→`ADAPTER_SHUTDOWN` · unbound→`NOT_BOUND` · terminal→`TERMINAL` · resubmit→`DUPLICATE_SUBMIT` · kill→`KILL_SWITCH` · unhealthy→`RUNTIME_UNHEALTHY` · no plan→`NO_PLAN` · not submittable→`plan.blockedReason` (e.g. `BLOCKED`/`MISSING_*`) · bad ids→`MISSING_ORDER_IDS` · bad stamps→`MISSING_TIMESTAMPS` |
| `validateAcknowledge` | shutdown · unbound · terminal · not submitted→`NOT_SUBMITTED` |
| `validateFill` | shutdown · unbound · terminal · not submitted · unknown order→`UNKNOWN_ORDER` · non-finite price / non-positive qty→`VALIDATION_FAILED` |
| `validateCancel` | shutdown · unbound · terminal · unknown order→`UNKNOWN_ORDER` |
| `validateCancelAll` | shutdown · unbound · terminal |
| NULL adapter (all mutating) | always→`ADAPTER_UNAVAILABLE` |
| `replace` (both adapters) | always→`ADAPTER_UNAVAILABLE` (null) / `UNSUPPORTED_OPERATION` (paper) |

Precedence corroborated by tests: kill > health; terminal/duplicate > runtime snapshot.

---

## 6. State diagram

Adapter health (session.status):
```
   PAPER: READY ──shutdown──▶ SHUTDOWN        NULL: UNAVAILABLE ──shutdown──▶ SHUTDOWN
   (DEGRADED reserved; never entered in the foundation)
```

Managed core execution (driven exclusively via the sealed reducer; adapter cannot bypass it):
```
NOT_CREATED ─PLAN→ PLANNED ─ARM→ READY ─SUBMIT→ SUBMITTED ─ACK→ ACKNOWLEDGED
                                                        │
                              ┌──── FILL(entry) ────────┤
                              ▼                         ▼
                       PARTIALLY_FILLED ───FILL──▶ FILLED ─(auto)OPEN→ OPEN
                              │                                          │
                              │                       FILL(protective)   ├─▶ REDUCING ─▶ CLOSED
                              ▼                                          ▼
      fail-closed exits from any non-terminal:  CANCELLED · FAILED · EXPIRED · REJECTED
      (KILL→CANCELLED, RUNTIME_UNHEALTHY→FAILED)
```

---

## 7. Adversarial findings (3-agent parallel review)

Dimensions covered: sealed-boundary, adapter purity, determinism, fail-closed, serialization, API contract, illegal transitions, hidden state.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| F1 | MEDIUM (confirmed by 2 agents) | `cancel(orderId)` emitted a `CANCELLED` event tagged with a single `orderId`, but the sealed core's cancel is **execution-scoped** (terminates all orders + closes position) → the event misrepresented the blast radius to audit/replay consumers. | **FIXED** — `cancel` now emits the event with `orderId=null` (honest, matches `cancelAll`) and records the caller's targeted order in the event `reason`. Test updated to assert `orderId===null` and that **all** orders reached a terminal state. `CancelCommand` doc now states the execution-scoped semantics explicitly. |
| F2 | LOW (cosmetic, not a defect) | `validateSubmit` relies on the core's `canTransition` to reject a bound-but-un-PLANNED session, surfacing a raw core `ILLEGAL_TRANSITION` rather than a bespoke adapter reason. Unreachable in normal flow (`createSession` always binds a PLANNED state); correctly fail-closed. | No change — documented as gap G2. |

No defects found on sealed-boundary, purity, determinism, serialization, or hidden-state. All adapter events are minted **only** from the actual core `result.event`; a core rejection short-circuits before any emit, so events can never contradict the true core transition. Multi-command methods (`submit`=ARM→SUBMIT, `fill`=FILL→auto-OPEN) are partial-application-safe — a failed second command discards the intermediate and returns the original session.

---

## 8. Regression evidence

All commands run on this branch after the fix.

| Package | typecheck | build | tests |
|---|---|---|---|
| `@nexus/execution-adapter` (new) | ✅ | ✅ | **109 passed** (7 files) |
| `@nexus/execution-core` (sealed) | ✅ | ✅ | 64 passed |
| `@nexus/trading-plan` | ✅ | ✅ | 44 passed |
| `@nexus/trading-decision` | ✅ | ✅ | 37 passed |
| `@nexus/portfolio-intelligence` | ✅ | ✅ | 72 passed |
| `@nexus/workers` (service) | ✅ | ✅ | — (typecheck+build only) |

Sealed core files: **unchanged** (verified). Zero regression. Adapter test breakdown: factory 12 · validation 21 · paper 32 · null 11 · events 19 · serialization 8 · determinism 6.

---

## 9. Remaining honest gaps

- **G1 — No true per-order cancel.** The sealed core exposes only execution-scoped `CANCEL`; `cancel(orderId)` therefore cancels the entire execution (event honestly tagged `orderId=null`, caller's order in the reason). Real per-order cancel awaits a broker adapter with live order handles (Phase 11B+).
- **G2 — `replace` is fail-closed.** Replacing a resting order is a live-venue capability (cancel a handle + place a new one) the sealed core does not model; both adapters reject with an explicit reason. No half-mutation possible.
- **G3 — No venue routing.** Sessions carry `mode/venue` from the core, but no order is routed anywhere; `SIMULATED` only. Fills are injected VERBATIM — the adapter never simulates market movement, never auto-profits, never fabricates a price/quantity.
- **G4 — No persistence / worker / UI.** By scope. The adapter is IO-free; a durable sink and worker integration are later phases. `RuntimeContext` is an injected snapshot — the adapter does not poll any service.
- **G5 — No live/broker adapter.** The `LIVE` kind is declared for forward-compatibility only; the factory falls back to NULL for it.

---

## 10. PASS / FAIL

**PASS** — Phase 11A-2 Execution Adapter Foundation is code-complete, reviewed, and green:

- ✅ `packages/execution-adapter` created, mirroring the sealed-package layout; all required files present.
- ✅ Pure / deterministic / fail-closed / replay-safe translation layer with **zero trading logic** and **zero broker/IO**.
- ✅ Paper (injected-fill-only, no simulation, no auto-profit) + Null (always fail-closed) adapters + opt-in/default-off factory + declared future-Live interface.
- ✅ 109 tests (target 80+) covering creation, factory, validation, both adapters, submit/cancel/cancelAll/replace, serialization, replay equivalence, determinism, purity, illegal ops, terminal rejection, duplicate commands, kill switch, runtime-unhealthy.
- ✅ Stable byte-identical serialization matching the core contract.
- ✅ Multi-agent adversarial review across all 8 dimensions; the one confirmed finding (F1) fixed and re-verified.
- ✅ Zero regression across execution-core, trading-plan, trading-decision, portfolio-intelligence, workers.

**STOP.** No runtime validation, no Docker, no UI, no worker integration, no Phase 11B, no commit. Everything remains UNCOMMITTED.
