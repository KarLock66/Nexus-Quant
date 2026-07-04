import { buildTradePlan } from "@nexus/trading-plan";
import { buildPortfolioState, type PortfolioItem } from "@nexus/portfolio-intelligence";
import { getTradingDecisions } from "./trading-decision";
import { getKillSwitch, getRuntimeStateView, getTradingPermissionView } from "./control";
import type {
  PortfolioExposureView,
  PortfolioHealthView,
  PortfolioSummaryView,
} from "./portfolio-types";

/**
 * Server-only data layer for the Phase 10C-2A Portfolio Intelligence Engine. It adds NO new
 * data gathering: it REUSES the existing decision assembler (`getTradingDecisions`) + the
 * trade-plan engine (`buildTradePlan`) to produce the served decision/plan pairs, plus the
 * control-plane runtime state, permission and kill switch, then runs the PURE
 * @nexus/portfolio-intelligence engine to derive the complete portfolio state. No business
 * logic lives here and nothing is recomputed — the served decision/plan are consumed verbatim.
 */

async function assemble(): Promise<{
  state: ReturnType<typeof buildPortfolioState>;
  symbolsMissingPrice: string[];
}> {
  const now = Date.now();
  const [view, runtime, permission, kill] = await Promise.all([
    getTradingDecisions(),
    // Control plane is opt-in; absence is unknown (never an ALLOWED/HEALTHY default).
    getRuntimeStateView().catch(() => null),
    getTradingPermissionView().catch(() => null),
    // Fail CLOSED on a read error for the hardest gate: a thrown kill-switch read is treated
    // as ENGAGED. (A missing row is a legitimate "never engaged" — getKillSwitch returns
    // engaged:false for that case without throwing.)
    getKillSwitch().catch(() => ({ engaged: true })),
  ]);

  const runtimeState = runtime?.current ?? null;
  const controlPermission = permission?.permission ?? null;
  const killEngaged = kill?.engaged ?? true;

  const items: PortfolioItem[] = view.decisions.map((decision) => {
    const dqScore = view.dqScores[decision.signalId] ?? null;
    const plan = buildTradePlan({ now, decision, dqScore, runtimeState, killEngaged });
    return { decision, plan, dqScore };
  });

  const state = buildPortfolioState({ now, items, runtimeState, controlPermission, killEngaged });
  return { state, symbolsMissingPrice: view.symbolsMissingPrice };
}

/** GET /api/v1/portfolio/summary — top-line state + statistics + allocation. */
export async function getPortfolioSummary(): Promise<PortfolioSummaryView> {
  const { state, symbolsMissingPrice } = await assemble();
  return {
    summary: state.summary,
    statistics: state.statistics,
    allocation: state.allocation,
    symbolsMissingPrice,
  };
}

/** GET /api/v1/portfolio/exposure — the book sliced every documented way + risk heat. */
export async function getPortfolioExposure(): Promise<PortfolioExposureView> {
  const { state } = await assemble();
  return { exposure: state.exposure, heat: state.heat };
}

/** GET /api/v1/portfolio/health — the overall verdict + deterministic warnings. */
export async function getPortfolioHealth(): Promise<PortfolioHealthView> {
  const { state } = await assemble();
  return { health: state.health, warnings: state.warnings };
}
