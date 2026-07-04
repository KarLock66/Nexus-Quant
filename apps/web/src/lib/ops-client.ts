"use client";

import { postCommand, usePolledResource, type PollState } from "./use-polled-resource";
import { getOperatorToken } from "./operator-token";
import type {
  ActionsCatalog,
  AlertsSummary,
  DataFlowMonitor,
  OperatorActionId,
  OperatorActionResult,
  PipelineStatus,
  RuntimeMetrics,
  SystemHealth,
} from "./ops-types";

/**
 * Typed client service layer for the /ops control plane. Panels never call
 * `fetch` directly; all polling goes through the shared `usePolledResource`
 * primitive (one deduped poll per endpoint, abortable, visibility-aware) so
 * each panel renders and degrades independently.
 */

export const OPS_ENDPOINTS = {
  health: "/api/v1/ops/health",
  dataFlow: "/api/v1/ops/data-flow",
  pipeline: "/api/v1/ops/pipeline",
  alerts: "/api/v1/ops/alerts",
  metrics: "/api/v1/ops/metrics",
  actions: "/api/v1/ops/actions",
} as const;

/** Default operator-console poll cadence (ms) — brisk, for a live control plane. */
export const OPS_POLL_INTERVAL_MS = 5_000;

export { usePolledResource };
export type { PollState };

export const useSystemHealth = () =>
  usePolledResource<SystemHealth>(OPS_ENDPOINTS.health, "ops/health", OPS_POLL_INTERVAL_MS);

export const useDataFlow = () =>
  usePolledResource<DataFlowMonitor>(OPS_ENDPOINTS.dataFlow, "ops/data-flow", OPS_POLL_INTERVAL_MS);

export const useOpsPipeline = () =>
  usePolledResource<PipelineStatus>(OPS_ENDPOINTS.pipeline, "ops/pipeline", OPS_POLL_INTERVAL_MS);

export const useAlerts = () =>
  usePolledResource<AlertsSummary>(OPS_ENDPOINTS.alerts, "ops/alerts", OPS_POLL_INTERVAL_MS);

export const useRuntimeMetrics = () =>
  usePolledResource<RuntimeMetrics>(OPS_ENDPOINTS.metrics, "ops/metrics", OPS_POLL_INTERVAL_MS);

/** Actions catalog polls slowly (capability rarely changes). */
export const useActionsCatalog = () =>
  usePolledResource<ActionsCatalog>(OPS_ENDPOINTS.actions, "ops/actions", 30_000);

/** POST an operator action; returns the typed result envelope. */
export const runOperatorAction = (id: OperatorActionId): Promise<OperatorActionResult> =>
  postCommand<OperatorActionResult>(
    OPS_ENDPOINTS.actions,
    { action: id },
    { authToken: getOperatorToken() },
  );
