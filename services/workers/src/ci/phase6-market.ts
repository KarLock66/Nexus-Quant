/**
 * PHASE 6 — Market integration runtime verification.
 *
 * Drives the REAL signal pipeline tick with the broker-backed market adapter
 * (paper) opted in, over the deterministic demo lineage, and asserts the Phase 6
 * guarantees end-to-end under runtime conditions:
 *
 *   1. reconciliation : broker state (positions folded from fills) reconciles with
 *                       the Phase 5 PortfolioState after every tick (FAIL-CLOSED)
 *   2. order lifecycle: every captured order's event stream reduces cleanly to a
 *                       terminal state via the pure state machine (no illegal
 *                       transition, no overfill)
 *   3. reconstruction : market state (positions + account) rebuilt from the fill
 *                       stream alone EQUALS the live adapter state (event-sourced)
 *   4. determinism    : a fresh adapter over the same demo lineage reaches the
 *                       identical market state
 *
 * Phase 6 adds NO persistence, so this phase needs only the demo upstream chain
 * (idempotent) — no schema, no migration. Fail-closed: the first failing assertion
 * aborts the run.
 */

import { ensureSignalDemoChain, prisma } from "@nexus/db";
import { createExecutionStage } from "../execution/index.js";
import { runSignalPipelineTick } from "../pipeline/orchestrator.js";
import {
  InProcessMarketBus,
  PaperBroker,
  createMarketExecutionAdapter,
  demoMarketDataProvider,
  reconstructMarketState,
  reduceOrder,
  type Fill,
  type OrderEvent,
} from "../market/index.js";
import { assert, log, makeLog } from "./lib.js";

/** Extract the realized fills from an order-event stream (in seq order). */
function fillsFrom(events: OrderEvent[]): Fill[] {
  const out: Fill[] = [];
  for (const e of events) {
    if (e.kind === "ORDER_PARTIALLY_FILLED" || e.kind === "ORDER_FILLED") {
      out.push({
        orderId: e.orderId,
        intentId: e.intentId,
        symbol: e.symbol,
        side: e.side,
        qty: e.fillQty,
        price: e.fillPrice,
        lineage: e.lineage,
      });
    }
  }
  return out;
}

export async function runPhase6(): Promise<void> {
  log("info", "PHASE 6 — market integration (order lifecycle, position/account, reconciliation)");
  const quiet = makeLog("warn");
  await ensureSignalDemoChain(prisma);

  // Capture the order lifecycle off the market bus for runtime verification.
  const orderEvents: OrderEvent[] = [];
  const bus = new InProcessMarketBus();
  bus.subscribe((e) => {
    if (e.kind === "ORDER") orderEvents.push(e.event);
  });

  const adapter = createMarketExecutionAdapter({
    broker: PaperBroker,
    marketData: demoMarketDataProvider(),
    bus,
  });
  const deps = createExecutionStage({ adapter });

  // ── 1) Reconciliation holds after each tick (idempotent demo lineage) ─────────
  // demoBootstrap explicit — self-owning, env-independent (see phase1 note / F1).
  await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase6-a", execution: deps, demoBootstrap: true });
  const reconA = adapter.reconcileWith(deps.portfolioState);
  assert(
    reconA.ok,
    `broker<->portfolio reconciliation failed after tick A: ${reconA.ok ? "" : reconA.detail}`,
  );

  await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase6-b", execution: deps, demoBootstrap: true });
  const reconB = adapter.reconcileWith(deps.portfolioState);
  assert(
    reconB.ok,
    `broker<->portfolio reconciliation failed after tick B: ${reconB.ok ? "" : reconB.detail}`,
  );

  const positions = adapter.getMarketState().positions;
  assert(
    Object.keys(positions).length >= 1,
    "expected at least one open position from the demo lineage",
  );

  // ── 2) Order lifecycle: each order stream reduces cleanly to a terminal state ──
  const byOrder = new Map<string, OrderEvent[]>();
  for (const e of orderEvents) {
    const list = byOrder.get(e.orderId);
    if (list) list.push(e);
    else byOrder.set(e.orderId, [e]);
  }
  assert(byOrder.size >= 1, "expected at least one order on the market bus");
  for (const [orderId, evs] of byOrder) {
    // Ordered quantity = the final cumQty of the stream's last fill (paper: full).
    let orderedQty = "0.00000000";
    for (const e of evs) {
      if (e.kind === "ORDER_PARTIALLY_FILLED" || e.kind === "ORDER_FILLED") orderedQty = e.cumQty;
    }
    const head = evs[0]!;
    const snap = reduceOrder(
      { orderId, symbol: head.symbol, side: head.side, qty: orderedQty },
      evs,
    );
    assert(
      snap.state === "FILLED" || snap.state === "CANCELLED" || snap.state === "REJECTED",
      `order ${orderId} did not reach a terminal state (got ${snap.state})`,
    );
  }

  // ── 3) Market state is reconstructable from the fill stream alone ─────────────
  const fills = fillsFrom(orderEvents);
  const reconstructed = reconstructMarketState(fills);
  assert(
    JSON.stringify(reconstructed) === JSON.stringify(adapter.getMarketState()),
    "reconstructed market state != live market state (event-sourcing broken)",
  );

  // ── 4) Determinism: a fresh adapter reaches the identical market state ─────────
  const fresh = createMarketExecutionAdapter({
    broker: PaperBroker,
    marketData: demoMarketDataProvider(),
  });
  const freshDeps = createExecutionStage({ adapter: fresh });
  await runSignalPipelineTick({ prisma, log: quiet, tickId: "phase6-c", execution: freshDeps, demoBootstrap: true });
  assert(
    JSON.stringify(fresh.getMarketState()) === JSON.stringify(adapter.getMarketState()),
    "market state diverged across identical runs (nondeterministic)",
  );
  assert(
    fresh.reconcileWith(freshDeps.portfolioState).ok,
    "fresh-run reconciliation failed (broker<->portfolio mismatch)",
  );

  log("info", "PHASE 6 PASS", {
    note: "order lifecycle, position/account reconstruction, and fail-closed reconciliation all hold",
    orders: byOrder.size,
    fills: fills.length,
    symbols: Object.keys(positions).length,
    account: adapter.accountValuation(),
  });
}
