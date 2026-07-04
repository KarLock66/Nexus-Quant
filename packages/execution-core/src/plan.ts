/**
 * plan.ts — Generate an ExecutionPlan (concrete order set) from an ExecutionIntent.
 *
 * The plan derives one ENTRY order plus a protective STOP and one LIMIT order per served
 * TARGET. Prices are VERBATIM from the intent's levels; quantities are DERIVED by splitting
 * the VERBATIM position size evenly across the targets (remainder to the last, deterministic).
 * The plan is `submittable` only when every fail-closed gate in {@link checkSubmittable}
 * passes; otherwise `blockedReason` records the WHY and the plan cannot reach SUBMITTED.
 *
 * Requires a plan-backed intent (callers guard the served TradePlan's presence first) — with
 * no TradePlan there is no ExecutionPlan.
 */

import { makeOrder } from "./orders.js";
import { checkSubmittable } from "./validation.js";
import { num, orderId as makeOrderId, planId as makePlanId, round } from "./util.js";
import type { ExecutionIntent, ExecutionOrder, ExecutionPlan } from "./types.js";

/** Split a total quantity into n deterministic parts (equal, remainder to the last). */
function splitQuantity(total: number | null, n: number): (number | null)[] {
  if (n <= 0) return [];
  if (total === null) return Array.from({ length: n }, () => null);
  const per = round(total / n, 8);
  const parts: number[] = [];
  for (let i = 0; i < n - 1; i++) parts.push(per);
  parts.push(round(total - per * (n - 1), 8));
  return parts;
}

export function buildExecutionPlan(intent: ExecutionIntent): ExecutionPlan {
  const planId = makePlanId(intent.intentId);
  const totalQuantity = num(intent.positionSize);
  const orders: ExecutionOrder[] = [];
  let idx = 0;

  // ENTRY — LIMIT at the served entry (VERBATIM). No entry ⇒ price null ⇒ UNAVAILABLE order.
  orders.push(
    makeOrder({
      orderId: makeOrderId(planId, "entry", idx++),
      planId,
      intentId: intent.intentId,
      symbol: intent.symbol,
      direction: intent.direction,
      role: "ENTRY",
      type: "LIMIT",
      price: intent.entry,
      quantity: totalQuantity,
      now: intent.createdAt,
    }),
  );

  // STOP — protective stop-trigger at the served stop (VERBATIM).
  orders.push(
    makeOrder({
      orderId: makeOrderId(planId, "stop", idx++),
      planId,
      intentId: intent.intentId,
      symbol: intent.symbol,
      direction: intent.direction,
      role: "STOP",
      type: "STOP",
      price: intent.stop,
      quantity: totalQuantity,
      now: intent.createdAt,
    }),
  );

  // TARGET — one LIMIT per served take-profit, quantity split across them.
  const parts = splitQuantity(totalQuantity, intent.targets.length);
  intent.targets.forEach((target, i) => {
    orders.push(
      makeOrder({
        orderId: makeOrderId(planId, "target", idx++),
        planId,
        intentId: intent.intentId,
        symbol: intent.symbol,
        direction: intent.direction,
        role: "TARGET",
        type: "LIMIT",
        price: target,
        quantity: parts[i] ?? null,
        now: intent.createdAt,
      }),
    );
  });

  const blockedReason = checkSubmittable(intent);
  const notes = [...intent.notes];
  if (blockedReason) notes.push(`not submittable: ${blockedReason}`);

  return {
    planId,
    intentId: intent.intentId,
    signalId: intent.signalId,
    symbol: intent.symbol,
    direction: intent.direction,
    mode: intent.mode,
    venue: intent.venue,
    orders,
    totalQuantity,
    submittable: blockedReason === null,
    blockedReason,
    provenance: "DERIVED",
    notes,
    createdAt: intent.createdAt,
  };
}
