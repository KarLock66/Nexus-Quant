/**
 * Phase 9.7 — Control execution gate (the enforcement seam). A {@link RiskGateHook}
 * (same shape as the Phase-8 risk hook) that the worker boot composes IN FRONT of the
 * risk gate, so it runs BEFORE any ExecutionIntent is constructed. It consults:
 *
 *   1. the LIVE kill switch (cheap single-row read) — an operator kill via the web tier
 *      mid-tick must block the very next order, not wait for the next evaluation; and
 *   2. the latest trading-permission snapshot from the tick evaluator (DB/quant/feature/
 *      signal/exec/risk/state conditions).
 *
 * FAIL-CLOSED: a missing permission snapshot, a BLOCKED verdict, or ANY thrown error all
 * deny the order. Default-off — only wired when CONTROL_PLANE=on, so the sealed Phase
 * 1–8 execution path is byte-for-byte unchanged when it is absent.
 */

import type { RiskGateDecision, RiskGateHook } from "../execution/stage.js";
import type { KillSwitchState, TradingPermission } from "@nexus/control";

export interface ControlGateDeps {
  /** Read the live kill switch (the worker wires this to the DB store). */
  readKillSwitch: () => Promise<KillSwitchState>;
  /** Latest permission snapshot from the ControlPlane evaluator. */
  currentPermission: () => TradingPermission | null;
  /**
   * Max age (ms) a permission snapshot may be before the gate distrusts it. A wedged
   * evaluator (repeated tick failures) would otherwise leave the LAST snapshot in place;
   * if it was ALLOWED the gate would keep approving on stale state. When set, a snapshot
   * older than this fails closed. Omit to disable the age guard (kept for tests/callers
   * that supply synthetic snapshots).
   */
  maxPermissionAgeMs?: number;
  /** Wall clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: object) => void;
}

export function createControlExecutionGate(deps: ControlGateDeps): RiskGateHook {
  return async (proposal): Promise<RiskGateDecision> => {
    try {
      const ks = await deps.readKillSwitch();
      if (ks.engaged) {
        return {
          approved: false,
          reason: "TRADING_STOPPED",
          detail: `kill switch engaged by ${ks.actor ?? "operator"}: ${ks.reason ?? "no reason"}`,
        };
      }

      const perm = deps.currentPermission();
      if (perm === null) {
        return { approved: false, reason: "CONTROL_NOT_READY", detail: "control plane has not evaluated yet" };
      }
      // A snapshot the evaluator has stopped refreshing cannot be trusted to reflect
      // current control state — distrust it and fail closed (never trade on doubt).
      if (deps.maxPermissionAgeMs !== undefined && Number.isFinite(perm.generatedAt)) {
        const ageMs = (deps.now ?? Date.now)() - perm.generatedAt;
        if (ageMs > deps.maxPermissionAgeMs) {
          return {
            approved: false,
            reason: "FAIL_CLOSED",
            detail: `permission snapshot stale (${Math.round(ageMs / 1000)}s old > ${Math.round(
              deps.maxPermissionAgeMs / 1000,
            )}s) — control evaluator may be wedged`,
          };
        }
      }
      if (perm.permission === "BLOCKED") {
        return {
          approved: false,
          reason: "TRADING_BLOCKED",
          detail: perm.blockedBy.map((b) => `${b.label}: ${b.detail}`).join("; ") || "trading blocked",
        };
      }
      return { approved: true };
    } catch (err) {
      // Any failure to evaluate control state must BLOCK (never trade on uncertainty).
      deps.log?.("error", "control gate error — blocking (fail-closed)", {
        detail: err instanceof Error ? err.message : String(err),
        symbol: proposal.symbol,
      });
      return {
        approved: false,
        reason: "FAIL_CLOSED",
        detail: `control gate error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
