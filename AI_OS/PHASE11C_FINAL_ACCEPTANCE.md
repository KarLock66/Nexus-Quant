# Phase 11C — Final Acceptance: Admission Hardening COMPLETE

Status: **RATIFIED — Phase 11C is COMPLETE and ACCEPTED**
Date of decision review: 2026-07-14 · Ratified by the project approver: 2026-07-14
Baseline: `713d9bf` (clean tree) — Stage 1 `f468b9b` + Stage 2 `a2182f9` + Stage 3 `713d9bf`
Method: independent read-only completion review from first principles — re-read of the full
Phase 11C corpus, direct source verification of every candidate item at file:line, and
re-derivation of the phase objective from the accepted documents (no prior assumption
preserved merely because a Stage 4 plan existed).

---

## 1. Executive summary

**Phase 11C is COMPLETE as of commit `713d9bf`.** Every trust boundary the phase's own
approved documents placed in scope has been closed with reject-only, fail-closed admission,
and every closure was validated (workers 351/351, PHASE G 10/10 byte-identical, seal
STEPS B–K green). Not one of the fourteen items in the former Stage 4 plan is REQUIRED to
satisfy Phase 11C: twelve are security or reliability hardening of tiers the accepted
Stage 3 Final Audit explicitly classified **"OOS — out of scope for Phase 11C"**, one is
future architecture, and one is a separate auth-policy question. The former Stage 4 plan is
sound, verified work and should be executed — **as the charter of a new phase
([PHASE12_CHARTER.md](PHASE12_CHARTER.md)), not as an extension of a phase whose objectives
are met.**

The single judgment call is recorded in §7: the DQ Stage-B range fail-open (the only genuine
fail-open found anywhere in the review) sits in the ingestion tier, which the accepted audit
ruled outside 11C's perimeter — it does not reopen the phase, and it is the first admission
fix Phase 12 should ship.

## 2. Original Phase 11C objective

Phase 11C appears nowhere in the approved roadmap (`docs/architecture/` contains zero
references to Phase 11). Its charter exists operationally, in documents the human reviewed
and accepted:

- **Stage 1 scope-lock** (commit `f468b9b`): *input validation only; no
  trading/feature/signal/portfolio logic change; no new data sources or fallbacks* — web
  `/api/v1` request ingress + worker pipeline DB-row admission.
- **Stage 2** (`a2182f9`): *closes the last persisted-state ingress with unchecked casts* —
  the two JSONL journal read paths.
- **Stage 3 plan verdict** (`PHASE11C_STAGE3_PLAN.md:6`): *"Two unguarded trust boundaries
  remain in the production **worker runtime**"* — while its §2 table simultaneously ranks
  ingestion REST, the governance body cast, and display-tier reads as *"Ranked Future
  Hardening (not Stage 3)"*.
- **Final Audit classification legend** (`PHASE11C_STAGE3_FINAL_AUDIT.md:66-67`):
  **"OOS (out of scope for Phase 11C, tracked on Future Hardening)"** — the audit itself
  defines the phase perimeter, and it was accepted.
- **Phase exit condition** (`PHASE11C_STAGE3_GAPC_IMPLEMENTATION_REPORT.md:158-159`):
  *"The audit's remaining-transitions table now has zero open entries: no unknown → trusted
  conversion in the production worker runtime lacks admission."*

**Synthesized objective:** install reject-only, fail-closed admission at every
unknown → trusted transition in the **production worker runtime** and the **web request
ingress**, with zero behavior change to trading logic (VERBATIM aggregation, byte-identical
golden snapshots). The ingestion tier and web DB-read display tier were deliberately,
repeatedly, and acceptedly registered as outside the phase.

Textual ambiguity resolved: the audit's headline *"No other unknown → trusted transition
survives in the production runtime"* cannot be read repo-wide, because the same document
simultaneously parks I2/B4/B6 as OOS unknown→trusted ingresses. The internally consistent
reading — worker runtime + web request ingress — is the operative one.

## 3. Stage assessments

### Stage 1 (`f468b9b`) — meets objective for its surface

