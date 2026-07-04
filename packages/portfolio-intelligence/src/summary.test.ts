import { describe, expect, it } from "vitest";
import { buildPortfolioSummary } from "./summary.js";
import { makeFlatItem, makeInputs, makeLongItem, makeShortItem } from "./test-fixtures.js";

describe("buildPortfolioSummary", () => {
  it("produces the exposure + count + capital + risk top-line", () => {
    const s = buildPortfolioSummary(makeInputs());
    expect(s.currentExposure).toBe(20_000);
    expect(s.longExposure).toBe(10_000);
    expect(s.shortExposure).toBe(10_000);
    expect(s.netExposure).toBe(0);
    expect(s.openTrades).toBe(2);
    expect(s.readyTrades).toBe(2);
    expect(s.capitalUsed).toBe(20_000);
    expect(s.capitalAvailable).toBe(80_000);
    expect(s.assumedEquity).toBe(100_000);
    expect(s.status).toBe("HEALTHY");
  });

  it("counts blocked / waiting / flat buckets", () => {
    const s = buildPortfolioSummary(
      makeInputs({
        items: [
          makeLongItem(),
          makeShortItem({ controlStatus: "BLOCKED" }),
          makeFlatItem(),
          makeLongItem({ signalId: "w", overallStatus: "WAITING" }),
        ],
      }),
    );
    expect(s.openTrades).toBe(1);
    expect(s.blockedTrades).toBe(1);
    expect(s.flatTrades).toBe(1);
    expect(s.waitingTrades).toBe(1);
  });

  it("status reflects a hard block (kill switch)", () => {
    const s = buildPortfolioSummary(makeInputs({ killEngaged: true }));
    expect(s.status).toBe("BLOCKED");
  });

  it("is deterministic — identical inputs serialize identically", () => {
    expect(JSON.stringify(buildPortfolioSummary(makeInputs()))).toBe(
      JSON.stringify(buildPortfolioSummary(makeInputs())),
    );
  });

  it("fails closed for the empty portfolio (no NaN)", () => {
    const s = buildPortfolioSummary(makeInputs({ items: [] }));
    expect(s.currentExposure).toBe(0);
    expect(s.openTrades).toBe(0);
    expect(s.capitalAvailable).toBe(100_000);
    expect(s.status).toBe("HEALTHY");
  });
});
