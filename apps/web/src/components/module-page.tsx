import { Hourglass } from "lucide-react";

interface PlannedWidget {
  title: string;
  detail: string;
}

interface ModulePageProps {
  title: string;
  module: string;
  phase: string;
  description: string;
  widgets: PlannedWidget[];
}

/**
 * Explicit production empty-state for a module whose backend has not landed
 * yet: states what the page will do, which roadmap phase delivers it, and
 * marks every capability as PLANNED. No live data is implied, no metrics are
 * fabricated. Replaced module-by-module as phases land.
 */
export function ModulePage({
  title,
  module,
  phase,
  description,
  widgets,
}: ModulePageProps) {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">{title}</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            {module}
          </span>
          <span className="rounded-full border border-(--color-warning)/40 bg-(--color-warning)/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-warning)">
            lands in {phase}
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          {description}
        </p>
      </header>

      <div
        role="status"
        className="glass flex items-start gap-3 border-(--color-warning)/20 p-4"
      >
        <Hourglass size={16} className="mt-0.5 shrink-0 text-(--color-warning)" aria-hidden="true" />
        <div className="text-sm text-slate-400">
          <span className="font-medium text-slate-200">
            This module is not live yet — nothing on this page is real data.
          </span>{" "}
          The backend for {title} ships in {phase}. The cards below describe the planned
          capabilities only.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {widgets.map((w) => (
          <div key={w.title} className="glass glass-hover p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-slate-200">{w.title}</span>
              <span className="shrink-0 rounded border border-(--color-line) px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                planned
              </span>
            </div>
            <div className="text-xs leading-relaxed text-slate-500">{w.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
