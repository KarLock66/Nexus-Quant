import { OpsConsole } from "@/components/ops-console";

export const metadata = { title: "Operations Control Plane" };

export default function OpsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Operations Control Plane</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            Operator
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phase 9.6
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Is the system alive, is data flowing, are features and signals updating, is risk
          active, is persistence healthy — and what failed, when, and what must be restarted.
          Every value is computed live from real persisted state. No mocks.
        </p>
      </header>

      <OpsConsole />
    </div>
  );
}
