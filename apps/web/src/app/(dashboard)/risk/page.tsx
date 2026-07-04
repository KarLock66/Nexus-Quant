import { RiskConsole } from "@/components/risk-console";

export const metadata = { title: "Risk Engine" };

export default function RiskPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Risk Engine</h1>
          <span className="rounded-full border border-(--color-line) bg-(--color-surface-800) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-accent-500)">
            M4 · M9 · M10
          </span>
          <span className="rounded-full border border-(--color-line) px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            Phases 2, 6, 7, 8
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Live risk state read from persisted truth: the current risk mode and its history
          (SystemRiskState), the hard limits (RiskLimit), detector events (RiskEvent), and M9
          budgets (RiskBudget). Escalation is automatic and fail-closed; de-escalation from
          RISK_OFF or FROZEN requires human approval.
        </p>
      </header>

      <RiskConsole />
    </div>
  );
}
