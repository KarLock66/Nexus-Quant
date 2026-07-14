# Phase 12 Charter: Perimeter Hardening & Validation-Gate Restoration

Status: CHARTER — future work, awaiting Phase 12 authorization; no source code touched,
no patches, nothing committed
Date: 2026-07-13 (drafted as Stage 4 plan) · 2026-07-14 (reclassified as Phase 12 charter)
Provenance: supersedes and replaces `AI_OS/PHASE11C_STAGE4_PLAN.md`; all technical content
preserved verbatim except phase labeling and framing. Reclassification ratified per
[PHASE11C_FINAL_ACCEPTANCE.md](PHASE11C_FINAL_ACCEPTANCE.md).

**Phase status statement:**
- **Phase 11C is COMPLETE** and accepted at `713d9bf` (Stage 1 `f468b9b` + Stage 2
  `a2182f9` + Stage 3 `713d9bf`).
- Every item in this charter is **future hardening work** — perimeter tiers and validation
  infrastructure the accepted Phase 11C documents explicitly registered as out of scope.
- **None of these items are blockers for Phase 11C acceptance** (item-by-item
  classification: acceptance document §4).
- **Batch structure and ordering are unchanged** from the reviewed plan: Batch 1 first
  (hard prerequisite), Batches 2/3/4 mutually independent, Batch 5 optional and severable.

Baseline: Phase 11C COMPLETE and COMMITTED as `713d9bf` (GAP A + GAP B + GAP C + all
Stage 3 planning/audit docs; clean tree). Workers 351/351, monorepo 17/17, PHASE G 10/10
byte-identical per the accepted GAP C report.
Method: full read of the Phase 11C corpus (Stage 3 plan, Batch 1/2 plans + reports, Final
Audit, GAP C report, project-state memory incl. the Stage-2-era "stages 3+" candidate list),
followed by a 5-agent read-only verification pass against `713d9bf`: (1) ingestion REST
surface map, (2) web governance edge, (3) harness debt, (4) display-tier Json reads,
(5) an adversarial completeness sweep for boundaries the Stage 3 register missed.
Every file:line below was verified against source during that pass.

---

## 1. Executive summary

**Phase 12 is the perimeter phase.** Phase 11C closed the last unknown → trusted transition
inside the production **worker runtime** — the Final Audit's remaining-transitions table has
zero open entries there. What remains is exactly what the Phase 11C documents deliberately
deferred and registered: the **ingestion tier's REST ingress** (venue response bodies cast
unvalidated), the **web operator-console edges** (one blind body cast, one whole unvalidated
control-plane read module, an internals-leaking 500 class), and the **two broken validation
harnesses** that currently prevent the project's own full acceptance battery from running
anywhere.

Verification confirmed the register's two Medium items and surfaced **two genuinely new
findings of this charter's class** the register missed:

- **A fail-open DQ-score inflation path** (`services/ingestion/src/dq/stage-b-client.ts:78-83`
  + `dq/score.ts:13-17`): the Stage-B admission guard checks deduction is a finite *number*
  but not its **range** — a negative deduction from a hostile/buggy quant response inflates
  the score (no upper clamp) past the `PASSED ≥ 90` feature-admission gate. This is the only
  genuine fail-open found anywhere in the sweep, and per the ratified acceptance it is the
  **top-priority admission fix in this phase** (first item within Batch 2).
- **`apps/web/src/lib/control.ts`** — the entire web control-plane read layer blind-casts DB
  String/Json columns into `@nexus/control` union types with silent defaults, and it is
  **logic-bearing**, not display-only: `riskEngineActive` (`control.ts:156`) feeds
  `evaluateTradingPermission` (`:165`), which flows into the served
  TradingDecision/TradePlan context. This is the same defect class Phase 11C's GAP B sealed
  on the worker side; the register's listing of four line-level `trading-decision.ts` sites
  while omitting this whole module was an oversight, not a scoping decision. (Human-terminal:
  the worker-side enforcement path is sealed — which is why this is Phase 12 hardening, not
  an 11C blocker.)

Proposed Phase 12: **five batches** — (1) harness restoration first, because it re-arms the
full validation battery every later batch is accepted against; (2) ingestion REST + DQ-range
admission; (3) web governance edge + control-plane read admission; (4) the mechanical
`String(err)` 500-egress cleanup (~28 read routes + 2 SSE emissions); (5) an **optional**,
severable display-tier Json-read batch (Low). Everything else — including the orphaned
Stage-2-era "cryptographic journal chaining" candidate — is explicitly out of scope (§9).

No schema changes, no new dependencies, no sealed-module behavior changes, no
trading/signal/risk/portfolio algorithm changes anywhere in Phase 12.

---

## 2. Phase 12 objectives

