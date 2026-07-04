/**
 * Market Integration Layer contracts (Phase 6).
 *
 * The effectful MARKET edge below the Phase 5 execution result. A risk-approved
 * ExecutionIntent (Phase 5) is turned into an Order; the Order's lifecycle (a
 * deterministic stream of OrderEvents) folds into event-sourced Position and
 * Account state, which is reconciled FAIL-CLOSED against the Phase 5
 * PortfolioState. Every artifact preserves the Phase 5 ExecutionLineage verbatim
 * (no link is ever dropped), and every model is a pure, reconstructable fold over
 * an event stream — so deterministic replay holds exactly as it does upstream.
 *
 * Decimal discipline (see money.ts): prices/quantities are 8dp strings, notionals
 * and PnL are 2dp strings; doubles are used only internally and quantized at the
 * border, so identical inputs serialize byte-identically.
 */

import type { ExecutionLineage, ExecutionSide } from "../execution/types.js";

export type { ExecutionLineage, ExecutionSide };

/** A position's directional state. FLAT carries no exposure. */
export type PositionSide = "LONG" | "SHORT" | "FLAT";

/** An order's directional action. BUY increases net qty; SELL decreases it. */
export type OrderSide = "BUY" | "SELL";

// ── Market data ───────────────────────────────────────────────────────────────

export type ProviderMode = "historical" | "replay" | "realtime";

/**
 * A point-in-time reference quote. `price` is the canonical mark the market layer
 * sizes orders against and marks positions to (8dp string). Minimal by design —
 * bid/ask/spread microstructure is a later concern; Phase 6 needs one mark.
 */
export interface Quote {
  symbol: string;
  /** ISO timestamp the quote describes (point-in-time). */
  ts: string;
  /** Reference price (quantized 8dp string). */
  price: string;
}

// ── Orders ──────────────────────────────────────────────────────────────────

/**
 * An order derived deterministically from an ExecutionIntent + a reference price.
 * `orderId` is a pure hash of the order's economic content + lineage (it EXCLUDES
 * any clock/tick), so the same intent + price reproduce the same order id forever
 * (replay-compatible, exactly like ExecutionIntent.intentId).
 */
export interface Order {
  orderId: string;
  /** The Phase 5 intent this order executes. */
  intentId: string;
  symbol: string;
  side: OrderSide;
  /** Quantity to fill (quantized 8dp string, always > 0). */
  qty: string;
  /** Reference price the order was sized against (quantized 8dp string). */
  price: string;
  /** Broker selected to execute the order (paper | simulated | real). */
  brokerId: string;
  /** Full Phase 5 lineage threaded verbatim (lossless provenance). */
  lineage: ExecutionLineage;
}

/** The seven canonical order lifecycle states (terminal: FILLED/CANCELLED/REJECTED). */
export type OrderState =
  | "REQUESTED"
  | "SUBMITTED"
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED";

/**
 * One lifecycle event for an order. A discriminated union over the seven states;
 * fill events carry the fill economics and the cumulative filled quantity. `seq`
 * is a per-order monotonic counter (0-based) fixing event order deterministically.
 */
export type OrderEvent =
  | OrderEventBase<"ORDER_REQUESTED">
  | OrderEventBase<"ORDER_SUBMITTED">
  | OrderEventBase<"ORDER_ACCEPTED">
  | (OrderEventBase<"ORDER_PARTIALLY_FILLED"> & OrderFillData)
  | (OrderEventBase<"ORDER_FILLED"> & OrderFillData)
  | (OrderEventBase<"ORDER_CANCELLED"> & { reason: string })
  | (OrderEventBase<"ORDER_REJECTED"> & { reason: string });

export type OrderEventKind = OrderEvent["kind"];

interface OrderEventBase<K extends string> {
  kind: K;
  /** Per-order monotonic sequence number (0-based), fixing deterministic order. */
  seq: number;
  orderId: string;
  intentId: string;
  symbol: string;
  side: OrderSide;
  brokerId: string;
  lineage: ExecutionLineage;
}

interface OrderFillData {
  /** This fill's quantity (quantized 8dp string, > 0). */
  fillQty: string;
  /** This fill's price (quantized 8dp string, includes any modeled slippage). */
  fillPrice: string;
  /** Cumulative filled quantity through this event (quantized 8dp string). */
  cumQty: string;
}

/** A realized fill extracted from a fill event — the unit positions/accounts fold. */
export interface Fill {
  orderId: string;
  intentId: string;
  symbol: string;
  side: OrderSide;
  /** Filled quantity (quantized 8dp string, > 0). */
  qty: string;
  /** Fill price (quantized 8dp string). */
  price: string;
  lineage: ExecutionLineage;
}

