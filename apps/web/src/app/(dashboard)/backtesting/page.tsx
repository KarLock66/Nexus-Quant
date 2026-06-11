import { ModulePage } from "@/components/module-page";

export const metadata = { title: "Backtesting Studio" };

export default function BacktestingPage() {
  return (
    <ModulePage
      title="Backtesting Studio"
      module="M3"
      phase="Phase 4"
      description="Historical backtests (VectorBT, cross-validated by Backtrader), walk-forward analysis, Monte Carlo simulation, and named stress scenarios. Expected vs. realized performance feeds the calibration loop — deviations create proposals, never auto-deploys."
      widgets={[
        { title: "Backtest Runner", detail: "Queue runs per strategy version with fees, slippage, and data-scope config." },
        { title: "Metrics", detail: "CAGR, Sharpe, Sortino, profit factor, max drawdown, win rate, recovery factor." },
        { title: "Walk-Forward", detail: "Rolling IS/OOS windows; out-of-sample metrics reported exclusively." },
        { title: "Monte Carlo", detail: "Trade resampling and block bootstrap: drawdown distribution, ruin probability." },
        { title: "Stress Scenarios", detail: "Mar-2020, May-2021, FTX-2022 replays plus synthetic gap/vol/liquidity shocks." },
        { title: "Calibration Reports", detail: "Expected vs. actual deviation tracking with approval-gated proposals." },
      ]}
    />
  );
}
