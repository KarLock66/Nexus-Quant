/**
 * Phase 10A-2 — Professional Trading Terminal: PRESENTATION-ONLY deterministic
 * derivations.
 *
 * Every function here is a PURE, deterministic transform of an already-served
 * {@link TradingDecision} (the single source of truth). Nothing is recomputed from
 * raw features, nothing is fabricated, no clock or randomness lives inside the
 * compute functions (the one freshness check takes an injected `nowMs`). Each
 * output carries its provenance so the UI can never present a derived/estimated
 * number as live truth:
 *   - Setup Quality grade .......... DERIVED   (deterministic scoring, never AI/random)
 *   - Win probability .............. ESTIMATED (heuristic; NOT a historical win rate)
 *   - Entry zone ................... DERIVED   (ATR recovered from the served levels)
 *   - Distances .................... DERIVED   (from the served price levels)
 * Fail-closed: a missing input yields `null` / `UNAVAILABLE`, never a NaN.
 *
 * This module touches no sealed code — it consumes the @nexus/trading-decision
 * output verbatim and only reshapes it for display.
 */

import { DEFAULT_DECISION_CONFIG } from "@nexus/trading-decision";
import type {
  Measure,
  Provenance,
  RankedDecision,
  TradingDecision,
} from "./trading-decision-types";

// ─────────────────────────── constants (documented, deterministic) ───────────────────────────

/**
 * ATR multiple the sealed level engine uses for the stop — read directly from the sealed
 * DEFAULT_DECISION_CONFIG (single source of truth, never re-typed here). The web tier never
 * overrides DecisionConfig, so the stop distance the API serves is exactly `atrStopMult × ATR`.
 * We invert that to recover ATR for the entry zone — no raw feature is read, no value is
 * recomputed, and this can never drift from the engine.
 */
export const ATR_STOP_MULT = DEFAULT_DECISION_CONFIG.atrStopMult;
/** Entry-zone half-width in ATR units (a band around the mark, symmetric — no fabricated bias). */
export const ENTRY_ZONE_ATR_MULT = 0.5;
/** A panel's data is STALE once its last successful poll is older than this (≈3× the 4s cadence). */
export const STALE_AFTER_MS = 12_000;

export type SetupGrade = "A+" | "A" | "B" | "C" | "D" | "F";
export type PanelLiveStatus = "LIVE" | "STALE" | "BLOCKED" | "WAITING" | "UNAVAILABLE";

// ─────────────────────────── small pure helpers ───────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

function round(x: number, dp: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Number(x.toFixed(dp));
  return r === 0 ? 0 : r;
}

/** Finite value of a Measure, or null (fail-closed — a non-finite measure is treated as absent). */
function mv(m: Measure | null | undefined): number | null {
  if (!m || m.value === null || !Number.isFinite(m.value)) return null;
  return m.value;
}

/** Scale a value onto a 0..100 meter against `max`, clamped. Fail-closed to 0. */
export function meterPct(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value) || max <= 0) return 0;
  return clamp((value / max) * 100, 0, 100);
}

// ─────────────────────────── Setup Quality (deterministic A+…F) ───────────────────────────

export interface GradeView {
  grade: SetupGrade;
  /** 0..100 composite the band is read from. */
  score: number;
  provenance: "derived";
  basis: string;
  components: {
    confidence: number;
    riskReward: number;
    trend: number;
    momentum: number;
    liquidity: number;
    approvals: number;
  };
}

