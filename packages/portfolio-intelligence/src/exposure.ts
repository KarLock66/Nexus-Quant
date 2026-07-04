/**
 * PortfolioExposure — the served book sliced every documented way: by symbol, by side, by
 * regime, and by bucket (lifecycle state, confidence band, capital-at-risk band). Symbol/side/
 * regime/confidence/risk groupings describe the OPEN book (only OPEN positions expose live
 * capital); the state grouping spans ALL candidates so the waiting/blocked/flat backlog is
 * visible. Within each grouping `sharePct` is the share of that grouping's own total, so the
 * groups sum to 100% when non-empty. Deterministic order: notional desc, then key asc.
 */

import { derivePortfolioFacts } from "./facts.js";
import { round } from "./util.js";
import type {
  ExposureBuckets,
  ExposureGroup,
  PortfolioExposure,
  PortfolioInputs,
  PortfolioPosition,
} from "./types.js";

/**
 * Group positions by a key; sharePct is within-grouping; sorted deterministically. Only LIVE
 * (OPEN, `contributesExposure`) positions add to `notional`, so a group's notional is always
 * real live exposure — a BLOCKED/WAITING/FLAT candidate contributes its `count` but $0 of
 * exposure (it holds none). Provenance downgrades to `estimated` when an OPEN constituent's
 * notional source was absent (its missing $ is silently treated as 0), so a partially-sourced
 * group is never presented as cleanly `derived`.
 */
function group(positions: PortfolioPosition[], keyFn: (p: PortfolioPosition) => string): ExposureGroup[] {
  const agg = new Map<string, { notional: number; count: number; missing: boolean }>();
  for (const p of positions) {
    const key = keyFn(p);
    const cur = agg.get(key) ?? { notional: 0, count: 0, missing: false };
    if (p.contributesExposure) {
      if (p.notional === null) cur.missing = true;
      else cur.notional += p.notional;
    }
    cur.count += 1;
    agg.set(key, cur);
  }
  const total = [...agg.values()].reduce((a, g) => a + g.notional, 0);
  const groups: ExposureGroup[] = [...agg.entries()].map(([key, g]) => ({
    key,
    notional: round(g.notional, 2),
    sharePct: total > 0 ? round((g.notional / total) * 100, 2) : 0,
    count: g.count,
    provenance: g.missing ? ("estimated" as const) : ("derived" as const),
  }));
  return groups.sort((a, b) =>
    b.notional !== a.notional ? b.notional - a.notional : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

function confidenceBand(p: PortfolioPosition): string {
  if (p.confidence >= 0.75) return "HIGH";
  if (p.confidence >= 0.5) return "MEDIUM";
  return "LOW";
}

function riskBand(p: PortfolioPosition): string {
  if (p.riskPct === null) return "UNKNOWN";
  if (p.riskPct < 0.5) return "LOW";
  if (p.riskPct < 1.5) return "MODERATE";
  return "HIGH";
}

export function buildPortfolioExposure(inputs: PortfolioInputs): PortfolioExposure {
  const facts = derivePortfolioFacts(inputs);
  const open = facts.open;

  const buckets: ExposureBuckets = {
    byState: group(facts.positions, (p) => p.state),
    byConfidence: group(open, confidenceBand),
    byRisk: group(open, riskBand),
  };

  return {
    bySymbol: group(open, (p) => p.symbol),
    bySide: group(open, (p) => p.direction),
    byRegime: group(open, (p) => p.regime ?? "UNKNOWN"),
    buckets,
    grossExposure: facts.grossExposure,
    netExposure: facts.netExposure,
    note:
      open.length === 0
        ? "no open exposure — all groupings empty (only OPEN positions expose capital)"
        : `gross $${facts.grossExposure} across ${open.length} open position(s); net $${facts.netExposure}`,
  };
}
