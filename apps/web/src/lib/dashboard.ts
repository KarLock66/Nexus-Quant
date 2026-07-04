import { prisma } from "@nexus/db";
import type { DashboardOverview, DashboardSignal } from "./dashboard-types";

/**
 * Server-only data layer for the Dashboard. Composes a portfolio overview from
 * real persisted truth only: current risk mode (SystemRiskState), live signal
 * activity (EngineSignal), the latest portfolio snapshot (PortfolioSnapshot),
 * the strategy registry (StrategyVersion), and the latest data-quality result
 * (DataQualityReport). Sources with no rows yet return null/0 — never invented.
 */

const DAY_MS = 86_400_000;

/** Rows created by the demo bootstrap chain (labeled, never silently blended). */
const DEMO_CREATOR = "system:demo";

export async function getDashboardOverview(): Promise<DashboardOverview> {
  const since = new Date(Date.now() - DAY_MS);

  const [
    riskState,
    total,
    last24h,
    demoSignals,
    latest,
    snapshot,
    totalVersions,
    activeVersions,
    demoVersions,
    dq,
  ] = await Promise.all([
    prisma.systemRiskState.findFirst({ orderBy: { ts: "desc" } }),
    prisma.engineSignal.count(),
    prisma.engineSignal.count({ where: { createdAt: { gte: since } } }),
    prisma.engineSignal.count({ where: { featureSnapshot: { exchange: "DEMO" } } }),
    prisma.engineSignal.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5,
      select: {
        id: true,
        symbol: true,
        decision: true,
        confidence: true,
        createdAt: true,
        featureSnapshot: { select: { exchange: true } },
      },
    }),
    prisma.portfolioSnapshot.findFirst({
      orderBy: { ts: "desc" },
      include: { portfolio: true },
    }),
    // Strategy counts assert the PRODUCTION registry: demo-bootstrap rows are
    // counted separately and surfaced as an explicit qualifier, never blended.
    prisma.strategyVersion.count({ where: { createdBy: { not: DEMO_CREATOR } } }),
    prisma.strategyVersion.count({
      where: { status: "ACTIVE", createdBy: { not: DEMO_CREATOR } },
    }),
    prisma.strategyVersion.count({ where: { createdBy: DEMO_CREATOR } }),
    // Latest report from a REAL venue regardless of status — a PASSED-only filter
    // would dig up the last good report forever and could never show a failure;
    // DEMO-origin reports are synthetic fixtures and excluded outright.
    prisma.dataQualityReport.findFirst({
      where: { exchange: { not: "DEMO" } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const latestSignals: DashboardSignal[] = latest.map((s) => ({
    id: s.id,
    symbol: s.symbol,
    decision: s.decision,
    confidence: s.confidence.toString(),
    createdAt: s.createdAt.toISOString(),
    origin: s.featureSnapshot.exchange,
  }));

  return {
    risk: riskState
      ? { mode: riskState.mode, reason: riskState.reason, ts: riskState.ts.toISOString() }
      : null,
    signals: { total, last24h, demo: demoSignals, latest: latestSignals },
    portfolio: snapshot
      ? {
          name: snapshot.portfolio.name,
          baseCurrency: snapshot.portfolio.baseCurrency,
          equity: snapshot.equity.toString(),
          exposure: snapshot.exposure.toString(),
          drawdown: snapshot.drawdown.toString(),
          ts: snapshot.ts.toISOString(),
        }
      : null,
    strategies: { total: totalVersions, active: activeVersions, demo: demoVersions },
    dataQuality: dq
      ? {
          score: dq.score,
          status: dq.status,
          symbol: dq.symbol,
          createdAt: dq.createdAt.toISOString(),
        }
      : null,
  };
}
