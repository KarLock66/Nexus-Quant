import { describe, expect, it } from "vitest";
import {
  activeProtections,
  componentsNeedingRecovery,
  deriveRuntimeState,
  evaluateProtectionRules,
  evaluateTradingPermission,
  isDegraded,
  PROTECTION_RULE_IDS,
  recoveryOutcome,
  summarizeStartup,
  type ControlComponent,
  type ControlInputs,
  type RuntimeState,
  type SteadyStateInput,
} from "./index.js";

/** A fully-healthy baseline; tests override single fields to isolate one condition. */
function base(overrides: Partial<ControlInputs> = {}): ControlInputs {
  return {
    now: 1_000_000,
    database: "healthy",
    redis: "healthy",
    quant: "healthy",
    features: { lagSeconds: 10, warningSeconds: 60, staleSeconds: 180 },
    signals: { lagSeconds: 10, warningSeconds: 60, staleSeconds: 120 },
    execution: { lagSeconds: 10, warningSeconds: 120, staleSeconds: 300 },
    riskEngineActive: true,
    killSwitch: { engaged: false, actor: null, reason: null, engagedAt: null },
    startupValidated: true,
    ...overrides,
  };
}

/** Compose the real evaluators into a steady-state input, as the worker evaluator does. */
function steady(inputs: ControlInputs, recovery: SteadyStateInput["recoveryOutcome"] = null): SteadyStateInput {
  return {
    killEngaged: inputs.killSwitch.engaged,
    activeProtections: activeProtections(inputs),
    degraded: isDegraded(inputs),
    recoveryOutcome: recovery,
  };
}

describe("trading permission (B) — fail-closed", () => {
  it("ALLOWS when every condition is satisfied", () => {
    const p = evaluateTradingPermission(base(), "HEALTHY");
    expect(p.permission).toBe("ALLOWED");
    expect(p.blockedBy).toHaveLength(0);
  });

  it.each<[string, Partial<ControlInputs>, string]>([
    ["database failing", { database: "failing" }, "database"],
    ["database unknown (fail-closed)", { database: "unknown" }, "database"],
    ["redis failing", { redis: "failing" }, "redis"],
    ["quant failing", { quant: "failing" }, "quant"],
    ["no feature observed", { features: { lagSeconds: null, warningSeconds: 60, staleSeconds: 180 } }, "feature_freshness"],
    ["feature stale", { features: { lagSeconds: 200, warningSeconds: 60, staleSeconds: 180 } }, "feature_freshness"],
    ["signal stale", { signals: { lagSeconds: 200, warningSeconds: 60, staleSeconds: 120 } }, "signal_freshness"],
    ["execution stalled", { execution: { lagSeconds: 400, warningSeconds: 120, staleSeconds: 300 } }, "execution_freshness"],
    ["risk disabled", { riskEngineActive: false }, "risk_engine"],
    ["kill engaged", { killSwitch: { engaged: true, actor: "op", reason: "test", engagedAt: "t" } }, "kill_switch"],
  ])("BLOCKS on %s", (_name, override, expectedCheck) => {
    const p = evaluateTradingPermission(base(override), "HEALTHY");
    expect(p.permission).toBe("BLOCKED");
    expect(p.blockedBy.map((r) => r.check)).toContain(expectedCheck);
  });

  it("allows the FIRST order when execution has never run (lag null)", () => {
    const p = evaluateTradingPermission(
      base({ execution: { lagSeconds: null, warningSeconds: 120, staleSeconds: 300 } }),
      "HEALTHY",
    );
    expect(p.permission).toBe("ALLOWED");
  });

  it("BLOCKS whenever runtime state is not HEALTHY, regardless of inputs", () => {
    for (const s of ["BOOTING", "STARTING", "DEGRADED", "PROTECTED", "STOPPED", "RECOVERING", "FAILED"] as RuntimeState[]) {
      const p = evaluateTradingPermission(base(), s);
      expect(p.permission).toBe("BLOCKED");
      expect(p.blockedBy.map((r) => r.check)).toContain("runtime_state");
    }
  });
});

describe("protection rules (D)", () => {
  it("emits exactly one verdict per catalog rule, in order", () => {
    const v = evaluateProtectionRules(base());
    expect(v.map((x) => x.ruleId)).toEqual([...PROTECTION_RULE_IDS]);
    expect(v.every((x) => !x.active)).toBe(true);
  });

  it.each<[string, Partial<ControlInputs>, string]>([
    ["database.unavailable on failing", { database: "failing" }, "database.unavailable"],
    ["database.unavailable on unknown", { database: "unknown" }, "database.unavailable"],
    ["redis.unavailable", { redis: "failing" }, "redis.unavailable"],
    ["quant.unavailable", { quant: "unknown" }, "quant.unavailable"],
    ["feature.stale", { features: { lagSeconds: 999, warningSeconds: 60, staleSeconds: 180 } }, "feature.stale"],
    ["signal.stale", { signals: { lagSeconds: 999, warningSeconds: 60, staleSeconds: 120 } }, "signal.stale"],
    ["execution.stale", { execution: { lagSeconds: 999, warningSeconds: 120, staleSeconds: 300 } }, "execution.stale"],
    ["risk.disabled", { riskEngineActive: false }, "risk.disabled"],
  ])("activates %s", (_name, override, ruleId) => {
    const active = activeProtections(base(override));
    expect(active.map((a) => a.ruleId)).toContain(ruleId);
  });

  it("does NOT treat a never-observed stream (lag null) as a breach", () => {
    const active = activeProtections(
      base({
        features: { lagSeconds: null, warningSeconds: 60, staleSeconds: 180 },
        execution: { lagSeconds: null, warningSeconds: 120, staleSeconds: 300 },
      }),
    );
    expect(active.map((a) => a.ruleId)).not.toContain("feature.stale");
    expect(active.map((a) => a.ruleId)).not.toContain("execution.stale");
  });

  it("flags soft (warning-band) staleness as DEGRADED, not PROTECTED", () => {
    const inputs = base({ features: { lagSeconds: 100, warningSeconds: 60, staleSeconds: 180 } });
    expect(activeProtections(inputs)).toHaveLength(0);
    expect(isDegraded(inputs)).toBe(true);
  });
});

