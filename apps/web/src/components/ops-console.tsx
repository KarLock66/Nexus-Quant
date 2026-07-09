"use client";

import { useState } from "react";
import {
  runOperatorAction,
  useActionsCatalog,
  useAlerts,
  useDataFlow,
  useOpsPipeline,
  useRuntimeMetrics,
  useSystemHealth,
  type PollState,
} from "@/lib/ops-client";
import type {
  ActionsCatalog,
  AlertSeverity,
  AlertsSummary,
  ComponentStatus,
  DataFlowMonitor,
  Freshness,
  OperatorActionId,
  OverallStatus,
  PipelineStatus,
  RuntimeMetrics,
  StageState,
  SystemHealth,
} from "@/lib/ops-types";
import { Badge, Dot, Metric, Panel, relTime, type Tone } from "./console-ui";

/* ─────────────────── status → shared tone ─────────────────── */

const COMPONENT_TONE: Record<ComponentStatus, Tone> = {
  healthy: "positive",
  degraded: "warning",
  failing: "negative",
  unknown: "neutral",
};
const OVERALL_TONE: Record<OverallStatus, Tone> = {
  healthy: "positive",
  degraded: "warning",
  critical: "negative",
};
const FRESH_TONE: Record<Freshness, Tone> = {
  fresh: "positive",
  warning: "warning",
  stale: "negative",
  unknown: "neutral",
};
const STAGE_TONE: Record<StageState, Tone> = {
  active: "positive",
  idle: "positive",
  degraded: "warning",
  failing: "negative",
  empty: "neutral",
  unknown: "neutral",
};
const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  INFO: "neutral",
  WARNING: "warning",
  CRITICAL: "negative",
  EMERGENCY: "negative",
};

/* ─────────────────── A. System Status ─────────────────── */

