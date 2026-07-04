/**
 * Phase 10C-2B-1 — Panel D: Risk Heat. Pure, props-only. The deterministic 0..100 heat score
 * (documented weights, no ML), its band, the diversification / stability / portfolio-risk
 * read-outs, and the weighted component breakdown. Heat is DERIVED — tagged as such.
 */

import { Panel, type PanelPollState } from "./console-ui";
import { Bar, HeatScale, Tile } from "./portfolio-viz";
import { formatNumber, formatPercent } from "@/lib/portfolio-terminal-derivations";
import type { HeatView } from "@/lib/portfolio-terminal-derivations";

export function PortfolioRiskPanel({
  view,
  warningsCount,
  state,
}: {
  view: HeatView | null;
  warningsCount: number | null;
  state: PanelPollState;
}) {
  return (
    <Panel
      title="Risk Heat"
      hint="A deterministic aggregation of portfolio stress (capital · risk · concentration · directional skew · gating) into a 0..100 heat score and band. No ML, no fabricated values — every component cites its basis."
      state={state}
      empty={!view}
    >
      {view && (
        <>
          <HeatScale pct={view.fillPct} band={view.band.tone} label={`${view.band.label} · ${view.heatScoreLabel}`} />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Tile label="Heat Score" value={view.heatScoreLabel} prov={view.provenance} hint="0..100 deterministic" />
            <Tile label="Risk Band" value={view.band.label} tone={view.band.tone} prov={view.provenance} hint="cool / warm / hot / extreme" />
            <Tile label="Stability" value={formatNumber(view.stability, 0)} prov={view.provenance} hint="100 − heat score" />
            <Tile label="Diversification" value={formatNumber(view.diversification, 0)} prov={view.provenance} hint="100 − concentration" />
            <Tile label="Portfolio Risk" value={formatPercent(view.portfolioRisk, 0)} prov={view.provenance} hint="risk used ÷ budget" />
            <Tile
              label="Warnings"
              value={warningsCount === null ? "—" : String(warningsCount)}
              tone={warningsCount && warningsCount > 0 ? "warning" : "neutral"}
              hint="active portfolio warnings"
            />
          </div>

          <div className="space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">heat components (earned ÷ weight)</span>
            {view.components.length === 0 ? (
              <p className="text-[11px] text-slate-600">none</p>
            ) : (
              view.components.map((c) => (
                <Bar
                  key={c.key}
                  label={`${c.label} (${formatNumber(c.earned, 1)}/${c.weight})`}
                  pct={c.earnedPct}
                  value={formatNumber(c.earned, 1)}
                  prov={view.provenance}
                  tone="warning"
                  hint={c.basis}
                />
              ))
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
