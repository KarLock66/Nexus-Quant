import { prisma } from "@nexus/db";
import type {
  RiskBudgetRow,
  RiskEventRow,
  RiskLimitRow,
  RiskMode,
  RiskModeState,
  RiskOverview,
} from "./risk-overview-types";

/**
 * Server-only data layer for the Risk Engine page. Every value is read from real
 * persisted state (Prisma) — nothing is mocked or fabricated. The current risk
 * mode and the six hard limits are laid down by the base seed (`pnpm db:seed`);
 * RiskEvents and RiskBudgets stay empty until a detector fires / budgets are set,
 * which the UI renders as an explicit empty state (never invented data).
 */

const HISTORY_LIMIT = 20;
const EVENT_LIMIT = 25;

/** Coerce a Prisma Json column that should hold a string[] into one, safely. */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

type StateRow = {
  mode: RiskMode;
  reason: string;
  triggeredBy: string;
  ts: Date;
  approvalRequestId: string | null;
};

function toModeState(r: StateRow): RiskModeState {
  return {
    mode: r.mode,
    reason: r.reason,
    triggeredBy: r.triggeredBy,
    ts: r.ts.toISOString(),
    approvalRequestId: r.approvalRequestId,
  };
}

export async function getRiskOverview(): Promise<RiskOverview> {
  const [states, limits, events, budgets] = await Promise.all([
    prisma.systemRiskState.findMany({ orderBy: { ts: "desc" }, take: HISTORY_LIMIT }),
    prisma.riskLimit.findMany({ orderBy: { key: "asc" } }),
    prisma.riskEvent.findMany({ orderBy: { createdAt: "desc" }, take: EVENT_LIMIT }),
    prisma.riskBudget.findMany({ orderBy: { scope: "asc" } }),
  ]);

  const history = states.map(toModeState);

  const limitRows: RiskLimitRow[] = limits.map((l) => ({
    key: l.key,
    value: l.value.toString(),
    unit: l.unit,
    updatedBy: l.updatedBy,
    updatedAt: l.updatedAt.toISOString(),
  }));

  const eventRows: RiskEventRow[] = events.map((e) => ({
    id: e.id,
    type: e.type,
    severity: e.severity,
    detector: e.detector,
    symbol: e.symbol,
    actionsTaken: toStringArray(e.actionsTaken),
    createdAt: e.createdAt.toISOString(),
    resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
  }));

  const budgetRows: RiskBudgetRow[] = budgets.map((b) => ({
    scope: b.scope,
    budgetPct: b.budgetPct.toString(),
    usedPct: b.usedPct.toString(),
  }));

  return {
    current: history[0] ?? null,
    history,
    limits: limitRows,
    events: eventRows,
    budgets: budgetRows,
  };
}
