/**
 * Phase 9.7 — worker control plane (enforcement side). Public surface:
 *   - ControlPlane            : the per-tick evaluator + boot/startup sequence
 *   - createControlExecutionGate : the fail-closed execution gate (RiskGateHook)
 *   - store helpers           : kill switch + audit reads/writes (also used by the seal)
 *
 * Pure decision logic lives in @nexus/control; this package is the IO + Prisma adapter.
 */

export { ControlPlane, type ControlPlaneDeps } from "./evaluator.js";
export { createControlExecutionGate, type ControlGateDeps } from "./gate.js";
export {
  appendAudit,
  engageKillSwitch,
  getKillSwitch,
  getCurrentState,
  getLatestTransition,
  resumeKillSwitch,
} from "./store.js";
export { validateStartup } from "./startup.js";
export { gatherControlInputs } from "./inputs.js";
