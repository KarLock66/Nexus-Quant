/**
 * Restart reconstruction + fail-closed recovery gate (Phase 7).
 *
 * On boot, the durable journal (event-store.ts) is replayed through the SAME pure
 * folds the live path uses to rebuild — from event history ALONE — the three
 * states Phase 6 kept only in memory:
 *
 *   Position State + Account State : reconstructMarketState(fills)      (state.ts)
 *   Portfolio State                : reconstructPortfolioState(results) (portfolio.ts)
 *
 * Because both are the existing deterministic folds over the recorded stream, a
 * recovered run is byte-identical to the run that wrote the journal — no Phase 6
 * fold is re-implemented here, only replayed.
 *
 * Recovery is FAIL-CLOSED on three independent checks; any one halts execution:
 *
 *   0. admission  — every journal record is structurally validated at read
 *                   (event-store.ts assertValidMarketJournalRecord, Phase 11C
 *                   Stage 2): a parseable-but-malformed record throws
 *                   JournalCorruptionError BEFORE any fold consumes it, instead
 *                   of crashing untyped or coercing silently.
 *   1. integrity  — the fold recomputed from the fills MUST equal the position /
 *                   account snapshots the journal recorded at commit time. A
 *                   mismatch means the log was tampered with or a record is
 *                   inconsistent (the fold and the snapshot disagree).
 *   2. reconcile  — the recovered broker state MUST reconcile with the recovered
 *                   portfolio state (the same fail-closed broker<->portfolio check
 *                   the stage runs per execution), proving the two independent
 *                   derivations still agree after a full replay.
 *
 * A throw here is the durability halt: the worker refuses to arm execution on an
 * unreconstructable or divergent history rather than trade against a state it
 * cannot prove (capital preservation > everything).
 */

import {
  DEFAULT_ACCOUNT_CONFIG,
  type AccountConfig,
} from "./account.js";
import type { MarketEventStore, MarketJournalRecord } from "./event-store.js";
import {
  DEFAULT_RECONCILIATION_TOLERANCE,
  reconcile,
} from "./reconcile.js";
import { reconstructMarketState } from "./state.js";
import {
  reconstructPortfolioState,
  type PortfolioState,
} from "../execution/portfolio.js";
import type { ExecutionResult } from "../execution/types.js";
import type { Account, Fill, MarketState, OrderEvent, Position } from "./types.js";

/** Thrown when reconstruction cannot prove a consistent state — halts execution. */
export class MarketRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketRecoveryError";
  }
}

/** The reconstructed, integrity-checked state used to seed the live adapter. */
export interface RecoveredMarketState {
  /** Broker-side positions + account, rebuilt from the fill stream alone. */
  marketState: MarketState;
  /** Phase 5 portfolio mirror, rebuilt from the ExecutionResult stream alone. */
  portfolioState: PortfolioState;
  recordsReplayed: number;
  fillsReplayed: number;
}

export interface RecoverOptions {
  accountConfig?: AccountConfig;
  /** Absolute notional tolerance for the broker<->portfolio reconcile gate. */
  tolerance?: number;
}

/** Lift realized fills from an order-event stream (same projection reduceOrder uses). */
function fillsFrom(events: OrderEvent[]): Fill[] {
  const fills: Fill[] = [];
  for (const e of events) {
    if (e.kind === "ORDER_PARTIALLY_FILLED" || e.kind === "ORDER_FILLED") {
      fills.push({
        orderId: e.orderId,
        intentId: e.intentId,
        symbol: e.symbol,
        side: e.side,
        qty: e.fillQty,
        price: e.fillPrice,
        lineage: e.lineage,
      });
    }
  }
  return fills;
}

/** Field-wise equality on the quantized (string) position projection. */
function samePosition(a: Position, b: Position): boolean {
  return (
    a.symbol === b.symbol &&
    a.netQty === b.netQty &&
    a.avgEntryPrice === b.avgEntryPrice &&
    a.realizedPnl === b.realizedPnl &&
    a.markPrice === b.markPrice
  );
}

/** Field-wise equality on the quantized (string) account scalar. */
function sameAccount(a: Account, b: Account): boolean {
  return a.cashBalance === b.cashBalance && a.realizedPnl === b.realizedPnl;
}

/**
 * INTEGRITY (fail-closed): the state recomputed from the fills must equal the
 * snapshots the journal recorded at commit. The last record overall fixes the
 * final account; the last record per symbol fixes that symbol's final position.
 */
function verifyAgainstSnapshots(
  records: MarketJournalRecord[],
  recomputed: MarketState,
): void {
  if (records.length === 0) return;

  const recordedAccount = records[records.length - 1]!.account;
  if (!sameAccount(recomputed.account, recordedAccount)) {
    throw new MarketRecoveryError(
      `account integrity mismatch: fold recomputed cash ${recomputed.account.cashBalance}/realized ${recomputed.account.realizedPnl} != journaled cash ${recordedAccount.cashBalance}/realized ${recordedAccount.realizedPnl}`,
    );
  }

  const lastPositionBySymbol = new Map<string, Position>();
  for (const record of records) lastPositionBySymbol.set(record.symbol, record.position);
  for (const [symbol, recorded] of lastPositionBySymbol) {
    const got = recomputed.positions[symbol];
    if (got === undefined || !samePosition(got, recorded)) {
      throw new MarketRecoveryError(
        `position integrity mismatch for ${symbol}: fold recomputed ${
          got ? JSON.stringify(got) : "<missing>"
        } != journaled ${JSON.stringify(recorded)}`,
      );
    }
  }
}

/**
 * Replay the durable journal into a recovered, integrity-checked state. Pure with
 * respect to the store's contents (no clock, no randomness) — it only reads and
 * folds. Throws MarketRecoveryError on any integrity or reconciliation mismatch.
 */
export async function recoverMarketState(
  store: MarketEventStore,
  opts: RecoverOptions = {},
): Promise<RecoveredMarketState> {
  const accountConfig = opts.accountConfig ?? DEFAULT_ACCOUNT_CONFIG;
  const tolerance = opts.tolerance ?? DEFAULT_RECONCILIATION_TOLERANCE;

  const records = await store.readAll();

  // 1) Rebuild broker Position + Account from the fill stream alone.
  const fills: Fill[] = [];
  for (const record of records) fills.push(...fillsFrom(record.orderEvents));
  const marketState = reconstructMarketState(fills, accountConfig);

  // 2) Rebuild the Phase 5 Portfolio mirror from the ExecutionResult stream alone.
  const results: ExecutionResult[] = records.map((r) => r.result);
  const portfolioState = reconstructPortfolioState(results);

  // 3) FAIL-CLOSED integrity: the recomputed fold must match the recorded snapshots.
  verifyAgainstSnapshots(records, marketState);

  // 4) FAIL-CLOSED reconcile: the two independent derivations must still agree.
  const verdict = reconcile(marketState, portfolioState, tolerance);
  if (!verdict.ok) {
    throw new MarketRecoveryError(
      `recovered broker<->portfolio reconciliation failed: ${verdict.detail}`,
    );
  }

  return {
    marketState,
    portfolioState,
    recordsReplayed: records.length,
    fillsReplayed: fills.length,
  };
}
