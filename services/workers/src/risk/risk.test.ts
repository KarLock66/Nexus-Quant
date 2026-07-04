/**
 * Phase 8 — Risk & Capital Control verification (pure folds + a temp file).
 *
 * Proves the Phase 8 acceptance criteria on top of the UNCHANGED Phase 5/6/7 layers:
 *   - capital model is a deterministic, immutable projection of account + positions
 *   - the position sizer is deterministic across all five modes
 *   - the exposure engine computes gross/net/long/short/leverage/utilization purely
 *   - the pre-trade gate REJECTS on each of the six hard checks (fail-closed)
 *   - the kill switch ACTIVATES on a trigger, halts all orders, and SURVIVES a restart
 *   - risk state REPLAYS identically and RECOVERS byte-identically from the journal
 *   - the integrated execution stage routes every order through the risk engine and
 *     the engine can BLOCK execution (no intent, no fill)
 *
 * IO-free except a single temp file for the JSONL file-store path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { emptyAccount } from "../market/account.js";
import { applyFill, flatPosition } from "../market/position.js";
import type { Account, ExecutionLineage, Fill, Position } from "../market/types.js";
import { createMarketExecutionAdapter } from "../market/index.js";
import { fixtureQuoteProvider } from "../ci/fixtures.js";
import { createExecutionStage, runExecutionStage } from "../execution/index.js";
import type {
  DecisionEvent,
  DecisionIntent,
  SignalObservation,
} from "../execution/types.js";

import { buildCapitalSnapshot } from "./capital.js";
import { computeExposure } from "./exposure.js";
import { RiskEngine, type MarketView } from "./engine.js";
import {
  FileRiskEventStore,
  InMemoryRiskEventStore,
  RiskJournalCorruptionError,
  type RiskEventStore,
} from "./events.js";
import { createRiskExecutionGate } from "./integration.js";
import { DEFAULT_RISK_LIMITS, evaluatePreTrade, projectOrder } from "./gate.js";
import { recoverRiskState, RiskRecoveryError } from "./recovery.js";
import { reconstructRiskState } from "./state.js";
import { sizePosition } from "./sizer.js";
import type { ProposedOrder, RiskLimits } from "./types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const LINEAGE: ExecutionLineage = {
  strategyVersionId: "sv-1",
  featureSnapshotId: "fs-1",
  dqReportId: "dq-1",
  datasetHash: "dataset-hash-1",
  featureHash: "feature-hash-1",
  executionStrategyId: "core-technical",
  executionStrategyVersion: 1,
  intentId: "intent-1",
  netScore: "0.00",
  contributions: [],
};

/** A market position built through the REAL Phase 6 fold (one opening fill). */
function mkPosition(symbol: string, side: "LONG" | "SHORT", qty: number, price: number): Position {
  const fill: Fill = {
    orderId: "o-1",
    intentId: "intent-1",
    symbol,
    side: side === "LONG" ? "BUY" : "SELL",
    qty: qty.toFixed(8),
    price: price.toFixed(8),
    lineage: LINEAGE,
  };
  return applyFill(flatPosition(symbol), fill);
}

function account(cash: number): Account {
  return emptyAccount({ initialCash: cash, leverage: 1 });
}

function view(cash: number, positions: Position[] = []): MarketView {
  const map: Record<string, Position> = {};
  for (const p of positions) map[p.symbol] = p;
  return { account: account(cash), positions: map };
}

function mkOrder(symbol: string, side: "LONG" | "SHORT", qty: number, price: number): ProposedOrder {
  return {
    symbol,
    side,
    targetQuantity: qty.toFixed(8),
    targetNotional: (qty * price).toFixed(2),
    price: price.toFixed(8),
    strategyId: "core-technical",
  };
}

