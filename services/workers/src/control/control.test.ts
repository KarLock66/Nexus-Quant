import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlInputs, KillSwitchState, TradingPermission } from "@nexus/control";
import { createControlExecutionGate } from "./gate.js";
import type { RiskGateHook } from "../execution/stage.js";

// Phase 11C Stage 3 Batch 2 — evaluator behavior under corrupt control rows. The store,
// input gatherer, recovery prober, and startup validator are mocked (no live DB); the
// PURE @nexus/control evaluators (protection rules, state machine, permission) run REAL.
vi.mock("./store.js", () => ({
  appendAudit: vi.fn(),
  getCurrentState: vi.fn(),
  getOpenIncident: vi.fn(),
  openIncident: vi.fn(),
  recordTransition: vi.fn(),
  resolveIncident: vi.fn(),
  resolveProtectionEventsExcept: vi.fn(),
  upsertProtectionEvent: vi.fn(),
}));
vi.mock("./inputs.js", () => ({ gatherControlInputs: vi.fn() }));
vi.mock("./recovery.js", () => ({ verifyRecovery: vi.fn() }));
vi.mock("./startup.js", () => ({ validateStartup: vi.fn() }));

import { ControlPlane } from "./evaluator.js";
import { ControlDataError } from "./validate.js";
import * as store from "./store.js";
import { gatherControlInputs } from "./inputs.js";
import { verifyRecovery } from "./recovery.js";
import { validateStartup } from "./startup.js";

const PROPOSAL = { symbol: "BTCUSDT", side: "LONG", targetNotional: "1000" } as unknown as Parameters<RiskGateHook>[0];
const STATE = {} as unknown as Parameters<RiskGateHook>[1];

const disengaged: KillSwitchState = { engaged: false, actor: null, reason: null, engagedAt: null };
const engaged: KillSwitchState = { engaged: true, actor: "op", reason: "halt now", engagedAt: "t" };

const allowed: TradingPermission = { permission: "ALLOWED", generatedAt: 0, reasons: [], blockedBy: [] };
const blocked: TradingPermission = {
  permission: "BLOCKED",
  generatedAt: 0,
  reasons: [],
  blockedBy: [{ check: "database", label: "Database healthy", ok: false, detail: "failing" }],
};

describe("control execution gate (enforcement seam) — fail-closed", () => {
  it("APPROVES when kill disengaged and permission ALLOWED", async () => {
    const gate = createControlExecutionGate({
      readKillSwitch: async () => disengaged,
      currentPermission: () => allowed,
    });
    expect(await gate(PROPOSAL, STATE)).toEqual({ approved: true });
  });

  it("BLOCKS immediately when the live kill switch is engaged (even if permission allows)", async () => {
    const gate = createControlExecutionGate({
      readKillSwitch: async () => engaged,
      currentPermission: () => allowed,
    });
    const d = await gate(PROPOSAL, STATE);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe("TRADING_STOPPED");
  });

  it("BLOCKS when the permission snapshot is BLOCKED", async () => {
    const gate = createControlExecutionGate({
      readKillSwitch: async () => disengaged,
      currentPermission: () => blocked,
    });
    const d = await gate(PROPOSAL, STATE);
    expect(d.approved).toBe(false);
    if (!d.approved) {
      expect(d.reason).toBe("TRADING_BLOCKED");
      expect(d.detail).toContain("Database healthy");
    }
  });

  it("BLOCKS when the control plane has not evaluated yet (no snapshot)", async () => {
    const gate = createControlExecutionGate({
      readKillSwitch: async () => disengaged,
      currentPermission: () => null,
    });
    const d = await gate(PROPOSAL, STATE);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe("CONTROL_NOT_READY");
  });

  it("FAILS CLOSED when the kill-switch read throws", async () => {
    const gate = createControlExecutionGate({
      readKillSwitch: async () => {
        throw new Error("db down");
      },
      currentPermission: () => allowed,
    });
    const d = await gate(PROPOSAL, STATE);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe("FAIL_CLOSED");
  });

  it("FAILS CLOSED on a stale ALLOWED snapshot older than the max age (wedged evaluator)", async () => {
    const NOW = 1_000_000;
    const gate = createControlExecutionGate({
      readKillSwitch: async () => disengaged,
      currentPermission: () => ({ ...allowed, generatedAt: NOW - 90_000 }),
      now: () => NOW,
      maxPermissionAgeMs: 60_000,
    });
    const d = await gate(PROPOSAL, STATE);
    expect(d.approved).toBe(false);
    if (!d.approved) {
      expect(d.reason).toBe("FAIL_CLOSED");
      expect(d.detail).toContain("stale");
    }
  });

  it("APPROVES a fresh ALLOWED snapshot within the max age", async () => {
    const NOW = 1_000_000;
    const gate = createControlExecutionGate({
      readKillSwitch: async () => disengaged,
      currentPermission: () => ({ ...allowed, generatedAt: NOW - 5_000 }),
      now: () => NOW,
      maxPermissionAgeMs: 60_000,
    });
    expect(await gate(PROPOSAL, STATE)).toEqual({ approved: true });
  });
});

// ───────── Phase 11C Stage 3 Batch 2 — fail-closed evaluator on corrupt control rows ─────────

