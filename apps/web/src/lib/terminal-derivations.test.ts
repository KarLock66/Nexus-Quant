import { describe, expect, it } from "vitest";
import {
  ATR_STOP_MULT,
  STALE_AFTER_MS,
  dataQualityBand,
  distanceToEntry,
  distanceToTarget,
  entryZone,
  meterPct,
  panelLiveStatus,
  riskRewardBar,
  setupGrade,
  sortRanked,
  tpProgressPct,
  winProbability,
} from "./terminal-derivations";
import { m, na, makeDecision, makeFlat, makeRankedRow as rr } from "./terminal-fixtures";

/* ─────────────────── setup grade ─────────────────── */

describe("setupGrade", () => {
  it("grades a strong directional setup A+ with derived provenance", () => {
    const g = setupGrade(makeDecision());
    expect(g.grade).toBe("A+");
    expect(g.score).toBeGreaterThanOrEqual(90);
    expect(g.provenance).toBe("derived");
    // 35*0.9 + 25*1 + 15*0.9 + 10*0.8 + 5*0.8 + 10 = 92
    expect(g.score).toBeCloseTo(92, 5);
  });

  it("grades a FLAT signal F with a zero composite", () => {
    const g = setupGrade(makeFlat());
    expect(g.grade).toBe("F");
    expect(g.score).toBe(0);
    expect(g.provenance).toBe("derived");
  });

  it("is deterministic — identical inputs produce identical output", () => {
    expect(setupGrade(makeDecision())).toEqual(setupGrade(makeDecision()));
  });

  it("never produces NaN when scores are unavailable", () => {
    const g = setupGrade(
      makeDecision({ trendStrength: na(), momentumScore: na(), liquidityScore: na(), riskRewardRatio: na() }),
    );
    expect(Number.isFinite(g.score)).toBe(true);
    expect(g.components.trend).toBe(0);
    expect(g.components.riskReward).toBe(0);
  });

  it("gives zero R:R credit below 1.0 and full credit at/above 3.0", () => {
    expect(setupGrade(makeDecision({ riskRewardRatio: m(0.8) })).components.riskReward).toBe(0);
    expect(setupGrade(makeDecision({ riskRewardRatio: m(5) })).components.riskReward).toBe(25);
  });

  it("only ever returns one of the six allowed letters", () => {
    const allowed = new Set(["A+", "A", "B", "C", "D", "F"]);
    for (const conf of [0, 0.2, 0.4, 0.55, 0.7, 0.85, 1]) {
      expect(allowed.has(setupGrade(makeDecision({ confidence: conf })).grade)).toBe(true);
    }
  });
});

/* ─────────────────── win probability ─────────────────── */

describe("winProbability", () => {
  it("returns a bounded ESTIMATE for a directional setup", () => {
    const p = winProbability(makeDecision());
    expect(p.provenance).toBe("estimated");
    expect(p.value).not.toBeNull();
    expect(p.value!).toBeGreaterThanOrEqual(40);
    expect(p.value!).toBeLessThanOrEqual(85);
    expect(p.basis).toMatch(/not a backtested or historical win rate/i);
  });

  it("is unavailable for a FLAT signal (no setup)", () => {
    const p = winProbability(makeFlat());
    expect(p.value).toBeNull();
    expect(p.provenance).toBe("unavailable");
  });

  it("is monotonic in confidence", () => {
    const lo = winProbability(makeDecision({ confidence: 0.2 })).value!;
    const hi = winProbability(makeDecision({ confidence: 0.95 })).value!;
    expect(hi).toBeGreaterThan(lo);
  });

  it("counts missing trend/momentum as zero without NaN", () => {
    const p = winProbability(makeDecision({ trendStrength: na(), momentumScore: na() }));
    expect(Number.isFinite(p.value!)).toBe(true);
  });
});

/* ─────────────────── entry zone ─────────────────── */