function SystemStatusPanel({ state }: { state: PollState<SystemHealth> }) {
  const d = state.data;
  return (
    <Panel
      title="System Status"
      hint="Postgres, Redis, quant, ingestion, workers, web — fail-closed aggregation."
      badge={d && <Badge tone={OVERALL_TONE[d.overallStatus]} text={d.overallStatus} />}
      state={state}
    >
      {d && (
        <div className="space-y-2">
          {d.components.map((c) => (
            <div
              key={c.key}
              className="flex items-center justify-between gap-3 rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-2"
            >
              <div className="flex items-center gap-2.5">
                <Dot tone={COMPONENT_TONE[c.status]} />
                <span className="text-[13px] text-slate-200">{c.label}</span>
                {!c.required && (
                  <span className="font-mono text-[9px] uppercase tracking-wider text-slate-600">
                    derived
                  </span>
                )}
              </div>
              <div className="max-w-[60%] text-right">
                <div className="truncate font-mono text-[11px] text-slate-400">{c.detail}</div>
                {c.latencyMs !== null && (
                  <div className="font-mono text-[10px] text-slate-600">{c.latencyMs}ms</div>
                )}
              </div>
            </div>
          ))}
          <div className="pt-1 text-right font-mono text-[10px] text-slate-600">
            v{d.version} · uptime {d.uptimeSeconds}s · checked {relTime(d.checkedAt)}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── C. Pipeline Status ─────────────────── */

function PipelinePanel({ state }: { state: PollState<PipelineStatus> }) {
  const d = state.data;
  return (
    <Panel
      title="Pipeline Status"
      hint="Exchange → Ingestion → DQ → Features → Signals → Risk → Execution → Persistence."
      badge={d && <Badge tone={STAGE_TONE[d.overall]} text={d.overall} />}
      state={state}
    >
      {d && (
        <ol className="space-y-1.5">
          {d.stages.map((s, i) => (
            <li key={s.key} className="flex items-center gap-3">
              <span className="w-4 font-mono text-[10px] text-slate-600">{i + 1}</span>
              <Dot tone={STAGE_TONE[s.state]} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-slate-200">{s.label}</span>
                  {s.errorCount > 0 && (
                    <span className="font-mono text-[10px] text-(--color-negative)">
                      {s.errorCount} err
                    </span>
                  )}
                </div>
                <div className="font-mono text-[10px] text-slate-500">{s.detail}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  {s.state}
                </div>
                <div className="font-mono text-[10px] text-slate-600">
                  {s.throughputPerMin !== null ? `${s.throughputPerMin}/min` : relTime(s.lastEventAt)}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* ─────────────────── E. Alerts ─────────────────── */

function AlertsPanel({ state }: { state: PollState<AlertsSummary> }) {
  const d = state.data;
  const tone: Tone = d ? (d.critical > 0 ? "negative" : d.active > 0 ? "warning" : "positive") : "neutral";
  return (
    <Panel
      title="Alerts"
      hint="Monitoring rules: infra reachability + data-flow staleness. Persisted + deduped."
      badge={d && <Badge tone={tone} text={`${d.active} active`} />}
      state={state}
    >
      {d && d.alerts.length > 0 && (
        <div className="space-y-2">
          {!d.persistenceOk && (
            <div
              role="status"
              className="rounded-md border border-(--color-warning)/30 bg-(--color-warning)/5 px-3 py-1.5 font-mono text-[10px] text-(--color-warning)"
            >
              alert persistence unavailable — showing live-computed alerts only
            </div>
          )}
          {d.alerts.map((a) => (
            <div
              key={a.id}
              className={`rounded-md border px-3 py-2 ${
                a.status === "RESOLVED"
                  ? "border-(--color-line) bg-(--color-surface-900)/40 opacity-60"
                  : "border-(--color-line) bg-(--color-surface-900)/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={SEVERITY_TONE[a.severity]} text={a.severity} />
                  <span className="text-[13px] text-slate-200">{a.message}</span>
                </div>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                  {a.status}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-slate-500">
                <span>{a.detail ?? a.ruleId}</span>
                <span>
                  first {relTime(a.firstSeen)} · last {relTime(a.lastSeen)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {d && d.alerts.length === 0 && (
        <p className="py-4 text-center text-xs text-(--color-positive)">
          All clear — no active alerts.
        </p>
      )}
    </Panel>
  );
}

/* ─────────────────── B. Data Flow ─────────────────── */

function DataFlowPanel({ state }: { state: PollState<DataFlowMonitor> }) {
  const d = state.data;
  return (
    <Panel
      title="Data Flow"
      hint="Last update, throughput, lag, and freshness per stream (fresh < warning < stale)."
      badge={d && <Badge tone={FRESH_TONE[d.overall]} text={d.overall} />}
      state={state}
    >
      {d && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-(--color-line) font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th scope="col" className="py-2 pr-3 font-medium">Stream</th>
                <th scope="col" className="px-3 py-2 font-medium">Freshness</th>
                <th scope="col" className="px-3 py-2 font-medium">Last update</th>
                <th scope="col" className="px-3 py-2 font-medium">Lag</th>
                <th scope="col" className="px-3 py-2 font-medium">Rows/min</th>
                <th scope="col" className="py-2 pl-3 font-medium">1h rows</th>
              </tr>
            </thead>
            <tbody>
              {d.streams.map((s) => (
                <tr key={s.key} className="border-b border-(--color-line)/50 last:border-0">
                  <td className="py-2.5 pr-3 font-medium text-slate-200">
                    {s.label}
                    {s.note && (
                      <span className="ml-2 font-mono text-[10px] text-slate-600">opt-in</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={FRESH_TONE[s.freshness]} text={s.freshness} />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-400">
                    {relTime(s.lastUpdateAt)}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] tabular-nums text-slate-400">
                    {s.lagSeconds === null ? "—" : `${s.lagSeconds}s`}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-slate-300">
                    {s.rowsPerMinute ?? "—"}
                  </td>
                  <td className="py-2.5 pl-3 font-mono tabular-nums text-slate-300">
                    {s.rowsLastHour.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── F. Runtime Metrics ─────────────────── */

function MetricsPanel({ state }: { state: PollState<RuntimeMetrics> }) {
  const d = state.data;
  return (
    <Panel
      title="Runtime Metrics"
      hint="Throughput counts, queue/worker activity, and live risk posture."
      state={state}
    >
      {d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric label="Queue depth" value={d.jobs.running} sub="in-flight jobs" />
            <Metric label="Workers" value={d.jobs.activeWorkers} sub="active types" />
            <Metric
              label="Throughput"
              value={d.jobs.ratePerMin ?? "—"}
              sub="ok jobs / min"
            />
            <Metric label="OK (24h)" value={d.jobs.ok24h} />
            <Metric label="Failed (24h)" value={d.jobs.failed24h} />
            <Metric
              label="Avg latency"
              value={d.jobs.avgLatencyMs === null ? "—" : `${d.jobs.avgLatencyMs}ms`}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Metric
              label="Risk mode"
              value={d.risk.mode ?? "—"}
              sub={
                d.risk.mode === null
                  ? "no SystemRiskState row"
                  : `${d.risk.openRiskEvents} open events`
              }
            />
            <Metric label="Web uptime" value={`${d.webUptimeSeconds}s`} />
            <Metric
              label="Last risk event"
              value={d.risk.lastRiskEventAt ? relTime(d.risk.lastRiskEventAt) : "—"}
            />
          </div>

          <div className="space-y-1 border-t border-(--color-line) pt-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
              stream counts (1h / 24h)
            </div>
            {d.counts.map((c) => (
              <div key={c.stream} className="flex items-center justify-between text-[11px]">
                <span className="font-mono text-slate-400">{c.stream}</span>
                <span className="font-mono tabular-nums text-slate-500">
                  {c.lastHour.toLocaleString()} / {c.last24h.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── D. Operator Controls ─────────────────── */

function ControlsPanel({
  state,
  onRefreshAll,
}: {
  state: PollState<ActionsCatalog>;
  onRefreshAll: () => void;
}) {
  const d = state.data;
  const [pending, setPending] = useState<OperatorActionId | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const run = async (id: OperatorActionId) => {
    setPending(id);
    setResult(null);
    try {
      const r = await runOperatorAction(id);
      setResult({ ok: r.ok, message: r.message });
      // Safe, read-only actions should immediately refresh the dashboard.
      if (r.ok && (id === "refreshHealth" || id === "rerunHealthChecks" || id === "clearStaleStatus")) {
        onRefreshAll();
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(null);
    }
  };

  return (
    <Panel
      title="Operator Controls"
      hint="Guarded, non-destructive operations. Restart actions require a configured control channel."
      badge={
        d && (
          <Badge
            tone={d.controlChannelConfigured ? "positive" : "neutral"}
            text={d.controlChannelConfigured ? "control on" : "control off"}
          />
        )
      }
      state={state}
    >
      {d && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {d.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!a.enabled || pending !== null}
                onClick={() => void run(a.id)}
                title={a.disabledReason ?? a.description}
                aria-busy={pending === a.id}
                className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors ${
                  a.enabled
                    ? "border-(--color-line) bg-(--color-surface-900)/60 hover:bg-(--color-surface-800)"
                    : "cursor-not-allowed border-(--color-line)/50 bg-(--color-surface-900)/30 opacity-50"
                }`}
              >
                <span className="flex w-full items-center justify-between text-[13px] text-slate-200">
                  {a.label}
                  {pending === a.id && (
                    <span className="font-mono text-[10px] text-slate-500" aria-hidden="true">
                      …
                    </span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-slate-500">
                  {a.enabled ? a.description : a.disabledReason}
                </span>
              </button>
            ))}
          </div>

          {result && (
            <div
              role="status"
              className={`rounded-md border px-3 py-2 font-mono text-[11px] ${
                result.ok
                  ? "border-(--color-positive)/30 bg-(--color-positive)/5 text-(--color-positive)"
                  : "border-(--color-warning)/30 bg-(--color-warning)/5 text-(--color-warning)"
              }`}
            >
              {result.message}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── composition ─────────────────── */

/**
 * Phase 9.6 Operations Control Plane (Section H). All hooks are owned here (one
 * poll per resource) so operator actions can refresh every panel at once. Each
 * panel still renders/degrades independently from its own poll state.
 */
export function OpsConsole() {
  const health = useSystemHealth();
  const dataFlow = useDataFlow();
  const pipeline = useOpsPipeline();
  const alerts = useAlerts();
  const metrics = useRuntimeMetrics();
  const actions = useActionsCatalog();

  const refreshAll = () => {
    health.refetch();
    dataFlow.refetch();
    pipeline.refetch();
    alerts.refetch();
    metrics.refetch();
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <SystemStatusPanel state={health} />
      <PipelinePanel state={pipeline} />
      <AlertsPanel state={alerts} />
      <div className="lg:col-span-2 xl:col-span-3">
        <DataFlowPanel state={dataFlow} />
      </div>
      <div className="lg:col-span-2 xl:col-span-2">
        <MetricsPanel state={metrics} />
      </div>
      <ControlsPanel state={actions} onRefreshAll={refreshAll} />
    </div>
  );
}
