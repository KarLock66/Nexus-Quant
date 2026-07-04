import { describe, expect, it } from "vitest";
import { applyRule } from "./signal-rule.js";
import { DEFAULT_SIGNAL_PARAMS } from "./types.js";

/**
 * Equivalence test: the deterministic mirror (applyRule) MUST reproduce the sealed
 * core-technical v1 rule's {side, decision} over the REAL quant-generated vectors in
 * services/workers/src/__fixtures__/decision-vectors.json. The vectors are inlined here
 * (with their provenance) so the package stays self-contained; their expected outcomes
 * are exactly what the sealed services/workers/src/signal/decision.ts produces.
 */

// Real compute_core_technical output (Python sole-authority). Do not edit by hand.
const FIXTURES = {
  clean: {
    atr_14: 20.0, donchian_lower_20: 90.0, donchian_mid_20: 100.0, donchian_upper_20: 110.0,
    ema_20: 100.0, ema_200: 100.0, ema_50: 100.0, realized_vol_30: 0.0, rsi_14: 50.0, volume_zscore_100: 0.0,
  },
  bull: {
    atr_14: 1.598852436, donchian_lower_20: 259.3718559, donchian_mid_20: 270.4318107, donchian_upper_20: 281.4917656,
    ema_20: 270.9552756, ema_200: 198.231233, ema_50: 256.202645, realized_vol_30: 1.531279392e-11, rsi_14: 100.0, volume_zscore_100: 0.0,
  },
  bear: {
    atr_14: 0.2249356441, donchian_lower_20: 35.37807025, donchian_mid_20: 36.89278166, donchian_upper_20: 38.40749306,
    ema_20: 36.81819394, ema_200: 55.63840744, ema_50: 39.27813113, realized_vol_30: 1.183853381e-10, rsi_14: 0.0, volume_zscore_100: 0.0,
  },
  highvol: {
    atr_14: 11.01961056, donchian_lower_20: 246.2766143, donchian_mid_20: 270.1515074, donchian_upper_20: 294.0264004,
    ema_20: 270.0953127, ema_200: 198.1027194, ema_50: 255.8060876, realized_vol_30: 0.04447471642, rsi_14: 59.53407147, volume_zscore_100: 0.0,
  },
} as const;

describe("applyRule — equivalence with the sealed core-technical v1 rule", () => {
  it("clean (flat constant) → FLAT/FLAT, zero confidence", () => {
    const r = applyRule(FIXTURES.clean, DEFAULT_SIGNAL_PARAMS);
    expect(r).not.toBeNull();
    expect(r?.side).toBe("FLAT");
    expect(r?.decision).toBe("FLAT");
    expect(r?.confidence).toBe(0);
    expect(r?.volFiltered).toBe(false);
  });

  it("bull (strict uptrend, RSI 100, low vol) → LONG/LONG", () => {
    const r = applyRule(FIXTURES.bull, DEFAULT_SIGNAL_PARAMS);
    expect(r?.side).toBe("LONG");
    expect(r?.decision).toBe("LONG");
    expect(r?.volFiltered).toBe(false);
    // 0.5·trendStrength + 0.5·rsiConviction, rsiConviction = 1.0
    expect(r?.confidence).toBeCloseTo(0.6834, 3);
  });

  it("bear (strict downtrend, RSI 0, low vol) → SHORT/SHORT", () => {
    const r = applyRule(FIXTURES.bear, DEFAULT_SIGNAL_PARAMS);
    expect(r?.side).toBe("SHORT");
    expect(r?.decision).toBe("SHORT");
    expect(r?.confidence).toBeCloseTo(0.6691, 3);
  });

  it("highvol (bull stack but realized_vol > max) → side LONG, decision FLAT (vol-filtered)", () => {
    const r = applyRule(FIXTURES.highvol, DEFAULT_SIGNAL_PARAMS);
    expect(r?.side).toBe("LONG");
    expect(r?.decision).toBe("FLAT");
    expect(r?.volFiltered).toBe(true);
    // FLAT-by-vol confidence = clamp01((rv - max)/max), rv 0.0445, max 0.02 → clamps to 1
    expect(r?.confidence).toBe(1);
  });

  it("fails closed (null) when a required feature is missing", () => {
    const { ema_20, ...missing } = FIXTURES.bull;
    void ema_20;
    expect(applyRule(missing as Record<string, number>, DEFAULT_SIGNAL_PARAMS)).toBeNull();
  });
});
