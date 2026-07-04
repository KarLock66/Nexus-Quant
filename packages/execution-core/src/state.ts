/**
 * state.ts — the deterministic execution state machine (reducer).
 *
 * `reduceExecution(state, command)` is the ONE way execution advances. It is pure: every
 * step returns a NEW {@link ExecutionState} (inputs never mutated), reads only the injected
 * clock carried on the command (`at`), and appends exactly one immutable audit event per
 * successful transition. Illegal transitions are REJECTED — the state is returned unchanged
 * with an ILLEGAL_TRANSITION failure and no event/seq advance. Fail-closed guards (kill
 * switch, runtime health, not-submittable) short-circuit to CANCELLED / FAILED / rejected.
 */

import { appendEvent, emptyAudit } from "./audit.js";
import { makeEvent } from "./events.js";
import { applyFillToOrder, transitionOrder } from "./orders.js";
import { makeFill, nextFillSeq } from "./fills.js";
import { closePosition, emptyPosition, openPosition, reducePosition } from "./positions.js";
import type {
  ExecutionCommand,
  ExecutionEntity,
  ExecutionEventType,
  ExecutionFailure,
  ExecutionFailureReason,
  ExecutionIntent,
  ExecutionLifecycle,
  ExecutionOrder,
  ExecutionPlan,
  ExecutionProvenance,
  ExecutionResult,
  ExecutionSource,
  ExecutionState,
  ExecutionStatus,
  OrderStatus,
} from "./types.js";

// ─────────────────────────── State machine definition ───────────────────────────

export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  "CLOSED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);

/**
 * Legal top-level transitions. CANCELLED (kill switch / manual) and FAILED (runtime
 * unhealthy) are reachable from every non-terminal status by design; terminal statuses
 * admit nothing further.
 */
const EXEC_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  NOT_CREATED: ["PLANNED", "REJECTED", "CANCELLED", "FAILED"],
  PLANNED: ["READY", "REJECTED", "EXPIRED", "CANCELLED", "FAILED"],
  READY: ["SUBMITTED", "REJECTED", "EXPIRED", "CANCELLED", "FAILED"],
  SUBMITTED: ["ACKNOWLEDGED", "REJECTED", "EXPIRED", "CANCELLED", "FAILED"],
  ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "REJECTED", "EXPIRED", "CANCELLED", "FAILED"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "FAILED"],
  FILLED: ["OPEN", "CANCELLED", "FAILED"],
  OPEN: ["REDUCING", "CLOSED", "CANCELLED", "FAILED"],
  REDUCING: ["REDUCING", "OPEN", "CLOSED", "CANCELLED", "FAILED"],
  CLOSED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
};

export function isTerminal(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXEC_TRANSITIONS[from].includes(to);
}

// ─────────────────────────── Construction ───────────────────────────

/** Build the initial NOT_CREATED state for an intent (+ its plan, when already generated). */
export function initExecutionState(
  intent: ExecutionIntent,
  plan: ExecutionPlan | null,
): ExecutionState {
  const lifecycle: ExecutionLifecycle = {
    current: "NOT_CREATED",
    history: ["NOT_CREATED"],
    terminal: false,
  };
  return {
    intentId: intent.intentId,
    signalId: intent.signalId,
    symbol: intent.symbol,
    status: "NOT_CREATED",
    mode: intent.mode,
    venue: intent.venue,
    intent,
    plan,
    orders: plan ? plan.orders.map((o) => ({ ...o })) : [],
    fills: [],
    position: emptyPosition(intent),
    lifecycle,
    audit: emptyAudit(intent.intentId),
    failure: null,
    seq: 0,
    clock: intent.createdAt,
    updatedAt: intent.createdAt,
    createdAt: intent.createdAt,
  };
}

// ─────────────────────────── Internal commit helpers ───────────────────────────

interface Commit {
  status: ExecutionStatus;
  type: ExecutionEventType;
  entity: ExecutionEntity;
  entityId: string;
  source: ExecutionSource;
  provenance: ExecutionProvenance;
  reason: string;
  at: number;
  /** Optional deep patches applied alongside the status transition. */
  orders?: ExecutionOrder[];
  fills?: ExecutionState["fills"];
  position?: ExecutionState["position"];
  failure?: ExecutionFailure | null;
}

