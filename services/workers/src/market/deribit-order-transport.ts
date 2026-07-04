/**
 * Deribit private-API order transport — the LIVE venue edge behind
 * `createRealBroker(transport)` (Phase 6/7 seam, unchanged).
 *
 * Routes a deterministic `Order` to Deribit as a MARKET / immediate-or-cancel
 * order over the private JSON-RPC HTTP API and maps the venue's acknowledgement
 * + trades into the canonical `OrderEvent` stream — the SAME shape paper and
 * simulated brokers emit — so the stage's pure `reduceOrder` remains the single
 * fail-closed validator of every live stream (no separate trust path for "real").
 *
 * Venue mapping discipline (documented, not tunable):
 *  - Canonical symbols route to Deribit LINEAR (USDC-settled) perpetuals, where
 *    the venue `amount` is denominated in the BASE coin — the exact unit of
 *    `Order.qty`. Inverse (USD-amount) instruments are REFUSED at instrument
 *    validation (their amount unit would misstate base exposure; a favorable
 *    fill on an inverse contract could over-deliver base units past the ordered
 *    quantity, which the reducer correctly treats as a hard failure).
 *  - The requested amount is `Order.qty` rounded DOWN to the instrument's
 *    contract-size step (never up — a venue can never be asked for more than
 *    the risk-approved quantity). A quantity that rounds below the venue
 *    minimum is REFUSED before any network call.
 *  - Fills are mapped VERBATIM (venue amount → fillQty, venue price →
 *    fillPrice); nothing is fabricated. If the venue completes the order short
 *    of the FULL ordered quantity (lot rounding or thin-liquidity IOC), the
 *    stream terminates with an honest ORDER_CANCELLED carrying the shortfall in
 *    its reason — never a fabricated ORDER_FILLED.
 *  - time_in_force=immediate_or_cancel guarantees no resting venue order can
 *    survive this call: whatever did not fill immediately is cancelled by the
 *    venue itself.
 *
 * Fail-closed discipline:
 *  - Missing/invalid config, an unmapped symbol, a non-linear or inactive
 *    instrument, a sub-minimum quantity, a malformed venue payload, or a venue
 *    error all THROW (typed DeribitOrderError). The stage converts a broker
 *    throw into a REJECTED result and commits NOTHING.
 *  - An AMBIGUOUS transport failure (timeout / network fault after the request
 *    may have reached the venue) is recovered by a label lookup: every order
 *    carries a deterministic venue label derived from orderId, so the transport
 *    re-queries `get_order_state_by_label` (+ `get_user_trades_by_order`) and
 *    maps the true venue outcome. Only if that recovery ALSO fails does the
 *    transport throw — with a CRITICAL log demanding manual reconciliation.
 *
 * Determinism boundary: this module is the deliberate effectful edge (network,
 * venue clock). Everything upstream (order derivation) and downstream
 * (reduceOrder, position/account folds, reconciliation, journaling) is the
 * existing pure machinery; replay safety is preserved because journals record
 * the COMMITTED venue outcome verbatim.
 */

import { log as defaultLog } from "../lib/log.js";
import { parseDecimal, quantizePrice, quantizeQty } from "./money.js";
import type { Order, OrderEvent } from "./types.js";
import type { RealtimeOrderTransport } from "./broker.js";

// ── Errors ──────────────────────────────────────────────────────────────────

export class DeribitOrderError extends Error {
  readonly endpoint: string;
  readonly rpcCode: number | undefined;

