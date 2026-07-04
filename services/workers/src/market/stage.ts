/**
 * Market execution stage (Phase 6) — the broker-backed execution adapter.
 *
 * This is the SEAM: it SATISFIES the Phase 5 ExecutionAdapter interface
 * (execute(intent) -> ExecutionResult), so it drops into the UNCHANGED Phase 5
 * execution stage in place of the paper/simulated adapter — no Phase 1-5 code is
 * touched. Internally it runs the full market tail per intent:
 *
 *   ExecutionIntent
 *     -> quote (MarketDataProvider; fail-closed if no price)
 *     -> deriveOrder   (delta toward the intent's target net exposure)
 *     -> broker.place  (THE effectful edge -> ordered OrderEvent stream)
 *     -> reduceOrder   (pure order state machine; fail-closed on illegal stream)
 *     -> applyFill*    (event-sourced Position + Account; CANDIDATE, not committed)
 *     -> reconcile     (broker state vs the portfolio mirror; FAIL-CLOSED)
 *     -> commit + publish (only after reconciliation passes)
 *
 * It returns the FILLED/REJECTED ExecutionResult Phase 5 folds into PortfolioState,
 * and maintains an internal portfolio mirror that tracks exactly what Phase 5 will
 * record (same applyResult), so the broker-side and portfolio-side states are
 * reconciled BEFORE anything is committed. Fail-closed throughout: a missing price,
 * a broker throw, an illegal lifecycle stream, or a reconciliation mismatch yields
 * a REJECTED result and commits NO state (no phantom fill, no divergence, no crash).
 *
 * Pure with respect to its inputs apart from the deliberate effects of
 * broker.place and bus.publish; the order/position/account math is all pure and
 * deterministic, so replay determinism holds exactly as upstream.
 */

import { errMsg } from "../lib/log.js";
import type { ExecutionAdapter } from "../execution/adapters.js";
import {
  applyResult,
  emptyPortfolioState,
  type PortfolioState,
} from "../execution/portfolio.js";
import { parseDecimal } from "../execution/money.js";
import type {
  ExecutionIntent,
  ExecutionResult,
  ExecutionSide,
} from "../execution/types.js";
import {
  DEFAULT_ACCOUNT_CONFIG,
  valuateAccount,
  type AccountConfig,
} from "./account.js";
import { PaperBroker, type BrokerAdapter } from "./broker.js";
import type { MarketEventStore } from "./event-store.js";
import { InProcessMarketBus, type MarketBus } from "./market-bus.js";
import { demoMarketDataProvider, type MarketDataProvider } from "./market-data.js";
import { quantizeQty } from "./money.js";
import { deriveOrder, reduceOrder } from "./order.js";
import {
  flatPosition,
  positionNotionalString,
  positionSide,
} from "./position.js";
import {
  DEFAULT_RECONCILIATION_TOLERANCE,
  reconcile,
} from "./reconcile.js";
import { applyFillToMarketState, emptyMarketState } from "./state.js";
import type {
  AccountValuation,
  MarketState,
  OrderEvent,
  OrderSide,
  OrderSnapshot,
  ReconciliationVerdict,
} from "./types.js";

export interface CreateMarketExecutionAdapterOptions {
  broker?: BrokerAdapter;
  marketData?: MarketDataProvider;
  accountConfig?: AccountConfig;
  /** Absolute notional tolerance for broker<->portfolio reconciliation. */
  tolerance?: number;
  /** Market bus to publish order/position/account events to (observers). */
  bus?: MarketBus;
  /**
   * Phase 7 durability — OPT-IN, default-off. When provided, each COMMITTED
   * execution is appended to this append-only store BEFORE in-memory state
   * advances (journal-then-commit; a write failure rejects and commits nothing).
   * Omitted (every Phase 1-6 test + the default worker) preserves Phase 6 exactly.
   */
  eventStore?: MarketEventStore;
  /**
   * Phase 7 restart seeding — OPT-IN, default empty. The broker-side state and the
   * portfolio mirror to resume from (produced by recoverMarketState on boot), so a
   * restarted adapter continues from the reconstructed history rather than flat.
   */
  initialMarketState?: MarketState;
  initialPortfolioMirror?: PortfolioState;
}

/**
 * The market integration adapter. Holds the event-sourced BrokerState and a
 * portfolio mirror that tracks the Phase 5 PortfolioState, reconciling the two
 * before committing any fill.
 */
