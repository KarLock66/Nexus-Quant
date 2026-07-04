/**
 * Broker abstraction (Phase 6) — the effectful market edge.
 *
 * A BrokerAdapter takes a deterministic Order and returns its ordered lifecycle as
 * an OrderEvent stream. Mirrors the Phase 5 ExecutionAdapter split exactly:
 *
 *   paper      — deterministic full fill at the order's reference price (no IO).
 *   simulated  — deterministic modeled execution: 1–3 partial fills with modeled
 *                adverse slippage, or an occasional venue reject — ALL derived from
 *                the orderId alone (FNV-1a), so the stream is a pure function of the
 *                order and is identical across runs (replay-stable). Never overfills.
 *   real       — INTERFACE ONLY: place() throws (no live venue wired). The stage
 *                treats a broker throw as a fail-closed REJECTED outcome.
 *
 * Brokers emit lifecycle events ONLY; they never touch position/account state.
 * The emitted stream always satisfies the order state machine (order.ts), so a
 * paper/simulated stream can never be rejected by the reducer.
 */

import { parseDecimal, quantizePrice, quantizeQty } from "./money.js";
import type { Order, OrderEvent, OrderEventKind, OrderSide } from "./types.js";

export interface BrokerAdapter {
  /** Stable broker identity, recorded on every order + result (paper|simulated|real). */
  readonly id: string;
  /**
   * Produce `order`'s lifecycle event stream. paper/simulated are PURE, synchronous
   * and deterministic functions of the order; real is effectful and throws. The
   * union return type supports both; callers await regardless.
   */
  place(order: Order): OrderEvent[] | Promise<OrderEvent[]>;
}

/** FNV-1a 32-bit hash — deterministic per-order draw (no clock, no randomness). */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Truncate a positive double to 8dp (floor) — keeps chunk sums from overshooting. */
function floor8(n: number): number {
  return Math.floor(n * 1e8) / 1e8;
}

/**
 * Build one lifecycle event, threading the order's identity + lineage verbatim.
 * Generic in the event kind so the literal is preserved (the discriminated union
 * narrows correctly when fill fields are spread on).
 */
function baseEvent<K extends OrderEventKind>(order: Order, kind: K, seq: number) {
  return {
    kind,
    seq,
    orderId: order.orderId,
    intentId: order.intentId,
    symbol: order.symbol,
    side: order.side,
    brokerId: order.brokerId,
    lineage: order.lineage,
  };
}

/** Adverse slippage: a BUY pays up, a SELL receives less (deterministic per fill). */
function slippedPrice(price: number, side: OrderSide, bps: number): number {
  const factor = side === "BUY" ? 1 + bps / 10_000 : 1 - bps / 10_000;
  return price * factor;
}

/** Deterministic, zero-impact full fill at the order's reference price. */
export const PaperBroker = {
  id: "paper",
  place(order: Order): OrderEvent[] {
    return [
      baseEvent(order, "ORDER_REQUESTED", 0),
      baseEvent(order, "ORDER_SUBMITTED", 1),
      baseEvent(order, "ORDER_ACCEPTED", 2),
      {
        ...baseEvent(order, "ORDER_FILLED", 3),
        fillQty: order.qty,
        fillPrice: order.price,
        cumQty: order.qty,
      },
    ];
  },
} satisfies BrokerAdapter;

/**
 * Deterministic simulation. Reject (~1 in 64) and the partial-fill schedule
 * (1–3 fills) + per-fill slippage (0–24 bps) are all derived from the orderId, so
 * the stream is a pure function of the order — identical across runs. The fill
 * quantities sum EXACTLY to the order quantity (the last fill takes the remainder),
 * so the order always completes with no overfill.
 */
