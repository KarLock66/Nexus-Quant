/**
 * Wire types for the Phase 10C-2A Portfolio Intelligence Engine (the `/api/v1/portfolio/*`
 * API). The canonical shapes are pure + browser-safe in `@nexus/portfolio-intelligence` and
 * re-used verbatim here, so there is one source of truth and Prisma never reaches the browser
 * bundle. Every value is already a plain JSON-serializable number/string/null carrying its own
 * provenance — no Decimal/Date crosses the wire.
 */

import type {
  CapitalAllocation,
  PortfolioExposure,
  PortfolioHealth,
  PortfolioStatistics,
  PortfolioSummary,
  PortfolioWarnings,
  RiskHeat,
} from "@nexus/portfolio-intelligence";

export type {
  AllocationRef,
  CapitalAllocation,
  ConfidenceBucket,
  ExposureBuckets,
  ExposureGroup,
  HeatBand,
  HeatComponent,
  PortfolioDistribution,
  PortfolioExposure,
  PortfolioHealth,
  PortfolioMeasure,
  PortfolioPosition,
  PortfolioState,
  PortfolioStatistics,
  PortfolioStatus,
  PortfolioSummary,
  PortfolioWarning,
  PortfolioWarnings,
  PositionState,
  Provenance,
  RiskHeat,
  SignalDecision,
  StatRef,
  SymbolAllocation,
  WarningSeverity,
  WarningSource,
} from "@nexus/portfolio-intelligence";

/** Standard response envelope (mirrors the decisions/control/ops APIs). */
export interface ApiEnvelope<T> {
  data: T;
  generatedAt: string;
}

/** GET /api/v1/portfolio/summary payload — the top-line state + statistics + allocation. */
export interface PortfolioSummaryView {
  summary: PortfolioSummary;
  statistics: PortfolioStatistics;
  allocation: CapitalAllocation;
  /** Symbols with an admitted EngineSignal but no fresh mark (price-incomplete). */
  symbolsMissingPrice: string[];
}

/** GET /api/v1/portfolio/exposure payload — the book sliced every documented way + heat. */
export interface PortfolioExposureView {
  exposure: PortfolioExposure;
  heat: RiskHeat;
}

/** GET /api/v1/portfolio/health payload — the overall verdict + warnings. */
export interface PortfolioHealthView {
  health: PortfolioHealth;
  warnings: PortfolioWarnings;
}
