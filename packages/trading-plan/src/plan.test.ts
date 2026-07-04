import { describe, expect, it } from "vitest";
import { buildTradePlan } from "./plan.js";
import { makeDecision, makeFlat, makeInputs, na } from "./test-fixtures.js";
import type { TradePlanInputs } from "./types.js";

/** Recursively assert no value is a NaN, an undefined, or a non-finite number. */
function assertNoNaNOrUndefined(value: unknown, path = "$"): void {
  if (value === undefined) throw new Error(`undefined at ${path}`);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}: ${value}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaNOrUndefined(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) assertNoNaNOrUndefined(v, `${path}.${k}`);
}

// A directional signal whose mark/levels are all unavailable (signal present, no fresh mark).
const noPrice = (): TradePlanInputs =>
  makeInputs({
    dqScore: null,
    runtimeState: "PROTECTED",
    decision: makeDecision({
      currentPrice: na(),
      entryPrice: na(),
      stopLoss: na(),
      takeProfit1: na(),
      takeProfit2: na(),
      takeProfit3: na(),
      riskRewardRatio: na(),
      stopDistancePct: na(),
      positionSize: na(),
      positionNotional: na(),
      capitalRiskPercent: na(),
      overallStatus: "INCOMPLETE",
    }),
  });

describe("buildTradePlan — orchestration", () => {
  it("assembles all five sections and carries identity verbatim", () => {
    const plan = buildTradePlan(makeInputs());
    expect(plan.signalId).toBe("sig-1");
    expect(plan.symbol).toBe("BTC-PERP");
    expect(plan.direction).toBe("LONG");
    expect(plan.confidence).toBe(0.9);
    expect(plan.summary.action).toBe("STRONG_BUY");
    expect(plan.execution.items).toHaveLength(10);
    expect(plan.invalidation.triggers).toHaveLength(9);
    expect(plan.readiness.band).toBe("READY");
    expect(plan.generatedNote).toMatch(/verbatim/);
  });

  it("never emits NaN or undefined across populated / FLAT / no-price decisions", () => {
    for (const inputs of [makeInputs(), makeInputs({ decision: makeFlat() }), noPrice()]) {
      const plan = buildTradePlan(inputs);
      assertNoNaNOrUndefined(plan);
      // and the JSON wire form contains no literal NaN
      expect(JSON.stringify(plan)).not.toContain("NaN");
    }
  });

  it("is deterministic — byte-identical output for identical inputs (stable snapshot)", () => {
    const a = JSON.stringify(buildTradePlan(makeInputs()));
    const b = JSON.stringify(buildTradePlan(makeInputs()));
    expect(a).toBe(b);
  });

  it("carries the decision's honest gap notes forward into generatedNote", () => {
    const plan = buildTradePlan(makeInputs({ decision: makeFlat() }));
    expect(plan.generatedNote).toMatch(/FLAT/);
  });
});
