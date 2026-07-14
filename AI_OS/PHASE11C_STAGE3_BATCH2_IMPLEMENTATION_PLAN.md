# Phase 11C — Stage 3 Batch 2 Implementation Plan: Control-Plane Store Admission (GAP B)

Status: PLANNING — awaiting approval, no source code touched
> **Historical record.** Phase 11C is COMPLETE and RATIFIED (2026-07-14, committed as `713d9bf`) — see [PHASE11C_FINAL_ACCEPTANCE.md](PHASE11C_FINAL_ACCEPTANCE.md). Future hardening: [PHASE12_CHARTER.md](PHASE12_CHARTER.md).
Date: 2026-07-13
Scope: **GAP B only** from `AI_OS/PHASE11C_STAGE3_PLAN.md` (§2).
Baseline: Batch 1 (GAP A — distributed decision-bus admission) is complete, validated, and sealed. This plan does not touch any Batch 1 file's behavior, any Stage 1/2 validator, or any file outside the list in §5.
Explicitly NOT in this batch: GAP C (db-quote finiteness rider — remains for the Stage 3 wrap-up), web auth, HTTP harness, Redis/BullMQ admission (done), UI, trading/strategy/execution-core logic.

---

## 1. The exact trust boundary being sealed

**Postgres control-plane rows → the kill-switch / recovery / state-machine domain**, crossed at exactly three read functions in `services/workers/src/control/store.ts`:

| Function | Line | Blind cast today |
|---|---|---|
| `getCurrentState` | `store.ts:62` | `row?.state as RuntimeState \| undefined ?? "BOOTING"` |
| `getLatestTransition` | `store.ts:75-78` | `row.state as RuntimeState`, `row.previousState as RuntimeState \| null`, `row.affectedComponents as ControlComponent[] \| null ?? []` (Prisma **Json** column) |
| `getOpenIncident` | `store.ts:175` | `row.affectedComponents as ControlComponent[] \| null ?? []` (Prisma **Json** column) |

The DB is a process boundary: any actor with DB access (operator tooling, a migration, another service, manual SQL, a bug in any writer) can put arbitrary values in these rows. The schema enforces **nothing** about the domains: `RuntimeStateTransition.state` / `previousState` are plain `String` columns (schema.prisma:992-993 — the eight-state domain exists only in a comment), and both `affectedComponents` columns are `Json` (schema.prisma:995, 1026) which can hold any JSON value — object, string, number, JSON null, or an array of anything.

This is the last fail-open boundary in the production worker runtime per the Stage 3 audit map (§1): every other worker ingress (pipeline rows, journals, decision bus, Deribit transport, env, probes) is now validated fail-closed.

## 2. Current data flow

**Writers (in-domain by construction):** `ControlPlane.commitTransition` → `recordTransition` and `ControlPlane.syncIncidentAndProtections` → `openIncident` write typed `RuntimeState` / `ControlComponent[]` values. Writers are not the threat; the DB's lack of domain constraints plus any out-of-band writer is.

**Readers and what the values drive:**

1. `getCurrentState` → `ControlPlane.boot` (`evaluator.ts:90`, with `.catch(() => "BOOTING")`) — the persisted state becomes `previousState` of the first boot transition, i.e. it is **written back** into a new `RuntimeStateTransition` row and its audit entry. Also read by the Phase 9.7 seal (`ci/seal-phase97-control.ts:184,308,323`) for state assertions.
2. `getOpenIncident` → four `ControlPlane` sites:
   - `evaluator.ts:149` (recovery exit): `open.affectedComponents` is unioned with `lastActiveComponents` into the recovery **targets** list; `targets.length === 0` short-circuits to `recovery = true` → `deriveRuntimeState` upgrades PROTECTED/RECOVERING → **HEALTHY without verification**.
   - `evaluator.ts:199` (entering PROTECTED): decides whether a new incident is opened.
   - `evaluator.ts:230` (reaching HEALTHY): decides incident resolution `VERIFIED`.
   - `evaluator.ts:251` (operator resume): decides incident resolution `MANUAL_RESUME`.
