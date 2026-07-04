/**
 * Phase 10C-2B-1 — Panel G: Portfolio Table. Pure, props-only. A sortable, deterministic
 * table over every candidate position. Each cell is carried VERBATIM from its source (the
 * engine remains the single source of truth) and fails closed to "—". The sort is stable with
 * nulls always last (the ordering is computed in the pure derivation layer).
 */

import { Badge, Dot, Panel, type PanelPollState, type Tone } from "./console-ui";
import { ProvTag, Val } from "./portfolio-viz";
import {
  formatConfidence,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatRatio,
  type PortfolioSortKey,
  type PortfolioTableRow,
  type SortDirection,
} from "@/lib/portfolio-terminal-derivations";

const DIRECTION_TONE: Record<string, Tone> = { LONG: "positive", SHORT: "negative", FLAT: "neutral" };

const COLUMNS: { key: PortfolioSortKey; label: string; align: "left" | "right" }[] = [
  { key: "symbol", label: "Symbol", align: "left" },
  { key: "direction", label: "Dir", align: "left" },
  { key: "status", label: "Status", align: "left" },
  { key: "confidence", label: "Conf", align: "right" },
  { key: "readiness", label: "Ready", align: "right" },
  { key: "risk", label: "Risk", align: "right" },
  { key: "capital", label: "Capital", align: "right" },
  { key: "exposure", label: "Exposure", align: "right" },
  { key: "rr", label: "R:R", align: "right" },
  { key: "health", label: "Health", align: "left" },
];

function HeaderCell({
  col,
  sortKey,
  direction,
  onSort,
}: {
  col: (typeof COLUMNS)[number];
  sortKey: PortfolioSortKey;
  direction: SortDirection;
  onSort?: (k: PortfolioSortKey) => void;
}) {
  const active = sortKey === col.key;
  const arrow = active ? (direction === "asc" ? "▲" : "▼") : "";
  // Announce the sort state programmatically: assistive tech reads `aria-sort` off the
  // active column header; the arrow glyph is decorative and hidden from it.
  const ariaSort = active ? (direction === "asc" ? "ascending" : "descending") : "none";
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider ${col.align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={() => onSort?.(col.key)}
        aria-label={`Sort by ${col.label}${active ? `, currently ${ariaSort}` : ""}`}
        className={`inline-flex items-center gap-1 transition-colors ${active ? "text-(--color-accent-500)" : "text-slate-500 hover:text-slate-300"}`}
      >
        {col.label}
        {arrow && (
          <span aria-hidden="true" className="text-[8px]">
            {arrow}
          </span>
        )}
      </button>
    </th>
  );
}

function Row({ r }: { r: PortfolioTableRow }) {
  return (
    <tr className="border-t border-(--color-line)/60 hover:bg-(--color-surface-900)/40">
      <td className="px-2 py-1.5 text-[12px] text-slate-200">{r.symbol}</td>
      <td className="px-2 py-1.5">
        {r.direction ? (
          <Badge tone={DIRECTION_TONE[r.direction] ?? "neutral"} text={r.direction} />
        ) : (
          <span className="font-mono text-[10px] text-slate-600">—</span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <Badge tone={r.status.tone} text={r.status.label} />
      </td>
      <td className="px-2 py-1.5 text-right">
        <Val>{formatConfidence(r.confidence)}</Val>
      </td>
      <td className="px-2 py-1.5 text-right">
        <Val>{formatNumber(r.readiness, 0)}</Val>
      </td>
      <td className="px-2 py-1.5 text-right">
        <Val>{formatPercent(r.risk.value, 2)}</Val>
      </td>
      <td className="px-2 py-1.5 text-right">
        <Val>{formatPercent(r.capitalPct.value, 1)}</Val>
      </td>
      <td className="px-2 py-1.5 text-right">
        <Val>{r.notional === null ? formatPercent(r.exposurePct.value, 1) : formatCurrency(r.notional)}</Val>
      </td>
      <td className="px-2 py-1.5 text-right">
        <Val>{formatRatio(r.riskReward)}</Val>
      </td>
      <td className="px-2 py-1.5">
        <span title={`health: ${r.status.label}`}>
          <Dot tone={r.status.tone} />
        </span>
      </td>
      <td className="px-2 py-1.5">
        <ProvTag p={r.rowProvenance} />
      </td>
    </tr>
  );
}

export function PortfolioTable({
  rows,
  sortKey,
  direction,
  onSort,
  state,
}: {
  rows: PortfolioTableRow[];
  sortKey: PortfolioSortKey;
  direction: SortDirection;
  onSort?: (k: PortfolioSortKey) => void;
  state: PanelPollState;
}) {
  return (
    <Panel
      title="Portfolio Table"
      hint="Every candidate position, sortable across all columns. Direction / confidence / R:R / risk are verbatim from the served decision; readiness from the served plan; capital / exposure from the allocation. Click a header to sort — nulls always sort last."
      badge={<Badge tone="info" text={`${rows.length} rows`} />}
      state={state}
      empty={rows.length === 0}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <HeaderCell key={col.key} col={col} sortKey={sortKey} direction={direction} onSort={onSort} />
              ))}
              <th scope="col" className="px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-slate-500">
                Prov
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.symbol} r={r} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-[9px] text-slate-600">
        Exposure shows $ notional where available, else the allocation share %. Provenance reflects the
        strongest backing source for the row (VERBATIM = a served decision; DERIVED = allocation-only).
      </p>
    </Panel>
  );
}