export class MarketExecutionAdapter implements ExecutionAdapter {
  readonly id: string;
  readonly bus: MarketBus;
  readonly broker: BrokerAdapter;
  readonly marketData: MarketDataProvider;

  private readonly accountConfig: AccountConfig;
  private readonly tolerance: number;
  /** Phase 7 durable journal (opt-in); undefined preserves Phase 6 behavior. */
  private readonly eventStore: MarketEventStore | undefined;
  private marketState: MarketState;
  /** Mirror of what Phase 5 will record from the results this adapter returns. */
  private portfolioMirror: PortfolioState;

  constructor(opts: CreateMarketExecutionAdapterOptions = {}) {
    this.broker = opts.broker ?? PaperBroker;
    this.marketData = opts.marketData ?? demoMarketDataProvider();
    this.accountConfig = opts.accountConfig ?? DEFAULT_ACCOUNT_CONFIG;
    this.tolerance = opts.tolerance ?? DEFAULT_RECONCILIATION_TOLERANCE;
    this.bus = opts.bus ?? new InProcessMarketBus();
    this.eventStore = opts.eventStore;
    this.id = `market:${this.broker.id}`;
    this.marketState = opts.initialMarketState ?? emptyMarketState(this.accountConfig);
    this.portfolioMirror = opts.initialPortfolioMirror ?? emptyPortfolioState();
  }

  /** The broker-side event-sourced state (positions + account). */
  getMarketState(): MarketState {
    return this.marketState;
  }

  /** The internal mirror of the Phase 5 portfolio state this adapter drives. */
  getPortfolioMirror(): PortfolioState {
    return this.portfolioMirror;
  }

  /** Derived account valuation at the current marks. */
  accountValuation(): AccountValuation {
    return valuateAccount(
      this.marketState.account,
      this.marketState.positions,
      this.accountConfig,
    );
  }

  /** Cross-check broker state against an external PortfolioState (e.g. Phase 5's). */
  reconcileWith(portfolio: PortfolioState): ReconciliationVerdict {
    return reconcile(this.marketState, portfolio, this.tolerance);
  }

  /** Build a fail-closed REJECTED result; commits NO state. */
  private reject(intent: ExecutionIntent, detail: string): ExecutionResult {
    return {
      intentId: intent.intentId,
      symbol: intent.symbol,
      side: intent.side,
      status: "REJECTED",
      adapterId: this.id,
      filledNotional: "0.00",
      detail,
      lineage: intent.lineage,
    };
  }

