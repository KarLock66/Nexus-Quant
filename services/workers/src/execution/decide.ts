/**
 * Decision derivation (Phase 4) — the pure seam between observation and action.
 *
 * deriveDecisionEvent composes a versioned Strategy over a market observation
 * into a fully-lineaged DecisionEvent. It is PURE: no IO, no clock, no
 * randomness. The execution slot is always inert in Phase 4 (PENDING when the
 * intent is to act, SKIPPED otherwise) — the hook is present, wired to nothing.
 *
 * Lineage is assembled from the observation's persisted-artifact ids plus the
 * deciding strategy's version, so the resulting DecisionEvent is traceable end to
 * end and reconstructable from the persisted EngineSignal + strategy code alone.
 */

import type { Strategy, StrategyContext } from "./strategy.js";
import type {
  DecisionEvent,
  DecisionLineage,
  ExecutionPlan,
  SignalObservation,
} from "./types.js";

function executionFor(action: string): ExecutionPlan {
  return action === "ENTER"
    ? { status: "PENDING", detail: `execution hook reserved (no router wired in Phase 4)` }
    : { status: "SKIPPED", detail: `intent ${action} — nothing to execute` };
}

export function deriveDecisionEvent(
  observation: SignalObservation,
  strategy: Strategy,
  ctx: StrategyContext = {},
): DecisionEvent {
  const decision = strategy.decide(observation, ctx);

  const lineage: DecisionLineage = {
    ...(ctx.tickId !== undefined ? { tickId: ctx.tickId } : {}),
    strategyVersionId: observation.strategyVersionId,
    featureSnapshotId: observation.featureSnapshotId,
    dqReportId: observation.dqReportId,
    datasetHash: observation.datasetHash,
    featureHash: observation.featureHash,
    executionStrategyId: strategy.id,
    executionStrategyVersion: strategy.version,
  };

  return {
    signal: observation,
    decision,
    execution: executionFor(decision.action),
    lineage,
  };
}
