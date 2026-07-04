import { describe, expect, it } from "vitest";
import { liquidityScore, momentumScore, trendScore, volatilityScore } from "./scores.js";
import { DEFAULT_DECISION_CONFIG, DEFAULT_SIGNAL_PARAMS } from "./types.js";

const FEATURES: Record<string, number> = {
  ema_20: 271,
  ema_200: 198,
  rsi_14: 80,
  realized_vol_30: 0.001,
};

describe("scores — deterministic, fail-closed", () => {
  it("trendScore = clamp01(|ema20−ema200|/|ema200|) × 100", () => {
    const m = trendScore(FEATURES);
    expect(m.value).toBeCloseTo(36.9, 1);
    expect(m.provenance).toBe("derived");
  });

  it("momentumScore = clamp01(|rsi−50|/50) × 100 (RSI-only, labeled)", () => {
    const m = momentumScore(FEATURES);
    expect(m.value).toBe(60);
    expect(m.basis).toMatch(/RSI-only/);
  });

  it("volatilityScore normalizes realized_vol_30 against 2× maxRealizedVol", () => {
    const m = volatilityScore(FEATURES, DEFAULT_SIGNAL_PARAMS);
    expect(m.value).toBeCloseTo(2.5, 1); // 0.001 / 0.04 × 100
  });

  it("liquidityScore blends spread + depth from a real observation", () => {
    const m = liquidityScore({ spreadBps: 2, depthUsd: 500_000, ts: "t" }, DEFAULT_DECISION_CONFIG);
    // spreadScore 0.8, depthScore 0.5 → avg 0.65 → 65
    expect(m.value).toBe(65);
  });

  it("each score fails closed to unavailable when its input is missing", () => {
    expect(trendScore({}).value).toBeNull();
    expect(momentumScore({}).value).toBeNull();
    expect(volatilityScore({}, DEFAULT_SIGNAL_PARAMS).value).toBeNull();
    expect(liquidityScore(null, DEFAULT_DECISION_CONFIG).value).toBeNull();
    expect(liquidityScore({ spreadBps: null, depthUsd: null, ts: "t" }, DEFAULT_DECISION_CONFIG).value).toBeNull();
  });

  it("clamps extreme inputs into the 0..100 band (never NaN/overflow)", () => {
    expect(trendScore({ ema_20: 1e9, ema_200: 1 }).value).toBe(100);
    expect(momentumScore({ rsi_14: 100 }).value).toBe(100);
  });
});
