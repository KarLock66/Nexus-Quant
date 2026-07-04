/**
 * PHASE 4 — Replay determinism.
 *
 * Identical inputs must yield identical outputs at three levels:
 *   1. pure engine    : generateSignal(input) twice -> identical side/decision/confidence
 *   2. persistence    : two pipeline ticks -> SAME row id + identical decision per
 *                       (featureSnapshotId, strategyVersionId)
 *   3. replay         : replayEngineSignal over the persisted row -> full MATCH
 *                       (recomputes the decision from persisted feature values;
 *                        featureHash/datasetHash are compared verbatim, never recomputed)
 *
 * Fail-closed: any divergence between the two runs is a failure.
 */

import { ensureSignalDemoChain, prisma } from "@nexus/db";
import { runSignalPipelineTick } from "../pipeline/orchestrator.js";
import {
  generateSignal,
  quantizeConfidence,
  replayEngineSignal,
} from "../signal/index.js";
import type {
  PersistedSignal,
  SignalDataQualityReport,
  SignalFeatureSnapshot,
  SignalParams,
  SignalStrategyVersion,
} from "../signal/index.js";
import {
  assert,
  demoRows,
  DEMO_SNAPSHOT_IDS,
  log,
  makeLog,
} from "./lib.js";

export async function runPhase4(): Promise<void> {
  log("info", "PHASE 4 — replay determinism");
  const quiet = makeLog("warn");

  const chain = await ensureSignalDemoChain(prisma);
  const strategyVersion: SignalStrategyVersion = {
    id: chain.strategyVersion.id,
    parameters: chain.strategyVersion.parameters,
  };

  const snaps = await prisma.featureSnapshot.findMany({
    where: { id: { in: [...DEMO_SNAPSHOT_IDS] } },
    include: { dqReport: true },
  });
  assert(snaps.length === 2, `expected 2 demo snapshots, found ${snaps.length}`);

  // ── Level 1: pure engine determinism ────────────────────────────────────────
  for (const snap of snaps) {
    const featureSnapshot: SignalFeatureSnapshot = {
      id: snap.id,
      symbol: snap.symbol,
      featureHash: snap.featureHash,
      features: snap.features as unknown as Record<string, number>,
    };
    const dqReport: SignalDataQualityReport = {
      id: snap.dqReport.id,
      score: snap.dqReport.score,
      status: snap.dqReport.status,
      datasetHash: snap.dqReport.datasetHash,
    };
    const a = generateSignal({ featureSnapshot, dqReport, strategyVersion });
    const b = generateSignal({ featureSnapshot, dqReport, strategyVersion });
    assert(
      a.status === "GENERATED" && b.status === "GENERATED",
      `engine refused for ${snap.symbol} (expected GENERATED both runs)`,
    );
    if (a.status === "GENERATED" && b.status === "GENERATED") {
      assert(a.signal.decision === b.signal.decision, `decision nondeterministic for ${snap.symbol}`);
      assert(a.signal.side === b.signal.side, `side nondeterministic for ${snap.symbol}`);
      assert(
        a.signal.confidence === b.signal.confidence,
        `confidence nondeterministic for ${snap.symbol}`,
      );
    }
  }

  // ── Level 2: persistence determinism (same input batch twice) ───────────────
  // demoBootstrap explicit — self-owning, env-independent (see phase1 note / F1).
  await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase4-a", demoBootstrap: true });
  const first = await demoRows();
  await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase4-b", demoBootstrap: true });
  const second = await demoRows();
  assert(first.length === 2 && second.length === 2, "expected 2 rows on both runs");

  const firstBySnap = new Map(first.map((r) => [r.featureSnapshotId, r]));
  for (const r of second) {
    const f = firstBySnap.get(r.featureSnapshotId);
    assert(f !== undefined, `snapshot ${r.featureSnapshotId} missing from first run`);
    if (f !== undefined) {
      assert(
        f.id === r.id,
        `row id changed across identical runs for ${r.featureSnapshotId} (nondeterministic persistence)`,
      );
      assert(
        f.decision === r.decision && f.side === r.side && f.confidence === r.confidence,
        `output changed across identical runs for ${r.featureSnapshotId}`,
      );
    }
  }

  // ── Level 3: replay equivalence over the persisted rows ─────────────────────
  for (const r of second) {
    const snap = snaps.find((s) => s.id === r.featureSnapshotId);
    assert(snap !== undefined, `snapshot ${r.featureSnapshotId} vanished`);
    if (snap === undefined) continue;

    const persistedSignal: PersistedSignal = {
      id: r.id,
      symbol: snap.symbol,
      side: r.side as PersistedSignal["side"],
      decision: r.decision as PersistedSignal["decision"],
      // Decimal(5,4) -> canonical 4-decimal string the engine compares.
      confidence: quantizeConfidence(Number(r.confidence)),
      strategyVersionId: r.strategyVersionId,
      strategyParams: chain.strategyVersion.parameters as unknown as SignalParams,
      featureSnapshotId: r.featureSnapshotId,
      dqReportId: r.dqReportId,
      datasetHash: r.datasetHash,
      featureHash: r.featureHash,
    };
    const replay = replayEngineSignal({
      signal: persistedSignal,
      featureSnapshot: {
        id: snap.id,
        symbol: snap.symbol,
        featureHash: snap.featureHash,
        features: snap.features as unknown as Record<string, number>,
      },
      dqReport: {
        id: snap.dqReport.id,
        score: snap.dqReport.score,
        status: snap.dqReport.status,
        datasetHash: snap.dqReport.datasetHash,
      },
      strategyVersion,
    });
    const fullMatch =
      replay.replayResult === "MATCH" &&
      replay.decisionMatch &&
      replay.confidenceMatch &&
      replay.sideMatch &&
      replay.lineageMatch;
    assert(
      fullMatch,
      `replay not a full match for ${r.featureSnapshotId}: ${replay.replayResult} — ${replay.detail}`,
    );
  }

  log("info", "PHASE 4 PASS", {
    note: "pure engine, persistence, and replay are all deterministic for identical inputs",
  });
}
