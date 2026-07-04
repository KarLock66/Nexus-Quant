import { describe, expect, it } from "vitest";
import { DECISION_ENDPOINTS } from "./trading-decision-client";

import * as decisionsRoute from "../app/api/v1/signals/decisions/route";
import * as rankingRoute from "../app/api/v1/signals/ranking/route";
import * as consensusRoute from "../app/api/v1/signals/consensus/route";

/**
 * Phase 10A-1 Trading Decision API contract (Section J/K): every route exists, is
 * dynamic + node-runtime, and exposes a GET handler. Surface-only — no handler is
 * invoked, so no database is required.
 */

const GET_ROUTES = [
  { name: "decisions", mod: decisionsRoute },
  { name: "ranking", mod: rankingRoute },
  { name: "consensus", mod: consensusRoute },
] as const;

describe("trading decision API contract", () => {
  it("exposes the documented client endpoints", () => {
    expect(DECISION_ENDPOINTS.decisions).toBe("/api/v1/signals/decisions");
    expect(DECISION_ENDPOINTS.ranking).toBe("/api/v1/signals/ranking");
    expect(DECISION_ENDPOINTS.consensus).toBe("/api/v1/signals/consensus");
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
