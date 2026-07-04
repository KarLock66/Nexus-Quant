import { describe, expect, it } from "vitest";
import { buildTradingDecision } from "./decision.js";
import type {
  ControlContext,
  DecisionInputs,
  PriceObservation,
  RiskContext,
  SignalParams,
  SignalProjection,
} from "./types.js";

const PARAMS: SignalParams = { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 };

// Real bull vector (quant-generated) with a clean atr_14 for level math.
const BULL_FEATURES: Record<string, number> = {
  atr_14: 2.0,
  ema_20: 271.0,
  ema_50: 256.0,
  ema_200: 198.0,
  rsi_14: 80,
  realized_vol_30: 0.001,
  donchian_upper_20: 281.0,
  donchian_lower_20: 259.0,
  donchian_mid_20: 270.0,
  volume_zscore_100: 0.0,
};

const FLAT_FEATURES: Record<string, number> = {
  atr_14: 20.0,
  ema_20: 100.0,
  ema_50: 100.0,
  ema_200: 100.0,
  rsi_14: 50.0,
  realized_vol_30: 0.0,
  donchian_upper_20: 110.0,
  donchian_lower_20: 90.0,
  donchian_mid_20: 100.0,
  volume_zscore_100: 0.0,
};

function signal(over: Partial<SignalProjection> = {}): SignalProjection {
  return {
    id: "sig-1",
    symbol: "BTC-PERP",
    side: "LONG",
    decision: "LONG",
    confidence: 0.6834,
    featureHash: "fh-abc",
    datasetHash: "ds-abc",
    strategyVersionId: "sv-1",
    strategyParams: PARAMS,
    createdAt: "2026-06-26T00:00:00.000Z",
    ...over,
  };
}

const RISK: RiskContext = {
  assumedEquity: 100_000,
  riskFraction: 0.01,
  leverage: 3,
  maxNotional: 750_000,
  systemRiskMode: "NORMAL",
};

const CONTROL_OK: ControlContext = {
  permission: "ALLOWED",
  runtimeState: "HEALTHY",
  killEngaged: false,
  blockedReasons: [],
};

const PRICE: PriceObservation = { price: 270, ts: "2026-06-26T00:00:00.000Z", source: "markPrice" };

function inputs(over: Partial<DecisionInputs> = {}): DecisionInputs {
  return {
    now: Date.parse("2026-06-26T00:00:30.000Z"), // 30s after signal
    signal: signal(),
    features: BULL_FEATURES,
    featureTs: "2026-06-26T00:00:00.000Z",
    timeframe: "H1",
    dqScore: 100,
    price: PRICE,
    liquidity: { spreadBps: 2, depthUsd: 500_000, ts: "2026-06-26T00:00:00.000Z" },
    risk: RISK,
    control: CONTROL_OK,
    ...over,
  };
}

describe("buildTradingDecision — verbatim signal passthrough (single source of truth)", () => {
  it("copies decision/bias/confidence/hashes byte-for-byte from the EngineSignal", () => {
    const d = buildTradingDecision(inputs());
    expect(d.direction).toBe("LONG");
    expect(d.bias).toBe("LONG");
    expect(d.confidence).toBe(0.6834);
    expect(d.featureHash).toBe("fh-abc");
    expect(d.datasetHash).toBe("ds-abc");
    expect(d.strategyVersionId).toBe("sv-1");
    expect(d.signalAgeSeconds).toBe(30);
    expect(d.featureAgeSeconds).toBe(30);
  });
});

describe("buildTradingDecision — entry/stop/target (Section B)", () => {
  it("derives ATR-based levels for a LONG, with real provenance on price", () => {
    const d = buildTradingDecision(inputs());
    expect(d.currentPrice.value).toBe(270);
    expect(d.currentPrice.provenance).toBe("real");
    expect(d.entryPrice.value).toBe(270);
    // stop = 270 - 1.5*2 = 267, tp1 = 270 + 1.5*2 = 273, tp2 = 276, tp3 = 279
    expect(d.stopLoss.value).toBe(267);
    expect(d.takeProfit1.value).toBe(273);
    expect(d.takeProfit2.value).toBe(276);
    expect(d.takeProfit3.value).toBe(279);
    expect(d.stopLoss.provenance).toBe("derived");
    // RR = (273-270)/(270-267) = 1.0
    expect(d.riskRewardRatio.value).toBe(1);
  });

  it("mirrors stops/targets for a SHORT", () => {
    const d = buildTradingDecision(
      inputs({ signal: signal({ side: "SHORT", decision: "SHORT" }) }),
    );
    expect(d.stopLoss.value).toBe(273); // 270 + 1.5*2
    expect(d.takeProfit1.value).toBe(267); // 270 - 1.5*2
  });
});

