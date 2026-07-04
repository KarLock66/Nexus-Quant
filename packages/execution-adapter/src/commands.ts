/**
 * commands.ts — the deterministic command set the adapter accepts.
 *
 * Every command carries the injected clock `at` (epoch ms) — the adapter NEVER reads a wall
 * clock. Broker-shaped commands (ACKNOWLEDGE / FILL) carry ONLY data a venue callback would
 * relay; the adapter fabricates nothing (no simulated prices, no auto-fills). SUBMIT carries
 * the {@link RuntimeContext} snapshot so the fail-closed gates are re-checked at submit time.
 */

import type { RuntimeContext } from "./runtime.js";

/**
 * Submit the bound execution's plan across the venue boundary. The runtime snapshot is
 * re-validated (kill switch / health) before anything is driven into the core.
 */
export interface SubmitCommand {
  type: "SUBMIT";
  at: number;
  runtime: RuntimeContext;
}

/** A venue acknowledgement of the submitted orders (injected — never fabricated). */
export interface AcknowledgeCommand {
  type: "ACKNOWLEDGE";
  at: number;
}

/**
 * An injected fill against a specific order. The paper adapter accepts these VERBATIM — it
 * never invents a price, a quantity, or market movement. Price/quantity are relayed from the
 * (mock) execution sink exactly as supplied.
 */
export interface FillCommand {
  type: "FILL";
  at: number;
  orderId: string;
  price: number;
  quantity: number;
}

/**
 * Cancel targeting a specific order of the bound execution. NOTE: the sealed core has no
 * per-order cancel — this resolves to an EXECUTION-SCOPED cancel (all orders terminated, any
 * open position closed). `orderId` records the caller's intent (surfaced in the event reason);
 * the emitted CANCELLED event itself is tagged orderId=null to reflect the true blast radius.
 * True per-order cancel is deferred to a live broker adapter (Phase 11B+).
 */
export interface CancelCommand {
  type: "CANCEL";
  at: number;
  orderId: string;
  reason?: string;
}

/** Cancel the entire bound execution. */
export interface CancelAllCommand {
  type: "CANCEL_ALL";
  at: number;
  reason?: string;
}

/**
 * Replace a resting order. Real replace is a venue capability (cancel a live order handle +
 * place a new one) that neither the paper nor null foundation can honor without inventing
 * order mechanics — so it fails closed here. Declared so a broker adapter attaches it later
 * WITHOUT changing this contract.
 */
export interface ReplaceCommand {
  type: "REPLACE";
  at: number;
  orderId: string;
  reason?: string;
}

/** Shut the adapter down. A non-terminal execution is cancelled (fail-safe) as part of this. */
export interface ShutdownCommand {
  type: "SHUTDOWN";
  at: number;
  reason?: string;
}

export type AdapterCommand =
  | SubmitCommand
  | AcknowledgeCommand
  | FillCommand
  | CancelCommand
  | CancelAllCommand
  | ReplaceCommand
  | ShutdownCommand;

export type AdapterCommandType = AdapterCommand["type"];
