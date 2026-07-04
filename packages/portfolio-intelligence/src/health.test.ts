import { describe, expect, it } from "vitest";
import { buildPortfolioHealth } from "./health.js";
import { buildPortfolioSummary } from "./summary.js";
import { makeInputs, makeLongItem } from "./test-fixtures.js";

const notion = (n: number) => ({ positionNotional: { value: n, provenance: "derived" as const, basis: "x" } });

describe("buildPortfolioHealth — precedence", () => {
  it("HEALTHY for a small, balanced, all-green book", () => {
    const h = buildPortfolioHealth(makeInputs());
    expect(h.status).toBe("HEALTHY");
  });

  it("BLOCKED when the kill switch is engaged (highest precedence)", () => {
    expect(buildPortfolioHealth(makeInputs({ killEngaged: true })).status).toBe("BLOCKED");
  });

  it("BLOCKED when control is BLOCKED", () => {
    expect(buildPortfolioHealth(makeInputs({ controlPermission: "BLOCKED" })).status).toBe("BLOCKED");
  });

  it("BLOCKED when runtime is not HEALTHY", () => {
    expect(buildPortfolioHealth(makeInputs({ runtimeState: "DEGRADED" })).status).toBe("BLOCKED");
  });

  it("RISK when risk exceeds budget (over-leveraged single name)", () => {
    // one position with a huge maxLoss via a wide stop → risk over the 10% budget
    const item = makeLongItem({
      positionSize: { value: 5000, provenance: "derived", basis: "x" },
      stopLoss: { value: 90, provenance: "derived", basis: "x" }, // |100-90|*5000 = 50k > 10k budget
    });
    const h = buildPortfolioHealth(makeInputs({ items: [item] }));
    expect(h.status).toBe("RISK");
  });

  it("CAUTION when heat is HOT but no hard block / critical", () => {
    const h = buildPortfolioHealth(makeInputs({ items: [makeLongItem(notion(95_000))] }));
    // 95% capital + full concentration + full skew → HOT range, no block
    expect(["CAUTION", "RISK"]).toContain(h.status);
  });

  it("status agrees with the summary by construction", () => {
    const inp = makeInputs({ killEngaged: true });
    expect(buildPortfolioHealth(inp).status).toBe(buildPortfolioSummary(inp).status);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildPortfolioHealth(makeInputs()))).toBe(JSON.stringify(buildPortfolioHealth(makeInputs())));
  });
});
