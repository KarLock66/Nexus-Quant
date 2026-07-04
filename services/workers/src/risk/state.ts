/**
 * RiskControlState fold (Phase 8) — the deterministic projection of the risk event
 * journal that the live engine and the restart-recovery share (same discipline as the
 * market state fold reused by Phase 7 recovery).
 *
 * The state is a PURE fold over RiskJournalRecords:
 *   - halt status is projected from KILL_SWITCH_TRIGGERED / TRADING_HALTED (engage)
 *     and TRADING_RESUMED (the only clear) — so the halt SURVIVES a restart and is
 *     cleared only by an explicit reset, with NO automatic recovery
 *   - the session baseline equity (first observed) and the high-water-mark equity
 *     (max observed) are folded from each record's capital snapshot — so daily PnL
 *     and drawdown are reconstructable from the journal ALONE (no in-memory-only state)
 *   - passed / failed check counters are folded for audit
 *
 * Because the live engine applies EXACTLY this fold to each record as it journals it,
 * a recovered state (recovery.ts replays reconstructRiskState over the same records)
 * is byte-identical to the live state that wrote the journal.
 */

import { parseDecimal, quantizePnl } from "./money.js";
import type { KillSwitchTrigger, RiskControlState, RiskJournalRecord } from "./types.js";

/** The empty pre-history state: not halted, no baseline, no observations. */
export function initialRiskControlState(): RiskControlState {
  return {
    halted: false,
    trigger: null,
    haltDetail: null,
    haltedAtSeq: null,
    baselineEquity: null,
    peakEquity: null,
    checksPassed: 0,
    checksFailed: 0,
  };
}

/** Parse a record's trigger string back to the typed union (MANUAL for operator halts). */
function asHaltCause(record: RiskJournalRecord): KillSwitchTrigger | "MANUAL" {
  return record.trigger ?? "MANUAL";
}

/**
 * Fold one record into the state. Pure: returns a NEW state, never mutates. Equity
 * is observed from the record's capital snapshot (baseline = first seen, peak = max
 * seen), so the daily-PnL baseline and drawdown high-water-mark are journal-derived.
 */
export function applyRiskRecord(
  state: RiskControlState,
  record: RiskJournalRecord,
): RiskControlState {
  let { baselineEquity, peakEquity } = state;
  if (record.capital !== null) {
    const equity = parseDecimal(record.capital.accountEquity);
    if (baselineEquity === null) baselineEquity = quantizePnl(equity);
    const priorPeak = peakEquity === null ? -Infinity : parseDecimal(peakEquity);
    if (equity > priorPeak) peakEquity = quantizePnl(equity);
  }

  let { halted, trigger, haltDetail, haltedAtSeq, checksPassed, checksFailed } = state;

  switch (record.type) {
    case "RISK_CHECK_PASSED":
      checksPassed += 1;
      break;
    case "RISK_CHECK_FAILED":
      // The umbrella "a pre-trade check failed" event counts the failed evaluation.
      checksFailed += 1;
      break;
    case "POSITION_LIMIT_BREACHED":
    case "LEVERAGE_LIMIT_BREACHED":
    case "DRAWDOWN_LIMIT_BREACHED":
      // Specific breach ANNOTATIONS (accompany an umbrella RISK_CHECK_FAILED on the
      // gate path, or a KILL_SWITCH_TRIGGERED on the global-trigger path) — they do
      // not separately count an evaluation, so checksFailed == failed gate checks.
      break;
    case "KILL_SWITCH_TRIGGERED":
    case "TRADING_HALTED":
      // Idempotent engage: the FIRST engaging record fixes the cause + seq; a
      // following TRADING_HALTED confirmation does not overwrite it.
      if (!halted) {
        halted = true;
        trigger = asHaltCause(record);
        haltDetail = record.detail;
        haltedAtSeq = record.seq;
      }
      break;
    case "TRADING_RESUMED":
      halted = false;
      trigger = null;
      haltDetail = null;
      haltedAtSeq = null;
      break;
    default: {
      const _never: never = record.type;
      void _never;
    }
  }

  return {
    halted,
    trigger,
    haltDetail,
    haltedAtSeq,
    baselineEquity,
    peakEquity,
    checksPassed,
    checksFailed,
  };
}

/**
 * Reconstruct the risk control state from a record stream — proof the state is a
 * deterministic, event-sourced fold (same records, same order -> same state). The
 * seed defaults to the empty pre-history state.
 */
export function reconstructRiskState(
  records: RiskJournalRecord[],
  seed: RiskControlState = initialRiskControlState(),
): RiskControlState {
  return records.reduce(applyRiskRecord, seed);
}
