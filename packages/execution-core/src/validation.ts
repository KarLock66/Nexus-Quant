/**
 * Fail-closed validation. Every gate returns an explicit {@link ExecutionFailureReason}
 * (the WHY) or null when it passes — nothing is ever silently admitted. These are pure
 * predicates over already-served data; they NEVER recompute a decision value, they only
 * check that a VERBATIM value is present and that the served gates permit execution.
 *
 *   No TradingDecision   → NO_DECISION      (⇒ no ExecutionIntent)
 *   No TradePlan         → NO_PLAN          (⇒ no ExecutionPlan)
 *   Action NO_TRADE /
 *     !canTrade          → BLOCKED          (cannot submit)
 *   Missing entry        → MISSING_ENTRY    (cannot submit)
 *   Missing stop         → MISSING_STOP     (cannot submit)
 *   Missing target       → MISSING_TARGET   (cannot submit)
 *   Missing readiness    → MISSING_READINESS(cannot submit)
 */

import type {
  ExecutionFailureReason,
  ExecutionInput,
  ExecutionIntent,
} from "./types.js";

/** Guard the raw orchestration input: a decision AND a plan must both be present. */
export function validateInput(input: ExecutionInput): ExecutionFailureReason | null {
  if (!input.decision) return "NO_DECISION";
  if (!input.plan) return "NO_PLAN";
  return null;
}

/**
 * Fail-closed submit gate. Returns the FIRST failing reason (deterministic order), or null
 * when the intent may legally proceed to SUBMITTED. Order matters: gating (BLOCKED) is
 * checked before individual level completeness so a NO_TRADE intent reports the honest
 * top-level reason rather than an incidental missing level.
 */
export function checkSubmittable(intent: ExecutionIntent): ExecutionFailureReason | null {
  // Served gates first — the plan already decided we may not trade.
  if (intent.action === "NO_TRADE" || !intent.canTrade || !intent.shouldTrade) return "BLOCKED";
  // Readiness must have been scored (fail-closed: an unscored trade never submits).
  if (intent.readinessScore === null || intent.readinessBand === null) return "MISSING_READINESS";
  // Then the concrete levels required to place protective orders.
  if (intent.entry === null) return "MISSING_ENTRY";
  if (intent.stop === null) return "MISSING_STOP";
  if (intent.targets.length === 0) return "MISSING_TARGET";
  return null;
}

/** True only when the intent passes every fail-closed submit gate. */
export function isSubmittable(intent: ExecutionIntent): boolean {
  return checkSubmittable(intent) === null;
}
