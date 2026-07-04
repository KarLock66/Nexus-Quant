# Phase 11A.1 — Validation Infrastructure Seal Report

**Date:** 2026-07-04 · **Branch:** `remediation/step8-featurehash-reproducibility` (UNCOMMITTED)
**Gate type:** validation-infrastructure remediation only. No production runtime behavior, domain semantics, execution semantics, architecture, or frontend was changed. The only edits are to the CI runtime-execution harness (`services/workers/src/ci/*`) and the GitHub workflow (`.github/workflows/ci-runtime-harness.yml`).
**Predecessor:** Phase 11A was **ACCEPTED WITH CONDITIONS** (`AI_OS/Phase11A_ACCEPTANCE_REPORT.md`, §16). This seal closes the one engineering condition that gate raised — **F1**, the composed CI harness could not go green on a fresh database — and re-runs every re-runnable acceptance gate to confirm nothing regressed.

---

## 1. Executive Summary

The single remaining **engineering** blocker to sealing Phase 11A was **F1**: the composed runtime harness (`pnpm --filter @nexus/workers ci:harness`) had mutually incompatible phase preconditions and an implicit ambient dependency, so the off-machine GitHub job could not pass as written. Three concrete defects, all in validation infrastructure:

1. **Implicit `DEMO_MODE` dependency (observed "considered 0").** Phases 1/4/6/7/8 call `runSignalPipelineTick` **in-process**. That function derives its demo-lineage bootstrap from `process.env.DEMO_MODE`. The workflow never exported it, so on a bare runner the tick resolved the *production* lineage, filtered out the DEMO snapshots, and considered 0 — failing Phase 1's `considered === 2` and starving Phases 4/6/7/8 of signals.
2. **Phase 1 ↔ Phase 3 count conflict (observed "need ≥ 3 signals").** Phase 3 (SSE) requires ≥ 3 signals to exercise a mid-stream reconnect cutoff, but it borrowed whatever rows earlier phases left behind. Phase 1 leaves exactly **2** demo rows; Phase 5 deletes its own fixtures **before** Phase 3 runs. On a fresh DB the composed harness therefore reached Phase 3 with only 2 rows and failed.
3. **Fixture ownership was implicit.** Phase 3 owned no setup/teardown of its own, so its success depended on the order and leftovers of other phases.

**Fixes (validation-infra only):**

- Phases 1/4/6/7/8 now pass `demoBootstrap: true` **explicitly** to every in-process `runSignalPipelineTick` call — the phases own their fixture semantics and are independent of ambient env.
- Phase 3 now **seeds its own deterministic frozen block** of 6 signals under a dedicated `SSE-TEST` symbol and removes them in a `finally` block — it owns its setup/teardown and is order-independent.
- The workflow's harness step now exports `DEMO_MODE=true` (belt-and-suspenders + parity with the SIGKILL-restart worker, which already forces it; the web read model ignores it).

**Result:** the composed harness now passes **all 8 phases end-to-end on a fresh database**, and passes **again on the same non-fresh database** (repeatability). Whole-repo TypeScript (13/13), ESLint, the touched test package (workers 230/230), the whole-repo production build, and the five committed migrations onto a fresh TimescaleDB all re-verified green this session.

**No production code was touched. F1 is RESOLVED.** The two non-engineering conditions from Phase 11A remain and are, by nature, not closable here: **commit the branch** (human-triggered repo convention) and the **external prerequisites** for live capital (venue credentials, funded account, host secrets, second operator).

---

## 2. Validation Infrastructure Changes

All changes are confined to `services/workers/src/ci/*` and one workflow file.

| File | Change | Why |
|---|---|---|
| `ci/phase1-pipeline.ts` | `runSignalPipelineTick(…, demoBootstrap: true)` on the concurrent-tick call | Env-independent demo lineage; kills "considered 0" |
| `ci/phase4-replay.ts` | `demoBootstrap: true` on both in-process ticks (`phase4-a`, `phase4-b`) | Same |
| `ci/phase6-market.ts` | `demoBootstrap: true` on `phase6-a/-b/-c` | Same — else no fills/positions |
| `ci/phase7-durability.ts` | `demoBootstrap: true` on `phase7-a/-b/-c` | Same — else no journal records |
| `ci/phase8-risk.ts` | `demoBootstrap: true` on `phase8-a/-b/-c` | Same — else no risk-gated fills |
| `ci/phase3-sse.ts` | Seeds 6 deterministic `SSE-TEST` signals + snapshots up front; validates against the frozen set; **removes them in `finally`** | Phase owns its fixtures; guarantees ≥ 3 signals regardless of what other phases leave; order-independent |
| `.github/workflows/ci-runtime-harness.yml` | `env: DEMO_MODE: "true"` on the "Run CI Runtime Execution Harness" step | Documented Phase 11A condition; parity with `spawnWorker` (which hard-codes it); harmless to HTTP phases (read model ignores it) |

