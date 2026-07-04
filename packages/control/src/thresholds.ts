/**
 * Canonical freshness thresholds for the control plane (seconds). These intentionally
 * line up with the Phase 9.6 data-flow bands (`apps/web/src/lib/ops-freshness.ts`) so
 * the control plane and the ops monitor never disagree about "stale". The `stale`
 * bound is the HARD breach edge (→ protection / blocks trading); `warning` is the soft
 * edge (→ DEGRADED).
 */

import type { ControlComponent } from "./types.js";

export interface FreshnessBand {
  warningSeconds: number;
  staleSeconds: number;
}

/** Per-stream bands. featureSnapshot 60/180, engineSignal 60/120, execution 120/300. */
export const FRESHNESS_BANDS: Record<"features" | "signals" | "execution", FreshnessBand> = {
  features: { warningSeconds: 60, staleSeconds: 180 },
  signals: { warningSeconds: 60, staleSeconds: 120 },
  execution: { warningSeconds: 120, staleSeconds: 300 },
};

/** Human labels for the canonical components (UI + reasons). */
export const COMPONENT_LABELS: Record<ControlComponent, string> = {
  database: "Database (Postgres)",
  redis: "Redis",
  quant: "Quant Service",
  features: "Feature Generation",
  signals: "Signal Engine",
  execution: "Execution",
  risk: "Risk Engine",
};
