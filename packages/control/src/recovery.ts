/**
 * Phase 9.7 — Recovery Engine (Section E), pure surface. The actual verification probes
 * (a real DB write/read, a quant `/health` re-check, freshness re-confirmation) run in
 * the worker (`control/evaluator.ts`) — they are IO and live there. This module owns the
 * deterministic pieces: the per-component verification PLAN (what must be re-checked,
 * surfaced in the UI/runbooks) and the aggregation of probe results into a single
 * {@link RecoveryOutcome} the state machine consumes.
 *
 * Discipline: "Never auto-resume blindly." A component returning healthy only starts
 * recovery; HEALTHY is reached ONLY after every plan step verifies. Any failed step ⇒
 * the aggregate is `false` (the state machine holds PROTECTED). The MANUAL kill switch
 * is never part of recovery — only an operator `resume` clears STOPPED.
 */

import type { ControlComponent, RecoveryOutcome, RecoveryReport } from "./types.js";

/**
 * Concrete verification steps per component. The worker executes these as real probes;
 * the text here is the canonical, operator-facing description (no placeholders).
 */
export const RECOVERY_PLAN: Record<ControlComponent, string[]> = {
  database: ["SELECT 1 succeeds", "control-table write succeeds", "write reads back identically"],
  redis: ["RESP PING → PONG"],
  quant: ["GET /health returns 200", "second /health confirms stability"],
  features: ["a fresh FeatureSnapshot is within the freshness bound"],
  signals: ["a fresh EngineSignal is within the freshness bound"],
  execution: ["execution activity is within the freshness bound"],
  risk: ["risk engine reports armed and not halted"],
};

/**
 * Reduce per-component recovery reports to the tri-state outcome:
 *   - no reports        → null  (nothing to verify / not started)  → RECOVERING
 *   - every report verified → true                                  → HEALTHY
 *   - any report not verified → false                               → PROTECTED
 */
export function recoveryOutcome(reports: RecoveryReport[]): RecoveryOutcome {
  if (reports.length === 0) return null;
  return reports.every((r) => r.verified) ? true : false;
}

/** Components that were protected last evaluation and are no longer protected now. */
export function componentsNeedingRecovery(
  previouslyActive: ControlComponent[],
  currentlyActive: ControlComponent[],
): ControlComponent[] {
  const current = new Set(currentlyActive);
  // Stable de-dupe preserving first-seen order.
  const seen = new Set<ControlComponent>();
  const out: ControlComponent[] = [];
  for (const c of previouslyActive) {
    if (!current.has(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}