/**
 * The terminal projection of an order's event stream (pure fold). `state` is the
 * final lifecycle state; `filledQty` / `avgFillPrice` summarize the executed
 * portion; `fills` is the ordered list of realized fills (lossless).
 */
export interface OrderSnapshot {
  orderId: string;
  symbol: string;
  side: OrderSide;
  /** Ordered quantity (quantized 8dp string). */
  orderedQty: string;
  state: OrderState;
  /** Cumulative filled quantity (quantized 8dp string). */
  filledQty: string;
  /** Quantity-weighted average fill price (quantized 8dp string; 0 if no fill). */
  avgFillPrice: string;
  fills: Fill[];
  events: OrderEvent[];
}

// ── Positions ─────────────────────────────────────────────────────────────────

/**
 * Event-sourced net position on one symbol. `netQty` is SIGNED (positive = LONG,
 * negative = SHORT, 0 = FLAT); `avgEntryPrice` is the running cost basis of the
 * open exposure; `realizedPnl` accrues on every reduce/close/flip; `markPrice` is
 * the latest reference price the position has been marked to. Pure fold over Fills.
 */
export interface Position {
  symbol: string;
  /** Signed net quantity (quantized 8dp string; sign encodes side). */
  netQty: string;
  /** Cost basis of the currently-open exposure (quantized 8dp string; 0 if flat). */
  avgEntryPrice: string;
  /** Cumulative realized PnL on this symbol (quantized 2dp string; may be < 0). */
  realizedPnl: string;
  /** Latest mark the position has been valued at (quantized 8dp string). */
  markPrice: string;
}

// ── Account ───────────────────────────────────────────────────────────────────

/**
 * Event-sourced account. `cashBalance` and `realizedPnl` are the only stored
 * scalars (cash moves with realized PnL and fees); buying power, margin, equity,
 * and unrealized PnL are DERIVED from cash + positions + marks (see account.ts),
 * so the account is always internally consistent and reconstructable from the
 * fill stream alone.
 */
export interface Account {
  /** Free + committed capital, moved only by realized PnL and fees (2dp string). */
  cashBalance: string;
  /** Cumulative realized PnL across all symbols (2dp string; may be < 0). */
  realizedPnl: string;
}

/** Derived account valuation given the current positions and their marks. */
export interface AccountValuation {
  cashBalance: string;
  realizedPnl: string;
  unrealizedPnl: string;
  /** cash + unrealized PnL (2dp string). */
  equity: string;
  /** gross notional / leverage (2dp string). */
  marginUsed: string;
  /** equity * leverage - grossExposure (2dp string; may be < 0 if over-leveraged). */
  buyingPower: string;
  /** Sum of |position notional at mark| (2dp string). */
  grossExposure: string;
}

// ── Market state (the broker's event-sourced source of truth) ────────────────

/**
 * The market layer's event-sourced state: net positions per symbol + the account.
 * A pure fold over the Fill stream (reconstructPosition / reconstructAccount), so
 * it is reconstructable identically on replay and rebuilt on restart — the exact
 * discipline the Phase 5 PortfolioState follows. This is the "BrokerState" that
 * reconciliation checks against the PortfolioState.
 */
export interface MarketState {
  positions: Record<string, Position>;
  account: Account;
}

// ── Market bus event (the in-process market seam) ────────────────────────────

/** The discriminated event the in-process market bus carries (observers only). */
export type MarketStageEvent =
  | { kind: "MARKET_DATA"; quote: Quote; providerMode: ProviderMode }
  | { kind: "ORDER"; event: OrderEvent }
  | { kind: "POSITION_UPDATED"; position: Position; lineage: ExecutionLineage }
  | { kind: "ACCOUNT_UPDATED"; valuation: AccountValuation }
  | { kind: "RECONCILIATION_FAILED"; verdict: ReconciliationVerdict };

// ── Reconciliation ───────────────────────────────────────────────────────────

/** One symbol whose broker-side and portfolio-side exposure disagree. */
export interface ReconciliationMismatch {
  symbol: string;
  brokerNotional: string;
  brokerSide: PositionSide;
  portfolioNotional: string;
  portfolioSide: PositionSide;
  detail: string;
}

/**
 * The result of reconciling BrokerState against the Phase 5 PortfolioState. `ok`
 * is true only when EVERY symbol agrees within tolerance; any mismatch (or a
 * symbol present on one side but not the other) fails closed.
 */
export type ReconciliationVerdict =
  | { ok: true; checked: number }
  | { ok: false; checked: number; mismatches: ReconciliationMismatch[]; detail: string };
