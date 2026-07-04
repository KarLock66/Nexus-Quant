/**
 * DeribitOrderTransport — live-venue order routing mapped onto the canonical
 * OrderEvent stream, verified with an injected fake venue (no live IO).
 *
 * The invariant under test: EVERY stream this transport emits must be accepted
 * by the pure reduceOrder state machine (the single fail-closed validator), and
 * every fill must be the venue's outcome VERBATIM — never fabricated, never an
 * overfill, never a FILLED that is not a complete fill.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DERIBIT_INSTRUMENT_MAP,
  DeribitOrderError,
  DeribitOrderTransport,
  readDeribitEnvConfig,
} from "./deribit-order-transport.js";
import { reduceOrder } from "./order.js";
import type { ExecutionLineage, Order } from "./types.js";

const LINEAGE: ExecutionLineage = {
  strategyVersionId: "sv-1",
  featureSnapshotId: "fs-1",
  dqReportId: "dq-1",
  datasetHash: "dataset-hash-1",
  featureHash: "feature-hash-1",
  executionStrategyId: "core-technical",
  executionStrategyVersion: 1,
  intentId: "intent-live",
  netScore: "500000.00",
  contributions: [],
};

function order(overrides: Partial<Order> = {}): Order {
  return {
    orderId: "ord-live-1",
    intentId: "intent-live",
    symbol: "BTC-PERP",
    side: "BUY",
    qty: "0.00300000",
    price: "62000.00000000",
    brokerId: "real",
    lineage: LINEAGE,
    ...overrides,
  };
}

const INSTRUMENT = {
  instrument_name: "BTC_USDC-PERPETUAL",
  contract_size: 0.001,
  min_trade_amount: 0.001,
  quote_currency: "USDC",
  settlement_currency: "USDC",
  is_active: true,
};

type RpcHandler = (params: Record<string, unknown>) => unknown;

/**
 * Fake Deribit JSON-RPC endpoint. Handlers return the `result` payload (or throw
 * {rpc:{code,message}} to yield an error envelope). Records every call.
 */
function fakeVenue(handlers: Record<string, RpcHandler>) {
  const calls: { method: string; params: Record<string, unknown>; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: body.method,
      params: body.params,
      auth: headers["authorization"] ?? null,
    });
    const handler = handlers[body.method];
    if (!handler) {
      return new Response(
        JSON.stringify({ error: { code: 404, message: `no handler for ${body.method}` } }),
        { status: 400 },
      );
    }
    try {
      const result = handler(body.params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", result }), { status: 200 });
    } catch (err) {
      const rpc = (err as { rpc?: { code: number; message: string } }).rpc;
      if (rpc) {
        return new Response(JSON.stringify({ error: rpc }), { status: 400 });
      }
      throw err;
    }
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const AUTH_OK: RpcHandler = () => ({ access_token: "tok-1", expires_in: 900 });

function transportWith(
  handlers: Record<string, RpcHandler>,
  overrides: Partial<ConstructorParameters<typeof DeribitOrderTransport>[0]> = {},
) {
  const venue = fakeVenue({ "public/auth": AUTH_OK, "public/get_instrument": () => INSTRUMENT, ...handlers });
  const transport = new DeribitOrderTransport({
    clientId: "cid",
    clientSecret: "sec",
    env: "test",
    fetchImpl: venue.fetchImpl,
    logger: () => {},
    ...overrides,
  });
  return { transport, venue };
}

function buyResult(orderState: string, trades: { amount: number; price: number; trade_seq?: number }[]) {
  return { order: { order_state: orderState, order_id: "venue-1" }, trades };
}

// ── Construction / config ────────────────────────────────────────────────────

describe("DeribitOrderTransport — fail-closed construction & config", () => {
  it("refuses to construct without credentials", () => {
    expect(
      () => new DeribitOrderTransport({ clientId: "", clientSecret: "", env: "test" }),
    ).toThrow(DeribitOrderError);
  });

  it("defaults to the TEST venue env (live requires the explicit value)", () => {
    const { transport } = transportWith({});
    expect(transport.env).toBe("test");
  });

  it("readDeribitEnvConfig fails closed on missing credentials", () => {
    const r = readDeribitEnvConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["DERIBIT_CLIENT_ID", "DERIBIT_CLIENT_SECRET"]);
  });

  it("readDeribitEnvConfig rejects a bad DERIBIT_ENV and bad instrument map JSON", () => {
    const bad = readDeribitEnvConfig({
      DERIBIT_CLIENT_ID: "a",
      DERIBIT_CLIENT_SECRET: "b",
      DERIBIT_ENV: "prod",
      DERIBIT_INSTRUMENT_MAP: "{oops",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.missing.join(" ")).toMatch(/DERIBIT_ENV/);
      expect(bad.missing.join(" ")).toMatch(/DERIBIT_INSTRUMENT_MAP/);
    }
  });

  it("readDeribitEnvConfig parses a valid config (env defaults to test)", () => {
    const r = readDeribitEnvConfig({ DERIBIT_CLIENT_ID: "a", DERIBIT_CLIENT_SECRET: "b" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.env).toBe("test");
      expect(r.config.instrumentMap).toBeUndefined();
    }
  });
});

