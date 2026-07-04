import { SystemMonitor } from "@/components/system-monitor";

export const metadata = { title: "System Monitoring" };

export default function SystemPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">System Monitoring</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            Platform
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phase 1
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Live health of every component: exchange connectors, data-quality scores, the
          ingest → DQ → feature → signal pipeline, and queue/worker activity. Degraded data
          quality freezes signal generation — visibly.
        </p>
      </header>

      <SystemMonitor />
    </div>
  );
}
