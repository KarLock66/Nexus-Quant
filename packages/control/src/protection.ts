/**
 * Phase 9.7 — Protection Engine (Section D). Pure, deterministic rule evaluation over
 * the gathered {@link ControlInputs}. Each rule yields a {@link ProtectionVerdict}; the
 * worker evaluator persists the ACTIVE ones (deduped by ruleId), opens incidents, and
 * transitions the runtime to PROTECTED. FAIL-CLOSED throughout: an `unknown` infra
 * health counts as unavailable; a stream that WAS producing and aged past its stale
 * bound is a breach.
 *
 * Freshness semantics (deliberate, see types.ts):
 *   - `lagSeconds === null`  → NO observation (empty table). NOT a breach here — an
 *     never-populated stream is a startup/permission concern, not a protection trip
 *     (so a quiet/booting system is not spuriously PROTECTED). Trading is still blocked
 *     by the permission engine, which treats null as "not fresh".
 *   - `lagSeconds > stale`   → a producing stream went stale → BREACH (active).
 */

import type {
  ComponentHealth,
  ControlInputs,
  ProtectionVerdict,
} from "./types.js";

/** Infra is "down" for protection purposes when failing OR unknown (fail-closed). */
function infraDown(h: ComponentHealth): boolean {
  return h === "failing" || h === "unknown";
}

/** A producing stream is breached iff it has been observed AND aged past its stale bound. */
function freshnessBreached(lagSeconds: number | null, staleSeconds: number): boolean {
  return lagSeconds !== null && lagSeconds > staleSeconds;
}

/**
 * Evaluate every protection rule. Returns one verdict per rule (active or not) in a
 * stable order, so callers can both render the full catalog and filter to `active`.
 */
export function evaluateProtectionRules(inputs: ControlInputs): ProtectionVerdict[] {
  const verdicts: ProtectionVerdict[] = [];

  // 1. Database unavailable — CRITICAL (trading cannot be reasoned about without it).
  verdicts.push({
    ruleId: "database.unavailable",
    component: "database",
    active: infraDown(inputs.database),
    severity: "CRITICAL",
    detail: infraDown(inputs.database)
      ? `database health is ${inputs.database}`
      : "database reachable",
  });

  // 2. Redis unavailable — CRITICAL (bus / distributed coordination).
  verdicts.push({
    ruleId: "redis.unavailable",
    component: "redis",
    active: infraDown(inputs.redis),
    severity: "CRITICAL",
    detail: infraDown(inputs.redis) ? `redis health is ${inputs.redis}` : "redis reachable",
  });

  // 3. Quant unavailable — CRITICAL (no fresh features can be computed).
  verdicts.push({
    ruleId: "quant.unavailable",
    component: "quant",
    active: infraDown(inputs.quant),
    severity: "CRITICAL",
    detail: infraDown(inputs.quant) ? `quant health is ${inputs.quant}` : "quant reachable",
  });

  // 4. Feature freshness breach.
  {
    const breached = freshnessBreached(inputs.features.lagSeconds, inputs.features.staleSeconds);
    verdicts.push({
      ruleId: "feature.stale",
      component: "features",
      active: breached,
      severity: "CRITICAL",
      detail: breached
        ? `FeatureSnapshot stale ${inputs.features.lagSeconds}s > ${inputs.features.staleSeconds}s`
        : "feature generation within bound",
    });
  }

  // 5. Signal freshness breach.
  {
    const breached = freshnessBreached(inputs.signals.lagSeconds, inputs.signals.staleSeconds);
    verdicts.push({
      ruleId: "signal.stale",
      component: "signals",
      active: breached,
      severity: "CRITICAL",
      detail: breached
        ? `EngineSignal stale ${inputs.signals.lagSeconds}s > ${inputs.signals.staleSeconds}s`
        : "signal engine within bound",
    });
  }

  // 6. Execution freshness breach (only meaningful once execution has been observed).
  {
    const breached = freshnessBreached(inputs.execution.lagSeconds, inputs.execution.staleSeconds);
    verdicts.push({
      ruleId: "execution.stale",
      component: "execution",
      active: breached,
      severity: "CRITICAL",
      detail: breached
        ? `Execution stale ${inputs.execution.lagSeconds}s > ${inputs.execution.staleSeconds}s`
        : "execution within bound (or idle)",
    });
  }

  // 7. Risk engine disabled — the control plane expects the Phase-8 gate armed.
  verdicts.push({
    ruleId: "risk.disabled",
    component: "risk",
    active: !inputs.riskEngineActive,
    severity: "CRITICAL",
    detail: inputs.riskEngineActive ? "risk engine armed" : "risk engine disabled/halted",
  });

  return verdicts;
}

/** Convenience: the active protection verdicts only. */
export function activeProtections(inputs: ControlInputs): ProtectionVerdict[] {
  return evaluateProtectionRules(inputs).filter((v) => v.active);
}

/**
 * A soft (non-critical) degradation that warrants DEGRADED but not PROTECTED: a stream
 * in its WARNING band (aged past `warning` but not yet past `stale`), or infra reading
 * `degraded`. Used only when no hard protection is active.
 */
export function isDegraded(inputs: ControlInputs): boolean {
  const softStale = (o: { lagSeconds: number | null; warningSeconds: number; staleSeconds: number }) =>
    o.lagSeconds !== null && o.lagSeconds > o.warningSeconds && o.lagSeconds <= o.staleSeconds;
  return (
    inputs.database === "degraded" ||
    inputs.redis === "degraded" ||
    inputs.quant === "degraded" ||
    softStale(inputs.features) ||
    softStale(inputs.signals) ||
    softStale(inputs.execution)
  );
}
