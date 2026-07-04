import { describe, expect, it } from "vitest";
import { buildTradingDecision } from "./decision.js";
import { rankOpportunities } from "./ranking.js";
import type {
  ControlContext,
  DecisionInputs,
  SignalParams,
  SignalProjection,
  TradingDecision,
} from "./types.js";

const PARAMS: SignalParams = { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 };
const BULL: Record<string, number> = {
  atr_14: 2, ema_20: 271, ema_50: 256, ema_200: 198, rsi_14: 80, realized_vol_30: 0.001,
  donchian_upper_20: 281, donchian_lower_20: 259, donchian_mid_20: 270, volume_zscore_100: 0,
};
const BEAR: Record<string, number> = {
  atr_14: 2, ema_20: 36, ema_50: 39, ema_200: 55, rsi_14: 10, realized_vol_30: 0.001,
  donchian_upper_20: 38, donchian_lower_20: 35, donchian_mid_20: 36, volume_zscore_100: 0,
};
const FLAT: Record<string, number> = {
  atr_14: 20, ema_20: 100, ema_50: 100, ema_200: 100, rsi_14: 50, realized_vol_30: 0,
  donchian_upper_20: 110, donchian_lower_20: 90, donchian_mid_20: 100, volume_zscore_100: 0,
};

function decision(
  over: {
    symbol: string;
    side: "LONG" | "SHORT" | "FLAT";
    decision: "LONG" | "SHORT" | "FLAT";
    confidence: number;
    features: Record<string, number>;
    control?: Partial<ControlContext>;
    price?: number | null;
  },
): TradingDecision {
  const sig: SignalProjection = {
    id: `sig-${over.symbol}`,
    symbol: over.symbol,
    side: over.side,
    decision: over.decision,
    confidence: over.confidence,
    featureHash: "fh",
    datasetHash: "ds",
    strategyVersionId: "sv-1",
    strategyParams: PARAMS,
    createdAt: "2026-06-26T00:00:00.000Z",
  };
  const control: ControlContext = {
    permission: "ALLOWED",
    runtimeState: "HEALTHY",
    killEngaged: false,
    blockedReasons: [],
    ...over.control,
  };
  const inputs: DecisionInputs = {
    now: Date.parse("2026-06-26T00:00:30.000Z"),
    signal: sig,
    features: over.features,
    featureTs: "2026-06-26T00:00:00.000Z",
    timeframe: "H1",
    dqScore: 100,
    price: over.price === null ? null : { price: over.price ?? 270, ts: "2026-06-26T00:00:00.000Z", source: "markPrice" },
    liquidity: { spreadBps: 2, depthUsd: 500_000, ts: "2026-06-26T00:00:00.000Z" },
    risk: { assumedEquity: 100_000, riskFraction: 0.01, leverage: 3, maxNotional: 750_000, systemRiskMode: "NORMAL" },
    control,
  };
  return buildTradingDecision(inputs);
}

describe("rankOpportunities — buckets + deterministic ordering (Section F)", () => {
  it("routes decisions into Top Long / Top Short / Watchlist / Blocked / Waiting", () => {
    const decisions = [
      { decision: decision({ symbol: "BTC-PERP", side: "LONG", decision: "LONG", confidence: 0.9, features: BULL }), featureQuality: 1 },
      { decision: decision({ symbol: "SOL-PERP", side: "LONG", decision: "LONG", confidence: 0.5, features: BULL }), featureQuality: 1 },
      { decision: decision({ symbol: "ETH-PERP", side: "SHORT", decision: "SHORT", confidence: 0.7, features: BEAR }), featureQuality: 1 },
      { decision: decision({ symbol: "XRP-PERP", side: "FLAT", decision: "FLAT", confidence: 0, features: FLAT }), featureQuality: 1 },
      { decision: decision({ symbol: "ADA-PERP", side: "LONG", decision: "LONG", confidence: 0.8, features: BULL, control: { killEngaged: true } }), featureQuality: 1 },
      { decision: decision({ symbol: "DOT-PERP", side: "LONG", decision: "LONG", confidence: 0.8, features: BULL, control: { runtimeState: "DEGRADED" } }), featureQuality: 1 },
    ];
    const board = rankOpportunities(decisions);

    expect(board.topLong.map((r) => r.symbol)).toEqual(["BTC-PERP", "SOL-PERP"]); // 0.9 before 0.5
    expect(board.topShort.map((r) => r.symbol)).toEqual(["ETH-PERP"]);
    expect(board.watchlist.map((r) => r.symbol)).toEqual(["XRP-PERP"]);
    expect(board.blocked.map((r) => r.symbol)).toEqual(["ADA-PERP"]);
    expect(board.waiting.map((r) => r.symbol)).toEqual(["DOT-PERP"]);
    expect(board.total).toBe(6);
  });

  it("a directional INCOMPLETE decision lands ONLY in the watchlist (no double-count)", () => {
    // LONG signal but no fresh mark → overallStatus INCOMPLETE.
    const board = rankOpportunities([
      { decision: decision({ symbol: "BTC-PERP", side: "LONG", decision: "LONG", confidence: 0.9, features: BULL, price: null }), featureQuality: 1 },
    ]);
    expect(board.topLong).toHaveLength(0);
    expect(board.watchlist.map((r) => r.symbol)).toEqual(["BTC-PERP"]);
    // Exactly one bucket total.
    const all = [...board.topLong, ...board.topShort, ...board.watchlist, ...board.blocked, ...board.waiting];
    expect(all).toHaveLength(1);
  });

  it("higher confidence outranks lower within a bucket", () => {
    const board = rankOpportunities([
      { decision: decision({ symbol: "LOWER", side: "LONG", decision: "LONG", confidence: 0.4, features: BULL }), featureQuality: 1 },
      { decision: decision({ symbol: "HIGHER", side: "LONG", decision: "LONG", confidence: 0.95, features: BULL }), featureQuality: 1 },
    ]);
    expect(board.topLong[0]?.symbol).toBe("HIGHER");
    expect(board.topLong[0]!.rankScore).toBeGreaterThan(board.topLong[1]!.rankScore);
  });

  it("is deterministic", () => {
    const mk = () => [
      { decision: decision({ symbol: "B", side: "LONG", decision: "LONG", confidence: 0.6, features: BULL }), featureQuality: 1 },
      { decision: decision({ symbol: "A", side: "LONG", decision: "LONG", confidence: 0.6, features: BULL }), featureQuality: 1 },
    ];
    expect(rankOpportunities(mk())).toEqual(rankOpportunities(mk()));
  });
});
