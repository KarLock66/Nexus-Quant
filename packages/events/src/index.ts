/**
 * Canonical event catalog for the Redis pub/sub + BullMQ backbone.
 * Publisher/consumer helpers (ioredis) land in Phase 1 with ingestion;
 * Phase 0 fixes the names and payload contracts so no service invents its own.
 */

export const EVENTS = {
  DATA_CANDLE_INGESTED: "data.candle.ingested",
  DATA_OPTION_CHAIN_INGESTED: "data.options.chain.ingested",
  DATA_FLOW_INGESTED: "data.flow.ingested",
  // Phase 9 — live WebSocket feed: raw trade prints (ticks) and top-of-book/mark
  // snapshots persisted from the real exchange stream.
  DATA_TICK_INGESTED: "data.tick.ingested",
  DATA_ORDERBOOK_INGESTED: "data.orderbook.ingested",
  DATA_GAP_DETECTED: "data.gap.detected",
  DATA_QUALITY_REPORT: "data.quality.report",
  FEATURE_SNAPSHOT_CREATED: "feature.snapshot.created",
  REGIME_CHANGED: "regime.changed",
  SIGNAL_GENERATED: "signal.generated",
  // Phase 4 execution decision layer — the action intent derived from an
  // observation by a versioned strategy. Carried on the in-process bus today;
  // this name reserves the contract for the future Redis/BullMQ bridge.
  DECISION_MADE: "decision.made",
  SIGNAL_CANDIDATE_CREATED: "signal.candidate.created",
  SIGNAL_PUBLISHED: "signal.published",
  SIGNAL_REJECTED: "signal.rejected",
  SIGNAL_CAPACITY_DEFERRED: "signal.capacity.deferred",
  RISK_EVENT_RAISED: "risk.event.raised",
  RISK_MODE_CHANGED: "risk.mode.changed",
  CALIBRATION_DEVIATION: "calibration.deviation",
  GOVERNANCE_APPROVAL_REQUESTED: "governance.approval.requested",
  SYSTEM_HEALTH_DEGRADED: "system.health.degraded",
  // Phase 5 execution layer — the effectful tail of the lineage chain
  // (Signal -> Decision -> ExecutionIntent -> ExecutionResult). Emitted on the
  // in-process execution bus today; these names reserve the contracts for the
  // future Redis/BullMQ bridge, exactly as DECISION_MADE reserved Phase 4's.
  EXECUTION_INTENT_EMITTED: "execution.intent.emitted",
  EXECUTION_BLOCKED: "execution.blocked",
  EXECUTION_RESULT_RECORDED: "execution.result.recorded",
  // Phase 6 execution market-integration layer — the market edge BELOW the
  // execution result: a risk-approved ExecutionIntent becomes an Order, whose
  // lifecycle (request -> accept -> [partial] fill) folds into event-sourced
  // Position and Account state and is reconciled FAIL-CLOSED against the Phase 5
  // PortfolioState. Carried on the in-process market bus today; these names
  // reserve the contracts for the future Redis/BullMQ bridge, exactly as Phase 4
  // reserved DECISION_MADE and Phase 5 the EXECUTION_* contracts.
  MARKET_DATA_RECEIVED: "market.data.received",
  ORDER_REQUESTED: "order.requested",
  ORDER_SUBMITTED: "order.submitted",
  ORDER_ACCEPTED: "order.accepted",
  ORDER_PARTIALLY_FILLED: "order.partially.filled",
  ORDER_FILLED: "order.filled",
  ORDER_CANCELLED: "order.cancelled",
  ORDER_REJECTED: "order.rejected",
  POSITION_UPDATED: "position.updated",
  ACCOUNT_UPDATED: "account.updated",
  RECONCILIATION_FAILED: "reconciliation.failed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

import type {
  Exchange,
  GateType,
  MarketRegime,
  RiskMode,
  SignalDecision,
  Timeframe,
} from "@nexus/core";

export interface EventPayloads {
  [EVENTS.DATA_CANDLE_INGESTED]: {
    exchange: Exchange;
    symbol: string;
    timeframe: Timeframe;
    ts: string;
  };
  [EVENTS.DATA_OPTION_CHAIN_INGESTED]: {
    exchange: Exchange;
    underlying: string;
    ts: string;
    contractCount: number;
  };
  [EVENTS.DATA_FLOW_INGESTED]: {
    exchange: Exchange;
    symbol: string;
    kind: "FUNDING" | "OPEN_INTEREST" | "LONG_SHORT_RATIO";
    ts: string;
  };
  [EVENTS.DATA_TICK_INGESTED]: {
    exchange: Exchange;
    symbol: string;
    /** Number of trade prints persisted in this flush. */
    count: number;
    /** ISO timestamp of the latest tick in the flush. */
    ts: string;
  };
  [EVENTS.DATA_ORDERBOOK_INGESTED]: {
    exchange: Exchange;
    symbol: string;
    /** ISO timestamp of the snapshot. */
    ts: string;
    /** Best bid/ask + mark (quantized decimal strings). */
    bestBid: string;
    bestAsk: string;
    markPrice?: string;
  };
  [EVENTS.DATA_GAP_DETECTED]: {
    exchange: Exchange;
    symbol: string;
    timeframe: Timeframe;
    from: string;
    to: string;
    missingBars: number;
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
  [EVENTS.SIGNAL_GENERATED]: {
    signalId: string;
    symbol: string;
    decision: SignalDecision;
    /** Opaque Python-authoritative featureHash (never recomputed in TS). */
    featureHash: string;
  };
  [EVENTS.DECISION_MADE]: {
    symbol: string;
    /** Action intent: act / hold / explicitly stand aside. */
    action: "ENTER" | "HOLD" | "STAND_ASIDE";
    /** Directional bias carried verbatim from the observation. */
    side: SignalDecision;
    /** Quantized 4dp conviction carried verbatim from the observation. */
    confidence: string;
    /** Observation lineage (the EngineSignal this decision derives from). */
    strategyVersionId: string;
    featureSnapshotId: string;
    /** The execution strategy that decided (logical id + version). */
    executionStrategyId: string;
    executionStrategyVersion: number;
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
    /** Failure taxonomy (P1): INFRA = component unavailable; AUTH = misconfig. */
    category: "INFRA" | "AUTH";
    /** AUTH -> CRITICAL (config error, fail-fast); INFRA -> WARN (degraded). */
    severity: "WARN" | "CRITICAL";
    detail: string;
  };
  [EVENTS.EXECUTION_INTENT_EMITTED]: {
    intentId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    action: "ENTER";
    /** Target notional exposure (quantized decimal string, capital units). */
    targetNotional: string;
    /** Adapter that will execute the intent (paper | simulated | real). */
    adapterId: string;
    /** Lineage back to the observation that ultimately produced the intent. */
    strategyVersionId: string;
    featureSnapshotId: string;
    executionStrategyId: string;
    executionStrategyVersion: number;
  };
  [EVENTS.EXECUTION_BLOCKED]: {
    symbol: string;
    side: "LONG" | "SHORT";
    targetNotional: string;
    /** Why the global risk gate refused to emit an ExecutionIntent. */
    reason: string;
    detail: string;
    strategyVersionId: string;
    featureSnapshotId: string;
  };
  [EVENTS.EXECUTION_RESULT_RECORDED]: {
    intentId: string;
    symbol: string;
    side: "LONG" | "SHORT";
    status: "FILLED" | "REJECTED";
    filledNotional: string;
    adapterId: string;
    strategyVersionId: string;
    featureSnapshotId: string;
  };
  // ── Phase 6 — Market Integration Layer ──────────────────────────────────────
  // Decimal-like fields travel as quantized strings (prices/qty 8dp, notional/PnL
  // 2dp), exactly as the rest of the catalog avoids float drift across borders.
  [EVENTS.MARKET_DATA_RECEIVED]: {
    symbol: string;
    /** ISO timestamp of the quote (point-in-time). */
    ts: string;
    /** Reference price (quantized decimal string). */
    price: string;
    /** Which provider sourced it (deterministic vs live edge). */
    providerMode: "historical" | "replay" | "realtime";
  };
  [EVENTS.ORDER_REQUESTED]: {
    orderId: string;
    intentId: string;
    symbol: string;
    side: "BUY" | "SELL";
    /** Order quantity (quantized decimal string). */
    qty: string;
    /** Reference price the order was sized against (quantized). */
    price: string;
    brokerId: string;
    /** Lineage back to the observation that produced the intent. */
    strategyVersionId: string;
    featureSnapshotId: string;
    executionStrategyId: string;
    executionStrategyVersion: number;
  };
  [EVENTS.ORDER_SUBMITTED]: {
    orderId: string;
    intentId: string;
    symbol: string;
    brokerId: string;
  };
  [EVENTS.ORDER_ACCEPTED]: {
    orderId: string;
    intentId: string;
    symbol: string;
    brokerId: string;
  };
  [EVENTS.ORDER_PARTIALLY_FILLED]: {
    orderId: string;
    intentId: string;
    symbol: string;
    side: "BUY" | "SELL";
    /** This fill's quantity and price (quantized). */
    fillQty: string;
    fillPrice: string;
    /** Cumulative filled quantity after this fill (quantized). */
    cumQty: string;
    brokerId: string;
  };
  [EVENTS.ORDER_FILLED]: {
    orderId: string;
    intentId: string;
    symbol: string;
    side: "BUY" | "SELL";
    fillQty: string;
    fillPrice: string;
    cumQty: string;
    brokerId: string;
  };
  [EVENTS.ORDER_CANCELLED]: {
    orderId: string;
    intentId: string;
    symbol: string;
    reason: string;
    brokerId: string;
  };
  [EVENTS.ORDER_REJECTED]: {
    orderId: string;
    intentId: string;
    symbol: string;
    reason: string;
    brokerId: string;
  };
  [EVENTS.POSITION_UPDATED]: {
    symbol: string;
    side: "LONG" | "SHORT" | "FLAT";
    /** Signed net quantity (quantized decimal string; sign encodes side). */
    netQty: string;
    avgEntryPrice: string;
    markPrice: string;
    realizedPnl: string;
    unrealizedPnl: string;
    /** Lineage back to the observation behind the latest fill. */
    strategyVersionId: string;
    featureSnapshotId: string;
  };
  [EVENTS.ACCOUNT_UPDATED]: {
    cashBalance: string;
    equity: string;
    marginUsed: string;
    buyingPower: string;
    realizedPnl: string;
    unrealizedPnl: string;
    grossExposure: string;
  };
  [EVENTS.RECONCILIATION_FAILED]: {
    symbol: string;
    /** Broker-side net exposure (|netQty| * mark, quantized). */
    brokerNotional: string;
    brokerSide: "LONG" | "SHORT" | "FLAT";
    /** Phase 5 portfolio-side recorded exposure (quantized). */
    portfolioNotional: string;
    portfolioSide: "LONG" | "SHORT" | "FLAT";
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
