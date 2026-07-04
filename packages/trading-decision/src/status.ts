/**
 * Deterministic status derivations: control (from the Phase 9.7 permission), execution
 * readiness (control + runtime state), a STATIC pre-trade risk verdict, and the composed
 * overall status. All fail-closed: unknown/absent inputs deny rather than round up.
 *
 * The risk verdict is explicitly STATIC — with no live account the daily-loss/drawdown
 * checks cannot run, so they are skipped and `staticOnly` is set. It is a pre-trade view,
 * not the live Phase-8 engine verdict.
 */

import type {
  ControlContext,
  ControlStatus,
  ExecutionStatus,
  OverallStatus,
  RiskContext,
  RiskStatusView,
  SignalDecision,
} from "./types.js";
import { round } from "./util.js";

export function deriveControlStatus(control: ControlContext): ControlStatus {
  // Kill is the hardest gate — surface it as BLOCKED even when permission is unknown.
  if (control.killEngaged) return "BLOCKED";
  if (control.permission === null) return "UNKNOWN";
  return control.permission === "ALLOWED" ? "ALLOWED" : "BLOCKED";
}

const WAITING_STATES = new Set(["BOOTING", "STARTING", "RECOVERING", "DEGRADED"]);
const BLOCKED_STATES = new Set(["STOPPED", "FAILED", "PROTECTED"]);

export function deriveExecutionStatus(
  control: ControlContext,
  controlStatus: ControlStatus,
): ExecutionStatus {
  if (controlStatus === "UNKNOWN") return "UNKNOWN";
  if (controlStatus === "BLOCKED") return "BLOCKED";
  // controlStatus === ALLOWED
  const state = control.runtimeState;
  if (state === "HEALTHY") return "READY";
  if (state === null) return "WAITING";
  if (BLOCKED_STATES.has(state)) return "BLOCKED";
  if (WAITING_STATES.has(state)) return "WAITING";
  return "WAITING"; // unknown state string → fail-closed to not-ready
}

export function evaluateStaticRisk(
  direction: SignalDecision,
  notional: number | null,
  risk: RiskContext,
): RiskStatusView {
  const mode = risk.systemRiskMode;
  if (mode === "RISK_OFF" || mode === "FROZEN") {
    return { status: "BLOCKED", reason: `system risk mode ${mode}`, staticOnly: true };
  }
  if (direction === "FLAT") {
    return { status: "NOT_APPLICABLE", reason: "FLAT signal — no order to risk-check", staticOnly: true };
  }
  if (notional === null) {
    return { status: "UNKNOWN", reason: "position notional unavailable — cannot evaluate caps", staticOnly: true };
  }
  if (notional > risk.maxNotional) {
    return {
      status: "BLOCKED",
      reason: `notional $${round(notional, 2)} exceeds max $${round(risk.maxNotional, 2)}`,
      staticOnly: true,
    };
  }
  return {
    status: "APPROVED",
    reason: "static pre-trade checks pass (daily-loss/drawdown require a live account)",
    staticOnly: true,
  };
}

export function deriveOverallStatus(
  direction: SignalDecision,
  controlStatus: ControlStatus,
  riskStatus: RiskStatusView["status"],
  executionStatus: ExecutionStatus,
  entryAvailable: boolean,
): OverallStatus {
  // A FLAT signal is fundamentally not a trade candidate — surface that first.
  if (direction === "FLAT") return "NO_TRADE";
  if (controlStatus === "BLOCKED" || riskStatus === "BLOCKED") return "BLOCKED";
  if (executionStatus === "WAITING" || executionStatus === "UNKNOWN") return "WAITING";
  if (!entryAvailable) return "INCOMPLETE";
  return "ACTIONABLE";
}
