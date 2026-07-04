/**
 * ExecutionIntent derivation (Phase 5) — the pure seam between a risk-APPROVED
 * portfolio allocation and the effectful adapter edge.
 *
 * `deriveExecutionIntent` is PURE: no IO, no clock, no randomness. The intent id
 * is a deterministic hash of the intent's ECONOMIC content + its lineage (NOT the
 * tickId), so the same allocation always yields the same intent id across ticks
 * and runs — replay-compatible by construction. Full lineage is threaded from the
 * allocation's dominant (primary) contributor plus the lossless contribution set.
 *
 * Callers MUST only invoke this after the risk gate approves the allocation; the
 * stage enforces that ordering so no intent can exist without a passing risk check.
 */

import { createHash } from "node:crypto";
import type {
  ExecutionIntent,
  ExecutionLineage,
  ProposedAllocation,
} from "./types.js";

/** Read-only context (lineage that is contextual, not part of intent identity). */
export interface IntentContext {
  /** Correlation id of the producing tick, when available. */
  tickId?: string;
}

/**
 * Deterministic 16-hex-char id over canonical, flat key/value parts. sha256 keyed
 * by sorted keys; pure (same parts -> same id, forever). 64 bits of hex is ample
 * to identify an intent without collision in this domain.
 */
function deterministicId(parts: Record<string, string | number>): string {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export function deriveExecutionIntent(
  proposal: ProposedAllocation,
  adapterId: string,
  ctx: IntentContext = {},
): ExecutionIntent {
  // The owning contributor (side agrees with the net direction; deterministic).
  const primary = proposal.primary;
  // A stable digest of EVERY contribution's FULL lineage (already in canonical
  // order), so the intent id is a function of the complete contribution set —
  // distinct lineage sets can never collide to the same id.
  const contributionKey = proposal.contributions
    .map(
      (c) =>
        `${c.featureSnapshotId}:${c.strategyVersionId}:${c.executionStrategyId}@v${c.executionStrategyVersion}:${c.side}:${c.confidence}:${c.weightedNotional}:${c.dqReportId}:${c.datasetHash}:${c.featureHash}`,
    )
    .join("|");

  // tickId is deliberately EXCLUDED from identity: the same economic intent has
  // the same id regardless of which tick produced it (strong replay determinism).
  const intentId = deterministicId({
    symbol: proposal.symbol,
    side: proposal.side,
    action: "ENTER",
    targetNotional: proposal.targetNotional,
    adapterId,
    strategyVersionId: primary.strategyVersionId,
    featureSnapshotId: primary.featureSnapshotId,
    dqReportId: primary.dqReportId,
    datasetHash: primary.datasetHash,
    featureHash: primary.featureHash,
    executionStrategyId: primary.executionStrategyId,
    executionStrategyVersion: primary.executionStrategyVersion,
    netScore: proposal.netScore,
    contributionKey,
  });

  const lineage: ExecutionLineage = {
    ...(ctx.tickId !== undefined ? { tickId: ctx.tickId } : {}),
    strategyVersionId: primary.strategyVersionId,
    featureSnapshotId: primary.featureSnapshotId,
    dqReportId: primary.dqReportId,
    datasetHash: primary.datasetHash,
    featureHash: primary.featureHash,
    executionStrategyId: primary.executionStrategyId,
    executionStrategyVersion: primary.executionStrategyVersion,
    intentId,
    netScore: proposal.netScore,
    contributions: proposal.contributions,
  };

  return {
    intentId,
    symbol: proposal.symbol,
    side: proposal.side,
    action: "ENTER",
    targetNotional: proposal.targetNotional,
    adapterId,
    lineage,
    rationale: `ENTER ${proposal.side} ${proposal.symbol} notional ${proposal.targetNotional} via ${adapterId} (net ${proposal.netScore} from ${proposal.contributions.length} decision(s))`,
  };
}
