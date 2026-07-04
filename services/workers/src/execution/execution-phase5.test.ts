/**
 * Phase 5 — Execution / Risk / Portfolio layer verification (pure, no IO).
 *
 * Upholds the platform's standing principles for the new effectful layer:
 *   - determinism / replay: same decisions -> same allocations, intent ids, fills
 *   - separation: the decision layer is untouched; this layer only CONSUMES it
 *   - risk is a MANDATORY, FAIL-CLOSED gate: no ExecutionIntent exists without an
 *     approving verdict; a tripped kill-switch or invalid input blocks everything
 *   - lineage is lossless: every artifact traces back to the observation(s)
 *   - portfolio state is reconstructable from the ExecutionResult stream alone
 *
 * Imports the PURE submodules directly (not ./index.js, which wires the decision
 * persistence subscriber and would pull in @nexus/db) — this suite is IO-free.
 */

import { describe, expect, it } from "vitest";
import { deriveDecisionEvent } from "./decide.js";
import { StrategyV1 } from "./strategies/index.js";
import {
  PaperExecutionAdapter,
  RealExecutionAdapter,
  SimulatedExecutionAdapter,
  resolveAdapter,
} from "./adapters.js";
import { InProcessExecutionBus } from "./execution-bus.js";
import { deriveExecutionIntent } from "./intent.js";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  aggregateDecisions,
  applyResult,
  emptyPortfolioState,
  projectExposure,
  reconstructPortfolioState,
  symbolExposure,
  type PortfolioConfig,
} from "./portfolio.js";
import {
  DEFAULT_RISK_LIMITS,
  KillSwitch,
  evaluateRisk,
  type RiskLimits,
} from "./risk.js";
import {
  createExecutionStage,
  runExecutionStage,
  type ExecutionStageDeps,
} from "./stage.js";
import type {
  DecisionContribution,
  DecisionEvent,
  DecisionIntent,
  ExecutionIntent,
  ExecutionResult,
  ExecutionStageEvent,
  ProposedAllocation,
  SignalObservation,
} from "./types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PARAMS = { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 };

interface DecisionOver {
  symbol?: string;
  side?: "LONG" | "SHORT" | "FLAT";
  action?: DecisionIntent["action"];
  confidence?: string;
  executionStrategyId?: string;
  executionStrategyVersion?: number;
  strategyVersionId?: string;
  featureSnapshotId?: string;
  tickId?: string;
}

/** A fully-formed DecisionEvent with explicit control over every lineage field. */
function decisionEvent(over: DecisionOver = {}): DecisionEvent {
  const symbol = over.symbol ?? "BTC-PERP";
  const side = over.side ?? "LONG";
  const confidence = over.confidence ?? "0.5000";
  const action = over.action ?? (side === "FLAT" ? "STAND_ASIDE" : "ENTER");
  const signal: SignalObservation = {
    symbol,
    side,
    decision: side,
    confidence,
    strategyVersionId: over.strategyVersionId ?? "sv-1",
    strategyParams: PARAMS,
    featureSnapshotId: over.featureSnapshotId ?? `fs-${symbol}`,
    dqReportId: "dq-1",
    datasetHash: "dataset-hash-1",
    featureHash: "feature-hash-1",
  };
  const decision: DecisionIntent = {
    action,
    side,
    confidence,
    rationale: "fixture",
  };
  return {
    signal,
    decision,
    execution: null,
    lineage: {
      ...(over.tickId !== undefined ? { tickId: over.tickId } : {}),
      strategyVersionId: signal.strategyVersionId,
      featureSnapshotId: signal.featureSnapshotId,
      dqReportId: signal.dqReportId,
      datasetHash: signal.datasetHash,
      featureHash: signal.featureHash,
      executionStrategyId: over.executionStrategyId ?? "core-technical",
      executionStrategyVersion: over.executionStrategyVersion ?? 1,
    },
  };
}

function contribution(over: Partial<DecisionContribution> = {}): DecisionContribution {
  return {
    strategyVersionId: "sv-1",
    executionStrategyId: "core-technical",
    executionStrategyVersion: 1,
    featureSnapshotId: "fs-1",
    dqReportId: "dq-1",
    datasetHash: "dataset-hash-1",
    featureHash: "feature-hash-1",
    side: "LONG",
    confidence: "0.5000",
    weightedNotional: "500000.00",
    ...over,
  };
}

