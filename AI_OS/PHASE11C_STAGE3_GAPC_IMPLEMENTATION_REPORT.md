# Phase 11C — Stage 3 GAP C Implementation Report: DB-Decimal Finiteness Guards

Status: COMPLETE — implemented, tested, NOT committed (per repo convention)
> **Historical record.** Phase 11C is COMPLETE and RATIFIED (2026-07-14, committed as `713d9bf`) — see [PHASE11C_FINAL_ACCEPTANCE.md](PHASE11C_FINAL_ACCEPTANCE.md). Future hardening: [PHASE12_CHARTER.md](PHASE12_CHARTER.md).
Date: 2026-07-13
Scope executed: **GAP C only**, per the approved
`AI_OS/PHASE11C_STAGE3_FINAL_AUDIT.md` recommendation — the planned
db-quote-transport tick/candle guards PLUS the approved same-class fold-in
(portfolio-ledger peak-equity read). Nothing else touched. No further work
started after this batch.

---

## 1. Boundaries sealed

Both fixes close the same defect class: an unguarded `Number(Decimal)` from a
Prisma read crossing into runtime state. Both are **boundary validation only**
— reject-only, no normalization, no silent defaults, no algorithm change.

### 1a. `market/db-quote-transport.ts` — tick & candle mark branches

**Before:** the orderbook branch guarded `Number.isFinite(mark) && mark > 0`
before `quantizePrice`, but the sibling tick (`Number(tick.price)`) and candle
(`Number(candle.close)`) branches passed the converted Decimal straight in — a
corrupt/zero Decimal became the symbol's live mark.

**After:** both branches apply the IDENTICAL finite-positive admission the
orderbook branch already had. Rejection follows the file's existing
source-priority contract exactly as the approved plan specified: a corrupt
tick **falls through to the candle**; a corrupt candle **falls through to
`return null`** (no mark → cache entry cleared → execution fails closed on
NO_MARKET_DATA, the same behavior as a stale source). No new fallback path was
invented — an unusable source is treated as ABSENT, the file's pre-existing
semantic. Valid quotes are served byte-identically (`quantizePrice` over the
same number as before).

### 1b. `market/portfolio-ledger.ts` — peak-equity recovery (`init()`)

**Before:** `Number(peak._max.equity)` from the `PortfolioSnapshot` aggregate
was assigned unguarded; a corrupt persisted Decimal produced `NaN`, which
survives `Math.max` and silently zeroed every subsequently persisted drawdown
(the `peakEquity > 0` ternary evaluates false on NaN).

**After:** the converted value is finite-checked. A non-finite aggregate is
**LOGGED at error level** (never silent) and treated as absent — the same `0`
used when no snapshots exist yet, so `Math.max(0, initialValue)` recovers the
peak from `initialValue`, exactly the approved audit mechanism. Valid data is
untouched: any finite persisted peak (including the null→0 absence case)
flows through byte-identically. No repair, no substitution of a fabricated
equity — an unreadable source is ignored and reported, exactly like the
db-quote branches.

### Constraint compliance

- **Minimal diff:** 2 source files, +23/−2 lines total (guards + comments);
  2 test files, +35 lines. Nothing else modified.
- **No business-logic change:** no pricing, sizing, risk, execution, or
  portfolio algorithm was altered — the source-priority order, quantization,
  drawdown formula, upsert shape, and all valid-path outputs are unchanged
  (proven by the untouched pre-existing tests passing byte-identically).
- **No normalization / no silent defaults:** invalid values are rejected
  (fall-through / treated-as-absent), never repaired; the one absence
  fallback that exists (ledger `initialValue` floor via `Math.max`) is the
  file's PRE-EXISTING behavior, now merely protected from NaN poisoning and
  logged when the persisted source is unusable.
- **Determinism / Phase 11B hash-replay guarantees preserved:** both files
  are live-edge/ledger tier, outside the inputHash/featureHash/golden
  envelope; the guards add rejection only. PHASE G verified (below) with
  hashes byte-identical to the accepted Batch 2 run.

## 2. Files changed (complete list)

| File | Action | Content |
|---|---|---|
| `services/workers/src/market/db-quote-transport.ts` | modified (+10/−2) | finite-positive guard copied to tick & candle branches; corrupt tick → candle → null fall-through |
| `services/workers/src/market/portfolio-ledger.ts` | modified (+10/−1) | finite guard on `Number(peak._max.equity)`; non-finite → error log + treated as absent (initialValue wins via existing `Math.max`) |
| `services/workers/src/market/db-quote-transport.test.ts` | extended (+24) | 3 tests: corrupt (NaN) tick falls through to candle; zero tick falls through to candle; all-corrupt sources → null (no mark fabricated) |
| `services/workers/src/market/portfolio-ledger.test.ts` | extended (+11) | 1 test: corrupt (`"garbage"`) persisted max equity → peak recovers from initialValue, drawdown reads 0.1000 not the NaN-poisoned 0.0000 |

Not touched: Batch 1/2 files (diff byte-identical to their accepted reports),
Stage 1/2 sealed validators, all pricing/risk/execution/portfolio algorithms,
web, ingestion, packages, schema. No new dependencies.

## 3. Test and validation results

All commands run 2026-07-13 from `services/workers` (or repo root), outputs
read in full.

