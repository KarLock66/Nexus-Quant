import { GovernanceConsole } from "@/components/governance-console";

export const metadata = { title: "Strategy Governance" };

export default function GovernancePage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Strategy Governance</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            M7
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phase 8
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Strategy registry with immutable versioning, dual approval workflows, and a complete
          audit trail — read from persisted truth (Strategy, StrategyVersion, ApprovalRequest,
          AuditLog). Every change records who, what, why, when; requester can never equal reviewer.
        </p>
      </header>

      <GovernanceConsole />
    </div>
  );
}