function proposal(over: Partial<ProposedAllocation> = {}): ProposedAllocation {
  const contributions = over.contributions ?? [contribution()];
  return {
    symbol: "BTC-PERP",
    side: "LONG",
    targetNotional: "500000.00",
    netScore: "500000.00",
    strategyId: "core-technical",
    strategyVersion: 1,
    primary: contributions[0]!,
    contributions,
    ...over,
  };
}

/** Fresh stage deps per test (deterministic config, fresh empty state). */
function stageDeps(over: Partial<ExecutionStageDeps> = {}): ExecutionStageDeps {
  return { ...createExecutionStage(), ...over };
}

const N = 100;
function distinct<T>(fn: () => T): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < N; i += 1) out.add(JSON.stringify(fn()));
  return out;
}

// ── Portfolio: aggregation, capital allocation, conflict resolution ───────────

describe("Portfolio — capital allocation & conflict netting (pure, deterministic)", () => {
  it("sizes one ENTER by totalCapital * weight * conviction", () => {
    const alloc = aggregateDecisions(
      [decisionEvent({ confidence: "0.5000" })],
      DEFAULT_PORTFOLIO_CONFIG,
    )[0]!;
    expect(alloc.targetNotional).toBe("500000.00"); // 1_000_000 * 1 * 0.5
    expect(alloc.side).toBe("LONG");
    expect(alloc.netScore).toBe("500000.00");
    expect(alloc.contributions).toHaveLength(1);
  });

  it("HOLD and STAND_ASIDE contribute no allocation", () => {
    const out = aggregateDecisions(
      [
        decisionEvent({ action: "HOLD", confidence: "0.0500" }),
        decisionEvent({ symbol: "ETH-PERP", side: "FLAT" }),
      ],
      DEFAULT_PORTFOLIO_CONFIG,
    );
    expect(out).toHaveLength(0);
  });

  it("nets opposing decisions on the same symbol (LONG 0.5 vs SHORT 0.3 -> LONG 0.2)", () => {
    const out = aggregateDecisions(
      [
        decisionEvent({ symbol: "X", side: "LONG", confidence: "0.5000" }),
        decisionEvent({ symbol: "X", side: "SHORT", confidence: "0.3000" }),
      ],
      DEFAULT_PORTFOLIO_CONFIG,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.side).toBe("LONG");
    expect(out[0]!.targetNotional).toBe("200000.00");
    expect(out[0]!.contributions).toHaveLength(2);
  });

  it("cancels exactly-opposing decisions to stand-aside (no allocation)", () => {
    const out = aggregateDecisions(
      [
        decisionEvent({ symbol: "X", side: "LONG", confidence: "0.5000" }),
        decisionEvent({ symbol: "X", side: "SHORT", confidence: "0.5000" }),
      ],
      DEFAULT_PORTFOLIO_CONFIG,
    );
    expect(out).toHaveLength(0);
  });

  it("net is order-independent and fully deterministic", () => {
    const a = decisionEvent({ symbol: "X", side: "LONG", confidence: "0.5000" });
    const b = decisionEvent({ symbol: "X", side: "SHORT", confidence: "0.3000" });
    expect(aggregateDecisions([a, b], DEFAULT_PORTFOLIO_CONFIG)).toEqual(
      aggregateDecisions([b, a], DEFAULT_PORTFOLIO_CONFIG),
    );
    expect(distinct(() => aggregateDecisions([a, b], DEFAULT_PORTFOLIO_CONFIG)).size).toBe(1);
  });

  it("emits allocations sorted by symbol", () => {
    const out = aggregateDecisions(
      [
        decisionEvent({ symbol: "ETH-PERP" }),
        decisionEvent({ symbol: "BTC-PERP" }),
        decisionEvent({ symbol: "SOL-PERP" }),
      ],
      DEFAULT_PORTFOLIO_CONFIG,
    );
    expect(out.map((a) => a.symbol)).toEqual(["BTC-PERP", "ETH-PERP", "SOL-PERP"]);
  });

  it("attributes the net to a contributor whose side AGREES with the net (not the opposing dominant)", () => {
    // A=SHORT 1.0 (|1,000,000|) dominates by magnitude, but B+C=LONG win the net.
    const out = aggregateDecisions(
      [
        decisionEvent({ symbol: "X", side: "SHORT", confidence: "1.0000", executionStrategyId: "shorty", featureSnapshotId: "fs-a" }),
        decisionEvent({ symbol: "X", side: "LONG", confidence: "0.6000", executionStrategyId: "longy", featureSnapshotId: "fs-b" }),
        decisionEvent({ symbol: "X", side: "LONG", confidence: "0.6000", executionStrategyId: "longy", featureSnapshotId: "fs-c" }),
      ],
      DEFAULT_PORTFOLIO_CONFIG,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.side).toBe("LONG"); // +1,200,000 - 1,000,000 = +200,000
    expect(out[0]!.targetNotional).toBe("200000.00");
    expect(out[0]!.primary.side).toBe("LONG"); // NOT the SHORT magnitude-dominant
    expect(out[0]!.strategyId).toBe("longy"); // bucket charged to a LONG strategy
  });

  it("intent id is input-order-independent for tied multi-strategy contributions", () => {
    // Two signal-strategy versions feeding ONE execution strategy on the SAME
    // snapshot at EQUAL conviction — tied on every sort key except strategyVersionId.
    const a = decisionEvent({ symbol: "X", side: "LONG", confidence: "0.5000", strategyVersionId: "sv-AAA", featureSnapshotId: "fs-1" });
    const b = decisionEvent({ symbol: "X", side: "LONG", confidence: "0.5000", strategyVersionId: "sv-BBB", featureSnapshotId: "fs-1" });
    const fwd = aggregateDecisions([a, b], DEFAULT_PORTFOLIO_CONFIG)[0]!;
    const rev = aggregateDecisions([b, a], DEFAULT_PORTFOLIO_CONFIG)[0]!;
    expect(fwd).toEqual(rev); // total-order sort makes the allocation identical
    expect(deriveExecutionIntent(fwd, "paper").intentId).toBe(
      deriveExecutionIntent(rev, "paper").intentId,
    );
  });

  it("respects per-strategy capital weights", () => {
    const cfg: PortfolioConfig = {
      ...DEFAULT_PORTFOLIO_CONFIG,
      strategyWeights: { "core-technical": 0.4 },
    };
    const alloc = aggregateDecisions([decisionEvent({ confidence: "0.5000" })], cfg)[0]!;
    expect(alloc.targetNotional).toBe("200000.00"); // 1_000_000 * 0.4 * 0.5
  });
});

