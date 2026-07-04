import { describe, expect, it } from "vitest";
import { buildDecisionSummary } from "./summary.js";
import { makeDecision, makeInputs } from "./test-fixtures.js";
import { m } from "./test-fixtures.js";

/**
 * Section A — Decision Summary. Every action branch is reachable and deterministic;
 * canTrade reflects the gates; shouldTrade is true only for the directional BUY/SELL set.
 */

describe("buildDecisionSummary — action verdict", () => {
  it("STRONG_BUY for an actionable, top-tier LONG", () => {
    const s = buildDecisionSummary(makeInputs());
    expect(s.action).toBe("STRONG_BUY");
    expect(s.canTrade).toBe(true);
    expect(s.shouldTrade).toBe(true);
    expect(s.why.length).toBeGreaterThan(0);
  });

  it("BUY for an actionable mid-tier LONG (strong conviction, weak R:R)", () => {
    const s = buildDecisionSummary(makeInputs({ decision: makeDecision({ riskRewardRatio: m(1.5) }) }));
    expect(s.action).toBe("BUY");
    expect(s.shouldTrade).toBe(true);
  });

  it("WATCH for an actionable LONG with weak conviction and weak R:R", () => {
    const s = buildDecisionSummary(
      makeInputs({ decision: makeDecision({ confidence: 0.6, riskRewardRatio: m(1.5) }) }),
    );
    expect(s.action).toBe("WATCH");
    expect(s.shouldTrade).toBe(false);
    expect(s.canTrade).toBe(true); // gates permit; conviction just below threshold
  });

  it("STRONG_SELL for an actionable, top-tier SHORT", () => {
    const s = buildDecisionSummary(
      makeInputs({ decision: makeDecision({ direction: "SHORT", bias: "SHORT" }) }),
    );
    expect(s.action).toBe("STRONG_SELL");
    expect(s.shouldTrade).toBe(true);
  });

  it("SELL for an actionable mid-tier SHORT", () => {
    const s = buildDecisionSummary(
      makeInputs({ decision: makeDecision({ direction: "SHORT", bias: "SHORT", riskRewardRatio: m(1.5) }) }),
    );
    expect(s.action).toBe("SELL");
    expect(s.shouldTrade).toBe(true);
  });

  it("WAIT when not yet actionable (WAITING) but not hard-blocked", () => {
    const s = buildDecisionSummary(makeInputs({ decision: makeDecision({ overallStatus: "WAITING" }) }));
    expect(s.action).toBe("WAIT");
    expect(s.canTrade).toBe(false);
    expect(s.shouldTrade).toBe(false);
  });

  it("WAIT when actionable but data is stale", () => {
    const s = buildDecisionSummary(
      makeInputs({ decision: makeDecision({ signalAgeSeconds: 99_999 }) }),
    );
    expect(s.action).toBe("WAIT");
  });

  it("NO_TRADE for a FLAT signal", () => {
    const s = buildDecisionSummary(makeInputs({ decision: makeDecision({ direction: "FLAT", bias: "FLAT", overallStatus: "NO_TRADE" }) }));
    expect(s.action).toBe("NO_TRADE");
    expect(s.shouldTrade).toBe(false);
  });

  it("NO_TRADE + cannot trade when control is BLOCKED", () => {
    const s = buildDecisionSummary(makeInputs({ decision: makeDecision({ controlStatus: "BLOCKED" }) }));
    expect(s.action).toBe("NO_TRADE");
    expect(s.canTrade).toBe(false);
    expect(s.why.some((w) => /control/i.test(w))).toBe(true);
  });

  it("NO_TRADE + cannot trade when the kill switch is engaged", () => {
    const s = buildDecisionSummary(makeInputs({ killEngaged: true }));
    expect(s.action).toBe("NO_TRADE");
    expect(s.canTrade).toBe(false);
    expect(s.why.some((w) => /kill/i.test(w))).toBe(true);
  });

  it("is deterministic — identical inputs serialize identically", () => {
    const a = JSON.stringify(buildDecisionSummary(makeInputs()));
    const b = JSON.stringify(buildDecisionSummary(makeInputs()));
    expect(a).toBe(b);
  });
});
