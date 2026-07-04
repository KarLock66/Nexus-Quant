/**
 * Position lifecycle — pure derivation of net exposure from filled quantity.
 *
 * A position opens from the ENTRY order's filled quantity at its average fill price, then
 * reduces as protective (STOP / TARGET) orders fill, and CLOSES when net exposure reaches
 * zero. Quantity is SIGNED (+ long / − short). The protective stop/targets are carried
 * VERBATIM from the intent — this module never recomputes a level. Clock is injected.
 */

import { positionId as makePositionId, round } from "./util.js";
import type {
  ExecutionIntent,
  ExecutionPosition,
  PositionStatus,
  SignalDecision,
} from "./types.js";

function sign(direction: SignalDecision): number {
  return direction === "LONG" ? 1 : direction === "SHORT" ? -1 : 0;
}

/** A not-yet-open position placeholder for an intent (NONE). */
export function emptyPosition(intent: ExecutionIntent): ExecutionPosition {
  return {
    positionId: makePositionId(intent.intentId),
    intentId: intent.intentId,
    symbol: intent.symbol,
    direction: intent.direction,
    status: "NONE",
    quantity: 0,
    entryQuantity: 0,
    closedQuantity: 0,
    avgEntryPrice: null,
    stop: intent.stop,
    targets: intent.targets,
    openedAt: null,
    closedAt: null,
    provenance: intent.stop === null ? "UNAVAILABLE" : "VERBATIM",
  };
}

/**
 * Open (or add to) a position from a filled entry quantity. Signed net exposure follows the
 * intent direction; the average entry price is passed through from the order's VWAP.
 */
export function openPosition(
  intent: ExecutionIntent,
  filledQuantity: number,
  avgEntryPrice: number | null,
  at: number,
): ExecutionPosition {
  const qty = Math.max(0, round(filledQuantity, 8));
  const s = sign(intent.direction);
  const status: PositionStatus = qty > 0 ? "OPEN" : "OPENING";
  return {
    positionId: makePositionId(intent.intentId),
    intentId: intent.intentId,
    symbol: intent.symbol,
    direction: intent.direction,
    status,
    quantity: round(s * qty, 8),
    entryQuantity: qty,
    closedQuantity: 0,
    avgEntryPrice: avgEntryPrice === null ? null : round(avgEntryPrice, 8),
    stop: intent.stop,
    targets: intent.targets,
    openedAt: at,
    closedAt: null,
    provenance: intent.stop === null ? "UNAVAILABLE" : "VERBATIM",
  };
}

/**
 * Reduce an open position by `reduceQuantity`. Over-reduction is clamped to the remaining
 * exposure (fail-closed — never a negative or flipped position). CLOSES when nothing remains.
 */
export function reducePosition(
  position: ExecutionPosition,
  reduceQuantity: number,
  at: number,
): ExecutionPosition {
  const s = sign(position.direction);
  const add = Math.max(0, round(reduceQuantity, 8));
  const closed = Math.min(position.entryQuantity, round(position.closedQuantity + add, 8));
  const remaining = round(position.entryQuantity - closed, 8);
  const status: PositionStatus = remaining <= 0 ? "CLOSED" : "REDUCING";
  return {
    ...position,
    status,
    quantity: round(s * remaining, 8),
    closedQuantity: closed,
    closedAt: remaining <= 0 ? at : position.closedAt,
  };
}

/** Force-close a position (kill switch / manual close). Net exposure → 0, status CLOSED. */
export function closePosition(position: ExecutionPosition, at: number): ExecutionPosition {
  return {
    ...position,
    status: "CLOSED",
    quantity: 0,
    closedQuantity: position.entryQuantity,
    closedAt: at,
  };
}