describe("runtime state machine (A) — deterministic transitions", () => {
  it("manual kill dominates every other condition → STOPPED", () => {
    const inputs = base({
      database: "failing",
      killSwitch: { engaged: true, actor: "op", reason: "halt", engagedAt: "t" },
    });
    expect(deriveRuntimeState("HEALTHY", steady(inputs)).state).toBe("STOPPED");
    expect(deriveRuntimeState("PROTECTED", steady(inputs)).state).toBe("STOPPED");
  });

  it("DB lost: HEALTHY → PROTECTED", () => {
    const r = deriveRuntimeState("HEALTHY", steady(base({ database: "failing" })));
    expect(r.state).toBe("PROTECTED");
    expect(r.affectedComponents).toContain<ControlComponent>("database");
  });

  it("execution freshness breach: HEALTHY → PROTECTED", () => {
    const r = deriveRuntimeState(
      "HEALTHY",
      steady(base({ execution: { lagSeconds: 999, warningSeconds: 120, staleSeconds: 300 } })),
    );
    expect(r.state).toBe("PROTECTED");
  });

  it("feature soft-stale: HEALTHY → DEGRADED", () => {
    const r = deriveRuntimeState(
      "HEALTHY",
      steady(base({ features: { lagSeconds: 100, warningSeconds: 60, staleSeconds: 180 } })),
    );
    expect(r.state).toBe("DEGRADED");
  });

  it("recovery: PROTECTED → RECOVERING (verifying) → HEALTHY (verified)", () => {
    const clean = base();
    expect(deriveRuntimeState("PROTECTED", steady(clean, null)).state).toBe("RECOVERING");
    expect(deriveRuntimeState("RECOVERING", steady(clean, true)).state).toBe("HEALTHY");
  });

  it("recovery verification failure: RECOVERING → PROTECTED", () => {
    expect(deriveRuntimeState("RECOVERING", steady(base(), false)).state).toBe("PROTECTED");
  });

  it("resume: STOPPED → HEALTHY when clean, → DEGRADED when soft-stale", () => {
    expect(deriveRuntimeState("STOPPED", steady(base())).state).toBe("HEALTHY");
    expect(
      deriveRuntimeState(
        "STOPPED",
        steady(base({ signals: { lagSeconds: 90, warningSeconds: 60, staleSeconds: 120 } })),
      ).state,
    ).toBe("DEGRADED");
  });

  it("all-nominal stays HEALTHY", () => {
    expect(deriveRuntimeState("HEALTHY", steady(base())).state).toBe("HEALTHY");
  });

  it("is deterministic: identical inputs → identical output", () => {
    const inputs = base({ quant: "failing" });
    const a = deriveRuntimeState("HEALTHY", steady(inputs));
    const b = deriveRuntimeState("HEALTHY", steady(inputs));
    expect(a).toEqual(b);
  });
});

describe("recovery aggregation (E)", () => {
  it("no reports → null (RECOVERING)", () => {
    expect(recoveryOutcome([])).toBeNull();
  });
  it("all verified → true (HEALTHY)", () => {
    expect(recoveryOutcome([{ component: "database", verified: true, steps: [] }])).toBe(true);
  });
  it("any unverified → false (hold PROTECTED)", () => {
    expect(
      recoveryOutcome([
        { component: "database", verified: true, steps: [] },
        { component: "quant", verified: false, steps: [] },
      ]),
    ).toBe(false);
  });
  it("components needing recovery = previously-active minus currently-active", () => {
    expect(componentsNeedingRecovery(["database", "quant"], ["quant"])).toEqual(["database"]);
    expect(componentsNeedingRecovery(["database"], ["database"])).toEqual([]);
  });
});

describe("startup validation (I) — fail-closed", () => {
  it("empty/partial check set never passes", () => {
    expect(summarizeStartup([]).passed).toBe(false);
  });
  it("passes only when every check passes", () => {
    expect(
      summarizeStartup([
        { name: "database", passed: true, detail: "" },
        { name: "quant", passed: true, detail: "" },
      ]).passed,
    ).toBe(true);
    expect(
      summarizeStartup([
        { name: "database", passed: true, detail: "" },
        { name: "quant", passed: false, detail: "down" },
      ]).passed,
    ).toBe(false);
  });
});
