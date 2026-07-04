"use client";

import { usePolledResource, type PollState } from "./use-polled-resource";
import type {
  ConnectorStatus,
  DataQualitySummary,
  PipelineStatus,
  QueueMetrics,
  ServiceHealth,
} from "./system-monitoring-types";

/**
 * Typed client service layer for the System Monitoring page. Panels never call
 * `fetch` directly; all polling goes through the shared `usePolledResource`
 * primitive (one deduped poll per endpoint, abortable, visibility-aware) so
 * each panel renders and degrades independently.
 */

export const SYSTEM_ENDPOINTS = {
  health: "/api/v1/system/health",
  connectors: "/api/v1/system/connectors",
  dataQuality: "/api/v1/system/data-quality",
  pipeline: "/api/v1/system/pipeline",
  queues: "/api/v1/system/queues",
} as const;

/** Default poll cadence (ms). Within the 5–10s window mandated for Phase 1. */
export const POLL_INTERVAL_MS = 7_000;

export { usePolledResource };
export type { PollState };

// Typed, named hooks per source — the only public surface panels consume.
export const useServiceHealth = () =>
  usePolledResource<ServiceHealth>(SYSTEM_ENDPOINTS.health, "system/health", POLL_INTERVAL_MS);

export const useConnectorStatus = () =>
  usePolledResource<ConnectorStatus[]>(SYSTEM_ENDPOINTS.connectors, "system/connectors", POLL_INTERVAL_MS);

export const useDataQuality = () =>
  usePolledResource<DataQualitySummary>(SYSTEM_ENDPOINTS.dataQuality, "system/data-quality", POLL_INTERVAL_MS);

export const usePipelineStatus = () =>
  usePolledResource<PipelineStatus>(SYSTEM_ENDPOINTS.pipeline, "system/pipeline", POLL_INTERVAL_MS);

export const useQueueMetrics = () =>
  usePolledResource<QueueMetrics>(SYSTEM_ENDPOINTS.queues, "system/queues", POLL_INTERVAL_MS);