1. **Restore the validation gates** so the project's own acceptance battery runs green
   end-to-end again: `ci:harness` HTTP phases 5/3 (blocked by the B1 auth gate since
   `3aca85b`/`7578820`) and `seal:phase97` STEP A (broken since 11B `348ef38` removed
   DEMO_MODE without updating the seal's spawn env).
2. **Seal the ingestion REST ingress**: every venue 200-body malformation becomes a typed,
   scope-fail-closed rejection instead of an untyped TypeError, a fabricated timestamp, a
   persisted `Invalid Date`, or a silent row skip.
3. **Close the DQ-score inflation fail-open** (deduction range + score clamp).
4. **Move web edge protection to the edge**: eliminate the governance blind spread cast
   (protection currently lives in a different module than the cast) and admit the web
   control-plane reads against the canonical `@nexus/control` domains.
5. **Finish the 500-contract**: no `/api/v1` route or SSE stream returns `String(err)`
   internals to any client (completes what security-remediation Batch 7 did for mutating
   routes only).
6. (Optional batch) Extend the reject-only Json-read discipline to the display tier's
   remaining silent-default casts.

Throughout: the Phase 11C conventions bind — admission is **reject-only** (same-reference
return, no normalization, no repair, no silent defaults), errors are typed with a stable
`.code`, guards are duplicated per module, validation runs at the read/deserialization edge,
and consequences of rejection are decided conservatively and locally at consuming sites.

---

## 3. Relationship to Phase 11C (why this work exists, and why it is a new phase)

**Phase 11C is complete; nothing here reopens it.** The item-by-item blocker analysis is in
[PHASE11C_FINAL_ACCEPTANCE.md](PHASE11C_FINAL_ACCEPTANCE.md) §4-§7. This charter exists
because the closed phase's documents deliberately parked real work:

1. **Phase 11C closed the worker; it explicitly parked the perimeter.** The Final Audit's §6
   register ("Explicitly not Stage 3") names ingestion REST casts (Medium), the web
   governance body cast (Medium), web display-tier Json reads (Low), and the two harness-debt
   items as the remaining work. Phase 12 is the planned consumption of that register.
2. **The harness debt actively degrades every future phase's acceptance.** HTTP phases 5/3
   (pagination + SSE contracts) have been unrunnable *anywhere* since the B1 gate landed —
   three consecutive Phase 11C Stage 3 batches had to carry "pre-existing failure, verified
   by control run" caveats. `seal:phase97` STEP A has been red since `348ef38` for the same
   class of reason (seal spawn env never updated for the zero-synthetic runtime). Restoring
   these gates first makes every later batch — and every later phase — acceptable against a
   fully green battery.
3. **The perimeter feeds the sealed core.** Ingestion REST bodies become MarketCandle → DQ →
   FeatureSnapshot rows — the highest-value data path in the system; the DQ score *is* the
   admission gate the sealed worker trusts (`bridge.ts:77`, `MIN_DATA_QUALITY_SCORE`). A
   score inflated past 90 by an unvalidated negative deduction defeats the Phase 11C seals
   from upstream, without ever touching a sealed boundary.
4. **Verification showed the web tier holds logic-bearing casts, not just display reads**:
   `control.ts:156,165` derives the operator-facing trading-permission verdict from
   unvalidated DB reads — the exact GAP B defect class, one tier over (human-terminal, so
   hardening rather than a phase blocker).

---

## 4. Exact implementation scope

### Batch 1 — Validation-harness restoration (harness code only, zero production files)

**1a. `ci:harness` HTTP phases 5/3 — authenticated bootstrap.**
Current failure: `run-all.ts:62` boots the web tier with empty `extraEnv`; the readiness
probe (`run-all.ts:64-82`) polls **unauthenticated** `GET /api/v1/signals?limit=1`; since B1,
`middleware.ts:49-64` 401s every sessionless `/api/v1/*` request (login/logout excepted,
`middleware.ts:31`), so the probe times out at 90 s before phases 5/3 ever run.
Fix (self-provisioned, no committed secrets, exercises the real B1 gate rather than
bypassing it):

- `run-all.ts`: generate per-run credentials (`node:crypto` randomUUID → operator token +
  `NEXTAUTH_SECRET`); pass `OPERATORS: "ci-harness:<token>"` + `NEXTAUTH_SECRET` via
  `startWebServer` extraEnv (env is read per-request server-side — `session.ts:34-36`,
  `operator-registry.ts:31` — so `next start` needs no rebuild); replace the probe with:
  poll `POST /api/v1/auth/login` `{token}` until 200 (keep the existing `web.hasExited()`
  fail-fast), extract the `nexus_session` cookie from Set-Cookie, confirm authenticated
  `GET /api/v1/signals?limit=1` → 200, then pass the Cookie header to `runPhase5`/`runPhase3`.
  **Reject-only: no fallback to unauthenticated probing** — persistent 401/503 fails the run.
- `lib.ts`: `getJson` gains optional `headers?` (~3 lines); `collectSse` opts gain optional
  `headers?` merged at `lib.ts:220-221` (~2 lines); new `loginOperator(baseUrl, token)`
  helper (~20 lines) — non-200 → null (callers poll); 200 with missing/malformed Set-Cookie
  → `HarnessError`, never a default.
- `phase5-pagination.ts` / `phase3-sse.ts`: thread the `authHeaders` parameter through
  (~8-10 lines each); **no assertion changes** — the phases' 200/envelope checks remain the
  admission boundary.

Rate-limit safety (verified): `checkLoginAllowed` runs before body parse but only 401 token
mismatches increment buckets (`recordLoginFailure` only at login `route.ts:87`); success
clears the per-client bucket (`route.ts:99`); connection-refused during boot throws before
HTTP and counts nothing. Session TTL 12 h ≫ harness runtime.

**1b. `seal:phase97` STEP A (and STEP I) spawn env.**
Root cause (verified via git provenance): the seal was created in `739818b` with this exact
env and passed because `spawnWorker` then injected `DEMO_MODE:'true'`; 11B `348ef38` deleted
DEMO_MODE and the demo provider without updating the seal env. Causal chain at HEAD:
no `MARKET_DATA_SOURCE` → `buildMarketDataProvider()` returns undefined (`index.ts:218-226`,
only `"realtime"` accepted) → config guard `index.ts:426-433` unarms execution →
`buildRiskGate` never runs → `risk.disabled` protection (CRITICAL) → worker holds PROTECTED,
never HEALTHY → STEP A 60 s timeout.
Fix: add `MARKET_DATA_SOURCE: "realtime"` to the STEP A spawn env (`seal-phase97-control.ts:175-178`)
and, for consistency, the STEP I spawn (`:316-319`, which today passes only because kill
dominates state derivation — an "unarmed but green" restart drill). **2 lines, 1 file.**
Zero-synthetic tension: none — `"realtime"` is the production-real source; the CI DB has no
non-DEMO venue rows, so `DbQuoteTransport` serves no mark and the spawned worker's execution
fails closed at quote time, which STEPs A/I never assert against (fill assertions B/C/G/J/K
use the in-process `fixtureQuoteProvider`). The rejected alternative (a fixture
`MARKET_DATA_SOURCE` value) would require touching production `index.ts` and violate 11B.

### Batch 2 — Ingestion REST admission + DQ-range guard

REST rejection convention (distinct from the WS per-frame drop): **typed throw that aborts
the scope/page** — callers already convert throws into scope-FAILED heartbeats
(`backfill.ts:169-308`) or warn-and-skip-cycle (`live.ts:324-335`); row-level skips may stay
skips but must be **counted + logged** (the option-chain `skipped` pattern,
`deribit.ts:878-880`). Guards run at call sites, **after** the retry loop, so a malformed 200
is a fatal typed rejection, never a retried transient. Optional but recommended: add a stable
`.code` (e.g. `MALFORMED_BODY`) to `BinanceApiError`/`DeribitApiError` to match the Phase 11C
typed-`.code` convention.

Per the ratified acceptance, the **DQ Stage-B range guard is the first item implemented in
this batch** (the sole genuine fail-open found in the completion review).

`services/ingestion/src/connectors/binance.ts` (root cast `restGet<T>` at `:288` stays
generic; per-site admission):

| Site | Gap (verified) | Fix |
|---|---|---|
| fetchCandles `:340-381` | non-array body → untyped TypeError at `:348` (rows already strongly field-guarded) | array assert → typed throw |
| fetchFundingRates `:410-433` | same at `:416` | array assert |
| fetchOpenInterest `:446-472` | non-array TypeError at `:455`; malformed rows **silently** skipped at `:459` (no log/counter) — live `pollFlow` surface | array assert + counted/warn-logged skips |
| fetchLongShortRatios `:483-511` | same pattern (`:490`, silent skip `:493`), ×3 endpoints | array assert + counted skips |
| fetchLiquidity `:530-571` | (a) missing/non-array `bids` → TypeError at `:535`; (b) **`:537` fabricates `Date.now()`** when the venue omits T/E — a silent wall-clock default that contradicts the module's own WS rule (`:683-687` "never fabricate") and the Deribit REST equivalent (`deribit.ts:947-962` returns null) | (a) object/array asserts; (b) **remove the `?? Date.now()`** — absent ts → warn + return null (the method's existing fail-closed contract). ⚠ Behavior change requiring approver sign-off, see §6 |

