import { ControlCenter } from "@/components/control-center";

export const metadata = { title: "Production Control Center" };

export default function ControlPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Production Control Center</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            Operator
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phase 9.7
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Control, protection, and recovery — not just visibility. Runtime state machine, the
          fail-closed trading-permission gate every execution path consults, the global kill
          switch, automated protection with verified recovery, operator runbooks, the incident
          timeline, and the immutable audit trail. Every value is real persisted control state.
        </p>
      </header>

      <ControlCenter />
    </div>
  );
}
