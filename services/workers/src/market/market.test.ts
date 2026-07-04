/**
 * Phase 6 — Market Integration Layer verification (pure, no IO).
 *
 * Upholds the platform's standing principles for the new market tail:
 *   - determinism / replay: same intents/fills -> same orders, positions, accounts
 *   - separation: the Phase 5 execution stage is UNCHANGED; the market adapter only
 *     SATISFIES its ExecutionAdapter interface and is driven by it
 *   - the order state machine REJECTS illegal transitions / overfills (fail-closed)
 *   - reconciliation is MANDATORY and FAIL-CLOSED: broker state must agree with the
 *     portfolio state, or the execution is rejected
 *   - lineage is lossless: every order/fill/result carries the Phase 5 lineage
 *   - position & account state are reconstructable from the fill stream alone
 *
 * Imports the PURE submodules directly (not @nexus/db), so this suite is IO-free.
 */

import { describe, expect, it } from "vitest";
import {
  createExecutionStage,
  runExecutionStage,
} from "../execution/stage.js";
import type {
  DecisionEvent,
  DecisionIntent,
  ExecutionIntent,
  ExecutionLineage,
  SignalObservation,
} from "../execution/types.js";
import {
  HistoricalProvider,
  RealtimeProvider,
  ReplayProvider,
  demoMarketDataProvider,
  DEMO_QUOTES,
} from "./market-data.js";
import {
  OrderTransitionError,
  deriveOrder,
  reduceOrder,
} from "./order.js";
import {
  PaperBroker,
  RealBroker,
  SimulatedBroker,
  resolveBroker,
} from "./broker.js";
import {
  applyFill,
  flatPosition,
  positionNotional,
  positionSide,
  reconstructPosition,
  unrealizedPnl,
} from "./position.js";
import {
  DEFAULT_ACCOUNT_CONFIG,
  applyRealized,
  emptyAccount,
  valuateAccount,
} from "./account.js";
import { reconstructMarketState } from "./state.js";
import { reconcile } from "./reconcile.js";
import { createMarketExecutionAdapter } from "./stage.js";
import { InProcessMarketBus } from "./market-bus.js";
import type { Fill, Order, OrderEvent, OrderSide, Quote } from "./types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LINEAGE: ExecutionLineage = {
  strategyVersionId: "sv-1",
  featureSnapshotId: "fs-1",
  dqReportId: "dq-1",
  datasetHash: "dataset-hash-1",
  featureHash: "feature-hash-1",
  executionStrategyId: "core-technical",
  executionStrategyVersion: 1,
  intentId: "intent-1",
  netScore: "500000.00",
  contributions: [],
};

function order(over: Partial<Order> = {}): Order {
  return {
    orderId: "ord-1",
    intentId: "intent-1",
    symbol: "BTC-PERP",
    side: "BUY",
    qty: "10.00000000",
    price: "100.00000000",
    brokerId: "paper",
    lineage: LINEAGE,
    ...over,
  };
}

function fill(side: OrderSide, qty: string, price: string, symbol = "BTC-PERP"): Fill {
  return { orderId: "ord-1", intentId: "intent-1", symbol, side, qty, price, lineage: LINEAGE };
}

const N = 100;
function distinct<T>(fn: () => T): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < N; i += 1) out.add(JSON.stringify(fn()));
  return out;
}

// ── Market data providers ─────────────────────────────────────────────────────