/** Apply a validated transition, appending exactly one audit event. Pure. */
function commit(state: ExecutionState, c: Commit): ExecutionResult {
  const seq = state.seq + 1;
  const event = makeEvent({
    intentId: state.intentId,
    seq,
    entity: c.entity,
    entityId: c.entityId,
    type: c.type,
    previousStatus: state.status,
    newStatus: c.status,
    source: c.source,
    provenance: c.provenance,
    reason: c.reason,
    ts: c.at,
  });
  const lifecycle: ExecutionLifecycle = {
    current: c.status,
    history: [...state.lifecycle.history, c.status],
    terminal: isTerminal(c.status),
  };
  const next: ExecutionState = {
    ...state,
    status: c.status,
    orders: c.orders ?? state.orders,
    fills: c.fills ?? state.fills,
    position: c.position === undefined ? state.position : c.position,
    lifecycle,
    audit: appendEvent(state.audit, event),
    failure: c.failure === undefined ? state.failure : c.failure,
    seq,
    clock: c.at,
    updatedAt: c.at,
  };
  return { ok: true, state: next, event, failure: next.failure };
}

/** Reject a command without mutating state (no event, no seq advance). */
function reject(
  state: ExecutionState,
  reason: ExecutionFailureReason,
  message: string,
  at: number,
): ExecutionResult {
  return {
    ok: false,
    state,
    event: null,
    failure: { reason, message, at, fatal: false },
  };
}

/** Advance every non-terminal order to a terminal status (used by CANCEL / KILL / FAIL). */
function terminateOrders(orders: ExecutionOrder[], to: OrderStatus, at: number): ExecutionOrder[] {
  return orders.map((o) => transitionOrder(o, to, at));
}

// ─────────────────────────── Reducer ───────────────────────────

