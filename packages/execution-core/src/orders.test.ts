import { describe, expect, it } from "vitest";
import {
  applyFillToOrder,
  canTransitionOrder,
  makeOrder,
  sideForRole,
  transitionOrder,
} from "./orders.js";
import { NOW } from "./test-fixtures.js";
import type { ExecutionOrder } from "./types.js";

function order(over: Partial<ExecutionOrder> = {}): ExecutionOrder {
  return {
    ...makeOrder({
      orderId: "o1",
      planId: "p1",
      intentId: "i1",
      symbol: "BTC-PERP",
      direction: "LONG",
      role: "ENTRY",
      type: "LIMIT",
      price: 100,
      quantity: 1,
      now: NOW,
    }),
    ...over,
  };
}

describe("orders — side + construction", () => {
  it("side follows direction and role", () => {
    expect(sideForRole("LONG", "ENTRY")).toBe("BUY");
    expect(sideForRole("LONG", "STOP")).toBe("SELL");
    expect(sideForRole("LONG", "TARGET")).toBe("SELL");
    expect(sideForRole("SHORT", "ENTRY")).toBe("SELL");
    expect(sideForRole("SHORT", "STOP")).toBe("BUY");
  });

  it("a priced order is VERBATIM, a null-price order is UNAVAILABLE", () => {
    expect(order().provenance).toBe("VERBATIM");
    expect(makeOrder({ ...({} as never), orderId: "o", planId: "p", intentId: "i", symbol: "S", direction: "LONG", role: "ENTRY", type: "MARKET", price: null, quantity: 1, now: NOW }).provenance).toBe("UNAVAILABLE");
  });

  it("starts PLANNED with zero fill", () => {
    const o = order();
    expect(o.status).toBe("PLANNED");
    expect(o.filledQuantity).toBe(0);
    expect(o.avgFillPrice).toBeNull();
  });
});

describe("orders — transitions", () => {
  it("legal transition advances, illegal returns the same reference", () => {
    const planned = order();
    const ready = transitionOrder(planned, "READY", NOW + 1);
    expect(ready.status).toBe("READY");
    const illegal = transitionOrder(planned, "FILLED", NOW + 1);
    expect(illegal).toBe(planned); // unchanged reference
  });

  it("canTransitionOrder reflects the map", () => {
    expect(canTransitionOrder("PLANNED", "READY")).toBe(true);
    expect(canTransitionOrder("FILLED", "READY")).toBe(false);
  });
});

describe("orders — fills + VWAP", () => {
  it("partial then full fill computes the volume-weighted average price", () => {
    let o = transitionOrder(transitionOrder(transitionOrder(order({ quantity: 2 }), "READY", NOW), "SUBMITTED", NOW), "ACKNOWLEDGED", NOW);
    o = applyFillToOrder(o, 100, 1, NOW + 1);
    expect(o.status).toBe("PARTIALLY_FILLED");
    expect(o.avgFillPrice).toBe(100);
    o = applyFillToOrder(o, 110, 1, NOW + 2);
    expect(o.status).toBe("FILLED");
    expect(o.avgFillPrice).toBe(105); // (100*1 + 110*1) / 2
    expect(o.filledQuantity).toBe(2);
  });

  it("over-fill is clamped to the order quantity (fail-closed)", () => {
    let o = transitionOrder(transitionOrder(transitionOrder(order({ quantity: 1 }), "READY", NOW), "SUBMITTED", NOW), "ACKNOWLEDGED", NOW);
    o = applyFillToOrder(o, 100, 5, NOW + 1);
    expect(o.filledQuantity).toBe(1);
    expect(o.status).toBe("FILLED");
  });
});
