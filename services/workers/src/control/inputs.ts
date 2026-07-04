/**
 * Phase 9.7 — gather the live {@link ControlInputs} snapshot the pure evaluators
 * consume. Freshness is read from the same persisted tables the Phase 9.6 monitor uses
 * (latest FeatureSnapshot / EngineSignal); execution freshness comes from the worker's
 * own in-memory last-fill marker (execution is event-sourced, not a DB table). Infra
 * health comes from the worker probes. `now` is captured once so the snapshot is a
 * consistent point-in-time input.
 */

import { prisma } from "@nexus/db";
import {
  FRESHNESS_BANDS,
  type ControlInputs,
  type FreshnessObservation,
  type KillSwitchState,
} from "@nexus/control";
import { probeDatabase, probeQuant, probeRedis } from "./probes.js";
import { getKillSwitch } from "./store.js";

export interface GatherDeps {
  redisUrl: string | undefined;
  quantUrl: string | undefined;
  /** Risk engine armed and not halted. */
  getRiskActive: () => boolean;
  /** Last time the execution stage produced a fill (null = never executed). */
  lastExecutionAt: Date | null;
  startupValidated: boolean;
}

function lag(now: number, ts: Date | null, band: { warningSeconds: number; staleSeconds: number }): FreshnessObservation {
  return {
    lagSeconds: ts === null ? null : Math.max(0, Math.round((now - ts.getTime()) / 1000)),
    warningSeconds: band.warningSeconds,
    staleSeconds: band.staleSeconds,
  };
}

export async function gatherControlInputs(deps: GatherDeps): Promise<ControlInputs> {
  const now = Date.now();

  // Infra probes + freshness reads run concurrently. Each read is defensive: a DB error
  // surfaces as a `null` freshness (handled fail-closed downstream) rather than throwing.
  const [db, redis, quant, featLast, sigLast, killSwitch] = await Promise.all([
    probeDatabase(),
    probeRedis(deps.redisUrl),
    probeQuant(deps.quantUrl),
    prisma.featureSnapshot
      .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
      .catch(() => null),
    prisma.engineSignal
      .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
      .catch(() => null),
    getKillSwitch().catch<KillSwitchState>(() => ({
      engaged: false,
      actor: null,
      reason: null,
      engagedAt: null,
    })),
  ]);

  return {
    now,
    database: db.health,
    redis: redis.health,
    quant: quant.health,
    features: lag(now, featLast?.createdAt ?? null, FRESHNESS_BANDS.features),
    signals: lag(now, sigLast?.createdAt ?? null, FRESHNESS_BANDS.signals),
    execution: lag(now, deps.lastExecutionAt, FRESHNESS_BANDS.execution),
    riskEngineActive: deps.getRiskActive(),
    killSwitch,
    startupValidated: deps.startupValidated,
  };
}