// ── Symbol / instrument validation ───────────────────────────────────────────

describe("DeribitOrderTransport — instrument gate (fail-closed)", () => {
  it("refuses an unmapped canonical symbol before any network call", async () => {
    const { transport, venue } = transportWith({});
    await expect(transport.place(order({ symbol: "XRP-PERP" }))).rejects.toThrow(/no Deribit instrument/);
    expect(venue.calls).toHaveLength(0);
  });

  it("maps the platform perp canonicals to LINEAR USDC perpetuals by default", () => {
    expect(DEFAULT_DERIBIT_INSTRUMENT_MAP["BTC-PERP"]).toBe("BTC_USDC-PERPETUAL");
    expect(DEFAULT_DERIBIT_INSTRUMENT_MAP["ETH-PERP"]).toBe("ETH_USDC-PERPETUAL");
  });

  it("refuses an INVERSE instrument (settlement != quote) — amount unit mismatch", async () => {
    const { transport } = transportWith({
      "public/get_instrument": () => ({
        ...INSTRUMENT,
        instrument_name: "BTC-PERPETUAL",
        quote_currency: "USD",
        settlement_currency: "BTC",
      }),
    });
    await expect(transport.place(order())).rejects.toThrow(/not a linear contract/);
  });

  it("refuses an inactive instrument", async () => {
    const { transport } = transportWith({
      "public/get_instrument": () => ({ ...INSTRUMENT, is_active: false }),
    });
    await expect(transport.place(order())).rejects.toThrow(/not active/);
  });

  it("refuses malformed instrument metadata", async () => {
    const { transport } = transportWith({
      "public/get_instrument": () => ({ ...INSTRUMENT, contract_size: 0 }),
    });
    await expect(transport.place(order())).rejects.toThrow(/malformed venue metadata/);
  });
});

// ── Sizing (round-down, never up; sub-minimum refused) ──────────────────────

describe("DeribitOrderTransport — venue sizing", () => {
  it("rounds the amount DOWN to the lot step and routes it", async () => {
    const { transport, venue } = transportWith({
      "private/buy": (p) => buyResult("filled", [{ amount: p["amount"] as number, price: 62_000 }]),
    });
    await transport.place(order({ qty: "0.00390000" })); // step 0.001 → 0.003
    const buy = venue.calls.find((c) => c.method === "private/buy");
    expect(buy?.params["amount"]).toBe(0.003);
    expect(buy?.params["type"]).toBe("market");
    expect(buy?.params["time_in_force"]).toBe("immediate_or_cancel");
    expect(buy?.params["label"]).toBe("nx-ord-live-1");
    expect(buy?.auth).toBe("Bearer tok-1");
  });

  it("refuses a quantity that rounds below the venue minimum (no network order)", async () => {
    const { transport, venue } = transportWith({});
    await expect(transport.place(order({ qty: "0.00040000" }))).rejects.toThrow(/below venue minimum/);
    expect(venue.calls.some((c) => c.method === "private/buy")).toBe(false);
  });

  it("SELL routes via private/sell", async () => {
    const { transport, venue } = transportWith({
      "private/sell": (p) => buyResult("filled", [{ amount: p["amount"] as number, price: 61_900 }]),
    });
    await transport.place(order({ side: "SELL", qty: "0.00300000" }));
    expect(venue.calls.some((c) => c.method === "private/sell")).toBe(true);
  });
});

