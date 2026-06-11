/**
 * Canonical event catalog for the Redis pub/sub + BullMQ backbone.
 * Publisher/consumer helpers (ioredis) land in Phase 1 with ingestion;
 * Phase 0 fixes the names and payload contracts so no service invents its own.
 */

export const EVENTS = {
  DATA_CANDLE_INGESTED: "data.candle.ingested",
  DATA_QUALITY_REPORT: "data.quality.report",
  FEATURE_SNAPSHOT_CREATED: "feature.snapshot.created",
  REGIME_CHANGED: "regime.changed",
  SIGNAL_CANDIDATE_CREATED: "signal.candidate.created",
  SIGNAL_PUBLISHED: "signal.published",
  SIGNAL_REJECTED: "signal.rejected",
  SIGNAL_CAPACITY_DEFERRED: "signal.capacity.deferred",
  RISK_EVENT_RAISED: "risk.event.raised",
  RISK_MODE_CHANGED: "risk.mode.changed",
  CALIBRATION_DEVIATION: "calibration.deviation",
  GOVERNANCE_APPROVAL_REQUESTED: "governance.approval.requested",
  SYSTEM_HEALTH_DEGRADED: "system.health.degraded",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

import type {
  Exchange,
  GateType,
  MarketRegime,
  RiskMode,
  Timeframe,
} from "@nexus/core";

export interface EventPayloads {
  [EVENTS.DATA_CANDLE_INGESTED]: {
    exchange: Exchange;
    symbol: string;
    timeframe: Timeframe;
    ts: string;
  };
  [EVENTS.DATA_QUALITY_REPORT]: {
    reportId: string;
    exchange: Exchange;
    symbol: string;
    score: number;
    status: "PASSED" | "FAILED";
  };
  [EVENTS.FEATURE_SNAPSHOT_CREATED]: {
    snapshotId: string;
    symbol: string;
    timeframe: Timeframe;
    featureHash: string;
  };
  [EVENTS.REGIME_CHANGED]: {
    symbol: string;
    timeframe: Timeframe;
    from: MarketRegime | null;
    to: MarketRegime;
  };
  [EVENTS.SIGNAL_CANDIDATE_CREATED]: {
    candidateId: string;
    strategyVersionId: string;
  };
  [EVENTS.SIGNAL_PUBLISHED]: { signalId: string };
  [EVENTS.SIGNAL_REJECTED]: {
    candidateId: string;
    failedGates: GateType[];
  };
  [EVENTS.SIGNAL_CAPACITY_DEFERRED]: {
    signalId: string;
    bindingConstraint: string;
    capacityAssessmentId: string;
  };
  [EVENTS.RISK_EVENT_RAISED]: {
    riskEventId: string;
    type: string;
    severity: "INFO" | "WARNING" | "CRITICAL" | "EMERGENCY";
  };
  [EVENTS.RISK_MODE_CHANGED]: {
    from: RiskMode;
    to: RiskMode;
    reason: string;
  };
  [EVENTS.CALIBRATION_DEVIATION]: {
    strategyVersionId: string;
    metric: string;
    expected: number;
    actual: number;
  };
  [EVENTS.GOVERNANCE_APPROVAL_REQUESTED]: {
    approvalId: string;
    kind: string;
  };
  [EVENTS.SYSTEM_HEALTH_DEGRADED]: {
    component: string;
    detail: string;
  };
}

export interface EventEnvelope<N extends EventName = EventName> {
  name: N;
  payload: EventPayloads[N];
  /** ISO timestamp set by the publisher. */
  publishedAt: string;
  /** Correlation id for tracing a pipeline run end-to-end. */
  correlationId: string;
}
