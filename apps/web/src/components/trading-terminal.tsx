"use client";

import { useMemo, useState } from "react";
import { useConsensus, useDecisions, useRanking } from "@/lib/trading-decision-client";
import { useRuntimeState } from "@/lib/control-client";
import type {
  Consensus,
  Measure,
  OpportunityBoard,
  RankedDecision,
  TradingDecision,
} from "@/lib/trading-decision-types";
import {
  dataQualityBand,
  distanceToEntry,
  distanceToTarget,
  entryZone,
  panelLiveStatus,
  riskRewardBar,
  setupGrade,
  sortRanked,
  tpProgressPct,
  winProbability,
  type EntryZoneView,
  type GradeView,
  type PanelLiveStatus,
  type ProbabilityView,
  type RankedRow,
  type RankSortKey,
} from "@/lib/terminal-derivations";
import {
  GradeBadge,
  LiveTag,
  Meter,
  ProvDot,
  ProvTag,
  RRBar,
  Stat,
  TPProgress,
  Val,
  ZoneBar,
  fmt,
} from "./terminal-viz";
import { Badge, Dot, fmtDuration, Panel, type PanelPollState, type Tone } from "./console-ui";

/* ─────────────────── tone maps ─────────────────── */

const DIRECTION_TONE: Record<string, Tone> = { LONG: "positive", SHORT: "negative", FLAT: "neutral" };
const CONTROL_TONE: Record<string, Tone> = { ALLOWED: "positive", BLOCKED: "negative", UNKNOWN: "neutral" };
const OVERALL_TONE: Record<string, Tone> = {
  ACTIONABLE: "positive",
  WAITING: "warning",
  BLOCKED: "negative",
  NO_TRADE: "neutral",
  INCOMPLETE: "warning",
};
const RUNTIME_TONE: Record<string, Tone> = {
  HEALTHY: "positive",
  DEGRADED: "warning",
  RECOVERING: "warning",
  STARTING: "warning",
  BOOTING: "warning",
  PROTECTED: "negative",
  STOPPED: "negative",
  FAILED: "negative",
};
const DQ_TONE: Record<string, Tone> = {
  EXCELLENT: "positive",
  GOOD: "positive",
  FAIR: "warning",
  POOR: "negative",
  UNKNOWN: "neutral",
};

/* ─────────────────── A. Market Overview ─────────────────── */