**Design principles honored:** each phase now declares its fixture requirement explicitly (no ambient env), owns its teardown (Phase 3 mirrors Phase 5's `finally`-cleanup pattern), and cannot be broken by another phase's leftovers or cleanup. No assertion was weakened — Phase 1 still asserts the exact 2-row no-duplicate invariant; Phase 3 still asserts exact backlog order, no-dup, and strict Last-Event-ID resume.

**Explicitly NOT changed:** `orchestrator.ts` and every production package are byte-for-byte unchanged. `demoBootstrap` is a pre-existing opt-in parameter on `PipelineDeps`; passing it from the harness changes no production default (`demoBootstrap` still falls back to `DEMO_MODE` when unset, which is off in production).

---

## 3. CI Harness Verification

Run against **ephemeral real infrastructure** brought up this session via `docker/docker-compose.ci.yml` (TimescaleDB `latest-pg16` + Redis 7, both health-gated), migrations applied with `@nexus/db migrate:deploy`, worker built to `dist/`, web served with `next start` on port 3200.

**Run 1 — FRESH database (migrate:deploy onto an empty TimescaleDB):** `ALL PHASES PASS`.

| Phase | Result | Key evidence |
|---|---|---|
| 1 pipeline / no-dup | ✅ PASS | 120 concurrent generations collapsed to **2** rows (`considered === 2`) |
| 2 SIGKILL restart | ✅ PASS | identical row ids before/after crash (idempotent upsert) |
| 4 replay determinism | ✅ PASS | pure engine + persistence + replay all deterministic |
| 6 market integration | ✅ PASS | 2 orders / 2 fills / 2 symbols; account arithmetic exact; reconciliation fail-closed |
| 7 durability/recovery | ✅ PASS | 2 journal records replayed; restart rebuild == live; tamper halts |
| 8 risk + kill switch | ✅ PASS | 2 filled + 2 RISK_CHECK_PASSED; tight limit blocks all; kill switch persists + recovers |
| 5 pagination (HTTP) | ✅ PASS | 27 rows / 3 pages; cursor == single-query == offset; fixtures removed in cleanup |
| 3 SSE (HTTP) | ✅ PASS | backlog **8** delivered (6 seeded + 2 demo), reconnect resumed exactly 1, no dup/no gap; SSE-TEST fixtures removed in cleanup |

**Run 2 — SAME non-fresh database (no wipe, immediately after Run 1):** `ALL PHASES PASS` again — Phase 1 still collapses to 2 rows (no "considered 4" drift), Phase 3 backlog still 8. This is the direct proof that the composed harness is now re-runnable and does not depend on a pristine wipe or on another phase's leftovers.

---

## 4. GitHub Workflow Verification

Audit of `.github/workflows/ci-runtime-harness.yml` (job `runtime-harness`), item by item:

| Aspect | Finding |
|---|---|
| **Environment variables** | `DATABASE_URL`, `REDIS_URL`, `NEXT_TELEMETRY_DISABLED`, `HARNESS_WEB_PORT=3000` at job level; **`DEMO_MODE=true` added** at the harness step. All values are self-contained (service-container credentials), no host secrets required. |
| **DEMO_MODE handling** | Now explicit at the harness step **and** each in-process phase passes `demoBootstrap: true` directly — dual-guarded. The spawned worker (Phase 2) already forces `DEMO_MODE=true` in `spawnWorker`. |
| **Secrets** | The runtime-harness job needs **none** — Postgres/Redis run as GH `services` with a fixed dev password. (The gated `phase9-seal` job is `workflow_dispatch`-only and builds the quant image; unaffected by this seal.) |
| **Startup ordering** | GH `services` are health-gated (`pg_isready`, `redis-cli ping`) before any step runs. Steps ordered: checkout → pnpm setup → node+pnpm cache → install → prisma generate → build all → **migrate:deploy → harness**. Correct: schema exists before the harness reads/writes. |
| **Migration ordering** | `migrate:deploy` runs after the build and before the harness. Verified this session: 5 migrations apply cleanly to a fresh TimescaleDB. |
| **Health gates** | `--health-interval 3s --health-retries 20` on both services (≈60 s budget). Adequate for cold image pulls on a fresh runner. |
| **Retries** | Service health retries as above. The harness itself uses **condition-based `waitFor`** (bounded polling of observable state), not fixed sleeps, so it is resilient to normal boot-time variance without arbitrary retries. |
| **Artifacts** | None uploaded. The harness streams structured JSON logs to stdout (captured by GH) and, on HTTP-phase failure, dumps the last 20 web-server lines. Sufficient for diagnosis; a formal artifact upload is optional hardening (§8), not a blocker. |
| **Caching** | `actions/setup-node@v4` with `cache: pnpm`; `pnpm/action-setup@v4` with no pinned version (the `packageManager` field owns the version — see commit `22369ab`, which fixed a prior version conflict). |

**Conclusion:** with the `DEMO_MODE` export added and the phases self-owning, the workflow has no remaining implicit prerequisite. It is expected to pass on a completely fresh runner. (The GitHub run itself executes only when the workflow file is committed and pushed — see §7/§8: the file is currently untracked.)

---

## 5. Determinism Verification

| Property | Evidence |
|---|---|
| No dependence on execution order | Run 1 and Run 2 both green; Phase 3 seeds its own set rather than relying on the order of Phases 1/5. |
| No dependence on previous runs / stale DB | Run 2 passed on the un-wiped DB from Run 1 with identical assertions. Phase 1 resets its demo EngineSignal rows at start (`resetDemoEngineSignals`); Phases 3 and 5 remove their fixtures in `finally`. |
| No dependence on existing journals/snapshots | Phases 7/8 create their journals in per-run temp files; Phase 3/5 snapshots are deleted in cleanup. Demo snapshots are idempotent upserts (`ensureSignalDemoChain`). |
| No timing races | All waits are condition-based `waitFor` with bounded deadlines (no fixed sleeps); assertions rest on invariants (exact row counts, id equality), not on wall-clock timing. |
| No localhost/fixed-port assumptions baked into the phases | `HARNESS_WEB_PORT` is configurable (run this session used 3200 to avoid a host WinNAT reservation on 3000); DB/Redis URLs come from env. |
| Explicit fixture ownership + teardown | Phase 3 (new) and Phase 5 seed-then-`finally`-cleanup; teardown of one phase cannot starve or corrupt a later phase (proven by Run 2). |

---

## 6. Fresh Environment Verification

The end-to-end chain was exercised this session, in order, with **no manual intervention** between steps:

| Step | Status | Evidence |
|---|---|---|
| `git clone` | ⚠️ VERIFIED-IN-CI-CONFIG | Not re-cloned locally (worked in the existing tree); the workflow's `actions/checkout@v4` performs the clean checkout on the runner. |
| `pnpm install` | ⚠️ VERIFIED-IN-CI-CONFIG | Local run used the existing install; the workflow runs `pnpm install --frozen-lockfile` on a cold runner (lockfile consistency confirmed — see §7). |
| `docker compose` up | ✅ VERIFIED | `docker-compose.ci.yml up -d postgres redis --wait` → both **Healthy**. |
| database migration | ✅ VERIFIED | `migrate:deploy` applied all 5 migrations to the fresh TimescaleDB. |
| runtime startup | ✅ VERIFIED | Worker booted from `dist/` (SIGKILL-restart in Phase 2); web booted via `next start` and served `/api/v1/signals` 200. |
| CI (composed harness) | ✅ VERIFIED | ALL 8 PHASES PASS (Run 1 fresh; Run 2 repeat). |
| acceptance gates | ✅ VERIFIED | TypeScript 13/13 (exit 0), ESLint (exit 0), workers tests 230/230, whole-repo build green. |
| shutdown | ✅ VERIFIED | `docker compose … down -v` removed containers, network, and volumes cleanly. |

The two ⚠️ steps are executed by the workflow itself on every runner; they were not re-run from a literal fresh clone on this machine. This is the honest boundary of a local verification.

---

## 7. Release Verification

| Item | Status | Detail |
|---|---|---|
| Whole-repo TypeScript | ✅ PASS | `pnpm -r typecheck` exit 0 (all 13 projects, incl. the edited workers package) |
| ESLint | ✅ PASS | `turbo run lint` exit 0 (coverage remains `@nexus/web` only — F2, accepted debt) |
| Tests (touched package) | ✅ PASS | workers 230/230; the edited files (`ci/*`) are harness entrypoints not imported by any vitest suite, so no test surface changed. Full-suite total (853) carried forward from today's acceptance gate. |
| Production build | ✅ PASS | `pnpm -r build` exit 0 (incl. Next.js production build) |
| Migrations / schema sync | ✅ PASS | 5 migrations apply cleanly to a fresh DB; Prisma client regenerated this session |
| Generated artifacts | ✅ OK | Prisma client regenerated; build outputs are gitignored; no stale generated file required regeneration for this seal |
| Lockfile consistency | ✅ OK | `pnpm install --frozen-lockfile` is the CI install path (no drift needed for the harness/workflow edits) |
| Production compose | ✅ (carried) | Validated fail-closed in the Phase 11A gate; unchanged by this seal |
| Documentation | ✅ | This report; the Phase 11A acceptance report's condition #2 (F1) is now satisfied |
| Working tree clean | ❌ **NOT clean** | The branch is uncommitted. Note: `services/workers/src/ci/` **and** `.github/workflows/ci-runtime-harness.yml` are **untracked** (`??`) — the entire runtime harness and workflow have never been committed. This is the same repo-wide "commit the branch" condition Phase 11A flagged, not a defect introduced here. |

---

## 8. Remaining Conditions

1. **Commit the branch (human-triggered).** The whole production completion — including the CI harness and workflow edited here — lives only in the uncommitted/untracked working tree. This is the highest-leverage operational risk and the prerequisite for tagging a release. Per repo convention, committing is done on explicit request; **this seal does not commit.**
2. **External prerequisites for live capital (unchanged, not closable in code):** Deribit credentials (test then live), funded account + explicit live flip, production host secrets, second operator identity for four-eyes.
3. **F2 — ESLint coverage is web-only (accepted debt).** Only `@nexus/web` defines a lint script. Extending lint to the other 12 packages is optional hardening that would touch production packages and is explicitly out of this validation-only scope.
4. **Optional CI hardening (non-blocking):** upload harness stdout as a workflow artifact on failure; boot the full `docker-compose.prod.yml` topology once on the target host during deployment.

---

## 9. VERIFIED Items

- **F1 fully resolved** — composed harness green on a fresh DB (Run 1) and repeatable on a non-fresh DB (Run 2).
- Each in-process phase (1/4/6/7/8) is **env-independent** (explicit `demoBootstrap`).
- Phase 3 **owns its setup and teardown**; guarantees ≥ 3 signals; order-independent.
- No phase depends on another phase's leftovers or on a pristine wipe (proven by Run 2).
- All waits are condition-based; no timing races; no fixed-port assumption in the phases.
- Fresh infra: docker compose up (healthy) → migrate (5/5) → runtime → harness → down -v, no manual intervention.
- Acceptance gates re-run green: TypeScript 13/13 (exit 0), ESLint (exit 0), workers tests 230/230, whole-repo build (exit 0), migrations onto fresh TimescaleDB.
- GitHub workflow audited: env, DEMO_MODE, secrets (none needed), startup + migration ordering, health gates, retries, caching all correct; `DEMO_MODE=true` added to the harness step.
- No production runtime, domain, execution, architecture, or frontend behavior changed.

## 10. PARTIALLY VERIFIED Items

1. **`git clone` + `pnpm install --frozen-lockfile` from a literal cold checkout** — executed by the workflow on every runner, but not re-run from a fresh clone on this machine (local run used the existing install). VERIFIED at the config level.
2. **The GitHub run going green on GitHub's infrastructure** — the workflow is correct and the identical harness passed on equivalent local ephemeral infra, but the workflow file is **untracked**, so no actual GitHub Actions run has executed the fixed harness. It will run only once the file is committed and pushed.
3. **Full 853-test suite this session** — the workers package (the only one edited) was re-run green (230/230); the full 853 total is carried forward from today's acceptance gate (untouched test code).

## 11. NOT VERIFIED Items

None within the validation-infrastructure scope. Every item reached at least PARTIALLY VERIFIED. (Out-of-scope, unchanged: live venue path with real credentials, full prod-compose end-to-end boot, headless-browser DOM — all carried from Phase 11A as external/optional.)

## 12. Release Recommendation

**Recommend sealing Phase 11A and proceeding toward the release tag `v1.0.0-platform`, with one hard prerequisite: commit the branch first.**

Sequence:
1. **Commit** the working tree (the CI harness, workflow, and the whole production completion are untracked/uncommitted). A tag cannot reference uncommitted work, and a single workspace accident would destroy the platform.
2. **Push** the branch so the fixed `ci-runtime-harness.yml` executes on GitHub and the green run is recorded on real CI infrastructure.
3. **Tag** `v1.0.0-platform` on the commit once the GitHub run is green.

All of these are human-triggered actions; this seal performs none of them.

## 13. Final Phase 11A Status

The one engineering condition Phase 11A left open — **F1, the composed CI harness could not pass on a fresh database** — is **eliminated and verified end-to-end (fresh + repeat runs)**. No production code was modified. The remaining conditions are non-engineering: a human-triggered commit and the external prerequisites for live capital.

# PHASE 11A SEALED (validation infrastructure)

**subject to the human-triggered commit of the working tree**, after which the release tag **`v1.0.0-platform`** should be created.

Phase 11B is **not** begun. No architecture was improved, no feature added, no runtime optimized, no domain or execution semantics changed. Only validation defects were eliminated.

---
*Produced by the Phase 11A.1 validation-infrastructure seal, 2026-07-04. Ephemeral infrastructure (`docker-compose.ci.yml`) torn down with `down -v` after verification.*