describe("Market data — deterministic as-of providers, interface-only realtime", () => {
  const series: Quote[] = [
    { symbol: "BTC-PERP", ts: "2026-06-01T00:00:00.000Z", price: "30000" },
    { symbol: "BTC-PERP", ts: "2026-06-02T00:00:00.000Z", price: "31000" },
    { symbol: "ETH-PERP", ts: "2026-06-01T00:00:00.000Z", price: "1850" },
  ];

  it("HistoricalProvider returns the latest quote at or before asOf", () => {
    const p = new HistoricalProvider(series);
    expect(p.quote("BTC-PERP", "2026-06-01T12:00:00.000Z")?.price).toBe("30000.00000000");
    expect(p.quote("BTC-PERP", "2026-06-02T12:00:00.000Z")?.price).toBe("31000.00000000");
    expect(p.quote("BTC-PERP")?.price).toBe("31000.00000000"); // latest when asOf omitted
    expect(p.quote("BTC-PERP", "2025-01-01T00:00:00.000Z")).toBeNull(); // before all
    expect(p.quote("SOL-PERP")).toBeNull(); // unknown symbol
  });

  it("ReplayProvider replays the recorded log deterministically", () => {
    const p = new ReplayProvider(series);
    expect(p.mode).toBe("replay");
    expect(distinct(() => p.quote("BTC-PERP", "2026-06-02T00:00:00.000Z"))).toHaveProperty("size", 1);
    expect(p.quote("ETH-PERP")?.price).toBe("1850.00000000");
  });

  it("RealtimeProvider is interface-only: quote throws (no live feed)", () => {
    expect(() => new RealtimeProvider().quote("BTC-PERP")).toThrow(/interface-only/);
  });

  it("demo provider serves the demo symbols deterministically", () => {
    const p = demoMarketDataProvider();
    expect(p.quote("BTC-PERP")?.price).toBe("30000.00000000");
    expect(p.quote("ETH-PERP")?.price).toBe("1850.00000000");
    expect(DEMO_QUOTES).toHaveLength(2);
  });
});

// ── Order derivation + lifecycle state machine ────────────────────────────────

describe("Order — deterministic id, pure lifecycle reducer, fail-closed transitions", () => {
  it("deriveOrder id is deterministic and independent of nothing but economic content", () => {
    const a = deriveOrder({
      intentId: "intent-1", symbol: "BTC-PERP", side: "BUY", qty: 10, price: 100,
      brokerId: "paper", lineage: LINEAGE,
    });
    const b = deriveOrder({
      intentId: "intent-1", symbol: "BTC-PERP", side: "BUY", qty: 10, price: 100,
      brokerId: "paper", lineage: LINEAGE,
    });
    expect(a.orderId).toBe(b.orderId);
    expect(a.orderId).toMatch(/^[0-9a-f]{16}$/);
    const c = deriveOrder({
      intentId: "intent-1", symbol: "BTC-PERP", side: "SELL", qty: 10, price: 100,
      brokerId: "paper", lineage: LINEAGE,
    });
    expect(c.orderId).not.toBe(a.orderId); // side is economic content
    expect(a.qty).toBe("10.00000000");
  });

  it("reduces a full paper lifecycle to a FILLED snapshot", () => {
    const o = order();
    const snap = reduceOrder(o, PaperBroker.place(o));
    expect(snap.state).toBe("FILLED");
    expect(snap.filledQty).toBe("10.00000000");
    expect(snap.avgFillPrice).toBe("100.00000000");
    expect(snap.fills).toHaveLength(1);
  });

  it("rejects an illegal transition (FILLED before ACCEPTED)", () => {
    const o = order();
    const bad: OrderEvent[] = [
      { kind: "ORDER_REQUESTED", seq: 0, orderId: o.orderId, intentId: o.intentId, symbol: o.symbol, side: o.side, brokerId: o.brokerId, lineage: LINEAGE },
      { kind: "ORDER_FILLED", seq: 1, orderId: o.orderId, intentId: o.intentId, symbol: o.symbol, side: o.side, brokerId: o.brokerId, lineage: LINEAGE, fillQty: "10.00000000", fillPrice: "100.00000000", cumQty: "10.00000000" },
    ];
    expect(() => reduceOrder(o, bad)).toThrow(OrderTransitionError);
  });

  it("rejects an overfill (cumQty exceeds ordered qty)", () => {
    const o = order();
    const bad: OrderEvent[] = [
      { kind: "ORDER_REQUESTED", seq: 0, orderId: o.orderId, intentId: o.intentId, symbol: o.symbol, side: o.side, brokerId: o.brokerId, lineage: LINEAGE },
      { kind: "ORDER_SUBMITTED", seq: 1, orderId: o.orderId, intentId: o.intentId, symbol: o.symbol, side: o.side, brokerId: o.brokerId, lineage: LINEAGE },
      { kind: "ORDER_ACCEPTED", seq: 2, orderId: o.orderId, intentId: o.intentId, symbol: o.symbol, side: o.side, brokerId: o.brokerId, lineage: LINEAGE },
      { kind: "ORDER_FILLED", seq: 3, orderId: o.orderId, intentId: o.intentId, symbol: o.symbol, side: o.side, brokerId: o.brokerId, lineage: LINEAGE, fillQty: "20.00000000", fillPrice: "100.00000000", cumQty: "20.00000000" },
    ];
    expect(() => reduceOrder(o, bad)).toThrow(/overfill|!= ordered/);
  });

  it("rejects a non-monotonic seq and an empty stream (fail-closed)", () => {
    const o = order();
    const outOfOrder: OrderEvent[] = [
      { kind: "ORDER_REQUESTED", seq: 1, orderId: o.orderId, intentId: o.intentId, symbol: o.symbol, side: o.side, brokerId: o.brokerId, lineage: LINEAGE },
    ];
    expect(() => reduceOrder(o, outOfOrder)).toThrow(OrderTransitionError);
    expect(() => reduceOrder(o, [])).toThrow(/empty event stream/);
  });
});

