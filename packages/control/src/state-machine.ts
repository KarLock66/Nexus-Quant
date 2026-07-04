/**
 * Phase 9.7 — Runtime State Machine (Section A). A pure, total, deterministic reducer
 * over the previous state plus a pre-digested {@link SteadyStateInput}. The worker
 * evaluator builds the input (from ControlInputs + recovery IO) and persists every
 * transition; this function decides the next steady state.
 *
 * Precedence (highest wins), matching the spec table verbatim:
 *   1. kill engaged                          → STOPPED (sticky; only `resume` clears it)
 *   2. any active protection rule            → PROTECTED (trading blocked)
 *   3. leaving PROTECTED/RECOVERING:
 *        recoveryOutcome === true            → HEALTHY      (recovery verified)
 *        recoveryOutcome === false           → PROTECTED    (verification failed)
 *        recoveryOutcome === null            → RECOVERING   (verifying)
 *   4. leaving STOPPED (resume): clean        → HEALTHY, soft-degraded → DEGRADED
 *   5. soft degradation                       → DEGRADED
 *   6. otherwise                              → HEALTHY
 *
 * BOOTING / STARTING / FAILED are boot-phase states owned by the worker boot sequence
 * (see startup.ts + control/evaluator.ts); this reducer is only invoked once the runtime
 * is past startup, and it is total so a stale `prev` of any value is handled safely.
 */

import type { ProtectionVerdict, RuntimeState, RuntimeStateResult, SteadyStateInput } from "./types.js";

function protectionReason(active: ProtectionVerdict[]): string {
  if (active.length === 1) return active[0]!.detail;
  return `${active.length} protection conditions active: ${active.map((a) => a.ruleId).join(", ")}`;
}

export function deriveRuntimeState(
  prev: RuntimeState,
  input: SteadyStateInput,
): RuntimeStateResult {
  // 1. Manual kill switch dominates everything.
  if (input.killEngaged) {
    return {
      state: "STOPPED",
      reason: "manual kill switch engaged",
      affectedComponents: [],
    };
  }

  // 2. Any active protection condition → PROTECTED.
  if (input.activeProtections.length > 0) {
    return {
      state: "PROTECTED",
      reason: protectionReason(input.activeProtections),
      affectedComponents: input.activeProtections.map((a) => a.component),
    };
  }

  // 3. No protection active, but we were protected/recovering → require verification.
  if (prev === "PROTECTED" || prev === "RECOVERING") {
    if (input.recoveryOutcome === true) {
      return { state: "HEALTHY", reason: "recovery verified", affectedComponents: [] };
    }
    if (input.recoveryOutcome === false) {
      return {
        state: "PROTECTED",
        reason: "recovery verification failed — holding protected",
        affectedComponents: [],
      };
    }
    return { state: "RECOVERING", reason: "verifying recovery", affectedComponents: [] };
  }

  // 4. Resume from STOPPED: re-evaluate cleanly.
  if (prev === "STOPPED") {
    return input.degraded
      ? { state: "DEGRADED", reason: "resumed — soft degradation present", affectedComponents: [] }
      : { state: "HEALTHY", reason: "resumed by operator", affectedComponents: [] };
  }

  // 5. Soft degradation (no hard protection).
  if (input.degraded) {
    return { state: "DEGRADED", reason: "non-critical degradation", affectedComponents: [] };
  }

  // 6. All nominal.
  return { state: "HEALTHY", reason: "all systems nominal", affectedComponents: [] };
}
