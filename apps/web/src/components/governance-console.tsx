"use client";

import { usePolledResource } from "@/lib/use-polled-resource";
import { POLL_INTERVAL_MS } from "@/lib/system-monitoring-client";
import type { GovernanceOverview } from "@/lib/governance-types";
import { Panel, relTime } from "./console-ui";

/**
 * Strategy Governance — live view of the Phase 8 governance state, read entirely
 * from persisted truth (Strategy, StrategyVersion, ApprovalRequest, AuditLog) via
 * `/api/v1/governance/overview`. The strategy registry is populated only by
 * governed registration (four-eyes review); the approval queue and audit trail
 * render explicit empty states until governance actions occur — no rows are
 * fabricated.
 */

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "text-slate-400 border-(--color-line)",
  BACKTESTING: "text-(--color-warning) border-(--color-warning)/40",
  BACKTEST_APPROVED: "text-(--color-accent-500) border-(--color-accent-500)/40",
  PENDING_DEPLOY_APPROVAL: "text-(--color-warning) border-(--color-warning)/40",
  ACTIVE: "text-(--color-positive) border-(--color-positive)/40 bg-(--color-positive)/10",
  PAUSED: "text-(--color-warning) border-(--color-warning)/40",
  DEGRADED: "text-(--color-negative) border-(--color-negative)/40",
  RETIRED: "text-slate-500 border-(--color-line)",
};

const APPROVAL_STATUS_STYLE: Record<string, string> = {
  PENDING: "text-(--color-warning) border-(--color-warning)/40",
  APPROVED: "text-(--color-positive) border-(--color-positive)/40",
  REJECTED: "text-(--color-negative) border-(--color-negative)/40",
  WITHDRAWN: "text-slate-500 border-(--color-line)",
};

function StatusBadge({ status, map }: { status: string; map: Record<string, string> }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${map[status] ?? "text-slate-400 border-(--color-line)"}`}
    >
      {status}
    </span>
  );
}

export function GovernanceConsole() {
  const { data, error, loading, lastUpdated } = usePolledResource<GovernanceOverview>(
    "/api/v1/governance/overview",
    "governance/overview",
    POLL_INTERVAL_MS,
  );
  const state = { loading, error, lastUpdated };

  return (
    <div className="space-y-4">
      {/* Strategy registry */}
      <Panel
        title="Strategy Registry"
        hint="All strategies with immutable versions and lifecycle status — from Strategy/StrategyVersion."
        state={state}
        empty={data ? data.strategies.length === 0 : false}
        emptyLabel="No strategies registered — register one via the governance API (four-eyes review)."
      >
        {data && data.strategies.length > 0 && (
          <div className="space-y-3">
            {data.strategies.map((s) => {
              const latest = s.versions[0];
              return (
                <div
                  key={s.id}
                  className="rounded-lg border border-(--color-line) bg-(--color-surface-900)/50 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[13px] font-medium text-slate-100">{s.name}</span>
                      {s.latestStatus && (
                        <StatusBadge status={s.latestStatus} map={STATUS_STYLE} />
                      )}
                      <span className="font-mono text-[10px] text-slate-600">
                        v{latest?.version ?? "—"} · {s.versions.length} version
                        {s.versions.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-slate-600">
                      by {s.createdBy}
                    </span>
                  </div>
                  {latest && (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-500">
                      {latest.hypothesis || latest.description}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Approval queue */}
        <Panel
          title="Approval Queue"
          hint="Backtest / deploy / parameter / risk-mode approvals — from ApprovalRequest."
          state={state}
          empty={data ? data.approvals.length === 0 : false}
          emptyLabel="Approval queue is empty — no pending requests."
        >
          {data && data.approvals.length > 0 && (
            <div className="space-y-2">
              {data.approvals.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={a.status} map={APPROVAL_STATUS_STYLE} />
                      <span className="truncate text-[13px] text-slate-200">{a.kind}</span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                      {a.entityType} · by {a.requestedBy}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-slate-600">
                    {relTime(a.createdAt, "—")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* Audit trail */}
        <Panel
          title="Audit Trail"
          hint="Who / what / why / when, with before-after diffs — from AuditLog."
          state={state}
          empty={data ? data.audit.length === 0 : false}
          emptyLabel="No audited actions recorded yet."
        >
          {data && data.audit.length > 0 && (
            <div className="space-y-1.5">
              {data.audit.map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-mono uppercase text-(--color-accent-500)">{l.action}</span>
                    <span className="truncate text-slate-400">{l.entityType}</span>
                    <span className="truncate font-mono text-slate-600">{l.actor}</span>
                  </span>
                  <span className="shrink-0 font-mono text-slate-600">{relTime(l.ts, "—")}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