function band(score: number): SetupGrade {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

/**
 * Deterministic Setup Quality. Pure function of the served decision — NEVER random,
 * NEVER AI-generated. A non-directional (FLAT) signal is not a setup → graded F.
 * Components (max 100): confidence 35 · R:R 25 · trend 15 · momentum 10 · approvals 10 ·
 * liquidity 5. Missing inputs contribute 0 (a setup with no liquidity data simply cannot
 * reach the top of its band) — fail-closed, never inflated.
 */
export function setupGrade(d: TradingDecision): GradeView {
  if (d.direction === "FLAT") {
    return {
      grade: "F",
      score: 0,
      provenance: "derived",
      basis: "FLAT signal — no directional setup to grade (not a trade candidate)",
      components: { confidence: 0, riskReward: 0, trend: 0, momentum: 0, liquidity: 0, approvals: 0 },
    };
  }

  const conf = clamp(d.confidence, 0, 1);
  const rr = mv(d.riskRewardRatio);
  const trend = mv(d.trendStrength);
  const mom = mv(d.momentumScore);
  const liq = mv(d.liquidityScore);

  const cConfidence = round(35 * conf, 2);
  // R:R 1.0 → 0 pts, 3.0+ → full. Below 1 is a losing geometry → 0.
  const cRiskReward = rr === null ? 0 : round(25 * clamp((rr - 1) / 2, 0, 1), 2);
  const cTrend = trend === null ? 0 : round(15 * (clamp(trend, 0, 100) / 100), 2);
  const cMomentum = mom === null ? 0 : round(10 * (clamp(mom, 0, 100) / 100), 2);
  const cLiquidity = liq === null ? 0 : round(5 * (clamp(liq, 0, 100) / 100), 2);
  const cApprovals =
    (d.executionStatus === "READY" ? 4 : 0) +
    (d.riskStatus.status === "APPROVED" ? 3 : 0) +
    (d.controlStatus === "ALLOWED" ? 3 : 0);

  const score = round(
    cConfidence + cRiskReward + cTrend + cMomentum + cLiquidity + cApprovals,
    2,
  );
  const components = {
    confidence: cConfidence,
    riskReward: cRiskReward,
    trend: cTrend,
    momentum: cMomentum,
    liquidity: cLiquidity,
    approvals: cApprovals,
  };
  return {
    grade: band(score),
    score,
    provenance: "derived",
    basis:
      `deterministic composite ${score}/100 = conf ${cConfidence} + R:R ${cRiskReward} + ` +
      `trend ${cTrend} + mom ${cMomentum} + liq ${cLiquidity} + approvals ${cApprovals} ` +
      `(DQ is a separate admission gate, not a grade input)`,
    components,
  };
}

// ─────────────────────────── Win probability (ESTIMATED) ───────────────────────────

export interface ProbabilityView {
  /** 0..100 estimate, or null when there is no directional setup. */
  value: number | null;
  provenance: "estimated" | "unavailable";
  basis: string;
}

/**
 * Deterministic, clearly-labelled ESTIMATE of directional follow-through. It is a
 * transparent heuristic of conviction (confidence) + trend + momentum, deliberately
 * bounded to 40–85% so it can NEVER read as a certainty. It is explicitly NOT a
 * backtested or historical win rate — the basis says so. FLAT → no setup → unavailable.
 */
export function winProbability(d: TradingDecision): ProbabilityView {
  if (d.direction === "FLAT" || mv(d.entryPrice) === null) {
    return {
      value: null,
      provenance: "unavailable",
      basis: "no directional setup — win probability not applicable",
    };
  }
  const conf = clamp(d.confidence, 0, 1);
  const trend = mv(d.trendStrength);
  const mom = mv(d.momentumScore);
  // Each term 0..1; trend/momentum default to 0 (fail-closed) and the basis notes it.
  const edge = clamp(
    0.6 * conf + 0.25 * (trend === null ? 0 : clamp(trend, 0, 100) / 100) + 0.15 * (mom === null ? 0 : clamp(mom, 0, 100) / 100),
    0,
    1,
  );
  const value = round(40 + 45 * edge, 0); // 40..85
  return {
    value,
    provenance: "estimated",
    basis:
      `ESTIMATE = 40 + 45·(0.6·conf + 0.25·trend + 0.15·mom) = ${value}%. ` +
      `Heuristic only — NOT a backtested or historical win rate` +
      (trend === null ? "; trend unavailable (counted 0)" : "") +
      (mom === null ? "; momentum unavailable (counted 0)" : ""),
  };
}

// ─────────────────────────── Entry zone (DERIVED from served levels) ───────────────────────────

export interface EntryZoneView {
  low: number | null;
  high: number | null;
  mid: number | null;
  /** Zone width as a % of the mid price. */
  widthPct: number | null;
  /** Signed distance of the current mark from the zone mid, as a % of mid (≈0 — entry = mark). */
  currentDistancePct: number | null;
  /** The ATR recovered from |entry − stop| ÷ atrStopMult (price units). */
  atr: number | null;
  provenance: Provenance;
  basis: string;
}

/**
 * Entry ZONE around the mark, half-width = ENTRY_ZONE_ATR_MULT × ATR, where ATR is
 * recovered from the served levels (|entry − stop| ÷ atrStopMult) — no raw feature read,
 * no recomputation. NB: in this engine `entryPrice` IS the current mark, so the current
 * price sits at the zone mid (currentDistance ≈ 0) by construction — surfaced honestly,
 * not a bug. Fail-closed: missing entry/stop → unavailable.
 */
export function entryZone(d: TradingDecision): EntryZoneView {
  const entry = mv(d.entryPrice);
  const stop = mv(d.stopLoss);
  const current = mv(d.currentPrice);
  if (entry === null || stop === null) {
    return {
      low: null,
      high: null,
      mid: null,
      widthPct: null,
      currentDistancePct: null,
      atr: null,
      provenance: "unavailable",
      basis: "entry/stop unavailable — ATR-based entry zone not computable",
    };
  }
  const atr = Math.abs(entry - stop) / ATR_STOP_MULT;
  const half = ENTRY_ZONE_ATR_MULT * atr;
  const low = round(entry - half, 2);
  const high = round(entry + half, 2);
  const widthPct = entry > 0 ? round((2 * half) / entry * 100, 3) : null;
  const currentDistancePct =
    current !== null && entry > 0 ? round(((current - entry) / entry) * 100, 3) : null;
  return {
    low,
    high,
    mid: round(entry, 2),
    widthPct,
    currentDistancePct,
    atr: round(atr, 2),
    provenance: "derived",
    basis:
      `mark ± ${ENTRY_ZONE_ATR_MULT}×ATR; ATR=${round(atr, 2)} recovered from ` +
      `|entry−stop|÷${ATR_STOP_MULT} (entry = current mark, so mark sits mid-zone)`,
  };
}

// ─────────────────────────── Distances (Panel B) ───────────────────────────

/** % move from `from` to `to` relative to `from`, as a derived Measure. Fail-closed. */
function pctMove(from: number | null, to: number | null, label: string): Measure {
  if (from === null || to === null || from === 0) {
    return { value: null, provenance: "unavailable", basis: `${label} — price level unavailable` };
  }
  return { value: round(((to - from) / from) * 100, 2), provenance: "derived", basis: label };
}

/** Distance from the current mark to the entry reference (≈0 — entry = mark). */
export function distanceToEntry(d: TradingDecision): Measure {
  return pctMove(mv(d.currentPrice), mv(d.entryPrice), "(entry−current)/current × 100");
}

/** Distance from the current mark to the first target (TP1). */
export function distanceToTarget(d: TradingDecision): Measure {
  return pctMove(mv(d.currentPrice), mv(d.takeProfit1), "(TP1−current)/current × 100");
}

// ─────────────────────────── Risk / TP visual geometry (pure) ───────────────────────────

export interface RiskRewardBar {
  /** Each segment is a fraction (0..1) of the full risk→TP3 span, for proportional bars. */
  riskFrac: number;
  tp1Frac: number;
  tp2Frac: number;
  tp3Frac: number;
}

/**
 * Proportional segment widths for the R:R visualisation: the risk leg (entry→stop) and
 * the reward legs (entry→TP1/TP2/TP3), each as a fraction of the full span. Pure geometry
 * from the served prices. null when levels are missing.
 */
export function riskRewardBar(d: TradingDecision): RiskRewardBar | null {
  const entry = mv(d.entryPrice);
  const stop = mv(d.stopLoss);
  const tp1 = mv(d.takeProfit1);
  const tp2 = mv(d.takeProfit2);
  const tp3 = mv(d.takeProfit3);
  if (entry === null || stop === null || tp1 === null || tp2 === null || tp3 === null) return null;
  const risk = Math.abs(entry - stop);
  const r1 = Math.abs(tp1 - entry);
  const r2 = Math.abs(tp2 - entry);
  const r3 = Math.abs(tp3 - entry);
  const span = risk + r3;
  if (span <= 0) return null;
  return {
    riskFrac: round(risk / span, 4),
    tp1Frac: round(r1 / span, 4),
    tp2Frac: round(r2 / span, 4),
    tp3Frac: round(r3 / span, 4),
  };
}

/**
 * Where the current mark sits between entry (0%) and TP3 (100%), direction-aware.
 * Since entry = mark this starts at 0 and advances as price moves toward target — honest.
 * null when levels are missing; clamped 0..100 (price beyond the band pins to an edge).
 */
export function tpProgressPct(d: TradingDecision): number | null {
  const entry = mv(d.entryPrice);
  const tp3 = mv(d.takeProfit3);
  const current = mv(d.currentPrice);
  if (entry === null || tp3 === null || current === null) return null;
  const span = tp3 - entry;
  if (span === 0) return null;
  return round(clamp(((current - entry) / span) * 100, 0, 100), 1);
}

// ─────────────────────────── Data-quality band (Panel D) ───────────────────────────

export interface DataQualityView {
  score: number | null;
  label: "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "UNKNOWN";
  provenance: "real" | "unavailable";
}

/** Deterministic band over the admitting report's DQ score (0..100). Fail-closed to UNKNOWN. */
export function dataQualityBand(score: number | null | undefined): DataQualityView {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return { score: null, label: "UNKNOWN", provenance: "unavailable" };
  }
  const s = clamp(score, 0, 100);
  const label = s >= 95 ? "EXCELLENT" : s >= 85 ? "GOOD" : s >= 70 ? "FAIR" : "POOR";
  return { score: round(s, 0), label, provenance: "real" };
}

