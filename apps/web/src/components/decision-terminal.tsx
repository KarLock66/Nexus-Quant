"use client";

import { useMemo, useState } from "react";
import { useTradePlan } from "@/lib/trade-plan-client";
import type {
  Action,
  ChecklistItem,
  DecisionSummary,
  ExecutionChecklist,
  Invalidation,
  InvalidationTrigger,
  ReadinessBand,
  RiskChecklist,
  RiskField,
  RiskTag,
  TradePlan,
  TradeReadiness,
} from "@/lib/trade-plan-types";
import { Badge, Dot, fmtDuration, Panel, type PanelPollState, type Tone } from "./console-ui";
import { fmt, ProvDot } from "./terminal-viz";

/* ─────────────────── tone maps ─────────────────── */

const ACTION_TONE: Record<Action, Tone> = {
  STRONG_BUY: "positive",
  BUY: "positive",
  WATCH: "info",
  WAIT: "warning",
  NO_TRADE: "neutral",
  SELL: "negative",
  STRONG_SELL: "negative",
};

const BAND_TONE: Record<ReadinessBand, Tone> = {
  READY: "positive",
  NEAR: "info",
  FORMING: "warning",
  NOT_READY: "negative",
};

const CHECK_TONE: Record<ChecklistItem["status"], Tone> = {
  PASS: "positive",
  FAIL: "negative",
  UNKNOWN: "neutral",
};

const TRIGGER_TONE: Record<InvalidationTrigger["state"], Tone> = {
  ARMED: "info",
  TRIGGERED: "negative",
  NOT_APPLICABLE: "neutral",
};

const RISK_TAG_TONE: Record<RiskTag, Tone> = {
  REAL: "positive",
  DERIVED: "info",
  ESTIMATED: "warning",
  UNAVAILABLE: "neutral",
};

const DIRECTION_TONE: Record<string, Tone> = { LONG: "positive", SHORT: "negative", FLAT: "neutral" };

function RiskTagChip({ tag }: { tag: RiskTag }) {
  return (
    <span title={`provenance: ${tag}`}>
      <Badge tone={RISK_TAG_TONE[tag]} text={tag} />
    </span>
  );
}

/* ─────────────────── A. Decision Summary ─────────────────── */

