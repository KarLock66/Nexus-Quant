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
 * Phase 0 placeholder for each platform page: states what the page will do
 * and which roadmap phase delivers it. Replaced module-by-module as phases land.
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
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-white">{title}</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            {module}
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            lands in {phase}
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          {description}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {widgets.map((w) => (
          <div key={w.title} className="glass glass-hover p-4">
            <div className="mb-1 text-[13px] font-medium text-slate-200">
              {w.title}
            </div>
            <div className="text-xs leading-relaxed text-slate-500">
              {w.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