// ─────────────────────────── Per-panel live status ───────────────────────────

export interface LiveStatusInput {
  nowMs: number;
  /** Epoch ms of the last successful poll for this panel's data source (null = never). */
  lastUpdated: number | null;
  hasError: boolean;
  hasData: boolean;
  decision?: TradingDecision | null;
}

/**
 * Single deterministic per-panel status. Precedence (highest first):
 *   UNAVAILABLE (no data) → STALE (poll gone cold) → BLOCKED (control/risk/overall blocked)
 *   → WAITING (waiting/incomplete) → LIVE. Pure: freshness uses the injected `nowMs`.
 */
export function panelLiveStatus(input: LiveStatusInput): PanelLiveStatus {
  const { nowMs, lastUpdated, hasError, hasData, decision } = input;
  if (!hasData) return "UNAVAILABLE";
  if (hasError && lastUpdated === null) return "UNAVAILABLE";
  if (lastUpdated === null || nowMs - lastUpdated > STALE_AFTER_MS) return "STALE";
  if (decision) {
    if (decision.overallStatus === "BLOCKED" || decision.controlStatus === "BLOCKED") return "BLOCKED";
    if (decision.overallStatus === "WAITING" || decision.overallStatus === "INCOMPLETE") return "WAITING";
  }
  return "LIVE";
}

