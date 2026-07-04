/**
 * Phase 10C-2B-1 — Panel A (verdict): Portfolio Health. Pure, props-only. The headline
 * status + heat band, the control/runtime/kill gate flags, and the engine's itemized reasons
 * — all carried VERBATIM. The presentation layer only maps each verdict to a tone.
 */

import { Badge, Panel, type PanelPollState } from "./console-ui";
import type { HealthView } from "@/lib/portfolio-terminal-derivations";

export function PortfolioHealthPanel({ view, state }: { view: HealthView | null; state: PanelPollState }) {
  return (
    <Panel
      title="Portfolio Health"
      hint="The deterministic headline verdict and the gate flags behind it (runtime / control / kill), with the engine's itemized reasons — never recomputed, shown verbatim."
      badge={view ? <Badge tone={view.status.tone} text={view.status.label} /> : undefined}
      state={state}
      empty={!view}
    >
      {view && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={view.status.tone} text={`status ${view.status.label}`} />
            <Badge tone={view.heatBand.tone} text={`heat ${view.heatBand.label}`} />
            {view.gates.map((g) => (
              <Badge key={g.label} tone={g.tone} text={`${g.label}: ${g.text}`} />
            ))}
          </div>

          <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/40 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">reasons</span>
            {view.reasons.length === 0 ? (
              <p className="mt-0.5 text-[11px] text-slate-600">no adverse conditions reported</p>
            ) : (
              <ul className="mt-0.5 space-y-0.5">
                {view.reasons.map((r, i) => (
                  <li key={i} className="text-[11px] text-slate-300">
                    • {r}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {view.note && <p className="font-mono text-[9px] text-slate-600">{view.note}</p>}
        </>
      )}
    </Panel>
  );
}