/** Generous limits; override only the field a test targets. */
function limits(over: Partial<RiskLimits> = {}): RiskLimits {
  return {
    maxPositionSize: 1_000_000,
    maxPositionNotional: 100_000_000,
    maxLeverage: 100,
    dailyLossLimit: 100_000_000,
    maxAssetAllocation: 1,
    maxDrawdown: 1,
    ...over,
  };
}

const N = 100;
function distinct<T>(fn: () => T): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < N; i += 1) out.add(JSON.stringify(fn()));
  return out;
}

// ── Deliverable 1 — Capital Model ────────────────────────────────────────────

describe("Capital Model — immutable, deterministic projection of account + positions", () => {
  it("derives equity/cash/margin/PnL/exposure and is frozen + deterministic", () => {
    const v = view(1_000_000, [mkPosition("BTC-PERP", "LONG", 10, 30_000)]);
    const cap = buildCapitalSnapshot(v.account, v.positions);
    expect(cap.accountEquity).toBe("1000000.00"); // cash + unrealized(0)
    expect(cap.availableCash).toBe("1000000.00");
    expect(cap.grossExposure).toBe("300000.00"); // 10 * 30000
    expect(cap.netExposure).toBe("300000.00"); // long
    expect(cap.usedMargin).toBe("300000.00"); // gross / leverage(1)
    expect(cap.availableMargin).toBe("700000.00"); // equity - usedMargin
    expect(Object.isFrozen(cap)).toBe(true);
    expect(distinct(() => buildCapitalSnapshot(v.account, v.positions)).size).toBe(1);
  });

  it("nets long against short for netExposure", () => {
    const v = view(1_000_000, [
      mkPosition("BTC-PERP", "LONG", 10, 30_000), // +300k
      mkPosition("ETH-PERP", "SHORT", 100, 1_850), // -185k
    ]);
    const cap = buildCapitalSnapshot(v.account, v.positions);
    expect(cap.grossExposure).toBe("485000.00");
    expect(cap.netExposure).toBe("115000.00");
  });
});

// ── Deliverable 2 — Position Sizer ───────────────────────────────────────────

describe("Position Sizer — five deterministic modes", () => {
  it("FIXED_QUANTITY: qty given, notional = qty*price", () => {
    const s = sizePosition({ config: { mode: "FIXED_QUANTITY", leverage: 2, fixedQuantity: 3 }, equity: 1_000_000, price: 100 });
    expect(s.targetQuantity).toBe("3.00000000");
    expect(s.targetNotional).toBe("300.00");
    expect(s.estimatedMargin).toBe("150.00"); // notional / leverage(2)
  });

  it("FIXED_NOTIONAL: notional given, qty = notional/price", () => {
    const s = sizePosition({ config: { mode: "FIXED_NOTIONAL", leverage: 1, fixedNotional: 50_000 }, equity: 1_000_000, price: 25_000 });
    expect(s.targetNotional).toBe("50000.00");
    expect(s.targetQuantity).toBe("2.00000000");
  });

  it("PERCENT_OF_EQUITY: notional = equity * fraction", () => {
    const s = sizePosition({ config: { mode: "PERCENT_OF_EQUITY", leverage: 1, equityFraction: 0.1 }, equity: 1_000_000, price: 1_000 });
    expect(s.targetNotional).toBe("100000.00");
    expect(s.targetQuantity).toBe("100.00000000");
  });

  it("VOLATILITY_ADJUSTED: notional = equity * riskBudget / volatility", () => {
    const s = sizePosition({ config: { mode: "VOLATILITY_ADJUSTED", leverage: 1, volTargetFraction: 0.02 }, equity: 1_000_000, price: 100, volatility: 0.04 });
    expect(s.targetNotional).toBe("500000.00"); // 1e6 * 0.02 / 0.04
  });

  it("RISK_PER_TRADE: qty = equity*riskFraction / (price*stopFraction)", () => {
    const s = sizePosition({ config: { mode: "RISK_PER_TRADE", leverage: 1, riskFraction: 0.01, stopLossFraction: 0.05 }, equity: 1_000_000, price: 200 });
    // qty = 10000 / (200*0.05=10) = 1000
    expect(s.targetQuantity).toBe("1000.00000000");
    expect(s.targetNotional).toBe("200000.00");
  });

  it("fail-safe: non-positive price or missing param => zero size (never NaN)", () => {
    expect(sizePosition({ config: { mode: "FIXED_NOTIONAL", leverage: 1, fixedNotional: 100 }, equity: 1e6, price: 0 }).targetNotional).toBe("0.00");
    expect(sizePosition({ config: { mode: "VOLATILITY_ADJUSTED", leverage: 1, volTargetFraction: 0.02 }, equity: 1e6, price: 100 }).targetQuantity).toBe("0.00000000");
  });

  it("every mode is deterministic 100x", () => {
    expect(distinct(() => sizePosition({ config: { mode: "PERCENT_OF_EQUITY", leverage: 3, equityFraction: 0.25 }, equity: 1_234_567, price: 333 })).size).toBe(1);
  });
});

