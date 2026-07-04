/**
 * Wire types for the Phase 10C-1 Actionable Decision Engine (the `DecisionTerminal` panels
 * and the `/api/v1/signals/{trade-plan,readiness}` API). The canonical shapes are pure +
 * browser-safe in `@nexus/trading-plan` and re-used verbatim here, so there is one source
 * of truth and Prisma never reaches the browser bundle. Every TradePlan value is already a
 * plain JSON-serializable number/string/null carrying its own provenance — no Decimal/Date
 * crosses the wire.
 */

import type { Action, ReadinessBand, SignalDecision, Timeframe, TradePlan } from "@nexus/trading-plan";

export type {
  Action,
  CheckStatus,
  ChecklistItem,
  DecisionSummary,
  ExecutionChecklist,
  Invalidation,
  InvalidationTrigger,
  Provenance,
  ReadinessBand,
  ReadinessComponent,
  RiskCategory,
  RiskChecklist,
  RiskField,
  RiskTag,
  TradePlan,
  TradeReadiness,
  TriggerState,
} from "@nexus/trading-plan";

/** Standard response envelope (mirrors the decisions/control/ops APIs). */
export interface ApiEnvelope<T> {
  data: T;
  generatedAt: string;
}

/** GET /api/v1/signals/trade-plan payload. */
export interface TradePlansView {
  plans: TradePlan[];
  count: number;
  /** Symbols with an admitted EngineSignal but no fresh mark (price-incomplete). */
  symbolsMissingPrice: string[];
}

/** One readiness row (lightweight subset of a full plan). */
export interface ReadinessRow {
  symbol: string;
  timeframe: Timeframe;
  direction: SignalDecision;
  action: Action;
  score: number;
  band: ReadinessBand;
}

/** GET /api/v1/signals/readiness payload. */
export interface ReadinessView {
  readiness: ReadinessRow[];
  count: number;
}
