import { ModulePage } from "@/components/module-page";

export const metadata = { title: "Risk Engine" };

export default function RiskPage() {
  return (
    <ModulePage
      title="Risk Engine"
      module="M4 · M9 · M10 · Defense"
      phase="Phases 2, 6, 7"
      description="Position sizing, hard limits, risk budgets, capacity, and the derivatives defense framework. Escalation is automatic and fail-closed; de-escalation from RISK_OFF or FROZEN requires human approval."
      widgets={[
        { title: "Position Sizing Calculator", detail: "Fixed fractional, fractional Kelly, ATR, volatility targeting — with per-limit checks." },
        { title: "Hard Limits", detail: "Daily/weekly/monthly drawdown, max exposure, correlation exposure — audited edits only." },
        { title: "Risk Mode", detail: "NORMAL → ELEVATED → RISK_OFF → FROZEN state machine with full history." },
        { title: "Detector Events", detail: "BTC volatility shock, ETH options risk, black swan monitors with actions taken." },
        { title: "Risk Budgets (M9)", detail: "Budget utilization per strategy, asset, and regime bucket." },
        { title: "Capacity (M10)", detail: "Portfolio, margin, and risk capacity with signal prioritization outcomes." },
      ]}
    />
  );
}