export function DecisionSummaryPanel({
  symbol,
  timeframe,
  summary,
  state,
}: {
  symbol: string;
  timeframe: string;
  summary: DecisionSummary;
  state: PanelPollState;
}) {
  const tone = ACTION_TONE[summary.action];
  return (
    <Panel
      title="Decision Summary"
      hint="The action verdict — should I trade, can I trade, and why — derived deterministically from the served decision + gating context. No strategy is recomputed."
      badge={<Badge tone={tone} text={summary.action.replace("_", " ")} />}
      state={state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge tone={DIRECTION_TONE[summary.direction] ?? "neutral"} text={summary.direction} />
          <div>
            <div className="text-lg font-semibold text-slate-100">{symbol}</div>
            <div className="font-mono text-[10px] text-slate-500">
              {timeframe} · confidence {fmt(summary.confidence, 4)}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div
            className={`rounded-lg border px-3 py-1.5 text-base font-bold tracking-wide ${
              tone === "positive"
                ? "border-(--color-positive)/40 bg-(--color-positive)/10 text-(--color-positive)"
                : tone === "negative"
                  ? "border-(--color-negative)/40 bg-(--color-negative)/10 text-(--color-negative)"
                  : tone === "warning"
                    ? "border-(--color-warning)/40 bg-(--color-warning)/10 text-(--color-warning)"
                    : tone === "info"
                      ? "border-(--color-accent-500)/40 bg-(--color-accent-500)/10 text-(--color-accent-500)"
                      : "border-(--color-line) bg-(--color-surface-800) text-slate-400"
            }`}
          >
            {summary.action.replace("_", " ")}
          </div>
        </div>
      </div>

      <p className="text-sm text-slate-300">{summary.headline}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={summary.shouldTrade ? "positive" : "neutral"} text={`should trade: ${summary.shouldTrade ? "yes" : "no"}`} />
        <Badge tone={summary.canTrade ? "positive" : "negative"} text={`can trade: ${summary.canTrade ? "yes" : "no"}`} />
      </div>

      <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/40 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">why</span>
        {summary.why.length === 0 ? (
          <p className="mt-0.5 text-[11px] text-slate-600">no reasons recorded</p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {summary.why.map((w, i) => (
              <li key={i} className="text-[11px] text-slate-300">
                • {w}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/* ─────────────────── B. Execution Checklist ─────────────────── */

function CheckRow({ item }: { item: ChecklistItem }) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-2.5 py-1.5"
      title={item.detail}
    >
      <span className="flex items-center gap-2">
        <Dot tone={CHECK_TONE[item.status]} />
        <span className="text-[12px] text-slate-200">{item.label}</span>
        <ProvDot p={item.provenance} />
      </span>
      <Badge tone={CHECK_TONE[item.status]} text={item.status} />
    </div>
  );
}

export function ExecutionChecklistPanel({
  execution,
  state,
}: {
  execution: ExecutionChecklist;
  state: PanelPollState;
}) {
  return (
    <Panel
      title="Execution Checklist"
      hint="Ten pre-trade gates, each PASS / FAIL / UNKNOWN with its source provenance. A missing source fails closed to UNKNOWN — never PASS."
      badge={
        <Badge
          tone={execution.allPass ? "positive" : execution.failed > 0 ? "negative" : "warning"}
          text={`${execution.passed}/${execution.items.length}`}
        />
      }
      state={state}
    >
      <div className="space-y-1.5">
        {execution.items.map((it) => (
          <CheckRow key={it.id} item={it} />
        ))}
      </div>
      <p className="font-mono text-[9px] text-slate-600">{execution.note}</p>
    </Panel>
  );
}

/* ─────────────────── C. Risk Checklist ─────────────────── */

function RiskRow({ f }: { f: RiskField }) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-lg border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2"
      title={f.basis}
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{f.label}</span>
        <RiskTagChip tag={f.tag} />
      </span>
      <span className="font-mono text-sm font-semibold tabular-nums text-slate-100">
        {f.value === null
          ? "—"
          : f.unit === "$"
            ? `$${fmt(f.value, 2)}`
            : f.unit === "s"
              ? fmtDuration(Math.round(f.value))
              : f.unit === "x"
                ? `${fmt(f.value, 2)}×`
                : `${fmt(f.value, f.unit === "%" ? 2 : 4)}${f.unit}`}
      </span>
    </div>
  );
}

export function RiskChecklistPanel({ risk, state }: { risk: RiskChecklist; state: PanelPollState }) {
  const fields: RiskField[] = [
    risk.maximumLoss,
    risk.capitalAtRisk,
    risk.rMultiple,
    risk.distancePct,
    risk.atrPct,
    risk.rewardPct,
    risk.expectedHoldSeconds,
  ];
  return (
    <Panel
      title="Risk Checklist"
      hint="The concrete risk figures for the trade, each tagged REAL / DERIVED / ESTIMATED / UNAVAILABLE. Read off the served decision — never re-derived; fail-closed to unavailable."
      badge={<Badge tone={RISK_TAG_TONE[risk.category.tag]} text={`risk: ${risk.category.label}`} />}
      state={state}
    >
      <div className="space-y-1.5">
        {fields.map((f) => (
          <RiskRow key={f.key} f={f} />
        ))}
      </div>
      <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/40 px-3 py-2" title={risk.category.basis}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">risk category</span>
          <RiskTagChip tag={risk.category.tag} />
        </div>
        <div className="mt-0.5 text-sm font-semibold text-slate-100">{risk.category.label}</div>
      </div>
      <p className="font-mono text-[9px] text-slate-600">
        {risk.note} · assumed equity ${fmt(risk.assumedEquity, 0)}
      </p>
    </Panel>
  );
}

/* ─────────────────── D. Trade Invalidation ─────────────────── */

function TriggerRow({ t }: { t: InvalidationTrigger }) {
  return (
    <div
      className="flex items-start justify-between gap-2 rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-2.5 py-1.5"
      title={`${t.description} — ${t.basis}`}
    >
      <span className="flex items-start gap-2">
        <span className="mt-1">
          <Dot tone={TRIGGER_TONE[t.state]} />
        </span>
        <span>
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] text-slate-200">{t.label}</span>
            <ProvDot p={t.provenance} />
          </span>
          <span className="block font-mono text-[9px] text-slate-600">{t.basis}</span>
        </span>
      </span>
      <Badge tone={TRIGGER_TONE[t.state]} text={t.state.replace("_", " ")} />
    </div>
  );
}

export function InvalidationPanel({ invalidation, state }: { invalidation: Invalidation; state: PanelPollState }) {
  return (
    <Panel
      title="Trade Invalidation"
      hint="What breaks this trade. Each condition is ARMED (would invalidate), TRIGGERED (already breached), or N/A (no active trade). Every basis cites a live decision value."
      badge={
        <Badge
          tone={invalidation.triggered > 0 ? "negative" : invalidation.armed > 0 ? "info" : "neutral"}
          text={invalidation.triggered > 0 ? `${invalidation.triggered} breached` : `${invalidation.armed} armed`}
        />
      }
      state={state}
    >
      <div className="space-y-1.5">
        {invalidation.triggers.map((t) => (
          <TriggerRow key={t.id} t={t} />
        ))}
      </div>
      <p className="font-mono text-[9px] text-slate-600">{invalidation.summary}</p>
    </Panel>
  );
}

/* ─────────────────── E. Readiness ─────────────────── */

export function ReadinessPanel({ readiness, state }: { readiness: TradeReadiness; state: PanelPollState }) {
  const tone = BAND_TONE[readiness.band];
  return (
    <Panel
      title="Trade Readiness"
      hint="A deterministic 0–100 readiness score from documented weights (gating/approval/freshness-aware) — no AI, no hidden weights. UNKNOWN sources earn 0 (fail-closed)."
      badge={<Badge tone={tone} text={readiness.band.replace("_", " ")} />}
      state={state}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-3xl font-bold tabular-nums text-slate-100">
          {fmt(readiness.score, 1)}
          <span className="ml-1 text-sm font-normal text-slate-500">/ 100</span>
        </div>
        <Badge tone={tone} text={readiness.band.replace("_", " ")} />
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-(--color-surface-800)" aria-hidden="true">
        <div
          className={`h-full rounded-full ${
            tone === "positive"
              ? "bg-(--color-positive)"
              : tone === "negative"
                ? "bg-(--color-negative)"
                : tone === "warning"
                  ? "bg-(--color-warning)"
                  : "bg-(--color-accent-500)"
          }`}
          style={{ width: `${Math.max(0, Math.min(100, readiness.score))}%` }}
        />
      </div>

      <div className="space-y-1.5">
        {readiness.components.map((c) => {
          const pct = c.weight > 0 ? Math.max(0, Math.min(100, (c.earned / c.weight) * 100)) : 0;
          return (
            <div key={c.key} title={c.basis}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{c.label}</span>
                <span className="font-mono text-[11px] tabular-nums text-slate-300">
                  {fmt(c.earned, 1)} / {c.weight}
                </span>
              </div>
              <div
                className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-(--color-surface-800)"
                aria-hidden="true"
              >
                <div className="h-full rounded-full bg-(--color-accent-500)/70" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="font-mono text-[9px] leading-relaxed text-slate-600">{readiness.basis}</p>
    </Panel>
  );
}

/* ─────────────────── container ─────────────────── */

export function DecisionTerminal({
  selected: controlledSelected,
  onSelect,
}: {
  /** Optional controlled symbol focus (shared with the other terminals on the page). */
  selected?: string | null;
  onSelect?: (symbol: string) => void;
} = {}) {
  const tradePlan = useTradePlan();
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selected = controlledSelected !== undefined ? controlledSelected : localSelected;
  const setSelected = onSelect ?? setLocalSelected;

  const view = tradePlan.data;
  const symbols = useMemo(() => (view ? view.plans.map((p) => p.symbol) : []), [view]);
  const active = selected && symbols.includes(selected) ? selected : symbols[0] ?? null;
  const plan: TradePlan | null = useMemo(
    () => (view && active ? view.plans.find((p) => p.symbol === active) ?? null : null),
    [view, active],
  );

  const state: PanelPollState = {
    loading: tradePlan.loading,
    error: tradePlan.error,
    lastUpdated: tradePlan.lastUpdated,
  };

  const empty = view && view.plans.length === 0;

  return (
    <div className="space-y-5">
      {/* symbol selector */}
      <div className="glass flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">decision terminal</span>
          {plan && <Badge tone={ACTION_TONE[plan.summary.action]} text={plan.summary.action.replace("_", " ")} />}
          {plan && <Badge tone={BAND_TONE[plan.readiness.band]} text={`readiness ${fmt(plan.readiness.score, 0)}`} />}
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
          <p className="mb-1 text-slate-200">No trade plans yet.</p>
          <p>
            Trade plans are derived from admitted{" "}
            <span className="font-mono text-slate-300">EngineSignal</span> rows. Start the worker
            (and ingestion for live prices) to populate the terminal.
          </p>
        </div>
      ) : plan ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <DecisionSummaryPanel symbol={plan.symbol} timeframe={plan.timeframe} summary={plan.summary} state={state} />
          <ReadinessPanel readiness={plan.readiness} state={state} />
          <ExecutionChecklistPanel execution={plan.execution} state={state} />
          <RiskChecklistPanel risk={plan.risk} state={state} />
          <div className="xl:col-span-2">
            <InvalidationPanel invalidation={plan.invalidation} state={state} />
          </div>
        </div>
      ) : tradePlan.error ? (
        <div className="glass p-6 text-sm text-slate-400">
          Trade plans unavailable — {tradePlan.error}
        </div>
      ) : (
        // Skeleton mirrors the 2×2 panel grid so the arriving data replaces
        // reserved space instead of shifting the layout (CLS).
        <div
          className="grid grid-cols-1 gap-4 xl:grid-cols-2"
          aria-busy="true"
          role="status"
          aria-label="Loading trade plans"
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
          no fresh mark for: {view.symbolsMissingPrice.join(", ")} — price-dependent risk figures show
          unavailable (run ingestion concurrently for live prices)
        </p>
      )}
    </div>
  );
}
