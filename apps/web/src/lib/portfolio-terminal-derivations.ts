/**
 * Phase 10C-2B-1 — Professional Portfolio Terminal: PRESENTATION-ONLY deterministic
 * derivations.
 *
 * Every function here is a PURE, deterministic transform of already-served Portfolio
 * Intelligence outputs (the single source of truth: `@nexus/portfolio-intelligence` via the
 * `/api/v1/portfolio/*` API) plus the verbatim served decisions / readiness rows. NOTHING is
 * recomputed, NOTHING is fabricated, no clock or randomness lives here, no Prisma / fetch is
 * imported. The engine's provenance (REAL / DERIVED / ESTIMATED / UNAVAILABLE) is carried
 * through untouched — the presentation layer only derives display GEOMETRY (bar widths,
 * tones, ordering, formatted strings).
 *
 * Fail-closed contract (mirrors terminal-derivations.ts): any null / undefined / NaN /
 * Infinity input yields `null` (rendered "—" / UNAVAILABLE upstream), NEVER a fabricated 0,
 * NEVER a NaN. This module touches no sealed code.
 */

import type { TradingDecision, Measure } from "./trading-decision-types";
import type { ReadinessBand, ReadinessRow } from "./trade-plan-types";
import type {
  CapitalAllocation,
  ExposureGroup,
  HeatBand,
  PortfolioExposure,
  PortfolioHealth,
  PortfolioMeasure,
  PortfolioStatistics,
  PortfolioStatus,
  PortfolioSummary,
  PortfolioWarning,
  PortfolioWarnings,
  Provenance,
  RiskHeat,
  SignalDecision,
  SymbolAllocation,
  WarningSeverity,
} from "./portfolio-types";
import type { Tone } from "@/components/console-ui";

// ─────────────────────────── small pure helpers ───────────────────────────

