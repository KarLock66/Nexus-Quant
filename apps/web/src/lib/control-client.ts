"use client";

import { postCommand, usePolledResource, type PollState } from "./use-polled-resource";
import { getOperatorToken } from "./operator-token";
import type {
  AuditTrailView,
  ControlCommandResult,
  IncidentTimelineView,
  IncidentWindow,
  ProtectionView,
  RecoveryView,
  RunbooksView,
  RuntimeStateView,
  TradingPermissionView,
} from "./control-types";

/**
 * Typed client service layer for the Phase 9.7 Control Plane. All polling goes
 * through the shared `usePolledResource` primitive (one deduped poll per
 * resource, independent loading / error / stale handling) so the control
 * center degrades panel-by-panel.
 */

export const CONTROL_ENDPOINTS = {
  runtimeState: "/api/v1/control/runtime-state",
  permission: "/api/v1/control/permission",
  protection: "/api/v1/control/protection",
  incidents: "/api/v1/control/incidents",
  audit: "/api/v1/control/audit",
  runbooks: "/api/v1/control/runbooks",
  recovery: "/api/v1/control/recovery",
  kill: "/api/v1/control/kill",
  resume: "/api/v1/control/resume",
} as const;

/** Brisk cadence — a live control plane. */
const FAST = 4_000;
const SLOW = 15_000;

export type { PollState };

export const useRuntimeState = () =>
  usePolledResource<RuntimeStateView>(CONTROL_ENDPOINTS.runtimeState, "control/runtime-state", FAST);

export const usePermission = () =>
  usePolledResource<TradingPermissionView>(CONTROL_ENDPOINTS.permission, "control/permission", FAST);

export const useProtection = () =>
  usePolledResource<ProtectionView>(CONTROL_ENDPOINTS.protection, "control/protection", FAST);

export const useRecovery = () =>
  usePolledResource<RecoveryView>(CONTROL_ENDPOINTS.recovery, "control/recovery", FAST);

export const useRunbooks = () =>
  usePolledResource<RunbooksView>(CONTROL_ENDPOINTS.runbooks, "control/runbooks", SLOW);

export const useIncidents = (window: IncidentWindow) =>
  usePolledResource<IncidentTimelineView>(
    `${CONTROL_ENDPOINTS.incidents}?window=${window}`,
    "control/incidents",
    FAST,
  );

export const useAudit = (q: string) =>
  usePolledResource<AuditTrailView>(
    `${CONTROL_ENDPOINTS.audit}?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    "control/audit",
    FAST,
  );

export const runKill = (actor: string, reason: string) =>
  postCommand<ControlCommandResult>(
    CONTROL_ENDPOINTS.kill,
    { actor, reason },
    { authToken: getOperatorToken() },
  );

export const runResume = (actor: string, reason: string) =>
  postCommand<ControlCommandResult>(
    CONTROL_ENDPOINTS.resume,
    { actor, reason },
    { authToken: getOperatorToken() },
  );
