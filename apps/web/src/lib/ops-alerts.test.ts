import { describe, expect, it } from "vitest";
import { evaluateAlertRules, type AlertSnapshot } from "./ops-alerts";
import { STREAM_THRESHOLDS } from "./ops-freshness";
import type {
  ComponentKey,
  ComponentStatus,
  DataFlowStream,
  Freshness,
  OpsComponent,
  StreamKey,
  SystemHealth,
} from "./ops-types";

function comp(key: ComponentKey, status: ComponentStatus): OpsComponent {
  return { key, label: key, status, required: key === "database" || key === "redis", detail: `${key} ${status}`, latencyMs: null, lastObservedAt: null };
}

function stream(key: StreamKey, lagSeconds: number | null, freshness: Freshness): DataFlowStream {
  const def = STREAM_THRESHOLDS.find((s) => s.key === key)!;
  return {
    key,
    label: def.label,
    lastUpdateAt: lagSeconds === null ? null : new Date(Date.now() - lagSeconds * 1000).toISOString(),
    lagSeconds,
    rowsPerMinute: 0,
    rowsLastHour: 0,
    freshness,
    thresholdsSeconds: { warning: def.warningSec, stale: def.staleSec },
    note: null,
  };
}

function healthySnapshot(): AlertSnapshot {
  const health: SystemHealth = {
    overallStatus: "healthy",
    components: [
      comp("web", "healthy"),
      comp("database", "healthy"),
      comp("redis", "healthy"),
      comp("quant", "healthy"),
      comp("ingestion", "healthy"),
      comp("workers", "healthy"),
    ],
    version: "0.1.0",
    uptimeSeconds: 1,
    checkedAt: new Date().toISOString(),
  };
  const dataFlow = {
    overall: "fresh" as Freshness,
    streams: [
      stream("marketTick", 5, "fresh"),
      stream("orderbookSnapshot", 5, "fresh"),
      stream("marketCandle", 30, "fresh"),
      stream("featureSnapshot", 10, "fresh"),
      stream("engineSignal", 10, "fresh"),
      // execution is unobservable in the default deployment → unknown
      stream("execution", null, "unknown"),
    ],
  };
  return { health, dataFlow };
}

describe("evaluateAlertRules (alert generation)", () => {
  it("fires nothing when everything is healthy and fresh", () => {
    expect(evaluateAlertRules(healthySnapshot())).toEqual([]);
  });

  it("raises a CRITICAL when the database is unreachable", () => {
    const s = healthySnapshot();
    s.health.components[1] = comp("database", "failing");
    const fired = evaluateAlertRules(s);
    const db = fired.find((f) => f.ruleId === "db.unreachable");
    expect(db).toBeDefined();
    expect(db!.severity).toBe("CRITICAL");
  });

  it("raises CRITICAL for redis and quant unreachable", () => {
    const s = healthySnapshot();
    s.health.components[2] = comp("redis", "failing");
    s.health.components[3] = comp("quant", "failing");
    const ids = evaluateAlertRules(s).map((f) => f.ruleId);
    expect(ids).toContain("redis.unreachable");
    expect(ids).toContain("quant.unreachable");
  });

  it("raises a WARNING when ticks exceed the 60s limit", () => {
    const s = healthySnapshot();
    s.dataFlow.streams[0] = stream("marketTick", 75, "stale");
    const t = evaluateAlertRules(s).find((f) => f.ruleId === "ticks.stale");
    expect(t).toBeDefined();
    expect(t!.severity).toBe("WARNING");
    expect(t!.message).toContain("75s");
  });

  it("raises a WARNING when an expected stream has produced nothing (lag null)", () => {
    const s = healthySnapshot();
    // An expected-but-absent stream reads as 'stale' with null lag (not 'unknown',
    // which is reserved for streams this deployment does not produce at all).
    s.dataFlow.streams[3] = stream("featureSnapshot", null, "stale");
    const f = evaluateAlertRules(s).find((x) => x.ruleId === "features.stale");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("WARNING");
    expect(f!.message).toContain("No feature snapshots observed");
  });

  it("never raises a false alarm for an unobservable (unknown) execution stream", () => {
    const s = healthySnapshot();
    // execution is unknown (opt-in, default-off) → must be skipped
    const ids = evaluateAlertRules(s).map((f) => f.ruleId);
    expect(ids).not.toContain("execution.stale");
  });

  it("does NOT raise redis when redis is unknown (unconfigured), only when failing", () => {
    const s = healthySnapshot();
    s.health.components[2] = comp("redis", "unknown");
    const ids = evaluateAlertRules(s).map((f) => f.ruleId);
    expect(ids).not.toContain("redis.unreachable");
  });
});
