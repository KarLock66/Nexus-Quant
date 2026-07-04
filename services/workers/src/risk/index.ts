/**
 * Risk & Capital Control Layer — public module surface (Phase 8).
 *
 * The mandatory, fail-closed layer between Signal Generation and Execution:
 *
 *   Signals -> Position Sizer -> Risk Engine -> Execution
 *
 * Composition (all pure + deterministic except the append-only journal IO):
 *   capital.ts    — Capital Model (immutable snapshot of trading resources)
 *   sizer.ts      — Position Sizer (5 deterministic sizing modes)
 *   exposure.ts   — Portfolio Exposure Engine (gross/net/long/short/leverage/util)
 *   gate.ts       — Pre-Trade Risk Gate (six hard checks, fail-closed)
 *   kill-switch.ts— Kill Switch trigger evaluation (global halts)
 *   state.ts      — RiskControlState fold (journal-derived, replay/restart-exact)
 *   events.ts     — append-only Risk Event store (in-memory + JSONL file)
 *   recovery.ts   — restart reconstruction (fail-closed)
 *   engine.ts     — the orchestration (capital -> triggers -> gate -> journal)
 *   integration.ts— the opt-in execution-stage hook (default-off)
 *
 * Nothing here changes a sealed Phase 1–7 code path; the integration is a single
 * default-off hook on the execution stage.
 */

export * from "./types.js";
export * from "./money.js";
export * from "./capital.js";
export * from "./sizer.js";
export * from "./exposure.js";
export * from "./gate.js";
export * from "./kill-switch.js";
export * from "./state.js";
export * from "./events.js";
export * from "./recovery.js";
export * from "./engine.js";
export * from "./integration.js";