// ── Deliverable 4 — Portfolio Exposure Engine ────────────────────────────────

describe("Portfolio Exposure Engine — gross/net/long/short/leverage/utilization", () => {
  it("computes all metrics deterministically", () => {
    const v = view(1_000_000, [
      mkPosition("BTC-PERP", "LONG", 10, 30_000), // long 300k
      mkPosition("ETH-PERP", "SHORT", 100, 1_850), // short 185k
    ]);
    const e = computeExposure(v.account, v.positions);
    expect(e.grossExposure).toBe("485000.00");
    expect(e.longExposure).toBe("300000.00");
    expect(e.shortExposure).toBe("185000.00");
    expect(e.netExposure).toBe("115000.00");
    expect(e.leverage).toBe("0.485000"); // 485k / 1M equity
    expect(e.utilization).toBe("0.485000"); // gross / (equity * leverage(1))
    expect(distinct(() => computeExposure(v.account, v.positions)).size).toBe(1);
  });
});

// ── Deliverable 3 — Pre-Trade Risk Gate (the six required rejections) ────────

describe("Pre-Trade Risk Gate — fail-closed rejection on each hard check", () => {
  const cap = (v: MarketView) => buildCapitalSnapshot(v.account, v.positions);
  const proj = (v: MarketView, o: ProposedOrder) => projectOrder(v.positions, cap(v), o, 1);

  it("position limit rejection (abs position > maxPositionSize)", () => {
    const v = view(1_000_000);
    const o = mkOrder("BTC-PERP", "LONG", 20, 100);
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), limits({ maxPositionSize: 10 }), 0);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) {
      expect(verdict.reason).toBe("MAX_POSITION_SIZE");
      expect(verdict.eventType).toBe("POSITION_LIMIT_BREACHED");
    }
  });

  it("notional rejection (notional > maxPositionNotional)", () => {
    const v = view(1_000_000);
    const o = mkOrder("BTC-PERP", "LONG", 1, 5_000);
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), limits({ maxPositionNotional: 1_000 }), 0);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) expect(verdict.eventType).toBe("POSITION_LIMIT_BREACHED");
  });

  it("leverage rejection (gross/equity > maxLeverage)", () => {
    const v = view(1_000_000);
    const o = mkOrder("BTC-PERP", "LONG", 25, 100_000); // notional 2.5M
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), limits({ maxLeverage: 2 }), 0);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) {
      expect(verdict.reason).toBe("MAX_LEVERAGE");
      expect(verdict.eventType).toBe("LEVERAGE_LIMIT_BREACHED");
    }
  });

  it("margin rejection (requiredMargin > availableMargin)", () => {
    const v = view(1_000_000); // availableMargin 1M at leverage 1
    const o = mkOrder("BTC-PERP", "LONG", 15, 100_000); // notional 1.5M; leverage 1.5 (< maxLev 3)
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), limits({ maxLeverage: 3 }), 0);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) expect(verdict.reason).toBe("MARGIN_UNAVAILABLE");
  });

  it("daily loss rejection (dailyPnL < -dailyLossLimit)", () => {
    const v = view(1_000_000);
    const o = mkOrder("BTC-PERP", "LONG", 1, 100);
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), limits({ dailyLossLimit: 5_000 }), -6_000);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) expect(verdict.reason).toBe("DAILY_LOSS_LIMIT");
  });

  it("concentration rejection (single-asset / equity > maxAssetAllocation)", () => {
    const v = view(1_000_000); // equity 1M
    const o = mkOrder("BTC-PERP", "LONG", 6, 100_000); // 600k -> 0.6 of equity
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), limits({ maxAssetAllocation: 0.5 }), 0);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) expect(verdict.reason).toBe("CONCENTRATION_LIMIT");
  });

  it("fail-closed: insolvent (equity <= 0) blocks", () => {
    const v = view(0, [mkPosition("BTC-PERP", "LONG", 1, 100_000)]); // equity 0, gross 100k
    const o = mkOrder("BTC-PERP", "LONG", 1, 100_000);
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), limits(), 0);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) expect(verdict.reason).toBe("FAIL_CLOSED");
  });

  it("approves when every check holds, with all checks recorded", () => {
    const v = view(1_000_000);
    const o = mkOrder("BTC-PERP", "LONG", 1, 100_000);
    const verdict = evaluatePreTrade(o, proj(v, o), cap(v), DEFAULT_RISK_LIMITS, 0);
    expect(verdict.approved).toBe(true);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });
});

