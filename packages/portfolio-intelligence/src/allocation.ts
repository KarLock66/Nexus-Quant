/**
 * CapitalAllocation — how the assumed equity is deployed across the OPEN book. Every field
 * discloses its provenance: aggregated figures are `derived`, and a ref with no source fails
 * closed to `unavailable` (symbol null / value null) — never fabricated. Percentages are of
 * the assumed equity (the web tier has no live book). Concentration is the HHI of gross-
 * exposure shares (shared with the heat engine, single source of truth).
 *
 *   capitalPct  = gross notional ÷ equity   (total deployment)
 *   exposurePct = net    notional ÷ equity   (directional net, signed)
 *   riskPct     = Σ maxLoss   ÷ equity       (capital genuinely at risk)
 */

import { derivePortfolioFacts, type PortfolioFacts } from "./facts.js";
import { concentrationScore } from "./heat.js";
import { round, sumFinite } from "./util.js";
import type {
  AllocationRef,
  CapitalAllocation,
  PortfolioInputs,
  PortfolioMeasure,
  SymbolAllocation,
} from "./types.js";

interface SymAgg {
  gross: number;
  net: number;
  risk: number;
  /** A finite notional source actually contributed (else `gross` is a 0-from-absent, not real). */
  grossHasSource: boolean;
  /** A finite maxLoss source actually contributed (else `risk` is a 0-from-absent, not real). */
  riskHasSource: boolean;
  bestReadiness: number;
  bestConfidence: number;
}

function aggregateBySymbol(facts: PortfolioFacts): Map<string, SymAgg> {
  const m = new Map<string, SymAgg>();
  for (const p of facts.open) {
    const cur =
      m.get(p.symbol) ??
      { gross: 0, net: 0, risk: 0, grossHasSource: false, riskHasSource: false, bestReadiness: -1, bestConfidence: -1 };
    if (p.notional !== null) {
      cur.gross += p.notional;
      cur.net += p.direction === "SHORT" ? -p.notional : p.notional;
      cur.grossHasSource = true;
    }
    if (p.maxLoss !== null) {
      cur.risk += p.maxLoss;
      cur.riskHasSource = true;
    }
    if (p.readiness > cur.bestReadiness) {
      cur.bestReadiness = p.readiness;
      cur.bestConfidence = p.confidence;
    }
    m.set(p.symbol, cur);
  }
  return m;
}

function pct(num: number, equity: number): number {
  return equity > 0 ? round((num / equity) * 100, 2) : 0;
}

