/**
 * Wire types for the Phase 9.7 Production Control Plane (the `/control` page and the
 * `/api/v1/control/*` API). VIEW shapes only — the canonical decision types live in
 * `@nexus/control` (pure, browser-safe, IO-free), which both the server data layer
 * (`lib/control.ts`, imports Prisma) and the client (`control-client.ts`,
 * `control-center.tsx`) re-use, so there is one source of truth and Prisma never
 * reaches the browser bundle.
 */

import type {
  ControlComponent,
  KillSwitchState,
  Runbook,
  RuntimeState,
  TradingPermission,
} from "@nexus/control";

/** Standard response envelope used by every /api/v1/control/* route. */
export interface ApiEnvelope<T> {
  data: T;
  generatedAt: string;
}

export interface TransitionView {
  state: RuntimeState;
  previousState: RuntimeState | null;
  reason: string;
  affectedComponents: ControlComponent[];
  enteredAt: string;
}

export interface RuntimeStateView {
  current: RuntimeState;
  previousState: RuntimeState | null;
  reason: string;
  affectedComponents: ControlComponent[];
  enteredAt: string | null;
  durationSeconds: number | null;
  recent: TransitionView[];
}

export interface TradingPermissionView extends TradingPermission {
  state: RuntimeState;
}

export interface ProtectionEventView {
  id: string;
  ruleId: string;
  component: string;
  severity: string;
  detail: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface ProtectionView {
  protectedComponents: string[];
  events: ProtectionEventView[];
  runbooks: Runbook[];
}

export interface IncidentView {
  id: string;
  type: string;
  severity: string;
  affectedComponents: ControlComponent[];
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  status: string;
  recoveryOutcome: string | null;
  detail: string | null;
}

export type IncidentWindow = "1h" | "24h" | "7d" | "30d";

export interface IncidentTimelineView {
  window: IncidentWindow;
  open: number;
  incidents: IncidentView[];
}

export interface AuditView {
  id: string;
  ts: string;
  actor: string;
  action: string;
  reason: string | null;
  result: string;
  metadata: unknown;
}

export interface AuditTrailView {
  total: number;
  entries: AuditView[];
}

export interface RecoveryComponentView {
  component: ControlComponent;
  plan: string[];
}

export interface RecoveryView {
  recovering: boolean;
  state: RuntimeState;
  components: RecoveryComponentView[];
}

export interface RunbooksView {
  all: Runbook[];
  applicable: Runbook[];
}

export type KillSwitchView = KillSwitchState;

/** Result of a kill/resume command. */
export interface ControlCommandResult {
  ok: boolean;
  killSwitch: KillSwitchState;
  message: string;
}