export function MarketOverviewPanel({
  d,
  grade,
  prob,
  runtimeState,
  live,
  state,
}: {
  d: TradingDecision;
  grade: GradeView;
  prob: ProbabilityView;
  runtimeState: string | null;
  live: PanelLiveStatus;
  state: PanelPollState;
}) {
  const dir = DIRECTION_TONE[d.direction] ?? "neutral";
  return (
    <Panel
      title="Market Overview"
      hint="Verbatim direction & conviction from the signal engine, with a deterministic setup grade and an estimated follow-through."
      badge={<LiveTag status={live} />}
      state={state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge tone={dir} text={d.direction} />
          <div>
            <div className="text-lg font-semibold text-slate-100">{d.symbol}</div>
            <div className="font-mono text-[10px] text-slate-500">
              {d.timeframe} · bias {d.bias}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <div className="font-mono text-[9px] uppercase tracking-wider text-slate-500">setup grade</div>
            <div className="flex justify-end">
              <ProvTag p={grade.provenance} />
            </div>
          </div>
          <GradeBadge g={grade} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={OVERALL_TONE[d.overallStatus] ?? "neutral"} text={d.overallStatus} />
        <Badge tone={CONTROL_TONE[d.controlStatus] ?? "neutral"} text={`ctrl ${d.controlStatus}`} />
        <Badge tone={runtimeState ? RUNTIME_TONE[runtimeState] ?? "neutral" : "neutral"} text={`runtime ${runtimeState ?? "UNKNOWN"}`} />
        <span className="inline-flex items-center gap-1.5" title={d.marketRegime.basis}>
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">regime</span>
          <Badge tone="info" text={d.marketRegime.regime ?? "n/a"} />
          <ProvDot p={d.marketRegime.provenance} />
        </span>
      </div>

      <Meter
        label="confidence"
        value={d.confidence * 100}
        display={fmt(d.confidence, 4)}
        tone={dir === "neutral" ? "info" : dir}
        provenance="verbatim"
      />
      <Meter
        label="win probability"
        value={prob.value ?? 0}
        display={prob.value === null ? "—" : `${fmt(prob.value, 0)}%`}
        tone="warning"
        provenance={prob.provenance}
      />
      <p className="font-mono text-[9px] leading-relaxed text-slate-600" title={prob.basis}>
        win probability is an ESTIMATE (heuristic) — not a historical or backtested win rate
      </p>
    </Panel>
  );
}

/* ─────────────────── B. Trade Plan ─────────────────── */

export function TradePlanPanel({
  d,
  zone,
  live,
  state,
}: {
  d: TradingDecision;
  zone: EntryZoneView;
  live: PanelLiveStatus;
  state: PanelPollState;
}) {
  const rr = riskRewardBar(d);
  const prog = tpProgressPct(d);
  const distEntry = distanceToEntry(d);
  const distTarget = distanceToTarget(d);
  return (
    <Panel
      title="Trade Plan"
      hint="ATR-derived entry zone, stop, targets, position sizing and distances. Levels come from the sealed level engine — unavailable when no fresh mark / FLAT."
      badge={<LiveTag status={live} />}
      state={state}
    >
      {/* entry zone */}
      <div className="space-y-2 rounded-lg border border-(--color-line) bg-(--color-surface-900)/50 p-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">entry zone</span>
          <ProvTag p={zone.provenance} />
        </div>
        <ZoneBar low={zone.low} high={zone.high} mid={zone.mid} />
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
          <span className="text-slate-400" title="zone low">low {fmt(zone.low)}</span>
          <span className="text-center text-slate-400" title="zone high">high {fmt(zone.high)}</span>
          <span className="text-right text-slate-400" title={zone.basis}>
            curr dist {zone.currentDistancePct === null ? "—" : `${fmt(zone.currentDistancePct, 2)}%`}
          </span>
        </div>
      </div>

      {/* stop + targets */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Stop" prov={d.stopLoss.provenance} hint={d.stopLoss.basis}><Val m={d.stopLoss} /></Stat>
        <Stat label="TP1" prov={d.takeProfit1.provenance} hint={d.takeProfit1.basis}><Val m={d.takeProfit1} /></Stat>
        <Stat label="TP2" prov={d.takeProfit2.provenance} hint={d.takeProfit2.basis}><Val m={d.takeProfit2} /></Stat>
        <Stat label="TP3" prov={d.takeProfit3.provenance} hint={d.takeProfit3.basis}><Val m={d.takeProfit3} /></Stat>
      </div>

      <RRBar bar={rr} rr={d.riskRewardRatio} />
      <TPProgress pct={prog} />

      {/* sizing */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Size" prov={d.positionSize.provenance} hint={d.positionSize.basis}><Val m={d.positionSize} dp={4} /></Stat>
        <Stat label="Notional" prov={d.positionNotional.provenance} hint={d.positionNotional.basis}><Val m={d.positionNotional} prefix="$" /></Stat>
        <Stat label="Capital Risk" prov={d.capitalRiskPercent.provenance} hint={d.capitalRiskPercent.basis}><Val m={d.capitalRiskPercent} unit="%" /></Stat>
        <Stat label="Hold (est)" prov={d.expectedHoldingTime.provenance} hint={d.expectedHoldingTime.basis}>
          <span className="font-mono text-slate-100">
            {d.expectedHoldingTime.seconds === null ? "—" : fmtDuration(d.expectedHoldingTime.seconds)}
          </span>
        </Stat>
      </div>

      {/* distances */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Dist → Entry" prov={distEntry.provenance} hint={distEntry.basis}><Val m={distEntry} unit="%" /></Stat>
        <Stat label="Dist → Stop" prov={d.stopDistancePct.provenance} hint={d.stopDistancePct.basis}><Val m={d.stopDistancePct} unit="%" /></Stat>
        <Stat label="Dist → Target" prov={distTarget.provenance} hint={distTarget.basis}><Val m={distTarget} unit="%" /></Stat>
      </div>
    </Panel>
  );
}

/* ─────────────────── C. AI Explain ─────────────────── */

function FactorList({ title, factors, tone }: { title: string; factors: { label: string; detail: string }[]; tone: Tone }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Dot tone={tone} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
          {title} ({factors.length})
        </span>
      </div>
      {factors.length === 0 ? (
        <p className="mt-0.5 text-[11px] text-slate-600">none</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {factors.map((f, i) => (
            <li key={i} className="text-[11px] text-slate-300">
              <span className="text-slate-200">{f.label}</span>
              <span className="text-slate-500"> — {f.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConsensusBlock({ data }: { data: Consensus }) {
  return (
    <div className="space-y-2 rounded-md border border-(--color-line) bg-(--color-surface-900)/40 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">multi-TF consensus</span>
          <Badge tone={data.overall ? DIRECTION_TONE[data.overall] ?? "neutral" : "neutral"} text={data.bias} />
        </span>
        <span className="font-mono text-[11px] text-slate-400" title={data.alignmentScore.basis}>
          align {data.alignmentScore.value === null ? "—" : `${fmt(data.alignmentScore.value, 0)}%`}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
        {data.timeframes.map((t) => (
          <div
            key={t.timeframe}
            className={`rounded border px-1.5 py-1 text-[11px] ${t.available ? "border-(--color-line)" : "border-(--color-line)/40 opacity-60"}`}
            title={t.note}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-slate-400">{t.timeframe}</span>
              {t.available && t.direction ? (
                <Dot tone={DIRECTION_TONE[t.direction] ?? "neutral"} />
              ) : (
                <span className="font-mono text-[8px] uppercase text-slate-600">n/a</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="font-mono text-[9px] text-slate-600">{data.note}</p>
    </div>
  );
}

function ConsensusLoader({ symbol }: { symbol: string }) {
  const state = useConsensus(symbol);
  if (state.error && !state.data)
    return <p className="font-mono text-[11px] text-(--color-warning)">consensus: {state.error}</p>;
  if (!state.data) return <p className="font-mono text-[11px] text-slate-500">loading consensus…</p>;
  return <ConsensusBlock data={state.data} />;
}

export function AiExplainPanel({
  d,
  live,
  state,
  withConsensus = true,
}: {
  d: TradingDecision;
  live: PanelLiveStatus;
  state: PanelPollState;
  /** Consensus uses its own poll; disable in unit-render to keep the panel pure. */
  withConsensus?: boolean;
}) {
  const ex = d.explain;
  const cb = ex.confidenceBreakdown;
  return (
    <Panel
      title="AI Explain"
      hint="Deterministic reasoning reconstructed from real feature values (no LLM, no fabrication) — every factor cites a feature; contributions tagged by provenance."
      badge={<LiveTag status={live} />}
      state={state}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FactorList title="bullish" factors={ex.bullish} tone="positive" />
        <FactorList title="bearish" factors={ex.bearish} tone="negative" />
        <FactorList title="neutral" factors={ex.neutral} tone="neutral" />
        <FactorList title="risk" factors={ex.risk} tone="warning" />
      </div>

      {/* contributions */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-(--color-line) bg-(--color-surface-900)/40 p-3">
        <Meter label="trend contribution" value={ex.contributions.trend.value ?? 0} display={ex.contributions.trend.value === null ? "—" : fmt(ex.contributions.trend.value, 0)} tone="info" provenance={ex.contributions.trend.provenance} />
        <Meter label="momentum contribution" value={ex.contributions.momentum.value ?? 0} display={ex.contributions.momentum.value === null ? "—" : fmt(ex.contributions.momentum.value, 0)} tone="info" provenance={ex.contributions.momentum.provenance} />
        <Meter label="liquidity contribution" value={ex.contributions.liquidity.value ?? 0} display={ex.contributions.liquidity.value === null ? "—" : fmt(ex.contributions.liquidity.value, 0)} tone="info" provenance={ex.contributions.liquidity.provenance} />
        <Meter label="volatility contribution" value={ex.contributions.volatility.value ?? 0} display={ex.contributions.volatility.value === null ? "—" : fmt(ex.contributions.volatility.value, 0)} tone="info" provenance={ex.contributions.volatility.provenance} />
      </div>

      {/* confidence breakdown */}
      <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-2 text-[11px]">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">confidence breakdown</span>
        <div className="mt-0.5 text-slate-300" title={cb.basis}>
          total {fmt(cb.total, 4)}
          {cb.trendComponent !== null &&
            ` = trend ${fmt(cb.trendComponent, 4)} + momentum ${fmt(cb.momentumComponent ?? 0, 4)}`}
        </div>
        <div className="mt-1 grid grid-cols-1 gap-0.5 text-[10px] text-slate-500 sm:grid-cols-3">
          <span title="execution readiness">exec: {ex.executionReadiness}</span>
          <span title="risk approval">risk: {ex.riskApproval}</span>
          <span title="control approval">control: {ex.controlApproval}</span>
        </div>
      </div>

      {withConsensus && <ConsensusLoader symbol={d.symbol} />}

      {d.provenanceNotes.length > 0 && (
        <div className="rounded-md border border-(--color-line)/60 bg-(--color-surface-900)/30 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-600">provenance / honest gaps</span>
          <ul className="mt-0.5 space-y-0.5">
            {d.provenanceNotes.map((n, i) => (
              <li key={i} className="font-mono text-[10px] text-slate-500">• {n}</li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── D. Market Analysis ─────────────────── */

function scoreMeter(label: string, m: Measure) {
  return (
    <Meter
      label={label}
      value={m.value ?? 0}
      display={m.value === null ? "—" : fmt(m.value, 1)}
      tone="info"
      provenance={m.provenance}
    />
  );
}

export function MarketAnalysisPanel({
  d,
  dqScore,
  live,
  state,
}: {
  d: TradingDecision;
  dqScore: number | null;
  live: PanelLiveStatus;
  state: PanelPollState;
}) {
  const dq = dataQualityBand(dqScore);
  return (
    <Panel
      title="Market Analysis"
      hint="Deterministic 0–100 factor scores from real persisted features, data-freshness, the admitting DQ score, and reproducibility lineage."
      badge={<LiveTag status={live} />}
      state={state}
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {scoreMeter("trend strength", d.trendStrength)}
        {scoreMeter("momentum", d.momentumScore)}
        {scoreMeter("volatility", d.volatilityScore)}
        {scoreMeter("liquidity", d.liquidityScore)}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Signal Age" prov="real" hint="age of the admitted EngineSignal row">
          <span className="font-mono text-slate-100">{fmtDuration(d.signalAgeSeconds)}</span>
        </Stat>
        <Stat label="Feature Age" prov={d.featureAgeSeconds === null ? "unavailable" : "real"} hint="age of the FeatureSnapshot the signal was built from">
          <span className="font-mono text-slate-100">{d.featureAgeSeconds === null ? "—" : fmtDuration(d.featureAgeSeconds)}</span>
        </Stat>
        <Stat label="DQ Score" prov={dq.provenance} hint="DataQualityReport.score of the admitting report">
          <span className="font-mono text-slate-100">{dq.score === null ? "—" : `${dq.score}/100`}</span>
        </Stat>
        <Stat label="Data Quality" prov={dq.score === null ? "unavailable" : "derived"} hint="deterministic band over the DQ score">
          <Badge tone={DQ_TONE[dq.label] ?? "neutral"} text={dq.label} />
        </Stat>
      </div>

      <div className="space-y-1 rounded-md border border-(--color-line) bg-(--color-surface-900)/40 px-3 py-2 font-mono text-[10px] text-slate-500">
        <div className="flex items-center justify-between gap-2">
          <span>feature hash</span>
          <span className="truncate text-slate-300" title={d.featureHash}>{d.featureHash}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span>strategy version</span>
          <span className="truncate text-slate-300" title={d.strategyVersionId}>{d.strategyVersionId}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span>dataset hash</span>
          <span className="truncate text-slate-400" title={d.datasetHash}>{d.datasetHash}</span>
        </div>
      </div>
    </Panel>
  );
}

/* ─────────────────── E. Opportunity Board ─────────────────── */

const SORT_KEYS: { key: RankSortKey; label: string }[] = [
  { key: "rank", label: "Rank" },
  { key: "confidence", label: "Confidence" },
  { key: "riskReward", label: "R:R" },
  { key: "quality", label: "Quality" },
  { key: "signalAge", label: "Signal Age" },
  { key: "featureAge", label: "Feature Age" },
];

function RankRow({ r, selected, onSelect }: { r: RankedRow; selected: boolean; onSelect?: (s: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(r.symbol)}
      className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? "border-(--color-accent-500)/50 bg-(--color-accent-500)/10"
          : "border-(--color-line) bg-(--color-surface-900)/50 hover:border-(--color-accent-500)/30"
      }`}
    >
      <span className="flex items-center gap-2">
        <Badge tone={DIRECTION_TONE[r.direction] ?? "neutral"} text={r.direction} />
        <span className="text-[13px] text-slate-200">{r.symbol}</span>
        <span className="font-mono text-[10px] text-slate-500">{r.timeframe}</span>
      </span>
      <span className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
        <span title="rank score">★ {fmt(r.rankScore, 3)}</span>
        <span title="confidence">c {fmt(r.confidence, 2)}</span>
        <span title="risk/reward">{r.riskReward === null ? "rr —" : `rr ${fmt(r.riskReward, 2)}`}</span>
      </span>
    </button>
  );
}

function RankColumn({
  title,
  tone,
  rows,
  selected,
  onSelect,
}: {
  title: string;
  tone: Tone;
  rows: RankedRow[];
  selected: string | null;
  onSelect?: (s: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Badge tone={tone} text={`${rows.length}`} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{title}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-slate-600">none</p>
      ) : (
        rows.map((r) => (
          <RankRow key={`${r.symbol}-${r.timeframe}`} r={r} selected={r.symbol === selected} onSelect={onSelect} />
        ))
      )}
    </div>
  );
}

export interface SortedBoard {
  topLong: RankedRow[];
  topShort: RankedRow[];
  watchlist: RankedRow[];
  blocked: RankedRow[];
  waiting: RankedRow[];
  total: number;
  note: string;
}

export function OpportunityBoardPanel({
  board,
  sortKey,
  onSort,
  selected,
  onSelect,
  live,
  state,
}: {
  board: SortedBoard | null;
  sortKey: RankSortKey;
  onSort?: (k: RankSortKey) => void;
  selected: string | null;
  onSelect?: (s: string) => void;
  live: PanelLiveStatus;
  state: PanelPollState;
}) {
  return (
    <Panel
      title="Opportunity Board"
      hint="Every active decision deterministically scored (confidence · R:R · liquidity · feature quality · approvals) and bucketed. Click a row to focus the terminal."
      badge={
        <span className="flex items-center gap-2">
          <LiveTag status={live} />
          {board && <Badge tone="info" text={`${board.total} ranked`} />}
        </span>
      }
      state={state}
    >
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Sort ranking">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">sort</span>
        {SORT_KEYS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSort?.(s.key)}
            aria-pressed={sortKey === s.key}
            className={`rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              sortKey === s.key
                ? "border-(--color-accent-500)/50 bg-(--color-accent-500)/10 text-(--color-accent-500)"
                : "border-(--color-line) text-slate-500 hover:text-slate-300"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {board && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <RankColumn title="Top Long" tone="positive" rows={board.topLong} selected={selected} onSelect={onSelect} />
          <RankColumn title="Top Short" tone="negative" rows={board.topShort} selected={selected} onSelect={onSelect} />
          <RankColumn title="Watchlist" tone="neutral" rows={board.watchlist} selected={selected} onSelect={onSelect} />
          <RankColumn title="Blocked" tone="negative" rows={board.blocked} selected={selected} onSelect={onSelect} />
          <RankColumn title="Waiting" tone="warning" rows={board.waiting} selected={selected} onSelect={onSelect} />
        </div>
      )}
      {board && <p className="font-mono text-[9px] text-slate-600">{board.note}</p>}
    </Panel>
  );
}

/* ─────────────────── container ─────────────────── */

function augment(rows: RankedDecision[], ageMap: Map<string, { s: number | null; f: number | null }>): RankedRow[] {
  return rows.map((r) => {
    const a = ageMap.get(`${r.symbol}|${r.timeframe}`);
    return { ...r, signalAgeSeconds: a?.s ?? null, featureAgeSeconds: a?.f ?? null };
  });
}

export function TradingTerminal({
  selected: controlledSelected,
  onSelect,
}: {
  /** Optional controlled symbol focus (shared with the other terminals on the page). */
  selected?: string | null;
  onSelect?: (symbol: string) => void;
} = {}) {
  const decisions = useDecisions();
  const ranking = useRanking();
  const runtime = useRuntimeState();
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selected = controlledSelected !== undefined ? controlledSelected : localSelected;
  const setSelected = onSelect ?? setLocalSelected;
  const [sortKey, setSortKey] = useState<RankSortKey>("rank");

  const view = decisions.data;
  const nowMs = Date.now();

  const symbols = useMemo(() => (view ? view.decisions.map((d) => d.symbol) : []), [view]);
  // Keep the user's selection if it's still present; otherwise focus the first symbol.
  const active = selected && symbols.includes(selected) ? selected : symbols[0] ?? null;
  const decision = useMemo(
    () => (view && active ? view.decisions.find((d) => d.symbol === active) ?? null : null),
    [view, active],
  );
  const dqScore = decision && view ? view.dqScores[decision.signalId] ?? null : null;
  const origin = decision && view ? view.origins?.[decision.signalId] ?? null : null;

  const grade = useMemo(() => (decision ? setupGrade(decision) : null), [decision]);
  const prob = useMemo(() => (decision ? winProbability(decision) : null), [decision]);
  const zone = useMemo(() => (decision ? entryZone(decision) : null), [decision]);

  const ageMap = useMemo(() => {
    const m = new Map<string, { s: number | null; f: number | null }>();
    view?.decisions.forEach((d) => m.set(`${d.symbol}|${d.timeframe}`, { s: d.signalAgeSeconds, f: d.featureAgeSeconds }));
    return m;
  }, [view]);

  const board: OpportunityBoard | null = ranking.data;
  const sortedBoard: SortedBoard | null = useMemo(() => {
    if (!board) return null;
    return {
      topLong: sortRanked(augment(board.topLong, ageMap), sortKey),
      topShort: sortRanked(augment(board.topShort, ageMap), sortKey),
      watchlist: sortRanked(augment(board.watchlist, ageMap), sortKey),
      blocked: sortRanked(augment(board.blocked, ageMap), sortKey),
      waiting: sortRanked(augment(board.waiting, ageMap), sortKey),
      total: board.total,
      note: board.note,
    };
  }, [board, ageMap, sortKey]);

  const decisionState: PanelPollState = {
    loading: decisions.loading,
    error: decisions.error,
    lastUpdated: decisions.lastUpdated,
  };
  const rankingState: PanelPollState = {
    loading: ranking.loading,
    error: ranking.error,
    lastUpdated: ranking.lastUpdated,
  };

  const panelLive = panelLiveStatus({
    nowMs,
    lastUpdated: decisions.lastUpdated,
    hasError: !!decisions.error,
    hasData: !!decision,
    decision,
  });
  const boardLive = panelLiveStatus({
    nowMs,
    lastUpdated: ranking.lastUpdated,
    hasError: !!ranking.error,
    hasData: !!sortedBoard,
  });
  const runtimeStateStr = runtime.data?.current ?? null;

  // Empty / loading states (no decisions to focus).
  const empty = view && view.decisions.length === 0;

  return (
    <div className="space-y-5">
      {/* workspace-wide status bar */}
      <div className="glass flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">runtime</span>
          <Badge tone={runtimeStateStr ? RUNTIME_TONE[runtimeStateStr] ?? "neutral" : "neutral"} text={runtimeStateStr ?? "UNKNOWN"} />
          {origin === "DEMO" && (
            <span title="the focused decision derives from the synthetic DEMO lineage, not market data">
              <Badge tone="warning" text="demo lineage" />
            </span>
          )}
          {runtime.data?.reason && (
            <span className="hidden font-mono text-[10px] text-slate-600 sm:inline" title={runtime.data.reason}>
              {runtime.data.reason.length > 48 ? `${runtime.data.reason.slice(0, 48)}…` : runtime.data.reason}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Focus symbol">
          {symbols.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSelected(s)}
              aria-pressed={s === active}
              className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                s === active
                  ? "border-(--color-accent-500)/50 bg-(--color-accent-500)/10 text-(--color-accent-500)"
                  : "border-(--color-line) text-slate-400 hover:text-slate-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <div className="glass p-6 text-sm text-slate-400">
          <p className="mb-1 text-slate-200">No trading decisions yet.</p>
          <p>
            Decisions are derived from admitted{" "}
            <span className="font-mono text-slate-300">EngineSignal</span> rows. Start the worker
            (and ingestion for live prices) to populate the terminal.
          </p>
        </div>
      ) : decision && grade && prob && zone ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MarketOverviewPanel d={decision} grade={grade} prob={prob} runtimeState={runtimeStateStr} live={panelLive} state={decisionState} />
          <MarketAnalysisPanel d={decision} dqScore={dqScore} live={panelLive} state={decisionState} />
          <TradePlanPanel d={decision} zone={zone} live={panelLive} state={decisionState} />
          <AiExplainPanel d={decision} live={panelLive} state={decisionState} />
        </div>
      ) : decisions.error ? (
        <div className="glass p-6 text-sm text-slate-400">
          Decisions unavailable — {decisions.error}
        </div>
      ) : (
        // Skeleton mirrors the 2×2 panel grid so the arriving data replaces
        // reserved space instead of shifting the layout (CLS).
        <div
          className="grid grid-cols-1 gap-4 xl:grid-cols-2"
          aria-busy="true"
          role="status"
          aria-label="Loading decisions"
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="glass space-y-3 p-5">
              <div className="h-4 w-40 animate-pulse rounded bg-(--color-surface-800)" />
              <div className="h-40 animate-pulse rounded-md bg-(--color-surface-800)/60" />
            </div>
          ))}
        </div>
      )}

      {view && view.symbolsMissingPrice.length > 0 && (
        <p className="font-mono text-[10px] text-slate-600">
          no fresh mark for: {view.symbolsMissingPrice.join(", ")} — price-dependent fields show n/a
          (run ingestion concurrently for live prices)
        </p>
      )}

      <OpportunityBoardPanel
        board={sortedBoard}
        sortKey={sortKey}
        onSort={setSortKey}
        selected={active}
        onSelect={setSelected}
        live={boardLive}
        state={rankingState}
      />
    </div>
  );
}
