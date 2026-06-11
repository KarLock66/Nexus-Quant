import { ModulePage } from "@/components/module-page";

export const metadata = { title: "Strategy Governance" };

export default function GovernancePage() {
  return (
    <ModulePage
      title="Strategy Governance"
      module="M7"
      phase="Phase 8"
      description="Strategy registry with immutable versioning, dual approval workflows (backtest + deploy), and a complete audit trail. Every change records who, what, why, when — and requester can never equal reviewer."
      widgets={[
        { title: "Strategy Registry", detail: "All strategies with lifecycle status from DRAFT through RETIRED." },
        { title: "Version Diffs", detail: "Parameter and logic diffs between any two immutable versions." },
        { title: "Approval Queue", detail: "Backtest, deploy, parameter, AI-recommendation, and risk-mode approvals." },
        { title: "Audit Trail", detail: "Filterable log with before/after JSON diffs and mandatory reasons." },
        { title: "Mandatory Fields", detail: "Hypothesis, entry/exit logic, risk rules, failure conditions — schema-enforced." },
        { title: "AI Proposals", detail: "Governance-agent proposals enter the same human approval queue as everything else." },
      ]}
    />
  );
}
