/**
 * Phase 9.7 — Production Control Plane: canonical contracts.
 *
 * PURE types and value-unions ONLY — this module (and the whole package) imports
 * nothing runtime-y (no Prisma, no node:net, no fetch). The deterministic evaluators
 * here are the SINGLE source of truth consulted by BOTH the worker (enforcement) and
 * the web tier (display), so the canonical string values live here and nowhere else.
 *
 * Design rule: every evaluator is FAIL-CLOSED. Uncertainty (an `unknown` component, a
 * `null` freshness observation where freshness is required) denies — it never rounds
 * up to "ok".
 */

// ─────────────────────────── Runtime state machine (A) ───────────────────────────

/**
 * The eight production runtime states. BOOTING/STARTING/FAILED are boot-phase states
 * owned by the worker boot sequence; HEALTHY/DEGRADED/PROTECTED/RECOVERING/STOPPED are
 * the steady-state machine driven by {@link deriveRuntimeState}.
 */
export const RUNTIME_STATES = [
  "BOOTING",
  "STARTING",
  "HEALTHY",
  "DEGRADED",
  "PROTECTED",
  "STOPPED",
  "RECOVERING",
  "FAILED",
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

/** Result of a state evaluation — the next state plus the deterministic reason. */
export interface RuntimeStateResult {
  state: RuntimeState;
  /** Human-readable, deterministic explanation (drives the audit/transition reason). */
  reason: string;
  /** Canonical component keys implicated in this state (empty when nominal). */
  affectedComponents: ControlComponent[];
}

// ─────────────────────────── Components & health ───────────────────────────

/** Health of a probed infrastructure component (mirrors the 9.6 ComponentStatus). */
export type ComponentHealth = "healthy" | "degraded" | "failing" | "unknown";

/**
 * Canonical control-plane component keys. Infra (database/redis/quant) carry a
 * {@link ComponentHealth}; features/signals/execution are freshness-derived; risk is a
 * boolean (engine armed or not).
 */
export const CONTROL_COMPONENTS = [
  "database",
  "redis",
  "quant",
  "features",
  "signals",
  "execution",
  "risk",
] as const;
export type ControlComponent = (typeof CONTROL_COMPONENTS)[number];

/**
 * A single freshness observation. `lagSeconds === null` means "no observation" (an
 * empty table) — distinct from a large lag. The evaluators treat the two differently
 * (see permission vs protection semantics in the function docs).
 */
export interface FreshnessObservation {
  lagSeconds: number | null;
  /** Inclusive bound (seconds) beyond which the stream is considered stale/breached. */
  staleSeconds: number;
  /** Inclusive bound (seconds) beyond which the stream is "soft stale" (→ DEGRADED). */
  warningSeconds: number;
}

/**
 * The complete, gathered input snapshot the evaluators consume. Built by the worker
 * (`control/inputs.ts`, real probes + Prisma) and the web (`lib/control.ts`, reusing
 * the 9.6 health aggregator). `now` is passed in so every evaluator is a pure function
 * of its inputs (deterministic, clock-injected — replay-safe).
 */
export interface ControlInputs {
  now: number;
  database: ComponentHealth;
  redis: ComponentHealth;
  quant: ComponentHealth;
  features: FreshnessObservation;
  signals: FreshnessObservation;
  execution: FreshnessObservation;
  /** True iff the Phase-8 risk engine is armed and not halted. */
  riskEngineActive: boolean;
  /** Current manual kill-switch state (DB-backed; read every evaluation). */
  killSwitch: KillSwitchState;
  /** Whether boot-time startup validation has passed (gates entry to HEALTHY). */
  startupValidated: boolean;
}

// ─────────────────────────── Kill switch (C) ───────────────────────────

export interface KillSwitchState {
  engaged: boolean;
  actor: string | null;
  reason: string | null;
  /** ISO timestamp the switch was last engaged (null when never engaged). */
  engagedAt: string | null;
}

// ─────────────────────────── Trading permission (B) ───────────────────────────

export type TradingPermissionVerdict = "ALLOWED" | "BLOCKED";

/** Canonical permission-check identifiers, one per {@link ControlInputs} condition. */
export type PermissionCheckId =
  | "database"
  | "redis"
  | "quant"
  | "feature_freshness"
  | "signal_freshness"
  | "execution_freshness"
  | "risk_engine"
  | "kill_switch"
  | "runtime_state";

export interface PermissionReason {
  check: PermissionCheckId;
  label: string;
  ok: boolean;
  detail: string;
}

export interface TradingPermission {
  permission: TradingPermissionVerdict;
  /**
   * Epoch ms the snapshot was evaluated (mirrors `inputs.now`). A consuming gate can
   * compare this against the wall clock to detect a wedged/stale evaluator and fail
   * closed instead of riding an arbitrarily old ALLOWED verdict.
   */
  generatedAt: number;
  /** Every check, in order — `ok:false` entries are the blocking reasons. */
  reasons: PermissionReason[];
  /** Convenience: the failing checks only (empty when ALLOWED). */
  blockedBy: PermissionReason[];
}

// ─────────────────────────── Protection rules (D) ───────────────────────────

/**
 * The protection rule catalog. Six rules are the spec's named set; `redis.unavailable`
 * is added so the runtime state stays consistent with the Section B "Redis healthy"
 * trade condition and the Section I startup check (additive, strictly more protective).
 */
export const PROTECTION_RULE_IDS = [
  "database.unavailable",
  "redis.unavailable",
  "quant.unavailable",
  "feature.stale",
  "signal.stale",
  "execution.stale",
  "risk.disabled",
] as const;
export type ProtectionRuleId = (typeof PROTECTION_RULE_IDS)[number];

export type ControlSeverity = "INFO" | "WARNING" | "CRITICAL" | "EMERGENCY";

export interface ProtectionVerdict {
  ruleId: ProtectionRuleId;
  component: ControlComponent;
  active: boolean;
  severity: ControlSeverity;
  detail: string;
}

// ─────────────────────────── Recovery (E) ───────────────────────────

/**
 * Tri-state recovery verification outcome consumed by {@link deriveRuntimeState}:
 *   - null  : verification in progress / not yet run → RECOVERING
 *   - true  : verified → HEALTHY
 *   - false : verification failed → PROTECTED (per spec)
 */
export type RecoveryOutcome = boolean | null;

export interface RecoveryStep {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RecoveryReport {
  component: ControlComponent;
  verified: boolean;
  steps: RecoveryStep[];
}

// ─────────────────────────── Startup validation (I) ───────────────────────────

export interface StartupCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface StartupValidation {
  passed: boolean;
  checks: StartupCheck[];
}

// ─────────────────────────── Runbooks (F) ───────────────────────────

/** A control-plane runbook is keyed by a protection rule or a control situation. */
export type RunbookKey = ProtectionRuleId | "kill_switch.engaged" | "startup.failed";

export interface Runbook {
  key: RunbookKey;
  title: string;
  problem: string;
  impact: string;
  diagnosis: string;
  requiredAction: string;
  verificationSteps: string[];
}

// ─────────────────────────── Steady-state machine input ───────────────────────────

/**
 * The minimal, pre-digested input to {@link deriveRuntimeState}. The evaluator computes
 * this from {@link ControlInputs} (+ the recovery IO outcome) so the state function
 * itself stays a tiny, exhaustively-testable reducer.
 */
export interface SteadyStateInput {
  killEngaged: boolean;
  /** Active protection verdicts (already filtered to `active === true`). */
  activeProtections: ProtectionVerdict[];
  /** A soft, non-critical degradation holds (warning-band staleness, etc.). */
  degraded: boolean;
  /** Recovery verification outcome when leaving PROTECTED/RECOVERING (see RecoveryOutcome). */
  recoveryOutcome: RecoveryOutcome;
}
