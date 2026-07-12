/**
 * Risk state recovery (Phase 8, Deliverable 7) — restart reconstruction.
 *
 * On boot, the risk event journal (events.ts) is replayed through the SAME pure fold
 * the live engine uses (reconstructRiskState, state.ts) to rebuild the entire
 * RiskControlState from event history ALONE:
 *
 *   recoveredRiskState  ==  riskStateBeforeShutdown
 *
 * Because the fold is deterministic and the engine applied exactly it to each record
 * as it journaled, the recovered state is byte-identical to the state that wrote the
 * journal — the halt status (and its trigger), the daily-PnL baseline, the drawdown
 * high-water-mark, and the audit counters all survive a restart with NO hidden
 * in-process state and NO automatic recovery (a halt stays halted until explicit reset).
 *
 * FAIL-CLOSED: a structurally corrupt journal makes the store's readAll throw
 * (RiskJournalCorruptionError) — including any parseable-but-malformed record caught
 * by the per-record admission boundary (events.ts assertValidRiskJournalRecord,
 * Phase 11C Stage 2: unknown event type, malformed capital snapshot, unknown
 * trigger). Recovery surfaces it as a RiskRecoveryError so the worker can engage the
 * kill switch (JOURNAL_INTEGRITY_FAILURE) rather than arm trading against a state it
 * cannot prove — in particular, a damaged halt record now halts recovery instead of
 * silently clearing the halt.
 */

import type { RiskEventStore } from "./events.js";
import { reconstructRiskState } from "./state.js";
import type { RiskControlState } from "./types.js";

/** Thrown when the risk journal cannot be replayed into a consistent state — halts. */
export class RiskRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskRecoveryError";
  }
}

export interface RecoveredRiskState {
  state: RiskControlState;
  recordsReplayed: number;
}

/**
 * Replay the risk journal into the reconstructed control state. Pure with respect to
 * the store's contents (no clock, no randomness) — it only reads and folds. Any read
 * error (structural corruption) is re-thrown as a RiskRecoveryError (fail-closed).
 */
export async function recoverRiskState(
  store: RiskEventStore,
): Promise<RecoveredRiskState> {
  let records;
  try {
    records = await store.readAll();
  } catch (err) {
    throw new RiskRecoveryError(
      `risk journal unreadable — cannot reconstruct risk state: ${(err as Error).message}`,
    );
  }
  return { state: reconstructRiskState(records), recordsReplayed: records.length };
}
