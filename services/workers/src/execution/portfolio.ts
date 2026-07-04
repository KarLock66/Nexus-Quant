/**
 * Portfolio layer (Phase 5) — multi-strategy aggregation, capital allocation,
 * and conflict resolution. PURE and DETERMINISTIC: given the same DecisionEvents
 * and config it always produces the same ProposedAllocations, and the portfolio
 * STATE is a reconstructable fold over ExecutionResults (event-sourced).
 *
 * Pipeline position: this is the FIRST execution-layer step, downstream of the
 * (pure, unchanged) decision layer and UPSTREAM of the risk gate. It sizes and
 * nets competing decisions but enforces NO hard limits — that is exclusively the
 * risk gate's job (strict separation: portfolio sizes, risk gates).
 *
 * Capital allocation: each execution strategy gets a weight (fraction of total
 * capital it may deploy); a decision's notional is strategyCapital * conviction.
 * Conflict resolution: per symbol, signed notionals are SUMMED (LONG +, SHORT -);
 * opposing decisions net against each other; a net inside the deadband cancels to
 * stand-aside. Contributions are sorted into a canonical TOTAL order BEFORE the
 * sum and the owning-contributor selection, so both are independent of input
 * (decision arrival) order — deterministic and reconstructable from the
 * contributing decisions alone.
 */

import type {
  DecisionContribution,
  DecisionEvent,
  ExecutionResult,
  ExecutionSide,
  ProposedAllocation,
} from "./types.js";
import { quantizeNotional, parseDecimal } from "./money.js";

export interface PortfolioConfig {
  /** Total deployable capital, in capital units. */
  totalCapital: number;
  /**
   * Capital weight per execution-strategy id — the fraction of `totalCapital`
   * that strategy may deploy. Strategies absent here use `defaultStrategyWeight`.
   */
  strategyWeights: Record<string, number>;
  /** Weight applied to any execution strategy not named in `strategyWeights`. */
  defaultStrategyWeight: number;
  /**
   * Absolute net-notional floor below which a symbol's competing decisions are
   * treated as canceling out — no allocation is proposed (explicit stand-aside).
   */
  netDeadband: number;
}

/** A reasonable, fully-deterministic default allocation policy. */
export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  totalCapital: 1_000_000,
  strategyWeights: {},
  defaultStrategyWeight: 1,
  netDeadband: 0.01,
};

/** Current net exposure on one symbol, attributed to its owning strategy. */
export interface PortfolioPosition {
  symbol: string;
  side: ExecutionSide;
  /** Absolute notional exposure (quantized). */
  notional: string;
  /** Execution strategy that owns this exposure (for per-strategy limits). */
  strategyId: string;
}

/**
 * Deterministic portfolio state. Positions are the source of truth; gross and
 * per-strategy exposures are DERIVED from them, so the state is always internally
 * consistent and is a pure fold over the ExecutionResult stream.
 */
export interface PortfolioState {
  positions: Record<string, PortfolioPosition>;
  /** Sum of |position notional| across all symbols (quantized, derived). */
  grossExposure: string;
  /** Sum of |position notional| per owning strategy (quantized, derived). */
  byStrategy: Record<string, string>;
}

/** Gross exposure of the whole portfolio / one strategy bucket if a proposal lands. */
export interface ExposureProjection {
  grossAfter: number;
  strategyAfter: number;
}

const signOf = (side: ExecutionSide): number => (side === "LONG" ? 1 : -1);

/**
 * Canonical TOTAL order over contributions: |notional| desc, then every lineage
 * field. Because it is total, the sum and primary selection never depend on input
 * order — distinct contributions are always ordered; truly identical ones are
 * interchangeable. (Equal quantized notionals parse to the same double, so the
 * magnitude key is an exact 0 on ties, never FP fuzz.)
 */
function compareContribution(
  a: DecisionContribution,
  b: DecisionContribution,
): number {
  return (
    Math.abs(parseDecimal(b.weightedNotional)) -
      Math.abs(parseDecimal(a.weightedNotional)) ||
    a.featureSnapshotId.localeCompare(b.featureSnapshotId) ||
    a.executionStrategyId.localeCompare(b.executionStrategyId) ||
    a.executionStrategyVersion - b.executionStrategyVersion ||
    a.strategyVersionId.localeCompare(b.strategyVersionId) ||
    a.dqReportId.localeCompare(b.dqReportId) ||
    a.datasetHash.localeCompare(b.datasetHash) ||
    a.featureHash.localeCompare(b.featureHash) ||
    a.side.localeCompare(b.side) ||
    a.confidence.localeCompare(b.confidence) ||
    a.weightedNotional.localeCompare(b.weightedNotional)
  );
}

/** Empty portfolio: no positions, zero exposure. */
export function emptyPortfolioState(): PortfolioState {
  return { positions: {}, grossExposure: quantizeNotional(0), byStrategy: {} };
}

/** Recompute gross + per-strategy aggregates from positions (pure, derived). */
function deriveAggregates(
  positions: Record<string, PortfolioPosition>,
): Pick<PortfolioState, "grossExposure" | "byStrategy"> {
  let gross = 0;
  const byStrategy: Record<string, number> = {};
  // Iterate in sorted key order so the derived doubles accumulate identically
  // across runs (sum is order-independent in exact arithmetic, but fixing the
  // order keeps FP rounding byte-stable too).
  for (const symbol of Object.keys(positions).sort()) {
    const pos = positions[symbol]!;
    const n = parseDecimal(pos.notional);
    gross += n;
    byStrategy[pos.strategyId] = (byStrategy[pos.strategyId] ?? 0) + n;
  }
  const byStrategyStr: Record<string, string> = {};
  for (const id of Object.keys(byStrategy).sort()) {
    byStrategyStr[id] = quantizeNotional(byStrategy[id]!);
  }
  return { grossExposure: quantizeNotional(gross), byStrategy: byStrategyStr };
}