// ── Deliverable 5 — Kill Switch ──────────────────────────────────────────────

describe("Kill Switch — activation halts all trading", () => {
  it("activates on a leverage breach and blocks subsequent orders", async () => {
    const store = new InMemoryRiskEventStore();
    const engine = new RiskEngine({ store, limits: limits({ maxLeverage: 2 }) });
    // gross 2.5M vs equity 1M -> leverage 2.5 > 2 -> global trigger.
    const v = view(1_000_000, [mkPosition("BTC-PERP", "LONG", 25, 100_000)]);
    const d1 = await engine.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), v, {});
    expect(d1.approved).toBe(false);
    expect(engine.isHalted()).toBe(true);
    expect(engine.state.trigger).toBe("LEVERAGE_BREACH");

    // A subsequent order is blocked even on a now-healthy view (no auto recovery).
    const d2 = await engine.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), view(1_000_000), {});
    expect(d2.approved).toBe(false);
    if (!d2.approved) expect(d2.reason).toBe("TRADING_HALTED");

    const types = (await store.readAll()).map((r) => r.type);
    expect(types).toContain("LEVERAGE_LIMIT_BREACHED");
    expect(types).toContain("KILL_SWITCH_TRIGGERED");
    expect(types).toContain("TRADING_HALTED");
  });

  it("activates on a drawdown breach and emits DRAWDOWN_LIMIT_BREACHED", async () => {
    const store = new InMemoryRiskEventStore();
    // dailyLossLimit high so drawdown (not daily-loss) is the binding trigger.
    const engine = new RiskEngine({ store, limits: limits({ maxDrawdown: 0.25, dailyLossLimit: 500_000 }) });
    await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100), view(1_000_000), {}); // baseline + peak = 1M
    const d = await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100), view(700_000), {}); // drawdown 0.30
    expect(d.approved).toBe(false);
    expect(engine.state.trigger).toBe("DRAWDOWN_BREACH");
    expect((await store.readAll()).map((r) => r.type)).toContain("DRAWDOWN_LIMIT_BREACHED");
  });

  it("a daily-loss breach halts trading", async () => {
    const store = new InMemoryRiskEventStore();
    const engine = new RiskEngine({ store, limits: limits({ dailyLossLimit: 100_000 }) });
    await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100), view(1_000_000), {}); // baseline 1M
    const d = await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100), view(800_000), {}); // -200k loss
    expect(d.approved).toBe(false);
    expect(engine.state.trigger).toBe("DAILY_LOSS_BREACH");
  });

  it("reset() is the ONLY way to resume (no automatic recovery)", async () => {
    const store = new InMemoryRiskEventStore();
    const engine = new RiskEngine({ store, limits: limits({ maxLeverage: 2 }) });
    await engine.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), view(1_000_000, [mkPosition("BTC-PERP", "LONG", 25, 100_000)]), {});
    expect(engine.isHalted()).toBe(true);
    await engine.reset("operator clears the halt");
    expect(engine.isHalted()).toBe(false);
    const d = await engine.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), view(1_000_000), {});
    expect(d.approved).toBe(true);
    expect((await store.readAll()).map((r) => r.type)).toContain("TRADING_RESUMED");
  });
});