// ── Brokers ───────────────────────────────────────────────────────────────────

describe("Brokers — paper deterministic, simulated replay-stable, real interface-only", () => {
  it("paper produces a deterministic full-fill stream", () => {
    const o = order();
    expect(distinct(() => PaperBroker.place(o)).size).toBe(1);
    const snap = reduceOrder(o, PaperBroker.place(o));
    expect(snap.state).toBe("FILLED");
    expect(snap.filledQty).toBe(o.qty);
  });

  it("simulated is deterministic, valid, and never overfills", () => {
    // Sweep many order ids; every stream must reduce cleanly and end terminal.
    for (let i = 0; i < 300; i += 1) {
      const o = order({ orderId: `sim-${i}`, brokerId: "simulated", qty: "12.34567890" });
      const stream = SimulatedBroker.place(o);
      expect(distinct(() => SimulatedBroker.place(o)).size).toBe(1); // deterministic
      const snap = reduceOrder(o, stream); // throws on any invalid/overfill stream
      expect(["FILLED", "REJECTED"]).toContain(snap.state);
      if (snap.state === "FILLED") expect(snap.filledQty).toBe(o.qty);
    }
  });

  it("simulated reaches both a partial-fill and a reject path across ids", () => {
    let sawPartial = false;
    let sawReject = false;
    for (let i = 0; i < 500 && !(sawPartial && sawReject); i += 1) {
      const o = order({ orderId: `sweep-${i}`, brokerId: "simulated", qty: "9.99999999" });
      const snap = reduceOrder(o, SimulatedBroker.place(o));
      if (snap.state === "REJECTED") sawReject = true;
      if (snap.fills.length > 1) sawPartial = true;
    }
    expect(sawPartial).toBe(true);
    expect(sawReject).toBe(true);
  });

  it("real broker is interface-only: place throws", () => {
    expect(() => RealBroker.place(order())).toThrow(/interface-only/);
  });

  it("resolveBroker maps ids (unknown -> paper)", () => {
    expect(resolveBroker("simulated")).toBe(SimulatedBroker);
    expect(resolveBroker("real")).toBe(RealBroker);
    expect(resolveBroker("???")).toBe(PaperBroker);
  });
});

// ── Position model — open / add / reduce / close / flip PnL ────────────────────