export const SimulatedBroker = {
  id: "simulated",
  place(order: Order): OrderEvent[] {
    const requested = baseEvent(order, "ORDER_REQUESTED", 0);
    const submitted = baseEvent(order, "ORDER_SUBMITTED", 1);

    // Rare modeled venue reject (after submit, before accept) — a legal transition.
    if ((hash32(`${order.orderId}:reject`) & 0x3f) === 0) {
      return [
        requested,
        submitted,
        { ...baseEvent(order, "ORDER_REJECTED", 2), reason: "simulated venue reject" },
      ];
    }

    const accepted = baseEvent(order, "ORDER_ACCEPTED", 2);
    const qty = parseDecimal(order.qty);
    const price = parseDecimal(order.price);

    // 1–3 fills. Degenerate splits (a non-last chunk rounding to 0) collapse to a
    // single full fill, so every emitted fill has strictly positive quantity.
    let parts = 1 + (hash32(`${order.orderId}:parts`) % 3);
    const chunk = floor8(qty / parts);
    if (parts > 1 && !(chunk > 0)) parts = 1;

    const events: OrderEvent[] = [requested, submitted, accepted];
    let cum = 0;
    let seq = 3;
    for (let i = 0; i < parts; i += 1) {
      const last = i === parts - 1;
      const fq = last ? qty - cum : chunk;
      const bps = hash32(`${order.orderId}:slip:${i}`) % 25;
      const fillPrice = quantizePrice(slippedPrice(price, order.side, bps));
      cum += fq;
      const fill = {
        fillQty: quantizeQty(fq),
        fillPrice,
        cumQty: quantizeQty(cum),
      };
      events.push(
        last
          ? { ...baseEvent(order, "ORDER_FILLED", seq), ...fill }
          : { ...baseEvent(order, "ORDER_PARTIALLY_FILLED", seq), ...fill },
      );
      seq += 1;
    }
    return events;
  },
} satisfies BrokerAdapter;

/**
 * Real venue routing — the DEFAULT-OFF interface-only stub. With no transport
 * wired (this singleton), place() throws and the stage converts the throw into a
 * fail-closed REJECTED outcome, so an accidental wiring to `real` can never reach a
 * venue. resolveBroker("real") returns THIS stub — the real venue path is opt-in
 * exclusively via createRealBroker(transport), never by id resolution.
 */
export const RealBroker = {
  id: "real",
  place(_order: Order): OrderEvent[] {
    throw new Error(
      "RealBroker is interface-only — no live venue transport is wired (use createRealBroker)",
    );
  },
} satisfies BrokerAdapter;

/**
 * A live order-routing transport to a real venue (REST/WebSocket/FIX/vendor SDK),
 * injected into the real broker so the broker stays a thin, testable seam and the
 * clock/network/IO live entirely in the transport. It MUST map the venue's
 * acknowledgements and fills into the canonical OrderEvent stream (the same shape
 * paper/simulated emit), so the stage's pure reduceOrder validates a live stream
 * fail-closed exactly as it does a modeled one — no separate trust path for "real".
 */
export interface RealtimeOrderTransport {
  /** Route `order` to the venue; resolve with its lifecycle as canonical OrderEvents. */
  place(order: Order): Promise<OrderEvent[]>;
}

/**
 * Phase 7 — the REAL broker behind the unchanged BrokerAdapter abstraction. It
 * delegates the effectful routing to the injected transport and returns the venue
 * stream verbatim; the stage's reduceOrder is the single fail-closed validator of
 * that stream (a malformed venue response is rejected there, never silently
 * applied). DEFAULT-OFF: only constructed when a transport is explicitly wired, so
 * the deterministic path (paper/simulated) is untouched.
 */
export function createRealBroker(transport: RealtimeOrderTransport): BrokerAdapter {
  return {
    id: "real",
    place(order: Order): Promise<OrderEvent[]> {
      return transport.place(order);
    },
  };
}

/** Resolve a broker by id (defaults to paper for any unknown id). */
export function resolveBroker(id: string): BrokerAdapter {
  switch (id) {
    case "simulated":
      return SimulatedBroker;
    case "real":
      return RealBroker;
    default:
      return PaperBroker;
  }
}
