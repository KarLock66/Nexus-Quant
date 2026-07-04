import { PortfolioTerminal } from "@/components/portfolio-terminal";

export const metadata = { title: "Portfolio Terminal" };

export default function PortfolioPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Portfolio Terminal</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            Institutional Console
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phase 10C-2B
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          A live, presentation-only view over the{" "}
          <span className="font-mono text-slate-300">Portfolio Intelligence Engine</span>: summary, health,
          exposure, capital allocation, risk heat, warnings, statistics, and a sortable position table.
          Every value is aggregated VERBATIM from the served decisions and plans — nothing is recomputed —
          and each carries its provenance (real · derived · estimated · unavailable). Unavailable data is
          shown as such, never fabricated. The Portfolio Engine remains the single source of truth.
        </p>
      </header>

      <PortfolioTerminal />
    </div>
  );
}
