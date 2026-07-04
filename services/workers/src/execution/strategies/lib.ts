/**
 * Shared PURE primitives for confidence-floor strategies.
 *
 * Factored out (like the engine's `decideSignal`) so every strategy version maps
 * an observation to an intent through the SAME audited logic and can only differ
 * by its declared parameters — never by silent reimplementation drift.
 */

import type { DecisionIntent, SignalObservation } from "../types.js";

/** Parse the quantized 4dp confidence string back to a number (deterministic). */
export function parseConfidence(confidence: string): number {
  const n = Number(confidence);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The canonical execution rule, parameterized by a single conviction floor:
 *   FLAT observation                 -> STAND_ASIDE (no edge; nothing to execute)
 *   directional, confidence >= floor -> ENTER       (act on the confirmed edge)
 *   directional, confidence <  floor -> HOLD         (edge too weak to act on)
 *
 * `side`/`confidence` are carried through VERBATIM so the intent can never
 * silently disagree with the observation it cites.
 */
export function deriveFloorIntent(
  observation: SignalObservation,
  floor: number,
): DecisionIntent {
  const { decision, side, confidence } = observation;
  const conviction = parseConfidence(confidence);

  if (decision === "FLAT") {
    return {
      action: "STAND_ASIDE",
      side,
      confidence,
      rationale: `observation FLAT (no directional edge) — stand aside`,
    };
  }

  if (conviction >= floor) {
    return {
      action: "ENTER",
      side,
      confidence,
      rationale: `${decision} edge with conviction ${confidence} >= floor ${floor.toFixed(4)} — enter`,
    };
  }

  return {
    action: "HOLD",
    side,
    confidence,
    rationale: `${decision} edge but conviction ${confidence} < floor ${floor.toFixed(4)} — hold`,
  };
}
