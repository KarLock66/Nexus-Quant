/**
 * Phase 10C-2B-1 — Panel C: Capital Allocation. Pure, props-only. Per-symbol capital / risk /
 * exposure shares (each a provenance-tagged measure), the largest position / risk / opportunity
 * refs, and the concentration vs diversification split. Nothing recomputed — measures verbatim.
 */

import { Panel, type PanelPollState } from "./console-ui";
import { Bar, ProvTag, Tile } from "./portfolio-viz";
import type { AllocationRefView, AllocationView } from "@/lib/portfolio-terminal-derivations";

function Ref({ label, ref }: { label: string; ref: AllocationRefView }) {
  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2.5" title={ref.basis}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
        <ProvTag p={ref.provenance} />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-semibold text-slate-100">{ref.symbol ?? "—"}</span>
        <span className="font-mono text-[11px] tabular-nums text-slate-300">{ref.label}</span>
      </div>
    </div>
  );
}

export function PortfolioAllocationPanel({ view, state }: { view: AllocationView | null; state: PanelPollState }) {
  return (
    <Panel
      title="Capital Allocation"
      hint="How capital, risk and gross exposure are distributed across the book — totals, per-symbol shares, the standout positions, and single-name concentration vs diversification."
      state={state}
      empty={!view}
    >
      {view && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Tile label="Capital %" value={view.totals.capital.label} prov={view.totals.capital.provenance} hint={view.totals.capital.basis} />
            <Tile label="Risk %" value={view.totals.risk.label} prov={view.totals.risk.provenance} hint={view.totals.risk.basis} />
            <Tile label="Exposure %" value={view.totals.exposure.label} prov={view.totals.exposure.provenance} hint={view.totals.exposure.basis} />
          </div>

          <div className="space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">per-symbol exposure share</span>
            {view.perSymbol.length === 0 ? (
              <p className="text-[11px] text-slate-600">none</p>
            ) : (
              view.perSymbol.map((a) => (
                <Bar
                  key={a.symbol}
                  label={a.symbol}
                  pct={a.exposure.pct}
                  value={a.exposure.label}
                  prov={a.exposure.provenance}
                  tone="info"
                  hint={`capital ${a.capital.label} · risk ${a.risk.label} · exposure ${a.exposure.label}`}
                />
              ))
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Ref label="Largest Position" ref={view.largestPosition} />
            <Ref label="Largest Risk" ref={view.largestRisk} />
            <Ref label="Largest Opportunity" ref={view.largestOpportunity} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Tile label="Concentration" value={view.concentration.label} prov={view.concentration.provenance} hint={view.concentration.basis} />
            <Tile label="Diversification" value={view.diversification.label} prov={view.diversification.provenance} hint={view.diversification.basis} />
          </div>
        </>
      )}
    </Panel>
  );
}
