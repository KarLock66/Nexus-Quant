/**
 * Phase 10C-2B-1 — Professional Portfolio Terminal: pure presentational viz primitives.
 *
 * Every component here is PROPS-ONLY (no hooks, no fetching, no clock) so it renders
 * deterministically and is unit-renderable via react-dom/server. No chart library — bars and
 * meters are plain flex/width divs using the existing design tokens (reuses console-ui's
 * TONE / Badge / Dot — no new design language). Each primitive renders provenance and fails
 * closed to "—" when a value is null/non-finite, never a NaN.
 */

import type { ReactNode } from "react";
import { Badge, Dot, TONE, type Tone } from "./console-ui";
import type { Provenance } from "@/lib/portfolio-types";
import { PROVENANCE_TONE } from "@/lib/portfolio-terminal-derivations";

/* ─────────────────── provenance ─────────────────── */

const PROV_LABEL: Record<Provenance, string> = {
  verbatim: "VERBATIM",
  real: "REAL",
  derived: "DERIVED",
  estimated: "EST",
  unavailable: "N/A",
};

export function ProvDot({ p }: { p: Provenance }) {
  return (
    <span title={`provenance: ${p}`}>
      <Dot tone={PROVENANCE_TONE[p]} />
    </span>
  );
}

export function ProvTag({ p }: { p: Provenance }) {
  return (
    <span
      title={`provenance: ${p}`}
      className={`font-mono text-[8px] uppercase tracking-wider ${TONE[PROVENANCE_TONE[p]].badge.split(" ")[0]}`}
    >
      {PROV_LABEL[p]}
    </span>
  );
}

/* ─────────────────── labelled metric tile (provenance-aware) ─────────────────── */

export function Tile({
  label,
  value,
  tone,
  prov,
  hint,
  qualifier,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  prov?: Provenance;
  hint?: string;
  /** Visible basis chip (e.g. "assumed") — hover hints alone can't carry provenance. */
  qualifier?: string;
}) {
  const valueClass = tone ? `${TONE[tone].badge.split(" ")[0]}` : "text-slate-100";
  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2.5" title={hint}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
        <span className="flex items-center gap-1">
          {qualifier && (
            <span className="rounded border border-(--color-warning)/40 px-1 font-mono text-[8px] uppercase tracking-wider text-(--color-warning)">
              {qualifier}
            </span>
          )}
          {prov && <ProvTag p={prov} />}
        </span>
      </div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

/* ─────────────────── horizontal bar (share / allocation) ─────────────────── */

/**
 * A labelled horizontal bar: a left label, a proportional fill (0..100, clamped by the
 * caller), and a right-aligned value. Width is the ONLY thing derived — the value string is
 * already fail-closed by the derivation layer.
 */
export function Bar({
  label,
  pct,
  value,
  tone = "info",
  prov,
  count,
  hint,
}: {
  label: string;
  pct: number;
  value: string;
  tone?: Tone;
  prov?: Provenance;
  count?: number;
  hint?: string;
}) {
  const width = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div className="space-y-1" title={hint}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1.5 truncate">
          <span className="truncate font-mono text-slate-300">{label}</span>
          {typeof count === "number" && <span className="font-mono text-[9px] text-slate-600">×{count}</span>}
          {prov && <ProvTag p={prov} />}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-slate-200">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-(--color-surface-800)" aria-hidden="true">
        <div className={`h-full rounded-full ${TONE[tone].dot}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

/* ─────────────────── meter (0..100 fill with used / remaining legs) ─────────────────── */

export function Meter({
  label,
  pct,
  display,
  tone = "info",
  prov,
  hint,
}: {
  label: string;
  pct: number;
  display: ReactNode;
  tone?: Tone;
  prov?: Provenance;
  hint?: string;
}) {
  const width = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div className="space-y-1" title={hint}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
          {prov && <ProvTag p={prov} />}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-slate-200">{display}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-(--color-surface-800)" aria-hidden="true">
        <div className={`h-full rounded-full ${TONE[tone].dot}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

/* ─────────────────── heat scale (cool → extreme) ─────────────────── */

/**
 * A 0..100 heat scale with a gradient track and a marker at `pct`. The gradient is purely
 * cosmetic (cool→warm→hot→extreme); the band tone/label come from the engine verbatim.
 */
export function HeatScale({ pct, band, label }: { pct: number; band: Tone; label: string }) {
  const width = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">risk heat</span>
        <Badge tone={band} text={label} />
      </div>
      <div
        aria-hidden="true"
        className="relative h-3 w-full overflow-hidden rounded-full border border-(--color-line) bg-gradient-to-r from-(--color-positive)/30 via-(--color-warning)/40 to-(--color-negative)/60"
      >
        <span
          className="absolute top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-slate-100 shadow"
          style={{ left: `calc(${width}% - 2px)` }}
          title="heat score"
        />
      </div>
      <div className="flex justify-between font-mono text-[8px] uppercase tracking-wider text-slate-600">
        <span>cool</span>
        <span>warm</span>
        <span>hot</span>
        <span>extreme</span>
      </div>
    </div>
  );
}

/* ─────────────────── value with fail-closed dash ─────────────────── */

/** Render a pre-formatted string, dimming the fail-closed "—" so absence reads as absence. */
export function Val({ children, mono = true }: { children: string; mono?: boolean }) {
  const dash = children === "—";
  return (
    <span className={`${mono ? "font-mono tabular-nums" : ""} ${dash ? "text-slate-600" : "text-slate-100"}`}>
      {children}
      {dash && <span className="ml-1 text-[8px] uppercase tracking-wider text-slate-600">n/a</span>}
    </span>
  );
}
