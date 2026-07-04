/**
 * Execution stage (Phase 5) — the effectful orchestration of the execution layer.
 *
 *   DecisionEvent[]                          (pure decision layer, upstream)
 *     -> aggregateDecisions   (PORTFOLIO: multi-strategy netting + capital alloc)
 *     -> evaluateRisk         (RISK GATE: mandatory, fail-closed — blocks here)
 *     -> deriveExecutionIntent(INTENT: built ONLY after risk approves)
 *     -> adapter.execute      (EXECUTION: the one effectful edge)
 *     -> applyResult          (PORTFOLIO STATE: event-sourced carry-forward)
 *
 * Strict ordering guarantees the headline invariant: NO ExecutionIntent is
 * constructed until the global risk gate approves the allocation. Fail-closed
 * throughout — a risk-eval error blocks (no intent); an adapter error becomes a
 * REJECTED result (no phantom fill, no crash). The stage NEVER touches the
 * decision or persistence layers; it only consumes the DecisionEvents they
 * already produced (decoupled). It is also self-contained: a failure here cannot
 * corrupt the already-committed decision/persistence work upstream.
 */

import { errMsg } from "../lib/log.js";
import {
  PaperExecutionAdapter,
  type ExecutionAdapter,
} from "./adapters.js";
import { InProcessExecutionBus, type ExecutionBus } from "./execution-bus.js";
import { deriveExecutionIntent } from "./intent.js";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  aggregateDecisions,
  applyResult,
  emptyPortfolioState,
  projectExposure,
  type PortfolioConfig,
  type PortfolioState,
} from "./portfolio.js";
import {
  DEFAULT_RISK_LIMITS,
  KillSwitch,
  evaluateRisk,
  type RiskLimits,
  type RiskVerdict,
} from "./risk.js";
import type {
  DecisionEvent,
  ExecutionResult,
  ProposedAllocation,
} from "./types.js";

type StageLog = (
  level: "info" | "warn" | "error",
  msg: string,
  extra?: object,
) => void;

/**
 * Decision a pre-trade risk hook returns for one allocation. Structural (no import
 * of the risk layer into this sealed module): the Phase 8 risk engine supplies a
 * matching object via createRiskExecutionGate.
 */
export type RiskGateDecision =
  | { approved: true }
  | { approved: false; reason: string; detail: string };

/**
 * OPT-IN pre-trade risk hook (Phase 8). Consulted per proposal BEFORE the Phase 5
 * gate; a non-approval blocks the order exactly like the Phase 5 gate (defense in
 * depth — both must pass). Default-off (the field omitted) = Phase 5/6/7 byte-for-byte.
 */
export type RiskGateHook = (
  proposal: ProposedAllocation,
  state: PortfolioState,
) => Promise<RiskGateDecision> | RiskGateDecision;

/**
 * Long-lived execution dependencies. The worker creates ONE of these at startup
 * (via createExecutionStage) and reuses it across ticks; `portfolioState` is the
 * mutable, event-sourced carry-forward updated by the orchestrator each tick.
 */
export interface ExecutionStageDeps {
  adapter: ExecutionAdapter;
  limits: RiskLimits;
  killSwitch: KillSwitch;
  portfolioConfig: PortfolioConfig;
  bus: ExecutionBus;
  /** Portfolio state carried across ticks (a deterministic fold over results). */
  portfolioState: PortfolioState;
  /**
   * Phase 8 risk engine hook — OPT-IN, default-off. When provided it runs per
   * proposal BEFORE the Phase 5 gate; a non-approval blocks the order (no intent is
   * constructed). Omitted (every Phase 1-7 test + the default worker) preserves the
   * prior behavior byte-for-byte.
   */
  riskGate?: RiskGateHook;
}

export interface ExecutionStageContext {
  log: StageLog;
  tickId?: string;
}

