/**
 * Phase 9.7 — ControlPlane orchestrator (worker side). Runs once per worker tick: it
 * gathers the live {@link ControlInputs}, runs the PURE @nexus/control evaluators
 * (protection → recovery → state machine → permission), and persists the results
 * (transitions, protection events, incidents, append-only audit). It also holds the
 * latest permission snapshot the execution control gate reads.
 *
 * Boot sequence (Section I): BOOTING → STARTING → validateStartup → HEALTHY (initial
 * evaluate) or FAILED (fail-closed; execution stays UNARMED). The DB-backed kill switch
 * and any prior state survive restart, so a system killed before shutdown comes back
 * STOPPED.
 */

import {
  deriveRuntimeState,
  evaluateProtectionRules,
  evaluateTradingPermission,
  isDegraded,
  recoveryOutcome,
  type ControlComponent,
  type ProtectionVerdict,
  type RecoveryOutcome,
  type RuntimeState,
  type StartupValidation,
  type TradingPermission,
} from "@nexus/control";
import { gatherControlInputs } from "./inputs.js";
import { verifyRecovery } from "./recovery.js";
import { validateStartup } from "./startup.js";
import { ControlDataError } from "./validate.js";
import {
  appendAudit,
  getCurrentState,
  getOpenIncident,
  openIncident,
  recordTransition,
  resolveIncident,
  resolveProtectionEventsExcept,
  upsertProtectionEvent,
} from "./store.js";

type Log = (level: "info" | "warn" | "error", msg: string, extra?: object) => void;

