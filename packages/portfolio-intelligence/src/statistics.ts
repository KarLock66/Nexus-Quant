/**
 * PortfolioStatistics — deterministic descriptive statistics over the DIRECTIONAL candidate
 * positions (FLAT signals carry no confidence/levels and are excluded). Averages/median fail
 * closed to null over an empty sample (never NaN). The action distribution spans ALL positions
 * (so NO_TRADE/WAIT are visible); readiness/regime/confidence distributions cover the
 * directional sample. Best/worst opportunity are by readiness (tie-break: confidence, symbol).
 * Every value is read verbatim from the served decision/plan — nothing is recomputed.
 */

import { derivePortfolioFacts } from "./facts.js";
import { avg, maxFinite, median, minFinite, round } from "./util.js";
import type {
  Action,
  ConfidenceBucket,
  ExposureGroup,
  PortfolioDistribution,
  PortfolioInputs,
  PortfolioPosition,
  PortfolioStatistics,
  ReadinessBand,
  StatRef,
} from "./types.js";

const ALL_ACTIONS: Action[] = ["STRONG_BUY", "BUY", "WATCH", "WAIT", "NO_TRADE", "SELL", "STRONG_SELL"];
const ALL_BANDS: ReadinessBand[] = ["READY", "NEAR", "FORMING", "NOT_READY"];

/** Best (dir=1) or worst (dir=-1) directional position by readiness, tie-break confidence then symbol. */
function pickByReadiness(sample: PortfolioPosition[], dir: 1 | -1): StatRef {
  let best: PortfolioPosition | null = null;
  for (const p of sample) {
    if (best === null) {
      best = p;
      continue;
    }
    const dr = p.readiness - best.readiness;
    const dc = p.confidence - best.confidence;
    const better =
      dir === 1
        ? dr > 0 || (dr === 0 && dc > 0) || (dr === 0 && dc === 0 && p.symbol < best.symbol)
        : dr < 0 || (dr === 0 && dc < 0) || (dr === 0 && dc === 0 && p.symbol < best.symbol);
    if (better) best = p;
  }
  if (best === null) return { symbol: null, timeframe: null, direction: null, value: null };
  return { symbol: best.symbol, timeframe: best.timeframe, direction: best.direction, value: round(best.readiness, 1) };
}

function confidenceBuckets(sample: PortfolioPosition[]): ConfidenceBucket[] {
  const buckets = [
    { label: "0.00–0.25", lo: 0, hi: 0.25 },
    { label: "0.25–0.50", lo: 0.25, hi: 0.5 },
    { label: "0.50–0.75", lo: 0.5, hi: 0.75 },
    { label: "0.75–1.00", lo: 0.75, hi: 1.0001 },
  ];
  return buckets.map((b) => ({
    label: b.label,
    count: sample.filter((p) => p.confidence >= b.lo && p.confidence < b.hi).length,
  }));
}

/**
 * Distribution of the directional sample by regime. `sharePct` is the COUNT share; `notional`
 * carries only LIVE (OPEN) exposure so it is never an invented figure, and provenance
 * downgrades to `estimated` when an OPEN constituent's notional source was absent.
 */
function regimeGroups(sample: PortfolioPosition[]): ExposureGroup[] {
  const agg = new Map<string, { notional: number; count: number; missing: boolean }>();
  for (const p of sample) {
    const key = p.regime ?? "UNKNOWN";
    const cur = agg.get(key) ?? { notional: 0, count: 0, missing: false };
    if (p.contributesExposure) {
      if (p.notional === null) cur.missing = true;
      else cur.notional += p.notional;
    }
    cur.count += 1;
    agg.set(key, cur);
  }
  const total = sample.length;
  return [...agg.entries()]
    .map(([key, g]): ExposureGroup => ({
      key,
      notional: round(g.notional, 2),
      sharePct: total > 0 ? round((g.count / total) * 100, 2) : 0,
      count: g.count,
      provenance: g.missing ? "estimated" : "derived",
    }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function buildPortfolioStatistics(inputs: PortfolioInputs): PortfolioStatistics {
  const facts = derivePortfolioFacts(inputs);
  const sample = facts.directional;
  const confidences = sample.map((p) => p.confidence);

  const byAction = Object.fromEntries(ALL_ACTIONS.map((a) => [a, 0])) as Record<Action, number>;
  for (const p of facts.positions) byAction[p.action] += 1;

  const byReadinessBand = Object.fromEntries(ALL_BANDS.map((b) => [b, 0])) as Record<ReadinessBand, number>;
  for (const p of sample) byReadinessBand[p.readinessBand] += 1;

  const distribution: PortfolioDistribution = {
    byAction,
    byReadinessBand,
    byRegime: regimeGroups(sample),
    confidenceBuckets: confidenceBuckets(sample),
  };

  const averageConfidence = avg(confidences);
  const averageRiskReward = avg(sample.map((p) => p.riskReward));
  const averageReadiness = avg(sample.map((p) => p.readiness));
  const averageRisk = avg(sample.map((p) => p.riskPct));

  return {
    sampleSize: sample.length,
    averageConfidence: averageConfidence === null ? null : round(averageConfidence, 4),
    medianConfidence: ((m) => (m === null ? null : round(m, 4)))(median(confidences)),
    highestConfidence: ((m) => (m === null ? null : round(m, 4)))(maxFinite(confidences)),
    lowestConfidence: ((m) => (m === null ? null : round(m, 4)))(minFinite(confidences)),
    averageRiskReward: averageRiskReward === null ? null : round(averageRiskReward, 2),
    averageReadiness: averageReadiness === null ? null : round(averageReadiness, 1),
    averageRisk: averageRisk === null ? null : round(averageRisk, 4),
    bestOpportunity: pickByReadiness(sample, 1),
    worstOpportunity: pickByReadiness(sample, -1),
    distribution,
    note:
      sample.length === 0
        ? "no directional candidates — statistics fail closed (null)"
        : `${sample.length} directional candidate(s); avg confidence ${averageConfidence === null ? "—" : round(averageConfidence, 4)}`,
  };
}