describe("entryZone", () => {
  it("derives a symmetric band from the served levels", () => {
    const z = entryZone(makeDecision()); // entry 100, stop 97 → risk 3, ATR = 3/1.5 = 2, half = 1
    expect(z.provenance).toBe("derived");
    expect(z.atr).toBeCloseTo(3 / ATR_STOP_MULT, 5);
    expect(z.low).toBe(99);
    expect(z.high).toBe(101);
    expect(z.mid).toBe(100);
    expect(z.currentDistancePct).toBe(0); // entry == current mark
  });

  it("is unavailable when entry/stop are missing", () => {
    const z = entryZone(makeDecision({ entryPrice: na(), stopLoss: na() }));
    expect(z.provenance).toBe("unavailable");
    expect(z.low).toBeNull();
    expect(z.high).toBeNull();
    expect(z.atr).toBeNull();
  });

  it("never yields NaN bounds", () => {
    const z = entryZone(makeFlat());
    for (const v of [z.low, z.high, z.mid, z.atr, z.widthPct]) {
      expect(v === null || Number.isFinite(v)).toBe(true);
    }
  });
});

/* ─────────────────── distances ─────────────────── */

describe("distances", () => {
  it("distance to entry is ~0 (entry == mark) and to target is the TP1 move", () => {
    const d = makeDecision();
    expect(distanceToEntry(d).value).toBe(0);
    expect(distanceToTarget(d).value).toBe(3); // (103-100)/100*100
  });

  it("fails closed when prices are missing", () => {
    const d = makeDecision({ takeProfit1: na(), currentPrice: na() });
    expect(distanceToTarget(d).provenance).toBe("unavailable");
    expect(distanceToTarget(d).value).toBeNull();
  });
});

/* ─────────────────── risk/reward + progress geometry ─────────────────── */

describe("riskRewardBar", () => {
  it("returns proportional fractions of the risk→TP3 span", () => {
    const b = riskRewardBar(makeDecision())!; // risk 3, r1 3, r2 6, r3 9, span 12
    expect(b.riskFrac).toBeCloseTo(0.25, 5);
    expect(b.tp1Frac).toBeCloseTo(0.25, 5);
    expect(b.tp2Frac).toBeCloseTo(0.5, 5);
    expect(b.tp3Frac).toBeCloseTo(0.75, 5);
  });

  it("is null when any level is missing", () => {
    expect(riskRewardBar(makeDecision({ takeProfit3: na() }))).toBeNull();
    expect(riskRewardBar(makeFlat())).toBeNull();
  });
});

describe("tpProgressPct", () => {
  it("starts at 0 (mark == entry) and clamps to 100 past TP3", () => {
    expect(tpProgressPct(makeDecision())).toBe(0);
    expect(tpProgressPct(makeDecision({ currentPrice: m(104.5, "real") }))).toBe(50);
    expect(tpProgressPct(makeDecision({ currentPrice: m(200, "real") }))).toBe(100);
  });

  it("is direction-aware for shorts", () => {
    const short = makeDecision({
      direction: "SHORT",
      entryPrice: m(100, "real"),
      takeProfit3: m(91),
      currentPrice: m(95.5, "real"),
    });
    expect(tpProgressPct(short)).toBe(50);
  });

  it("is null when levels are missing", () => {
    expect(tpProgressPct(makeFlat())).toBeNull();
  });
});

/* ─────────────────── data quality band ─────────────────── */

describe("dataQualityBand", () => {
  it.each([
    [98, "EXCELLENT"],
    [90, "GOOD"],
    [75, "FAIR"],
    [50, "POOR"],
  ])("bands score %d as %s", (score, label) => {
    const dq = dataQualityBand(score);
    expect(dq.label).toBe(label);
    expect(dq.provenance).toBe("real");
  });

  it("is UNKNOWN/unavailable for null", () => {
    const dq = dataQualityBand(null);
    expect(dq.label).toBe("UNKNOWN");
    expect(dq.provenance).toBe("unavailable");
    expect(dq.score).toBeNull();
  });
});

