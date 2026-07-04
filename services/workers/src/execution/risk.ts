/**
 * Risk layer (Phase 5) — the GLOBAL, MANDATORY, FAIL-CLOSED gate.
 *
 * `evaluateRisk` is the only path to an ExecutionIntent: the stage constructs no
 * intent unless this returns `approved`. It enforces HARD constraints (max single
 * position, max portfolio exposure, per-strategy limits) and a kill-switch, and
 * it FAILS CLOSED — any missing/invalid input, or a tripped kill-switch, BLOCKS
 * rather than allows. The function is pure; the kill-switch is the one small piece
 * of (explicitly managed) state, modeled on the existing platform RiskMode so it
 * dovetails with the RISK_MODE_CHANGED event already in the catalog.
 */

import type { RiskMode } from "@nexus/core";
import { parseDecimal } from "./money.js";
import type { ExposureProjection } from "./portfolio.js";
import type { ProposedAllocation } from "./types.js";

export interface RiskLimits {
  /** Hard cap on a single position's notional. */
  maxPositionNotional: number;
  /** Hard cap on gross portfolio exposure (sum of |position notional|). */
  maxPortfolioExposure: number;
  /** Per-strategy hard caps on gross notional, keyed by execution strategy id. */
  perStrategyMaxNotional: Record<string, number>;
  /** Cap applied to any strategy not named in `perStrategyMaxNotional`. */
  defaultPerStrategyMaxNotional: number;
}

/** Generous-but-finite defaults; the demo sizing fits inside them and executes. */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositionNotional: 750_000,
  maxPortfolioExposure: 2_000_000,
  perStrategyMaxNotional: {},
  defaultPerStrategyMaxNotional: 1_500_000,
};

export type RiskBlockReason =
  | "KILL_SWITCH"
  | "MAX_POSITION_SIZE"
  | "PER_STRATEGY_LIMIT"
  | "MAX_PORTFOLIO_EXPOSURE"
  | "FAIL_CLOSED";

export type RiskVerdict =
  | { approved: true }
  | { approved: false; reason: RiskBlockReason; detail: string };

/**
 * Fail-closed kill-switch backed by the platform RiskMode taxonomy. RISK_OFF and
 * FROZEN HALT all execution; NORMAL / ELEVATED permit it. Default is NORMAL so the
 * system is execution-capable, but any uncertainty resolves to halted, not open.
 */
export class KillSwitch {
  private _mode: RiskMode;

  constructor(initial: RiskMode = "NORMAL") {
    this._mode = initial;
  }

  get mode(): RiskMode {
    return this._mode;
  }

  /** True when the current mode forbids opening new exposure (execution halted). */
  isEngaged(): boolean {
    return this._mode === "RISK_OFF" || this._mode === "FROZEN";
  }

  /** Trip the switch — halts all execution until explicitly reset. */
  engage(mode: "RISK_OFF" | "FROZEN" = "FROZEN"): void {
    this._mode = mode;
  }

  /** Clear the switch back to a trading mode. */
  reset(mode: "NORMAL" | "ELEVATED" = "NORMAL"): void {
    this._mode = mode;
  }
}

/**
 * The global pre-execution gate. Returns `approved` only when every hard
 * constraint holds AND the kill-switch is disengaged AND all inputs are valid.
 * Any other condition BLOCKS (fail-closed). Pure — given the same inputs it
 * always returns the same verdict.
 */
export function evaluateRisk(
  proposal: ProposedAllocation,
  projection: ExposureProjection,
  limits: RiskLimits,
  killSwitch: KillSwitch,
): RiskVerdict {
  // 1) Kill-switch halts everything, unconditionally and first.
  if (killSwitch.isEngaged()) {
    return {
      approved: false,
      reason: "KILL_SWITCH",
      detail: `risk mode ${killSwitch.mode} — all execution halted`,
    };
  }

  const target = parseDecimal(proposal.targetNotional);
  const perStrategyMax =
    limits.perStrategyMaxNotional[proposal.strategyId] ??
    limits.defaultPerStrategyMaxNotional;

  // 2) Fail-closed input validation: any non-finite/non-positive limit, a
  //    non-finite exposure projection, or a non-positive target BLOCKS. Missing
  //    risk configuration must never read as "allowed".
  const limitsValid = [
    limits.maxPositionNotional,
    limits.maxPortfolioExposure,
    perStrategyMax,
  ].every((x) => Number.isFinite(x) && x > 0);
  const projectionValid =
    Number.isFinite(projection.grossAfter) &&
    Number.isFinite(projection.strategyAfter);
  if (!limitsValid || !projectionValid || !(target > 0)) {
    return {
      approved: false,
      reason: "FAIL_CLOSED",
      detail: "missing or invalid risk inputs — blocking (fail-closed)",
    };
  }

  // 3) Hard constraints (most specific first).
  if (target > limits.maxPositionNotional) {
    return {
      approved: false,
      reason: "MAX_POSITION_SIZE",
      detail: `position ${proposal.targetNotional} > max ${limits.maxPositionNotional}`,
    };
  }
  if (projection.strategyAfter > perStrategyMax) {
    return {
      approved: false,
      reason: "PER_STRATEGY_LIMIT",
      detail: `strategy ${proposal.strategyId} exposure ${projection.strategyAfter.toFixed(2)} > limit ${perStrategyMax}`,
    };
  }
  if (projection.grossAfter > limits.maxPortfolioExposure) {
    return {
      approved: false,
      reason: "MAX_PORTFOLIO_EXPOSURE",
      detail: `portfolio exposure ${projection.grossAfter.toFixed(2)} > max ${limits.maxPortfolioExposure}`,
    };
  }

  return { approved: true };
}
