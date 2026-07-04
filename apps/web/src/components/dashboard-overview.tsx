"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePolledResource } from "@/lib/use-polled-resource";
import { POLL_INTERVAL_MS } from "@/lib/system-monitoring-client";
import type { DashboardOverview as DashboardOverviewData } from "@/lib/dashboard-types";
import { relTime } from "./console-ui";
import { MODE_STYLE } from "./risk-console";

/**
 * Dashboard — portfolio overview at a glance, composed entirely from persisted
 * truth via `/api/v1/dashboard/overview`. Risk mode, signal activity, and the
 * strategy registry are always present (seeded/produced by the runtime); the
 * portfolio equity tile and data-quality tile render an explicit "unavailable"
 * state until paper execution / DQ produce a row — no metric is fabricated.
 */

const DECISION_STYLE: Record<string, string> = {
  LONG: "text-(--color-positive)",
  SHORT: "text-(--color-negative)",
  FLAT: "text-slate-400",
};

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="glass flex flex-col gap-3 p-5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      {children}
    </section>
  );
}

function Unavailable({ hint }: { hint: string }) {
  return (
    <div className="flex flex-1 flex-col justify-center py-3">
      <div className="text-lg font-semibold text-slate-500">unavailable</div>
      <div className="mt-0.5 text-[11px] text-slate-600">{hint}</div>
    </div>
  );
}

export function DashboardOverview() {
  const { data, error, loading, lastUpdated } = usePolledResource<DashboardOverviewData>(
    "/api/v1/dashboard/overview",
    "dashboard/overview",
    POLL_INTERVAL_MS,
  );

  if (loading && lastUpdated === null) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="glass h-32 animate-pulse p-5" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="status"
          className="rounded-md border border-(--color-warning)/30 bg-(--color-warning)/5 px-3 py-2 font-mono text-[11px] text-(--color-warning)"
        >
          stale — {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* Risk mode */}
        <Tile label="Risk Mode">
          {data?.risk ? (
            <div className="flex flex-1 flex-col justify-center">
              <span
                className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-sm font-semibold uppercase tracking-wider ${MODE_STYLE[data.risk.mode].badge}`}
              >
                <span
                  className={`inline-block h-2 w-2 rounded-full ${MODE_STYLE[data.risk.mode].dot}`}
                />
                {data.risk.mode}
              </span>
              <div className="mt-2 text-[11px] text-slate-500">{data.risk.reason}</div>
              <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                {relTime(data.risk.ts, "—")}
              </div>
            </div>
          ) : (
            <Unavailable hint="No SystemRiskState — run pnpm db:seed." />
          )}
        </Tile>

        {/* Portfolio equity */}
        <Tile label="Portfolio">
          {data?.portfolio ? (
            <div className="flex flex-1 flex-col justify-center">
              <div className="text-2xl font-semibold tabular-nums text-slate-100">
                {Number(data.portfolio.equity).toLocaleString()}{" "}
                <span className="text-sm text-slate-500">{data.portfolio.baseCurrency}</span>
              </div>
              <div className="mt-1 flex gap-4 text-[11px] text-slate-500">
                <span>
                  exposure{" "}
                  <span className="tabular-nums text-slate-400">
                    {Number(data.portfolio.exposure).toLocaleString()}
                  </span>
                </span>
                <span>
                  drawdown{" "}
                  <span className="tabular-nums text-(--color-negative)">
                    {(Number(data.portfolio.drawdown) * 100).toFixed(2)}%
                  </span>
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                {data.portfolio.name} · {relTime(data.portfolio.ts, "—")}
              </div>
            </div>
          ) : (
            <Unavailable hint="No portfolio snapshot — start paper execution." />
          )}
        </Tile>

        {/* Active signals */}
        <Tile label="Signal Activity">
          {data ? (
            <div className="flex flex-1 flex-col justify-center">
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-semibold tabular-nums text-slate-100">
                  {data.signals.total.toLocaleString()}
                </span>
                <span className="text-[11px] text-slate-500">
                  total · {data.signals.last24h} in 24h
                  {data.signals.demo > 0 && (
                    <span className="text-(--color-warning)"> · {data.signals.demo} demo</span>
                  )}
                </span>
              </div>
              {data.signals.latest.length > 0 ? (
                <div className="mt-2 space-y-0.5">
                  {data.signals.latest.slice(0, 3).map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between font-mono text-[11px]"
                    >
                      <span className="flex items-center gap-1.5 text-slate-400">
                        {s.symbol}
                        {s.origin === "DEMO" && (
                          <span
                            title="generated from the synthetic DEMO lineage, not market data"
                            className="rounded border border-(--color-warning)/40 px-1 text-[8px] uppercase tracking-wider text-(--color-warning)"
                          >
                            demo
                          </span>
                        )}
                      </span>
                      <span className={DECISION_STYLE[s.decision] ?? "text-slate-400"}>
                        {s.decision}
                      </span>
                      <span className="text-slate-600">{relTime(s.createdAt, "—")}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-slate-600">
                  No EngineSignals yet — start the worker.
                </div>
              )}
            </div>
          ) : (
            <Unavailable hint="No data." />
          )}
        </Tile>

        {/* Strategies */}
        <Tile label="Strategies">
          {data ? (
            <div className="flex flex-1 flex-col justify-center">
              <div className="text-2xl font-semibold tabular-nums text-slate-100">
                {data.strategies.active}
                <span className="text-sm text-slate-500"> / {data.strategies.total}</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">active strategy versions</div>
              {data.strategies.demo > 0 && (
                <div className="mt-0.5 font-mono text-[10px] text-(--color-warning)">
                  +{data.strategies.demo} demo bootstrap (excluded from counts)
                </div>
              )}
            </div>
          ) : (
            <Unavailable hint="No strategies registered." />
          )}
        </Tile>

        {/* Data quality — latest REAL-venue report, shown honestly whatever its status. */}
        <Tile label="Data Quality">
          {data?.dataQuality ? (
            <div className="flex flex-1 flex-col justify-center">
              <div
                className={`text-2xl font-semibold tabular-nums ${
                  data.dataQuality.status === "PASSED"
                    ? "text-slate-100"
                    : "text-(--color-negative)"
                }`}
              >
                {data.dataQuality.score}
                <span className="text-sm text-slate-500"> / 100</span>
              </div>
              <div
                className={`mt-1 text-[11px] ${
                  data.dataQuality.status === "PASSED"
                    ? "text-slate-500"
                    : "text-(--color-negative)"
                }`}
              >
                {data.dataQuality.symbol} · {data.dataQuality.status}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                {relTime(data.dataQuality.createdAt, "—")}
              </div>
            </div>
          ) : (
            <Unavailable hint="No data-quality report from a real venue yet." />
          )}
        </Tile>

        {/* Pointer tile to the live signal feed */}
        <Tile label="Lineage">
          <div className="flex flex-1 flex-col justify-center text-[11px] leading-relaxed text-slate-500">
            Every signal carries verbatim <span className="font-mono text-slate-400">featureHash</span>{" "}
            / <span className="font-mono text-slate-400">datasetHash</span> lineage. See the{" "}
            <Link href="/signals" className="text-(--color-accent-500) hover:underline">
              Trading Terminal
            </Link>{" "}
            for the full reproducible feed.
          </div>
        </Tile>
      </div>
    </div>
  );
}
