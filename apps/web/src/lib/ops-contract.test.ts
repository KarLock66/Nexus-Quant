import { describe, expect, it } from "vitest";
import { OPS_ENDPOINTS } from "./ops-client";

import * as healthRoute from "../app/api/v1/ops/health/route";
import * as dataFlowRoute from "../app/api/v1/ops/data-flow/route";
import * as pipelineRoute from "../app/api/v1/ops/pipeline/route";
import * as alertsRoute from "../app/api/v1/ops/alerts/route";
import * as metricsRoute from "../app/api/v1/ops/metrics/route";
import * as actionsRoute from "../app/api/v1/ops/actions/route";

/**
 * API contract (Section I): the observability routes exist, are dynamic +
 * node-runtime (Prisma / node:net), and expose the expected handlers. We assert
 * the surface WITHOUT invoking handlers, so no database is required.
 */

const GET_ROUTES = [
  { name: "health", mod: healthRoute, path: "/api/v1/ops/health" },
  { name: "data-flow", mod: dataFlowRoute, path: "/api/v1/ops/data-flow" },
  { name: "pipeline", mod: pipelineRoute, path: "/api/v1/ops/pipeline" },
  { name: "alerts", mod: alertsRoute, path: "/api/v1/ops/alerts" },
  { name: "metrics", mod: metricsRoute, path: "/api/v1/ops/metrics" },
  { name: "actions", mod: actionsRoute, path: "/api/v1/ops/actions" },
] as const;

describe("ops observability API contract", () => {
  it("exposes all six client endpoints at the documented paths", () => {
    expect(OPS_ENDPOINTS.health).toBe("/api/v1/ops/health");
    expect(OPS_ENDPOINTS.dataFlow).toBe("/api/v1/ops/data-flow");
    expect(OPS_ENDPOINTS.pipeline).toBe("/api/v1/ops/pipeline");
    expect(OPS_ENDPOINTS.alerts).toBe("/api/v1/ops/alerts");
    expect(OPS_ENDPOINTS.metrics).toBe("/api/v1/ops/metrics");
    expect(OPS_ENDPOINTS.actions).toBe("/api/v1/ops/actions");
  });

  it.each(GET_ROUTES.map((r) => [r.name, r] as const))(
    "%s route is force-dynamic, node runtime, and exports GET",
    (_name, route) => {
      expect(route.mod.dynamic).toBe("force-dynamic");
      expect(route.mod.runtime).toBe("nodejs");
      expect(typeof (route.mod as { GET?: unknown }).GET).toBe("function");
    },
  );

  it("actions route additionally exports a POST handler", () => {
    expect(typeof (actionsRoute as { POST?: unknown }).POST).toBe("function");
  });
});