  constructor(message: string, opts: { endpoint: string; rpcCode?: number }) {
    super(message);
    this.name = "DeribitOrderError";
    this.endpoint = opts.endpoint;
    this.rpcCode = opts.rpcCode;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

export type DeribitVenueEnv = "live" | "test";

export interface DeribitOrderTransportConfig {
  /** OAuth2 client credentials (Deribit API key with `trade` scope). */
  clientId: string;
  clientSecret: string;
  /** Venue environment. `test` = test.deribit.com (paper venue). DEFAULT: test. */
  env?: DeribitVenueEnv;
  /**
   * Canonical symbol → Deribit LINEAR instrument. Unmapped symbols FAIL CLOSED.
   * Defaults cover the platform's perp canonicals on USDC-settled linears.
   */
  instrumentMap?: Record<string, string>;
  /** Injected fetch (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
  /** Injected logger (defaults to the workers structured logger). */
  logger?: typeof defaultLog;
}

const BASE_URL: Record<DeribitVenueEnv, string> = {
  live: "https://www.deribit.com/api/v2",
  test: "https://test.deribit.com/api/v2",
};

/** Default canonical → Deribit linear (USDC) perpetual instrument map. */
export const DEFAULT_DERIBIT_INSTRUMENT_MAP: Readonly<Record<string, string>> = {
  "BTC-PERP": "BTC_USDC-PERPETUAL",
  "ETH-PERP": "ETH_USDC-PERPETUAL",
};

const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh the access token this long before its venue expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Deribit RPC code for an invalid/expired token. */
const RPC_UNAUTHORIZED = 13_009;
/** Numeric tolerance matching reduceOrder's fill-completeness comparison. */
const QTY_EPS = 1e-9;

// ── Venue payload shapes (validated at the border, never trusted) ───────────

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface VenueInstrument {
  instrumentName: string;
  /** Amount step, in BASE coin (linear contracts only). */
  contractSize: number;
  /** Minimum order amount, in BASE coin. */
  minTradeAmount: number;
  /** Settlement currency (== quote currency for linears; e.g. USDC). */
  settlementCurrency: string;
}

interface VenueTrade {
  amount: number;
  price: number;
  seq: number;
}

interface VenueOrderOutcome {
  orderState: string;
  venueOrderId: string;
  trades: VenueTrade[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function finitePositive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

// ── Transport ───────────────────────────────────────────────────────────────

export class DeribitOrderTransport implements RealtimeOrderTransport {
  readonly env: DeribitVenueEnv;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly instrumentMap: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: typeof defaultLog;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private rpcId = 0;
  private readonly instrumentCache = new Map<string, VenueInstrument>();

  constructor(config: DeribitOrderTransportConfig) {
    const clientId = (config.clientId ?? "").trim();
    const clientSecret = (config.clientSecret ?? "").trim();
    if (clientId === "" || clientSecret === "") {
      throw new DeribitOrderError(
        "Deribit credentials missing — refusing to construct a live order transport (fail-closed)",
        { endpoint: "config" },
      );
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.env = config.env ?? "test";
    this.baseUrl = BASE_URL[this.env];
    this.instrumentMap = { ...DEFAULT_DERIBIT_INSTRUMENT_MAP, ...(config.instrumentMap ?? {}) };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = config.logger ?? defaultLog;
  }

  // ── JSON-RPC plumbing ─────────────────────────────────────────────────────

  private async rpc(method: string, params: Record<string, unknown>, token?: string): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: (this.rpcId += 1), method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DeribitOrderError(
        `transport failure calling ${method}: ${err instanceof Error ? err.message : String(err)}`,
        { endpoint: method },
      );
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new DeribitOrderError(`non-JSON response (HTTP ${res.status}) from ${method}`, {
        endpoint: method,
      });
    }
    const envelope = asRecord(payload) as RpcEnvelope | null;
    if (envelope?.error !== undefined) {
      const { code, message } = envelope.error;
      throw new DeribitOrderError(`venue error ${code ?? "?"} on ${method}: ${message ?? "unknown"}`, {
        endpoint: method,
        ...(code !== undefined ? { rpcCode: code } : {}),
      });
    }
    if (!res.ok || envelope === null || !("result" in envelope)) {
      throw new DeribitOrderError(`malformed response (HTTP ${res.status}) from ${method}`, {
        endpoint: method,
      });
    }
    return envelope.result;
  }

  /** OAuth2 client-credentials token, cached with an early-refresh margin. */
  private async token(): Promise<string> {
    if (this.accessToken !== null && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken;
    }
    const result = asRecord(
      await this.rpc("public/auth", {
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    );
    const token = typeof result?.["access_token"] === "string" ? result["access_token"] : "";
    const expiresIn = finitePositive(result?.["expires_in"]);
    if (token === "" || expiresIn === null) {
      throw new DeribitOrderError("auth succeeded but returned no usable token (fail-closed)", {
        endpoint: "public/auth",
      });
    }
    this.accessToken = token;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;
    return token;
  }

  /** Private call with one automatic re-auth retry on an invalid/expired token. */
  private async privateRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.rpc(method, params, await this.token());
    } catch (err) {
      if (err instanceof DeribitOrderError && err.rpcCode === RPC_UNAUTHORIZED) {
        this.accessToken = null;
        return this.rpc(method, params, await this.token());
      }
      throw err;
    }
  }

  // ── Instrument resolution (validated + cached) ────────────────────────────

  private mapSymbol(symbol: string): string {
    const instrument = this.instrumentMap[symbol];
    if (instrument === undefined || instrument === "") {
      throw new DeribitOrderError(
        `no Deribit instrument mapped for canonical symbol ${symbol} — refusing to route (fail-closed)`,
        { endpoint: "instrument-map" },
      );
    }
    return instrument;
  }

  private async instrument(name: string): Promise<VenueInstrument> {
    const cached = this.instrumentCache.get(name);
    if (cached !== undefined) return cached;

    const raw = asRecord(await this.rpc("public/get_instrument", { instrument_name: name }));
    const contractSize = finitePositive(raw?.["contract_size"]);
    const minTradeAmount = finitePositive(raw?.["min_trade_amount"]);
    const quote = typeof raw?.["quote_currency"] === "string" ? raw["quote_currency"] : "";
    const settlement =
      typeof raw?.["settlement_currency"] === "string" ? raw["settlement_currency"] : "";
    const active = raw?.["is_active"] === true;

    if (contractSize === null || minTradeAmount === null || quote === "" || settlement === "") {
      throw new DeribitOrderError(`instrument ${name}: malformed venue metadata (fail-closed)`, {
        endpoint: "public/get_instrument",
      });
    }
    if (!active) {
      throw new DeribitOrderError(`instrument ${name} is not active on the venue (fail-closed)`, {
        endpoint: "public/get_instrument",
      });
    }
    // LINEAR guard: on Deribit linears (USDC-settled) settlement == quote and the
    // order `amount` is denominated in the BASE coin — the unit Order.qty carries.
    // Inverse contracts (settlement == base, quote == USD, amount in USD) would
    // misstate base exposure and can over-deliver past the ordered qty: REFUSED.
    if (settlement !== quote) {
      throw new DeribitOrderError(
        `instrument ${name} is not a linear contract (settlement ${settlement} != quote ${quote}); ` +
          `its amount unit would misstate base exposure — refusing to route (fail-closed)`,
        { endpoint: "public/get_instrument" },
      );
    }
    const resolved: VenueInstrument = {
      instrumentName: name,
      contractSize,
      minTradeAmount,
      settlementCurrency: settlement,
    };
    this.instrumentCache.set(name, resolved);
    return resolved;
  }

  // ── Venue outcome parsing ─────────────────────────────────────────────────

  private parseTrades(raw: unknown, endpoint: string): VenueTrade[] {
    if (!Array.isArray(raw)) return [];
    const trades: VenueTrade[] = raw.map((t, i) => {
      const rec = asRecord(t);
      const amount = finitePositive(rec?.["amount"]);
      const price = finitePositive(rec?.["price"]);
      if (amount === null || price === null) {
        throw new DeribitOrderError(
          `trade ${i}: malformed venue fill (amount=${String(rec?.["amount"])}, price=${String(rec?.["price"])}) — fail-closed`,
          { endpoint },
        );
      }
      const seqRaw = rec?.["trade_seq"];
      const seq = typeof seqRaw === "number" && Number.isFinite(seqRaw) ? seqRaw : i;
      return { amount, price, seq };
    });
    return trades.sort((a, b) => a.seq - b.seq);
  }

  private parseOrderOutcome(raw: unknown, endpoint: string): VenueOrderOutcome {
    const rec = asRecord(raw);
    const orderRec = asRecord(rec?.["order"]);
    const orderState =
      typeof orderRec?.["order_state"] === "string" ? orderRec["order_state"] : "";
    const venueOrderId = typeof orderRec?.["order_id"] === "string" ? orderRec["order_id"] : "";
    if (orderState === "" || venueOrderId === "") {
      throw new DeribitOrderError(`malformed venue order payload from ${endpoint} (fail-closed)`, {
        endpoint,
      });
    }
    return { orderState, venueOrderId, trades: this.parseTrades(rec?.["trades"], endpoint) };
  }

  // ── Event-stream construction (reduceOrder-compatible, honest) ────────────

  private buildEvents(order: Order, outcome: VenueOrderOutcome): OrderEvent[] {
    const base = (kind: OrderEvent["kind"], seq: number) => ({
      seq,
      orderId: order.orderId,
      intentId: order.intentId,
      symbol: order.symbol,
      side: order.side,
      brokerId: order.brokerId,
      lineage: order.lineage,
      kind,
    });

    const orderedQty = parseDecimal(order.qty);
    const events: OrderEvent[] = [
      base("ORDER_REQUESTED", 0) as OrderEvent,
      base("ORDER_SUBMITTED", 1) as OrderEvent,
    ];

    if (outcome.orderState === "rejected") {
      events.push({
        ...base("ORDER_REJECTED", 2),
        kind: "ORDER_REJECTED",
        reason: `venue rejected order ${outcome.venueOrderId}`,
      });
      return events;
    }

    events.push(base("ORDER_ACCEPTED", 2) as OrderEvent);

    let cum = 0;
    let seq = 3;
    for (let i = 0; i < outcome.trades.length; i += 1) {
      const t = outcome.trades[i]!;
      const next = cum + t.amount;
      if (next > orderedQty + QTY_EPS) {
        // A venue overfill would silently corrupt position state if admitted —
        // and the reducer would reject it anyway. Throw so the stage rejects and
        // the operator reconciles the venue account manually.
        throw new DeribitOrderError(
          `venue overfill on order ${order.orderId}: cumulative ${next} exceeds ordered ${order.qty} — manual reconciliation required`,
          { endpoint: "fills" },
        );
      }
      const complete = Math.abs(next - orderedQty) <= QTY_EPS;
      const isLast = i === outcome.trades.length - 1;
      events.push({
        ...base(complete && isLast ? "ORDER_FILLED" : "ORDER_PARTIALLY_FILLED", seq),
        kind: complete && isLast ? "ORDER_FILLED" : "ORDER_PARTIALLY_FILLED",
        fillQty: quantizeQty(t.amount),
        fillPrice: quantizePrice(t.price),
        cumQty: quantizeQty(next),
      } as OrderEvent);
      cum = next;
      seq += 1;
    }

    const complete = Math.abs(cum - orderedQty) <= QTY_EPS;
    if (!complete) {
      // Honest terminal: the venue is DONE with this order (IOC / lot rounding)
      // but the full ordered quantity did not execute. Never fabricate FILLED.
      events.push({
        ...base("ORDER_CANCELLED", seq),
        kind: "ORDER_CANCELLED",
        reason:
          `venue ${outcome.orderState}: executed ${quantizeQty(cum)} of ordered ${order.qty} ` +
          `(immediate-or-cancel remainder cancelled by venue; venue order ${outcome.venueOrderId})`,
      });
    }
    return events;
  }

  // ── Ambiguous-failure recovery (label lookup) ─────────────────────────────

  /** Deterministic venue label for an order — the recovery key. */
  static venueLabel(orderId: string): string {
    return `nx-${orderId}`;
  }

  private async recoverByLabel(
    order: Order,
    instrument: VenueInstrument,
  ): Promise<VenueOrderOutcome | null> {
    const result = await this.privateRpc("private/get_order_state_by_label", {
      currency: instrument.settlementCurrency,
      label: DeribitOrderTransport.venueLabel(order.orderId),
    });
    if (!Array.isArray(result) || result.length === 0) return null;
    const orderRec = asRecord(result[0]);
    const orderState = typeof orderRec?.["order_state"] === "string" ? orderRec["order_state"] : "";
    const venueOrderId = typeof orderRec?.["order_id"] === "string" ? orderRec["order_id"] : "";
    if (orderState === "" || venueOrderId === "") {
      throw new DeribitOrderError(
        "recovery lookup returned a malformed order payload (fail-closed)",
        { endpoint: "private/get_order_state_by_label" },
      );
    }
    const tradesRaw = await this.privateRpc("private/get_user_trades_by_order", {
      order_id: venueOrderId,
      sorting: "asc",
    });
    return {
      orderState,
      venueOrderId,
      trades: this.parseTrades(tradesRaw, "private/get_user_trades_by_order"),
    };
  }

  // ── RealtimeOrderTransport ────────────────────────────────────────────────

  async place(order: Order): Promise<OrderEvent[]> {
    const instrumentName = this.mapSymbol(order.symbol);
    const instrument = await this.instrument(instrumentName);

    // Round DOWN to the venue lot step; never ask the venue for more than the
    // risk-approved quantity. A sub-minimum result is refused pre-network.
    const qty = parseDecimal(order.qty);
    const step = instrument.contractSize;
    const lots = Math.floor((qty + QTY_EPS) / step);
    const amount = Number((lots * step).toFixed(10));
    if (!(amount > 0) || amount + QTY_EPS < instrument.minTradeAmount) {
      throw new DeribitOrderError(
        `order qty ${order.qty} rounds to ${amount} ${instrumentName} (step ${step}), below venue minimum ${instrument.minTradeAmount} — refusing to route (fail-closed)`,
        { endpoint: "sizing" },
      );
    }

    const method = order.side === "BUY" ? "private/buy" : "private/sell";
    let outcome: VenueOrderOutcome;
    try {
      const result = await this.privateRpc(method, {
        instrument_name: instrumentName,
        amount,
        type: "market",
        time_in_force: "immediate_or_cancel",
        label: DeribitOrderTransport.venueLabel(order.orderId),
      });
      outcome = this.parseOrderOutcome(result, method);
    } catch (err) {
      // A definitive venue error (an RPC error envelope) means the venue judged
      // and refused the request — nothing executed; rethrow (stage → REJECTED).
      if (err instanceof DeribitOrderError && err.rpcCode !== undefined) throw err;
      // AMBIGUOUS failure (timeout / network fault): the order may or may not
      // have reached the venue. Recover the true outcome via the deterministic
      // order label before giving up.
      this.log("warn", "Deribit order placement ambiguous — attempting label recovery", {
        component: "market.deribit",
        orderId: order.orderId,
        detail: err instanceof Error ? err.message : String(err),
      });
      let recovered: VenueOrderOutcome | null;
      try {
        recovered = await this.recoverByLabel(order, instrument);
      } catch (recoveryErr) {
        this.log("error", "Deribit order state UNKNOWN — manual reconciliation required", {
          component: "market.deribit",
          category: "VENUE",
          severity: "CRITICAL",
          orderId: order.orderId,
          venueLabel: DeribitOrderTransport.venueLabel(order.orderId),
          placementError: err instanceof Error ? err.message : String(err),
          recoveryError:
            recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        });
        throw err;
      }
      if (recovered === null) {
        // The venue has no order under our label: the request never landed.
        // Safe to fail closed — nothing executed.
        throw err;
      }
      this.log("info", "Deribit label recovery resolved the true venue outcome", {
        component: "market.deribit",
        orderId: order.orderId,
        orderState: recovered.orderState,
        trades: recovered.trades.length,
      });
      outcome = recovered;
    }

    // An `open` state cannot survive an IOC market order; if the venue ever
    // reports one, cancel it explicitly so no untracked resting order exists.
    if (outcome.orderState === "open") {
      await this.privateRpc("private/cancel", { order_id: outcome.venueOrderId });
      outcome = { ...outcome, orderState: "cancelled" };
    }

    return this.buildEvents(order, outcome);
  }
}

// ── Env wiring ───────────────────────────────────────────────────────────────

export interface DeribitEnvConfig {
  clientId: string;
  clientSecret: string;
  env: DeribitVenueEnv;
  instrumentMap: Record<string, string> | undefined;
}

/**
 * Read + validate the Deribit live-venue configuration from process env.
 * Returns null (with the missing keys) when the transport must NOT be built —
 * the caller leaves execution UNARMED (fail-closed).
 *
 *   DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET  — API key with `trade` scope
 *   DERIBIT_ENV=test|live                      — venue env (DEFAULT test; live
 *                                                trading requires the explicit
 *                                                value "live")
 *   DERIBIT_INSTRUMENT_MAP                     — optional JSON object overriding
 *                                                the canonical→instrument map
 */
export function readDeribitEnvConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: DeribitEnvConfig } | { ok: false; missing: string[] } {
  const clientId = (env["DERIBIT_CLIENT_ID"] ?? "").trim();
  const clientSecret = (env["DERIBIT_CLIENT_SECRET"] ?? "").trim();
  const missing: string[] = [];
  if (clientId === "") missing.push("DERIBIT_CLIENT_ID");
  if (clientSecret === "") missing.push("DERIBIT_CLIENT_SECRET");

  const rawEnv = (env["DERIBIT_ENV"] ?? "test").trim().toLowerCase();
  if (rawEnv !== "live" && rawEnv !== "test") missing.push("DERIBIT_ENV (must be live|test)");

  let instrumentMap: Record<string, string> | undefined;
  const rawMap = (env["DERIBIT_INSTRUMENT_MAP"] ?? "").trim();
  if (rawMap !== "") {
    try {
      const parsed: unknown = JSON.parse(rawMap);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        !Object.values(parsed).every((v) => typeof v === "string" && v !== "")
      ) {
        missing.push("DERIBIT_INSTRUMENT_MAP (must be a JSON object of non-empty strings)");
      } else {
        instrumentMap = parsed as Record<string, string>;
      }
    } catch {
      missing.push("DERIBIT_INSTRUMENT_MAP (invalid JSON)");
    }
  }

  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: { clientId, clientSecret, env: rawEnv as DeribitVenueEnv, instrumentMap },
  };
}