describe("buildTradingDecision — fail-closed (no fabrication)", () => {
  it("no fresh mark → price-dependent fields unavailable, overall INCOMPLETE", () => {
    const d = buildTradingDecision(inputs({ price: null }));
    expect(d.currentPrice.value).toBeNull();
    expect(d.currentPrice.provenance).toBe("unavailable");
    expect(d.entryPrice.value).toBeNull();
    expect(d.stopLoss.value).toBeNull();
    expect(d.positionSize.value).toBeNull();
    expect(d.overallStatus).toBe("INCOMPLETE");
    expect(d.provenanceNotes).toContain("current mark unavailable — price-dependent fields not computed");
  });

  it("FLAT signal → no levels/size, overall NO_TRADE", () => {
    const d = buildTradingDecision(
      inputs({ signal: signal({ side: "FLAT", decision: "FLAT", confidence: 0 }), features: FLAT_FEATURES }),
    );
    expect(d.entryPrice.value).toBeNull();
    expect(d.stopLoss.value).toBeNull();
    expect(d.positionSize.value).toBeNull();
    expect(d.overallStatus).toBe("NO_TRADE");
  });

  it("missing atr_14 → levels unavailable even with a fresh mark", () => {
    const { atr_14, ...noAtr } = BULL_FEATURES;
    void atr_14;
    const d = buildTradingDecision(inputs({ features: noAtr }));
    expect(d.entryPrice.value).toBe(270); // entry is the mark itself
    expect(d.stopLoss.value).toBeNull();
    expect(d.takeProfit1.value).toBeNull();
  });

  it("missing scores feature → that score unavailable, never NaN", () => {
    const { rsi_14, ...noRsi } = BULL_FEATURES;
    void rsi_14;
    const d = buildTradingDecision(inputs({ features: noRsi }));
    expect(d.momentumScore.value).toBeNull();
    expect(d.momentumScore.provenance).toBe("unavailable");
  });

  it("no liquidity snapshot → liquidityScore unavailable (volume z-score never substituted)", () => {
    const d = buildTradingDecision(inputs({ liquidity: null }));
    expect(d.liquidityScore.value).toBeNull();
    expect(d.provenanceNotes).toContain("liquidity unavailable — no order-book/liquidity snapshot");
  });
});

describe("buildTradingDecision — sizing (assumed equity)", () => {
  it("computes RISK_PER_TRADE size and labels the equity assumption", () => {
    const d = buildTradingDecision(inputs());
    // riskAmount = 100000*0.01 = 1000; stopDistance = |270-267| = 3; qty = 333.33333333
    expect(d.positionSize.value).toBeCloseTo(333.33333333, 6);
    expect(d.positionNotional.value).toBeCloseTo(90000, 2); // 333.333*270
    expect(d.capitalRiskPercent.value).toBe(1);
    expect(d.assumedEquity).toBe(100000);
    expect(d.provenanceNotes.some((n) => n.includes("assumes equity"))).toBe(true);
  });
});

describe("buildTradingDecision — statuses (fail-closed)", () => {
  it("control ALLOWED + HEALTHY → READY / ACTIONABLE", () => {
    const d = buildTradingDecision(inputs());
    expect(d.controlStatus).toBe("ALLOWED");
    expect(d.executionStatus).toBe("READY");
    expect(d.riskStatus.status).toBe("APPROVED");
    expect(d.overallStatus).toBe("ACTIONABLE");
  });

  it("kill engaged → control + overall BLOCKED", () => {
    const d = buildTradingDecision(
      inputs({ control: { ...CONTROL_OK, killEngaged: true } }),
    );
    expect(d.controlStatus).toBe("BLOCKED");
    expect(d.executionStatus).toBe("BLOCKED");
    expect(d.overallStatus).toBe("BLOCKED");
  });

  it("permission null (control off) → UNKNOWN, never an ALLOWED default", () => {
    const d = buildTradingDecision(
      inputs({ control: { permission: null, runtimeState: null, killEngaged: false, blockedReasons: [] } }),
    );
    expect(d.controlStatus).toBe("UNKNOWN");
    expect(d.executionStatus).toBe("UNKNOWN");
    expect(d.overallStatus).toBe("WAITING");
  });

  it("system risk mode FROZEN → riskStatus BLOCKED", () => {
    const d = buildTradingDecision(inputs({ risk: { ...RISK, systemRiskMode: "FROZEN" } }));
    expect(d.riskStatus.status).toBe("BLOCKED");
    expect(d.overallStatus).toBe("BLOCKED");
  });

  it("runtime DEGRADED → execution WAITING", () => {
    const d = buildTradingDecision(
      inputs({ control: { ...CONTROL_OK, runtimeState: "DEGRADED" } }),
    );
    expect(d.executionStatus).toBe("WAITING");
    expect(d.overallStatus).toBe("WAITING");
  });
});

describe("buildTradingDecision — regime + holding time + determinism", () => {
  it("derives a regime (never PANIC/EUPHORIA) and labels it as derived", () => {
    const d = buildTradingDecision(inputs());
    expect(d.marketRegime.regime).toBe("TRENDING_BULL");
    expect(d.marketRegime.provenance).toBe("derived");
    expect(["PANIC", "EUPHORIA"]).not.toContain(d.marketRegime.regime);
  });

  it("estimates holding time from timeframe and labels it estimated", () => {
    const d = buildTradingDecision(inputs());
    expect(d.expectedHoldingTime.provenance).toBe("estimated");
    expect(d.expectedHoldingTime.seconds).toBe(3600 * 20); // H1 × 20 bars
  });

  it("is deterministic: identical inputs → identical output", () => {
    const a = buildTradingDecision(inputs());
    const b = buildTradingDecision(inputs());
    expect(a).toEqual(b);
  });

  it("confidence breakdown mirrors the sealed 0.5/0.5 directional blend", () => {
    const d = buildTradingDecision(inputs());
    const bd = d.explain.confidenceBreakdown;
    expect(bd.trendComponent).not.toBeNull();
    expect(bd.momentumComponent).not.toBeNull();
    expect(bd.total).toBe(0.6834);
  });
});
