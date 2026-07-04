/**
 * RiskHeat — a deterministic 0..100 portfolio-heat score with DOCUMENTED weights (summing to
 * 100) — no ML, no LLM, no fabricated values. It is composed ONLY from already-aggregated
 * facts: capital deployed, risk-at-risk vs budget, single-name concentration, directional net
 * skew, and gating stress. Every factor is a clamped 0..1 fraction; each component fails
 * closed to 0 points when its source is empty. The score is always finite.
 *
 * Concentration is the Herfindahl-Hirschman Index of gross-exposure shares (Σ shareᵢ²),
 * scaled to 0..100: one symbol → 100 (fully concentrated), n equal symbols → 100/n.
 */

import { derivePortfolioFacts, type PortfolioFacts } from "./facts.js";
import { clamp, clamp01, round, safeDiv } from "./util.js";
import type {
  HeatBand,
  HeatComponent,
  PortfolioConfig,
  PortfolioInputs,
  RiskHeat,
} from "./types.js";

/** HHI of gross-exposure shares across OPEN positions, scaled 0..100 (0 when no exposure). */
export function concentrationScore(facts: PortfolioFacts): number {
  const gross = facts.grossExposure;
  if (gross <= 0) return 0;
  // Aggregate notional per symbol (OPEN only).
  const bySymbol = new Map<string, number>();
  for (const p of facts.open) {
    if (p.notional === null) continue;
    bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + p.notional);
  }
  let hhi = 0;
  for (const notional of bySymbol.values()) {
    const share = notional / gross;
    hhi += share * share;
  }
  return round(clamp01(hhi) * 100, 2);
}

function bandFor(score: number, cfg: PortfolioConfig): HeatBand {
  if (score >= cfg.heatExtremeBand) return "EXTREME";
  if (score >= cfg.heatHotBand) return "HOT";
  if (score >= cfg.heatWarmBand) return "WARM";
  return "COOL";
}

export function buildRiskHeat(inputs: PortfolioInputs): RiskHeat {
  const facts = derivePortfolioFacts(inputs);
  const w = facts.cfg.heatWeights;

  // factor fractions (each clamped 0..1, fail-closed to 0)
  const capitalFrac = clamp01(facts.capitalPct / 100);
  const riskFrac =
    facts.riskBudgetAbs > 0 ? clamp01(facts.riskUsedAbs / facts.riskBudgetAbs) : 0;
  const concentration = concentrationScore(facts);
  const concentrationFrac = clamp01(concentration / 100);
  // directional skew — |net| ÷ gross (0 = perfectly balanced, 1 = fully one-sided).
  const skewFrac =
    facts.grossExposure > 0
      ? clamp01(Math.abs(facts.netExposure) / facts.grossExposure)
      : 0;
  // gating stress — share of directional candidates that are blocked or stale.
  const denom = facts.directional.length;
  const stressed = facts.blockedCount + facts.staleCount;
  const gatingFrac = denom > 0 ? clamp01(stressed / denom) : 0;

  const cCapital = round(w.capital * capitalFrac, 2);
  const cRisk = round(w.risk * riskFrac, 2);
  const cConcentration = round(w.concentration * concentrationFrac, 2);
  const cSkew = round(w.directionalSkew * skewFrac, 2);
  const cGating = round(w.gating * gatingFrac, 2);

  const components: HeatComponent[] = [
    { key: "capital", label: "Capital deployed", weight: w.capital, earned: cCapital, basis: `capital ${facts.capitalPct}% of equity` },
    { key: "risk", label: "Risk vs budget", weight: w.risk, earned: cRisk, basis: `risk $${facts.riskUsedAbs} of $${facts.riskBudgetAbs} budget` },
    { key: "concentration", label: "Concentration", weight: w.concentration, earned: cConcentration, basis: `HHI concentration ${concentration}/100` },
    { key: "directionalSkew", label: "Directional skew", weight: w.directionalSkew, earned: cSkew, basis: `|net| $${Math.abs(facts.netExposure)} ÷ gross $${facts.grossExposure}` },
    { key: "gating", label: "Gating stress", weight: w.gating, earned: cGating, basis: `blocked ${facts.blockedCount}, stale ${facts.staleCount} of ${denom} directional` },
  ];

  const heatScore = round(
    clamp(components.reduce((a, c) => a + c.earned, 0), 0, 100),
    1,
  );
  const heatBand = bandFor(heatScore, facts.cfg);
  const diversificationScore = round(100 - concentration, 2);
  const portfolioRisk =
    facts.riskBudgetAbs > 0
      ? round(clamp((safeDiv(facts.riskUsedAbs, facts.riskBudgetAbs) ?? 0) * 100, 0, 100), 2)
      : 0;
  const portfolioStability = round(100 - heatScore, 1);

  return {
    heatScore,
    heatBand,
    diversificationScore,
    concentrationScore: concentration,
    portfolioRisk,
    portfolioStability,
    components,
    provenance: "derived",
    note:
      facts.openCount === 0
        ? "no open exposure — heat is COOL by construction (nothing deployed)"
        : `heat ${heatScore}/100 (${heatBand}) from documented weights (sum ${w.capital + w.risk + w.concentration + w.directionalSkew + w.gating})`,
  };
}
