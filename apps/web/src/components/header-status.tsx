"use client";

import { usePolledResource } from "@/lib/use-polled-resource";
import type { RiskOverview } from "@/lib/risk-overview-types";
import { MODE_STYLE } from "./risk-console";

/**
 * Global header risk-mode indicator. Reads the REAL persisted risk mode from
 * `/api/v1/risk/overview` (shared, deduped poll — the Risk Engine page reuses
 * the same subscription). Renders an explicit unavailable state when the
 * backend has no SystemRiskState or the endpoint is unreachable — the header
 * never asserts a mode it cannot prove.
 */
export function HeaderStatus() {
  const { data, error, loading } = usePolledResource<RiskOverview>(
    "/api/v1/risk/overview",
    "risk/overview",
    30_000,
  );

  const mode = data?.current?.mode ?? null;

  if (loading && !data) {
    return (
      <span className="font-mono text-[11px] uppercase tracking-widest text-slate-600">
        risk mode: …
      </span>
    );
  }

  if (mode === null) {
    return (
      <span
        className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest"
        title={error ?? "no SystemRiskState recorded"}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-600" />
        <span className="text-slate-500">risk mode: unavailable</span>
      </span>
    );
  }

  return (
    <span
      className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest"
      title={error ? `stale — ${error}` : (data?.current?.reason ?? undefined)}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${MODE_STYLE[mode].dot}`} />
      <span className="text-slate-400">
        risk mode: {mode}
        {error ? " (stale)" : ""}
      </span>
    </span>
  );
}