export function buildCapitalAllocation(inputs: PortfolioInputs): CapitalAllocation {
  const facts = derivePortfolioFacts(inputs);
  const equity = facts.assumedEquity;
  const hasOpen = facts.openCount > 0;

  // Source coverage across the OPEN book — discloses (and provenance-downgrades) when some open
  // positions contributed no notional / maxLoss source, so a silently under-counted aggregate is
  // never presented as cleanly `derived`.
  const notionalCovered = facts.open.filter((p) => p.notional !== null).length;
  const riskCovered = facts.open.filter((p) => p.maxLoss !== null).length;
  const notionalProv: PortfolioMeasure["provenance"] =
    hasOpen && notionalCovered < facts.openCount ? "estimated" : "derived";
  const riskProv: PortfolioMeasure["provenance"] =
    hasOpen && riskCovered < facts.openCount ? "estimated" : "derived";

  const capitalPct: PortfolioMeasure = {
    value: pct(facts.grossExposure, equity),
    provenance: notionalProv,
    basis: `gross $${facts.grossExposure} ÷ equity $${equity} (notional from ${notionalCovered}/${facts.openCount} open)`,
  };
  const exposurePct: PortfolioMeasure = {
    value: pct(facts.netExposure, equity),
    provenance: notionalProv,
    basis: `net $${facts.netExposure} ÷ equity $${equity} (notional from ${notionalCovered}/${facts.openCount} open)`,
  };
  const riskPct: PortfolioMeasure = {
    value: pct(facts.riskUsedAbs, equity),
    provenance: riskProv,
    basis: `risk $${facts.riskUsedAbs} ÷ equity $${equity} (maxLoss from ${riskCovered}/${facts.openCount} open)`,
  };

  const bySymbol = aggregateBySymbol(facts);
  const perSymbol: SymbolAllocation[] = [...bySymbol.entries()]
    .map(([symbol, a]): SymbolAllocation => ({
      symbol,
      capitalPct: { value: pct(a.gross, equity), provenance: "derived", basis: `${symbol} gross $${round(a.gross, 2)} ÷ equity $${equity}` },
      riskPct: { value: pct(a.risk, equity), provenance: "derived", basis: `${symbol} risk $${round(a.risk, 2)} ÷ equity $${equity}` },
      exposurePct: { value: facts.grossExposure > 0 ? round((a.gross / facts.grossExposure) * 100, 2) : 0, provenance: "derived", basis: `${symbol} gross $${round(a.gross, 2)} ÷ gross $${facts.grossExposure}` },
    }))
    .sort((x, y) =>
      (y.capitalPct.value ?? 0) - (x.capitalPct.value ?? 0) || (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0),
    );

  // ── superlatives (deterministic tie-breaks: value desc, then symbol asc) ──
  const naRef = (basis: string): AllocationRef => ({ symbol: null, value: null, provenance: "unavailable", basis });

  // Superlatives consider ONLY symbols whose figure has a real contributing source, so a
  // 0-from-absent notional/maxLoss is never reported as the "largest" (fail-closed → UNAVAILABLE).
  let largestPosition: AllocationRef = naRef("no open position with a notional source");
  let largestRisk: AllocationRef = naRef("no open position with a maxLoss source");
  for (const [symbol, a] of bySymbol) {
    if (
      a.grossHasSource &&
      (largestPosition.value === null ||
        a.gross > largestPosition.value ||
        (a.gross === largestPosition.value && largestPosition.symbol !== null && symbol < largestPosition.symbol))
    ) {
      largestPosition = { symbol, value: round(a.gross, 2), provenance: "derived", basis: `${symbol} gross notional` };
    }
    if (
      a.riskHasSource &&
      (largestRisk.value === null ||
        a.risk > largestRisk.value ||
        (a.risk === largestRisk.value && largestRisk.symbol !== null && symbol < largestRisk.symbol))
    ) {
      largestRisk = { symbol, value: round(a.risk, 2), provenance: "derived", basis: `${symbol} Σ maxLoss` };
    }
  }

  // Largest opportunity — best readiness across DIRECTIONAL candidates (not just open).
  let largestOpportunity: AllocationRef = naRef("no directional candidates");
  let bestReadiness = -1;
  let bestConfidence = -1;
  for (const p of facts.directional) {
    if (
      p.readiness > bestReadiness ||
      (p.readiness === bestReadiness && p.confidence > bestConfidence) ||
      (p.readiness === bestReadiness && p.confidence === bestConfidence && largestOpportunity.symbol !== null && p.symbol < largestOpportunity.symbol)
    ) {
      bestReadiness = p.readiness;
      bestConfidence = p.confidence;
      largestOpportunity = { symbol: p.symbol, value: round(p.readiness, 1), provenance: "derived", basis: `${p.symbol} readiness ${round(p.readiness, 1)} (confidence ${p.confidence.toFixed(4)})` };
    }
  }

  const conc = concentrationScore(facts);
  const concentration: PortfolioMeasure = {
    value: conc,
    provenance: hasOpen ? notionalProv : "unavailable",
    basis: hasOpen ? `HHI of gross-exposure shares (1 symbol→100, n equal→100/n)` : "no open exposure",
  };

  return {
    capitalPct,
    riskPct,
    exposurePct,
    perSymbol,
    largestPosition,
    largestRisk,
    largestOpportunity,
    concentration,
    note: hasOpen
      ? `capital ${capitalPct.value}% deployed across ${perSymbol.length} symbol(s); concentration ${conc}/100`
      : "no open exposure — allocation is empty (nothing deployed)",
  };
}
