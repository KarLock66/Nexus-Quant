import { ModulePage } from "@/components/module-page";

export default function DashboardPage() {
  return (
    <ModulePage
      title="Dashboard"
      module="M6"
      phase="Phase 7"
      description="Portfolio overview at a glance: equity, drawdown, active signals, risk mode, capacity utilization, and strategy health. Every number traces back to a versioned feature snapshot and an audited gate decision."
      widgets={[
        { title: "Portfolio Overview", detail: "Equity, exposure, open hypothetical positions, base-currency PnL." },
        { title: "Equity & Drawdown Curve", detail: "Live paper-portfolio curve vs. BTC/ETH buy-and-hold benchmark." },
        { title: "Active Signals", detail: "Currently ACTIVE signals with state, confidence, RR, and gate summary." },
        { title: "Risk Mode & Events", detail: "Current system risk mode with the most recent detector events." },
        { title: "Capacity Gauges", detail: "Portfolio / margin / risk capacity utilization from the latest M10 assessment." },
        { title: "Strategy Health", detail: "Composite health score per active strategy from M3 calibration." },
      ]}
    />
  );
}