/**
 * Aggregate a tick's DecisionEvents into per-symbol net allocations. Only ENTER
 * decisions size capital; HOLD / STAND_ASIDE contribute nothing. Output is sorted
 * by symbol for a stable, replay-identical ordering.
 */
export function aggregateDecisions(
  decisions: DecisionEvent[],
  config: PortfolioConfig,
): ProposedAllocation[] {
  // Bucket contributing (signed) notionals per symbol.
  const bySymbol = new Map<string, DecisionContribution[]>();

  for (const event of decisions) {
    if (event.decision.action !== "ENTER") continue;
    const side = event.decision.side;
    if (side !== "LONG" && side !== "SHORT") continue; // FLAT never executes

    const { lineage } = event;
    const weight =
      config.strategyWeights[lineage.executionStrategyId] ??
      config.defaultStrategyWeight;
    const strategyCapital = config.totalCapital * weight;
    // conviction is the quantized 4dp confidence parsed back to a double; the
    // execution layer's own parser is used (no import from the decision layer).
    const conviction = parseDecimal(event.decision.confidence);
    const signed = signOf(side) * strategyCapital * conviction;

    const contribution: DecisionContribution = {
      strategyVersionId: lineage.strategyVersionId,
      executionStrategyId: lineage.executionStrategyId,
      executionStrategyVersion: lineage.executionStrategyVersion,
      featureSnapshotId: lineage.featureSnapshotId,
      dqReportId: lineage.dqReportId,
      datasetHash: lineage.datasetHash,
      featureHash: lineage.featureHash,
      side,
      confidence: event.decision.confidence,
      weightedNotional: quantizeNotional(signed),
    };
    const list = bySymbol.get(event.signal.symbol);
    if (list) list.push(contribution);
    else bySymbol.set(event.signal.symbol, [contribution]);
  }

  const out: ProposedAllocation[] = [];
  for (const symbol of [...bySymbol.keys()].sort()) {
    // Canonical TOTAL order FIRST, so both the sum below and the owning-
    // contributor selection are independent of input (decision arrival) order.
    const contributions = bySymbol.get(symbol)!.sort(compareContribution);
    const netSigned = contributions.reduce(
      (acc, c) => acc + parseDecimal(c.weightedNotional),
      0,
    );
    // Conflicting decisions inside the deadband cancel out — stand aside.
    if (Math.abs(netSigned) <= config.netDeadband) continue;

    const side: ExecutionSide = netSigned > 0 ? "LONG" : "SHORT";
    // The OWNING contributor is the dominant one whose side AGREES with the net
    // direction — never an opposing contributor that merely has the largest
    // magnitude. A nonzero net guarantees >= 1 contributor on its side, so find
    // always resolves (the !-assert can never throw).
    const primary = contributions.find((c) => c.side === side)!;

    out.push({
      symbol,
      side,
      targetNotional: quantizeNotional(Math.abs(netSigned)),
      netScore: quantizeNotional(netSigned),
      strategyId: primary.executionStrategyId,
      strategyVersion: primary.executionStrategyVersion,
      primary,
      contributions,
    });
  }
  return out;
}

/** Absolute exposure currently held on a symbol (0 if flat). */
export function symbolExposure(state: PortfolioState, symbol: string): number {
  const pos = state.positions[symbol];
  return pos ? parseDecimal(pos.notional) : 0;
}

/**
 * Gross exposure of the whole portfolio and of the proposal's strategy bucket if
 * `proposal` were applied. A new position REPLACES any existing exposure on the
 * same symbol (target is the desired net), so the symbol's prior notional is
 * removed before the target is added. Pure — used by the risk gate.
 */
export function projectExposure(
  state: PortfolioState,
  proposal: ProposedAllocation,
): ExposureProjection {
  const target = parseDecimal(proposal.targetNotional);
  const prior = state.positions[proposal.symbol];
  const priorNotional = prior ? parseDecimal(prior.notional) : 0;

  const grossBefore = parseDecimal(state.grossExposure);
  const grossAfter = grossBefore - priorNotional + target;

  const bucket = proposal.strategyId;
  const strategyBefore = parseDecimal(state.byStrategy[bucket] ?? "0");
  // Only subtract the symbol's prior notional from this bucket if the bucket
  // currently owns it; otherwise the symbol is moving between strategy buckets.
  const priorInBucket = prior && prior.strategyId === bucket ? priorNotional : 0;
  const strategyAfter = strategyBefore - priorInBucket + target;

  return { grossAfter, strategyAfter };
}

/**
 * Fold one ExecutionResult into the portfolio state. FILLED results set the
 * symbol's position to the filled notional (replacing any prior); REJECTED
 * results leave state unchanged. Pure: returns a new state, never mutates.
 */
export function applyResult(
  state: PortfolioState,
  result: ExecutionResult,
): PortfolioState {
  if (result.status !== "FILLED") return state;
  const positions: Record<string, PortfolioPosition> = {
    ...state.positions,
    [result.symbol]: {
      symbol: result.symbol,
      side: result.side,
      notional: result.filledNotional,
      strategyId: result.lineage.executionStrategyId,
    },
  };
  return { positions, ...deriveAggregates(positions) };
}

/**
 * Reconstruct portfolio state from an ExecutionResult stream — proof that state
 * is a deterministic, event-sourced fold (replaying the same results in the same
 * order always yields the same state). The seed defaults to empty.
 */
export function reconstructPortfolioState(
  results: ExecutionResult[],
  seed: PortfolioState = emptyPortfolioState(),
): PortfolioState {
  return results.reduce(applyResult, seed);
}
