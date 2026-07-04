/**
 * Phase 9.7 — Operator Runbook System (Section F). A static, specific catalog: every
 * protection rule (plus the manual kill switch and startup failure) maps to a runbook
 * with Problem / Impact / Diagnosis / Required Action / Verification. NO generic
 * messages, NO placeholder text — each entry tells the operator exactly what failed,
 * what it affects, how to confirm it, what to do, and how to verify the fix.
 */

import type { ProtectionRuleId, Runbook, RunbookKey } from "./types.js";

export const RUNBOOKS: Record<RunbookKey, Runbook> = {
  "database.unavailable": {
    key: "database.unavailable",
    title: "Database Down",
    problem: "Postgres/TimescaleDB is unreachable — SELECT 1 is failing or timing out.",
    impact:
      "Trading is disabled (fail-closed): signals, features, risk state and audit cannot be read or written. Persistence stage is down.",
    diagnosis:
      "Check the Postgres container/process is running and the host:5432 is reachable. On Windows, a sudden 'cannot reach localhost:5432' is often WinNAT reserving the port — inspect `netsh int ipv4 show excludedportrange protocol=tcp`.",
    requiredAction:
      "Restart the Postgres container (`docker compose -f docker/docker-compose.ci.yml up -d postgres`). If WinNAT reserved 5432, add a winnat excludedportrange exclusion and restart the service, then bring Postgres back up.",
    verificationSteps: [
      "`SELECT 1` succeeds against the database",
      "the control plane records database → healthy",
      "runtime state transitions PROTECTED → RECOVERING → HEALTHY",
    ],
  },
  "redis.unavailable": {
    key: "redis.unavailable",
    title: "Redis Down",
    problem: "Redis is unreachable — the RESP PING probe is not returning PONG.",
    impact:
      "Trading is disabled (fail-closed). The distributed decision bus and BullMQ coordination cannot operate; in-process fallback does not satisfy the control-plane trade gate.",
    diagnosis:
      "Check the Redis container/process and REDIS_URL. Confirm with `redis-cli -u $REDIS_URL ping` (expect PONG) or a raw TCP PING to host:6379.",
    requiredAction:
      "Restart the Redis container (`docker compose -f docker/docker-compose.ci.yml up -d redis`). Verify REDIS_URL points at the live instance and any AUTH password is correct.",
    verificationSteps: [
      "RESP PING returns PONG",
      "the control plane records redis → healthy",
      "runtime state returns to HEALTHY after recovery verification",
    ],
  },
  "quant.unavailable": {
    key: "quant.unavailable",
    title: "Quant Service Down",
    problem: "The quant feature service is unreachable — GET /health is failing.",
    impact:
      "Trading is disabled (fail-closed). No new FeatureSnapshots can be computed; feature generation will go stale.",
    diagnosis:
      "Check the quant container on :8000 and QUANT_SERVICE_URL. `curl $QUANT_SERVICE_URL/health` should return 200. Confirm the container has fastapi/uvicorn/numpy/scipy and did not crash on boot.",
    requiredAction:
      "Restart the quant container (dev image on :8000, or the digest-pinned image in CI). Do NOT run quant on the host (Py 3.14 / no TA-Lib violates reproducibility).",
    verificationSteps: [
      "GET /health returns 200 twice in a row",
      "a fresh FeatureSnapshot is produced and within the freshness bound",
      "runtime state returns to HEALTHY",
    ],
  },
  "feature.stale": {
    key: "feature.stale",
    title: "Feature Generation Stale",
    problem: "The newest FeatureSnapshot has aged past the freshness bound (180s).",
    impact:
      "Trading is blocked — decisions must not be made on stale features. The signal engine will starve.",
    diagnosis:
      "Confirm ingestion AND quant are both running concurrently (the feature bridge needs live candles + a reachable quant). Check the ingestion daemon is admitting candles and DQ is PASSING.",
    requiredAction:
      "Ensure the ingestion daemon (`pnpm --filter @nexus/ingestion live:ingest`) and quant are both up; investigate any DQ failures blocking feature computation.",
    verificationSteps: [
      "a new FeatureSnapshot row appears with createdAt within the bound",
      "feature freshness lag drops below 180s",
      "runtime state returns to HEALTHY",
    ],
  },
  "signal.stale": {
    key: "signal.stale",
    title: "Signal Engine Stale",
    problem: "The newest EngineSignal has aged past the freshness bound (120s).",
    impact: "Trading is blocked — no fresh decisions are being produced.",
    diagnosis:
      "Check the workers service is running its tick loop (SIGNAL_TICK_MS) and that fresh FeatureSnapshots exist for it to consume. A stale feature stage starves the signal engine first.",
    requiredAction:
      "Restart/verify the workers service; resolve any upstream feature staleness first (feature.stale runbook).",
    verificationSteps: [
      "a new EngineSignal row appears within the bound",
      "signal freshness lag drops below 120s",
      "runtime state returns to HEALTHY",
    ],
  },
  "execution.stale": {
    key: "execution.stale",
    title: "Execution Stalled",
    problem:
      "Execution was active but has aged past the freshness bound (300s) — orders are not completing.",
    impact:
      "Trading is blocked — a previously-active execution path has stalled; new orders are withheld until it is confirmed healthy.",
    diagnosis:
      "Check the market adapter and the DbQuoteTransport freshness (marks age out >60s). Confirm ingestion+workers are running concurrently so real marks stay fresh; inspect the worker logs for NO_MARKET_DATA blocks.",
    requiredAction:
      "Ensure the ingestion daemon is feeding fresh marks and the workers execution stage is armed (MARKET_BROKER/MARKET_DATA_SOURCE). Resolve any market-data staleness.",
    verificationSteps: [
      "execution activity resumes within the freshness bound",
      "execution freshness lag drops below 300s",
      "runtime state returns to HEALTHY",
    ],
  },
  "risk.disabled": {
    key: "risk.disabled",
    title: "Risk Engine Disabled",
    problem: "The Phase-8 risk engine is not armed (or is halted by its kill switch).",
    impact:
      "Trading is blocked — the control plane refuses to trade without the pre-trade risk gate active.",
    diagnosis:
      "Confirm the worker booted with RISK_ENGINE=on and MARKET_BROKER set. If the risk journal was corrupt the engine starts HALTED (JOURNAL_INTEGRITY_FAILURE) — check the worker boot logs.",
    requiredAction:
      "Restart the worker with RISK_ENGINE=on; if the risk journal is corrupt, investigate the journal integrity failure before re-arming (do not bypass the fail-closed halt).",
    verificationSteps: [
      "the worker logs 'risk engine enabled' and is not halted",
      "the control plane records risk → armed",
      "runtime state returns to HEALTHY",
    ],
  },
  "kill_switch.engaged": {
    key: "kill_switch.engaged",
    title: "Global Kill Switch Engaged",
    problem: "An operator has engaged the global kill switch — the runtime is STOPPED.",
    impact:
      "All trading/execution is disabled by deliberate operator action. Monitoring, health, and audit logging continue.",
    diagnosis:
      "Review the audit trail (/api/v1/control/audit) for who engaged it, when, and why. The kill switch is NEVER auto-recovered.",
    requiredAction:
      "Once the underlying reason is resolved, an authorized operator must explicitly POST /api/v1/control/resume with their identity and a reason.",
    verificationSteps: [
      "the kill switch reads disengaged",
      "a RESUME audit entry is recorded with actor + reason",
      "runtime state leaves STOPPED and re-evaluates to HEALTHY/DEGRADED",
    ],
  },
  "startup.failed": {
    key: "startup.failed",
    title: "Startup Validation Failed",
    problem:
      "Boot-time validation failed — a required dependency (database, redis, quant, schema, or freshness probes) was not satisfied. The runtime is FAILED and did not start trading.",
    impact:
      "Execution is UNARMED (fail-closed) — the system did not start partially. Signals may still flow for observability.",
    diagnosis:
      "Read the startup checks in the runtime-state detail to see which dependency failed, then follow that component's runbook.",
    requiredAction:
      "Resolve the failing dependency (see its runbook), then restart the worker so startup validation re-runs.",
    verificationSteps: [
      "every startup check passes",
      "runtime state transitions STARTING → HEALTHY",
      "execution is armed",
    ],
  },
};

/** Look up the runbook for a protection rule (or kill/startup key). */
export function runbookFor(key: RunbookKey): Runbook {
  return RUNBOOKS[key];
}

/**
 * The runbooks that apply RIGHT NOW given the active rule ids, the kill switch, and
 * whether startup failed — surfaced in the UI next to active incidents.
 */
export function applicableRunbooks(opts: {
  activeRuleIds: ProtectionRuleId[];
  killEngaged: boolean;
  startupFailed: boolean;
}): Runbook[] {
  const out: Runbook[] = [];
  if (opts.killEngaged) out.push(RUNBOOKS["kill_switch.engaged"]);
  if (opts.startupFailed) out.push(RUNBOOKS["startup.failed"]);
  for (const id of opts.activeRuleIds) out.push(RUNBOOKS[id]);
  return out;
}

/** Every runbook (catalog view). */
export function allRunbooks(): Runbook[] {
  return Object.values(RUNBOOKS);
}
