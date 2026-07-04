/**
 * PortfolioHealth — the deterministic overall verdict, derived ONLY from the served plan/
 * control/runtime context + the portfolio heat (per the phase spec). Fail-closed precedence:
 *
 *   BLOCKED : kill engaged · control BLOCKED · runtime not HEALTHY        (cannot trade)
 *   RISK    : heat EXTREME · risk over budget · any CRITICAL warning
 *   CAUTION : heat HOT · any HIGH warning · any MEDIUM warning
 *   HEALTHY : none of the above
 *
 * Nothing is recomputed — gates are read verbatim, heat/warnings are the engine's own
 * deterministic aggregates. The status mirrors PortfolioSummary.status by construction.
 */

import { derivePortfolioFacts } from "./facts.js";
import { buildRiskHeat } from "./heat.js";
import { buildPortfolioWarnings } from "./warnings.js";
import type { PortfolioHealth, PortfolioInputs, PortfolioStatus } from "./types.js";

export function buildPortfolioHealth(inputs: PortfolioInputs): PortfolioHealth {
  const facts = derivePortfolioFacts(inputs);
  const heat = buildRiskHeat(inputs);
  const warns = buildPortfolioWarnings(inputs);

  const reasons: string[] = [];
  let status: PortfolioStatus;

  if (facts.killEngaged || facts.controlAllowed === false || facts.runtimeHealthy === false) {
    status = "BLOCKED";
    if (facts.killEngaged) reasons.push("kill switch engaged");
    if (facts.controlAllowed === false) reasons.push("control plane BLOCKED");
    if (facts.runtimeHealthy === false) reasons.push(`runtime not HEALTHY (${inputs.runtimeState ?? "unknown"})`);
  } else if (
    heat.heatBand === "EXTREME" ||
    (facts.riskBudgetAbs > 0 && facts.riskUsedAbs > facts.riskBudgetAbs) ||
    warns.critical > 0
  ) {
    status = "RISK";
    if (heat.heatBand === "EXTREME") reasons.push(`risk heat EXTREME (${heat.heatScore}/100)`);
    if (facts.riskBudgetAbs > 0 && facts.riskUsedAbs > facts.riskBudgetAbs)
      reasons.push(`risk $${facts.riskUsedAbs} over budget $${facts.riskBudgetAbs}`);
    if (warns.critical > 0) reasons.push(`${warns.critical} critical warning(s)`);
  } else if (heat.heatBand === "HOT" || warns.high > 0 || warns.medium > 0) {
    status = "CAUTION";
    if (heat.heatBand === "HOT") reasons.push(`risk heat HOT (${heat.heatScore}/100)`);
    if (warns.high > 0) reasons.push(`${warns.high} high warning(s)`);
    if (warns.medium > 0) reasons.push(`${warns.medium} medium warning(s)`);
  } else {
    status = "HEALTHY";
    reasons.push(
      facts.openCount > 0
        ? `${facts.openCount} open position(s), heat ${heat.heatBand}, no elevated warnings`
        : "no open exposure, no elevated warnings",
    );
  }

  return {
    status,
    reasons,
    runtimeHealthy: facts.runtimeHealthy,
    controlAllowed: facts.controlAllowed,
    killEngaged: facts.killEngaged,
    heatBand: heat.heatBand,
    note: `portfolio ${status} — derived from control/runtime/risk-budget + heat ${heat.heatBand} (no strategy recomputed)`,
  };
}
