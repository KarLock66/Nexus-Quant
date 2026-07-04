/**
 * Wire types for the Phase 9.6 Operations Control Plane (the `/ops` page and the
 * `/api/v1/ops/*` observability API).
 *
 * Pure types ONLY — no runtime imports. The server data layer (system-health.ts,
 * ops.ts, ops-alerts.ts — all of which import Prisma / node:net) and the client
 * (ops-client.ts, ops-console.tsx) both import from here, so keeping this module
 * import-free guarantees Prisma never reaches the browser bundle.
 *
 * This is additive to the existing System Monitoring wire types
 * (system-monitoring-types.ts); the ops plane is operator-facing and intentionally
 * self-contained so it can be reasoned about (and shipped) independently.
 */

/** Per-component health. `unknown` is fail-closed: it never counts as healthy. */
export type ComponentStatus = "healthy" | "degraded" | "failing" | "unknown";

/** Single aggregate verdict for the whole platform (Section A). */
export type OverallStatus = "healthy" | "degraded" | "critical";

/** Data-flow freshness band (Section B): fresh < warning < stale. */
export type Freshness = "fresh" | "warning" | "stale" | "unknown";

/** Standard response envelope used by every /api/v1/ops/* route. */
export interface ApiEnvelope<T> {
  data: T;
  generatedAt: string;
}

// ─────────────────── A. System Health Aggregator ───────────────────

export type ComponentKey =
  | "web"
  | "database"
  | "redis"
  | "quant"
  | "ingestion"
  | "workers";

export interface OpsComponent {
  key: ComponentKey;
  label: string;
  status: ComponentStatus;
  /** Hard dependency (db) vs derived/optional (redis when unconfigured, quant). */
  required: boolean;
  /** Human-readable probe result / reason. */
  detail: string;
  /** Round-trip probe latency where measured (null for derived signals). */
  latencyMs: number | null;
  /** ISO of the evidence the status was derived from (derived components). */
  lastObservedAt: string | null;
}

export interface SystemHealth {
  overallStatus: OverallStatus;
  components: OpsComponent[];
  version: string;
  uptimeSeconds: number;
  checkedAt: string;
}

// ─────────────────── B. Live Data Flow Monitor ───────────────────

export type StreamKey =
  | "marketTick"
  | "orderbookSnapshot"
  | "marketCandle"
  | "featureSnapshot"
  | "engineSignal"
  | "execution";

export interface DataFlowStream {
  key: StreamKey;
  label: string;
  lastUpdateAt: string | null;
  lagSeconds: number | null;
  rowsPerMinute: number | null;
  rowsLastHour: number;
  freshness: Freshness;
  /** The seconds thresholds applied to compute `freshness` (warning < stale). */
  thresholdsSeconds: { warning: number; stale: number };
  /** Context when a stream is not directly observable (e.g. execution opt-in). */
  note: string | null;
}

export interface DataFlowMonitor {
  overall: Freshness;
  streams: DataFlowStream[];
}

// ─────────────────── C. Pipeline Visualization ───────────────────

export type StageState =
  | "active"
  | "idle"
  | "degraded"
  | "failing"
  | "empty"
  | "unknown";

export type StageKey =
  | "exchange"
  | "ingestion"
  | "dataQuality"
  | "featureGeneration"
  | "signalEngine"
  | "riskEngine"
  | "execution"
  | "persistence";

export interface PipelineStage {
  key: StageKey;
  label: string;
  state: StageState;
  lastEventAt: string | null;
  throughputPerMin: number | null;
  latencyMs: number | null;
  errorCount: number;
  detail: string;
}

export interface PipelineStatus {
  overall: StageState;
  stages: PipelineStage[];
}

// ─────────────────── E. Alerting Engine ───────────────────

/** Mirrors the platform `RiskSeverity` enum without importing Prisma. */
export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL" | "EMERGENCY";
export type AlertStatus = "ACTIVE" | "RESOLVED";

export interface OpsAlertView {
  /** DB id when persisted; otherwise the stable ruleId (live-only fallback). */
  id: string;
  ruleId: string;
  severity: AlertSeverity;
  message: string;
  status: AlertStatus;
  firstSeen: string;
  lastSeen: string;
  detail: string | null;
  /** True when backed by a persisted OpsAlert row (vs computed live-only). */
  persisted: boolean;
}

export interface AlertsSummary {
  active: number;
  critical: number;
  alerts: OpsAlertView[];
  /** False when the OpsAlert table is unavailable — alerts still computed live. */
  persistenceOk: boolean;
}

// ─────────────────── F. Runtime Metrics ───────────────────

export interface StreamCount {
  stream: StreamKey;
  lastHour: number;
  last24h: number;
}

export interface JobMetrics {
  running: number;
  ok24h: number;
  failed24h: number;
  ratePerMin: number | null;
  avgLatencyMs: number | null;
  activeWorkers: number;
}

export interface RiskMetrics {
  mode: string | null;
  openRiskEvents: number;
  lastRiskEventAt: string | null;
}

export interface RuntimeMetrics {
  webUptimeSeconds: number;
  counts: StreamCount[];
  jobs: JobMetrics;
  risk: RiskMetrics;
}

// ─────────────────── D. Operator Actions ───────────────────

export type OperatorActionId =
  | "refreshHealth"
  | "rerunHealthChecks"
  | "clearStaleStatus"
  | "restartIngestion"
  | "restartWorkers";

export interface OperatorAction {
  id: OperatorActionId;
  label: string;
  description: string;
  enabled: boolean;
  /** Always false in this build — no destructive action is exposed. */
  destructive: boolean;
  /** Why the control is disabled (null when enabled). */
  disabledReason: string | null;
}

export interface ActionsCatalog {
  actions: OperatorAction[];
  /** True when an external control channel is configured (gates restart actions). */
  controlChannelConfigured: boolean;
}

export interface OperatorActionResult {
  id: OperatorActionId;
  ok: boolean;
  /** A gated control request was accepted for an external supervisor to honor. */
  accepted: boolean;
  message: string;
  performedAt: string;
}
