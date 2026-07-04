# BACKLOG — Prioritized Future Tasks

> Pull from the top of HIGH when TASK.md completes. Move the pulled item into
> TASK.md with a step list; delete it here.

## HIGH (Phase 1 remainder — data layer, per docs/architecture/05-roadmap.md)

1. **Feature Store core** — versioned `FeatureSetDefinition`s across 5 domains
   (Technical, Options, Flow, Regime, Risk); point-in-time `FeatureSnapshot`
   computation with canonical `featureHash`; DQ ≥ 90 admission rule; identical
   inputs ⇒ identical hash across two runs.
2. **Deribit WebSocket live ingestion** — reconnect-safe streaming with no duplicate
   rows (composite-unique upsert verified under reconnect).
3. **Strike-level option chains** — `OptionContractSnapshot` ingest (expiry, strike,
   IV, greeks, OI, volume, bid/ask) + chain aggregates; queryable via SQL, no JSON
   parsing.
4. **Synthetic corruption test suite** — injected gaps, duplicates, outliers each
   produce correct DQ deductions and a FAILED report (Phase 1 acceptance).
5. **Demo seed + hash-verified determinism** — `DEMO_MODE=true` with same
   `DEMO_SEED` produces identical dataset on two machines, zero network.
6. **System Monitoring page** (apps/web) — connector status, DQ scores, demo banner;
   DQ + features + market-data API endpoints behind it.
7. **Binance connector** (secondary) — candles, funding, OI + OI delta, long/short
   ratio; same connector interface.
8. **Gap detection/repair jobs** + agent prompt template seeds (4 M2 agents) +
   `RegimeTransitionMatrix` persistence (computation lands Phase 3).

## MEDIUM (Phase 2 — risk substrate; blocked until Phase 1 acceptance)

1. Position sizing methods in Python (fixed fractional, fractional Kelly, ATR, vol
   targeting) with property-based tests; hand-computed fixtures to 8 dp.
2. `RiskLimit` enforcement in `packages/core`; any breach ⇒ `approved=false`.
3. `SystemRiskState` machine with approval-gated de-escalation (202 + ApprovalRequest).
4. Risk Engine page (limits, mode, sizing calculator).
5. Bybit connector (tertiary).

## LOW (chores & deferred verification)

1. Verify `docker compose up` + `pnpm db:migrate && pnpm db:seed` on a machine with
   Docker (Phase 0 acceptance still partially unverified on this Windows box).
2. CI hardening — run quant pytest in CI on Python 3.12 to catch 3.14-vs-3.12 drift.
3. E2E (Playwright) smoke for the 8 web pages.
4. Repo hygiene: add `__pycache__/` check to lint, prune `.turbo` from any tooling reads.