Fourteen `/api/v1` routes moved from silent coercion to malformed-input → 400
(`lib/api-validate.ts`); worker pipeline gained `assertValidStrategyVersionRow` /
`assertValidSnapshotRow` / signal-contract rejection before publish. Validated at the time
by the **full** harness — all phases including HTTP 5/3, which still ran pre-auth-gate —
plus golden 10/10. Audit inventory rows W10/W11 confirm SEALED. No residue.

### Stage 2 (`a2182f9`) — meets objective for its surface

Both JSONL journal read paths admitted structurally with consumed-fields discipline; the
concrete exploit (a tampered `TRADING_HALTED` record silently clearing a kill-switch halt on
restart) closed; corruption routes to the existing fail-closed handlers (market → UNARMED,
risk → HALTED). 293/293 including the tampered-halt regression. Audit rows W13/W14 confirm
SEALED. No residue.

### Stage 3 (`713d9bf`) — meets objective and closes the phase surface

GAP A (Redis/BullMQ decision bus — including the latent listener-crash and infinite-retry
poisoning), GAP B (all four control-store blind casts, conservative call-site handling, the
PROTECTED→HEALTHY upgrade hole closed), GAP C (DB-Decimal finiteness, tick/candle +
portfolio-ledger fold-in). Validated: 351/351, PHASE G hashes byte-identical across batches,
seal STEPS B–K with admission live, zero business-logic drift proven four independent ways
(audit §5). The trust-transitions table (Final Audit §3) has **zero open entries** in the
phase surface.

**Every boundary the phase's planning documents ever marked ⚠/◐ is now ✅:** the Stage 3
plan's boundary-map ⚠ items (redis-bus, bullmq, control rows) and ◐ item (tick/candle
Decimals) are all sealed. Of the Stage-2-era "stages 3+" candidate list, three of four were
consumed (bus, control-plane, db-quote); the fourth (journal chaining) was never adopted
into any approved stage plan — a candidate, not a commitment (§4 item 13).

## 4. Former-Stage-4 item-by-item classification

Classification scale: REQUIRED to satisfy Phase 11C · Security hardening · Reliability
hardening · Future architecture · Nice-to-have · Out of scope. **No item classifies as
REQUIRED.**

| # | Item (charter batch) | Classification | Evidence |
|---|---|---|---|
| 1 | `ci:harness` HTTP 5/3 auth bootstrap (B1a) | **Reliability hardening** | Harness-only code (`services/workers/src/ci/`); broken by security-remediation commits `3aca85b`/`7578820`, not by 11C; audit §4.3: *"Neither is a trust boundary; both are validation-harness scope."* |
| 2 | `seal:phase97` STEP A/I spawn env (B1b) | **Reliability hardening** | Broke at 11B `348ef38` (DEMO_MODE deletion); 2-line env fix in `ci/seal-phase97-control.ts`; zero production files. |
| 3 | Binance REST array/object asserts + counted skips (B2) | **Security hardening** | Audit I2: *"OOS — Future Hardening (Medium)"*; untyped TypeErrors already fail closed at scope level; external-venue perimeter, never in any 11C stage scope. |
| 4 | Binance liquidity `?? Date.now()` removal (B2) | **Security hardening** | `binance.ts:537`; a data-integrity silent default (11B-theme, not 11C admission); behavior change needing its own sign-off; same OOS-I2 disposition. |
| 5 | Deribit envelope `result: null` admission (B2) | **Security hardening** | Same I2 disposition; downstream failures are untyped but not silent. |
| 6 | Deribit candle-ts → persisted `Invalid Date` (B2) | **Security hardening** | Same I2 disposition; corrupt-persistence path pre-DQ. |
| 7 | DQ Stage-B deduction range + score clamp (B2) | **Security hardening** — top priority of Phase 12 | Verified: `dq/stage-b-client.ts:80-81` admits any finite deduction; `dq/score.ts:17` has no upper clamp → a negative deduction inflates past PASSED ≥ 90. §7 records why this does not reopen 11C. |
| 8 | Governance strategies edge validator (B3a) | **Security hardening** | Audit B4: *"OOS — Future Hardening (Medium)… currently fail-closed"* — `registerStrategyVersion` re-validates field-by-field → 400; residue (unbounded lengths, unbounded `parameters` Json) is hardening, not an open boundary. |
| 9 | Retire/overview `String(err)` 500s (B3b) | **Security hardening** | Info egress to authenticated operators; audit ranked Low/cosmetic; not an admission boundary. |
| 10 | `apps/web/src/lib/control.ts` read admission (B3c) | **Security hardening** | Logic-bearing (`control.ts:47-49,123,156,165`) **but human-terminal**: all three consumers are operator-display/decision-support (`control/permission/route.ts:10`, `trading-decision.ts:78`, `portfolio.ts:29`); the enforcement path is the GAP B-sealed worker store. Same tier class as audit B6 (OOS), corrected severity Medium. |
| 11 | 500-egress cleanup, ~26 read routes + SSE (B4) | **Security hardening** | Egress hygiene (trusted → out) — the *opposite direction* of 11C's admission objective; extends remediation Batch 7 to read routes. |
| 12 | Display-tier Json reads (B5, optional) | **Nice-to-have** | Audit B6: OOS Low; no corrupt value reaches a displayed figure as a finite wrong number; residual threat is direct-DB corruption only. |
| 13 | Cryptographic journal chaining | **Future architecture** | Appeared only on a Stage-2-era memory *candidates* list; never adopted by the approved Stage 3 plan or audit. Different control class (authenticity vs structure), on-disk format change, key management, sealed-store contact — needs its own design phase. |
| 14 | `governance/overview` in-handler session guard | **Out of scope** | Authentication policy, not admission; middleware B1 already gates the route; flagged as a separate decision. |

