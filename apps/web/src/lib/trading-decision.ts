import { prisma } from "@nexus/db";
import { MIN_DATA_QUALITY_SCORE, TIMEFRAMES, type RiskMode, type Timeframe } from "@nexus/core";
import {
  buildTradingDecision,
  computeConsensus,
  rankOpportunities,
  resolveSignalParams,
  type Consensus,
  type ConsensusTimeframeInput,
  type ControlContext,
  type OpportunityBoard,
  type RiskContext,
  type SignalParams,
  type SignalProjection,
  type TradingDecision,
} from "@nexus/trading-decision";
import { getMarketView } from "./market-price";
import { getKillSwitch, getTradingPermissionView } from "./control";
import type { DecisionsView } from "./trading-decision-types";

/**
 * Server-only data layer for the Phase 10A-1 Trading Decision Center. READS the
 * persisted runtime — the admitted EngineSignal (+ its FeatureSnapshot / DataQualityReport
 * / strategyParams), the live mark (market-price.ts), the system risk mode, and the Phase
 * 9.7 control permission — and runs the PURE @nexus/trading-decision engine to derive an
 * actionable TradingDecision per symbol. No business logic lives here: it only gathers
 * inputs and serializes the engine's output. The decision/confidence are carried verbatim
 * from the signal engine; nothing is recomputed or fabricated.
 */

/** Assumed display equity (the web tier has no live account — see sizing provenance). */
const ASSUMED_EQUITY = Number(process.env.TRADING_DECISION_EQUITY_USD ?? 100_000);
const DEFAULT_LEVERAGE = 3;
const DEFAULT_RISK_FRACTION = 0.01;
/** How many recent EngineSignals to scan when selecting the latest per symbol. */
const SCAN_LIMIT = 200;

interface AssembledItem {
  decision: TradingDecision;
  dqScore: number;
  /** Origin venue of the admitting FeatureSnapshot ("DEMO" = synthetic lineage). */
  origin: string;
}

async function buildRiskContext(): Promise<RiskContext> {
  const [riskState, perTradeLimit] = await Promise.all([
    prisma.systemRiskState.findFirst({ orderBy: { ts: "desc" }, select: { mode: true } }),
    prisma.riskLimit.findUnique({ where: { key: "MAX_RISK_PER_TRADE" } }),
  ]);

  let riskFraction = DEFAULT_RISK_FRACTION;
  if (perTradeLimit) {
    const v = Number(perTradeLimit.value);
    if (Number.isFinite(v) && v > 0) {
      // Seed unit for MAX_RISK_PER_TRADE is "pct" (e.g. 1.0 = 1%); fall back to fraction.
      riskFraction = /pct/i.test(perTradeLimit.unit) ? v / 100 : v;
    }
  }
  riskFraction = Math.min(Math.max(riskFraction, 0), 0.5);

  return {
    assumedEquity: ASSUMED_EQUITY,
    riskFraction,
    leverage: DEFAULT_LEVERAGE,
    // Deterministic cap = buying power of the assumed account (no live book to read).
    maxNotional: ASSUMED_EQUITY * DEFAULT_LEVERAGE,
    systemRiskMode: (riskState?.mode as RiskMode | undefined) ?? null,
  };
}

async function buildControlContext(): Promise<ControlContext> {
  try {
    const [permission, kill] = await Promise.all([getTradingPermissionView(), getKillSwitch()]);
    return {
      permission: permission.permission,
      runtimeState: permission.state,
      killEngaged: kill.engaged,
      blockedReasons: permission.blockedBy.map((r) => `${r.label}: ${r.detail}`),
    };
  } catch {
    // Control plane unavailable / tables empty → unknown (never an ALLOWED default).
    return { permission: null, runtimeState: null, killEngaged: false, blockedReasons: [] };
  }
}