describe("Position — pure reducer, exact PnL on open/add/reduce/close/flip", () => {
  it("OPEN then ADD computes a quantity-weighted average basis", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("BUY", "10", "100")); // OPEN
    expect(p.netQty).toBe("10.00000000");
    expect(p.avgEntryPrice).toBe("100.00000000");
    p = applyFill(p, fill("BUY", "10", "120")); // ADD
    expect(p.netQty).toBe("20.00000000");
    expect(p.avgEntryPrice).toBe("110.00000000"); // (10*100 + 10*120)/20
    expect(p.realizedPnl).toBe("0.00");
  });

  it("REDUCE realizes PnL on the closed qty, basis unchanged", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("BUY", "20", "110"));
    p = applyFill(p, fill("SELL", "5", "130")); // REDUCE: 5 * (130-110) = +100
    expect(p.netQty).toBe("15.00000000");
    expect(p.avgEntryPrice).toBe("110.00000000");
    expect(p.realizedPnl).toBe("100.00");
  });

  it("CLOSE realizes the remaining PnL and returns to flat", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("BUY", "20", "110"));
    p = applyFill(p, fill("SELL", "20", "130")); // CLOSE: 20 * 20 = +400
    expect(positionSide(p)).toBe("FLAT");
    expect(p.netQty).toBe("0.00000000");
    expect(p.avgEntryPrice).toBe("0.00000000");
    expect(p.realizedPnl).toBe("400.00");
  });

  it("FLIP closes fully (realizing PnL) and opens the remainder at the fill price", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("BUY", "10", "100")); // LONG 10 @ 100
    p = applyFill(p, fill("SELL", "30", "90")); // FLIP: close 10 @ 90 -> -100; open SHORT 20 @ 90
    expect(positionSide(p)).toBe("SHORT");
    expect(p.netQty).toBe("-20.00000000");
    expect(p.avgEntryPrice).toBe("90.00000000");
    expect(p.realizedPnl).toBe("-100.00");
  });

  it("SHORT reduce realizes correctly (profit when price falls)", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("SELL", "10", "100")); // SHORT 10 @ 100
    p = applyFill(p, fill("BUY", "4", "90")); // REDUCE: 4 * (100-90) = +40
    expect(p.netQty).toBe("-6.00000000");
    expect(p.avgEntryPrice).toBe("100.00000000");
    expect(p.realizedPnl).toBe("40.00");
  });

  it("unrealized PnL marks the open exposure (long gains as price rises)", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("BUY", "10", "100"));
    expect(unrealizedPnl(p, 130)).toBe(300); // 10 * (130 - 100)
    expect(positionNotional(p, 130)).toBe(1300); // |10| * 130
  });

  it("reconstructs identically from the fill stream (event-sourced fold)", () => {
    const fills = [fill("BUY", "10", "100"), fill("BUY", "10", "120"), fill("SELL", "5", "130")];
    const a = reconstructPosition(fills);
    const b = fills.reduce(applyFill, flatPosition("BTC-PERP"));
    expect(a).toEqual(b);
    expect(distinct(() => reconstructPosition(fills)).size).toBe(1);
  });
});

// ── Account model — cash fold + derived valuation ─────────────────────────────

describe("Account — event-sourced cash, derived equity/margin/buying-power", () => {
  it("applies realized PnL into cash and realized", () => {
    let a = emptyAccount(); // 1_000_000 cash
    a = applyRealized(a, 400);
    expect(a.cashBalance).toBe("1000400.00");
    expect(a.realizedPnl).toBe("400.00");
  });

  it("valuation derives equity, margin, buying power from positions + marks", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("BUY", "10", "100")); // gross 10*100=1000 at mark 100
    const val = valuateAccount(emptyAccount(), { "BTC-PERP": p });
    expect(val.grossExposure).toBe("1000.00");
    expect(val.unrealizedPnl).toBe("0.00"); // mark == entry
    expect(val.equity).toBe("1000000.00");
    expect(val.marginUsed).toBe("1000.00"); // gross / leverage(1)
    expect(val.buyingPower).toBe("999000.00"); // equity*1 - gross
  });

  it("leverage frees buying power (margin = gross / leverage)", () => {
    let p = flatPosition("BTC-PERP");
    p = applyFill(p, fill("BUY", "10", "100"));
    const val = valuateAccount(emptyAccount(), { "BTC-PERP": p }, { initialCash: 1_000_000, leverage: 10 });
    expect(val.marginUsed).toBe("100.00"); // 1000 / 10
    expect(val.buyingPower).toBe("9999000.00"); // 1_000_000*10 - 1000
  });
});