3. `getLatestTransition` → exported via the `control/index.ts` barrel; no production worker call site today (grep-verified: store + barrel only). Sealed anyway — it is the same boundary and the export invites future use.

## 3. Why the current boundary is unsafe

- **Silent recovery-target narrowing → unverified HEALTHY (the concrete exploit).** A corrupt `Incident.affectedComponents` of `{}` (or `"x"`, `42`, JSON null): the cast is a no-op at runtime, `?? []` only catches null/undefined, and the spread at `evaluator.ts:150` (`...(open?.affectedComponents ?? [])`) silently yields **zero elements** for any non-array iterable-by-spread-into-array-literal? No — spread of `{}` in an array literal throws TypeError; spread of a string yields characters; JSON null yields `?? []`. Concretely by shape:
  - `"database"` (string) → spreads into `["d","a","t","a",…]` — garbage strings enter `verifyRecovery`, whose `switch` has no default case, so every character produces `steps: []` → `verified: false` → recovery fails closed *by accident* of `steps.length > 0`. Survivable, but only by an unstated implementation coincidence — and each garbage "component" burns a probe round.
  - `{}` (object) → the spread **throws TypeError** inside `evaluate()`; `index.ts:512` catches and logs it; the permission snapshot silently ages out and execution goes stale-closed only after `maxPermissionAgeMs` (≥60 s of riding the previous ALLOWED verdict). An untyped crash-per-tick is the backstop — not admission.
  - After a worker **restart** in PROTECTED (`lastActiveComponents` reset to `[]`), a corrupt incident whose components read as empty (JSON null → `?? []`) makes `targets = []` → `recovery = true` → **PROTECTED upgrades to HEALTHY with zero verification**. This is the state-upgrade path the Stage 3 plan flags: corruption in the one subsystem whose whole contract is fail-closed can *loosen* protection.
- **Out-of-domain state strings launder themselves.** `getCurrentState` returning `"HACKED"` flows into `boot`'s `commitTransition("BOOTING", persisted, …)` — the bogus value is re-persisted as a fresh, worker-authored `previousState` and audit `metadata.from`, corrupting the transition ledger with the worker's own signature. The seal's state assertions also compare against it blind.
- **Masking defaults.** `?? "BOOTING"` and `?? []` conflate "no row / legitimate null" with "malformed row" — corruption is indistinguishable from first boot, so it can never be surfaced.
- **The only current backstop is indirect and slow**: a downstream throw makes `evaluate()` reject wholesale (caught at `index.ts:510-512`), and the execution gate fails closed *only after* the permission snapshot exceeds `maxPermissionAgeMs`. During the window, the gate honors the last pre-corruption verdict; and non-throwing corruption (the narrowing cases above) is never caught at all.

## 4. Minimal implementation strategy

Same shape as Stage 1/2 and Batch 1: **one admission module per boundary, reject-only validators, conservative local handling at the consuming call sites.** Every value read from a control row is `unknown` until admitted; nothing is repaired, filtered, or coerced.

### 4.1 New module: `services/workers/src/control/validate.ts`

- `ControlDataError extends Error` with `readonly code: "MALFORMED_RUNTIME_STATE" | "MALFORMED_STATE_TRANSITION" | "MALFORMED_INCIDENT"` (mirrors `PipelineDataError` / `BusAdmissionError` — name + stable machine code).
- Runtime sets built from the **canonical tuples** `RUNTIME_STATES` and `CONTROL_COMPONENTS` in `packages/control/src/types.ts:21,52` — the tuples are the types' single source, so the validators cannot drift from the type domain (same technique as Batch 1's `SIGNAL_DECISIONS` reuse).
- `assertValidRuntimeState(v: unknown, ctx: string, code: ControlDataCode): asserts v is RuntimeState` — non-empty string ∈ RUNTIME_STATES, else throw with `ctx` in the message.
- `admitControlComponents(v: unknown, ctx: string, code: ControlDataCode): ControlComponent[]` — `null`/`undefined` → `[]` (**preserves the current `?? []` contract exactly**: absence remains legitimate); otherwise must be an array and **every** element must be a known component string; one bad element rejects the whole value (**no silent filtering**); a valid array is returned as the same reference, unmodified.
- Local `isNonEmptyString` duplicate, per the deliberate Stage 1/2/Batch 1 per-module-duplication convention (no sealed module is touched for a helper).

