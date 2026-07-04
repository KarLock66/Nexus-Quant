import { describe, expect, it } from "vitest";
import {
  STREAM_THRESHOLDS,
  deriveStageState,
  freshnessFromLag,
  worstFreshness,
  worstStageState,
} from "./ops-freshness";

describe("freshnessFromLag (staleness detection)", () => {
  it("classifies lag below the warning edge as fresh", () => {
    expect(freshnessFromLag(0, 30, 120)).toBe("fresh");
    expect(freshnessFromLag(30, 30, 120)).toBe("fresh"); // inclusive lower edge
  });

  it("classifies lag in the warning band", () => {
    expect(freshnessFromLag(31, 30, 120)).toBe("warning");
    expect(freshnessFromLag(120, 30, 120)).toBe("warning");
  });

  it("classifies lag past the stale edge as stale", () => {
    expect(freshnessFromLag(121, 30, 120)).toBe("stale");
    expect(freshnessFromLag(9999, 30, 120)).toBe("stale");
  });

  it("treats null (no data observed) as unknown — never a false 'fresh'", () => {
    expect(freshnessFromLag(null, 30, 120)).toBe("unknown");
  });

  it("matches the Section B live-feed band (30s / 120s) for ticks-class streams", () => {
    const tick = STREAM_THRESHOLDS.find((s) => s.key === "marketTick")!;
    expect(tick.warningSec).toBe(30);
    expect(tick.staleSec).toBe(60); // aligns with the Section E "no ticks > 60s" rule
  });
});

describe("worstFreshness", () => {
  it("returns the worst band, ranking unknown above fresh but below warning", () => {
    expect(worstFreshness(["fresh", "fresh"])).toBe("fresh");
    expect(worstFreshness(["fresh", "warning"])).toBe("warning");
    expect(worstFreshness(["warning", "stale"])).toBe("stale");
    expect(worstFreshness(["fresh", "unknown"])).toBe("unknown");
    expect(worstFreshness(["unknown", "warning"])).toBe("warning");
  });
});

describe("deriveStageState (pipeline health)", () => {
  const now = 1_000_000_000_000;
  const at = (secAgo: number) => new Date(now - secAgo * 1000);

  it("is empty when nothing was ever produced", () => {
    expect(
      deriveStageState({ lastEventAt: null, count24h: 0, errorCount: 0, freshSec: 60, staleSec: 600, now }),
    ).toBe("empty");
  });

  it("is active when produced within the fresh window", () => {
    expect(
      deriveStageState({ lastEventAt: at(10), count24h: 5, errorCount: 0, freshSec: 60, staleSec: 600, now }),
    ).toBe("active");
  });

  it("is idle when quiet but within the stale window", () => {
    expect(
      deriveStageState({ lastEventAt: at(300), count24h: 5, errorCount: 0, freshSec: 60, staleSec: 600, now }),
    ).toBe("idle");
  });

  it("is failing when very stale past the stale window", () => {
    expect(
      deriveStageState({ lastEventAt: at(700), count24h: 5, errorCount: 0, freshSec: 60, staleSec: 600, now }),
    ).toBe("failing");
  });

  it("is degraded when producing but with recent errors", () => {
    expect(
      deriveStageState({ lastEventAt: at(10), count24h: 5, errorCount: 2, freshSec: 60, staleSec: 600, now }),
    ).toBe("degraded");
  });

  it("escalates to failing when errors AND nothing fresh", () => {
    expect(
      deriveStageState({ lastEventAt: at(700), count24h: 5, errorCount: 2, freshSec: 60, staleSec: 600, now }),
    ).toBe("failing");
  });
});

describe("worstStageState", () => {
  it("ranks failing as the worst and active as the best", () => {
    expect(worstStageState(["active", "idle"])).toBe("idle");
    expect(worstStageState(["active", "degraded"])).toBe("degraded");
    expect(worstStageState(["idle", "failing", "active"])).toBe("failing");
    expect(worstStageState([])).toBe("unknown");
  });
});
