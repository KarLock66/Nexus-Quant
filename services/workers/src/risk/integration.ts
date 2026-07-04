/**
 * Risk Engine integration (Phase 8) — the OPT-IN seam that wires the risk engine in
 * front of the execution stage so every order passes through risk before any intent
 * is constructed. It produces a `RiskGateHook` matching the execution stage's single
 * default-off hook: when the hook is absent the stage is byte-for-byte Phase 5/6/7;
 * when present, a block here prevents intent construction exactly like the sealed
 * Phase 5 gate (defense in depth — both gates must pass).
 *
 * The risk engine sizes from the portfolio layer's already-agreed net notional using
 * the Position Sizer in FIXED_NOTIONAL mode — exercising the sizer in the live path to
 * derive the quantity + margin the gate checks, WITHOUT overriding the sealed portfolio
 * layer's capital allocation. The capital model + positions come from the live market
 * adapter (the real event-sourced account), so the gate checks against true equity,
 * margin, and exposure.
 */

import type { PortfolioState } from "../execution/portfolio.js";
import type { ProposedAllocation } from "../execution/types.js";
import type { RiskGateHook } from "../execution/stage.js";
import type { Quote } from "../market/types.js";
import { buildCapitalSnapshot } from "./capital.js";
import type { EvaluateContext, MarketView, RiskEngine } from "./engine.js";
import { parseDecimal } from "./money.js";
import { sizePosition } from "./sizer.js";
import type { HealthSignals, ProposedOrder } from "./types.js";

export interface RiskExecutionGateDeps {
  engine: RiskEngine;
  /** Live event-sourced market view (account + positions) — the capital model source. */
  getView: () => MarketView;
  /** Reference price provider (the market adapter's quote source). */
  getQuote: (symbol: string) => Quote | null;
  /** Optional external health signals consulted by the kill switch per evaluation. */
  getHealth?: () => HealthSignals;
}

/**
 * Build the execution-stage risk hook. Returns a function the stage calls per proposal
 * BEFORE the Phase 5 gate; a non-approval blocks the order. Fail-closed: a missing
 * price blocks; any thrown error is caught by the stage and treated as a block.
 */
export function createRiskExecutionGate(deps: RiskExecutionGateDeps): RiskGateHook {
  const { engine, getView, getQuote, getHealth } = deps;
  const leverage = engine.accountConfig.leverage;

  return async (proposal: ProposedAllocation, _state: PortfolioState) => {
    const quote = getQuote(proposal.symbol);
    if (quote === null)
      return { approved: false, reason: "NO_MARKET_DATA", detail: `no quote for ${proposal.symbol}` };
    const price = parseDecimal(quote.price);
    if (!(price > 0))
      return { approved: false, reason: "NO_MARKET_DATA", detail: `invalid price ${quote.price}` };

    const view = getView();
    const capital = buildCapitalSnapshot(view.account, view.positions, engine.accountConfig);

    // Convert the portfolio's agreed net notional into qty + margin via the sizer
    // (FIXED_NOTIONAL), so the gate's quantity/margin checks see canonical, deterministic
    // values without re-sizing the sealed portfolio allocation.
    const sizing = sizePosition({
      config: { mode: "FIXED_NOTIONAL", leverage, fixedNotional: parseDecimal(proposal.targetNotional) },
      equity: parseDecimal(capital.accountEquity),
      price,
    });

    const order: ProposedOrder = {
      symbol: proposal.symbol,
      side: proposal.side,
      targetQuantity: sizing.targetQuantity,
      targetNotional: sizing.targetNotional,
      price: quote.price,
      strategyId: proposal.strategyId,
    };

    const ctx: EvaluateContext = getHealth ? { health: getHealth() } : {};
    const decision = await engine.evaluate(order, view, ctx);
    return decision.approved
      ? { approved: true }
      : { approved: false, reason: decision.reason, detail: decision.detail };
  };
}
