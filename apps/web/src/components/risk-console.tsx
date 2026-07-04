"use client";

import { usePolledResource } from "@/lib/use-polled-resource";
import { POLL_INTERVAL_MS } from "@/lib/system-monitoring-client";
import type { RiskMode, RiskOverview } from "@/lib/risk-overview-types";
import { Panel, relTime } from "./console-ui";

/**
 * Risk Engine — live view of the Phase 2/6/7/8 risk state, read entirely from
 * persisted truth (SystemRiskState, RiskLimit, RiskEvent, RiskBudget) via
 * `/api/v1/risk/overview`. The current mode and hard limits come from the base
 * seed and are always present; detector events / budgets render an explicit
 * empty state until the runtime produces them — no values are fabricated.
 */

export const MODE_STYLE: Record<RiskMode, { badge: string; dot: string }> = {
  NORMAL: {
    badge: "text-(--color-positive) border-(--color-positive)/40 bg-(--color-positive)/10",
    dot: "bg-(--color-positive)",
  },
  ELEVATED: {
    badge: "text-(--color-warning) border-(--color-warning)/40 bg-(--color-warning)/10",
    dot: "bg-(--color-warning)",
  },
  RISK_OFF: {
    badge: "text-(--color-negative) border-(--color-negative)/40 bg-(--color-negative)/10",
    dot: "bg-(--color-negative)",
  },
  FROZEN: {
    badge: "text-(--color-negative) border-(--color-negative)/50 bg-(--color-negative)/15",
    dot: "bg-(--color-negative)",
  },
};

const SEVERITY_STYLE: Record<string, string> = {
  INFO: "text-slate-400 border-(--color-line)",
  WARNING: "text-(--color-warning) border-(--color-warning)/40",
  CRITICAL: "text-(--color-negative) border-(--color-negative)/40",
  EMERGENCY: "text-(--color-negative) border-(--color-negative)/60 bg-(--color-negative)/10",
};

export function RiskConsole() {
  const { data, error, loading, lastUpdated } = usePolledResource<RiskOverview>(
    "/api/v1/risk/overview",
    "risk/overview",
    POLL_INTERVAL_MS,
  );
  const state = { loading, error, lastUpdated };

  const mode = data?.current?.mode;
  const modeStyle = mode ? MODE_STYLE[mode] : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Risk Mode + state machine history */}
      <Panel
        title="Risk Mode"
        hint="NORMAL → ELEVATED → RISK_OFF → FROZEN — from SystemRiskState."
        state={state}
        badge={
          modeStyle && mode ? (
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${modeStyle.badge}`}
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${modeStyle.dot}`} />
              {mode}
            </span>
          ) : undefined
        }
      >
        {data?.current ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2.5">
              <div className="text-[13px] text-slate-200">{data.current.reason}</div>
              <div className="mt-1 font-mono text-[11px] text-slate-500">
                triggered by {data.current.triggeredBy} · {relTime(data.current.ts, "—")}
                {data.current.approvalRequestId
                  ? ` · approval ${data.current.approvalRequestId.slice(0, 8)}…`
                  : ""}
              </div>
            </div>
            {data.history.length > 1 && (
              <div className="space-y-1 border-t border-(--color-line) pt-3">
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
                  history
                </div>
                {data.history.slice(1).map((h, i) => (
                  <div
                    key={`${h.ts}-${i}`}
                    className="flex items-center justify-between text-[11px]"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${MODE_STYLE[h.mode].dot}`}
                      />
                      <span className="font-mono text-slate-400">{h.mode}</span>
                      <span className="truncate text-slate-500">{h.reason}</span>
                    </span>
                    <span className="shrink-0 font-mono text-slate-600">{relTime(h.ts, "—")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="py-6 text-center text-xs text-slate-500">
            No SystemRiskState recorded. Run <span className="font-mono">pnpm db:seed</span>.
          </p>
        )}
      </Panel>

      {/* Hard limits */}
      <Panel
        title="Hard Limits"
        hint="Drawdown, exposure, correlation, per-trade risk — from RiskLimit."
        state={state}
        empty={data ? data.limits.length === 0 : false}
      >
        {data && data.limits.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <tbody>
                {data.limits.map((l) => (
                  <tr key={l.key} className="border-b border-(--color-line)/50 last:border-0">
                    <td className="py-2 pr-3 font-mono text-[11px] text-slate-400">{l.key}</td>
                    <td className="py-2 text-right font-mono tabular-nums text-slate-100">
                      {l.value}
                      <span className="ml-1 text-[10px] text-slate-500">
                        {l.unit === "pct" ? "%" : l.unit}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Detector events */}
      <Panel
        title="Detector Events"
        hint="Volatility / liquidity / options / black-swan monitors — from RiskEvent."
        state={state}
        empty={data ? data.events.length === 0 : false}
        emptyLabel="No detector events fired — risk monitors are quiet."
      >
        {data && data.events.length > 0 && (
          <div className="space-y-2">
            {data.events.map((e) => (
              <div
                key={e.id}
                className="flex items-start justify-between gap-3 rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${SEVERITY_STYLE[e.severity] ?? SEVERITY_STYLE["INFO"]}`}
                    >
                      {e.severity}
                    </span>
                    <span className="truncate text-[13px] text-slate-200">{e.type}</span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                    {e.detector}
                    {e.symbol ? ` · ${e.symbol}` : ""}
                    {e.actionsTaken.length > 0 ? ` · ${e.actionsTaken.join(", ")}` : ""}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-slate-600">
                  {e.resolvedAt ? "resolved" : relTime(e.createdAt, "—")}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Risk budgets (M9) */}
      <Panel
        title="Risk Budgets (M9)"
        hint="Budget utilization per strategy / asset / regime — from RiskBudget."
        state={state}
        empty={data ? data.budgets.length === 0 : false}
        emptyLabel="No risk budgets configured."
      >
        {data && data.budgets.length > 0 && (
          <div className="space-y-2">
            {data.budgets.map((b) => {
              const used = Number(b.usedPct);
              const budget = Number(b.budgetPct);
              const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
              return (
                <div key={b.scope} className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="truncate font-mono text-slate-400">{b.scope}</span>
                    <span className="shrink-0 font-mono tabular-nums text-slate-300">
                      {b.usedPct} / {b.budgetPct}%
                    </span>
                  </div>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-(--color-surface-800)"
                    aria-hidden="true"
                  >
                    <div
                      className={`h-full rounded-full ${pct >= 90 ? "bg-(--color-negative)" : pct >= 70 ? "bg-(--color-warning)" : "bg-(--color-positive)"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