/** A finite number, or null (fail-closed — non-finite is treated as absent). */
export function finite(n: number | null | undefined): number | null {
  return n === null || n === undefined || !Number.isFinite(n) ? null : n;
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Finite value of a Measure, or null (a non-finite measure is treated as absent). */
function mv(m: Measure | PortfolioMeasure | null | undefined): number | null {
  if (!m) return null;
  return finite(m.value);
}

/** Clamp a value to a 0..100 meter fill fraction. Fail-closed to 0. */
export function fillPct(value: number | null | undefined): number {
  const v = finite(value ?? null);
  return v === null ? 0 : clamp(v, 0, 100);
}

// ─────────────────────────── formatters (fail-closed) ───────────────────────────

/** Format a percent value (already on a 0..100 scale) → "12.3%". Null/NaN → "—". */
export function formatPercent(value: number | null | undefined, dp = 1): string {
  const v = finite(value ?? null);
  if (v === null) return "—";
  return `${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`;
}

/** Format a currency ($) value → "$50,000". Null/NaN → "—". */
export function formatCurrency(value: number | null | undefined, dp = 0): string {
  const v = finite(value ?? null);
  if (v === null) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

/** Format a capital-at-risk percent → "1.00%". Null/NaN → "—". */
export function formatRisk(value: number | null | undefined, dp = 2): string {
  return formatPercent(value, dp);
}

/** Format a plain number → "3.00". Null/NaN → "—". */
export function formatNumber(value: number | null | undefined, dp = 2): string {
  const v = finite(value ?? null);
  if (v === null) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Format a reward:risk ratio → "3.00:1". Null/NaN → "—". */
export function formatRatio(value: number | null | undefined, dp = 2): string {
  const v = finite(value ?? null);
  return v === null ? "—" : `${formatNumber(v, dp)}:1`;
}

/** Format a 0..1 confidence as a percent → "90%". Null/NaN → "—". */
export function formatConfidence(value: number | null | undefined, dp = 0): string {
  const v = finite(value ?? null);
  return v === null ? "—" : formatPercent(v * 100, dp);
}

// ─────────────────────────── status / band tones ───────────────────────────

export interface StatusView {
  label: string;
  tone: Tone;
}

const STATUS_TONE: Record<PortfolioStatus, Tone> = {
  HEALTHY: "positive",
  CAUTION: "warning",
  RISK: "negative",
  BLOCKED: "negative",
};

/** Presentation tone + label for the headline portfolio status. Null → UNAVAILABLE. */
export function buildPortfolioStatus(status: PortfolioStatus | null | undefined): StatusView {
  if (!status || !(status in STATUS_TONE)) return { label: "UNAVAILABLE", tone: "neutral" };
  return { label: status, tone: STATUS_TONE[status] };
}

const HEAT_TONE: Record<HeatBand, Tone> = {
  COOL: "positive",
  WARM: "info",
  HOT: "warning",
  EXTREME: "negative",
};

/** Presentation tone + label for a risk-heat band. Null → UNAVAILABLE. */
export function heatBandView(band: HeatBand | null | undefined): StatusView {
  if (!band || !(band in HEAT_TONE)) return { label: "UNAVAILABLE", tone: "neutral" };
  return { label: band, tone: HEAT_TONE[band] };
}

const SEVERITY_TONE: Record<WarningSeverity, Tone> = {
  CRITICAL: "negative",
  HIGH: "negative",
  MEDIUM: "warning",
  LOW: "info",
};

export function severityTone(severity: WarningSeverity): Tone {
  return SEVERITY_TONE[severity] ?? "neutral";
}

/** Tone for a provenance tag (mirrors terminal-viz PROV_TONE). */
export const PROVENANCE_TONE: Record<Provenance, Tone> = {
  verbatim: "positive",
  real: "positive",
  derived: "info",
  estimated: "warning",
  unavailable: "neutral",
};

// ─────────────────────────── summary cards (Panel A) ───────────────────────────

export interface SummaryCard {
  label: string;
  value: string;
  /** Optional tone for the value (status cards). */
  tone?: Tone;
  /** Audit hint shown on hover. */
  hint?: string;
  /**
   * Visible provenance chip (e.g. "assumed") for figures whose basis the label
   * alone cannot carry — a hover hint is not enough for a $-headline.
   */
  qualifier?: string;
}

/**
 * The Panel A headline cards. The PortfolioSummary fields are plain aggregated numbers WITHOUT
 * per-field provenance, so we never invent a provenance tag for them — we only format them
 * fail-closed. Counts render their integer verbatim (0 is a real count here, not a fabricated
 * value); $-figures fail closed to "—". Capital/risk figures derive from the ASSUMED display
 * equity (no live account exists anywhere in the system), so those cards carry a visible
 * "assumed" qualifier plus the exact basis in their hint — the provenance must never be
 * dropped at the card level.
 */
export function buildSummaryCards(summary: PortfolioSummary | null | undefined): SummaryCard[] {
  const s = summary ?? null;
  const count = (n: number | null | undefined): string => {
    const v = finite(n ?? null);
    return v === null ? "—" : String(Math.trunc(v));
  };
  const status = buildPortfolioStatus(s?.status);
  const assumedBasis =
    s === null
      ? "assumed display book (no live account)"
      : `of assumed equity ${formatCurrency(s.assumedEquity)} — display book (TRADING_DECISION_EQUITY_USD), not a live account`;
  return [
    { label: "Status", value: status.label, tone: status.tone, hint: s?.note ?? "portfolio status" },
    { label: "Net Exposure", value: formatCurrency(s?.netExposure), hint: "long − short notional (OPEN)" },
    { label: "Long Exposure", value: formatCurrency(s?.longExposure), hint: "long notional (OPEN)" },
    { label: "Short Exposure", value: formatCurrency(s?.shortExposure), hint: "short notional (OPEN)" },
    { label: "Capital Used", value: formatCurrency(s?.capitalUsed), hint: `capital deployed — ${assumedBasis}`, qualifier: "assumed" },
    { label: "Capital Available", value: formatCurrency(s?.capitalAvailable), hint: `capital remaining — ${assumedBasis}`, qualifier: "assumed" },
    { label: "Risk Used", value: formatCurrency(s?.riskUsed), hint: `Σ max-loss of OPEN positions — ${assumedBasis}`, qualifier: "assumed" },
    { label: "Risk Remaining", value: formatCurrency(s?.riskRemaining), hint: `risk budget remaining — ${assumedBasis}`, qualifier: "assumed" },
    { label: "Open Trades", value: count(s?.openTrades), tone: "positive", hint: "OPEN positions" },
    { label: "Ready", value: count(s?.readyTrades), tone: "positive", hint: "OPEN & readiness READY" },
    { label: "Waiting", value: count(s?.waitingTrades), tone: "warning", hint: "WAITING positions" },
    { label: "Blocked", value: count(s?.blockedTrades), tone: "negative", hint: "BLOCKED positions" },
    { label: "Flat", value: count(s?.flatTrades), tone: "neutral", hint: "FLAT / NO_TRADE (stand aside)" },
  ];
}

// ─────────────────────────── capital / risk meters (Panel A) ───────────────────────────

export interface MeterView {
  /** 0..100 fill fraction. */
  pct: number;
  /** Formatted "used" figure. */
  usedLabel: string;
  /** Formatted "remaining" figure. */
  remainingLabel: string;
  /** Whether the meter has any real basis (both legs finite). */
  available: boolean;
  basis: string;
}

function meter(used: number | null, remaining: number | null, basis: string): MeterView {
  const u = finite(used);
  const r = finite(remaining);
  if (u === null || r === null) {
    return { pct: 0, usedLabel: formatCurrency(u), remainingLabel: formatCurrency(r), available: false, basis };
  }
  const total = u + r;
  const pct = total > 0 ? clamp((u / total) * 100, 0, 100) : 0;
  return { pct, usedLabel: formatCurrency(u), remainingLabel: formatCurrency(r), available: true, basis };
}

/**
 * Capital-used and risk-used meters from the summary. Fail-closed when a leg is
 * missing. Both meters are denominated in the ASSUMED display equity, and their
 * basis strings say so — the qualifier must survive to the meter level.
 */
export function buildCapitalMeter(summary: PortfolioSummary | null | undefined): {
  capital: MeterView;
  risk: MeterView;
} {
  const s = summary ?? null;
  return {
    capital: meter(
      s?.capitalUsed ?? null,
      s?.capitalAvailable ?? null,
      "capital used ÷ (used + available) — assumed equity book, not a live account",
    ),
    risk: meter(
      s?.riskUsed ?? null,
      s?.riskRemaining ?? null,
      "risk used ÷ (used + remaining) — assumed equity book, not a live account",
    ),
  };
}

// ─────────────────────────── exposure bars (Panel B) ───────────────────────────

export interface ExposureBarView {
  key: string;
  label: string;
  /** 0..100 share fill. */
  pct: number;
  notionalLabel: string;
  count: number;
  provenance: Provenance;
}

const SIDE_LABEL: Record<string, string> = { LONG: "Long", SHORT: "Short" };

/** Map one ExposureGroup → a fail-closed bar view (share verbatim, clamped only for width). */
function exposureBar(g: ExposureGroup, label?: string): ExposureBarView {
  return {
    key: g.key,
    label: label ?? g.key,
    pct: fillPct(g.sharePct),
    notionalLabel: formatCurrency(g.notional),
    count: finite(g.count) ?? 0,
    provenance: g.provenance,
  };
}

export interface ExposureBars {
  bySymbol: ExposureBarView[];
  bySide: ExposureBarView[];
  byRegime: ExposureBarView[];
  byState: ExposureBarView[];
  byConfidence: ExposureBarView[];
  byRisk: ExposureBarView[];
  grossLabel: string;
  netLabel: string;
}

/** Build every documented exposure grouping into bar views. Order is preserved verbatim. */
export function buildExposureBars(exposure: PortfolioExposure | null | undefined): ExposureBars | null {
  if (!exposure) return null;
  const map = (groups: ExposureGroup[] | undefined, labels?: Record<string, string>): ExposureBarView[] =>
    (groups ?? []).map((g) => exposureBar(g, labels?.[g.key]));
  return {
    bySymbol: map(exposure.bySymbol),
    bySide: map(exposure.bySide, SIDE_LABEL),
    byRegime: map(exposure.byRegime),
    byState: map(exposure.buckets?.byState),
    byConfidence: map(exposure.buckets?.byConfidence),
    byRisk: map(exposure.buckets?.byRisk),
    grossLabel: formatCurrency(exposure.grossExposure),
    netLabel: formatCurrency(exposure.netExposure),
  };
}

// ─────────────────────────── allocation bars (Panel C) ───────────────────────────

export interface MeasureView {
  /** Formatted value (fail-closed "—"). */
  label: string;
  /** 0..100 fill (clamped) for an optional bar. */
  pct: number;
  provenance: Provenance;
  basis: string;
}

function measureView(m: PortfolioMeasure | null | undefined, fmt: (v: number | null) => string): MeasureView {
  const v = mv(m);
  return {
    label: fmt(v),
    pct: fillPct(v),
    provenance: m?.provenance ?? "unavailable",
    basis: m?.basis ?? "unavailable",
  };
}

export interface AllocationRowView {
  symbol: string;
  capital: MeasureView;
  risk: MeasureView;
  exposure: MeasureView;
}

export interface AllocationRefView {
  symbol: string | null;
  label: string;
  provenance: Provenance;
  basis: string;
}

export interface AllocationView {
  totals: { capital: MeasureView; risk: MeasureView; exposure: MeasureView };
  perSymbol: AllocationRowView[];
  largestPosition: AllocationRefView;
  largestRisk: AllocationRefView;
  largestOpportunity: AllocationRefView;
  concentration: MeasureView;
  diversification: MeasureView;
}

function refView(ref: CapitalAllocation["largestPosition"] | undefined, fmt: (v: number | null) => string): AllocationRefView {
  return {
    symbol: ref?.symbol ?? null,
    label: ref ? fmt(finite(ref.value)) : "—",
    provenance: ref?.provenance ?? "unavailable",
    basis: ref?.basis ?? "unavailable",
  };
}

/** Build the capital-allocation panel geometry. Concentration drives a derived diversification. */
export function buildAllocationBars(allocation: CapitalAllocation | null | undefined): AllocationView | null {
  if (!allocation) return null;
  const pct = (v: number | null) => formatPercent(v, 1);
  const cur = (v: number | null) => formatCurrency(v);
  const conc = mv(allocation.concentration);
  return {
    totals: {
      capital: measureView(allocation.capitalPct, pct),
      risk: measureView(allocation.riskPct, pct),
      exposure: measureView(allocation.exposurePct, pct),
    },
    perSymbol: (allocation.perSymbol ?? []).map((a: SymbolAllocation) => ({
      symbol: a.symbol,
      capital: measureView(a.capitalPct, pct),
      risk: measureView(a.riskPct, pct),
      exposure: measureView(a.exposurePct, pct),
    })),
    largestPosition: refView(allocation.largestPosition, cur),
    largestRisk: refView(allocation.largestRisk, cur),
    largestOpportunity: refView(allocation.largestOpportunity, (v) => formatNumber(v, 0)),
    concentration: measureView(allocation.concentration, pct),
    // Diversification = 100 − concentration (the engine reports this in heat too); fail-closed.
    diversification: {
      label: conc === null ? "—" : formatPercent(clamp(100 - conc, 0, 100), 1),
      pct: conc === null ? 0 : clamp(100 - conc, 0, 100),
      provenance: allocation.concentration?.provenance ?? "unavailable",
      basis: "100 − concentration",
    },
  };
}

// ─────────────────────────── risk heat (Panel D) ───────────────────────────

export interface HeatComponentView {
  key: string;
  label: string;
  weight: number;
  earned: number;
  /** earned ÷ weight, 0..100, for a per-component bar. */
  earnedPct: number;
  basis: string;
}

export interface HeatView {
  heatScore: number | null;
  heatScoreLabel: string;
  fillPct: number;
  band: StatusView;
  diversification: number | null;
  concentration: number | null;
  portfolioRisk: number | null;
  stability: number | null;
  components: HeatComponentView[];
  provenance: Provenance;
}

/** Build the risk-heat panel geometry. Score/components carried verbatim; widths clamped only. */
export function buildRiskHeatBar(heat: RiskHeat | null | undefined): HeatView | null {
  if (!heat) return null;
  const score = finite(heat.heatScore);
  return {
    heatScore: score,
    heatScoreLabel: score === null ? "—" : formatNumber(score, 0),
    fillPct: fillPct(score),
    band: heatBandView(heat.heatBand),
    diversification: finite(heat.diversificationScore),
    concentration: finite(heat.concentrationScore),
    portfolioRisk: finite(heat.portfolioRisk),
    stability: finite(heat.portfolioStability),
    provenance: heat.provenance ?? "derived",
    components: (heat.components ?? []).map((c) => {
      const w = finite(c.weight);
      const e = finite(c.earned);
      return {
        key: c.key,
        label: c.label,
        weight: w ?? 0,
        earned: e ?? 0,
        earnedPct: w !== null && w > 0 && e !== null ? clamp((e / w) * 100, 0, 100) : 0,
        basis: c.basis,
      };
    }),
  };
}

// ─────────────────────────── warnings (Panel E) ───────────────────────────

export interface WarningItemView {
  id: string;
  severity: WarningSeverity;
  tone: Tone;
  /** Presentation title derived from the source (the value itself is carried verbatim). */
  title: string;
  reason: string;
  basis: string;
  provenance: Provenance;
  source: string;
}

export interface WarningGroupView {
  severity: WarningSeverity;
  tone: Tone;
  count: number;
  items: WarningItemView[];
}

const SEVERITY_ORDER: WarningSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const SOURCE_TITLE: Record<string, string> = {
  control: "Control Plane",
  runtime: "Runtime",
  risk: "Risk Budget",
  exposure: "Exposure",
  capital: "Capital",
  concentration: "Concentration",
  "data-quality": "Data Quality",
  freshness: "Freshness",
  signal: "Signal",
};

function warningItem(w: PortfolioWarning): WarningItemView {
  return {
    id: w.id,
    severity: w.severity,
    tone: severityTone(w.severity),
    title: SOURCE_TITLE[w.source] ?? w.source,
    reason: w.reason,
    basis: w.basis,
    provenance: w.provenance,
    source: w.source,
  };
}

export interface WarningGroupsView {
  groups: WarningGroupView[];
  counts: Record<WarningSeverity, number>;
  total: number;
}

/**
 * Group the warnings by severity in fixed CRITICAL→LOW order, preserving each warning's
 * fields verbatim. Counts come from the engine's own tallies (fail-closed to the grouped
 * length when a tally is missing) — never recomputed in a way that could disagree.
 */
export function buildWarningGroups(warnings: PortfolioWarnings | null | undefined): WarningGroupsView {
  const list = warnings?.warnings ?? [];
  const byKey = new Map<WarningSeverity, WarningItemView[]>();
  for (const sev of SEVERITY_ORDER) byKey.set(sev, []);
  for (const w of list) {
    const bucket = byKey.get(w.severity);
    if (bucket) bucket.push(warningItem(w));
    else byKey.set(w.severity, [warningItem(w)]);
  }
  const engineCount: Record<WarningSeverity, number | undefined> = {
    CRITICAL: warnings?.critical,
    HIGH: warnings?.high,
    MEDIUM: warnings?.medium,
    LOW: warnings?.low,
  };
  const counts = {} as Record<WarningSeverity, number>;
  const groups: WarningGroupView[] = SEVERITY_ORDER.map((severity) => {
    const items = byKey.get(severity) ?? [];
    const count = finite(engineCount[severity] ?? null) ?? items.length;
    counts[severity] = count;
    return { severity, tone: severityTone(severity), count, items };
  });
  return { groups, counts, total: list.length };
}

// ─────────────────────────── statistics (Panel F) ───────────────────────────

export interface StatTileView {
  label: string;
  value: string;
  hint: string;
}

export interface DistributionBarView {
  label: string;
  count: number;
  /** Share of the total, 0..100. */
  pct: number;
}

export interface StatisticsView {
  sampleSize: number;
  tiles: StatTileView[];
  best: { symbol: string | null; label: string };
  worst: { symbol: string | null; label: string };
  confidenceBuckets: DistributionBarView[];
  byAction: DistributionBarView[];
  byReadinessBand: DistributionBarView[];
}

function distribution(record: Record<string, number> | undefined): DistributionBarView[] {
  const entries = Object.entries(record ?? {});
  const total = entries.reduce((acc, [, n]) => acc + (finite(n) ?? 0), 0);
  return entries.map(([label, n]) => {
    const c = finite(n) ?? 0;
    return { label, count: c, pct: total > 0 ? clamp((c / total) * 100, 0, 100) : 0 };
  });
}

/** Build the statistics panel: averages/medians as fail-closed tiles + distribution bars. */
export function buildStatistics(stats: PortfolioStatistics | null | undefined): StatisticsView | null {
  if (!stats) return null;
  const buckets = (stats.distribution?.confidenceBuckets ?? []).map((b) => b);
  const totalBuckets = buckets.reduce((acc, b) => acc + (finite(b.count) ?? 0), 0);
  return {
    sampleSize: finite(stats.sampleSize) ?? 0,
    tiles: [
      { label: "Avg Confidence", value: formatConfidence(stats.averageConfidence), hint: "mean over directional candidates" },
      { label: "Median Confidence", value: formatConfidence(stats.medianConfidence), hint: "median over directional candidates" },
      { label: "Highest", value: formatConfidence(stats.highestConfidence), hint: "max confidence" },
      { label: "Lowest", value: formatConfidence(stats.lowestConfidence), hint: "min confidence" },
      { label: "Avg R:R", value: formatRatio(stats.averageRiskReward), hint: "mean reward:risk" },
      { label: "Avg Readiness", value: formatNumber(stats.averageReadiness, 0), hint: "mean readiness score" },
      { label: "Avg Risk", value: formatRisk(stats.averageRisk), hint: "mean capital-at-risk %" },
    ],
    best: {
      symbol: stats.bestOpportunity?.symbol ?? null,
      label: formatNumber(finite(stats.bestOpportunity?.value ?? null), 0),
    },
    worst: {
      symbol: stats.worstOpportunity?.symbol ?? null,
      label: formatNumber(finite(stats.worstOpportunity?.value ?? null), 0),
    },
    confidenceBuckets: buckets.map((b) => {
      const c = finite(b.count) ?? 0;
      return { label: b.label, count: c, pct: totalBuckets > 0 ? clamp((c / totalBuckets) * 100, 0, 100) : 0 };
    }),
    byAction: distribution(stats.distribution?.byAction),
    byReadinessBand: distribution(stats.distribution?.byReadinessBand),
  };
}

// ─────────────────────────── portfolio table (Panel G) ───────────────────────────

export interface PortfolioTableRow {
  symbol: string;
  direction: SignalDecision | null;
  directionProvenance: Provenance;
  status: StatusView;
  confidence: number | null;
  readiness: number | null;
  readinessBand: ReadinessBand | null;
  /** Capital-at-risk % (verbatim served measure or allocation fallback). */
  risk: { value: number | null; provenance: Provenance };
  capitalPct: { value: number | null; provenance: Provenance };
  exposurePct: { value: number | null; provenance: Provenance };
  notional: number | null;
  riskReward: number | null;
  riskRewardProvenance: Provenance;
  /** Row-level provenance: VERBATIM when a served decision backs the row, else its strongest source. */
  rowProvenance: Provenance;
}

const OVERALL_STATUS_VIEW: Record<string, StatusView> = {
  ACTIONABLE: { label: "READY", tone: "positive" },
  WAITING: { label: "WAITING", tone: "warning" },
  INCOMPLETE: { label: "INCOMPLETE", tone: "warning" },
  BLOCKED: { label: "BLOCKED", tone: "negative" },
  NO_TRADE: { label: "FLAT", tone: "neutral" },
};

/** Presentation status for a row, derived verbatim from the served decision statuses. */
function rowStatus(decision: TradingDecision | undefined): StatusView {
  if (!decision) return { label: "UNAVAILABLE", tone: "neutral" };
  if (decision.controlStatus === "BLOCKED") return { label: "BLOCKED", tone: "negative" };
  return OVERALL_STATUS_VIEW[decision.overallStatus] ?? { label: "UNAVAILABLE", tone: "neutral" };
}

export interface TableSources {
  /** Per-symbol capital/risk/exposure shares — from the served allocation. */
  perSymbol: SymbolAllocation[];
  /** Per-symbol gross notional — from the served exposure. */
  bySymbol: ExposureGroup[];
  /** Served decisions (verbatim direction / confidence / R:R / status / capital-at-risk). */
  decisions: TradingDecision[];
  /** Served readiness rows (verbatim readiness score + band). */
  readiness: ReadinessRow[];
}

/**
 * Join the per-symbol portfolio shares with the served decision + readiness rows into table
 * rows. Every value is carried VERBATIM from its source (the engine remains the single source
 * of truth); the only derivation is the presentation status/tone and the row-level provenance.
 * The symbol universe is the union of all sources, so a position present in only one feed
 * still renders (its missing columns fail closed to "—"). Output order is the allocation order,
 * then exposure-only symbols, then decision-only symbols — deterministic and stable.
 */
export function buildTableRows(sources: TableSources): PortfolioTableRow[] {
  const decisionBySymbol = new Map<string, TradingDecision>();
  // First decision per symbol wins (decisions are already one-per-symbol from the assembler).
  for (const d of sources.decisions ?? []) if (!decisionBySymbol.has(d.symbol)) decisionBySymbol.set(d.symbol, d);
  const readinessBySymbol = new Map<string, ReadinessRow>();
  for (const r of sources.readiness ?? []) if (!readinessBySymbol.has(r.symbol)) readinessBySymbol.set(r.symbol, r);
  const allocBySymbol = new Map<string, SymbolAllocation>();
  for (const a of sources.perSymbol ?? []) if (!allocBySymbol.has(a.symbol)) allocBySymbol.set(a.symbol, a);
  const exposureBySymbol = new Map<string, ExposureGroup>();
  for (const g of sources.bySymbol ?? []) if (!exposureBySymbol.has(g.key)) exposureBySymbol.set(g.key, g);

  // Deterministic symbol universe: allocation order, then new exposure symbols, then new decision symbols.
  const order: string[] = [];
  const seen = new Set<string>();
  const push = (sym: string) => {
    if (!seen.has(sym)) {
      seen.add(sym);
      order.push(sym);
    }
  };
  for (const a of sources.perSymbol ?? []) push(a.symbol);
  for (const g of sources.bySymbol ?? []) push(g.key);
  for (const d of sources.decisions ?? []) push(d.symbol);

  return order.map((symbol) => {
    const decision = decisionBySymbol.get(symbol);
    const ready = readinessBySymbol.get(symbol);
    const alloc = allocBySymbol.get(symbol);
    const exp = exposureBySymbol.get(symbol);

    const capitalRisk = decision?.capitalRiskPercent;
    const risk =
      capitalRisk && mv(capitalRisk) !== null
        ? { value: mv(capitalRisk), provenance: capitalRisk.provenance }
        : { value: mv(alloc?.riskPct), provenance: alloc?.riskPct?.provenance ?? "unavailable" };

    const rowProvenance: Provenance = decision ? "verbatim" : alloc || exp ? "derived" : "unavailable";

    return {
      symbol,
      direction: decision?.direction ?? null,
      directionProvenance: decision ? "verbatim" : "unavailable",
      status: rowStatus(decision),
      confidence: decision ? finite(decision.confidence) : null,
      readiness: ready ? finite(ready.score) : null,
      readinessBand: ready?.band ?? null,
      risk,
      capitalPct: { value: mv(alloc?.capitalPct), provenance: alloc?.capitalPct?.provenance ?? "unavailable" },
      exposurePct: { value: mv(alloc?.exposurePct), provenance: alloc?.exposurePct?.provenance ?? "unavailable" },
      notional: mv(exp ? { value: exp.notional, provenance: exp.provenance, basis: "" } : null),
      riskReward: decision ? mv(decision.riskRewardRatio) : null,
      riskRewardProvenance: decision?.riskRewardRatio?.provenance ?? "unavailable",
      rowProvenance,
    };
  });
}

// ─────────────────────────── table sorting (Panel G) ───────────────────────────

export type PortfolioSortKey =
  | "symbol"
  | "direction"
  | "status"
  | "confidence"
  | "readiness"
  | "risk"
  | "capital"
  | "exposure"
  | "rr"
  | "health";

export type SortDirection = "asc" | "desc";

/** Numeric accessor for a row + key, or null (→ sorts last). */
function rowValue(row: PortfolioTableRow, key: PortfolioSortKey): number | null {
  switch (key) {
    case "confidence":
      return row.confidence;
    case "readiness":
      return row.readiness;
    case "risk":
      return row.risk.value;
    case "capital":
      return row.capitalPct.value;
    case "exposure":
      return row.exposurePct.value;
    case "rr":
      return row.riskReward;
    default:
      return null;
  }
}

/** String accessor for the non-numeric keys (symbol/direction/status/health). */
function rowText(row: PortfolioTableRow, key: PortfolioSortKey): string | null {
  switch (key) {
    case "symbol":
      return row.symbol;
    case "direction":
      return row.direction;
    case "status":
      return row.status.label;
    case "health":
      return row.status.label;
    default:
      return null;
  }
}

const TEXT_KEYS = new Set<PortfolioSortKey>(["symbol", "direction", "status", "health"]);

/**
 * Deterministic, STABLE sort of the portfolio table. Nulls always sort LAST regardless of
 * direction; ties break by symbol so the order is total and never jitters between polls.
 * Returns a new array (input untouched). Mirrors sortRanked in terminal-derivations.ts.
 */
export function sortPortfolio(
  rows: PortfolioTableRow[],
  key: PortfolioSortKey,
  direction: SortDirection = "desc",
): PortfolioTableRow[] {
  const isText = TEXT_KEYS.has(key);
  return [...rows].sort((a, b) => {
    if (isText) {
      const ta = rowText(a, key);
      const tb = rowText(b, key);
      if (ta === null && tb === null) {
        /* tiebreak */
      } else if (ta === null) {
        return 1;
      } else if (tb === null) {
        return -1;
      } else if (ta !== tb) {
        return direction === "asc" ? (ta < tb ? -1 : 1) : ta < tb ? 1 : -1;
      }
    } else {
      const va = rowValue(a, key);
      const vb = rowValue(b, key);
      if (va === null && vb === null) {
        /* tiebreak */
      } else if (va === null) {
        return 1;
      } else if (vb === null) {
        return -1;
      } else {
        const d = direction === "asc" ? va - vb : vb - va;
        if (d !== 0 && Number.isFinite(d)) return d;
      }
    }
    // Stable total order: tiebreak by symbol (always ascending).
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
}

// ─────────────────────────── health (Panel A detail) ───────────────────────────

export interface HealthGateView {
  label: string;
  tone: Tone;
  text: string;
}

export interface HealthView {
  status: StatusView;
  heatBand: StatusView;
  reasons: string[];
  gates: HealthGateView[];
  note: string;
}

function gate(label: string, value: boolean | null, goodWhenTrue = true): HealthGateView {
  if (value === null) return { label, tone: "neutral", text: "UNKNOWN" };
  const good = goodWhenTrue ? value : !value;
  return { label, tone: good ? "positive" : "negative", text: value ? "YES" : "NO" };
}

/** Build the health verdict panel: status + gate flags + itemized reasons, all verbatim. */
export function buildHealthView(health: PortfolioHealth | null | undefined): HealthView | null {
  if (!health) return null;
  return {
    status: buildPortfolioStatus(health.status),
    heatBand: heatBandView(health.heatBand),
    reasons: health.reasons ?? [],
    note: health.note ?? "",
    gates: [
      gate("Runtime Healthy", health.runtimeHealthy ?? null, true),
      gate("Control Allowed", health.controlAllowed ?? null, true),
      gate("Kill Engaged", health.killEngaged ?? null, false),
    ],
  };
}
