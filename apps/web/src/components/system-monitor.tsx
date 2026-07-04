"use client";

import {
  useConnectorStatus,
  useDataQuality,
  usePipelineStatus,
  useQueueMetrics,
  useServiceHealth,
} from "@/lib/system-monitoring-client";
import type { HealthLevel, PipelineState } from "@/lib/system-monitoring-types";
import { Badge, Dot, Metric, Panel, relTime, TONE, type PanelPollState, type Tone } from "./console-ui";

/* ─────────────────── health-level → shared tone ─────────────────── */

const LEVEL_TONE: Record<HealthLevel, Tone> = {
  healthy: "positive",
  degraded: "warning",
  failing: "negative",
  unknown: "neutral",
};

const PIPELINE_TO_LEVEL: Record<PipelineState, HealthLevel> = {
  running: "healthy",
  idle: "healthy",
  failing: "failing",
  empty: "unknown",
};

const PIPELINE_LABEL: Record<PipelineState, string> = {
  running: "running",
  idle: "idle",
  failing: "failing",
  empty: "no data",
};

function HealthDot({ level }: { level: HealthLevel }) {
  return <Dot tone={LEVEL_TONE[level]} />;
}

function HealthBadge({ level, text }: { level: HealthLevel; text?: string }) {
  return <Badge tone={LEVEL_TONE[level]} text={text ?? level} />;
}

/* ─────────────────── A. Service Health ─────────────────── */

