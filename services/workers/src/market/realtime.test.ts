/**
 * Phase 7 — Realtime connector layer verification (transport-injected, no live IO).
 *
 * RealtimeProvider and RealBroker become REAL behind the UNCHANGED MarketDataProvider
 * / BrokerAdapter abstractions, with the live edge isolated in an injected
 * transport. Verified here with in-memory transports:
 *   - default-OFF is preserved: no transport -> interface-only throw (unchanged)
 *   - with a transport, the provider returns the live mark and the broker routes the
 *     order, both behind the same interfaces the deterministic path uses
 *   - end-to-end, a realtime provider + realtime broker drive the UNCHANGED stage to
 *     FILLED results that reconcile and journal exactly like paper/simulated
 *   - the effectful edge stays fail-closed: a transport throw -> REJECTED, no state
 */

import { describe, expect, it } from "vitest";
import { createExecutionStage, runExecutionStage } from "../execution/stage.js";
import type {
  DecisionEvent,
  DecisionIntent,
  SignalObservation,
} from "../execution/types.js";
import {
  PaperBroker,
  RealBroker,
  createRealBroker,
  type RealtimeOrderTransport,
} from "./broker.js";
import {
  RealtimeProvider,
  type RealtimeQuoteTransport,
} from "./market-data.js";
import { InMemoryMarketEventStore } from "./event-store.js";
import { recoverMarketState } from "./recovery.js";
import { createMarketExecutionAdapter } from "./stage.js";
import type { ExecutionLineage, Order, Quote } from "./types.js";

const ctx = { log: () => {}, tickId: "p7-rt" };

const LINEAGE: ExecutionLineage = {
  strategyVersionId: "sv-1",
  featureSnapshotId: "fs-1",
  dqReportId: "dq-1",
  datasetHash: "dataset-hash-1",
  featureHash: "feature-hash-1",
  executionStrategyId: "core-technical",
  executionStrategyVersion: 1,
  intentId: "intent-rt",
  netScore: "500000.00",
  contributions: [],
};

const LIVE_QUOTES: Record<string, Quote> = {
  "BTC-PERP": { symbol: "BTC-PERP", ts: "2026-06-01T00:00:00.000Z", price: "31234.5" },
  "ETH-PERP": { symbol: "ETH-PERP", ts: "2026-06-01T00:00:00.000Z", price: "1888.25" },
};

const quoteTransport: RealtimeQuoteTransport = {
  latest: (symbol) => LIVE_QUOTES[symbol] ?? null,
};

/** A real order transport that maps to a deterministic venue (paper) for testing. */
const orderTransport: RealtimeOrderTransport = {
  place: async (order: Order) => PaperBroker.place(order),
};

function decisionEvent(
  symbol: string,
  side: "LONG" | "SHORT",
  confidence: string,
): DecisionEvent {
  const signal: SignalObservation = {
    symbol,
    side,
    decision: side,
    confidence,
    strategyVersionId: "sv-1",
    strategyParams: { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 },
    featureSnapshotId: `fs-${symbol}`,
    dqReportId: "dq-1",
    datasetHash: "dataset-hash-1",
    featureHash: "feature-hash-1",
  };
  const decision: DecisionIntent = { action: "ENTER", side, confidence, rationale: "fixture" };
  return {
    signal,
    decision,
    execution: null,
    lineage: {
      strategyVersionId: "sv-1",
      featureSnapshotId: `fs-${symbol}`,
      dqReportId: "dq-1",
      datasetHash: "dataset-hash-1",
      featureHash: "feature-hash-1",
      executionStrategyId: "core-technical",
      executionStrategyVersion: 1,
    },
  };
}

// ── RealtimeProvider ────────────────────────────────────────────────────────────

describe("RealtimeProvider — interface-only by default, real with a transport", () => {
  it("throws interface-only when NO transport is wired (default-off preserved)", () => {
    expect(() => new RealtimeProvider().quote("BTC-PERP")).toThrow(/interface-only/);
  });

  it("returns the transport's latest mark, normalized to 8dp", () => {
    const provider = new RealtimeProvider(quoteTransport);
    expect(provider.quote("BTC-PERP")).toEqual({
      symbol: "BTC-PERP",
      ts: "2026-06-01T00:00:00.000Z",
      price: "31234.50000000",
    });
    expect(provider.mode).toBe("realtime");
  });

  it("returns null (fail-closed at the caller) when the feed has no quote yet", () => {
    const provider = new RealtimeProvider(quoteTransport);
    expect(provider.quote("XRP-PERP")).toBeNull();
  });
});

// ── RealBroker ──────────────────────────────────────────────────────────────────

describe("RealBroker — interface-only singleton, real via createRealBroker", () => {
  function order(): Order {
    return {
      orderId: "ord-rt",
      intentId: "intent-rt",
      symbol: "BTC-PERP",
      side: "BUY",
      qty: "1.00000000",
      price: "31234.50000000",
      brokerId: "real",
      lineage: LINEAGE,
    };
  }

  it("the interface-only singleton still throws (resolveBroker('real') path)", () => {
    expect(() => RealBroker.place(order())).toThrow(/interface-only/);
  });

  it("createRealBroker routes the order through the injected transport", async () => {
    const broker = createRealBroker(orderTransport);
    expect(broker.id).toBe("real");
    const events = await broker.place(order());
    expect(events[events.length - 1]!.kind).toBe("ORDER_FILLED");
  });
});

// ── End-to-end: realtime provider + realtime broker drive the unchanged stage ──

describe("Realtime connectors — end-to-end behind the unchanged abstractions", () => {
  const decisions = [
    decisionEvent("BTC-PERP", "LONG", "0.5000"),
    decisionEvent("ETH-PERP", "SHORT", "0.4000"),
  ];

  it("FILLED results reconcile and journal exactly like the deterministic path", async () => {
    const store = new InMemoryMarketEventStore();
    const adapter = createMarketExecutionAdapter({
      marketData: new RealtimeProvider(quoteTransport),
      broker: createRealBroker(orderTransport),
      eventStore: store,
    });
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage(decisions, deps, ctx);

    expect(r.filled).toBe(2);
    expect(adapter.reconcileWith(r.portfolioState).ok).toBe(true);
    // The realtime mark flows through to the position mark (lossless).
    expect(adapter.getMarketState().positions["BTC-PERP"]!.markPrice).toBe("31234.50000000");
    // And the run is durable + reconstructable, same as paper/simulated.
    const recovered = await recoverMarketState(store);
    expect(recovered.marketState).toEqual(adapter.getMarketState());
  });

  it("a transport throw is fail-closed REJECTED (no fill, no state, no crash)", async () => {
    const flaky: RealtimeOrderTransport = {
      place: async () => {
        throw new Error("venue unreachable");
      },
    };
    const adapter = createMarketExecutionAdapter({
      marketData: new RealtimeProvider(quoteTransport),
      broker: createRealBroker(flaky),
    });
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage([decisionEvent("BTC-PERP", "LONG", "0.5")], deps, ctx);
    expect(r.rejected).toBe(1);
    expect(r.filled).toBe(0);
    expect(adapter.getMarketState().positions["BTC-PERP"]).toBeUndefined();
  });
});