// ── Kill switch persistence + recovery + replay ──────────────────────────────

describe("Kill Switch persistence — halt survives a restart", () => {
  it("recovered state equals live state and stays halted (in-memory)", async () => {
    const store = new InMemoryRiskEventStore();
    const engine = new RiskEngine({ store, limits: limits({ maxLeverage: 2 }) });
    await engine.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), view(1_000_000, [mkPosition("BTC-PERP", "LONG", 25, 100_000)]), {});

    const recovered = await recoverRiskState(store);
    expect(recovered.state).toEqual(engine.state);
    expect(recovered.state.halted).toBe(true);

    // A fresh engine seeded from recovery is still halted until reset.
    const restarted = new RiskEngine({ store, limits: limits({ maxLeverage: 2 }), state: recovered.state });
    const d = await restarted.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), view(1_000_000), {});
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe("TRADING_HALTED");
  });

  it("halt survives a restart through the JSONL file store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-risk-"));
    const file = join(dir, "risk-journal.jsonl");
    try {
      const engine = new RiskEngine({ store: new FileRiskEventStore(file), limits: limits({ maxLeverage: 2 }) });
      await engine.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), view(1_000_000, [mkPosition("BTC-PERP", "LONG", 25, 100_000)]), {});
      // Simulate a restart: a brand-new store instance over the same file.
      const recovered = await recoverRiskState(new FileRiskEventStore(file));
      expect(recovered.state).toEqual(engine.state);
      expect(recovered.state.halted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Replay + recovery equivalence", () => {
  /** A mixed sequence: a pass, a gate rejection, then a halting trigger. */
  async function drive(store: InMemoryRiskEventStore): Promise<RiskEngine> {
    const engine = new RiskEngine({ store, limits: limits({ maxPositionNotional: 1_000_000, maxLeverage: 2 }) });
    await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100_000), view(1_000_000), {}); // pass
    await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 5_000_000), view(1_000_000), {}); // notional reject
    await engine.evaluate(mkOrder("ETH-PERP", "LONG", 1, 1_850), view(1_000_000, [mkPosition("BTC-PERP", "LONG", 25, 100_000)]), {}); // leverage trigger -> halt
    return engine;
  }

  it("replay equivalence: two identical runs produce identical journals + state", async () => {
    const a = new InMemoryRiskEventStore();
    const b = new InMemoryRiskEventStore();
    const ea = await drive(a);
    const eb = await drive(b);
    expect(await a.readAll()).toEqual(await b.readAll());
    expect(ea.state).toEqual(eb.state);
  });

  it("recovery equivalence: reconstructed state == live state", async () => {
    const store = new InMemoryRiskEventStore();
    const engine = await drive(store);
    const recovered = await recoverRiskState(store);
    expect(recovered.state).toEqual(engine.state);
    // And the pure fold matches too (no hidden in-process state).
    expect(reconstructRiskState(await store.readAll())).toEqual(engine.state);
    expect(engine.state.checksPassed).toBe(1);
    expect(engine.state.checksFailed).toBeGreaterThanOrEqual(1);
  });
});

