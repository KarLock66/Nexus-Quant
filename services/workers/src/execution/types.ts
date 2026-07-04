/**
 * Execution Decision Layer contracts (Phase 4).
 *
 * Extends the EngineSignal observation model into a three-part DecisionEvent:
 *   signal     — the deterministic market OBSERVATION (an EngineSignal projection)
 *   decision   — the ACTION INTENT a versioned strategy derives from it
 *   execution  — a future extensibility hook (order routing); inert for now
 *
 * The decision layer is PURE and DERIVED: a DecisionEvent is reconstructable from
 * the persisted EngineSignal (the observation, the audit source of truth) plus the
 * versioned, pure strategy code alone. No lineage is ever lost and nothing new is
 * persisted — auditability without a schema change.
 */

import type { SignalDecision } from "@nexus/core";
import type { GeneratedSignal } from "../signal/types.js";

/**
 * The market observation a decision is made about. Structurally an EngineSignal
 * (the engine's pure output) — aliased here so the execution layer reads in its
 * own vocabulary without duplicating the field contract (single source of truth).
 */
export type SignalObservation = GeneratedSignal;

/** What the strategy intends to do about an observation. */
export type DecisionAction =
  | "ENTER" // act on a confirmed directional edge
  | "HOLD" // an edge exists but conviction is below the action floor
  | "STAND_ASIDE"; // no directional edge (FLAT) — explicitly decline to act

/** The action intent a strategy derives from one observation (pure output). */
export interface DecisionIntent {
  action: DecisionAction;
  /** Directional bias carried verbatim from the observation. */
  side: SignalDecision;
  /** Quantized 4dp conviction carried verbatim from the observation. */
  confidence: string;
  /** Human- and audit-readable WHY (deterministic for a given observation). */
  rationale: string;
}

/**
 * Future extensibility hook — where order routing / sizing will later attach.
 * Inert in Phase 4: a decision is never executed yet, so this stays PENDING
 * (intent recorded, no execution) or SKIPPED (intent was not to act).
 */
export interface ExecutionPlan {
  status: "PENDING" | "SKIPPED";
  detail: string;
}

/**
 * Full decision lineage. Every decision is traceable to the observation's
 * persisted artifacts (featureSnapshotId, strategyVersionId, dqReportId + the
 * verbatim hashes), the tick that produced it, and the exact strategy version
 * that decided. No link may be dropped (auditability-first).
 */
export interface DecisionLineage {
  /** Correlation id of the producing tick (omitted when run outside a tick). */
  tickId?: string;
  /** Signal-generation strategy version (the DB EngineSignal lineage key). */
  strategyVersionId: string;
  featureSnapshotId: string;
  dqReportId: string;
  datasetHash: string;
  featureHash: string;
  /** The execution strategy that derived the intent (logical id + version). */
  executionStrategyId: string;
  executionStrategyVersion: number;
}

/**
 * The Phase 4 event model: observation + action intent + execution hook, bound
 * by a complete lineage. This is the unit the logical event bus carries.
 */
export interface DecisionEvent {
  signal: SignalObservation;
  decision: DecisionIntent;
  execution: ExecutionPlan | null;
  lineage: DecisionLineage;
}

// ── Phase 5 — Execution layer contracts ──────────────────────────────────────
//
// The decision layer above stays PURE and UNCHANGED: a DecisionEvent still
// carries the inert Phase 4 ExecutionPlan hook. Phase 5 adds a SEPARATE,
// downstream, EFFECTFUL layer that consumes DecisionEvents and transforms them:
//
//   DecisionEvent[] -> (portfolio) ProposedAllocation[] -> (risk gate)
//                   -> ExecutionIntent -> (adapter) ExecutionResult
//
// Strict separation of concerns: the portfolio layer aggregates/sizes, the risk
// layer is a mandatory fail-closed GATE (no ExecutionIntent is constructed until
// risk APPROVES), and adapters are the only effectful edge. Every artifact below
// preserves full lineage back to the observation (no link is ever dropped).

/** Net directional intent. FLAT is never executed (it produces no allocation). */
export type ExecutionSide = "LONG" | "SHORT";

/** The only execution action in Phase 5 scope: open net exposure on a symbol. */
export type ExecutionAction = "ENTER";

