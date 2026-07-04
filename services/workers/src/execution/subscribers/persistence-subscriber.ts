/**
 * Persistence subscriber (Phase 4) — the audit/replay sink on the event bus.
 *
 * Subscribes to DecisionEvents and persists their OBSERVATION (the EngineSignal)
 * via the unchanged, idempotent `persistEngineSignal` — so the EngineSignal table
 * remains the single source of truth and every prior persistence guarantee
 * (idempotent upsert on (featureSnapshotId, strategyVersionId), P2002 race
 * resolution, fail-closed rethrow) is preserved verbatim. The decision intent is
 * NOT persisted: it is a pure, reproducible function of this observation plus the
 * versioned strategy, so recording the observation loses no decision lineage.
 *
 * This is what removes the tick loop's direct coupling to persistence: the
 * orchestrator publishes; this subscriber writes.
 */

import type { PrismaClient } from "@nexus/db";
import { persistEngineSignal } from "../../signal/persistence.js";
import type { DecisionHandler } from "../bus.js";
import type { DecisionEvent } from "../types.js";

export type SubscriberLog = (
  level: "info" | "warn" | "error",
  msg: string,
  extra?: object,
) => void;

export interface PersistenceSubscriberDeps {
  prisma: PrismaClient;
  log: SubscriberLog;
}

export function createPersistenceSubscriber(
  deps: PersistenceSubscriberDeps,
): DecisionHandler {
  const { prisma, log } = deps;
  return async (event: DecisionEvent): Promise<void> => {
    const persisted = await persistEngineSignal(prisma, event.signal);
    log("info", "engine signal persisted", {
      tickId: event.lineage.tickId,
      signalId: persisted.id,
      symbol: persisted.symbol,
      side: event.signal.side,
      decision: persisted.decision,
      confidence: persisted.confidence,
      featureSnapshotId: event.lineage.featureSnapshotId,
      strategyVersionId: event.lineage.strategyVersionId,
      featureHash: event.signal.featureHash,
      lineageValid: true,
      // decision-layer lineage (audit): which strategy decided, and the intent.
      executionStrategy: `${event.lineage.executionStrategyId}@v${event.lineage.executionStrategyVersion}`,
      action: event.decision.action,
      execution: event.execution?.status ?? null,
    });
  };
}
