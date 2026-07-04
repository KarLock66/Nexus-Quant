/**
 * EngineSignal persistence + orchestration (STEP 15 / 16).
 *
 * runSignalEngine = generate (pure) -> persist (only on success) -> publish
 * signal.generated. Persistence is idempotent on (featureSnapshotId,
 * strategyVersionId): one deterministic decision per (snapshot, strategy).
 * Failures are logged and rethrown (fail-closed). REFUSED generations persist
 * nothing — no silent fallback.
 */

import { Prisma } from "@nexus/db";
import type { PrismaClient } from "@nexus/db";
import { EVENTS } from "@nexus/events";
import { generateSignal } from "./engine.js";
import type { GeneratedSignal, SignalEngineInput } from "./types.js";
import { errMsg, log } from "../lib/log.js";

export interface PersistedEngineSignal {
  id: string;
  symbol: string;
  decision: GeneratedSignal["decision"];
  confidence: string;
}

export async function persistEngineSignal(
  prisma: PrismaClient,
  signal: GeneratedSignal,
): Promise<PersistedEngineSignal> {
  try {
    const row = await prisma.engineSignal.upsert({
      where: {
        featureSnapshotId_strategyVersionId: {
          featureSnapshotId: signal.featureSnapshotId,
          strategyVersionId: signal.strategyVersionId,
        },
      },
      create: {
        symbol: signal.symbol,
        side: signal.side,
        decision: signal.decision,
        confidence: new Prisma.Decimal(signal.confidence),
        strategyVersionId: signal.strategyVersionId,
        strategyParams: signal.strategyParams as unknown as Prisma.InputJsonValue,
        featureSnapshotId: signal.featureSnapshotId,
        dqReportId: signal.dqReportId,
        datasetHash: signal.datasetHash,
        featureHash: signal.featureHash,
      },
      update: {
        side: signal.side,
        decision: signal.decision,
        confidence: new Prisma.Decimal(signal.confidence),
        strategyParams: signal.strategyParams as unknown as Prisma.InputJsonValue,
        dqReportId: signal.dqReportId,
        datasetHash: signal.datasetHash,
        featureHash: signal.featureHash,
      },
      select: { id: true, symbol: true, decision: true, confidence: true },
    });
    return {
      id: row.id,
      symbol: row.symbol,
      decision: row.decision,
      confidence: String(row.confidence),
    };
  } catch (err) {
    // Concurrent-writer race: two ticks (or a tick + e2e run) raced the same
    // (featureSnapshotId, strategyVersionId). The unique index already prevented
    // a duplicate row; resolve idempotently to the existing one instead of
    // failing. Decision is deterministic for that key, so the winner is correct.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.engineSignal.findUnique({
        where: {
          featureSnapshotId_strategyVersionId: {
            featureSnapshotId: signal.featureSnapshotId,
            strategyVersionId: signal.strategyVersionId,
          },
        },
        select: { id: true, symbol: true, decision: true, confidence: true },
      });
      if (existing) {
        log("warn", "engine signal upsert raced — resolved to existing row", {
          signalId: existing.id,
          featureSnapshotId: signal.featureSnapshotId,
          strategyVersionId: signal.strategyVersionId,
        });
        return {
          id: existing.id,
          symbol: existing.symbol,
          decision: existing.decision,
          confidence: String(existing.confidence),
        };
      }
    }
    log("error", "failed to persist engine signal", {
      featureSnapshotId: signal.featureSnapshotId,
      strategyVersionId: signal.strategyVersionId,
      error: errMsg(err),
    });
    throw err;
  }
}

export interface SignalEngineDeps {
  prisma: PrismaClient;
  publish?: (name: string, payload: object) => Promise<void>;
}

export type RunSignalEngineResult =
  | { status: "GENERATED"; signal: PersistedEngineSignal }
  | { status: "REFUSED"; reason: string };

export async function runSignalEngine(
  deps: SignalEngineDeps,
  input: SignalEngineInput,
): Promise<RunSignalEngineResult> {
  const generated = generateSignal(input);
  if (generated.status === "REFUSED") {
    log("warn", "signal engine refused", {
      featureSnapshotId: input.featureSnapshot.id,
      reason: generated.reason,
    });
    return { status: "REFUSED", reason: generated.reason };
  }

  const persisted = await persistEngineSignal(deps.prisma, generated.signal);

  log("info", "engine signal persisted", {
    signalId: persisted.id,
    symbol: persisted.symbol,
    side: generated.signal.side,
    decision: persisted.decision,
    confidence: persisted.confidence,
    featureSnapshotId: input.featureSnapshot.id,
    strategyVersionId: input.strategyVersion.id,
    featureHash: generated.signal.featureHash,
  });

  if (deps.publish) {
    await deps.publish(EVENTS.SIGNAL_GENERATED, {
      signalId: persisted.id,
      symbol: persisted.symbol,
      decision: persisted.decision,
      featureHash: generated.signal.featureHash,
    });
  }

  return { status: "GENERATED", signal: persisted };
}
