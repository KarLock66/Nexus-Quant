/**
 * Position model (Phase 6) — a pure, event-sourced net position per symbol.
 *
 * `applyFill` is the single reducer covering the whole state machine:
 *   OPEN   (flat -> directional)      avg = fill price; no realized PnL
 *   ADD    (same side)                avg = qty-weighted average cost basis
 *   REDUCE (opposing, smaller)        realize PnL on the closed qty; basis unchanged
 *   CLOSE  (opposing, equal)          realize PnL; back to flat (basis reset)
 *   FLIP   (opposing, larger)         realize PnL on the whole prior qty; open the
 *                                     remainder at the fill price (new basis)
 *
 * Realized PnL on a closed quantity q at price p against basis a is
 *   q * (p - a) * sign(priorNetQty)
 * (a LONG profits when p > a; a SHORT profits when p < a). State is reconstructable
 * identically from the Fill stream alone (reconstructPosition), so deterministic
 * replay holds. Pure: no clock, no randomness, no IO; quantized at the border.
 */

import {
  parseDecimal,
  quantizeNotional,
  quantizePnl,
  quantizePrice,
  quantizeQty,
} from "./money.js";
import type { Fill, Position, PositionSide } from "./types.js";

/** Residual quantities at or below this magnitude are treated as exactly flat. */
const QTY_EPSILON = 1e-9;

/** An empty (flat) position on `symbol`. */
export function flatPosition(symbol: string): Position {
  return {
    symbol,
    netQty: quantizeQty(0),
    avgEntryPrice: quantizePrice(0),
    realizedPnl: quantizePnl(0),
    markPrice: quantizePrice(0),
  };
}

/** Directional state of a position (sign of net quantity). */
export function positionSide(p: Position): PositionSide {
  const q = parseDecimal(p.netQty);
  if (q > QTY_EPSILON) return "LONG";
  if (q < -QTY_EPSILON) return "SHORT";
  return "FLAT";
}

/** Signed quantity contributed by a fill (BUY increases net, SELL decreases). */
function signedFillQty(fill: Fill): number {
  const q = parseDecimal(fill.qty);
  return fill.side === "BUY" ? q : -q;
}

/**
 * Fold one Fill into a position. Pure: returns a NEW position, never mutates. The
 * fill's price becomes the position's latest mark (the value reconciliation and
 * unrealized PnL use).
 */
export function applyFill(p: Position, fill: Fill): Position {
  const cur = parseDecimal(p.netQty); // signed prior net
  const a = parseDecimal(p.avgEntryPrice);
  const price = parseDecimal(fill.price);
  let realized = parseDecimal(p.realizedPnl);
  const f = signedFillQty(fill);
  const next = cur + f;

  let avg = a;

  if (Math.abs(cur) <= QTY_EPSILON) {
    // OPEN — basis is the fill price.
    avg = price;
  } else if (Math.sign(cur) === Math.sign(f)) {
    // ADD — quantity-weighted average cost basis.
    avg = (Math.abs(cur) * a + Math.abs(f) * price) / (Math.abs(cur) + Math.abs(f));
  } else {
    // Opposing fill — REDUCE / CLOSE / FLIP. Realize PnL on the closed quantity.
    const closeQty = Math.min(Math.abs(f), Math.abs(cur));
    realized += closeQty * (price - a) * Math.sign(cur);
    if (Math.abs(f) < Math.abs(cur)) {
      avg = a; // REDUCE — basis of the remaining exposure is unchanged.
    } else if (Math.abs(f) > Math.abs(cur)) {
      avg = price; // FLIP — remainder opens fresh at the fill price.
    } else {
      avg = 0; // CLOSE — flat.
    }
  }

  const flat = Math.abs(next) <= QTY_EPSILON;
  return {
    symbol: p.symbol,
    netQty: quantizeQty(flat ? 0 : next),
    avgEntryPrice: quantizePrice(flat ? 0 : avg),
    realizedPnl: quantizePnl(realized),
    markPrice: quantizePrice(price),
  };
}

/**
 * Reconstruct a position from its Fill stream — proof that position state is a
 * deterministic, event-sourced fold (same fills, same order -> same position).
 */
export function reconstructPosition(
  fills: Fill[],
  seed?: Position,
): Position {
  const symbol = seed?.symbol ?? fills[0]?.symbol ?? "";
  return fills.reduce(applyFill, seed ?? flatPosition(symbol));
}

/**
 * Mark-to-market notional of a position: |netQty| * markPrice (2dp capital units).
 * Pass `mark` to value at a different reference price than the stored mark.
 */
export function positionNotional(p: Position, mark?: number): number {
  const m = mark ?? parseDecimal(p.markPrice);
  return Math.abs(parseDecimal(p.netQty)) * m;
}

/** As `positionNotional`, quantized to the canonical 2dp capital string. */
export function positionNotionalString(p: Position, mark?: number): string {
  return quantizeNotional(positionNotional(p, mark));
}

/**
 * Unrealized PnL of an open position at a mark: netQty * (mark - avgEntry). Uses
 * the position's stored mark when none is given. Flat positions have zero.
 */
export function unrealizedPnl(p: Position, mark?: number): number {
  const q = parseDecimal(p.netQty);
  if (Math.abs(q) <= QTY_EPSILON) return 0;
  const m = mark ?? parseDecimal(p.markPrice);
  return q * (m - parseDecimal(p.avgEntryPrice));
}

/** As `unrealizedPnl`, quantized to the canonical 2dp capital string. */
export function unrealizedPnlString(p: Position, mark?: number): string {
  return quantizePnl(unrealizedPnl(p, mark));
}
