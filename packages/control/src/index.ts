/**
 * @nexus/control — Phase 9.7 Production Control Plane (pure, deterministic core).
 *
 * The single source of truth for the runtime state machine, trading-permission engine,
 * protection rules, recovery aggregation, startup aggregation, and operator runbooks.
 * Imported by BOTH the worker (enforcement) and the web tier (display). IO-free.
 */

export * from "./types.js";
export * from "./thresholds.js";
export { deriveRuntimeState } from "./state-machine.js";
export {
  evaluateTradingPermission,
} from "./permission.js";
export {
  evaluateProtectionRules,
  activeProtections,
  isDegraded,
} from "./protection.js";
export {
  RECOVERY_PLAN,
  recoveryOutcome,
  componentsNeedingRecovery,
} from "./recovery.js";
export {
  REQUIRED_STARTUP_CHECKS,
  summarizeStartup,
  type StartupCheckName,
} from "./startup.js";
export {
  RUNBOOKS,
  runbookFor,
  applicableRunbooks,
  allRunbooks,
} from "./runbooks.js";
