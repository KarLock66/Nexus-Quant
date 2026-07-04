/**
 * Phase 9.7 — Trading Permission Engine (Section B). The single `canTrade()` authority
 * every execution path must consult. PURE + deterministic + FAIL-CLOSED: ALLOWED only
 * when EVERY condition is satisfiable from real evidence; any uncertainty blocks.
 *
 * Freshness here is stricter than the protection engine on purpose: a stream with NO
 * observation (`lagSeconds === null`) is "not fresh" → BLOCKED. You cannot trade on
 * data you have never seen. (Execution freshness is the one exception — a never-yet-
 * executed system is allowed to place its FIRST order; only a stalled, previously-
 * active execution path blocks.)
 */

import type {
  ComponentHealth,
  ControlInputs,
  PermissionReason,
  RuntimeState,
  TradingPermission,
} from "./types.js";

function healthy(h: ComponentHealth): boolean {
  return h === "healthy";
}

/** A required stream is fresh iff observed AND within its stale bound. */
function streamFresh(lagSeconds: number | null, staleSeconds: number): boolean {
  return lagSeconds !== null && lagSeconds <= staleSeconds;
}

/**
 * States in which trading is categorically blocked regardless of individual checks.
 * Only HEALTHY permits trading; everything else (boot, degraded, protected, stopped,
 * recovering, failed) is conservative.
 */
function stateBlocks(state: RuntimeState): boolean {
  return state !== "HEALTHY";
}

/**
 * Evaluate trading permission. `runtimeState` is the persisted current state (the gate
 * reads it alongside the live inputs); pass it so permission is never less conservative
 * than the state machine. Omit it (undefined) to evaluate the raw conditions only.
 */
export function evaluateTradingPermission(
  inputs: ControlInputs,
  runtimeState?: RuntimeState,
): TradingPermission {
  const reasons: PermissionReason[] = [];

  reasons.push({
    check: "database",
    label: "Database healthy",
    ok: healthy(inputs.database),
    detail: healthy(inputs.database) ? "healthy" : `database is ${inputs.database}`,
  });
  reasons.push({
    check: "redis",
    label: "Redis healthy",
    ok: healthy(inputs.redis),
    detail: healthy(inputs.redis) ? "healthy" : `redis is ${inputs.redis}`,
  });
  reasons.push({
    check: "quant",
    label: "Quant healthy",
    ok: healthy(inputs.quant),
    detail: healthy(inputs.quant) ? "healthy" : `quant is ${inputs.quant}`,
  });

  {
    const ok = streamFresh(inputs.features.lagSeconds, inputs.features.staleSeconds);
    reasons.push({
      check: "feature_freshness",
      label: "Feature freshness valid",
      ok,
      detail: ok
        ? `fresh (${inputs.features.lagSeconds}s)`
        : inputs.features.lagSeconds === null
          ? "no FeatureSnapshot observed"
          : `FeatureSnapshot stale ${inputs.features.lagSeconds}s > ${inputs.features.staleSeconds}s`,
    });
  }
  {
    const ok = streamFresh(inputs.signals.lagSeconds, inputs.signals.staleSeconds);
    reasons.push({
      check: "signal_freshness",
      label: "Signal freshness valid",
      ok,
      detail: ok
        ? `fresh (${inputs.signals.lagSeconds}s)`
        : inputs.signals.lagSeconds === null
          ? "no EngineSignal observed"
          : `EngineSignal stale ${inputs.signals.lagSeconds}s > ${inputs.signals.staleSeconds}s`,
    });
  }
  {
    // Execution: a never-executed system (null) may place its first order; only a
    // stalled, previously-active execution path blocks.
    const stalled =
      inputs.execution.lagSeconds !== null &&
      inputs.execution.lagSeconds > inputs.execution.staleSeconds;
    reasons.push({
      check: "execution_freshness",
      label: "Execution freshness valid",
      ok: !stalled,
      detail: stalled
        ? `Execution stalled ${inputs.execution.lagSeconds}s > ${inputs.execution.staleSeconds}s`
        : inputs.execution.lagSeconds === null
          ? "no prior execution (first order allowed)"
          : `fresh (${inputs.execution.lagSeconds}s)`,
    });
  }

  reasons.push({
    check: "risk_engine",
    label: "Risk engine active",
    ok: inputs.riskEngineActive,
    detail: inputs.riskEngineActive ? "armed" : "disabled/halted",
  });
  reasons.push({
    check: "kill_switch",
    label: "Kill switch disengaged",
    ok: !inputs.killSwitch.engaged,
    detail: inputs.killSwitch.engaged
      ? `ENGAGED by ${inputs.killSwitch.actor ?? "unknown"}: ${inputs.killSwitch.reason ?? "no reason"}`
      : "disengaged",
  });

  if (runtimeState !== undefined) {
    const ok = !stateBlocks(runtimeState);
    reasons.push({
      check: "runtime_state",
      label: "Runtime state HEALTHY",
      ok,
      detail: ok ? "HEALTHY" : `state is ${runtimeState}`,
    });
  }

  const blockedBy = reasons.filter((r) => !r.ok);
  return {
    permission: blockedBy.length === 0 ? "ALLOWED" : "BLOCKED",
    generatedAt: inputs.now,
    reasons,
    blockedBy,
  };
}