// ── Outcome mapping (streams must satisfy reduceOrder) ───────────────────────

describe("DeribitOrderTransport — canonical stream mapping", () => {
  it("a complete venue fill maps to ...ACCEPTED→ORDER_FILLED and passes reduceOrder", async () => {
    const { transport } = transportWith({
      "private/buy": () => buyResult("filled", [{ amount: 0.003, price: 62_010.5 }]),
    });
    const o = order();
    const events = await transport.place(o);
    expect(events.map((e) => e.kind)).toEqual([
      "ORDER_REQUESTED",
      "ORDER_SUBMITTED",
      "ORDER_ACCEPTED",
      "ORDER_FILLED",
    ]);
    const snapshot = reduceOrder(o, events);
    expect(snapshot.state).toBe("FILLED");
    expect(snapshot.filledQty).toBe("0.00300000");
    expect(snapshot.fills[0]!.price).toBe("62010.50000000");
  });

  it("multiple venue trades map to PARTIALLY_FILLED* + final ORDER_FILLED (sorted by trade_seq)", async () => {
    const { transport } = transportWith({
      "private/buy": () =>
        buyResult("filled", [
          { amount: 0.001, price: 62_020, trade_seq: 2 },
          { amount: 0.002, price: 62_010, trade_seq: 1 },
        ]),
    });
    const o = order();
    const events = await transport.place(o);
    expect(events.map((e) => e.kind)).toEqual([
      "ORDER_REQUESTED",
      "ORDER_SUBMITTED",
      "ORDER_ACCEPTED",
      "ORDER_PARTIALLY_FILLED",
      "ORDER_FILLED",
    ]);
    const snapshot = reduceOrder(o, events);
    // trade_seq ordering honored: the 0.002 fill (seq 1) lands first.
    expect(snapshot.fills[0]!.qty).toBe("0.00200000");
    expect(snapshot.state).toBe("FILLED");
  });

  it("a lot-rounded shortfall terminates with an HONEST ORDER_CANCELLED (never fabricated FILLED)", async () => {
    const { transport } = transportWith({
      "private/buy": (p) => buyResult("filled", [{ amount: p["amount"] as number, price: 62_000 }]),
    });
    const o = order({ qty: "0.00390000" }); // routes 0.003; 0.0009 unfillable
    const events = await transport.place(o);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "ORDER_REQUESTED",
      "ORDER_SUBMITTED",
      "ORDER_ACCEPTED",
      "ORDER_PARTIALLY_FILLED",
      "ORDER_CANCELLED",
    ]);
    const snapshot = reduceOrder(o, events);
    expect(snapshot.state).toBe("CANCELLED");
    expect(snapshot.filledQty).toBe("0.00300000"); // the REAL executed quantity
  });

  it("an IOC that fills nothing maps to ORDER_CANCELLED with no fills", async () => {
    const { transport } = transportWith({
      "private/buy": () => buyResult("cancelled", []),
    });
    const o = order();
    const events = await transport.place(o);
    const snapshot = reduceOrder(o, events);
    expect(snapshot.state).toBe("CANCELLED");
    expect(snapshot.fills).toHaveLength(0);
  });

  it("a venue reject maps to ORDER_REJECTED", async () => {
    const { transport } = transportWith({
      "private/buy": () => buyResult("rejected", []),
    });
    const o = order();
    const snapshot = reduceOrder(o, await transport.place(o));
    expect(snapshot.state).toBe("REJECTED");
  });

  it("an unexpected `open` state is cancelled at the venue, then reported CANCELLED", async () => {
    const { transport, venue } = transportWith({
      "private/buy": () => buyResult("open", [{ amount: 0.001, price: 62_000 }]),
      "private/cancel": () => ({}),
    });
    const o = order();
    const events = await transport.place(o);
    expect(venue.calls.some((c) => c.method === "private/cancel")).toBe(true);
    const snapshot = reduceOrder(o, events);
    expect(snapshot.state).toBe("CANCELLED");
    expect(snapshot.filledQty).toBe("0.00100000");
  });

  it("THROWS on a venue overfill instead of admitting it (manual reconciliation)", async () => {
    const { transport } = transportWith({
      "private/buy": () => buyResult("filled", [{ amount: 0.004, price: 62_000 }]),
    });
    await expect(transport.place(order())).rejects.toThrow(/overfill/);
  });

  it("THROWS on a malformed venue fill (fail-closed, nothing admitted)", async () => {
    const { transport } = transportWith({
      "private/buy": () => buyResult("filled", [{ amount: Number.NaN, price: 62_000 }]),
    });
    await expect(transport.place(order())).rejects.toThrow(/malformed venue fill/);
  });

  it("THROWS on a definitive venue RPC error (stage converts to REJECTED)", async () => {
    const { transport } = transportWith({
      "private/buy": () => {
        throw { rpc: { code: 10_009, message: "not_enough_funds" } };
      },
    });
    await expect(transport.place(order())).rejects.toThrow(/not_enough_funds/);
  });
});

