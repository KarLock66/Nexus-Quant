import { describe, expect, it } from "vitest";
import type { KillSwitchState, TradingPermission } from "@nexus/control";
import { createControlExecutionGate } from "./gate.js";
import type { RiskGateHook } from "../execution/stage.js";

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