`services/ingestion/src/connectors/deribit.ts` (root envelope decode `restGet<T>` at
`:484-557`):

| Site | Gap (verified) | Fix |
|---|---|---|
| root envelope `:520-550` | `result: null` passes (`:544` checks only `undefined`) → downstream TypeErrors; non-object envelope body only accidentally fail-closed | reject `null` alongside `undefined`; assert plain-object envelope |
| fetchCandles `:599` (ts loop `:615-635`) | ts guarded only against `undefined` → non-numeric entry → **`Invalid Date` persisted** via `upsertCandles` (binance's equivalent checks `Number.isFinite`, `binance.ts:357`) — the one corrupt-persistence path found | `Number.isFinite(ts)` + non-array-ticks assert |
| fetchFundingRates `:676-702` | non-array body → TypeError at `:684` | array assert |
| fetchOpenInterest `:727-761` | none site-local once root null-fix lands (strongest site) | 0-1 lines |
| fetchOptionChain `:782-928` | non-array summaries → TypeError at `:796` | array assert |
| fetchLiquidity `:940-989` | non-array bids/asks → TypeError at `:969` (after scalar guards) | extend the existing warn+null branch with array asserts |

**DQ Stage-B range guard** (`services/ingestion/src/dq/stage-b-client.ts:74-98` +
`dq/score.ts:13-17`): require `deduction >= 0` (and `<= 100`) and, when present, `category`
∈ the `StageBFailureCategory` literals, inside `isStructuralCheck` — a failing response
routes into the **existing** fail-closed path (`parseStageBResponse` → null →
`stage_b_unavailable` INFRA deduction, `:151-155`); no new error plumbing. Plus a
defense-in-depth `Math.min(100, …)` clamp in `score.ts:17` (zero-behavior for all current
inputs; Stage-A deductions are code-pinned).

Confirmed unchanged: WS paths (I1, per-field guarded, drop-convention verified);
`features/client.ts` (typed `FeatureComputeError` decode — and its `:123` features-record
opaqueness deliberately byte-mirrors the sealed workers client, see §9).

### Batch 3 — Web edge admission (governance body + control-plane reads)

**3a. Governance register edge** (`apps/web/src/app/api/v1/governance/strategies/route.ts:36`):
today `{ ...(body.value as unknown as RegisterStrategyInput), actor: auth.operatorId }` — a
blind double cast, fail-closed **only** because every `RegisterStrategyInput` field is
declared `unknown` and `registerStrategyVersion` (`governance-actions.ts:167-202`)
re-validates field-by-field in a different module. Recommended fix (**Option 2**): a
route-local reject-only `assertRegisterStrategyBody(body.value)` reusing Stage 1's
`api-validate` helpers (`requireStringField` with generous maxLen bounds) for the 9 string
fields plus local plain-object/array checks for `parameters`/`validRegimes`/`volatilityBounds`,
returning the same reference; downstream `governance-actions.ts` validation **stays
untouched** (defense in depth — sealed-module convention). This also closes two real
residual gaps the downstream validator does not cover: `requireText` has **no length bound**
and `parameters` is an unbounded object persisted verbatim to a Json column. Minimal
fallback (**Option 1**, if the approver prefers zero behavior deltas): replace the spread
with explicit named picks, the `approvals/[id]/route.ts:36-41` in-repo precedent (~14 lines,
zero test impact) — but it leaves the unbounded-input gaps open.
Test consequence (Option 2): `mutating-500-contract.test.ts:105-108,173-191` posts
`{ strategyName: "s1" }` with governance-actions mocked — those fixtures must become full
valid bodies; new edge-validation tests follow the existing direct-handler-invocation style.

**3b. Retire-route 500 leak** (`governance/versions/[id]/retire/route.ts:42-45`): replace
`detail: String(err)` with the existing `internalErrorResponse` (`lib/api-error.ts:26-32`,
generic message + correlationId, real error to server log) and add retire to the
mutating-500-contract CASES (it is absent today — the test header even says "five mutating
routes"). `governance/overview/route.ts:13-15` has the identical leak (+ raw
`new Date().toISOString()` instead of `canonicalTimestamp`) and rides along. (Whether
overview should also gain an in-handler `requireOperatorSession` like its three siblings is
an **auth** question, not admission — flagged for the approver separately, not scoped here.)

**3c. Web control-plane read admission** (`apps/web/src/lib/control.ts` — NEW register
entry, sweep finding): `asState()` (`:47-48`) casts any string to `RuntimeState` and passes
unknown strings through; `affectedComponents` Json casts at `:102,109,217`;
`ProtectionEvent.ruleId` casts at `:123,187` and component cast at `:273` with a
`RECOVERY_PLAN[component] ?? []` silent default at `:275`. Logic-bearing:
`riskEngineActive = !ruleIds.includes("risk.disabled")` (`:156`) →
`evaluateTradingPermission` (`:165`) → `buildControlContext` in `trading-decision.ts:76-84`
→ served TradingDecision/TradePlan. Fix: module-local reject-only guards built from the
**canonical exported tuples** `RUNTIME_STATES` / `CONTROL_COMPONENTS` / `PROTECTION_RULE_IDS`
(`packages/control/src/types.ts:21,52,152` — already imported by this module; drift-proof,
same technique as GAP B); a typed `ControlReadError` with `.code`
(`CONTROL_STATE_INVALID` / `CONTROL_COMPONENTS_INVALID` / `PROTECTION_RULE_INVALID`);
`?? "BOOTING"` kept **only** for the legitimate no-rows-yet case; unknown non-null values
reject. Same-reference returns, no filtering.

### Batch 4 — 500-egress contract completion (mechanical)

Sweep-verified class: ~26 authenticated read GET routes plus 2 SSE `stream-error` emissions
(`signals/stream/route.ts:120,133`) return `detail: String(err)` — leaking driver/Prisma
internals (connection strings, table names, paths) to the operator console. Batch 7 sealed
only the mutating routes (asserted by `mutating-500-contract.test.ts:8` — "no detail, no
String(err)"). Fix: mechanical replacement with `internalErrorResponse`; for the 6
signal-envelope routes a small `signalInternalError` helper in `lib/api-envelope.ts`
preserves the 11B envelope shape (generic message + correlationId); SSE emits a generic
detail and logs server-side. New read-route 500-contract test mirroring the mutating one.
~28 files × 2-4 lines + 1 helper (~15 lines) + 1 contract test file.

### Batch 5 (OPTIONAL — approver's decision; first to drop under scope pressure)

Display-tier Json-read admission, Low. Verified honest picture: **no corrupt Json value can
reach a displayed risk/sizing figure as a finite wrong number** (readFeature per-key
typeof+isFinite → null → UNAVAILABLE; trading-plan re-guards via finiteMeasure). The two
real residual defects: (1) corrupt `EngineSignal.strategyParams` is **silently laundered
into `DEFAULT_SIGNAL_PARAMS`** by `resolveSignalParams`
(`packages/trading-decision/src/util.ts:64-73`) — displayed explainability/vol/consensus
analytics computed off defaults with no indication; the workers' own Stage 1 rationale
(`pipeline/validate.ts:48-51`) condemns exactly this and sealed it on the worker side;
(2) a JSON-literal-null `features` on the `trading-decision.ts:148` path throws an untyped
TypeError that 500s decisions/ranking/trade-plan/readiness **for all symbols** (they funnel
through one assemble call). Scope if included: a small web-local admission module
(`admitStrategyParams` / `admitFeaturesObject`, reject-only, typed `.code`) applied at
`trading-decision.ts:127,148,206,217` — **critically, the `:217` consensus site must keep
its `features === null` → per-timeframe "no data" semantics (null pass-through); a naive
admitter there would regress graceful degradation into an endpoint 500**. Fold in the two
same-class sweep finds: `system-monitoring.ts:330-337` (`Number(c.deduction ?? 0)` silent
default on the DQ panel) and `risk-overview.ts:22-25` (`toStringArray` coercion). If this
batch is declined, these items must be **explicitly waived on the register** — decided, not
omitted. Writers of all these columns are the sealed worker/ingestion tiers behind write-path
admission; residual threat is direct DB write / migration corruption only — which is why Low
is the honest rank.

---

## 5. Files and modules expected to change

| Batch | File | Action |
|---|---|---|
| 1 | `services/workers/src/ci/run-all.ts` | credential self-provisioning, authenticated readiness probe, header threading (~20-25 lines) |
| 1 | `services/workers/src/ci/lib.ts` | `getJson`/`collectSse` optional headers; `loginOperator` helper (~25-30 lines) |
| 1 | `services/workers/src/ci/phase5-pagination.ts` | thread authHeaders (~8-10 lines) |
| 1 | `services/workers/src/ci/phase3-sse.ts` | thread authHeaders (~8-10 lines) |
| 1 | `services/workers/src/ci/seal-phase97-control.ts` | `MARKET_DATA_SOURCE: "realtime"` in STEP A + STEP I spawn envs (2 lines) |
| 2 | `services/ingestion/src/connectors/binance.ts` | array/object asserts at 5 sites; counted skips; remove `:537` `Date.now()` default; optional error `.code` (~25-35 lines) |
| 2 | `services/ingestion/src/connectors/deribit.ts` | envelope null/object fix; candle-ts finiteness; array asserts at 3 sites (~15-25 lines) |
| 2 | `services/ingestion/src/dq/stage-b-client.ts` | deduction range + category literal checks (~6-10 lines) |
| 2 | `services/ingestion/src/dq/score.ts` | `Math.min(100, …)` clamp (1 line, defense-in-depth) |
| 2 | `services/ingestion/src/connectors/binance.test.ts`, `deribit.test.ts`, `dq/dq.test.ts` | malformed-body fixtures via existing stubFetch/jsonResponse/rpcResponse (~130-230 test lines) |
| 3 | `apps/web/src/app/api/v1/governance/strategies/route.ts` | edge validator replaces blind spread cast (~30-50 lines Option 2 / ~14 Option 1) |
| 3 | `apps/web/src/app/api/v1/governance/versions/[id]/retire/route.ts` | `internalErrorResponse` (~5 lines) |
| 3 | `apps/web/src/app/api/v1/governance/overview/route.ts` | same + `canonicalTimestamp` (~5 lines) |
| 3 | `apps/web/src/lib/control.ts` | reject-only domain guards from canonical tuples + `ControlReadError` (~60-90 lines) |
| 3 | `apps/web/src/app/api/v1/mutating-500-contract.test.ts` | retire CASES entry; full-body fixtures for the new edge (~30-45 lines) |
| 3 | `apps/web/src/lib/control-contract.test.ts` (+ new edge-validation tests) | admission behavior (~80-120 lines) |
| 4 | ~26 read `route.ts` files + `signals/stream/route.ts` | `internalErrorResponse` / generic SSE detail (~80-100 lines total) |
| 4 | `apps/web/src/lib/api-envelope.ts` | `signalInternalError` helper (~15 lines) |
| 4 | new `read-500-contract.test.ts` | contract coverage (~60-120 lines) |
| 5 (opt) | `apps/web/src/lib/trading-decision.ts` + new web admission module + `system-monitoring.ts` + `risk-overview.ts` (+ tests) | reject-only Json-read guards (~200-300 lines incl. tests) |

**Not touched, any batch:** all Phase 11C sealed validators and modules
(`pipeline/validate.ts`, journal stores, `bus/*`, `control/store.ts|evaluator.ts|validate.ts`,
`governance-actions.ts`), all trading/signal/risk/portfolio/execution algorithms,
`schema.prisma`, packages (except zero-line usage of already-exported `@nexus/control`
tuples), `docker/*`. No new dependencies.

---

## 6. Risks and regression analysis

1. **Harness auth bootstrap semantics** — the probe polls only with the *correct* token
   (failures alone are rate-limited; success clears the bucket); 503/network-error during
   boot counts nothing. No fallback to unauthenticated probing (reject-only). Because the
   fix *depends on* the B1 gate working, it cannot mask it. All HTTP-phase traffic becomes
   authenticated — any future intentional unauthenticated probe must be added explicitly.
2. **Seal STEP A fix removes incidental coverage** of the "broker with no data source →
   unarmed" guard path (the guard itself is untouched production code, `index.ts:426-433`);
   if coverage is wanted, it is one table-driven unit test — noted, not scoped. **Dist
   staleness gotcha**: the seal must run after `pnpm -r build` (spawnWorker prefers
   `dist/`, `lib.ts:308-312`); a stale pre-`348ef38` dist still honors DEMO_MODE and would
   mask the fix.
3. **Binance liquidity `Date.now()` removal is a real behavior change** (the one in
   Phase 12's ingestion scope): depth snapshots without a venue ts are skipped instead of
   persisted with a fabricated clock. Venue docs say T is always present on `/fapi/v1/depth`
   → expected frequency ~0; idempotency improves (fabricated ts was non-reproducible).
   **Requires explicit approver sign-off** under the approval-first discipline.
4. **Array/object asserts convert untyped TypeErrors into typed throws** with identical
   caller handling (verified: backfill per-scope catch; pollFlow warn+skip) — blast radius
   unchanged, observability improved. Retry-loop semantics unchanged (guards after retry).
5. **DQ range guard** — quant is first-party and never emits negative deductions today, so
   zero-behavior in healthy operation; the only theoretical loss is an undocumented future
   "bonus points" semantic. `score.ts` is shared with Stage-A checks — the clamp is
   zero-behavior for code-pinned Stage-A deductions; keep it a separate reviewable hunk.
6. **Governance edge (Option 2)** — observable 400 message texts change for malformed
   bodies; new length bounds could newly 400 a legitimately enormous `entryLogic` (bounds
   must be generous); the mutating-500-contract fixtures must become full valid bodies.
   Option 1 has zero behavior change but leaves the unbounded-input gaps open.
7. **`control.ts` admission** — worker/web version skew (worker ships a new ProtectionRuleId
   or ControlComponent before the web deploys) would turn `/control` reads into 500s.
   Mitigations: guards derive from the **shared** `@nexus/control` tuples so both tiers move
   in lockstep by construction, and the skew path is tested. Legacy pre-9.7 rows should be
   checked against a dev DB before enabling. A corrupt row now renders an error state
   instead of a silently-wrong permission text — the fail-closed direction.
8. **500-egress batch** — operators lose in-browser `detail` diagnostics for read failures
   (correlationId + server log instead — the tradeoff Batch 7 already accepted for mutating
   routes). The 6 signal-envelope routes must keep the 11B envelope shape byte-exact
   (contract-tested); SSE consumers (`signal-feed.tsx`) render the generic detail unchanged.
9. **Batch 5 regression trap (if included)** — the `trading-decision.ts:217` consensus site
   currently treats `features === null` as graceful per-timeframe "no data"; admission there
   must pass null through or Phase 12 would *regress* graceful degradation into an endpoint
   500.
10. **Determinism envelope** — nothing in Phase 12 touches the inputHash/featureHash/golden
    path (Batch 1 is harness-only; Batch 2 is ingestion-side pre-DQ admission — rejection
    only, no value transformation; Batches 3-5 are web-tier). PHASE G byte-identity is
    asserted anyway in every batch's gate (§7). GAP C's precedent applies: hashes must come
    back byte-identical.

---

## 7. Test and validation strategy

Per-batch gates (the Phase 11C battery, now strengthened by Batch 1 itself):

1. **Typecheck**: `pnpm typecheck` strict clean, per affected package and repo-wide.
2. **Unit suites**: full `pnpm test` per affected package + monorepo turbo run. Workers
   **351/351 must stay green in every batch** (sealed-suite proof:
   `pipeline/validate.test.ts`, `orchestrator.test.ts`, `durability.test.ts`, `risk.test.ts`,
   `bus/admission.test.ts`, `control/validate.test.ts`); web (24 test files) and ingestion
   (6 test files) suites green with the new cases.
3. **New tests per batch** (conventions verified against existing files):
   - B1: optional colocated unit test for the Set-Cookie extraction helper
     (destructive-guard.test.ts style); the harness/seal runs are themselves the acceptance
     tests.
   - B2: additive describe-blocks in the two connector test files using the existing
     `stubFetch`/`jsonResponse`/`rpcResponse` venue-fixture helpers — non-array bodies per
     endpoint, `rpcResponse(null)`, ragged/string-ts chart ticks, missing depth T/E (asserts
     null + warn, no fabricated ts), silent-skip counters; `dq.test.ts` negative-deduction
     and >100-deduction cases extending its existing malformed-Stage-B blocks (~:404-444).
   - B3: same-reference + one-rejection-per-family tests for the governance edge validator
     and `control.ts` guards (mirroring `bus/admission.test.ts` style); mutating-500-contract
     gains retire; skew-path test for an unknown component/ruleId.
   - B4: new read-route 500-contract test asserting "no detail, no String(err)" across the
     converted routes + SSE, mirroring `mutating-500-contract.test.ts`.
   - B5 (if included): admission-module unit tests incl. the null-pass-through consensus
     semantics regression test.
4. **Live disposable-stack gates** (docker-compose.ci.yml, migrations deployed, dist rebuilt
   first):
   - `ci:harness`: after Batch 1, **ALL phases — 1, 2, 4, G, 6, 7, 8 AND HTTP 5, 3 — must
     PASS**; this becomes the standing bar for Batches 2-5. PHASE G golden snapshots
     **10/10 byte-identical** in every batch (any drift is a defect — admission adds
     rejection only).
   - `seal:phase97`: **STEPS A–K ALL PASS** after Batch 1 (first full green since 11B).
   - Batch 2 optionally exercises `ci:seal-phase9` where infrastructure allows (venue-fixture
     unit tests are the primary gate; the seal adds live-path confidence).
5. **Behavioral proofs required per batch** (accepted-report style): e.g. B2 — a non-array
   klines 200 fails the backfill candle scope with a typed error and a FAILED heartbeat while
   the next scope proceeds; a `result: null` Deribit envelope throws typed instead of
   TypeErrors at the ticker consumer; a negative Stage-B deduction yields the INFRA-deduction
   fail-closed report, never a >100 score. B3 — an out-of-domain persisted runtime state
   renders a typed error, not "HEALTHY"; a valid row round-trips same-reference.

---

## 8. Expected acceptance criteria

1. `ci:harness` passes **all** phases (1, 2, 4, G, 6, 7, 8, 5, 3) on the disposable stack —
   the first fully green harness run since the B1 auth gate landed — with PHASE G 10/10
   byte-identical.
2. `seal:phase97` STEPS A–K all pass, both spawned workers armed
   (`MARKET_DATA_SOURCE=realtime`), no production file changed by Batch 1.
3. Every malformed venue REST 200-body in the two connectors produces a **typed** rejection
   (`.code`-bearing venue error) with scope-local fail-closed handling; zero untyped
   TypeErrors from body shape; zero fabricated timestamps; zero silent row skips (all
   counted + logged); Deribit `result: null` rejected; no `Invalid Date` can reach
   `upsertCandles`.
4. A Stage-B response with any out-of-range deduction is rejected into the existing
   fail-closed INFRA-deduction path; no DQ score can exceed 100.
5. The governance register route has **no blind cast**: the request body is admitted
   field-by-field at the route edge (bounded strings, plain-object parameters), with
   downstream `governance-actions.ts` validation intact and byte-identical.
6. No `/api/v1` route (mutating or read) and no SSE frame returns `String(err)`-derived
   internals; contract tests pin both route classes.
7. `apps/web/src/lib/control.ts` admits every DB-sourced state/component/ruleId against the
   canonical `@nexus/control` domains; out-of-domain values produce a typed `ControlReadError`
   (fail-closed render), never a silent default or pass-through; valid values are returned
   same-reference.
8. All pre-existing suites green: workers 351/351 (sealed suites byte-identical behavior),
   web + ingestion + packages suites green, monorepo turbo green, repo typecheck clean.
9. Zero schema changes, zero new dependencies, zero sealed-module behavior changes, zero
   changes to trading/signal/risk/portfolio algorithms — verified by diff review per batch.
10. (If Batch 5 approved) corrupt `strategyParams` produces a typed rejection, never
    silently-defaulted analytics; the JSON-null features path yields a typed, per-symbol
    fail-closed outcome instead of an all-symbol untyped 500; consensus null-semantics
    regression test passes.

---

## 9. Explicitly out of scope for Phase 12

| Item | Why excluded |
|---|---|
| **Cryptographic journal chaining / deep-tamper detection** (the one unconsumed Stage-2-era "stages 3+" candidate) | Different threat model: Phase 11C admission proves *structure*, chaining proves *authenticity* — it cannot be delivered as a read-edge validator; it changes the on-disk journal format (migration for existing journals), touches the sealed Stage 2 stores, and needs its own design pass (key management, replay interaction). Requires an explicit go/no-go design decision in a later phase (Phase 13 or a Phase 12 appendix decision) — never silently carried. |
| Helper centralization (`isPlainObject`/`isNonEmptyString` copies) | Deliberate per-module-duplication convention; centralizing touches sealed modules for zero behavior change. Remains on the register. |
| Ingestion `features/client.ts:123` per-value feature validation | Byte-mirrors the **sealed** workers feature client (identical isRecord-only guard — the ratified Stage 1 opaque-verbatim hash discipline); touching it breaks documented lockstep. Revisit only at the planned shared-lib extraction. |
| Per-value finiteness inside `features` objects generally | Ratified design: values are opaque for hash discipline; `feature()` throws `StrategyInputError` at point of use (`replay/strategy.ts:63`). |
| Web same-origin SSE/fetch client consumers (`signal-feed.tsx`, `use-polled-resource.ts`) | Display tier consuming the platform's own authenticated API; unchanged register disposition. |
| CLI/CI harness casts beyond Batch 1's two fixes (`cli/e2e-pipeline.ts`, other `ci/*` casts) | Non-production entrypoints that fail loudly in harness; unchanged register disposition. |
| Exchange WS ingress paths | Verified guarded (per-field finite checks, drop/skip convention) — audit item I1 SAFE re-confirmed. |
| DB-enum-backed casts (`ops-alerts.ts:201` severity, `trading-decision.ts:72` RiskMode) | Prisma enum columns guarantee domain membership at the driver level — not an unknown → trusted transition. |
| `governance/overview` in-handler session guard | An authentication-policy question, not admission; flagged to the approver as a separate decision (middleware B1 already gates it). |
| Redis-Streams event store, clock-based daily-PnL reset, docs `03-api-design.md` nextCursor refresh, and all other pre-11C deferred follow-ups | Not admission/validation scope; tracked elsewhere. |
| Any change to trading, signal, risk, execution, portfolio, or hash/replay logic; any schema change; any new dependency | Standing constraint, carried forward from Phase 11C. |
| External dependencies (Deribit credentials, funded account, prod host secrets, second operator) | Unchanged; outside code scope entirely. |

---

## 10. Batch structure, boundaries, dependencies (unchanged from the reviewed plan)

```
Batch 1  Harness restoration            services/workers/src/ci only
   │       (ci:harness auth bootstrap + seal97 spawn env)
   │  restores the full acceptance battery ─ every later batch is gated on it
   ▼
Batch 2  Ingestion REST + DQ range      services/ingestion only          (independent of B3/B4)
Batch 3  Web edge admission             governance route edge + control.ts (+retire/overview 500s)
Batch 4  500-egress completion          ~28 web route files, mechanical  (independent of B2/B3)
Batch 5  Display-tier Json reads        OPTIONAL — approver's decision; severable; last
```

- **Batch 1 first** is the only hard ordering: Batches 3/4 are web-tier and their acceptance
  explicitly includes the HTTP phases the harness cannot currently run; Batch 2's acceptance
  includes the fully-green `ci:harness` bar as well.
- Batches 2, 3, 4 are mutually independent (different tiers/files, no shared modules) and can
  be approved, implemented, and reviewed in any order after Batch 1 — each with its own
  implementation plan → approval → implementation → report cycle, per the Phase 11C cadence.
- Within Batch 2, the DQ range guard is implemented first (ratified-acceptance priority).
- Batch 5 is deliberately severable: if declined, its items move to the register as
  **explicit waivers** (decided, not omitted).

**Approver decision points carried in this charter:** (a) Batch 2's `Date.now()` removal
(behavior change, §6.3); (b) Batch 3a Option 1 vs Option 2 (recommendation: Option 2);
(c) Batch 5 include/exclude (recommendation: include, first-to-drop); (d) the
cryptographic-journal-chaining go/no-go design decision (§9 — a later-phase decision, never
silently carried).

---

## 11. Provenance: adjustments to the prior Future-Hardening expectation, with evidence

This charter was originally drafted as a Phase 11C Stage 4 plan. There was no prior
PHASE11C_STAGE4 document; the de-facto prior expectation was the Stage 3 Final Audit's
Future Hardening register plus the Stage-2-era "remaining 11C candidates" list. The
completion review then determined (and the approver ratified) that none of this work blocks
Phase 11C — hence this document's reclassification as the Phase 12 charter. The drafting
pass adjusted the prior expectation in five evidence-backed ways:

1. **The register missed a logic-bearing web module.** It lists four line-level
   `trading-decision.ts` Json reads (B6, Low) but omits `apps/web/src/lib/control.ts`
   entirely — which blind-casts the same worker-persisted tables GAP B sealed, with silent
   defaults, and feeds `evaluateTradingPermission` → the served decision context
   (`control.ts:47-48,102,109,123,156,165,187,217,273-275`). Promoted into Batch 3.
2. **One genuine fail-open existed outside the register.** The audit marked
   `stage-b-client.ts` SAFE (I3) — correct for *structure*, but the guard admits any finite
   deduction: a negative value inflates the DQ score past the `PASSED ≥ 90` gate with no
   clamp (`stage-b-client.ts:78-83`, `score.ts:13-17`). Structural-vs-range is exactly the
   distinction admission exists to enforce. Promoted into Batch 2, first item.
3. **The ingestion Medium item is sharper than "casts."** Verification decomposed I2 into
   four targeted defects — Deribit `result:null` admission, a persisted-`Invalid Date`
   candle path, a fabricated `Date.now()` liquidity timestamp (the lone silent-default), and
   unlogged row skips — plus the blanket non-array TypeError class. The fixes are ~40-60
   source lines at 10 call sites, not a blanket response-schema layer; the audit's "deserves
   its own pass with venue fixtures" is confirmed — and the venue-fixture harness it called
   for **already exists** (`stubFetch`/`jsonResponse`/`rpcResponse`).
4. **The retire-route "cosmetic" finding is a ~28-site class.** Batch 7 converted only the
   five mutating routes; every read route and both SSE error frames still leak
   `String(err)`. One route fix would leave the register internally inconsistent — hence
   mechanical Batch 4.
5. **Harness debt graduated from wrap-up note to Batch 1**, on evidence that both failures
   are environmental drift with exact, tiny, production-untouching fixes (git-provenance:
   the seal passed at `739818b` only via the now-deleted DEMO_MODE injection), and that
   every Stage 3 batch paid an evidence tax (stash-control runs) for not having these gates
   green. Restoring them first makes Phase 12 the first phase since 11B accepted against a
   fully green battery.

Also dispositioned: **cryptographic journal chaining** — the only Stage-2-era candidate
Stage 3 did not consume — is *not* silently absorbed into Phase 12 (§9, rationale + explicit
escalation path), and the display-tier Lows are refined by evidence (the strategyParams
silent-default is a real convention violation; the feature-value paths already fail closed;
the consensus site's null semantics must be preserved by any future guard).

---

**STOP — charter only. Phase 11C is closed
([PHASE11C_FINAL_ACCEPTANCE.md](PHASE11C_FINAL_ACCEPTANCE.md)); no Phase 12 implementation
is authorized until this charter is reviewed and approved batch-by-batch.**