/* ─────────────────── meter scaling ─────────────────── */

describe("meterPct", () => {
  it("scales and clamps 0..100", () => {
    expect(meterPct(50, 100)).toBe(50);
    expect(meterPct(150, 100)).toBe(100);
    expect(meterPct(-5, 100)).toBe(0);
    expect(meterPct(null, 100)).toBe(0);
    expect(meterPct(5, 0)).toBe(0);
  });
});

/* ─────────────────── per-panel live status ─────────────────── */

describe("panelLiveStatus", () => {
  const now = 1_000_000;
  const fresh = now - 1000;

  it("is UNAVAILABLE without data", () => {
    expect(panelLiveStatus({ nowMs: now, lastUpdated: fresh, hasError: false, hasData: false })).toBe("UNAVAILABLE");
  });

  it("is LIVE when fresh and actionable", () => {
    expect(
      panelLiveStatus({ nowMs: now, lastUpdated: fresh, hasError: false, hasData: true, decision: makeDecision() }),
    ).toBe("LIVE");
  });

  it("is STALE when the poll has gone cold", () => {
    expect(
      panelLiveStatus({ nowMs: now, lastUpdated: now - STALE_AFTER_MS - 1, hasError: false, hasData: true, decision: makeDecision() }),
    ).toBe("STALE");
  });

  it("surfaces BLOCKED and WAITING decision states when fresh", () => {
    expect(
      panelLiveStatus({ nowMs: now, lastUpdated: fresh, hasError: false, hasData: true, decision: makeDecision({ overallStatus: "BLOCKED" }) }),
    ).toBe("BLOCKED");
    expect(
      panelLiveStatus({ nowMs: now, lastUpdated: fresh, hasError: false, hasData: true, decision: makeDecision({ overallStatus: "WAITING" }) }),
    ).toBe("WAITING");
  });

  it("is UNAVAILABLE on first error before any successful poll", () => {
    expect(panelLiveStatus({ nowMs: now, lastUpdated: null, hasError: true, hasData: true })).toBe("UNAVAILABLE");
  });
});

/* ─────────────────── ranked sort ─────────────────── */

describe("sortRanked", () => {
  it("sorts by confidence descending", () => {
    const rows = [rr({ symbol: "A", confidence: 0.2 }), rr({ symbol: "B", confidence: 0.9 })];
    expect(sortRanked(rows, "confidence").map((r) => r.symbol)).toEqual(["B", "A"]);
  });

  it("sorts by signal age ascending (freshest first), nulls last", () => {
    const rows = [
      rr({ symbol: "OLD", signalAgeSeconds: 100 }),
      rr({ symbol: "NEW", signalAgeSeconds: 5 }),
      rr({ symbol: "NONE", signalAgeSeconds: null }),
    ];
    expect(sortRanked(rows, "signalAge").map((r) => r.symbol)).toEqual(["NEW", "OLD", "NONE"]);
  });

  it("nulls sort last for descending value keys too", () => {
    const rows = [rr({ symbol: "HAS", riskReward: 3 }), rr({ symbol: "NULL", riskReward: null })];
    expect(sortRanked(rows, "riskReward").map((r) => r.symbol)).toEqual(["HAS", "NULL"]);
  });

  it("breaks ties deterministically by symbol then timeframe", () => {
    const rows = [rr({ symbol: "Z", confidence: 0.5 }), rr({ symbol: "A", confidence: 0.5 })];
    expect(sortRanked(rows, "confidence").map((r) => r.symbol)).toEqual(["A", "Z"]);
  });

  it("does not mutate the input array", () => {
    const rows = [rr({ symbol: "A", confidence: 0.1 }), rr({ symbol: "B", confidence: 0.9 })];
    const before = rows.map((r) => r.symbol);
    sortRanked(rows, "confidence");
    expect(rows.map((r) => r.symbol)).toEqual(before);
  });
});