## 5. Remaining trust-boundary analysis

Inside the phase perimeter (worker runtime + web request ingress): **zero open
unknown → trusted transitions.** The audit's §3 table plus the GAP C closure statement
account for every one: bus (×2), control store (×2), pipeline rows (×2), journals (×2),
DB Decimals (×2) — all SEALED; quant-feature decode, Deribit order transport, env, session
cookie — SAFE by verified construction.

Outside the perimeter, four residues exist, none crossing unvalidated into a fail-closed
production enforcement path:

1. **DQ Stage-B range gap** — the only genuine *fail-open*: an out-of-range deduction from
   the first-party quant service inflates the score past the Feature-Store gate. Guarded
   structurally (malformed shapes already fail closed to INFRA deduction,
   `stage-b-client.ts:152-155`); the defect is a missing range constraint inside an existing
   validator.
2. **Exchange REST casts** — external venues, fail closed by untyped TypeError at scope
   level; observability and typing debt.
3. **Web DB-tier reads** (`control.ts`, `trading-decision.ts`) — worker-authored sources
   behind write-path admission; terminate at human displays; worst case is a silently wrong
   permission *rendering*, while the worker-side enforcement of the same state is sealed.
4. **Error egress leaks** — disclosure, not admission.

## 6. Validation summary (phase-cumulative)

- **Unit/integration:** workers 351/351 (Stage 1 sealed suites byte-identical throughout
  Stages 2–3); web + ingestion + packages suites green; monorepo turbo 17/17; strict
  typecheck clean repo-wide.
- **Determinism:** PHASE G golden snapshots 10/10 byte-identical in every Stage 3 batch
  validation, hashes byte-identical across Batch 2 and GAP C runs on the same disposable DB
  (`624d8507…`/`2dd56a08…`) — zero drift from admission work, ever.
- **Live gates:** `ci:harness` DB phases 1, 2, 4, G, 6, 7, 8 PASS on the disposable stack;
  `seal:phase97` STEPS B–K PASS with admission live (STEP I includes a real worker restart
  reading persisted state through the new validators).
- **Zero-drift proof:** hunk-by-hunk diff review of every stage; reject-only admitters
  proven same-reference by test; VERBATIM aggregation preserved end-to-end.
- **Known-dark gates (pre-existing, non-11C):** `ci:harness` HTTP phases 5/3 (B1 auth gate,
  `3aca85b`/`7578820`) and `seal:phase97` STEP A (11B `348ef38` env drift) — both proven
  pre-existing by control runs; restoration is Phase 12 Batch 1, to be completed **before**
  any new admission work so no future acceptance pays the control-run evidence tax again.

## 7. Phase completion decision

**Phase 11C is COMPLETE. No former-Stage-4 item is a blocker. RATIFIED 2026-07-14.**

