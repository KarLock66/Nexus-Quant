/**
 * Phase 10C-2B-1 — Panel F: Portfolio Statistics. Pure, props-only. Confidence / R:R /
 * readiness / risk averages + medians + extremes over the directional candidates, plus the
 * action / readiness-band / confidence distributions. Every figure is fail-closed.
 */

import { Panel, type PanelPollState } from "./console-ui";
import { Bar, Tile } from "./portfolio-viz";
import type { DistributionBarView, StatisticsView } from "@/lib/portfolio-terminal-derivations";
import type { Tone } from "./console-ui";

function Dist({ title, bars, tone }: { title: string; bars: DistributionBarView[]; tone: Tone }) {
  const shown = bars.filter((b) => b.count > 0);
  return (
    <div className="space-y-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{title}</span>
      {shown.length === 0 ? (
        <p className="text-[11px] text-slate-600">none</p>
      ) : (
        shown.map((b) => <Bar key={b.label} label={b.label} pct={b.pct} value={String(b.count)} tone={tone} />)
      )}
    </div>
  );
}

export function PortfolioStatisticsPanel({ view, state }: { view: StatisticsView | null; state: PanelPollState }) {
  return (
    <Panel
      title="Portfolio Statistics"
      hint="Aggregate statistics over the directional candidate positions — averages, medians, extremes and the action / readiness / confidence distributions. Unavailable aggregates fail closed to —."
      state={state}
      empty={!view}
    >
      {view && (
        <>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-400">
              sample size {view.sampleSize}
            </span>
            <span className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-1 font-mono text-[10px] text-slate-400">
              best {view.best.symbol ?? "—"} ({view.best.label})
            </span>
            <span className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-1 font-mono text-[10px] text-slate-400">
              worst {view.worst.symbol ?? "—"} ({view.worst.label})
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {view.tiles.map((t) => (
              <Tile key={t.label} label={t.label} value={t.value} hint={t.hint} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Dist title="confidence" bars={view.confidenceBuckets} tone="positive" />
            <Dist title="by action" bars={view.byAction} tone="info" />
            <Dist title="by readiness" bars={view.byReadinessBand} tone="warning" />
          </div>
        </>
      )}
    </Panel>
  );
}
