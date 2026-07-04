import { describe, expect, it } from "vitest";
import { buildExecutionIntent } from "./intent.js";
import { closePosition, emptyPosition, openPosition, reducePosition } from "./positions.js";
import { makeDecision, makePlan, makeShortDecision, NOW } from "./test-fixtures.js";

const longIntent = () => buildExecutionIntent(makeDecision(), makePlan(makeDecision()), { now: NOW });
const shortIntent = () => buildExecutionIntent(makeShortDecision(), makePlan(makeShortDecision()), { now: NOW });

describe("positions — lifecycle", () => {
  it("empty position is NONE with verbatim stop/targets", () => {
    const p = emptyPosition(longIntent());
    expect(p.status).toBe("NONE");
    expect(p.quantity).toBe(0);
    expect(p.stop).toBe(97);
    expect(p.targets).toEqual([103, 106, 109]);
  });

  it("opens LONG with signed +quantity, SHORT with signed −quantity", () => {
    expect(openPosition(longIntent(), 0.6, 100, NOW).quantity).toBe(0.6);
    expect(openPosition(shortIntent(), 0.6, 100, NOW).quantity).toBe(-0.6);
  });

  it("reduces toward zero and CLOSES when nothing remains", () => {
    const open = openPosition(longIntent(), 1, 100, NOW);
    const r1 = reducePosition(open, 0.4, NOW + 1);
    expect(r1.status).toBe("REDUCING");
    expect(r1.quantity).toBeCloseTo(0.6, 8);
    const r2 = reducePosition(r1, 0.6, NOW + 2);
    expect(r2.status).toBe("CLOSED");
    expect(r2.quantity).toBe(0);
    expect(r2.closedAt).toBe(NOW + 2);
  });

  it("over-reduction is clamped (never a flipped/negative position)", () => {
    const open = openPosition(longIntent(), 1, 100, NOW);
    const r = reducePosition(open, 5, NOW + 1);
    expect(r.status).toBe("CLOSED");
    expect(r.quantity).toBe(0);
    expect(r.closedQuantity).toBe(1);
  });

  it("force-close zeroes exposure", () => {
    const open = openPosition(longIntent(), 1, 100, NOW);
    const c = closePosition(open, NOW + 9);
    expect(c.status).toBe("CLOSED");
    expect(c.quantity).toBe(0);
    expect(c.closedAt).toBe(NOW + 9);
  });
});
