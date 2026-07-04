"use client";

import { useMemo, useState } from "react";
import { usePortfolioExposure, usePortfolioHealth, usePortfolioSummary } from "@/lib/portfolio-client";
import { useDecisions } from "@/lib/trading-decision-client";
import { useReadiness } from "@/lib/trade-plan-client";
import {
  buildAllocationBars,
  buildCapitalMeter,
  buildExposureBars,
  buildHealthView,
  buildRiskHeatBar,
  buildStatistics,
  buildSummaryCards,
  buildTableRows,
  buildWarningGroups,
  sortPortfolio,
  type PortfolioSortKey,
  type SortDirection,
} from "@/lib/portfolio-terminal-derivations";
import type { PanelPollState } from "./console-ui";
import { PortfolioSummaryPanel } from "./portfolio-summary-panel";
import { PortfolioHealthPanel } from "./portfolio-health-panel";
import { PortfolioExposurePanel } from "./portfolio-exposure-panel";
import { PortfolioAllocationPanel } from "./portfolio-allocation-panel";
import { PortfolioRiskPanel } from "./portfolio-risk-panel";
import { PortfolioWarningPanel } from "./portfolio-warning-panel";
import { PortfolioStatisticsPanel } from "./portfolio-statistics-panel";
import { PortfolioTable } from "./portfolio-table";
import { PortfolioLoading } from "./portfolio-loading";
import { PortfolioEmpty } from "./portfolio-empty";

/**
 * Phase 10C-2B-1 — Professional Portfolio Terminal (presentation container).
 *
 * Consumes the existing `/api/v1/portfolio/{summary,exposure,health}` APIs (the Portfolio
 * Intelligence Engine — single source of truth) plus the served `signals/{decisions,readiness}`
 * feeds for the per-position table, all via the shared `usePolledResource` primitive at the
 * same cadence as the Signal Terminal. NOTHING is recomputed here — every panel is derived by
 * a pure, fail-closed function over the served (verbatim) outputs, with provenance preserved.
 */
export function PortfolioTerminal() {
  const summary = usePortfolioSummary();
  const exposure = usePortfolioExposure();
  const health = usePortfolioHealth();
  const decisions = useDecisions();
  const readiness = useReadiness();

  const [sortKey, setSortKey] = useState<PortfolioSortKey>("exposure");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const summaryState: PanelPollState = { loading: summary.loading, error: summary.error, lastUpdated: summary.lastUpdated };
  const exposureState: PanelPollState = { loading: exposure.loading, error: exposure.error, lastUpdated: exposure.lastUpdated };
  const healthState: PanelPollState = { loading: health.loading, error: health.error, lastUpdated: health.lastUpdated };

  // Derivations — pure, memoized on the served payloads.
  const cards = useMemo(() => buildSummaryCards(summary.data?.summary), [summary.data]);
  const meters = useMemo(() => buildCapitalMeter(summary.data?.summary), [summary.data]);
  const allocation = useMemo(() => buildAllocationBars(summary.data?.allocation), [summary.data]);
  const statistics = useMemo(() => buildStatistics(summary.data?.statistics), [summary.data]);
  const exposureBars = useMemo(() => buildExposureBars(exposure.data?.exposure), [exposure.data]);
  const heat = useMemo(() => buildRiskHeatBar(exposure.data?.heat), [exposure.data]);
  const healthView = useMemo(() => buildHealthView(health.data?.health), [health.data]);
  const warnings = useMemo(() => buildWarningGroups(health.data?.warnings), [health.data]);

  const rows = useMemo(() => {
    const built = buildTableRows({
      perSymbol: summary.data?.allocation.perSymbol ?? [],
      bySymbol: exposure.data?.exposure.bySymbol ?? [],
      decisions: decisions.data?.decisions ?? [],
      readiness: readiness.data?.readiness ?? [],
    });
    return sortPortfolio(built, sortKey, direction);
  }, [summary.data, exposure.data, decisions.data, readiness.data, sortKey, direction]);

  const onSort = (k: PortfolioSortKey) => {
    if (k === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      // Text columns read most naturally ascending; numeric columns best-first (descending).
      setDirection(["symbol", "direction", "status", "health"].includes(k) ? "asc" : "desc");
    }
  };

  const tableState: PanelPollState = {
    loading: summary.loading || exposure.loading,
    error: summary.error ?? exposure.error,
    lastUpdated:
      summary.lastUpdated !== null && exposure.lastUpdated !== null
        ? Math.min(summary.lastUpdated, exposure.lastUpdated)
        : (summary.lastUpdated ?? exposure.lastUpdated),
  };

  // First-load skeleton — nothing fetched yet.
  if (summary.loading && summary.data === null && summary.error === null) {
    return <PortfolioLoading />;
  }

  // Honest empty state — the engine served a valid but flat book (no candidate positions).
  const s = summary.data?.summary;
  const isEmpty =
    s !== undefined &&
    rows.length === 0 &&
    s.openTrades + s.blockedTrades + s.waitingTrades + s.flatTrades === 0;
  if (isEmpty) {
    return <PortfolioEmpty reason={summary.data?.summary.note ?? null} />;
  }

  const missing = summary.data?.symbolsMissingPrice ?? [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4">
        <PortfolioSummaryPanel cards={cards} capital={meters.capital} risk={meters.risk} state={summaryState} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PortfolioHealthPanel view={healthView} state={healthState} />
        <PortfolioRiskPanel view={heat} warningsCount={warnings.total} state={exposureState} />
        <PortfolioExposurePanel bars={exposureBars} state={exposureState} />
        <PortfolioAllocationPanel view={allocation} state={summaryState} />
      </div>

      <PortfolioWarningPanel view={warnings} state={healthState} />
      <PortfolioStatisticsPanel view={statistics} state={summaryState} />
      <PortfolioTable rows={rows} sortKey={sortKey} direction={direction} onSort={onSort} state={tableState} />

      {missing.length > 0 && (
        <p className="font-mono text-[10px] text-slate-600">
          no fresh mark for: {missing.join(", ")} — price-dependent exposure shows n/a (run ingestion
          concurrently for live prices)
        </p>
      )}
    </div>
  );
}
