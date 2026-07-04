/**
 * Wire types for the Risk Engine page.
 *
 * Pure types only — NO runtime imports (mirrors `system-monitoring-types.ts`),
 * so Prisma is never pulled into the browser bundle. Every value here is sourced
 * from a real persisted table: SystemRiskState, RiskLimit, RiskEvent, RiskBudget.
 */

export type RiskMode = "NORMAL" | "ELEVATED" | "RISK_OFF" | "FROZEN";

/** A single SystemRiskState row (current mode or a point in its history). */
export interface RiskModeState {
  mode: RiskMode;
  reason: string;
  triggeredBy: string; // detector name or user id
  ts: string; // ISO
  approvalRequestId: string | null; // present for de-escalation from RISK_OFF/FROZEN
}

/** A RiskLimit row — decimal carried verbatim as a string (no float drift). */
export interface RiskLimitRow {
  key: string; // DAILY_DD | MAX_PORTFOLIO_EXPOSURE | ...
  value: string;
  unit: string; // pct | usd
  updatedBy: string;
  updatedAt: string; // ISO
}

/** A RiskEvent row — what a detector fired and the actions it triggered. */
export interface RiskEventRow {
  id: string;
  type: string; // RiskEventType
  severity: string; // INFO | WARNING | CRITICAL | EMERGENCY
  detector: string;
  symbol: string | null;
  actionsTaken: string[];
  createdAt: string; // ISO
  resolvedAt: string | null; // ISO
}

/** A RiskBudget row (M9) — utilization per strategy/asset/regime scope. */
export interface RiskBudgetRow {
  scope: string;
  budgetPct: string;
  usedPct: string;
}

/** Composite payload for GET /api/v1/risk/overview. */
export interface RiskOverview {
  current: RiskModeState | null; // null only before the base seed runs
  history: RiskModeState[]; // newest first
  limits: RiskLimitRow[];
  events: RiskEventRow[]; // newest first (empty until a detector fires)
  budgets: RiskBudgetRow[]; // empty until M9 budgets are configured
}