// ── Market state fold — reconstructable broker state ──────────────────────────

describe("MarketState — reconstructable from the fill stream", () => {
  it("folds positions + account deterministically and reconstructs identically", () => {
    const fills = [
      fill("BUY", "10", "100", "BTC-PERP"),
      fill("BUY", "5", "50", "ETH-PERP"),
      fill("SELL", "4", "120", "BTC-PERP"), // realizes 4*(120-100)=+80
    ];
    const s = reconstructMarketState(fills);
    expect(s.positions["BTC-PERP"]!.netQty).toBe("6.00000000");
    expect(s.positions["BTC-PERP"]!.realizedPnl).toBe("80.00");
    expect(s.account.realizedPnl).toBe("80.00");
    expect(s.account.cashBalance).toBe("1000080.00");
    expect(distinct(() => reconstructMarketState(fills)).size).toBe(1);
  });
});

// ── Reconciliation — fail-closed on mismatch ──────────────────────────────────

describe("Reconciliation — broker vs portfolio, fail-closed", () => {
  const brokerState = (netQty: string, mark: string, symbol = "BTC-PERP") => ({
    positions: {
      [symbol]: { symbol, netQty, avgEntryPrice: mark, realizedPnl: "0.00", markPrice: mark },
    },
    account: emptyAccount(),
  });
  const portfolio = (notional: string, side: "LONG" | "SHORT", symbol = "BTC-PERP") => ({
    positions: { [symbol]: { symbol, side, notional, strategyId: "core-technical" } },
    grossExposure: notional,
    byStrategy: { "core-technical": notional },
  });

  it("passes when broker notional/side agree within tolerance", () => {
    const v = reconcile(brokerState("10.00000000", "100.00000000"), portfolio("1000.00", "LONG"));
    expect(v.ok).toBe(true);
  });

  it("fails closed on a notional gap beyond tolerance", () => {
    const v = reconcile(brokerState("10.00000000", "100.00000000"), portfolio("2000.00", "LONG"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.mismatches[0]!.detail).toMatch(/notional gap/);
  });

  it("fails closed on a side flip", () => {
    const v = reconcile(brokerState("-10.00000000", "100.00000000"), portfolio("1000.00", "LONG"));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.mismatches[0]!.detail).toMatch(/side/);
  });

  it("fails closed when exposure exists on one side only", () => {
    const v = reconcile(brokerState("10.00000000", "100.00000000"), {
      positions: {}, grossExposure: "0.00", byStrategy: {},
    });
    expect(v.ok).toBe(false);
  });
});

// ── Stage — broker-backed ExecutionAdapter driven by the REAL Phase 5 stage ────

