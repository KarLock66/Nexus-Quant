/**
 * Phase 10C-2B-1 — Panel B: Exposure. Pure, props-only. The book sliced every documented way
 * (symbol / side / regime / state / confidence / risk band). Each group is a fail-closed share
 * bar carrying its own provenance; order is preserved verbatim from the engine.
 */

import { Panel, type PanelPollState } from "./console-ui";
import { Bar } from "./portfolio-viz";
import type { ExposureBars, ExposureBarView } from "@/lib/portfolio-terminal-derivations";
import type { Tone } from "./console-ui";

function Group({ title, bars, tone }: { title: string; bars: ExposureBarView[]; tone: Tone }) {
  return (
    <div className="space-y-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{title}</span>
      {bars.length === 0 ? (
        <p className="text-[11px] text-slate-600">none</p>
      ) : (
        bars.map((b) => (
          <Bar
            key={b.key}
            label={b.label}
            pct={b.pct}
            value={b.notionalLabel}
            count={b.count}
            prov={b.provenance}
            tone={tone}
          />
        ))
      )}
    </div>
  );
}

const SIDE_TONE: Record<string, Tone> = { LONG: "positive", SHORT: "negative" };

export function PortfolioExposurePanel({ bars, state }: { bars: ExposureBars | null; state: PanelPollState }) {
  return (
    <Panel
      title="Exposure"
      hint="Gross notional sliced by symbol, side, regime, lifecycle state, confidence and risk band. Net = long − short; gross = long + short of OPEN positions."
      state={state}
      empty={!bars}
    >
      {bars && (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-1.5">
              <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">gross</span>
              <span className="ml-2 font-mono text-sm tabular-nums text-slate-100">{bars.grossLabel}</span>
            </div>
            <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-1.5">
              <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">net</span>
              <span className="ml-2 font-mono text-sm tabular-nums text-slate-100">{bars.netLabel}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Group title="by symbol" bars={bars.bySymbol} tone="info" />
            <div className="space-y-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">by side</span>
              {bars.bySide.length === 0 ? (
                <p className="text-[11px] text-slate-600">none</p>
              ) : (
                bars.bySide.map((b) => (
                  <Bar
                    key={b.key}
                    label={b.label}
                    pct={b.pct}
                    value={b.notionalLabel}
                    count={b.count}
                    prov={b.provenance}
                    tone={SIDE_TONE[b.key] ?? "neutral"}
                  />
                ))
              )}
            </div>
            <Group title="by regime" bars={bars.byRegime} tone="info" />
            <Group title="by state" bars={bars.byState} tone="neutral" />
            <Group title="by confidence" bars={bars.byConfidence} tone="positive" />
            <Group title="by risk band" bars={bars.byRisk} tone="warning" />
          </div>
        </>
      )}
    </Panel>
  );
}
