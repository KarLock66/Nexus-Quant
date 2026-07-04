/**
 * Kill Switch trigger evaluation (Phase 8, Deliverable 5) — the PURE decision of
 * whether a global trading halt should engage, given the current capital, exposure,
 * the session baseline / high-water-mark, the configured limits, and external health
 * signals. The STATE of the halt (engaged/cleared) is not held here — it lives in the
 * journal-derived RiskControlState (state.ts), so a halt survives a restart and is
 * cleared only by an explicit reset (engine.reset). NO automatic recovery.
 *
 * Triggers (checked in this deterministic order; the FIRST tripped wins):
 *   DAILY_LOSS_BREACH             dailyPnL < -dailyLossLimit
 *   DRAWDOWN_BREACH               currentDrawdown > maxDrawdown
 *   LEVERAGE_BREACH               grossExposure / equity > maxLeverage  (or insolvent)
 *   MARKET_DATA_STALE             health.marketDataStale
 *   RECOVERY_FAILURE              health.recoveryFailure
 *   JOURNAL_INTEGRITY_FAILURE     health.journalIntegrityFailure
 *   EXCHANGE_CONNECTIVITY_FAILURE health.exchangeConnectivityFailure
 *
 * Pure: no clock, no randomness; identical inputs always yield the identical decision.
 */

import { parseDecimal } from "./money.js";
import type {
  CapitalSnapshot,
  HealthSignals,
  KillSwitchTrigger,
  RiskLimits,
} from "./types.js";

export interface TriggerInput {
  capital: CapitalSnapshot;
  limits: RiskLimits;
  /** Session-window PnL: current equity − baseline equity (negative = loss). */
  dailyPnL: number;
  /** Current drawdown as a fraction: (peak − equity) / peak (0 when peak <= 0). */
  drawdown: number;
  health?: HealthSignals;
}

/** A tripped trigger and its deterministic detail. */
export interface TriggerResult {
  trigger: KillSwitchTrigger;
  detail: string;
}

/**
 * Compute the current drawdown fraction from the high-water-mark and current equity.
 * Pure; returns 0 when there is no positive peak yet (no history → no drawdown).
 */
export function currentDrawdown(peakEquity: number, equity: number): number {
  if (!(peakEquity > 0) || !Number.isFinite(equity)) return 0;
  const dd = (peakEquity - equity) / peakEquity;
  return dd > 0 ? dd : 0;
}

/**
 * Evaluate the global kill-switch triggers. Returns the first tripped trigger (with
 * an audit detail) or null when none trips. Fail-closed on insolvency: a non-positive
 * equity with open gross exposure trips LEVERAGE_BREACH (leverage is undefined → halt).
 */
export function evaluateTriggers(input: TriggerInput): TriggerResult | null {
  const { capital, limits, dailyPnL, drawdown, health } = input;
  const equity = parseDecimal(capital.accountEquity);
  const gross = parseDecimal(capital.grossExposure);

  if (Number.isFinite(dailyPnL) && dailyPnL < -limits.dailyLossLimit) {
    return {
      trigger: "DAILY_LOSS_BREACH",
      detail: `dailyPnL ${dailyPnL.toFixed(2)} < -dailyLossLimit ${limits.dailyLossLimit}`,
    };
  }

  if (Number.isFinite(drawdown) && drawdown > limits.maxDrawdown) {
    return {
      trigger: "DRAWDOWN_BREACH",
      detail: `drawdown ${drawdown.toFixed(6)} > maxDrawdown ${limits.maxDrawdown}`,
    };
  }

  // Leverage breach OR insolvency-with-exposure (equity <= 0 makes leverage undefined).
  if (equity > 0) {
    const leverage = gross / equity;
    if (leverage > limits.maxLeverage) {
      return {
        trigger: "LEVERAGE_BREACH",
        detail: `leverage ${leverage.toFixed(6)} (gross ${capital.grossExposure} / equity ${capital.accountEquity}) > max ${limits.maxLeverage}`,
      };
    }
  } else if (gross > 0) {
    return {
      trigger: "LEVERAGE_BREACH",
      detail: `insolvent: equity ${capital.accountEquity} <= 0 with gross exposure ${capital.grossExposure}`,
    };
  }

  const h = health ?? {};
  if (h.marketDataStale)
    return { trigger: "MARKET_DATA_STALE", detail: "market data is stale" };
  if (h.recoveryFailure)
    return { trigger: "RECOVERY_FAILURE", detail: "state recovery failed" };
  if (h.journalIntegrityFailure)
    return { trigger: "JOURNAL_INTEGRITY_FAILURE", detail: "journal integrity failure" };
  if (h.exchangeConnectivityFailure)
    return { trigger: "EXCHANGE_CONNECTIVITY_FAILURE", detail: "exchange connectivity failure" };

  return null;
}