// ── Portfolio state: event-sourced, reconstructable ───────────────────────────

describe("Portfolio state — deterministic, reconstructable from results", () => {
  function filled(symbol: string, notional: string, strategyId = "core-technical"): ExecutionResult {
    return {
      intentId: `i-${symbol}`,
      symbol,
      side: "LONG",
      status: "FILLED",
      adapterId: "paper",
      filledNotional: notional,
      detail: "paper",
      lineage: {
        strategyVersionId: "sv-1",
        featureSnapshotId: `fs-${symbol}`,
        dqReportId: "dq-1",
        datasetHash: "dh",
        featureHash: "fh",
        executionStrategyId: strategyId,
        executionStrategyVersion: 1,
        intentId: `i-${symbol}`,
        netScore: notional,
        contributions: [],
      },
    };
  }

  it("applies FILLED results into positions + derived aggregates", () => {
    let s = emptyPortfolioState();
    s = applyResult(s, filled("BTC-PERP", "300000.00"));
    s = applyResult(s, filled("ETH-PERP", "200000.00"));
    expect(symbolExposure(s, "BTC-PERP")).toBe(300000);
    expect(s.grossExposure).toBe("500000.00");
    expect(s.byStrategy["core-technical"]).toBe("500000.00");
  });

  it("REJECTED results leave state unchanged (same reference)", () => {
    const s = applyResult(emptyPortfolioState(), filled("BTC-PERP", "100000.00"));
    const rejected: ExecutionResult = {
      ...filled("ETH-PERP", "999999.00"),
      status: "REJECTED",
      filledNotional: "0.00",
    };
    expect(applyResult(s, rejected)).toBe(s);
  });

  it("reconstructs identically from the result stream (event-sourced fold)", () => {
    const results = [
      filled("BTC-PERP", "300000.00"),
      filled("ETH-PERP", "200000.00"),
      filled("BTC-PERP", "150000.00"), // later fill replaces the symbol's exposure
    ];
    const folded = results.reduce(applyResult, emptyPortfolioState());
    expect(reconstructPortfolioState(results)).toEqual(folded);
    expect(symbolExposure(folded, "BTC-PERP")).toBe(150000);
    expect(folded.grossExposure).toBe("350000.00");
  });
});

// ── Risk gate: hard constraints, kill-switch, fail-closed ─────────────────────