  async execute(intent: ExecutionIntent): Promise<ExecutionResult> {
    // 1) Reference price — fail-closed if the provider has none or throws (the
    //    realtime edge is interface-only, so a throw here is expected & contained).
    let price: number;
    let quoteTs: string;
    try {
      const quote = this.marketData.quote(intent.symbol);
      if (quote === null) return this.reject(intent, "no market data — no price, no execution");
      price = parseDecimal(quote.price);
      quoteTs = quote.ts;
      if (!(price > 0)) return this.reject(intent, `invalid reference price ${quote.price}`);
      await this.bus.publish({
        kind: "MARKET_DATA",
        quote,
        providerMode: this.marketData.mode,
      });
    } catch (err) {
      return this.reject(intent, `market data error: ${errMsg(err)}`);
    }

    // 2) Delta order: move the symbol from its current net toward the intent's
    //    target net exposure (target notional / price), naturally producing
    //    OPEN / ADD / REDUCE / FLIP depending on the current position.
    const target = parseDecimal(intent.targetNotional);
    const targetSignedQty = (intent.side === "LONG" ? 1 : -1) * (target / price);
    const prior = this.marketState.positions[intent.symbol] ?? flatPosition(intent.symbol);
    const currentSignedQty = parseDecimal(prior.netQty);
    const deltaSignedQty = targetSignedQty - currentSignedQty;
    const deltaQty = Math.abs(deltaSignedQty);

    // No-op: already at target within quantization — report the (unchanged) net.
    if (quantizeQty(deltaQty) === quantizeQty(0)) {
      const side: ExecutionSide = positionSide(prior) === "SHORT" ? "SHORT" : "LONG";
      const result: ExecutionResult = {
        intentId: intent.intentId,
        symbol: intent.symbol,
        side: positionSide(prior) === "FLAT" ? intent.side : side,
        status: "FILLED",
        adapterId: this.id,
        filledNotional: positionNotionalString(prior),
        detail: `already at target net (no-op) at ${quoteTs}`,
        lineage: intent.lineage,
      };
      this.portfolioMirror = applyResult(this.portfolioMirror, result);
      return result;
    }

    const orderSide: OrderSide = deltaSignedQty >= 0 ? "BUY" : "SELL";
    const order = deriveOrder({
      intentId: intent.intentId,
      symbol: intent.symbol,
      side: orderSide,
      qty: deltaQty,
      price,
      brokerId: this.broker.id,
      lineage: intent.lineage,
    });

    // 3) Broker lifecycle — the effectful edge. A throw (e.g. the real broker)
    //    becomes a fail-closed REJECTED result; no order can silently execute.
    let events: OrderEvent[];
    try {
      events = await this.broker.place(order);
    } catch (err) {
      return this.reject(intent, `broker error: ${errMsg(err)}`);
    }

    // 4) Fold the stream through the pure order state machine (fail-closed on any
    //    illegal transition or fill inconsistency).
    let snapshot: OrderSnapshot;
    try {
      snapshot = reduceOrder(order, events);
    } catch (err) {
      return this.reject(intent, `order lifecycle error: ${errMsg(err)}`);
    }

    // Publish the lifecycle for audit regardless of fill outcome.
    for (const event of events) {
      await this.bus.publish({ kind: "ORDER", event });
    }

    // 5) Apply fills to a CANDIDATE market state (not yet committed).
    let candidate = this.marketState;
    for (const fill of snapshot.fills) {
      candidate = applyFillToMarketState(candidate, fill);
    }

    // No fills (e.g. broker rejected) -> REJECTED, no state change.
    if (snapshot.fills.length === 0) {
      return this.reject(
        intent,
        `order ${snapshot.state.toLowerCase()} with no fills via ${this.broker.id}`,
      );
    }

    const candidatePos = candidate.positions[intent.symbol] ?? prior;
    const netSide = positionSide(candidatePos);
    const resultSide: ExecutionSide = netSide === "SHORT" ? "SHORT" : "LONG";
    const result: ExecutionResult = {
      intentId: intent.intentId,
      symbol: intent.symbol,
      side: netSide === "FLAT" ? intent.side : resultSide,
      status: "FILLED",
      adapterId: this.id,
      // Resulting net exposure marked to the fill price — the value Phase 5 records
      // and the value reconciliation recomputes from the position (equal by build).
      filledNotional: positionNotionalString(candidatePos),
      detail: `${snapshot.state} via ${this.broker.id} (${snapshot.fills.length} fill(s), avg ${snapshot.avgFillPrice})`,
      lineage: intent.lineage,
    };

    // 6) Candidate portfolio mirror (exactly what Phase 5 will record).
    const candidateMirror = applyResult(this.portfolioMirror, result);

    // 7) Reconcile broker state vs portfolio mirror — FAIL-CLOSED. A mismatch
    //    means the two derivations diverged: reject and commit NOTHING.
    const verdict = reconcile(candidate, candidateMirror, this.tolerance);
    if (!verdict.ok) {
      await this.bus.publish({ kind: "RECONCILIATION_FAILED", verdict });
      return this.reject(intent, `reconciliation failed: ${verdict.detail}`);
    }

    // 7b) DURABILITY (Phase 7, opt-in) — append the committed execution to the
    //     append-only journal BEFORE advancing in-memory state, so disk and memory
    //     move together. A write failure is fail-closed: reject and commit NOTHING
    //     (no in-memory advance past an un-journaled fill — restart stays exact).
    if (this.eventStore) {
      try {
        await this.eventStore.append({
          intentId: intent.intentId,
          symbol: intent.symbol,
          orderEvents: events,
          result,
          position: candidatePos,
          account: candidate.account,
        });
      } catch (err) {
        return this.reject(intent, `durable journal write failed: ${errMsg(err)}`);
      }
    }

    // 8) Commit + publish position/account updates.
    this.marketState = candidate;
    this.portfolioMirror = candidateMirror;
    await this.bus.publish({
      kind: "POSITION_UPDATED",
      position: candidatePos,
      lineage: intent.lineage,
    });
    await this.bus.publish({
      kind: "ACCOUNT_UPDATED",
      valuation: valuateAccount(candidate.account, candidate.positions, this.accountConfig),
    });

    return result;
  }
}

/** Build a market execution adapter with safe deterministic defaults (paper broker,
 *  demo market data). The result satisfies the Phase 5 ExecutionAdapter interface. */
export function createMarketExecutionAdapter(
  opts: CreateMarketExecutionAdapterOptions = {},
): MarketExecutionAdapter {
  return new MarketExecutionAdapter(opts);
}