async function assemble(symbolsFilter?: string[]): Promise<{
  items: AssembledItem[];
  symbolsMissingPrice: string[];
}> {
  const now = Date.now();
  const [risk, control] = await Promise.all([buildRiskContext(), buildControlContext()]);

  const rows = await prisma.engineSignal.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SCAN_LIMIT,
    include: { featureSnapshot: { include: { dqReport: true } } },
  });

  // Latest EngineSignal per symbol (rows already newest-first).
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (symbolsFilter && !symbolsFilter.includes(r.symbol)) continue;
    if (!latest.has(r.symbol)) latest.set(r.symbol, r);
  }

  const items: AssembledItem[] = [];
  const symbolsMissingPrice: string[] = [];

  for (const row of latest.values()) {
    const fs = row.featureSnapshot;
    const params: SignalParams = resolveSignalParams(
      row.strategyParams as Record<string, unknown> | null,
    );
    const signal: SignalProjection = {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      decision: row.decision,
      confidence: Number(row.confidence),
      featureHash: row.featureHash,
      datasetHash: row.datasetHash,
      strategyVersionId: row.strategyVersionId,
      strategyParams: params,
      createdAt: row.createdAt.toISOString(),
    };

    const market = await getMarketView(row.symbol, now);
    if (market.price === null) symbolsMissingPrice.push(row.symbol);

    const decision = buildTradingDecision({
      now,
      signal,
      features: fs.features as unknown as Record<string, number>,
      featureTs: fs.ts.toISOString(),
      timeframe: fs.timeframe,
      dqScore: fs.dqReport.score,
      price: market.price,
      liquidity: market.liquidity,
      risk,
      control,
    });

    items.push({ decision, dqScore: fs.dqReport.score, origin: fs.exchange });
  }

  return { items, symbolsMissingPrice };
}

/** GET /api/v1/signals/decisions — the actionable TradingDecision per active symbol. */
export async function getTradingDecisions(symbolsFilter?: string[]): Promise<DecisionsView> {
  const { items, symbolsMissingPrice } = await assemble(symbolsFilter);
  // Pass through the DQ score + origin venue the data layer already read for each
  // admitting report/snapshot (keyed by signalId) — no recomputation; the sealed
  // TradingDecision shape is unchanged.
  const dqScores: Record<string, number> = {};
  const origins: Record<string, string> = {};
  for (const i of items) {
    dqScores[i.decision.signalId] = i.dqScore;
    origins[i.decision.signalId] = i.origin;
  }
  return {
    decisions: items.map((i) => i.decision),
    symbolsMissingPrice,
    count: items.length,
    dqScores,
    origins,
  };
}

/** GET /api/v1/signals/ranking — the opportunity board ranked across all decisions. */
export async function getOpportunityBoard(): Promise<OpportunityBoard> {
  const { items } = await assemble();
  return rankOpportunities(
    items.map((i) => ({ decision: i.decision, featureQuality: i.dqScore / 100 })),
  );
}

/**
 * GET /api/v1/signals/consensus?symbol= — multi-timeframe consensus for one symbol,
 * computed ONLY from timeframes that have a persisted FeatureSnapshot (others = no data).
 */
export async function getConsensus(symbol: string): Promise<Consensus> {
  const now = Date.now();

  // Resolve the strategy's params from the symbol's latest signal (else defaults).
  const latestSignal = await prisma.engineSignal.findFirst({
    where: { symbol },
    orderBy: { createdAt: "desc" },
    select: { strategyParams: true },
  });
  const params = resolveSignalParams(latestSignal?.strategyParams as Record<string, unknown> | null);

  const perTf = await Promise.all(
    TIMEFRAMES.map(async (timeframe: Timeframe): Promise<ConsensusTimeframeInput> => {
      const fs = await prisma.featureSnapshot.findFirst({
        where: { symbol, timeframe, dqReport: { score: { gte: MIN_DATA_QUALITY_SCORE } } },
        orderBy: { ts: "desc" },
        select: { features: true, ts: true },
      });
      return {
        timeframe,
        features: fs ? (fs.features as unknown as Record<string, number>) : null,
        ts: fs ? fs.ts.toISOString() : null,
        params,
      };
    }),
  );

  return computeConsensus(symbol, perTf, now);
}

/** Distinct symbols that currently have at least one admitted EngineSignal. */
export async function getDecisionSymbols(): Promise<string[]> {
  const rows = await prisma.engineSignal.findMany({
    distinct: ["symbol"],
    orderBy: { symbol: "asc" },
    select: { symbol: true },
  });
  return rows.map((r) => r.symbol);
}