export function reduceExecution(state: ExecutionState, command: ExecutionCommand): ExecutionResult {
  const at = command.at;

  // Terminal states admit nothing (except a redundant re-cancel/fail no-op → reject).
  if (isTerminal(state.status) && command.type !== "KILL") {
    // KILL on a terminal state is a benign no-op reject too; keep it uniform.
    return reject(state, "ILLEGAL_TRANSITION", `${state.status} is terminal`, at);
  }

  switch (command.type) {
    // ── Kill switch: any non-terminal → CANCELLED, orders cancelled, open position closed ──
    case "KILL": {
      if (isTerminal(state.status)) return reject(state, "ILLEGAL_TRANSITION", `${state.status} is terminal`, at);
      const position =
        state.position && (state.position.status === "OPEN" || state.position.status === "REDUCING")
          ? closePosition(state.position, at)
          : state.position;
      return commit(state, {
        status: "CANCELLED",
        type: "KILLED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "KILL_SWITCH",
        provenance: "DERIVED",
        reason: "kill switch engaged → immediate CANCELLED",
        at,
        orders: terminateOrders(state.orders, "CANCELLED", at),
        position,
        failure: { reason: "KILL_SWITCH", message: "kill switch engaged", at, fatal: false },
      });
    }

    // ── Runtime unhealthy: any non-terminal → FAILED ──
    case "RUNTIME_UNHEALTHY": {
      return commit(state, {
        status: "FAILED",
        type: "FAILED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "RUNTIME",
        provenance: "DERIVED",
        reason: "runtime unhealthy → FAILED",
        at,
        orders: terminateOrders(state.orders, "FAILED", at),
        failure: { reason: "RUNTIME_UNHEALTHY", message: "runtime unhealthy", at, fatal: true },
      });
    }

    case "PLAN": {
      if (!canTransition(state.status, "PLANNED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot PLAN from ${state.status}`, at);
      }
      if (!state.plan) return reject(state, "NO_PLAN", "no ExecutionPlan attached", at);
      return commit(state, {
        status: "PLANNED",
        type: "PLANNED",
        entity: "PLAN",
        entityId: state.plan.planId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: "execution planned from decision + trade plan",
        at,
      });
    }

    case "ARM": {
      if (!canTransition(state.status, "READY")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot ARM from ${state.status}`, at);
      }
      // Fail-closed: only a submittable plan may arm.
      if (!state.plan || !state.plan.submittable) {
        const reason = state.plan?.blockedReason ?? "NO_PLAN";
        return reject(state, reason, `plan not submittable: ${reason}`, at);
      }
      return commit(state, {
        status: "READY",
        type: "ARMED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: "all fail-closed gates pass → READY",
        at,
        orders: state.orders.map((o) => transitionOrder(o, "READY", at)),
      });
    }

    case "SUBMIT": {
      if (!canTransition(state.status, "SUBMITTED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot SUBMIT from ${state.status}`, at);
      }
      if (!state.plan || !state.plan.submittable) {
        const reason = state.plan?.blockedReason ?? "NO_PLAN";
        return reject(state, reason, `plan not submittable: ${reason}`, at);
      }
      return commit(state, {
        status: "SUBMITTED",
        type: "SUBMITTED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: "orders submitted",
        at,
        orders: state.orders.map((o) => transitionOrder(o, "SUBMITTED", at)),
      });
    }

    case "ACKNOWLEDGE": {
      if (!canTransition(state.status, "ACKNOWLEDGED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot ACKNOWLEDGE from ${state.status}`, at);
      }
      return commit(state, {
        status: "ACKNOWLEDGED",
        type: "ACKNOWLEDGED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: "venue acknowledged orders",
        at,
        orders: state.orders.map((o) => transitionOrder(o, "ACKNOWLEDGED", at)),
      });
    }

    case "FILL":
      return reduceFill(state, command, at);

    case "OPEN": {
      if (!canTransition(state.status, "OPEN")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot OPEN from ${state.status}`, at);
      }
      const entry = state.orders.find((o) => o.role === "ENTRY");
      if (!entry || entry.filledQuantity <= 0) {
        return reject(state, "MISSING_ENTRY", "no filled entry to open a position", at);
      }
      const position = openPosition(state.intent, entry.filledQuantity, entry.avgFillPrice, at);
      return commit(state, {
        status: "OPEN",
        type: "OPENED",
        entity: "POSITION",
        entityId: position.positionId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: "position opened from filled entry",
        at,
        position,
      });
    }

    case "REDUCE": {
      if (!canTransition(state.status, "REDUCING")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot REDUCE from ${state.status}`, at);
      }
      if (!state.position || (state.position.status !== "OPEN" && state.position.status !== "REDUCING")) {
        return reject(state, "ILLEGAL_TRANSITION", "no open position to reduce", at);
      }
      const position = reducePosition(state.position, command.quantity, at);
      const status: ExecutionStatus = position.status === "CLOSED" ? "CLOSED" : "REDUCING";
      return commit(state, {
        status,
        type: status === "CLOSED" ? "CLOSED" : "REDUCED",
        entity: "POSITION",
        entityId: position.positionId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: status === "CLOSED" ? "position fully reduced → CLOSED" : "position reduced",
        at,
        position,
      });
    }

    case "CLOSE": {
      if (!canTransition(state.status, "CLOSED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot CLOSE from ${state.status}`, at);
      }
      const position = state.position ? closePosition(state.position, at) : state.position;
      return commit(state, {
        status: "CLOSED",
        type: "CLOSED",
        entity: "POSITION",
        entityId: position?.positionId ?? state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: "position closed",
        at,
        orders: terminateOrders(state.orders, "CANCELLED", at),
        position,
      });
    }

    case "CANCEL": {
      if (!canTransition(state.status, "CANCELLED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot CANCEL from ${state.status}`, at);
      }
      const position =
        state.position && (state.position.status === "OPEN" || state.position.status === "REDUCING")
          ? closePosition(state.position, at)
          : state.position;
      return commit(state, {
        status: "CANCELLED",
        type: "CANCELLED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: command.reason ?? "execution cancelled",
        at,
        orders: terminateOrders(state.orders, "CANCELLED", at),
        position,
        failure: { reason: "CANCELLED", message: command.reason ?? "cancelled", at, fatal: false },
      });
    }

    case "REJECT": {
      if (!canTransition(state.status, "REJECTED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot REJECT from ${state.status}`, at);
      }
      return commit(state, {
        status: "REJECTED",
        type: "REJECTED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: command.reason ?? "execution rejected",
        at,
        orders: terminateOrders(state.orders, "REJECTED", at),
        failure: { reason: "REJECTED", message: command.reason ?? "rejected", at, fatal: true },
      });
    }

    case "EXPIRE": {
      if (!canTransition(state.status, "EXPIRED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot EXPIRE from ${state.status}`, at);
      }
      return commit(state, {
        status: "EXPIRED",
        type: "EXPIRED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: "execution expired",
        at,
        orders: terminateOrders(state.orders, "EXPIRED", at),
        failure: { reason: "EXPIRED", message: "expired", at, fatal: false },
      });
    }

    case "FAIL": {
      if (!canTransition(state.status, "FAILED")) {
        return reject(state, "ILLEGAL_TRANSITION", `cannot FAIL from ${state.status}`, at);
      }
      return commit(state, {
        status: "FAILED",
        type: "FAILED",
        entity: "EXECUTION",
        entityId: state.intentId,
        source: "EXECUTION_CORE",
        provenance: "DERIVED",
        reason: command.reason ?? "execution failed",
        at,
        orders: terminateOrders(state.orders, "FAILED", at),
        failure: { reason: "FAILED", message: command.reason ?? "failed", at, fatal: true },
      });
    }

    default: {
      // Exhaustiveness guard — an unknown command is rejected, never silently ignored.
      const _never: never = command;
      return reject(state, "UNKNOWN", `unknown command ${(_never as { type?: string }).type ?? "?"}`, at);
    }
  }
}

// ─────────────────────────── FILL handling ───────────────────────────

function reduceFill(
  state: ExecutionState,
  command: Extract<ExecutionCommand, { type: "FILL" }>,
  at: number,
): ExecutionResult {
  const order = state.orders.find((o) => o.orderId === command.orderId);
  if (!order) return reject(state, "VALIDATION_FAILED", `no order ${command.orderId}`, at);
  if (command.quantity <= 0 || !Number.isFinite(command.price)) {
    return reject(state, "VALIDATION_FAILED", "fill needs a positive quantity and finite price", at);
  }

  const filled = applyFillToOrder(order, command.price, command.quantity, at);
  const fillSeq = nextFillSeq(state.fills, order.orderId);
  const fill = makeFill({
    order,
    fillSeq,
    price: command.price,
    quantity: command.quantity,
    cumulativeQuantity: filled.filledQuantity,
    at,
  });
  const orders = state.orders.map((o) => (o.orderId === order.orderId ? filled : o));
  const fills = [...state.fills, fill];

  // ENTRY fills drive the fill lifecycle (PARTIALLY_FILLED → FILLED).
  if (order.role === "ENTRY") {
    const target: ExecutionStatus = filled.status === "FILLED" ? "FILLED" : "PARTIALLY_FILLED";
    if (!canTransition(state.status, target)) {
      return reject(state, "ILLEGAL_TRANSITION", `cannot ${target} from ${state.status}`, at);
    }
    return commit(state, {
      status: target,
      type: target === "FILLED" ? "FILLED" : "PARTIALLY_FILLED",
      entity: "ORDER",
      entityId: order.orderId,
      source: "EXECUTION_CORE",
      provenance: "DERIVED",
      reason: target === "FILLED" ? "entry fully filled" : "entry partially filled",
      at,
      orders,
      fills,
    });
  }

  // Protective (STOP / TARGET) fills reduce an open position.
  if (!state.position || (state.position.status !== "OPEN" && state.position.status !== "REDUCING")) {
    return reject(state, "ILLEGAL_TRANSITION", "protective fill with no open position", at);
  }
  const position = reducePosition(state.position, command.quantity, at);
  const status: ExecutionStatus = position.status === "CLOSED" ? "CLOSED" : "REDUCING";
  if (!canTransition(state.status, status)) {
    return reject(state, "ILLEGAL_TRANSITION", `cannot ${status} from ${state.status}`, at);
  }
  return commit(state, {
    status,
    type: status === "CLOSED" ? "CLOSED" : "REDUCED",
    entity: "POSITION",
    entityId: position.positionId,
    source: "EXECUTION_CORE",
    provenance: "DERIVED",
    reason: status === "CLOSED" ? `${order.role} fill closed position` : `${order.role} fill reduced position`,
    at,
    orders,
    fills,
    position,
  });
}

/** Fold a sequence of commands, stopping at the first rejection (returns the last result). */
export function reduceSequence(
  state: ExecutionState,
  commands: readonly ExecutionCommand[],
): ExecutionResult {
  let cur: ExecutionResult = { ok: true, state, event: null, failure: state.failure };
  for (const command of commands) {
    cur = reduceExecution(cur.state, command);
    if (!cur.ok) return cur;
  }
  return cur;
}
