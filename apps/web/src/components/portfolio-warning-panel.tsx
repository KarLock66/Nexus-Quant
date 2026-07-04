/**
 * Phase 10C-2B-1 — Panel E: Portfolio Warnings. Pure, props-only. Warnings grouped by
 * severity (CRITICAL → LOW), each showing its severity, title, reason, basis and provenance —
 * all carried VERBATIM from the engine. The presentation layer only assigns the group tone.
 */

import { Badge, Panel, type PanelPollState } from "./console-ui";
import { ProvTag } from "./portfolio-viz";
import type { WarningGroupsView } from "@/lib/portfolio-terminal-derivations";

export function PortfolioWarningPanel({ view, state }: { view: WarningGroupsView; state: PanelPollState }) {
  const hasAny = view.total > 0;
  return (
    <Panel
      title="Portfolio Warnings"
      hint="Deterministic warnings grouped by severity. Each cites its source, reason, audit basis and provenance — never recomputed, never fabricated."
      badge={
        <span className="flex items-center gap-1.5">
          {view.counts.CRITICAL > 0 && <Badge tone="negative" text={`${view.counts.CRITICAL} critical`} />}
          {view.counts.HIGH > 0 && <Badge tone="negative" text={`${view.counts.HIGH} high`} />}
          {!hasAny && <Badge tone="positive" text="clear" />}
        </span>
      }
      state={state}
    >
      {!hasAny ? (
        <p className="py-4 text-center text-xs text-slate-500">No active warnings — all gates within thresholds.</p>
      ) : (
        <div className="space-y-3">
          {view.groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.severity} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Badge tone={g.tone} text={`${g.severity} (${g.count})`} />
                </div>
                <ul className="space-y-1.5">
                  {g.items.map((w) => (
                    <li
                      key={w.id}
                      className="rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-2"
                      title={w.basis}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-slate-200">{w.title}</span>
                          <span className="font-mono text-[9px] uppercase tracking-wider text-slate-600">{w.source}</span>
                        </span>
                        <ProvTag p={w.provenance} />
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-300">{w.reason}</p>
                      <p className="mt-0.5 font-mono text-[9px] text-slate-600">{w.basis}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </Panel>
  );
}