Admission is **reject-only**: for every well-formed row the returned values are the identical references/strings the blind casts produce today.

### 4.2 `services/workers/src/control/store.ts` — replace the four casts

- `getCurrentState`: no row → `"BOOTING"` (unchanged — absence is first boot, not corruption); row present → `assertValidRuntimeState(row.state, "RuntimeStateTransition.state", "MALFORMED_RUNTIME_STATE")`.
- `getLatestTransition`: assert `state`; `previousState` — `null` passes, otherwise assert; `affectedComponents` via `admitControlComponents` (all with code `MALFORMED_STATE_TRANSITION`).
- `getOpenIncident`: `affectedComponents` via `admitControlComponents` (code `MALFORMED_INCIDENT`).
- No other store function changes. Writers (`recordTransition`, `openIncident`, …) already take typed parameters and stay byte-identical.

### 4.3 `services/workers/src/control/evaluator.ts` — conservative, LOCAL handling (per Stage 3 plan §3)

Only `ControlDataError` is handled specially; any other error (DB outage etc.) propagates exactly as today. Five touch points, four semantic sites:

| Site | Today | After |
|---|---|---|
| `boot`, :90 | `.catch(() => "BOOTING")` swallows everything silently | catch → `log("error", "persisted runtime state unreadable — falling back to BOOTING", {error})`, same `"BOOTING"` fallback. Conservative: boot still runs full startup validation; the fallback can never arm anything by itself. Corruption becomes visible instead of silent. |
| recovery exit, :149 | corrupt row throws untyped out of `evaluate()` or silently narrows targets | catch `ControlDataError` → `recovery = false` (state stays **PROTECTED** via `deriveRuntimeState`), audit `RECOVERY_FAILED` / "open incident row corrupt — recovery unverifiable (fail-closed)". The one site where corruption could previously *upgrade* state now fails closed locally. |
| entering PROTECTED, :199 | corrupt row throws untyped, blocking incident bookkeeping | catch `ControlDataError` → treat as "no readable open incident" → **open a fresh valid incident** + `log("warn", …)`. Corruption never blocks protection; the fresh row is newer, so subsequent `getOpenIncident` (ordered `startedAt desc`) reads the valid one. |
| resolution, :230 and :251 | corrupt row throws untyped, aborting the tick's persistence mid-sequence | catch `ControlDataError` → **skip resolution, incident stays OPEN** (operator-visible) + `log("error", …)`. The state transition itself already happened and is untouched. |

Note on :149 cadence: while a corrupt incident row persists, each tick in PROTECTED with clear protections re-attempts and re-audits `RECOVERY_FAILED` — identical cadence to today's behavior for a genuinely failing recovery probe; visible pressure on the operator is the intent.

### 4.4 Single-admission-point rationale

All three reads flow through `store.ts` — validation there covers **every** consumer (evaluator, barrel export, the Phase 9.7 seal) with one admission point per row shape, before any value reaches the domain. Call sites do not re-validate; they only decide the conservative *consequence* of a rejection, which is irreducibly per-site (recovery vs. bookkeeping vs. boot) — exactly the Stage 2 pattern (validators in the store/journal layer, fail-closed consequences at the consumer).

## 5. Files to modify

| File | Action | Content |
|---|---|---|
| `services/workers/src/control/validate.ts` | **create** | `ControlDataError` (+ code union), `assertValidRuntimeState`, `admitControlComponents`, local guard |
| `services/workers/src/control/store.ts` | modify | replace the 4 casts in `getCurrentState` / `getLatestTransition` / `getOpenIncident`; nothing else |
| `services/workers/src/control/evaluator.ts` | modify | `ControlDataError` handling at the 5 touch points above; import of the error class |
| `services/workers/src/control/validate.test.ts` | **create** | validator unit tests |
| `services/workers/src/control/control.test.ts` | extend | evaluator fail-closed behavior tests (mocked store/inputs/recovery — no live DB) |

