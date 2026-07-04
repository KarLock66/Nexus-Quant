/**
 * Wire types for the Dashboard (portfolio overview at a glance).
 *
 * Pure types only — NO runtime imports. Each field maps to a real persisted
 * table: SystemRiskState, EngineSignal, PortfolioSnapshot, StrategyVersion,
 * DataQualityReport. Anything not yet produced by the runtime (e.g. no portfolio
 * snapshot) is `null`, rendered by the UI as an explicit "unavailable" tile.
 */

import type { RiskMode } from "./risk-overview-types";

export interface DashboardSignal {
  id: string;
  symbol: string;
  decision: string;
  confidence: string;
  createdAt: string; // ISO
  /** Origin venue of the admitting FeatureSnapshot; "DEMO" = synthetic lineage. */
  origin: string;
}

export interface DashboardOverview {
  /** Latest SystemRiskState (seeded by base seed; null only pre-seed). */
  risk: { mode: RiskMode; reason: string; ts: string } | null;
  /** EngineSignal rollup; `demo` counts signals from the synthetic DEMO lineage. */
  signals: { total: number; last24h: number; demo: number; latest: DashboardSignal[] };
  /** Latest PortfolioSnapshot — null until paper execution writes one. */
  portfolio: {
    name: string;
    baseCurrency: string;
    equity: string;
    exposure: string;
    drawdown: string;
    ts: string;
  } | null;
  /**
   * StrategyVersion counts of the PRODUCTION registry (demo-bootstrap rows are
   * counted separately in `demo`, never blended into total/active).
   */
  strategies: { total: number; active: number; demo: number };
  /**
   * Latest DataQualityReport from a REAL venue, regardless of status (a failing
   * pipeline shows its failure honestly). Null until a real-venue report exists.
   */
  dataQuality: { score: number; status: string; symbol: string; createdAt: string } | null;
}
