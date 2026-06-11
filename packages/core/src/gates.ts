import type { GateResult, GateType } from "./types.js";

/**
 * The gate chain is the platform's single risk-decision surface (M1).
 * Python services compute numbers; only this layer decides pass/fail.
 *
 * Phase 0 ships the chain runner and contract; concrete gates land in
 * Phases 2-3 (POSITION_SIZE, RISK_MODE, then the rest). The runner is
 * fail-closed by construction: a gate that throws is recorded as failed.
 */

export interface GateContext {
  /** Raw inputs a gate needs, keyed by gate; populated by the orchestrator. */
  inputs: Partial<Record<GateType, unknown>>;
}

export interface Gate {
  readonly type: GateType;
  evaluate(ctx: GateContext): Promise<GateResult> | GateResult;
}

export interface GateChainOutcome {
  passed: boolean;
  results: GateResult[];
  failedGates: GateType[];
}

/**
 * Runs every gate (no short-circuit: a rejected signal must record the
 * complete picture for audit), fail-closed on errors.
 */
export async function runGateChain(
  gates: readonly Gate[],
  ctx: GateContext,
): Promise<GateChainOutcome> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    try {
      results.push(await gate.evaluate(ctx));
    } catch (err) {
      results.push({
        gate: gate.type,
        passed: false,
        measured: null,
        threshold: null,
        detail: `gate evaluation error (fail-closed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }
  const failedGates = results.filter((r) => !r.passed).map((r) => r.gate);
  return { passed: failedGates.length === 0, results, failedGates };
}
