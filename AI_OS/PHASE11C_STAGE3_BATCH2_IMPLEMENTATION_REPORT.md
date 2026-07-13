# Phase 11C — Stage 3 Batch 2 Implementation Report: Control-Plane Store Admission

Status: COMPLETE — implemented, tested, NOT committed (per instruction)
Date: 2026-07-13
Scope executed: **GAP B only** (control-plane store admission), per the approved
`AI_OS/PHASE11C_STAGE3_BATCH2_IMPLEMENTATION_PLAN.md`. GAP C (db-quote finiteness
rider) deliberately NOT touched — it remains Stage 3 wrap-up work.
Baseline: Batch 1 (GAP A) untouched; its uncommitted diff is byte-identical.

---

## 1. Trust boundary sealed

**Before:** three read functions in `control/store.ts` blind-cast Postgres values
into the fail-closed kill-switch/recovery domain. `RuntimeStateTransition.state`/
`previousState` are plain `String` columns and both `affectedComponents` columns
are unconstrained `Json` (their domains exist only as schema comments), so any
actor with DB access could inject values that:

- silently upgraded PROTECTED → HEALTHY with **zero recovery verification**
  (JSON-null `affectedComponents` on the open incident + a restarted worker →
  empty target list → `recovery = true`);
- crashed `evaluate()` untyped once per tick (`{}` spread throws TypeError),
  leaving execution riding the last ALLOWED permission for up to
  `maxPermissionAgeMs` (≥60 s) before going stale-closed;
- laundered an out-of-domain state string into fresh worker-authored rows
  (`getCurrentState` → boot `previousState` write-back);
- and were indistinguishable from legitimate absence (`?? []`, `?? "BOOTING"`).

**After:** every control-row value is `unknown` until admitted at the store read —
the single admission point per row shape, covering every consumer (evaluator,
barrel export, Phase 9.7 seal). Admission is **reject-only**: valid values are
returned as the identical references (no repair, no filtering, no coercion;
null → `[]` and no-row → `"BOOTING"` preserved verbatim). Accept-domains are
built from the canonical `RUNTIME_STATES` / `CONTROL_COMPONENTS` tuples in
`@nexus/control` — the types' single source, drift-proof. Rejection consequences
are handled conservatively and LOCALLY at the consuming sites (only
`ControlDataError`; all other errors propagate exactly as before):

| Site | Consequence on corrupt row |
|---|---|
| boot (`getCurrentState`) | logged (never silently swallowed) + same BOOTING fallback; startup validation still gates arming |
| recovery exit (`getOpenIncident`) | `recovery = false` → state stays **PROTECTED**; audit `RECOVERY_FAILED` "open incident row corrupt — recovery unverifiable (fail-closed)". The one site where corruption could previously UPGRADE state. |
| entering PROTECTED | corruption never blocks protection — a FRESH valid incident is opened (newer `startedAt`; subsequent reads see the valid row) + warn log |
| both resolution sites | resolution skipped — incident stays **OPEN** (operator-visible) + error log; the state transition itself is unaffected |

## 2. Files changed (Batch 2 delta only)

| File | Action | Content |
|---|---|---|
| `services/workers/src/control/validate.ts` | created | `ControlDataError` (`.code`: `MALFORMED_RUNTIME_STATE` \| `MALFORMED_STATE_TRANSITION` \| `MALFORMED_INCIDENT`), `assertValidRuntimeState`, `admitControlComponents`, local `isNonEmptyString` (per-module-duplication convention) |
| `services/workers/src/control/store.ts` | modified | the 4 blind casts in `getCurrentState` / `getLatestTransition` / `getOpenIncident` replaced with validator calls; nothing else (writers byte-identical) |
| `services/workers/src/control/evaluator.ts` | modified | `ControlDataError` handling at the 5 touch points (4 semantic sites) above; new private `readOpenIncidentForResolution` helper for the two resolution reads; imports `ControlDataError` |
| `services/workers/src/control/validate.test.ts` | created | 15 tests — full accept-domain enumeration + one rejection per malformation family (incl. same-reference return and no-silent-filtering proofs) |
| `services/workers/src/control/control.test.ts` | extended | 5 evaluator behavior tests (mocked store/inputs/recovery/startup, REAL pure `@nexus/control` evaluators); existing 7 gate tests untouched and passing |

