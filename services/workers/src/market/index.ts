/**
 * Market Integration Layer — public module surface (Phase 6).
 *
 * The effectful market tail BELOW the Phase 5 execution result:
 *   ExecutionIntent -> Order -> (broker) OrderEvent* -> Fill -> Position/Account
 *                   -> reconcile(broker, portfolio) -> ExecutionResult
 *
 * `createMarketExecutionAdapter` returns an object satisfying the Phase 5
 * ExecutionAdapter interface, so it drops into the UNCHANGED Phase 5 execution
 * stage (opt-in) without touching any sealed code path. Everything here is pure
 * and deterministic except the single broker edge (and the interface-only real
 * broker / realtime provider, which throw) — so replay determinism and lineage
 * integrity hold exactly as they do upstream.
 */

export * from "./types.js";
export * from "./money.js";
export * from "./market-data.js";
export * from "./order.js";
export * from "./broker.js";
export * from "./position.js";
export * from "./account.js";
export * from "./state.js";
export * from "./reconcile.js";
export * from "./market-bus.js";
export * from "./stage.js";
// Phase 7 — Order & Position durability (append-only store + restart reconstruction).
export * from "./event-store.js";
export * from "./recovery.js";
// Phase 9 — opt-in DB-backed realtime quote transport (real exchange marks).
export * from "./db-quote-transport.js";
// Final production completion — Deribit private-API order transport (real venue).
export * from "./deribit-order-transport.js";
// Final production completion — persistent portfolio & equity ledger (DB-backed).
export * from "./portfolio-ledger.js";