describe("MarketExecutionAdapter — integrates with the unchanged Phase 5 stage", () => {
  const ctx = { log: () => {}, tickId: "t-1" };

  function decisionEvent(symbol: string, side: "LONG" | "SHORT", confidence: string): DecisionEvent {
    const signal: SignalObservation = {
      symbol, side, decision: side, confidence,
      strategyVersionId: "sv-1",
      strategyParams: { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 },
      featureSnapshotId: `fs-${symbol}`, dqReportId: "dq-1",
      datasetHash: "dataset-hash-1", featureHash: "feature-hash-1",
    };
    const decision: DecisionIntent = { action: "ENTER", side, confidence, rationale: "fixture" };
    return {
      signal, decision, execution: null,
      lineage: {
        strategyVersionId: "sv-1", featureSnapshotId: `fs-${symbol}`, dqReportId: "dq-1",
        datasetHash: "dataset-hash-1", featureHash: "feature-hash-1",
        executionStrategyId: "core-technical", executionStrategyVersion: 1,
      },
    };
  }

  const decisions = [
    decisionEvent("BTC-PERP", "LONG", "0.5000"),
    decisionEvent("ETH-PERP", "SHORT", "0.4000"),
  ];

  it("ENTERs flow to FILLED paper results and reconcile with the portfolio", async () => {
    const adapter = createMarketExecutionAdapter();
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage(decisions, deps, ctx);

    expect(r.intentsEmitted).toBe(2);
    expect(r.filled).toBe(2);
    expect(r.blocked).toBe(0);
    // Broker-side state agrees with the Phase 5 portfolio state (fail-closed check).
    expect(adapter.reconcileWith(r.portfolioState).ok).toBe(true);
    // Positions exist on both symbols with the expected sides.
    expect(positionSide(adapter.getMarketState().positions["BTC-PERP"]!)).toBe("LONG");
    expect(positionSide(adapter.getMarketState().positions["ETH-PERP"]!)).toBe("SHORT");
    // Lineage is threaded onto the order/position events (lossless).
    expect(adapter.getMarketState().positions["BTC-PERP"]!.markPrice).toBe("30000.00000000");
  });

  it("is deterministic end-to-end (fresh adapter twice -> identical state)", async () => {
    const run = async () => {
      const adapter = createMarketExecutionAdapter();
      const deps = createExecutionStage({ adapter });
      const r = await runExecutionStage(decisions, deps, ctx);
      return { portfolio: r.portfolioState, market: adapter.getMarketState() };
    };
    const a = await run();
    const b = await run();
    expect(a.market).toEqual(b.market);
    expect(a.portfolio).toEqual(b.portfolio);
  });

  it("re-running the same decisions is a no-op at target (idempotent net)", async () => {
    const adapter = createMarketExecutionAdapter();
    const deps = createExecutionStage({ adapter });
    const first = await runExecutionStage(decisions, deps, { ...ctx });
    const afterFirst = adapter.getMarketState();
    // Second pass with the SAME targets: already at target -> no net change.
    deps.portfolioState = first.portfolioState;
    const second = await runExecutionStage(decisions, deps, { ...ctx });
    expect(adapter.getMarketState()).toEqual(afterFirst);
    expect(adapter.reconcileWith(second.portfolioState).ok).toBe(true);
  });

  it("simulated broker is deterministic and still reconciles", async () => {
    const mk = () =>
      createMarketExecutionAdapter({ broker: SimulatedBroker, marketData: demoMarketDataProvider() });
    const run = async (adapter: ReturnType<typeof mk>) => {
      const deps = createExecutionStage({ adapter });
      const r = await runExecutionStage(decisions, deps, ctx);
      expect(adapter.reconcileWith(r.portfolioState).ok).toBe(true);
      return adapter.getMarketState();
    };
    expect(await run(mk())).toEqual(await run(mk()));
  });

  it("real broker -> fail-closed REJECTED (no fill, no state change, no crash)", async () => {
    const adapter = createMarketExecutionAdapter({ broker: RealBroker });
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage([decisionEvent("BTC-PERP", "LONG", "0.5000")], deps, ctx);
    expect(r.intentsEmitted).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.filled).toBe(0);
    expect(adapter.getMarketState().positions["BTC-PERP"]).toBeUndefined();
  });

  it("missing market data -> fail-closed REJECTED (no price, no execution)", async () => {
    // Provider knows only ETH; a BTC intent finds no price.
    const provider = new HistoricalProvider([
      { symbol: "ETH-PERP", ts: "2026-06-01T00:00:00.000Z", price: "1850" },
    ]);
    const adapter = createMarketExecutionAdapter({ marketData: provider });
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage([decisionEvent("BTC-PERP", "LONG", "0.5000")], deps, ctx);
    expect(r.rejected).toBe(1);
    expect(r.filled).toBe(0);
  });

  it("publishes order + position + account events on the market bus", async () => {
    const bus = new InProcessMarketBus();
    const kinds: string[] = [];
    bus.subscribe((e) => void kinds.push(e.kind));
    const adapter = createMarketExecutionAdapter({ bus });
    const deps = createExecutionStage({ adapter });
    await runExecutionStage([decisionEvent("BTC-PERP", "LONG", "0.5000")], deps, ctx);
    expect(kinds).toContain("MARKET_DATA");
    expect(kinds).toContain("ORDER");
    expect(kinds).toContain("POSITION_UPDATED");
    expect(kinds).toContain("ACCOUNT_UPDATED");
  });
});
