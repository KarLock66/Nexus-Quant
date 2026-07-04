"use client";

import { useSyncExternalStore, type ReactNode } from "react";

/**
 * Shared console UI primitives (Panel / Badge / Dot / Metric + time helpers) for the
 * operator-facing pages. Factored out of the Phase 9.6 ops console styling so the Phase
 * 9.7 control center can reuse the identical look without importing or mutating
 * ops-console.tsx. Presentational only — no data fetching.
 */

/* ─────────────────── shared 1s clock ─────────────────── */

// One interval for the whole app; subscribers re-render once per second while at
// least one is mounted. Without a tick, relative-time labels only recompute when
// a poll publishes — the Panel header would read "just now" forever between
// polls (and during a hung backend, indefinitely).
let clockNowMs = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockSubscribers = new Set<() => void>();

function subscribeClock(onChange: () => void): () => void {
  clockSubscribers.add(onChange);
  if (clockTimer === null) {
    clockNowMs = Date.now();
    clockTimer = setInterval(() => {
      clockNowMs = Date.now();
      for (const notify of clockSubscribers) notify();
    }, 1_000);
  }
  return () => {
    clockSubscribers.delete(onChange);
    if (clockSubscribers.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const getClockNow = (): number => clockNowMs;
// SSR renders 0; every time label in the app is gated behind client-fetched data
// (null during SSR), so no label is ever computed from the server snapshot.
const getServerClockNow = (): number => 0;

/** Epoch ms, ticking once per second (shared interval). */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, getClockNow, getServerClockNow);
}

export type Tone = "positive" | "warning" | "negative" | "neutral" | "info";

export const TONE: Record<Tone, { dot: string; badge: string }> = {
  positive: {
    dot: "bg-(--color-positive)",
    badge: "text-(--color-positive) border-(--color-positive)/40 bg-(--color-positive)/10",
  },
  warning: {
    dot: "bg-(--color-warning)",
    badge: "text-(--color-warning) border-(--color-warning)/40 bg-(--color-warning)/10",
  },
  negative: {
    dot: "bg-(--color-negative)",
    badge: "text-(--color-negative) border-(--color-negative)/40 bg-(--color-negative)/10",
  },
  neutral: {
    dot: "bg-slate-500",
    badge: "text-slate-400 border-(--color-line) bg-(--color-surface-800)",
  },
  info: {
    dot: "bg-(--color-accent-500)",
    badge: "text-(--color-accent-500) border-(--color-accent-500)/40 bg-(--color-accent-500)/10",
  },
};

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${TONE[tone].dot}`} />;
}

export function Badge({ tone, text }: { tone: Tone; text: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${TONE[tone].badge}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${TONE[tone].dot}`} />
      {text}
    </span>
  );
}

export function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border border-(--color-line) bg-(--color-surface-900)/60 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export function relTime(iso: string | null, nullLabel = "never"): string {
  if (!iso) return nullLabel;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function sinceMs(ms: number | null, nowMs: number): string {
  if (ms === null) return "—";
  const s = Math.round((nowMs - ms) / 1000);
  return s < 1 ? "just now" : `${s}s ago`;
}

export interface PanelPollState {
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
}

export function Panel({
  title,
  hint,
  badge,
  state,
  empty,
  emptyLabel,
  children,
}: {
  title: string;
  hint: string;
  badge?: ReactNode;
  state: PanelPollState;
  empty?: boolean;
  emptyLabel?: string;
  children: ReactNode;
}) {
  const firstLoad = state.loading && state.lastUpdated === null;
  // Ticking clock so the header counts up between polls instead of freezing at
  // "just now". Labeled "polled" because it is POLL freshness (when this panel
  // last fetched), not data freshness — the rows themselves carry data times.
  const now = useNow();
  return (
    <section className="glass flex flex-col gap-4 p-5" aria-busy={firstLoad}>
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
            {badge}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-slate-600">
          {firstLoad ? "loading" : `polled ${sinceMs(state.lastUpdated, now)}`}
        </span>
      </header>

      {state.error && (
        <div
          role="status"
          className="rounded-md border border-(--color-warning)/30 bg-(--color-warning)/5 px-3 py-2 font-mono text-[11px] text-(--color-warning)"
        >
          stale — {state.error}
        </div>
      )}

      {firstLoad ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-(--color-surface-800)" />
          ))}
        </div>
      ) : empty ? (
        <p className="py-6 text-center text-xs text-slate-500">{emptyLabel ?? "None recorded yet."}</p>
      ) : (
        children
      )}
    </section>
  );
}
