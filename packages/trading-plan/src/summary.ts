/**
 * Section A — buildDecisionSummary. The action verdict + the three operator questions
 * (Should I trade? · Can I trade? · Why?). Deterministic relabelling of the served
 * decision + gating context ONLY — no new strategy, nothing recomputed.
 *
 * Mapping (fail-closed, in precedence order):
 *   FLAT / overallStatus NO_TRADE ......................... NO_TRADE
 *   hard-blocked (kill / control / risk / overall BLOCKED)  NO_TRADE  (can't trade)
 *   not actionable yet (WAITING / INCOMPLETE) or stale .... WAIT
 *   actionable directional, top-tier (conf≥strong & RR≥) .. STRONG_BUY / STRONG_SELL
 *   actionable directional, mid-tier (conf≥strong | RR≥) .. BUY / SELL
 *   actionable directional, weak conviction .............. WATCH
 */

import { deriveFacts, type PlanFacts } from "./facts.js";
import type { Action, DecisionSummary, TradePlanInputs } from "./types.js";

function actionFor(f: PlanFacts): Action {
  if (f.noTrade) return "NO_TRADE";
  if (f.hardBlocked) return "NO_TRADE";
  if (!f.actionable || f.stale) return "WAIT";
  // actionable + directional
  if (f.isLong) return f.strong ? "STRONG_BUY" : f.good ? "BUY" : "WATCH";
  if (f.isShort) return f.strong ? "STRONG_SELL" : f.good ? "SELL" : "WATCH";
  return "WAIT";
}

function headlineFor(action: Action, f: PlanFacts): string {
  switch (action) {
    case "STRONG_BUY":
      return `Strong long setup on ${f.confidence.toFixed(2)} conviction — execute the plan`;
    case "BUY":
      return "Valid long setup — execute with standard sizing";
    case "STRONG_SELL":
      return `Strong short setup on ${f.confidence.toFixed(2)} conviction — execute the plan`;
    case "SELL":
      return "Valid short setup — execute with standard sizing";
    case "WATCH":
      return `Directional ${f.direction.toLowerCase()} setup forming — conviction below threshold, monitor`;
    case "WAIT":
      return f.stale
        ? "Signal/feature data is stale — wait for a fresh tick"
        : "Setup not yet actionable — wait for gates to clear";
    case "NO_TRADE":
    default:
      return f.noTrade && !f.hardBlocked
        ? "No directional edge this bar — stand aside"
        : "Trading is blocked — do not trade";
  }
}

function reasons(f: PlanFacts): string[] {
  const why: string[] = [];

  // Should I trade?
  if (!f.directional) {
    why.push("Signal is FLAT — the rule found no directional edge this bar");
  } else {
    why.push(`Signal direction ${f.direction} carried verbatim (confidence ${f.confidence.toFixed(4)})`);
    if (f.rr !== null) why.push(`Reward:risk ${f.rr.toFixed(2)} vs ready threshold ${f.cfg.readyRR}`);
  }

  // Can I trade? — the gates.
  if (f.killEngaged) why.push("Kill switch ENGAGED — trading globally stopped");
  if (f.controlStatus === "BLOCKED") why.push("Control plane BLOCKED trading");
  else if (f.controlAllowed === null) why.push("Control permission unknown (control plane off / no data) — fail-closed");
  if (f.riskStatusLabel === "BLOCKED") why.push("Risk engine BLOCKED the order");
  if (f.overallStatus === "WAITING" || f.overallStatus === "INCOMPLETE")
    why.push(`Overall status ${f.overallStatus} — not yet actionable`);
  if (f.stale) why.push("Signal or feature data is stale (past freshness bound)");

  // alignment colour (only meaningful for a directional setup)
  if (f.directional) {
    if (f.trendAligned === true) why.push("Trend aligned with the direction");
    else if (f.trendAligned === false) why.push("Trend NOT aligned (weak EMA separation)");
    if (f.momentumAligned === true) why.push("Momentum supports the direction");
    else if (f.momentumAligned === false) why.push("Momentum weak / not supportive");
    if (f.volOk === false) why.push("Volatility elevated (near the filter ceiling)");
  }

  return why;
}

export function buildDecisionSummary(inputs: TradePlanInputs): DecisionSummary {
  const f = deriveFacts(inputs);
  const action = actionFor(f);
  const shouldTrade =
    action === "STRONG_BUY" || action === "BUY" || action === "STRONG_SELL" || action === "SELL";
  return {
    action,
    headline: headlineFor(action, f),
    canTrade: f.canTrade,
    shouldTrade,
    why: reasons(f),
    direction: f.direction,
    confidence: f.confidence,
    basis:
      `action from overallStatus=${f.overallStatus}, control=${f.controlStatus}, ` +
      `risk=${f.riskStatusLabel}, kill=${f.killEngaged}, stale=${f.stale}, ` +
      `strong=${f.strong}, good=${f.good} (no strategy recomputed)`,
  };
}
