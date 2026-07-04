/**
 * Wire types for the System Monitoring page (Phase 1).
 *
 * Pure types only — NO runtime imports. Both the server data layer
 * (`system-monitoring.ts`, which imports Prisma) and the client components
 * (`system-monitoring-client.ts`) import from here, so keeping this module
 * import-free guarantees Prisma is never pulled into the browser bundle.
 */

/** Canonical health semantics shared by every badge/dot in the UI. */
export type HealthLevel = "healthy" | "degraded" | "failing" | "unknown";

/** Standard response envelope used by every /api/v1/system/* route. */
export interface ApiEnvelope<T> {
  data: T;
  generatedAt: string;
}

// ─────────────────── A. Service Health ───────────────────

export interface ServiceComponent {
  key: string; // api | database | redis | quant | worker
  label: string;
  status: HealthLevel;
  detail: string; // human-readable reason / probe result
  latencyMs: number | null;
}

export interface ServiceHealth {
  status: HealthLevel; // worst-of components
  components: ServiceComponent[];
  version: string;
  uptimeSeconds: number; // web process uptime
}

// ─────────────────── B. Connector Status ───────────────────

export interface ConnectorStatus {
  exchange: string; // BINANCE | DERIBIT | BYBIT | DEMO
  status: HealthLevel;
  lastSyncAt: string | null; // ISO; max(MarketCandle.ts) for the exchange
  lagSeconds: number | null; // now - lastSyncAt
  rowsLast24h: number;
  symbols: string[];
  error: string | null;
}

// ─────────────────── C. Data Quality ───────────────────

export interface DqStageScore {
  stage: string; // ingest | transform | feature | signal
  score: number; // 0..100
  status: HealthLevel;
}

export interface DqCheckRollup {
  check: string;
  failRate: number; // 0..1 across sampled reports
  deduction: number; // total points deducted
}

export interface DataQualitySummary {
  overallScore: number | null; // 0..100, avg of latest report per series
  status: HealthLevel;
  passRate: number | null; // 0..1 over the sampled window
  failureRate: number | null; // 1 - passRate
  anomalyCount: number; // failed checks across sampled reports
  reportsSampled: number;
  stages: DqStageScore[];
  worstChecks: DqCheckRollup[];
}

// ─────────────────── D. Pipeline / Runtime ───────────────────

export type PipelineState = "idle" | "running" | "failing" | "empty";

export interface PipelineStage {
  key: string; // ingest | dq | feature | signal
  label: string;
  state: PipelineState;
  lastRunAt: string | null;
  lagSeconds: number | null;
  count24h: number;
  detail: string;
}

export interface PipelineStatus {
  state: PipelineState; // overall flow state
  stages: PipelineStage[];
  lastSignalAt: string | null;
}

// ─────────────────── E. Queues / Workers ───────────────────

export interface QueueJobSummary {
  job: string;
  status: string; // RUNNING | OK | FAILED
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface QueueMetrics {
  depth: number; // in-flight (RUNNING) jobs — queue-depth proxy
  processingRatePerMin: number | null; // OK completions / min over the window
  activeWorkers: number; // distinct RUNNING job types
  failed24h: number;
  ok24h: number;
  avgLatencyMs: number | null; // mean completed-job duration
  deadLetter: number; // FAILED jobs in window (dead-letter proxy)
  jobs: QueueJobSummary[];
}
