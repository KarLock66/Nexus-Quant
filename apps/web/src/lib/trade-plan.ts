import { buildTradePlan } from "@nexus/trading-plan";
import { getTradingDecisions } from "./trading-decision";
import { getKillSwitch, getRuntimeStateView } from "./control";
import type { ReadinessView, TradePlansView } from "./trade-plan-types";

/**
 * Server-only data layer for the Phase 10C-1 Actionable Decision Engine. It adds NO new
 * data gathering: it REUSES the existing decision assembler (`getTradingDecisions`, which
 * already reads the admitted EngineSignal + FeatureSnapshot + DQ + live mark + risk/control
 * context) plus the control-plane runtime state and kill switch, then runs the PURE
 * @nexus/trading-plan engine to derive an actionable TradePlan per symbol. No business logic
 * lives here and nothing is recomputed — the served TradingDecision is consumed verbatim.
 */

async function assemble(symbolsFilter?: string[]): Promise<{
  plans: ReturnType<typeof buildTradePlan>[];
  symbolsMissingPrice: string[];
}> {
  const now = Date.now();
  const [view, runtime, kill] = await Promise.all([
    getTradingDecisions(symbolsFilter),
    // Control plane is opt-in; absence is unknown (never an ALLOWED/HEALTHY default).
    getRuntimeStateView().catch(() => null),
    // Fail CLOSED on a read error for the hardest gate: a thrown kill-switch read is
    // treated as ENGAGED. (A missing row is a legitimate "never engaged" — getKillSwitch
    // returns engaged:false for that case without throwing.)
    getKillSwitch().catch(() => ({ engaged: true })),
  ]);

  const runtimeState = runtime?.current ?? null;
  const killEngaged = kill?.engaged ?? true;

  const plans = view.decisions.map((decision) =>
    buildTradePlan({
      now,
      decision,
      dqScore: view.dqScores[decision.signalId] ?? null,
      runtimeState,
      killEngaged,
    }),
  );

  return { plans, symbolsMissingPrice: view.symbolsMissingPrice };
}

/** GET /api/v1/signals/trade-plan — the actionable TradePlan per active symbol. */
export async function getTradePlans(symbolsFilter?: string[]): Promise<TradePlansView> {
  const { plans, symbolsMissingPrice } = await assemble(symbolsFilter);
  return { plans, count: plans.length, symbolsMissingPrice };
}

/** GET /api/v1/signals/readiness — the readiness score + action verdict per symbol. */
export async function getReadiness(symbolsFilter?: string[]): Promise<ReadinessView> {
  const { plans } = await assemble(symbolsFilter);
  const readiness = plans.map((p) => ({
    symbol: p.symbol,
    timeframe: p.timeframe,
    direction: p.direction,
    action: p.summary.action,
    score: p.readiness.score,
    band: p.readiness.band,
  }));
  return { readiness, count: readiness.length };
}