const FRESH = { lagSeconds: 0, staleSeconds: 60, warningSeconds: 30 };
const healthyInputs = (): ControlInputs => ({
  now: 0,
  database: "healthy",
  redis: "healthy",
  quant: "healthy",
  features: { ...FRESH },
  signals: { ...FRESH },
  execution: { ...FRESH },
  riskEngineActive: true,
  killSwitch: { engaged: false, actor: null, reason: null, engagedAt: null },
  startupValidated: true,
});

const makePlane = (log = vi.fn()) =>
  new ControlPlane({ log, getRiskActive: () => true, redisUrl: undefined, quantUrl: undefined });

const corrupt = new ControlDataError(
  "Incident.affectedComponents (incident inc-bad): not an array (got object) — fail-closed, nothing repaired",
  "MALFORMED_INCIDENT",
);

describe("ControlPlane vs corrupt control rows (Stage 3 Batch 2) — fail-closed, locally handled", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(store.getCurrentState).mockResolvedValue("BOOTING");
    vi.mocked(store.getOpenIncident).mockResolvedValue(null);
    vi.mocked(store.openIncident).mockResolvedValue("inc-fresh");
    vi.mocked(store.upsertProtectionEvent).mockResolvedValue("pe-1");
    vi.mocked(verifyRecovery).mockImplementation(async (component) => ({
      component,
      verified: true,
      steps: [{ name: "probe", passed: true, detail: "ok" }],
    }));
    vi.mocked(validateStartup).mockResolvedValue({ passed: true, checks: [] });
  });

  it("stays PROTECTED when the open-incident row is corrupt at recovery exit (cannot reach HEALTHY)", async () => {
    const plane = makePlane();
    vi.mocked(gatherControlInputs).mockResolvedValue({ ...healthyInputs(), database: "failing" });
    const r1 = await plane.evaluate();
    expect(r1.state).toBe("PROTECTED");

    vi.mocked(gatherControlInputs).mockResolvedValue(healthyInputs());
    vi.mocked(store.getOpenIncident).mockRejectedValue(corrupt);
    const r2 = await plane.evaluate();
    expect(r2.state).toBe("PROTECTED");
    expect(store.resolveIncident).not.toHaveBeenCalled();
    expect(verifyRecovery).not.toHaveBeenCalled(); // unverifiable, not "verified over a narrowed set"
    const auditActions = vi.mocked(store.appendAudit).mock.calls.map(([a]) => a.action);
    expect(auditActions).toContain("RECOVERY_FAILED");
    expect(auditActions).not.toContain("RECOVERY_VERIFIED");
  });

  it("opens a FRESH incident when the open-incident read is corrupt on entering PROTECTED (protection never blocked)", async () => {
    const log = vi.fn();
    const plane = makePlane(log);
    vi.mocked(store.getOpenIncident).mockRejectedValue(corrupt);
    vi.mocked(gatherControlInputs).mockResolvedValue({ ...healthyInputs(), database: "failing" });
    const r = await plane.evaluate();
    expect(r.state).toBe("PROTECTED");
    expect(store.openIncident).toHaveBeenCalledTimes(1);
    expect(store.upsertProtectionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ incidentId: "inc-fresh" }),
    );
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("fresh incident"), expect.anything());
  });

  it("skips resolution (incident left OPEN) when the row is corrupt at the resolution read — state transition unaffected", async () => {
    const log = vi.fn();
    const plane = makePlane(log);
    vi.mocked(gatherControlInputs).mockResolvedValue({ ...healthyInputs(), database: "failing" });
    await plane.evaluate(); // → PROTECTED

    vi.mocked(gatherControlInputs).mockResolvedValue(healthyInputs());
    vi.mocked(store.getOpenIncident)
      .mockResolvedValueOnce({ id: "inc-1", affectedComponents: ["database"] }) // recovery-exit read: valid
      .mockRejectedValueOnce(corrupt); // resolution read: corrupt
    const r = await plane.evaluate();
    expect(r.state).toBe("HEALTHY"); // recovery genuinely verified
    expect(verifyRecovery).toHaveBeenCalledWith("database", expect.anything());
    expect(store.resolveIncident).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("error", expect.stringContaining("resolution skipped"), expect.anything());
  });

  it("logs (never silently swallows) an unreadable persisted state at boot and falls back to BOOTING", async () => {
    const log = vi.fn();
    const plane = makePlane(log);
    vi.mocked(store.getCurrentState).mockRejectedValue(
      new ControlDataError('RuntimeStateTransition.state: "HACKED" is not a RuntimeState', "MALFORMED_RUNTIME_STATE"),
    );
    const boot = await plane.boot();
    expect(boot.started).toBe(true);
    expect(log).toHaveBeenCalledWith("error", expect.stringContaining("falling back to BOOTING"), expect.anything());
    // The unreadable state is treated as first boot — nothing corrupt is written back.
    expect(vi.mocked(store.recordTransition).mock.calls[0]?.[0]).toMatchObject({
      state: "BOOTING",
      previousState: null,
    });
  });

  it("still propagates a non-admission error from the recovery-exit incident read (today's semantics preserved)", async () => {
    const plane = makePlane();
    vi.mocked(gatherControlInputs).mockResolvedValue({ ...healthyInputs(), database: "failing" });
    await plane.evaluate();
    vi.mocked(gatherControlInputs).mockResolvedValue(healthyInputs());
    vi.mocked(store.getOpenIncident).mockRejectedValue(new Error("db down"));
    await expect(plane.evaluate()).rejects.toThrow("db down");
  });
});