// ─────────────────────────── Opportunity board sorting (Panel E) ───────────────────────────

/**
 * A board row augmented with the ages joined from the decisions payload (RankedDecision
 * itself carries no age — the sealed ranking shape is unchanged; the container joins by
 * symbol+timeframe). Ages enable Signal-Age / Feature-Age sorting without recomputation.
 */
export interface RankedRow extends RankedDecision {
  signalAgeSeconds: number | null;
  featureAgeSeconds: number | null;
}

export type RankSortKey =
  | "rank"
  | "confidence"
  | "riskReward"
  | "quality"
  | "signalAge"
  | "featureAge";

/** Age keys sort freshest-first (ascending); value keys sort best-first (descending). */
const ASCENDING_KEYS = new Set<RankSortKey>(["signalAge", "featureAge"]);

/**
 * Deterministic, stable sort of a ranked column. Nulls always sort last regardless of
 * direction; ties break by symbol then timeframe so the order is total and never jitters
 * between polls. Returns a new array (input untouched).
 */
export function sortRanked(rows: RankedRow[], key: RankSortKey): RankedRow[] {
  const raw = (r: RankedRow): number | null => {
    switch (key) {
      case "confidence":
        return r.confidence;
      case "riskReward":
        return r.riskReward;
      case "quality":
        return r.components.featureQuality;
      case "signalAge":
        return r.signalAgeSeconds;
      case "featureAge":
        return r.featureAgeSeconds;
      case "rank":
      default:
        return r.rankScore;
    }
  };
  const asc = ASCENDING_KEYS.has(key);
  return [...rows].sort((a, b) => {
    const va = raw(a);
    const vb = raw(b);
    // Nulls last, both directions.
    if (va === null && vb === null) {
      /* fall through to tiebreak */
    } else if (va === null) {
      return 1;
    } else if (vb === null) {
      return -1;
    } else {
      const d = asc ? va - vb : vb - va;
      if (d !== 0 && Number.isFinite(d)) return d;
    }
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return a.timeframe < b.timeframe ? -1 : a.timeframe > b.timeframe ? 1 : 0;
  });
}