describe("Risk gate — mandatory, hard constraints, fail-closed", () => {
  const empty = emptyPortfolioState();
  const approveAll = new KillSwitch();

  it("approves a proposal within all limits", () => {
    const p = proposal({ targetNotional: "500000.00" });
    const v = evaluateRisk(p, projectExposure(empty, p), DEFAULT_RISK_LIMITS, approveAll);
    expect(v.approved).toBe(true);
  });

  it("blocks on max single-position size", () => {
    const p = proposal({ targetNotional: "800000.00" }); // > 750_000
    const v = evaluateRisk(p, projectExposure(empty, p), DEFAULT_RISK_LIMITS, approveAll);
    expect(v).toMatchObject({ approved: false, reason: "MAX_POSITION_SIZE" });
  });

  it("blocks on per-strategy limit", () => {
    const limits: RiskLimits = {
      ...DEFAULT_RISK_LIMITS,
      perStrategyMaxNotional: { "core-technical": 100_000 },
    };
    const p = proposal({ targetNotional: "500000.00" });
    const v = evaluateRisk(p, projectExposure(empty, p), limits, approveAll);
    expect(v).toMatchObject({ approved: false, reason: "PER_STRATEGY_LIMIT" });
  });

  it("blocks on max portfolio exposure (given prior state)", () => {
    // Prior gross 1_800_000; +500_000 -> 2_300_000 > 2_000_000.
    let state = emptyPortfolioState();
    state = applyResult(state, {
      intentId: "i-prior",
      symbol: "ETH-PERP",
      side: "LONG",
      status: "FILLED",
      adapterId: "paper",
      filledNotional: "1800000.00",
      detail: "",
      lineage: {
        strategyVersionId: "sv-1",
        featureSnapshotId: "fs-eth",
        dqReportId: "dq-1",
        datasetHash: "dh",
        featureHash: "fh",
        executionStrategyId: "other",
        executionStrategyVersion: 1,
        intentId: "i-prior",
        netScore: "1800000.00",
        contributions: [],
      },
    });
    const p = proposal({ symbol: "BTC-PERP", targetNotional: "500000.00" });
    const v = evaluateRisk(p, projectExposure(state, p), DEFAULT_RISK_LIMITS, approveAll);
    expect(v).toMatchObject({ approved: false, reason: "MAX_PORTFOLIO_EXPOSURE" });
  });

  it("kill-switch (FROZEN/RISK_OFF) blocks everything, unconditionally", () => {
    const p = proposal({ targetNotional: "1.00" }); // trivially within limits
    for (const mode of ["FROZEN", "RISK_OFF"] as const) {
      const ks = new KillSwitch();
      ks.engage(mode);
      expect(ks.isEngaged()).toBe(true);
      const v = evaluateRisk(p, projectExposure(empty, p), DEFAULT_RISK_LIMITS, ks);
      expect(v).toMatchObject({ approved: false, reason: "KILL_SWITCH" });
    }
  });

  it("fail-closed: invalid/missing limits block (never silently allow)", () => {
    const p = proposal({ targetNotional: "500000.00" });
    const bad: RiskLimits = { ...DEFAULT_RISK_LIMITS, maxPortfolioExposure: Number.NaN };
    const v = evaluateRisk(p, projectExposure(empty, p), bad, approveAll);
    expect(v).toMatchObject({ approved: false, reason: "FAIL_CLOSED" });

    const zero: RiskLimits = { ...DEFAULT_RISK_LIMITS, maxPositionNotional: 0 };
    expect(evaluateRisk(p, projectExposure(empty, p), zero, approveAll)).toMatchObject({
      approved: false,
      reason: "FAIL_CLOSED",
    });
  });

  it("is fully deterministic", () => {
    const p = proposal();
    expect(
      distinct(() =>
        evaluateRisk(p, projectExposure(empty, p), DEFAULT_RISK_LIMITS, approveAll),
      ).size,
    ).toBe(1);
  });
});

// ── Intent derivation: deterministic id + lossless lineage ────────────────────