The one item warranting explicit adjudication was #7 (DQ range fail-open), ruled a
non-blocker on four grounds: **(i)** the accepted Final Audit places the entire ingestion
tier outside Phase 11C (§2.2 legend and I2/I3 rows) — phase scope is defined by its accepted
documents, and a post-hoc severity correction changes the *priority* of future work, not the
*membership* of a closed phase; **(ii)** consistency — the audit already ruled exchange-REST
ingress (a *less* trusted source) OOS-Medium; an internal first-party service's range gap
cannot retroactively be more in-scope than that; **(iii)** the boundary is not unguarded —
it has structural, fail-closed admission; the gap is one missing constraint in a validator,
i.e. exactly the Future-Hardening class; **(iv)** no 11C stage scope-lock ever included
ingestion. The contrary reading — that 11C's objective covered the whole market-data
admission chain — was surfaced to the approver and not adopted at ratification.

## 8. Phase 11C closeout summary

- **Original objective:** reject-only, fail-closed admission at every unknown → trusted
  transition in the production worker runtime and the web request ingress, with zero
  trading-logic behavior change (§2).
- **Stage 1 COMPLETE** (`f468b9b`): web request-ingress admission (14 routes,
  `api-validate.ts`) + worker pipeline admission (strategy rows, snapshots, signal
  contract).
- **Stage 2 COMPLETE** (`a2182f9`): JSONL journal recovery admission (market → UNARMED,
  risk → HALTED); tampered-halt exploit closed.
- **Stage 3 COMPLETE** (`713d9bf`): distributed decision-bus admission (GAP A),
  control-plane store admission (GAP B), DB-Decimal finiteness (GAP C + ledger fold-in).
- **Trust boundaries sealed (10):** Redis bytes → DecisionEvent; BullMQ job.data →
  DecisionEvent; DB String → RuntimeState; DB Json → ControlComponent[]; DB Json → strategy
  parameters; DB rows → snapshot/DQ pipeline input; JSONL → MarketJournalRecord; JSONL →
  RiskJournalRecord; DB Decimal → mark price (tick/candle); DB Decimal → ledger peak equity.
  Four concrete exploits closed: silent kill-switch clear, queue poisoning, listener crash,
  PROTECTED→HEALTHY upgrade hole.
- **Validation:** §6 — 351/351, turbo 17/17, PHASE G 10/10 byte-identical, seal B–K green,
  zero determinism drift.
- **Final production readiness:** the codebase fulfils Phase 11C's mandate; production
  posture is otherwise unchanged from the Final Production Completion baseline. Remaining
  go-live dependencies are **external only** (Deribit credentials, funded account, host
  secrets, second operator) plus the two dark harness gates (Phase 12 Batch 1).
- **Remaining future hardening register — all transferred to
  [PHASE12_CHARTER.md](PHASE12_CHARTER.md):** harness restoration (B1); ingestion REST
  admission + DQ range guard (B2); web edge admission — governance body, `control.ts`,
  500-leak pair (B3); 500-egress contract completion (B4); optional display-tier Json reads
  (B5); cryptographic journal chaining (separate future design decision, not silently
  carried); `governance/overview` session-guard question (separate auth decision).

## 9. Disposition of artifacts

- This document is the official final acceptance record of Phase 11C.
- `AI_OS/PHASE11C_STAGE4_PLAN.md` is **superseded and replaced** by
  [PHASE12_CHARTER.md](PHASE12_CHARTER.md) — all technical content preserved; the work is
  reclassified as **Phase 12 future hardening**, none of it a blocker for Phase 11C
  acceptance; batch structure and ordering unchanged.
- The Stage 1–3 planning/audit/report documents remain unmodified historical records.

## 10. Confidence level

**High** on the completion decision — grounded in the accepted phase documents' own scope
definitions (audit legend, Future Hardening register, GAP C completion statement),
cross-verified against current source at every cited line. **Moderate-high** on individual
severity rankings (the DQ item's exploitability depends on quant-service threat assumptions
taken conservatively). The single judgment call (§7) is recorded with its contrary reading
so the ratification was made with full context.

---

**Phase 11C: CLOSED. Successor work: [PHASE12_CHARTER.md](PHASE12_CHARTER.md), awaiting
Phase 12 authorization.**
