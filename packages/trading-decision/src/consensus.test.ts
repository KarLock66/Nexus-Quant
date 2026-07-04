import { describe, expect, it } from "vitest";
import { computeConsensus } from "./consensus.js";
import type { ConsensusTimeframeInput, SignalParams } from "./types.js";

const PARAMS: SignalParams = { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 };

const BULL: Record<string, number> = {
  ema_20: 271, ema_50: 256, ema_200: 198, rsi_14: 80, realized_vol_30: 0.001,
};
const BEAR: Record<string, number> = {
  ema_20: 36, ema_50: 39, ema_200: 55, rsi_14: 10, realized_vol_30: 0.001,
};

const NOW = Date.parse("2026-06-26T00:00:30.000Z");

function tf(timeframe: ConsensusTimeframeInput["timeframe"], features: Record<string, number> | null): ConsensusTimeframeInput {
  return { timeframe, features, ts: features ? "2026-06-26T00:00:00.000Z" : null, params: PARAMS };
}

describe("computeConsensus — real timeframes only, honest N/A", () => {
  it("aggregates across available timeframes and marks missing ones 'no data'", () => {
    const c = computeConsensus("BTC-PERP", [tf("H1", BULL), tf("H4", BULL), tf("M15", null)], NOW);
    expect(c.overall).toBe("LONG");
    expect(c.availableCount).toBe(2);
    expect(c.requestedCount).toBe(3);
    expect(c.agreement).toEqual(["H1", "H4"]);
    expect(c.alignmentScore.value).toBe(100);
    const m15 = c.timeframes.find((t) => t.timeframe === "M15");
    expect(m15?.available).toBe(false);
    expect(m15?.note).toBe("no data");
    expect(c.note).toMatch(/no data for: M15/);
  });

  it("reports conflict and a partial alignment when timeframes disagree", () => {
    const c = computeConsensus("BTC-PERP", [tf("H1", BULL), tf("H4", BEAR)], NOW);
    // tie 1 LONG / 1 SHORT → deterministic tie-break to LONG
    expect(c.overall).toBe("LONG");
    expect(c.alignmentScore.value).toBe(50);
    expect(c.conflict).toEqual(["H4"]);
  });

  it("all timeframes missing → overall null, bias 'no data', alignment unavailable", () => {
    const c = computeConsensus("BTC-PERP", [tf("H1", null), tf("H4", null)], NOW);
    expect(c.overall).toBeNull();
    expect(c.bias).toBe("no data");
    expect(c.alignmentScore.value).toBeNull();
    expect(c.availableCount).toBe(0);
  });

  it("is deterministic", () => {
    const a = computeConsensus("BTC-PERP", [tf("H1", BULL), tf("H4", BEAR)], NOW);
    const b = computeConsensus("BTC-PERP", [tf("H1", BULL), tf("H4", BEAR)], NOW);
    expect(a).toEqual(b);
  });
});