describe("ExecutionIntent — deterministic id, lossless lineage", () => {
  it("produces a stable intent id independent of tickId", () => {
    const p = proposal();
    const a = deriveExecutionIntent(p, "paper", { tickId: "t-1" });
    const b = deriveExecutionIntent(p, "paper", { tickId: "t-2" });
    expect(a.intentId).toBe(b.intentId); // tickId is NOT part of identity
    expect(a.intentId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes id when economic content changes", () => {
    const base = deriveExecutionIntent(proposal({ targetNotional: "100000.00" }), "paper");
    const bigger = deriveExecutionIntent(proposal({ targetNotional: "200000.00" }), "paper");
    const sim = deriveExecutionIntent(proposal({ targetNotional: "100000.00" }), "simulated");
    expect(base.intentId).not.toBe(bigger.intentId);
    expect(base.intentId).not.toBe(sim.intentId);
  });

  it("threads full lineage (primary fields + lossless contributions + intentId)", () => {
    const p = proposal({
      contributions: [
        contribution({ featureSnapshotId: "fs-a", weightedNotional: "300000.00" }),
        contribution({ featureSnapshotId: "fs-b", weightedNotional: "200000.00" }),
      ],
    });
    const intent = deriveExecutionIntent(p, "paper", { tickId: "t-1" });
    expect(intent.lineage.tickId).toBe("t-1");
    expect(intent.lineage.intentId).toBe(intent.intentId);
    expect(intent.lineage.featureSnapshotId).toBe("fs-a"); // dominant contributor
    expect(intent.lineage.contributions).toHaveLength(2);
    expect(intent.lineage.contributions.map((c) => c.featureSnapshotId)).toEqual([
      "fs-a",
      "fs-b",
    ]);
  });

  it("omits tickId from lineage when no tick context is supplied", () => {
    expect("tickId" in deriveExecutionIntent(proposal(), "paper").lineage).toBe(false);
  });
});

// ── Adapters: paper deterministic, simulated deterministic, real interface-only ─

describe("Execution adapters", () => {
  const intent: ExecutionIntent = deriveExecutionIntent(proposal(), "paper");

  it("paper fills at target, deterministically", () => {
    const r = PaperExecutionAdapter.execute(intent);
    expect(r.status).toBe("FILLED");
    expect(r.filledNotional).toBe(intent.targetNotional);
    expect(distinct(() => PaperExecutionAdapter.execute(intent)).size).toBe(1);
  });

  it("simulated is deterministic and never fills above target", () => {
    const simIntent = deriveExecutionIntent(proposal(), "simulated");
    const r = SimulatedExecutionAdapter.execute(simIntent);
    expect(r.status).toBe("FILLED");
    expect(Number(r.filledNotional)).toBeLessThanOrEqual(Number(simIntent.targetNotional));
    expect(distinct(() => SimulatedExecutionAdapter.execute(simIntent)).size).toBe(1);
  });

  it("simulated reject branch is reachable and zero-fill", () => {
    let rejected: ExecutionResult | undefined;
    for (let i = 0; i < 2000 && !rejected; i += 1) {
      const cand: ExecutionIntent = { ...intent, intentId: `cand-${i}`, adapterId: "simulated" };
      const r = SimulatedExecutionAdapter.execute(cand);
      if (r.status === "REJECTED") rejected = r;
    }
    expect(rejected).toBeDefined();
    expect(rejected?.filledNotional).toBe("0.00");
  });

  it("real adapter is interface-only: execute throws", () => {
    expect(() => RealExecutionAdapter.execute(intent)).toThrow(/interface-only/);
  });

  it("resolveAdapter maps ids (unknown -> paper default)", () => {
    expect(resolveAdapter("simulated")).toBe(SimulatedExecutionAdapter);
    expect(resolveAdapter("real")).toBe(RealExecutionAdapter);
    expect(resolveAdapter("???")).toBe(PaperExecutionAdapter);
  });
});

// ── Execution bus: synchronous, fail-closed fan-out ───────────────────────────

describe("InProcessExecutionBus — decoupled, synchronous, fail-closed", () => {
  const evt: ExecutionStageEvent = {
    kind: "RESULT_RECORDED",
    result: PaperExecutionAdapter.execute(deriveExecutionIntent(proposal(), "paper")),
  };

  it("delivers to subscribers in registration order, awaiting each", async () => {
    const bus = new InProcessExecutionBus();
    const seen: string[] = [];
    bus.subscribe(async (e) => {
      await Promise.resolve();
      seen.push(`a:${e.kind}`);
    });
    bus.subscribe((e) => {
      seen.push(`b:${e.kind}`);
    });
    await bus.publish(evt);
    expect(seen).toEqual(["a:RESULT_RECORDED", "b:RESULT_RECORDED"]);
  });

  it("rejects (fail-closed) when a subscriber throws — no silent success", async () => {
    const bus = new InProcessExecutionBus();
    let reached = false;
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => {
      reached = true;
    });
    await expect(bus.publish(evt)).rejects.toThrow("boom");
    expect(reached).toBe(false);
  });
});

// ── Stage: end-to-end integration of all four layers ──────────────────────────

