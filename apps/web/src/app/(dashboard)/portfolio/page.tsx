import { ModulePage } from "@/components/module-page";

export const metadata = { title: "Portfolio Analytics" };

export default function PortfolioPage() {
  return (
    <ModulePage
      title="Portfolio Analytics"
      module="M6 · M9"
      phase="Phase 7"
      description="Institutional analytics over the paper portfolio: performance, attribution, correlation, and allocation. The same Python metrics module that scores backtests scores live analytics — the numbers cannot disagree."
      widgets={[
        { title: "Equity & Drawdown", detail: "Full curves with max-drawdown episode annotation." },
        { title: "Monthly Returns", detail: "Heatmap matrix with benchmark overlay." },
        { title: "Rolling Sharpe / Volatility", detail: "Configurable windows over the portfolio series." },
        { title: "Trade Distribution", detail: "R-multiple and PnL histograms from hypothetical trades." },
        { title: "Attribution & Correlation", detail: "Per-strategy/per-symbol contribution; rolling and regime-conditional correlation matrices." },
        { title: "Exports", detail: "CSV, JSON, and PDF reproducing on-screen numbers exactly." },
      ]}
    />
  );
}