/**
 * One decision's contribution to a (possibly blended) per-symbol allocation.
 * Carries the contributor's FULL reproducibility lineage so a netted allocation
 * never loses the provenance of any decision that fed it.
 */
export interface DecisionContribution {
  /** Signal-generation strategy version (the EngineSignal lineage key). */
  strategyVersionId: string;
  /** Execution strategy that derived the intent (logical id + version). */
  executionStrategyId: string;
  executionStrategyVersion: number;
  featureSnapshotId: string;
  dqReportId: string;
  datasetHash: string;
  featureHash: string;
  /** This decision's directional intent and conviction (carried verbatim). */
  side: ExecutionSide;
  confidence: string;
  /** Signed notional this decision contributed to the symbol's net (quantized). */
  weightedNotional: string;
}

/**
 * Portfolio-layer output: a single NET target per symbol after multi-strategy
 * aggregation, capital allocation, and conflict resolution (opposing decisions
 * net against each other; a flat net yields no allocation). Deterministic and
 * order-independent — the net is a sum, so it is reconstructable from the
 * contributing decisions alone.
 */
export interface ProposedAllocation {
  symbol: string;
  /** Net direction after conflict resolution (sign of the summed exposure). */
  side: ExecutionSide;
  /** Absolute net target notional in capital units (quantized, always > 0). */
  targetNotional: string;
  /** Signed net conviction-weighted score that produced this (audit). */
  netScore: string;
  /** Strategy bucket this allocation is charged to for per-strategy limits. */
  strategyId: string;
  strategyVersion: number;
  /**
   * The OWNING contribution: the dominant contributor whose side AGREES with the
   * net direction (never an opposing contributor that merely has the largest
   * magnitude). Its lineage represents the allocation and seeds the strategy
   * bucket, so attribution always matches the net side.
   */
  primary: DecisionContribution;
  /** Every decision that fed this net, in canonical order (lossless). */
  contributions: DecisionContribution[];
}

/**
 * Execution lineage: the primary contributor's decision lineage PLUS the
 * execution-specific ids, with the full contribution set retained. This is what
 * makes the execution tail of the chain end-to-end traceable.
 */
export interface ExecutionLineage extends DecisionLineage {
  /** Deterministic id of the ExecutionIntent (pure hash of the lineage+target). */
  intentId: string;
  /** Net conviction-weighted score behind the allocation (audit). */
  netScore: string;
  /** Lossless set of contributing decisions (>= 1). */
  contributions: DecisionContribution[];
}

/**
 * ExecutionIntent — first-class Phase 5 model. The sized, risk-APPROVED
 * instruction to open exposure. Constructed ONLY after the risk gate approves
 * the underlying ProposedAllocation, so its mere existence implies risk passed.
 * Its id is a pure deterministic function of its lineage + target, so the same
 * inputs reproduce the same intent id forever (replay-compatible).
 */
export interface ExecutionIntent {
  intentId: string;
  symbol: string;
  side: ExecutionSide;
  action: ExecutionAction;
  /** Target notional exposure in capital units (quantized decimal string). */
  targetNotional: string;
  /** Adapter selected to execute this intent (paper | simulated | real). */
  adapterId: string;
  lineage: ExecutionLineage;
  /** Deterministic, audit-readable WHY this intent exists. */
  rationale: string;
}

/** Outcome of handing an ExecutionIntent to an adapter (the effectful edge). */
export interface ExecutionResult {
  intentId: string;
  symbol: string;
  side: ExecutionSide;
  status: "FILLED" | "REJECTED";
  adapterId: string;
  /** Notional actually filled (== target for paper; modeled for sim; 0 if rejected). */
  filledNotional: string;
  /** Deterministic, audit-readable adapter detail (e.g. modeled slippage). */
  detail: string;
  lineage: ExecutionLineage;
}

/**
 * The discriminated event the in-process execution bus carries. Mirrors how the
 * decision bus carries DecisionEvent, but for the effectful tail of the chain.
 */
export type ExecutionStageEvent =
  | { kind: "INTENT_EMITTED"; intent: ExecutionIntent }
  | {
      kind: "BLOCKED";
      proposal: ProposedAllocation;
      reason: string;
      detail: string;
    }
  | { kind: "RESULT_RECORDED"; result: ExecutionResult };
