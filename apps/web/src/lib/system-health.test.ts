import { describe, expect, it } from "vitest";
import { reduceOverall } from "./system-health";
import type { ComponentKey, ComponentStatus, OpsComponent } from "./ops-types";

function comp(
  key: ComponentKey,
  status: ComponentStatus,
  required: boolean,
): OpsComponent {
  return { key, label: key, status, required, detail: "", latencyMs: null, lastObservedAt: null };
}

/** A fully-healthy baseline; redis configured (required) and quant present. */
function healthyComponents(): OpsComponent[] {
  return [
    comp("web", "healthy", true),
    comp("database", "healthy", true),
    comp("redis", "healthy", true),
    comp("quant", "healthy", false),
    comp("ingestion", "healthy", false),
    comp("workers", "healthy", false),
  ];
}

describe("reduceOverall (health aggregation, fail-closed)", () => {
  it("is healthy when every component is healthy", () => {
    expect(reduceOverall(healthyComponents())).toBe("healthy");
  });

  it("is critical when the database is failing", () => {
    const c = healthyComponents();
    c[1] = comp("database", "failing", true);
    expect(reduceOverall(c)).toBe("critical");
  });

  it("is critical when a configured redis is failing", () => {
    const c = healthyComponents();
    c[2] = comp("redis", "failing", true);
    expect(reduceOverall(c)).toBe("critical");
  });

  it("is only degraded (not critical) when a non-critical-tier component fails", () => {
    const c = healthyComponents();
    c[3] = comp("quant", "failing", false);
    expect(reduceOverall(c)).toBe("degraded");
  });

  it("is degraded when any component is degraded", () => {
    const c = healthyComponents();
    c[4] = comp("ingestion", "degraded", false);
    expect(reduceOverall(c)).toBe("degraded");
  });

  it("is degraded (fail-closed) when a REQUIRED component is unknown", () => {
    const c = healthyComponents();
    c[1] = comp("database", "unknown", true);
    expect(reduceOverall(c)).toBe("degraded");
  });

  it("stays healthy when redis is unconfigured (unknown + optional)", () => {
    const c = healthyComponents();
    // Unconfigured redis is reported unknown + not required → must not block healthy.
    c[2] = comp("redis", "unknown", false);
    expect(reduceOverall(c)).toBe("healthy");
  });
});