function ServiceHealthPanel() {
  const { data, error, loading, lastUpdated } = useServiceHealth();
  const state: PanelPollState = { loading, error, lastUpdated };
  return (
    <Panel
      title="Service Health"
      hint="Postgres, Redis, quant service, workers, API uptime."
      badge={data ? <HealthBadge level={data.status} /> : undefined}
      state={state}
    >
      <div className="space-y-2">
        {data?.components.map((c) => (
          <div
            key={c.key}
            className="flex items-center justify-between gap-3 rounded-md border border-(--color-line) bg-(--color-surface-900)/50 px-3 py-2"
          >
            <div className="flex items-center gap-2.5">
              <HealthDot level={c.status} />
              <span className="text-[13px] text-slate-200">{c.label}</span>
            </div>
            <div className="text-right">
              <div className="font-mono text-[11px] text-slate-400">{c.detail}</div>
              {c.latencyMs !== null && (
                <div className="font-mono text-[10px] text-slate-600">{c.latencyMs}ms</div>
              )}
            </div>
          </div>
        ))}
        {data && (
          <div className="pt-1 text-right font-mono text-[10px] text-slate-600">
            v{data.version} · uptime {data.uptimeSeconds}s
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ─────────────────── C. Data Quality ─────────────────── */

function DataQualityPanel() {
  const { data, error, loading, lastUpdated } = useDataQuality();
  const state: PanelPollState = { loading, error, lastUpdated };
  return (
    <Panel
      title="Data Quality"
      hint="DQ score, pass/fail rate, per-stage health, worst checks."
      badge={data ? <HealthBadge level={data.status} /> : undefined}
      state={state}
      empty={data ? data.reportsSampled === 0 : false}
    >
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <Metric
              label="Overall DQ"
              value={data.overallScore === null ? "—" : `${data.overallScore}`}
              sub="0–100"
            />
            <Metric
              label="Failure rate"
              value={data.failureRate === null ? "—" : `${(data.failureRate * 100).toFixed(1)}%`}
              sub={`${data.reportsSampled} reports`}
            />
            <Metric label="Anomalies" value={data.anomalyCount} sub="failed checks" />
          </div>

          <div className="space-y-1.5">
            {data.stages.map((s) => (
              <div key={s.stage} className="flex items-center gap-3">
                <span className="w-20 font-mono text-[11px] uppercase tracking-wider text-slate-500">
                  {s.stage}
                </span>
                <div
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--color-surface-800)"
                  aria-hidden="true"
                >
                  <div
                    className={`h-full rounded-full ${TONE[LEVEL_TONE[s.status]].dot}`}
                    style={{ width: `${s.score}%` }}
                  />
                </div>
                <span className="w-8 text-right font-mono text-[11px] tabular-nums text-slate-300">
                  {s.score}
                </span>
              </div>
            ))}
          </div>

          {data.worstChecks.length > 0 && (
            <div className="space-y-1 border-t border-(--color-line) pt-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
                worst checks
              </div>
              {data.worstChecks.map((c) => (
                <div key={c.check} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono text-slate-400">{c.check}</span>
                  <span className="text-slate-500">
                    {(c.failRate * 100).toFixed(0)}% fail · −{c.deduction}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── D. Pipeline / Runtime ─────────────────── */

function PipelinePanel() {
  const { data, error, loading, lastUpdated } = usePipelineStatus();
  const state: PanelPollState = { loading, error, lastUpdated };
  return (
    <Panel
      title="Runtime Pipeline"
      hint="Market data → DQ → Feature → Signal flow state."
      badge={
        data ? (
          <HealthBadge level={PIPELINE_TO_LEVEL[data.state]} text={PIPELINE_LABEL[data.state]} />
        ) : undefined
      }
      state={state}
    >
      {data && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">
              last signal {relTime(data.lastSignalAt)}
            </span>
          </div>
          <ol className="space-y-2">
            {data.stages.map((s, i) => {
              const lvl = PIPELINE_TO_LEVEL[s.state];
              return (
                <li key={s.key} className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-slate-600">{i + 1}</span>
                  <HealthDot level={lvl} />
                  <div className="flex-1">
                    <div className="text-[13px] text-slate-200">{s.label}</div>
                    <div className="font-mono text-[10px] text-slate-500">{s.detail}</div>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    {PIPELINE_LABEL[s.state]}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── B. Connector Status ─────────────────── */

const LEVEL_RANK: Record<HealthLevel, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  failing: 3,
};

function ConnectorPanel() {
  const { data, error, loading, lastUpdated } = useConnectorStatus();
  const state: PanelPollState = { loading, error, lastUpdated };
  const worst =
    data && data.length > 0
      ? data.reduce<HealthLevel>(
          (acc, c) => (LEVEL_RANK[c.status] > LEVEL_RANK[acc] ? c.status : acc),
          "healthy",
        )
      : undefined;

  return (
    <Panel
      title="Connector Status"
      hint="Per-exchange WebSocket/backfill liveness from candle freshness."
      badge={worst ? <HealthBadge level={worst} /> : undefined}
      state={state}
      empty={data ? data.length === 0 : false}
    >
      {data && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-(--color-line) font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th scope="col" className="py-2 pr-3 font-medium">Connector</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Last sync</th>
                <th scope="col" className="px-3 py-2 font-medium">24h rows</th>
                <th scope="col" className="py-2 pl-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.exchange} className="border-b border-(--color-line)/50 last:border-0">
                  <td className="py-2.5 pr-3 font-medium text-slate-200">
                    {c.exchange}
                    {c.symbols.length > 0 && (
                      <span className="ml-2 font-mono text-[10px] text-slate-600">
                        {c.symbols.slice(0, 3).join(", ")}
                        {c.symbols.length > 3 ? ` +${c.symbols.length - 3}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <HealthBadge level={c.status} />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-400">
                    {relTime(c.lastSyncAt)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-slate-300">
                    {c.rowsLast24h.toLocaleString()}
                  </td>
                  <td className="py-2.5 pl-3 text-[11px] text-slate-500">
                    {c.error ?? (c.lagSeconds !== null ? `lag ${c.lagSeconds}s` : "—")}
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

/* ─────────────────── E. Queue / Worker Metrics ─────────────────── */

function QueuePanel() {
  const { data, error, loading, lastUpdated } = useQueueMetrics();
  const state: PanelPollState = { loading, error, lastUpdated };
  const level: HealthLevel | undefined = data
    ? data.failed24h > 0
      ? "degraded"
      : data.depth > 0 || data.ok24h > 0
        ? "healthy"
        : "unknown"
    : undefined;

  return (
    <Panel
      title="Queues & Workers"
      hint="BullMQ depth, throughput, worker count, dead-letter (from JobRun)."
      badge={level ? <HealthBadge level={level} /> : undefined}
      state={state}
      empty={data ? data.jobs.length === 0 && data.depth === 0 : false}
    >
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric label="Queue depth" value={data.depth} sub="in-flight" />
            <Metric label="Workers" value={data.activeWorkers} sub="active types" />
            <Metric
              label="Throughput"
              value={data.processingRatePerMin === null ? "—" : data.processingRatePerMin}
              sub="ok / min"
            />
            <Metric label="OK (24h)" value={data.ok24h} />
            <Metric label="Failed (24h)" value={data.failed24h} sub="dead-letter" />
            <Metric
              label="Avg latency"
              value={data.avgLatencyMs === null ? "—" : `${data.avgLatencyMs}ms`}
            />
          </div>

          {data.jobs.length > 0 && (
            <div className="space-y-1 border-t border-(--color-line) pt-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
                recent jobs
              </div>
              {data.jobs.map((j, i) => {
                const lvl: HealthLevel =
                  j.status === "FAILED" ? "failing" : j.status === "RUNNING" ? "degraded" : "healthy";
                return (
                  <div
                    key={`${j.job}-${j.startedAt}-${i}`}
                    className="flex items-center justify-between gap-2 text-[11px]"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <HealthDot level={lvl} />
                      <span className="truncate font-mono text-slate-400">{j.job}</span>
                    </span>
                    <span className="shrink-0 font-mono text-slate-600">
                      {j.durationMs !== null ? `${j.durationMs}ms` : "running"} · {relTime(j.startedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────── page composition ─────────────────── */

/**
 * Live System Monitoring dashboard (Phase 1). Each panel owns its own poll
 * cycle and error state, so a single failing endpoint degrades only its tile.
 * Responsive: 1 column on mobile, 2–3 on desktop.
 */
export function SystemMonitor() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <ServiceHealthPanel />
      <DataQualityPanel />
      <PipelinePanel />
      <div className="lg:col-span-2 xl:col-span-3">
        <ConnectorPanel />
      </div>
      <div className="lg:col-span-2 xl:col-span-3">
        <QueuePanel />
      </div>
    </div>
  );
}
