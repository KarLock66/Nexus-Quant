/**
 * Wire types for the Phase 10A-1 Trading Decision Center (the upgraded `/signals` page
 * and the `/api/v1/signals/{decisions,consensus,ranking}` API). The canonical decision
 * shapes are pure + browser-safe in `@nexus/trading-decision` and re-used verbatim here,
 * so there is one source of truth and Prisma never reaches the browser bundle. Every
 * TradingDecision value is already a plain JSON-serializable number/string/null carrying
 * its own provenance tag — no Decimal/Date crosses the wire.
 */

import type { Consensus, OpportunityBoard, TradingDecision } from "@nexus/trading-decision";

export type {
  Consensus,
  ConsensusTimeframe,
  OpportunityBoard,
  RankedDecision,
  TradingDecision,
  Measure,
  Provenance,
} from "@nexus/trading-decision";

/** Standard response envelope (mirrors the control/ops APIs). */
export interface ApiEnvelope<T> {
  data: T;
  generatedAt: string;
}

/** GET /api/v1/signals/decisions payload. */
export interface DecisionsView {
  decisions: TradingDecision[];
  /** Symbols with an admitted EngineSignal but no fresh mark (price-incomplete). */
  symbolsMissingPrice: string[];
  count: number;
  /**
   * Per-decision DataQualityReport score (0..100) of the admitting report, keyed by
   * `TradingDecision.signalId`. A verbatim pass-through of the value the decisions data
   * layer already reads (`featureSnapshot.dqReport.score`) — surfaced for the terminal's
   * Market Analysis panel, NOT recomputed and NOT part of the sealed TradingDecision shape.
   */
  dqScores: Record<string, number>;
  /**
   * Origin venue of each decision's admitting FeatureSnapshot, keyed by
   * `TradingDecision.signalId` ("DEMO" = synthetic bootstrap lineage). A verbatim
   * pass-through like `dqScores` so the terminal can LABEL demo-derived decisions —
   * additive; optional for older fixtures/tests.
   */
  origins?: Record<string, string>;
}

/** GET /api/v1/signals/consensus?symbol= payload. */
export type ConsensusView = Consensus;

/** GET /api/v1/signals/ranking payload. */
export type RankingView = OpportunityBoard;