Diff stat (Batch 2 files): `control.test.ts +141`, `evaluator.ts ~97 lines touched`
(includes re-indentation of the recovery block now inside the fail-closed guard),
`store.ts +31/−1`, plus the two new files.

Not touched: all Batch 1 files (bus/*, pipeline/validate.ts, index.ts,
seal-phase8-runtime.ts — diff identical to the Batch 1 report), Stage 1/2
validators, trading/strategy/execution-core logic, market (GAP C deferred), web,
schema, packages. No new dependencies. `control/index.ts` barrel NOT extended
(no consumer needs the public path — smaller diff; noted as the plan's optional
item, omitted).

## 3. Test results

All commands run 2026-07-13 from `services/workers` (or repo root where noted).

| Gate | Result |
|---|---|
| `vitest run` targeted (`control/validate.test.ts`, `control/control.test.ts`) | **27/27 PASS** (15 validator + 7 pre-existing gate + 5 new evaluator) |
| `pnpm typecheck` (tsc strict, --noEmit) | **clean** |
| `pnpm test` — full workers suite | **20 files, 347/347 PASS** (Batch 1 baseline 327 + 20 new; all sealed suites green: `pipeline/validate.test.ts`, `orchestrator.test.ts`, `durability.test.ts`, `risk.test.ts`, `bus/admission.test.ts`, `bus/bus.test.ts`) |
| `pnpm test` — monorepo (turbo, repo root) | **17/17 tasks PASS** |

New behavioral proofs (mocked store, real pure evaluators):

1. PROTECTED + protections clear + corrupt open-incident read → state stays
   **PROTECTED** (never HEALTHY), `verifyRecovery` never invoked (unverifiable,
   not "verified over a narrowed set"), `resolveIncident` never called, audit
   contains `RECOVERY_FAILED` and no `RECOVERY_VERIFIED`.
2. Entering PROTECTED with a corrupt incident read → evaluation completes,
   a fresh incident is opened and protection events attach to it (warn logged).
3. Corrupt row at the resolution read → resolution skipped (incident left OPEN,
   error logged) while the genuinely verified HEALTHY transition still happens.
4. Unreadable persisted state at boot → error logged (no silent swallow), boot
   proceeds from BOOTING with `previousState: null` — nothing corrupt written back.
5. A non-admission error (`Error("db down")`) from the same read still propagates
   out of `evaluate()` — pre-existing semantics preserved.

## 4. Validation results (live harnesses, disposable stack)

Stack: `docker-compose.ci.yml` (tmpfs Postgres 16 + Redis 7 + pinned quant),
migrations deployed clean.

| Harness | Result |
|---|---|
| `ci:harness` DB phases | **PHASE 1, 2, 4, G, 6, 7, 8 all PASS** |
| PHASE G golden snapshot | **10/10 byte-identical** (snapshotHash `624d8507…`, inputHash `2dd56a08…`, 2 signals/run) — determinism gate intact |
| `seal:phase97` (Phase 9.7 control seal, rebuilt dist) | **STEPS B–K ALL PASS**; STEP A fails on a **pre-existing harness staleness** (below) |

**Golden snapshots unchanged:** PHASE G is an intra-run gate — 10× reset→tick→
snapshot over freshly seeded fixture lineage must be byte-identical, and it is
(the absolute hash legitimately differs run-to-run with the disposable DB's new
cuids/timestamps; verified in `golden-snapshot.ts:108-129`, which asserts
intra-run identity of snapshot hash, inputHash, counts, and featureHash set).
Corroborating: a manually spawned worker on the same DB produced live ticks with
inputHash `2dd56a08…` — byte-identical to PHASE G's frozen input. The control
plane is outside the hash/replay envelope; admission adds rejection only.

**Phase 9.7 seal, steps B–K (the Batch 2-relevant surface):** the REAL control
plane with admission live in every store read passed the full lifecycle —
HEALTHY allows trading; kill → STOPPED → resume → HEALTHY; quant-dead →
PROTECTED + incident opened; DB-read failure → FAIL_CLOSED block; stale features
→ BLOCKED; PROTECTED→RECOVERING→HEALTHY with incident RESOLVED (verified);
audit/timeline persisted; kill survives a real worker restart (STEP I boots the
freshly built dist worker and reads state STOPPED **through the new admission**);
control-off tick byte-for-byte; MANUAL_RESUME closure.

### seal:phase97 STEP A — pre-existing failure, NOT Batch 2

STEP A times out waiting for the spawned worker to reach HEALTHY. Root cause
(from the worker's own log): the seal spawns the worker with
`MARKET_BROKER: "paper"` but no `MARKET_DATA_SOURCE`; the 11B-era config guard
(`index.ts:427`, committed **2026-07-04** in `739818b` — "MARKET_BROKER is set
but no market-data source is configured — execution unarmed (fail-closed)")
leaves execution unarmed → risk engine inactive → `risk.disabled` protection →
the worker correctly holds **PROTECTED**, never HEALTHY. Verified pre-existing
three ways: (1) the first seal run used the stale **2026-07-06 dist** — compiled
before Batch 1 AND Batch 2 — and failed at the identical point with B–K
identical; (2) the guard predates both batches and its file is untouched by this
diff; (3) the worker log shows `control plane: startup validated` and a clean
BOOTING→STARTING sequence — every control-store read through the new admission
succeeded (including reading the previous run's persisted HEALTHY state). The
seal's spawn env needs `MARKET_DATA_SOURCE` — same class as the harness HTTP
phases 5/3 auth-gate issue flagged in the Batch 1 report; **flagged for the
Stage 3 wrap-up, not silently absorbed into Batch 2.**

### ci:harness HTTP phases (5, 3) — unchanged pre-existing failure

Same as documented in the Batch 1 report: the unauthenticated readiness probe is
401'd by the B1 operator-session gate. Aborts after all DB phases pass; workers
control diff is not imported by the web tier.

## 5. Deviations from the approved plan

1. **None in scope or mechanism.** All files match the plan's list; the optional
   `control/index.ts` barrel export was omitted (plan explicitly allowed this;
   tests import `./validate.js` directly, diff smaller).
2. **`readOpenIncidentForResolution` helper** — the plan described identical
   inline handling at the two resolution sites; implemented as one private
   method instead of two duplicated try/catch blocks. Behavior exactly as
   planned.
3. **Workers `dist/` rebuilt** (`pnpm --filter @nexus/workers build`) so the
   Phase 9.7 seal's spawned workers run the working-tree code — a validation
   prerequisite, not a source change (dist is gitignored build output).
4. Prediction from the plan held: **no seal file needed modification** — STEP I
   passes through the new admission unchanged; STEP A's failure is stale harness
   env, documented above, file untouched.

## 6. Remaining Stage 3 work (NOT started, per instruction)

- **GAP C rider (final Stage 3 batch / wrap-up):** finite-positive guards on the
  tick/candle branches of `market/db-quote-transport.ts:117,124` (copy the `:108`
  orderbook-branch guard; tick fails → candle → `null`) + NaN/zero fall-through
  tests.
- **Flagged harness debt (outside Stage 3 plan, pre-existing):**
  1. `ci:harness` HTTP phases (5, 3) need a session bootstrap against the B1
     operator auth gate (flagged in Batch 1).
  2. `seal:phase97` STEP A needs `MARKET_DATA_SOURCE` in its worker spawn env to
     satisfy the 11B zero-synthetic config guard (flagged this batch).

---

**STOP — Batch 2 complete and validated. Working tree holds the uncommitted
Batch 1 + Batch 2 diff; no subsequent Stage 3 batch started, awaiting instruction.**