export interface ControlPlaneDeps {
  log: Log;
  /** Risk engine armed and not halted (read live each evaluation). */
  getRiskActive: () => boolean;
  redisUrl: string | undefined;
  quantUrl: string | undefined;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export class ControlPlane {
  private readonly deps: ControlPlaneDeps;
  private lastState: RuntimeState = "BOOTING";
  private lastActiveComponents: ControlComponent[] = [];
  private lastPermission: TradingPermission | null = null;
  private startupValidated = false;
  private startedFlag = false;
  private lastExecutionAt: Date | null = null;
  /** Probe targets (mutable so the runtime seal can flip quant dead→live in-process). */
  redisUrl: string | undefined;
  quantUrl: string | undefined;

  constructor(deps: ControlPlaneDeps) {
    this.deps = deps;
    this.redisUrl = deps.redisUrl;
    this.quantUrl = deps.quantUrl;
  }

  /** Latest permission verdict (set by the most recent evaluate); null before boot. */
  currentPermission(): TradingPermission | null {
    return this.lastPermission;
  }

  /** True once startup validation has passed and the runtime is armed. */
  get started(): boolean {
    return this.startedFlag;
  }

  /** Record that execution produced a fill (drives execution-freshness recovery). */
  noteExecution(ts: Date = new Date()): void {
    this.lastExecutionAt = ts;
  }

  /** Boot sequence + startup validation. Returns whether the runtime may arm execution. */
  async boot(): Promise<{ started: boolean; validation: StartupValidation }> {
    const persisted = await getCurrentState().catch((err: unknown) => {
      // Conservative fallback either way (boot still runs full startup validation);
      // the read failure is LOGGED, never silently swallowed (Phase 11C Stage 3).
      this.deps.log("error", "control plane: persisted runtime state unreadable — falling back to BOOTING", {
        error: err instanceof Error ? err.message : String(err),
      });
      return "BOOTING" as RuntimeState;
    });
    await this.commitTransition("BOOTING", persisted === "BOOTING" ? null : persisted, "worker boot", []);
    await this.commitTransition("STARTING", "BOOTING", "running startup validation", []);

    const validation = await validateStartup({ redisUrl: this.redisUrl, quantUrl: this.quantUrl });
    if (!validation.passed) {
      const failed = validation.checks.filter((c) => !c.passed).map((c) => c.name).join(", ");
      await this.commitTransition("FAILED", "STARTING", `startup validation failed: ${failed}`, []);
      await appendAudit({
        actor: "system:control",
        action: "STARTUP_FAILED",
        result: "FAILED",
        reason: `failed checks: ${failed}`,
        metadata: { checks: validation.checks },
      });
      this.lastState = "FAILED";
      this.startedFlag = false;
      this.deps.log("error", "control plane: startup validation FAILED — execution unarmed (fail-closed)", { failed });
      return { started: false, validation };
    }

    this.startupValidated = true;
    this.startedFlag = true;
    // NB: the caller runs the first evaluate() AFTER arming execution (so the risk
    // engine is live), avoiding a spurious risk.disabled PROTECTED blip at boot.
    this.deps.log("info", "control plane: startup validated — ready to arm", {
      checks: validation.checks.map((c) => `${c.name}:${c.passed ? "ok" : "FAIL"}`),
    });
    return { started: true, validation };
  }

  /**
   * One control evaluation: gather → protection → (recovery) → state machine →
   * permission, persisting every consequence. Safe to call every tick.
   */
  async evaluate(): Promise<{ state: RuntimeState; permission: TradingPermission }> {
    const inputs = await gatherControlInputs({
      redisUrl: this.redisUrl,
      quantUrl: this.quantUrl,
      getRiskActive: this.deps.getRiskActive,
      lastExecutionAt: this.lastExecutionAt,
      startupValidated: this.startupValidated,
    });

    const verdicts = evaluateProtectionRules(inputs);
    const active: ProtectionVerdict[] = verdicts.filter((v) => v.active);
    const activeRuleIds = active.map((a) => a.ruleId);
    const degraded = isDegraded(inputs);
    let prev = this.lastState;

    // Recovery (Section E): leaving PROTECTED/RECOVERING with everything clear → verify.
    let recovery: RecoveryOutcome = null;
    const leaving = (prev === "PROTECTED" || prev === "RECOVERING") && active.length === 0 && !inputs.killSwitch.engaged;
    if (leaving) {
      if (prev === "PROTECTED") {
        await this.commitTransition("RECOVERING", prev, "components healthy — verifying recovery", []);
        prev = "RECOVERING";
        this.lastState = "RECOVERING";
      }
      let open: { id: string; affectedComponents: ControlComponent[] } | null = null;
      let openReadable = true;
      try {
        open = await getOpenIncident();
      } catch (err) {
        if (!(err instanceof ControlDataError)) throw err;
        openReadable = false;
      }
      if (!openReadable) {
        // Fail-closed: an unreadable incident row makes recovery UNVERIFIABLE — this is
        // the one site where corruption could otherwise UPGRADE state (→ HEALTHY).
        recovery = false;
        await appendAudit({
          actor: "system:control",
          action: "RECOVERY_FAILED",
          result: "FAILED",
          reason: "open incident row corrupt — recovery unverifiable (fail-closed)",
        });
      } else {
        const targets = uniq([...this.lastActiveComponents, ...(open?.affectedComponents ?? [])]);
        if (targets.length === 0) {
          recovery = true; // nothing specific to verify (e.g. clean restart)
        } else {
          const reports = await Promise.all(targets.map((c) => verifyRecovery(c, {
            redisUrl: this.redisUrl,
            quantUrl: this.quantUrl,
            getRiskActive: this.deps.getRiskActive,
            lastExecutionAt: this.lastExecutionAt,
          })));
          recovery = recoveryOutcome(reports);
          await appendAudit({
            actor: "system:control",
            action: recovery ? "RECOVERY_VERIFIED" : "RECOVERY_FAILED",
            result: recovery ? "OK" : "FAILED",
            reason: `verified ${targets.join(", ")}`,
            metadata: { reports },
          });
        }
      }
    }

    const result = deriveRuntimeState(prev, {
      killEngaged: inputs.killSwitch.engaged,
      activeProtections: active,
      degraded,
      recoveryOutcome: recovery,
    });

    // Persist protection events: resolve cleared, upsert active (deduped by ruleId).
    await resolveProtectionEventsExcept(activeRuleIds);
    await this.syncIncidentAndProtections(prev, result.state, active);

    if (result.state !== prev) {
      await this.commitTransition(result.state, prev, result.reason, result.affectedComponents);
    }

    this.lastState = result.state;
    this.lastActiveComponents = active.map((a) => a.component);
    this.lastPermission = evaluateTradingPermission(inputs, result.state);
    return { state: result.state, permission: this.lastPermission };
  }

  /** Open an incident on entry to PROTECTED; resolve it when we reach HEALTHY (verified). */
  private async syncIncidentAndProtections(
    prev: RuntimeState,
    next: RuntimeState,
    active: ProtectionVerdict[],
  ): Promise<void> {
    if (next === "PROTECTED" && active.length > 0) {
      let open: { id: string; affectedComponents: ControlComponent[] } | null = null;
      try {
        open = await getOpenIncident();
      } catch (err) {
        if (!(err instanceof ControlDataError)) throw err;
        // Corruption never blocks protection: treat as no readable open incident and
        // open a FRESH valid one (newer startedAt — subsequent reads see the valid row).
        this.deps.log("warn", "control plane: open incident row corrupt — opening a fresh incident", {
          error: err.message,
        });
      }
      if (!open) {
        const type = active.length === 1 ? active[0]!.ruleId : "multi";
        const id = await openIncident({
          type,
          severity: "CRITICAL",
          affectedComponents: uniq(active.map((a) => a.component)),
          detail: active.map((a) => a.detail).join("; "),
        });
        open = { id, affectedComponents: uniq(active.map((a) => a.component)) };
        await appendAudit({
          actor: "system:control",
          action: "PROTECTION_ENGAGED",
          result: "OK",
          reason: active.map((a) => a.ruleId).join(", "),
          metadata: { incidentId: id, rules: active.map((a) => a.ruleId) },
        });
      }
      for (const v of active) {
        await upsertProtectionEvent({
          ruleId: v.ruleId,
          component: v.component,
          severity: v.severity,
          detail: v.detail,
          incidentId: open.id,
        });
      }
    }

    // Reaching HEALTHY after an incident → resolve it (recovery verified).
    if (next === "HEALTHY" && (prev === "RECOVERING" || prev === "PROTECTED")) {
      const open = await this.readOpenIncidentForResolution();
      if (open) {
        await resolveIncident(open.id, "VERIFIED");
        await appendAudit({
          actor: "system:control",
          action: "INCIDENT_RESOLVED",
          result: "OK",
          reason: "recovery verified",
          metadata: { incidentId: open.id },
        });
      }
    }

    // Operator resume from a manual stop with the runtime back nominal. If the kill was
    // thrown WHILE an incident was open (PROTECTED → kill → STOPPED → resume), reaching
    // HEALTHY/DEGRADED here bypasses the RECOVERING path, so the incident would otherwise
    // be orphaned (perpetually OPEN, null duration). Close it as MANUAL_RESUME — recovery
    // was operator-driven, NOT machine-verified — so the timeline is honest and the open
    // count returns to zero. (No active protections can hold here: deriveRuntimeState
    // would have returned PROTECTED, not HEALTHY/DEGRADED, if any were active.)
    if (prev === "STOPPED" && (next === "HEALTHY" || next === "DEGRADED")) {
      const open = await this.readOpenIncidentForResolution();
      if (open) {
        await resolveIncident(open.id, "MANUAL_RESUME");
        await appendAudit({
          actor: "system:control",
          action: "INCIDENT_RESOLVED",
          result: "OK",
          reason: "operator resume — manual (unverified) recovery",
          metadata: { incidentId: open.id, outcome: "MANUAL_RESUME" },
        });
      }
    }
  }

  /**
   * getOpenIncident for the two RESOLUTION sites: a corrupt row skips resolution — the
   * incident stays OPEN (operator-visible) and the state transition itself is untouched.
   * Non-admission errors propagate unchanged (Phase 11C Stage 3).
   */
  private async readOpenIncidentForResolution(): Promise<{
    id: string;
    affectedComponents: ControlComponent[];
  } | null> {
    try {
      return await getOpenIncident();
    } catch (err) {
      if (!(err instanceof ControlDataError)) throw err;
      this.deps.log("error", "control plane: open incident row corrupt — resolution skipped, incident left OPEN", {
        error: err.message,
      });
      return null;
    }
  }

  private async commitTransition(
    state: RuntimeState,
    previousState: RuntimeState | null,
    reason: string,
    affected: ControlComponent[],
  ): Promise<void> {
    await recordTransition({ state, previousState, reason, affectedComponents: affected });
    await appendAudit({
      actor: "system:control",
      action: "STATE_CHANGE",
      result: "OK",
      reason,
      metadata: { from: previousState, to: state, affected },
    });
    this.lastState = state;
    this.deps.log("info", "control plane: runtime state", { from: previousState, to: state, reason });
  }
}
