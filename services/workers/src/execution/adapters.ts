/**
 * Execution adapters (Phase 5) — the ONLY effectful edge of the system.
 *
 * An adapter takes a risk-approved ExecutionIntent and returns an ExecutionResult.
 * The decision/portfolio/risk layers above are pure; effects live here and nowhere
 * else (strict separation: decision pure, execution effectful-but-traceable).
 *
 *   paper      — deterministic, zero-impact fills (no IO). The default.
 *   simulated  — deterministic modeled fills (slippage + occasional venue reject),
 *                derived from the intent id alone — still pure & replay-stable.
 *   real       — INTERFACE ONLY (Phase 5): execute() throws. The stage treats an
 *                adapter throw as a REJECTED result, so even an accidental wiring
 *                to `real` can never silently execute or crash a tick (fail-closed).
 */

import { quantizeNotional, parseDecimal } from "./money.js";
import type { ExecutionIntent, ExecutionResult } from "./types.js";

export interface ExecutionAdapter {
  /** Stable adapter identity, recorded on every intent + result (paper|simulated|real). */
  readonly id: string;
  /**
   * Execute `intent`. paper/simulated are PURE, synchronous, deterministic
   * functions of the intent; real is async and effectful. The union return type
   * supports both; callers await the result regardless.
   */
  execute(intent: ExecutionIntent): ExecutionResult | Promise<ExecutionResult>;
}

/** FNV-1a 32-bit hash — deterministic per-intent draw (no clock, no randomness). */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fill(
  intent: ExecutionIntent,
  status: ExecutionResult["status"],
  filledNotional: string,
  detail: string,
): ExecutionResult {
  return {
    intentId: intent.intentId,
    symbol: intent.symbol,
    side: intent.side,
    status,
    adapterId: intent.adapterId,
    filledNotional,
    detail,
    lineage: intent.lineage,
  };
}

/** Deterministic, zero-market-impact paper fills. Always FILLED at target. */
export const PaperExecutionAdapter = {
  id: "paper",
  execute(intent: ExecutionIntent): ExecutionResult {
    return fill(
      intent,
      "FILLED",
      intent.targetNotional,
      "paper fill at reference (no market impact)",
    );
  },
} satisfies ExecutionAdapter;

/**
 * Deterministic simulation: a small modeled slippage (0–24 bps) and a rare
 * modeled venue reject (~1 in 64), BOTH derived from the intent id, so the output
 * is a pure function of the intent — identical across runs (replay-stable).
 */
export const SimulatedExecutionAdapter = {
  id: "simulated",
  execute(intent: ExecutionIntent): ExecutionResult {
    if ((hash32(`${intent.intentId}:reject`) & 0x3f) === 0) {
      return fill(intent, "REJECTED", quantizeNotional(0), "simulated venue reject");
    }
    const slippageBps = hash32(`${intent.intentId}:slip`) % 25;
    const filled = parseDecimal(intent.targetNotional) * (1 - slippageBps / 10_000);
    return fill(
      intent,
      "FILLED",
      quantizeNotional(filled),
      `simulated fill, ${slippageBps}bps modeled slippage`,
    );
  },
} satisfies ExecutionAdapter;

/**
 * Real venue routing — INTERFACE ONLY in Phase 5. Implements the adapter contract
 * so it is wireable, but execute() throws: no live venue is connected. The stage
 * converts this throw into a fail-closed REJECTED result.
 */
export const RealExecutionAdapter = {
  id: "real",
  execute(_intent: ExecutionIntent): ExecutionResult {
    throw new Error(
      "RealExecutionAdapter is interface-only in Phase 5 — no live venue is wired",
    );
  },
} satisfies ExecutionAdapter;

/** Resolve an adapter by id (defaults to paper for any unknown id). */
export function resolveAdapter(id: string): ExecutionAdapter {
  switch (id) {
    case "simulated":
      return SimulatedExecutionAdapter;
    case "real":
      return RealExecutionAdapter;
    default:
      return PaperExecutionAdapter;
  }
}