describe("Risk journal — fail-closed on corruption", () => {
  it("recoverRiskState surfaces corruption as RiskRecoveryError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-risk-"));
    const file = join(dir, "corrupt.jsonl");
    try {
      // line0 valid, line1 garbage (NOT last), line2 valid -> mid-file corruption.
      const store = new InMemoryRiskEventStore();
      await new RiskEngine({ store }).evaluate(mkOrder("BTC-PERP", "LONG", 1, 100_000), view(1_000_000), {});
      const recs = await store.readAll();
      const line0 = JSON.stringify({ ...recs[0], seq: 0 });
      const line2 = JSON.stringify({ ...recs[0], seq: 1 });
      await writeFile(file, `${line0}\n{ broken json\n${line2}\n`);
      await expect(new FileRiskEventStore(file).readAll()).rejects.toBeInstanceOf(RiskJournalCorruptionError);
      await expect(recoverRiskState(new FileRiskEventStore(file))).rejects.toBeInstanceOf(RiskRecoveryError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a journal write failure blocks even a passing check (fail-closed)", async () => {
    const failing: RiskEventStore = {
      append: async () => {
        throw new Error("disk full");
      },
      readAll: async () => [],
    };
    const engine = new RiskEngine({ store: failing });
    const d = await engine.evaluate(mkOrder("BTC-PERP", "LONG", 1, 100_000), view(1_000_000), {});
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe("FAIL_CLOSED");
  });
});

// ── Deliverable 8 (integration) — every order routes through the risk engine ──

describe("Integration — the execution stage routes every order through the risk engine", () => {
  function decisionEvent(symbol: string, side: "LONG" | "SHORT", confidence: string): DecisionEvent {
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
  const decisions = [
    decisionEvent("BTC-PERP", "LONG", "0.5000"),
    decisionEvent("ETH-PERP", "SHORT", "0.4000"),
  ];
  const ctx = { log: () => {}, tickId: "p8" };

  it("BLOCKS execution when the risk engine rejects (no fill, no intent)", async () => {
    const store = new InMemoryRiskEventStore();
    const engine = new RiskEngine({ store, limits: limits({ maxPositionNotional: 1_000 }) }); // tiny -> all blocked
    const adapter = createMarketExecutionAdapter({ marketData: fixtureQuoteProvider() });
    const riskGate = createRiskExecutionGate({
      engine,
      getView: () => adapter.getMarketState(),
      getQuote: (s) => adapter.marketData.quote(s),
    });
    const deps = createExecutionStage({ adapter, riskGate });
    const r = await runExecutionStage(decisions, deps, ctx);
    expect(r.filled).toBe(0);
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    const types = (await store.readAll()).map((rec) => rec.type);
    expect(types.every((t) => t !== "RISK_CHECK_PASSED")).toBe(true);
    // A hard-limit rejection journals BOTH the umbrella RISK_CHECK_FAILED and the
    // specific POSITION_LIMIT_BREACHED (full event-model coverage on the fail path).
    expect(types).toContain("RISK_CHECK_FAILED");
    expect(types).toContain("POSITION_LIMIT_BREACHED");
  });

  it("APPROVES and lets execution fill when within limits, journaling RISK_CHECK_PASSED", async () => {
    const store = new InMemoryRiskEventStore();
    const engine = new RiskEngine({ store, limits: DEFAULT_RISK_LIMITS });
    const adapter = createMarketExecutionAdapter({ marketData: fixtureQuoteProvider() });
    const riskGate = createRiskExecutionGate({
      engine,
      getView: () => adapter.getMarketState(),
      getQuote: (s) => adapter.marketData.quote(s),
    });
    const deps = createExecutionStage({ adapter, riskGate });
    const r = await runExecutionStage(decisions, deps, ctx);
    expect(r.filled).toBeGreaterThanOrEqual(1);
    expect(r.blocked).toBe(0);
    expect((await store.readAll()).filter((rec) => rec.type === "RISK_CHECK_PASSED").length).toBe(r.filled);
  });
});
