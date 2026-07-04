/**
 * Phase 10A-2 — Professional Trading Terminal: pure presentational viz primitives.
 *
 * Every component here is PROPS-ONLY (no hooks, no fetching, no clock) so it renders
 * deterministically and is unit-renderable via react-dom/server. No chart library —
 * meters and bars are plain flex/width divs using the existing design tokens. Each
 * primitive renders provenance and fails closed to "—" when a value is null/non-finite,
 * never a NaN.
 */

import type { ReactNode } from "react";
import { Badge, Dot, TONE, type Tone } from "./console-ui";
import type { Measure, Provenance } from "@/lib/trading-decision-types";
import type { GradeView, PanelLiveStatus, RiskRewardBar } from "@/lib/terminal-derivations";

/* ─────────────────── tone maps ─────────────────── */

export const PROV_TONE: Record<Provenance, Tone> = {
  verbatim: "positive",
  real: "positive",
  derived: "info",
  estimated: "warning",
  unavailable: "neutral",
};

const PROV_LABEL: Record<Provenance, string> = {
  verbatim: "VERBATIM",
  real: "REAL",
  derived: "DERIVED",
  estimated: "EST",
  unavailable: "N/A",
};

const LIVE_TONE: Record<PanelLiveStatus, Tone> = {
  LIVE: "positive",
  STALE: "warning",
  BLOCKED: "negative",
  WAITING: "warning",
  UNAVAILABLE: "neutral",
};

const GRADE_TONE: Record<string, Tone> = {
  "A+": "positive",
  A: "positive",
  B: "info",
  C: "warning",
  D: "negative",
  F: "negative",
};

/* ─────────────────── number formatting (fail-closed) ─────────────────── */