Optionally `control/index.ts` barrel-exports `validate.js` for symmetry with `bus/index.ts` — only if the tests want the public path; otherwise omitted (smaller diff).

No schema changes, no package changes, no web changes, no new dependencies, no Batch 1 / Stage 1 / Stage 2 file touched.

## 6. Validation strategy

**Unit — `control/validate.test.ts`** (mirrors Stage 1 `validate.test.ts` style: happy paths + one rejection per family, asserting error class, `code`, and a message fragment):
- `assertValidRuntimeState`: all 8 `RUNTIME_STATES` pass; `"HACKED"`, `""`, `42`, `null`, `undefined` throw with the given code and ctx in the message.
- `admitControlComponents`: `null` → `[]`; `[]` → same reference; all 7 known components → same reference, unmodified; one unknown element among valid ones → throws (proves no silent filtering); non-array (`{}`, `"database"`, `1`) → throws; array with non-string element → throws.

**Behavior — `control/control.test.ts` extension** (vitest `vi.mock` of `./store.js`, `./inputs.js`, `./recovery.js` — the existing gate tests in the file are untouched):
1. **Fail-closed recovery verification (the required proof):** drive `ControlPlane.evaluate()` into PROTECTED (mocked inputs with a failing component), then evaluate again with all-healthy inputs but `getOpenIncident` rejecting with `ControlDataError` → resulting state is **not HEALTHY** (stays PROTECTED), `resolveIncident` never called, `appendAudit` received a `RECOVERY_FAILED` entry.
2. **Protection never blocked:** entering PROTECTED with `getOpenIncident` throwing `ControlDataError` → `openIncident` is still called (fresh incident) and protection events are still upserted.
3. **Resolution skipped, incident visible:** reaching HEALTHY-from-RECOVERING with a corrupt incident read → `resolveIncident` not called, evaluation completes without throwing.
4. **Boot fallback logs:** `getCurrentState` rejecting with `ControlDataError` → boot proceeds from BOOTING and the injected `log` received an error entry (no silent swallow).
5. **Non-`ControlDataError` unchanged:** a plain `Error` from `getOpenIncident` at the recovery site still propagates out of `evaluate()` (today's semantics preserved).

**Regression gates** (same battery as Batch 1):
- `pnpm typecheck` (strict, --noEmit) clean.
- Full workers suite `pnpm test` — all 327+ tests green, including the Stage 1/2/Batch 1 seal suites (`pipeline/validate.test.ts`, `orchestrator.test.ts`, `durability.test.ts`, `risk.test.ts`, `bus/admission.test.ts`, `bus/bus.test.ts`) proving sealed batches untouched.
- Monorepo `pnpm test` (turbo) green.
- `ci:harness` on the disposable stack: all DB phases incl. **PHASE G golden snapshots byte-identical** — admission adds rejection only, no transformation, so any snapshot drift is a defect. (HTTP phases 5/3 remain broken by the pre-existing B1 auth-gate issue documented in the Batch 1 report — out of scope, verified pre-existing by control run there.)
- Phase 9.7 seal expectation: `seal-phase97-control.ts` reads `getCurrentState` over rows written by `recordTransition` (always in-domain) — passes unchanged; **no seal file modification is expected in this batch** (unlike Batch 1's probe fix).

## 7. Regression risks

1. **Legacy/existing control rows** — every writer (worker `recordTransition`/`openIncident`, and they are the only writers of these columns) produces in-domain values, so real rows pass. A genuinely corrupt historical row now surfaces as PROTECTED-hold / OPEN-incident / logged boot fallback — visible and conservative instead of silent. Intended.
2. **`boot` catch broadening** — the existing `.catch` already swallowed *all* errors; the change only adds logging for them and keeps the identical `"BOOTING"` fallback. No semantic change for DB-outage boots.
3. **Audit-entry cadence** — a persistently corrupt incident row yields one `RECOVERY_FAILED` audit per tick while in PROTECTED-with-clear-protections; same cadence as today's genuine recovery failures (bounded, operator-visible).
4. **Fresh-incident-alongside-corrupt-incident** (site :199) — two OPEN rows can coexist; `getOpenIncident` orders `startedAt desc`, so all subsequent reads see the fresh valid row. The corrupt one remains for forensics until manually fixed. Acceptable; noted for the operator runbook.
5. **Web tier display divergence** — apps/web reads the same tables raw for display; a corrupt row could render oddly there while the worker fails closed. Explicitly deferred by the Stage 3 plan (display tier, Future Hardening).
6. **`getLatestTransition` consumers** — none in production worker code (grep-verified); validation there is future-proofing with zero live-path risk.
7. **Test mocking of `./store.js`** — new `vi.mock`-based evaluator tests live alongside the existing dependency-injected gate tests in the same file; the mock is scoped so the gate tests (which import only `./gate.js`) are unaffected.

## 8. Why business logic remains unchanged (byte-identical valid-path behavior)

- **Reject-only admission**: for every in-domain row, `assertValidRuntimeState` returns void and `admitControlComponents` returns the same array reference — the store functions return values **identical** to today's casts. No defaults change (`"BOOTING"` on no-row, `[]` on null are preserved verbatim), no normalization, no coercion, no reordering.
- **Evaluator control flow is untouched unless `ControlDataError` is thrown** — which, by construction, only happens on rows that today would either crash `evaluate()` untyped or silently corrupt the domain. The pure `@nexus/control` evaluators, `deriveRuntimeState`, permission logic, gate, probes, recovery probes: zero changes.
- **Deterministic replay / featureHash / inputHash**: the control plane is outside the deterministic pipeline entirely — it neither feeds the inputHash/featureHash envelopes nor the signal path. PHASE G byte-identity is asserted in the gate anyway.
- **Execution semantics**: the execution control gate (`gate.ts`) and its fail-closed stale-snapshot behavior are untouched; valid evaluations produce identical permissions at identical times.
- **Event identities**: transitions, incidents, protection events, and audit entries for valid inputs are created with the same data at the same points in the same order; the only new writes (fresh incident at :199, RECOVERY_FAILED audit at :149, boot error log) occur exclusively on corrupt-row paths that previously crashed or corrupted silently.

## 9. Reviewer acceptance mapping

1. **Where is the remaining trust boundary?** Postgres → worker control domain at `store.ts:62,75-78,175` (§1) — the last fail-open ingress on the Stage 3 audit map.
2. **Why is it unsafe today?** Unconstrained String/Json columns cross into the fail-closed kill-switch/recovery domain via blind casts; concrete paths: unverified PROTECTED→HEALTHY upgrade after restart, per-tick untyped crash with a ≥60 s stale-ALLOWED window, ledger self-laundering of bogus states (§3).
3. **Why is the proposed admission point sufficient?** All consumers read through the three store functions; validating there covers every path with one admission point per row shape, before any domain use; call sites add only the rejection *consequence*, which is irreducibly local (§4.4).
4. **Why does valid runtime behavior stay byte-identical?** Reject-only validators returning identical references; all defaults preserved; no change reachable without a `ControlDataError`; control plane is outside the hash/replay envelope; PHASE G asserts byte-identity (§8).
5. **How do tests prove the boundary is sealed?** Unit tests enumerate the full accept-domain and one rejection per malformation family (incl. no-silent-filtering); behavior tests prove the four conservative consequences — cannot-reach-HEALTHY on corrupt incident, protection-never-blocked, resolution-skipped-visible, boot-fallback-logged — plus non-`ControlDataError` passthrough; the regression battery (full suites + PHASE G byte-identity) proves nothing else moved (§6).

---

**STOP — planning complete. No source code modified. Awaiting approval before implementation.**
