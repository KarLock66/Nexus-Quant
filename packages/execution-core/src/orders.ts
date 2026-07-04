/**
 * Order lifecycle — pure construction + deterministic transitions for a single order.
 *
 * Orders are created PLANNED and advance
 *   PLANNED → READY → SUBMITTED → ACKNOWLEDGED → PARTIALLY_FILLED → FILLED
 * with failure exits CANCELLED / REJECTED / EXPIRED / FAILED. Illegal transitions are
 * rejected (the order is returned unchanged). Prices are VERBATIM from the served levels;
 * this module never invents one.
 */

import { round } from "./util.js";
import type {
  ExecutionOrder,
  OrderRole,
  OrderSide,
  OrderStatus,
  OrderType,
  SignalDecision,
} from "./types.js";

/** Legal per-order transitions. Any (from → to) not listed is rejected. */
const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  NOT_CREATED: ["PLANNED", "REJECTED", "FAILED"],
  PLANNED: ["READY", "CANCELLED", "REJECTED", "EXPIRED", "FAILED"],
  READY: ["SUBMITTED", "CANCELLED", "REJECTED", "EXPIRED", "FAILED"],
  SUBMITTED: ["ACKNOWLEDGED", "REJECTED", "CANCELLED", "EXPIRED", "FAILED"],
  ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED", "FAILED"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "FAILED"],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** The side an order takes given the trade direction and the order's protective role. */
export function sideForRole(direction: SignalDecision, role: OrderRole): OrderSide {
  const long = direction === "LONG";
  if (role === "ENTRY") return long ? "BUY" : "SELL";
  // STOP + TARGET both close/reduce the position → opposite of entry.
  return long ? "SELL" : "BUY";
}

export interface MakeOrderArgs {
  orderId: string;
  planId: string;
  intentId: string;
  symbol: string;
  direction: SignalDecision;
  role: OrderRole;
  type: OrderType;
  price: number | null;
  quantity: number | null;
  now: number;
}

/** Construct one PLANNED order. Price/quantity are passed through VERBATIM (or null). */
export function makeOrder(a: MakeOrderArgs): ExecutionOrder {
  return {
    orderId: a.orderId,
    planId: a.planId,
    intentId: a.intentId,
    symbol: a.symbol,
    side: sideForRole(a.direction, a.role),
    role: a.role,
    type: a.type,
    price: a.price,
    quantity: a.quantity,
    status: "PLANNED",
    filledQuantity: 0,
    avgFillPrice: null,
    provenance: a.price === null ? "UNAVAILABLE" : "VERBATIM",
    reason: `${a.role} order planned`,
    createdAt: a.now,
    updatedAt: a.now,
  };
}

/**
 * Transition an order to `to` at injected time `at`. Returns a NEW order on success, or the
 * SAME order reference unchanged when the transition is illegal (caller detects the no-op by
 * reference/`status` equality).
 */
export function transitionOrder(
  order: ExecutionOrder,
  to: OrderStatus,
  at: number,
  reason?: string,
): ExecutionOrder {
  if (!canTransitionOrder(order.status, to)) return order;
  return { ...order, status: to, updatedAt: at, reason: reason ?? `→ ${to}` };
}

/**
 * Apply a fill quantity/price to an order, advancing it to PARTIALLY_FILLED or FILLED and
 * updating the volume-weighted average fill price. Pure; returns a NEW order. Over-fills are
 * clamped to the order quantity (fail-closed — never a negative remaining).
 */
export function applyFillToOrder(
  order: ExecutionOrder,
  price: number,
  quantity: number,
  at: number,
): ExecutionOrder {
  const target = order.quantity;
  const priorQty = order.filledQuantity;
  const addQty = Math.max(0, quantity);
  const newFilled = target === null ? priorQty + addQty : Math.min(target, priorQty + addQty);
  const actuallyAdded = newFilled - priorQty;

  const priorNotional = (order.avgFillPrice ?? 0) * priorQty;
  const avg = newFilled > 0 ? round((priorNotional + price * actuallyAdded) / newFilled, 8) : null;

  const complete = target !== null && newFilled >= target;
  const nextStatus: OrderStatus = complete ? "FILLED" : "PARTIALLY_FILLED";

  return {
    ...order,
    status: canTransitionOrder(order.status, nextStatus) ? nextStatus : order.status,
    filledQuantity: round(newFilled, 8),
    avgFillPrice: avg,
    updatedAt: at,
    reason: complete ? "order filled" : "order partially filled",
  };
}