export function fmt(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/* ─────────────────── provenance ─────────────────── */

export function ProvDot({ p }: { p: Provenance }) {
  return (
    <span title={`provenance: ${p}`}>
      <Dot tone={PROV_TONE[p]} />
    </span>
  );
}

export function ProvTag({ p }: { p: Provenance }) {
  return (
    <span
      title={`provenance: ${p}`}
      className={`font-mono text-[8px] uppercase tracking-wider ${TONE[PROV_TONE[p]].badge.split(" ")[0]}`}
    >
      {PROV_LABEL[p]}
    </span>
  );
}

/** A provenance-tagged Measure: value+unit (mono, tabular), or "—" with the basis on hover. */
export function Val({
  m,
  unit = "",
  dp = 2,
  prefix = "",
}: {
  m: Measure;
  unit?: string;
  dp?: number;
  prefix?: string;
}) {
  if (m.value === null || !Number.isFinite(m.value)) {
    return (
      <span title={m.basis} className="font-mono text-slate-600">
        — <span className="text-[9px] uppercase tracking-wider">n/a</span>
      </span>
    );
  }
  return (
    <span title={m.basis} className="font-mono tabular-nums text-slate-100">
      {prefix}
      {fmt(m.value, dp)}
      {unit}
    </span>
  );
}

/* ─────────────────── live status ─────────────────── */

export function LiveTag({ status }: { status: PanelLiveStatus }) {
  return <Badge tone={LIVE_TONE[status]} text={status} />;
}

/* ─────────────────── setup grade ─────────────────── */

export function GradeBadge({ g, size = "lg" }: { g: GradeView; size?: "lg" | "sm" }) {
  const tone = GRADE_TONE[g.grade] ?? "neutral";
  const dim = size === "lg" ? "h-12 w-12 text-2xl" : "h-7 w-9 text-sm";
  return (
    <span
      title={g.basis}
      className={`inline-flex items-center justify-center rounded-lg border font-mono font-bold tabular-nums ${dim} ${TONE[tone].badge}`}
    >
      {g.grade}
    </span>
  );
}

/* ─────────────────── meter (0..100 fill) ─────────────────── */

export function Meter({
  label,
  value,
  display,
  tone = "info",
  provenance,
}: {
  label: string;
  /** 0..100 fill fraction. */
  value: number;
  /** What to show on the right (already formatted). */
  display: ReactNode;
  tone?: Tone;
  provenance?: Provenance;
}) {
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
          {provenance && <ProvTag p={provenance} />}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-slate-200">{display}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-(--color-surface-800)" aria-hidden="true">
        <div className={`h-full rounded-full ${TONE[tone].dot}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ─────────────────── risk / reward bar ─────────────────── */

/**
 * Proportional R:R visualisation: a red risk leg (entry→stop) on the left and stacked
 * green reward legs (entry→TP1/TP2/TP3) on the right, with entry at the pivot. Widths are
 * fractions of the full risk→TP3 span. Renders a fail-closed placeholder when `bar` is null.
 */
export function RRBar({ bar, rr }: { bar: RiskRewardBar | null; rr: Measure }) {
  if (!bar) {
    return (
      <div className="rounded-md border border-(--color-line) bg-(--color-surface-900)/40 px-2.5 py-2 font-mono text-[10px] text-slate-600">
        R:R visual unavailable — no directional levels
      </div>
    );
  }
  const riskW = bar.riskFrac * 100;
  const tp1W = bar.tp1Frac * 100;
  const tp2W = (bar.tp2Frac - bar.tp1Frac) * 100;
  const tp3W = (bar.tp3Frac - bar.tp2Frac) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">risk / reward</span>
        <span className="font-mono text-[11px] tabular-nums text-slate-200">
          <Val m={rr} unit=":1" />
        </span>
      </div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-md border border-(--color-line) bg-(--color-surface-900)"
        aria-hidden="true"
      >
        <div className="h-full bg-(--color-negative)/70" style={{ width: `${riskW}%` }} title="risk (entry→stop)" />
        <div className="h-full w-px bg-slate-300/60" title="entry" />
        <div className="h-full bg-(--color-positive)/80" style={{ width: `${tp1W}%` }} title="reward → TP1" />
        <div className="h-full bg-(--color-positive)/55" style={{ width: `${tp2W}%` }} title="reward → TP2" />
        <div className="h-full bg-(--color-positive)/35" style={{ width: `${tp3W}%` }} title="reward → TP3" />
      </div>
      <div className="flex justify-between font-mono text-[9px] text-slate-600">
        <span>stop</span>
        <span>entry</span>
        <span>TP1</span>
        <span>TP3</span>
      </div>
    </div>
  );
}

/* ─────────────────── TP progress ─────────────────── */

/** Where the current mark sits between entry (0%) and TP3 (100%). null → fail-closed bar. */
export function TPProgress({ pct }: { pct: number | null }) {
  const p = pct === null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">progress to TP3</span>
        <span className="font-mono text-[11px] tabular-nums text-slate-200">
          {p === null ? "—" : `${fmt(p, 1)}%`}
        </span>
      </div>
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-(--color-surface-800)"
        aria-hidden="true"
      >
        <div className="h-full rounded-full bg-(--color-accent-500)" style={{ width: `${p ?? 0}%` }} />
      </div>
    </div>
  );
}

/* ─────────────────── entry zone band ─────────────────── */

/**
 * A small band visual for the entry zone: low … mark … high. The mark marker sits at the
 * center by construction (entry = current mark). Fail-closed when bounds are null.
 */
export function ZoneBar({ low, high, mid }: { low: number | null; high: number | null; mid: number | null }) {
  const ok = low !== null && high !== null && mid !== null && high > low;
  const markerPct = ok ? Math.max(0, Math.min(100, ((mid! - low!) / (high! - low!)) * 100)) : 50;
  return (
    <div className="space-y-1">
      <div className="flex justify-between font-mono text-[10px] tabular-nums text-slate-400">
        <span title="zone low">{fmt(low)}</span>
        <span className="text-slate-500">entry zone</span>
        <span title="zone high">{fmt(high)}</span>
      </div>
      <div
        className="relative h-2 w-full rounded-full border border-(--color-line) bg-(--color-accent-500)/15"
        aria-hidden="true"
      >
        {ok && (
          <span
            className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-(--color-accent-500)"
            style={{ left: `${markerPct}%` }}
            title="current mark (mid-zone)"
          />
        )}
      </div>
    </div>
  );
}

/* ─────────────────── labelled stat (provenance-aware) ─────────────────── */

export function Stat({
  label,
  children,
  prov,
  hint,
}: {
  label: string;
  children: ReactNode;
  prov?: Provenance;
  hint?: string;
}) {
  return (
    <div
      className="rounded-lg border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2"
      title={hint}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
        {prov && <ProvTag p={prov} />}
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-slate-100">{children}</div>
    </div>
  );
}
