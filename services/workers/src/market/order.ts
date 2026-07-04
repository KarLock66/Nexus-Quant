/**
 * Order model + lifecycle state machine (Phase 6).
 *
 * `deriveOrder` is the PURE seam from a risk-approved ExecutionIntent + a
 * reference price to a broker Order. The orderId is a deterministic hash of the
 * order's economic content + lineage and EXCLUDES any clock/tick, so the same
 * (intent, price, side, qty, broker) reproduce the same order id forever — exactly
 * the replay discipline ExecutionIntent.intentId follows.
 *
 * `reduceOrder` is the PURE, event-sourced order state machine: it folds an
 * ordered OrderEvent stream into an OrderSnapshot, enforcing the legal transition
 * table and the fill invariants (monotonic seq, no overfill, FILLED iff fully
 * filled). Any illegal transition or fill inconsistency FAILS CLOSED (throws
 * OrderTransitionError) — a malformed broker stream can never silently corrupt
 * position/account state.
 */

import { createHash } from "node:crypto";
import { parseDecimal, quantizePrice, quantizeQty } from "./money.js";
import type {
  ExecutionLineage,
  Fill,
  Order,
  OrderEvent,
  OrderEventKind,
  OrderSide,
  OrderSnapshot,
  OrderState,
} from "./types.js";

/** Thrown by the order reducer on any illegal transition or fill inconsistency. */
export class OrderTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderTransitionError";
  }
}