| Gate | Result |
|---|---|
| Targeted GAP C files (`vitest run` db-quote-transport + portfolio-ledger tests) | **18/18 PASS** (8 + 10, incl. the 4 new GAP C tests) |
| `pnpm typecheck` (tsc strict, --noEmit, standalone run) | **exit 0, clean** |
| `pnpm test` — full workers suite | **20 files, 351/351 PASS** (347 baseline + 4 new; all sealed suites green incl. `market.test.ts`, `durability.test.ts`, `risk.test.ts`, `bus/admission.test.ts`, `control/validate.test.ts`) |
| `pnpm test` — monorepo (turbo, repo root) | **17/17 tasks PASS** (workers re-ran live 351/351; the 16 unaffected tasks cache-hit from today's green runs — only workers inputs changed) |
| `ci:harness` on the live disposable stack (timescaledb pg16 + redis 7 + pinned quant, migrations verified: "No pending migrations") | **PHASE 1, 2, 4, G, 6, 7, 8 ALL PASS** |
| **PHASE G golden snapshot** | **10/10 byte-identical** — and snapshotHash `624d8507…` / inputHash `2dd56a08…` are **byte-identical to the accepted Batch 2 run on this same disposable DB**: GAP C moved NOTHING in the determinism envelope |
| Workers `dist/` rebuild | rebuilt post-change (`tsc -p tsconfig.json` clean); both GAP C `.js` files recompiled — the spawnWorker stale-dist gotcha is closed for any future seal run |

New behavioral proofs (fake Prisma, no live DB):

1. Fresh tick with a non-finite price (`"garbage"` → NaN) + valid fresh candle
   → the **candle** mark is served (fall-through, not a NaN mark).
2. Fresh tick with price `"0"` + valid fresh candle → candle mark served
   (zero is not a usable mark, same as the orderbook branch's contract).
3. Corrupt tick AND corrupt candle → `latest()` returns **null** — no mark is
   ever fabricated; execution fails closed exactly as on a stale feed.
4. Corrupt persisted max equity (`"garbage"`) → ledger initializes with
   peak = initialValue; a subsequent equity of 0.9× initialValue persists
   drawdown `0.1000`. (Pre-fix, the NaN-poisoned peak silently persisted
   `0.0000` for every snapshot — the exact failure the audit predicted.)
5. All 14 pre-existing tests in the two files pass unmodified — valid-quote
   and valid-ledger behavior is preserved byte-identically.

### ci:harness HTTP phases (5, 3) — unchanged pre-existing failure

Identical signature to the Batch 1/2 reports (where a stash-control run proved
it pre-existing): every DB phase passes, the web server itself boots clean
("Ready in 825ms"), then the harness times out on its unauthenticated
readiness probe against the B1 operator-session gate. The GAP C diff lives in
`services/workers/src/market/` and is not imported by the web tier (web's
`market-price.ts` replicates the mark logic; it does not import this module).
Remains flagged Stage 3 wrap-up harness debt, not absorbed here.

### Seal harnesses — not applicable to this diff (evidence, not omission)

Neither `seal:phase97` nor `seal-phase8-runtime` can exercise the GAP C code
paths, verified by grep over `src/ci/`: no harness or seal file sets
`MARKET_DATA_SOURCE=realtime` (the only condition under which the worker
constructs `DbQuoteTransport`) or `PORTFOLIO_LEDGER=on` (the only condition
under which `PortfolioLedger` initializes), and no `src/ci/` file references
either module — the seals' spawned workers use `fixtureQuoteProvider`.
Their regression surface for this change (market/durability/risk over the
edited package) is covered by ci:harness PHASES 6/7/8 (PASS above) and the
full unit suite. Running them would re-validate control-plane/risk surfaces
untouched by GAP C while adding only the known STEP A staleness noise.

## 4. Deviations from the approved scope

1. **None in mechanism or scope.** Both guards implement exactly the approved
   audit recommendation (§6 of the final audit): the `:108`-pattern
   finite-positive guard on tick/candle, and the finite guard + logged
   absence-fallback on the ledger peak.
2. One judgment call within scope: the ledger guard **logs at error level**
   when rejecting the persisted peak (the audit text specified the fallback
   mechanism; the log line enforces the "no silent substitution" constraint —
   an operator sees the corrupt series, nothing is silently defaulted).
3. Workers `dist/` was rebuilt (validation hygiene, gitignored build output —
   same step as Batch 2).

## 5. Stage 3 completion statement

**Phase 11C Stage 3 is COMPLETE.** Per the approved final audit:

- **GAP A** (distributed decision-bus admission) — sealed, Batch 1.
- **GAP B** (control-plane store admission) — sealed, Batch 2.
- **GAP C** (DB-Decimal finiteness: db-quote tick/candle + portfolio-ledger
  peak fold-in) — sealed, this batch.

The audit's remaining-transitions table now has **zero open entries**: no
unknown → trusted conversion in the production worker runtime lacks admission.
Remaining registers are unchanged and explicitly OUTSIDE Stage 3: Future
Hardening (ingestion REST casts — Medium; web governance body cast — Medium;
web display-tier Json reads — Low; helper centralization — Low) and the two
pre-existing harness-debt items (ci:harness HTTP-phase auth bootstrap;
seal:phase97 STEP A `MARKET_DATA_SOURCE` spawn env).

Working tree now holds the complete uncommitted Stage 3 diff
(Batch 1 + Batch 2 + GAP C), ready for the human-triggered commit.

---

**STOP — GAP C complete and validated. No further work started, per instruction.**
