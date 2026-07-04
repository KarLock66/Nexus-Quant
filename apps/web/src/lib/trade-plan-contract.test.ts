import { describe, expect, it } from "vitest";
import { TRADE_PLAN_ENDPOINTS } from "./trade-plan-client";

import * as tradePlanRoute from "../app/api/v1/signals/trade-plan/route";
import * as readinessRoute from "../app/api/v1/signals/readiness/route";

/**
 * Phase 10C-1 Trade-Plan API contract (Section J/K): every route exists, is dynamic +
 * node-runtime, and exposes a GET handler. Surface-only — no handler is invoked, so no
 * database is required (mirrors the Phase 10A-1 trading-decision contract test).
 */

const GET_ROUTES = [
  { name: "trade-plan", mod: tradePlanRoute },
  { name: "readiness", mod: readinessRoute },
] as const;

describe("trade-plan API contract", () => {
  it("exposes the documented client endpoints", () => {
    expect(TRADE_PLAN_ENDPOINTS.tradePlan).toBe("/api/v1/signals/trade-plan");
    expect(TRADE_PLAN_ENDPOINTS.readiness).toBe("/api/v1/signals/readiness");
  });

  it.each(GET_ROUTES.map((r) => [r.name, r] as const))(
    "%s route is force-dynamic, node runtime, and exports GET",
    (_name, route) => {
      expect((route.mod as { dynamic?: unknown }).dynamic).toBe("force-dynamic");
      expect((route.mod as { runtime?: unknown }).runtime).toBe("nodejs");
      expect(typeof (route.mod as { GET?: unknown }).GET).toBe("function");
    },
  );
});