/** Deterministic 16-hex id over canonical sorted key/values (same as intent.ts). */
function deterministicId(parts: Record<string, string | number>): string {
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export interface DeriveOrderInput {
  intentId: string;
  symbol: string;
  side: OrderSide;
  /** Absolute order quantity (> 0). */
  qty: number;
  /** Reference price the order is sized against (> 0). */
  price: number;
  brokerId: string;
  lineage: ExecutionLineage;
}

/**
 * Build the deterministic Order for one (intent, price, side, qty, broker). Pure:
 * no clock, no randomness. Quantizes qty/price to the canonical 8dp strings so the
 * id and the order serialize byte-identically across runs.
 */
export function deriveOrder(input: DeriveOrderInput): Order {
  const qty = quantizeQty(input.qty);
  const price = quantizePrice(input.price);
  const orderId = deterministicId({
    intentId: input.intentId,
    symbol: input.symbol,
    side: input.side,
    qty,
    price,
    brokerId: input.brokerId,
  });
  return {
    orderId,
    intentId: input.intentId,
    symbol: input.symbol,
    side: input.side,
    qty,
    price,
    brokerId: input.brokerId,
    lineage: input.lineage,
  };
}

// ── Lifecycle state machine ───────────────────────────────────────────────────

/** Pseudo-state before the first event is applied. */
const START = "START" as const;
type ReducerState = OrderState | typeof START;

/** Which lifecycle state each event kind transitions the order INTO. */
const STATE_OF: Record<OrderEventKind, OrderState> = {
  ORDER_REQUESTED: "REQUESTED",
  ORDER_SUBMITTED: "SUBMITTED",
  ORDER_ACCEPTED: "ACCEPTED",
  ORDER_PARTIALLY_FILLED: "PARTIALLY_FILLED",
  ORDER_FILLED: "FILLED",
  ORDER_CANCELLED: "CANCELLED",
  ORDER_REJECTED: "REJECTED",
};

/** Legal predecessor states for each target state (the transition table). */
const LEGAL_FROM: Record<OrderState, ReducerState[]> = {
  REQUESTED: [START],
  SUBMITTED: ["REQUESTED"],
  ACCEPTED: ["SUBMITTED"],
  PARTIALLY_FILLED: ["ACCEPTED", "PARTIALLY_FILLED"],
  FILLED: ["ACCEPTED", "PARTIALLY_FILLED"],
  CANCELLED: ["REQUESTED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"],
  REJECTED: ["REQUESTED", "SUBMITTED", "ACCEPTED"],
};

const TERMINAL: ReadonlySet<OrderState> = new Set(["FILLED", "CANCELLED", "REJECTED"]);

function isFillEvent(
  e: OrderEvent,
): e is Extract<OrderEvent, { kind: "ORDER_PARTIALLY_FILLED" | "ORDER_FILLED" }> {
  return e.kind === "ORDER_PARTIALLY_FILLED" || e.kind === "ORDER_FILLED";
}

/**
 * Fold an ordered OrderEvent stream into the terminal OrderSnapshot. Fail-closed:
 * out-of-order seq, an illegal transition, a fill past the ordered quantity, a
 * cumQty that disagrees with the running total, or a FILLED that is not a complete
 * fill all throw OrderTransitionError. `orderedQty` is the order's total size.
 */
export function reduceOrder(
  order: Pick<Order, "orderId" | "symbol" | "side" | "qty">,
  events: OrderEvent[],
): OrderSnapshot {
  const orderedQty = parseDecimal(order.qty);
  let state: ReducerState = START;
  let filled = 0;
  const fills: Fill[] = [];

  events.forEach((e, i) => {
    if (e.seq !== i) {
      throw new OrderTransitionError(
        `order ${order.orderId}: event ${i} has seq ${e.seq} (expected ${i}) — non-monotonic stream`,
      );
    }
    if (e.orderId !== order.orderId) {
      throw new OrderTransitionError(
        `order ${order.orderId}: event ${i} belongs to order ${e.orderId}`,
      );
    }
    const next = STATE_OF[e.kind];
    if (TERMINAL.has(state as OrderState)) {
      throw new OrderTransitionError(
        `order ${order.orderId}: event ${e.kind} after terminal state ${state}`,
      );
    }
    if (!LEGAL_FROM[next].includes(state)) {
      throw new OrderTransitionError(
        `order ${order.orderId}: illegal transition ${state} -> ${next} (${e.kind})`,
      );
    }

    if (isFillEvent(e)) {
      const fq = parseDecimal(e.fillQty);
      const cum = parseDecimal(e.cumQty);
      if (!(fq > 0)) {
        throw new OrderTransitionError(`order ${order.orderId}: non-positive fillQty ${e.fillQty}`);
      }
      // cumQty must equal the running total (fills are internally consistent).
      const expectedCum = quantizeQty(filled + fq);
      if (quantizeQty(cum) !== expectedCum) {
        throw new OrderTransitionError(
          `order ${order.orderId}: cumQty ${e.cumQty} != running ${expectedCum}`,
        );
      }
      // No overfill, ever.
      if (cum > orderedQty + 1e-9) {
        throw new OrderTransitionError(
          `order ${order.orderId}: cumQty ${e.cumQty} exceeds ordered ${order.qty} (overfill)`,
        );
      }
      // FILLED iff complete; PARTIALLY_FILLED iff strictly short of complete.
      const complete = Math.abs(cum - orderedQty) <= 1e-9;
      if (e.kind === "ORDER_FILLED" && !complete) {
        throw new OrderTransitionError(
          `order ${order.orderId}: ORDER_FILLED at cumQty ${e.cumQty} != ordered ${order.qty}`,
        );
      }
      if (e.kind === "ORDER_PARTIALLY_FILLED" && complete) {
        throw new OrderTransitionError(
          `order ${order.orderId}: ORDER_PARTIALLY_FILLED completes the order (use ORDER_FILLED)`,
        );
      }
      filled += fq;
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

    state = next;
  });

  if (state === START) {
    throw new OrderTransitionError(`order ${order.orderId}: empty event stream`);
  }

  // Quantity-weighted average fill price over the realized fills.
  let notional = 0;
  for (const f of fills) notional += parseDecimal(f.qty) * parseDecimal(f.price);
  const avgFillPrice = filled > 0 ? quantizePrice(notional / filled) : quantizePrice(0);

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    orderedQty: quantizeQty(orderedQty),
    state: state as OrderState,
    filledQty: quantizeQty(filled),
    avgFillPrice,
    fills,
    events,
  };
}