describe("runExecutionStage — portfolio -> risk -> intent -> adapter -> result", () => {
  const ctx = { log: () => {}, tickId: "t-1" };

  it("ENTERs flow through to FILLED paper results; state advances", async () => {
    const deps = stageDeps();
    const decisions = [
      decisionEvent({ symbol: "BTC-PERP", side: "LONG", confidence: "0.5000" }),
      decisionEvent({ symbol: "ETH-PERP", side: "SHORT", confidence: "0.4000" }),
    ];
    const r = await runExecutionStage(decisions, deps, ctx);
    expect(r.proposed).toBe(2);
    expect(r.intentsEmitted).toBe(2);
    expect(r.filled).toBe(2);
    expect(r.blocked).toBe(0);
    expect(r.portfolioState.grossExposure).toBe("900000.00"); // 500k + 400k
    // Reconstructable from the result stream alone.
    expect(reconstructPortfolioState(r.results)).toEqual(r.portfolioState);
  });

  it("NO ExecutionIntent is constructed when risk blocks (fail-closed gate)", async () => {
    const deps = stageDeps({
      limits: { ...DEFAULT_RISK_LIMITS, maxPositionNotional: 1_000 },
    });
    const seen: ExecutionStageEvent["kind"][] = [];
    deps.bus.subscribe((e) => void seen.push(e.kind));
    const r = await runExecutionStage([decisionEvent({ confidence: "0.5000" })], deps, ctx);
    expect(r.proposed).toBe(1);
    expect(r.intentsEmitted).toBe(0);
    expect(r.blocked).toBe(1);
    expect(r.results).toHaveLength(0);
    expect(seen).toEqual(["BLOCKED"]); // never INTENT_EMITTED
    expect(r.portfolioState).toEqual(emptyPortfolioState());
  });

  it("engaged kill-switch halts all execution (everything blocked)", async () => {
    const ks = new KillSwitch();
    ks.engage("FROZEN");
    const deps = stageDeps({ killSwitch: ks });
    const r = await runExecutionStage(
      [decisionEvent({ symbol: "BTC-PERP" }), decisionEvent({ symbol: "ETH-PERP" })],
      deps,
      ctx,
    );
    expect(r.intentsEmitted).toBe(0);
    expect(r.blocked).toBe(2);
    expect(r.filled).toBe(0);
  });

  it("adapter throw becomes a fail-closed REJECTED result — no crash, no phantom fill", async () => {
    const deps = stageDeps({ adapter: RealExecutionAdapter });
    const r = await runExecutionStage([decisionEvent({ confidence: "0.5000" })], deps, ctx);
    expect(r.intentsEmitted).toBe(1); // intent WAS emitted (risk approved)
    expect(r.rejected).toBe(1);
    expect(r.filled).toBe(0);
    expect(r.results[0]!.status).toBe("REJECTED");
    expect(r.results[0]!.filledNotional).toBe("0.00");
    expect(r.portfolioState).toEqual(emptyPortfolioState()); // rejects don't move state
  });

  it("is deterministic end-to-end (intent ids + fills identical across runs)", async () => {
    const decisions = [
      decisionEvent({ symbol: "BTC-PERP", side: "LONG", confidence: "0.5000" }),
      decisionEvent({ symbol: "ETH-PERP", side: "SHORT", confidence: "0.4000" }),
    ];
    const a = await runExecutionStage(decisions, stageDeps(), ctx);
    const b = await runExecutionStage(decisions, stageDeps(), ctx);
    expect(a.results).toEqual(b.results);
    expect(a.portfolioState).toEqual(b.portfolioState);
  });

  it("integrates with the real decision layer (deriveDecisionEvent -> stage)", async () => {
    const obs: SignalObservation = {
      symbol: "BTC-PERP",
      side: "LONG",
      decision: "LONG",
      confidence: "0.5000",
      strategyVersionId: "sv-1",
      strategyParams: PARAMS,
      featureSnapshotId: "fs-btc",
      dqReportId: "dq-1",
      datasetHash: "dh",
      featureHash: "fh",
    };
    const event = deriveDecisionEvent(obs, StrategyV1, { tickId: "t-1" });
    expect(event.decision.action).toBe("ENTER");
    const r = await runExecutionStage([event], stageDeps(), ctx);
    expect(r.intentsEmitted).toBe(1);
    expect(r.filled).toBe(1);
    expect(r.results[0]!.lineage.featureSnapshotId).toBe("fs-btc");
  });
});