// ── Auth lifecycle ───────────────────────────────────────────────────────────

describe("DeribitOrderTransport — auth lifecycle", () => {
  it("caches the access token across placements (one auth for two orders)", async () => {
    const { transport, venue } = transportWith({
      "private/buy": () => buyResult("filled", [{ amount: 0.003, price: 62_000 }]),
    });
    await transport.place(order());
    await transport.place(order({ orderId: "ord-live-2" }));
    expect(venue.calls.filter((c) => c.method === "public/auth")).toHaveLength(1);
  });

  it("re-authenticates ONCE on an invalid/expired-token error and retries", async () => {
    let buys = 0;
    const { transport, venue } = transportWith({
      "private/buy": () => {
        buys += 1;
        if (buys === 1) throw { rpc: { code: 13_009, message: "invalid_token" } };
        return buyResult("filled", [{ amount: 0.003, price: 62_000 }]);
      },
    });
    const snapshot = reduceOrder(order(), await transport.place(order()));
    expect(snapshot.state).toBe("FILLED");
    expect(venue.calls.filter((c) => c.method === "public/auth")).toHaveLength(2);
  });
});

// ── Ambiguous-failure recovery (label lookup) ────────────────────────────────

describe("DeribitOrderTransport — ambiguous transport failure recovery", () => {
  it("recovers the TRUE venue outcome via the deterministic order label", async () => {
    const { transport } = transportWith({
      "private/buy": () => {
        throw new Error("socket hang up"); // network fault AFTER the venue executed
      },
      "private/get_order_state_by_label": (p) => {
        expect(p["label"]).toBe("nx-ord-live-1");
        expect(p["currency"]).toBe("USDC");
        return [{ order_state: "filled", order_id: "venue-9" }];
      },
      "private/get_user_trades_by_order": () => [{ amount: 0.003, price: 62_001 }],
    });
    const o = order();
    const snapshot = reduceOrder(o, await transport.place(o));
    expect(snapshot.state).toBe("FILLED");
    expect(snapshot.fills[0]!.price).toBe("62001.00000000");
  });

  it("rethrows when the venue has NO order under the label (nothing executed)", async () => {
    const { transport } = transportWith({
      "private/buy": () => {
        throw new Error("timeout");
      },
      "private/get_order_state_by_label": () => [],
    });
    await expect(transport.place(order())).rejects.toThrow(/timeout/);
  });

  it("rethrows (CRITICAL, manual reconciliation) when recovery itself fails", async () => {
    const logged: string[] = [];
    const { transport } = transportWith(
      {
        "private/buy": () => {
          throw new Error("timeout");
        },
        "private/get_order_state_by_label": () => {
          throw new Error("recovery down too");
        },
      },
      { logger: (_lvl, msg) => logged.push(msg) },
    );
    await expect(transport.place(order())).rejects.toThrow(/timeout/);
    expect(logged.join(" ")).toMatch(/manual reconciliation/);
  });
});
