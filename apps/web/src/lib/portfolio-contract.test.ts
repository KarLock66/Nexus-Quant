import { describe, expect, it } from "vitest";
import { PORTFOLIO_ENDPOINTS } from "./portfolio-client";

import * as summaryRoute from "../app/api/v1/portfolio/summary/route";
import * as exposureRoute from "../app/api/v1/portfolio/exposure/route";
import * as healthRoute from "../app/api/v1/portfolio/health/route";

/**
 * Phase 10C-2A Portfolio API contract: every route exists, is dynamic + node-runtime, and
 * exposes a GET handler. Surface-only — no handler is invoked, so no database is required
 * (mirrors the Phase 10C-1 trade-plan / 10A-1 trading-decision contract tests).
 */

const GET_ROUTES = [
  { name: "summary", mod: summaryRoute },
  { name: "exposure", mod: exposureRoute },
  { name: "health", mod: healthRoute },
] as const;

describe("portfolio API contract", () => {
  it("exposes the documented client endpoints", () => {
    expect(PORTFOLIO_ENDPOINTS.summary).toBe("/api/v1/portfolio/summary");
    expect(PORTFOLIO_ENDPOINTS.exposure).toBe("/api/v1/portfolio/exposure");
    expect(PORTFOLIO_ENDPOINTS.health).toBe("/api/v1/portfolio/health");
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
