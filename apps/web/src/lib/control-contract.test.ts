import { describe, expect, it } from "vitest";
import { CONTROL_ENDPOINTS } from "./control-client";

import * as runtimeStateRoute from "../app/api/v1/control/runtime-state/route";
import * as permissionRoute from "../app/api/v1/control/permission/route";
import * as protectionRoute from "../app/api/v1/control/protection/route";
import * as recoveryRoute from "../app/api/v1/control/recovery/route";
import * as runbooksRoute from "../app/api/v1/control/runbooks/route";
import * as incidentsRoute from "../app/api/v1/control/incidents/route";
import * as auditRoute from "../app/api/v1/control/audit/route";
import * as killRoute from "../app/api/v1/control/kill/route";
import * as resumeRoute from "../app/api/v1/control/resume/route";

/**
 * Phase 9.7 control-plane API contract (Section J/K): every route exists, is dynamic +
 * node-runtime, and exposes the expected handler. Surface-only — no handler is invoked,
 * so no database is required.
 */

const GET_ROUTES = [
  { name: "runtime-state", mod: runtimeStateRoute },
  { name: "permission", mod: permissionRoute },
  { name: "protection", mod: protectionRoute },
  { name: "recovery", mod: recoveryRoute },
  { name: "runbooks", mod: runbooksRoute },
  { name: "incidents", mod: incidentsRoute },
  { name: "audit", mod: auditRoute },
] as const;

describe("control plane API contract", () => {
  it("exposes all nine client endpoints at the documented paths", () => {
    expect(CONTROL_ENDPOINTS.runtimeState).toBe("/api/v1/control/runtime-state");
    expect(CONTROL_ENDPOINTS.permission).toBe("/api/v1/control/permission");
    expect(CONTROL_ENDPOINTS.protection).toBe("/api/v1/control/protection");
    expect(CONTROL_ENDPOINTS.recovery).toBe("/api/v1/control/recovery");
    expect(CONTROL_ENDPOINTS.runbooks).toBe("/api/v1/control/runbooks");
    expect(CONTROL_ENDPOINTS.incidents).toBe("/api/v1/control/incidents");
    expect(CONTROL_ENDPOINTS.audit).toBe("/api/v1/control/audit");
    expect(CONTROL_ENDPOINTS.kill).toBe("/api/v1/control/kill");
    expect(CONTROL_ENDPOINTS.resume).toBe("/api/v1/control/resume");
  });

  it.each(GET_ROUTES.map((r) => [r.name, r] as const))(
    "%s route is force-dynamic, node runtime, and exports GET",
    (_name, route) => {
      expect((route.mod as { dynamic?: unknown }).dynamic).toBe("force-dynamic");
      expect((route.mod as { runtime?: unknown }).runtime).toBe("nodejs");
      expect(typeof (route.mod as { GET?: unknown }).GET).toBe("function");
    },
  );

  it("kill + resume expose POST handlers (force-dynamic, node runtime)", () => {
    for (const mod of [killRoute, resumeRoute]) {
      expect((mod as { dynamic?: unknown }).dynamic).toBe("force-dynamic");
      expect((mod as { runtime?: unknown }).runtime).toBe("nodejs");
      expect(typeof (mod as { POST?: unknown }).POST).toBe("function");
    }
  });
});
