import { DashboardOverview } from "@/components/dashboard-overview";

export const metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Dashboard</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            M6
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phases 3–8
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Portfolio overview at a glance — current risk mode, live signal activity, the latest
          portfolio snapshot, the strategy registry, and data-quality health. Every tile reads
          persisted truth; anything the runtime has not yet produced is shown as explicitly
          unavailable, never fabricated.
        </p>
      </header>

      <DashboardOverview />
    </div>
  );
}