export interface ExecutionStageResult {
  proposed: number;
  intentsEmitted: number;
  filled: number;
  rejected: number;
  blocked: number;
  /** Outcomes recorded this tick (authoritative; the bus carries the same set). */
  results: ExecutionResult[];
  /** Portfolio state AFTER this tick's fills — carry into the next tick. */
  portfolioState: PortfolioState;
}

/** Compact, log-friendly counts for the pipeline tick result (no nested arrays). */
export interface ExecutionStageSummary {
  proposed: number;
  intentsEmitted: number;
  filled: number;
  rejected: number;
  blocked: number;
}

export function summarize(result: ExecutionStageResult): ExecutionStageSummary {
  return {
    proposed: result.proposed,
    intentsEmitted: result.intentsEmitted,
    filled: result.filled,
    rejected: result.rejected,
    blocked: result.blocked,
  };
}

/**
 * Run the execution layer over one tick's DecisionEvents. Pure with respect to
 * its inputs (returns a NEW portfolio state; does not mutate `deps`) apart from
 * the deliberate effects of `deps.adapter.execute` and `deps.bus.publish`.
 */
export async function runExecutionStage(
  decisions: DecisionEvent[],
  deps: ExecutionStageDeps,
  ctx: ExecutionStageContext,
): Promise<ExecutionStageResult> {
  const { log, tickId } = ctx;
  const proposals = aggregateDecisions(decisions, deps.portfolioConfig);

  let state = deps.portfolioState;
  let intentsEmitted = 0;
  let filled = 0;
  let rejected = 0;
  let blocked = 0;
  const results: ExecutionResult[] = [];

  for (const proposal of proposals) {
    const primary = proposal.contributions[0]!;

    // ── PHASE 8 RISK ENGINE (opt-in, fail-closed) ───────────────────────────
    // Runs strictly BEFORE the Phase 5 gate; a block here prevents intent
    // construction exactly like the Phase 5 gate. Omitted => unchanged behavior.
    if (deps.riskGate) {
      let pre: RiskGateDecision;
      try {
        pre = await deps.riskGate(proposal, state);
      } catch (err) {
        // Any failure to evaluate the risk engine must BLOCK, never execute.
        pre = { approved: false, reason: "FAIL_CLOSED", detail: `risk engine error: ${errMsg(err)}` };
      }
      if (!pre.approved) {
        blocked += 1;
        log("warn", "execution blocked by risk engine (Phase 8)", {
          tickId,
          symbol: proposal.symbol,
          side: proposal.side,
          targetNotional: proposal.targetNotional,
          reason: pre.reason,
          detail: pre.detail,
          strategyVersionId: primary.strategyVersionId,
          featureSnapshotId: primary.featureSnapshotId,
        });
        await deps.bus.publish({
          kind: "BLOCKED",
          proposal,
          reason: pre.reason,
          detail: pre.detail,
        });
        continue; // NO ExecutionIntent is constructed when the risk engine blocks.
      }
    }

    // ── RISK GATE (mandatory, fail-closed) ──────────────────────────────────
    let verdict: RiskVerdict;
    try {
      const projection = projectExposure(state, proposal);
      verdict = evaluateRisk(proposal, projection, deps.limits, deps.killSwitch);
    } catch (err) {
      // Any failure to *evaluate* risk must block, never execute (fail-closed).
      verdict = {
        approved: false,
        reason: "FAIL_CLOSED",
        detail: `risk evaluation error: ${errMsg(err)}`,
      };
    }

    if (!verdict.approved) {
      blocked += 1;
      log("warn", "execution blocked by risk gate", {
        tickId,
        symbol: proposal.symbol,
        side: proposal.side,
        targetNotional: proposal.targetNotional,
        reason: verdict.reason,
        detail: verdict.detail,
        strategyVersionId: primary.strategyVersionId,
        featureSnapshotId: primary.featureSnapshotId,
      });
      await deps.bus.publish({
        kind: "BLOCKED",
        proposal,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      continue; // NO ExecutionIntent is constructed when risk blocks.
    }

    // ── INTENT (constructed only AFTER risk approval) ───────────────────────
    const intent = deriveExecutionIntent(
      proposal,
      deps.adapter.id,
      tickId !== undefined ? { tickId } : {},
    );
    intentsEmitted += 1;
    log("info", "execution intent emitted", {
      tickId,
      intentId: intent.intentId,
      symbol: intent.symbol,
      side: intent.side,
      targetNotional: intent.targetNotional,
      adapterId: intent.adapterId,
      strategyVersionId: intent.lineage.strategyVersionId,
      featureSnapshotId: intent.lineage.featureSnapshotId,
      executionStrategy: `${intent.lineage.executionStrategyId}@v${intent.lineage.executionStrategyVersion}`,
    });
    await deps.bus.publish({ kind: "INTENT_EMITTED", intent });

    // ── EXECUTION (effectful edge; adapter error => fail-closed REJECTED) ────
    let result: ExecutionResult;
    try {
      result = await deps.adapter.execute(intent);
    } catch (err) {
      result = {
        intentId: intent.intentId,
        symbol: intent.symbol,
        side: intent.side,
        status: "REJECTED",
        adapterId: intent.adapterId,
        filledNotional: "0.00",
        detail: `adapter error: ${errMsg(err)}`,
        lineage: intent.lineage,
      };
    }

    if (result.status === "FILLED") filled += 1;
    else rejected += 1;
    results.push(result);
    state = applyResult(state, result); // event-sourced portfolio update

    log(result.status === "FILLED" ? "info" : "warn", "execution result recorded", {
      tickId,
      intentId: result.intentId,
      symbol: result.symbol,
      side: result.side,
      status: result.status,
      filledNotional: result.filledNotional,
      adapterId: result.adapterId,
      detail: result.detail,
    });
    await deps.bus.publish({ kind: "RESULT_RECORDED", result });
  }

  return {
    proposed: proposals.length,
    intentsEmitted,
    filled,
    rejected,
    blocked,
    results,
    portfolioState: state,
  };
}

export interface CreateExecutionStageOptions {
  adapter?: ExecutionAdapter;
  limits?: RiskLimits;
  killSwitch?: KillSwitch;
  portfolioConfig?: PortfolioConfig;
  /**
   * Execution bus the stage publishes outcomes to. Omitted (every Phase 1-6 test +
   * the default worker) uses a fresh in-process bus — unchanged behavior. Phase 7
   * may inject a Redis/BullMQ bridge here without touching the stage logic.
   */
  bus?: ExecutionBus;
  /** Initial portfolio state (e.g. recovered on restart); defaults to empty. */
  portfolioState?: PortfolioState;
  /** Phase 8 risk engine hook (opt-in, default-off). */
  riskGate?: RiskGateHook;
}

/**
 * Build the long-lived ExecutionStageDeps with safe defaults: the PAPER adapter
 * (deterministic, zero external effect — so wiring this on does not regress any
 * Phase 4 guarantee), the default risk limits, a disengaged kill-switch, the
 * default capital-allocation policy, a fresh in-process execution bus, and an
 * empty portfolio state. The worker creates one at startup and reuses it.
 */
export function createExecutionStage(
  opts: CreateExecutionStageOptions = {},
): ExecutionStageDeps {
  return {
    adapter: opts.adapter ?? PaperExecutionAdapter,
    limits: opts.limits ?? DEFAULT_RISK_LIMITS,
    killSwitch: opts.killSwitch ?? new KillSwitch(),
    portfolioConfig: opts.portfolioConfig ?? DEFAULT_PORTFOLIO_CONFIG,
    bus: opts.bus ?? new InProcessExecutionBus(),
    portfolioState: opts.portfolioState ?? emptyPortfolioState(),
    ...(opts.riskGate !== undefined ? { riskGate: opts.riskGate } : {}),
  };
}
