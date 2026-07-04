/**
 * Fill lifecycle — pure construction of an immutable fill record.
 *
 * A fill is a point-in-time event against an order. Its {@link FillStatus} is derived from
 * the parent order's cumulative quantity: FULL when the order is now complete, PARTIAL
 * otherwise, VOID when the fill carried no quantity (fail-closed — a zero fill is recorded,
 * never silently dropped, so the audit stays complete). The clock is injected; the id is
 * deterministic in (order, per-order fill sequence).
 */

import { fillId as makeFillId, round } from "./util.js";
import type { ExecutionFill, ExecutionOrder, FillStatus } from "./types.js";

export interface MakeFillArgs {
  order: ExecutionOrder;
  /** Per-order fill sequence (0-based) — deterministic id + replay order. */
  fillSeq: number;
  price: number;
  quantity: number;
  /** The parent order's cumulative filled quantity AFTER this fill (from applyFillToOrder). */
  cumulativeQuantity: number;
  at: number;
}

/**
 * Build one fill record for a fill already applied to its order. `cumulativeQuantity` is the
 * order's post-fill total, so FULL/PARTIAL is derived, never guessed.
 */
export function makeFill(a: MakeFillArgs): ExecutionFill {
  const qty = Math.max(0, a.quantity);
  const target = a.order.quantity;
  let status: FillStatus;
  if (qty <= 0) status = "VOID";
  else if (target !== null && a.cumulativeQuantity >= target) status = "FULL";
  else status = "PARTIAL";

  return {
    fillId: makeFillId(a.order.orderId, a.fillSeq),
    orderId: a.order.orderId,
    intentId: a.order.intentId,
    symbol: a.order.symbol,
    side: a.order.side,
    price: round(a.price, 8),
    quantity: round(qty, 8),
    status,
    cumulativeQuantity: round(a.cumulativeQuantity, 8),
    provenance: "DERIVED",
    ts: a.at,
  };
}

/** Count of fills already recorded against an order id — the next fill's sequence. */
export function nextFillSeq(fills: readonly ExecutionFill[], orderId: string): number {
  let n = 0;
  for (const f of fills) if (f.orderId === orderId) n++;
  return n;
}
