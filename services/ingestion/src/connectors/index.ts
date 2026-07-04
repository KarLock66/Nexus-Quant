/**
 * Connector registry — resolves a canonical Exchange to its ExchangeConnector
 * implementation. The live daemon depends ONLY on this factory, so a new venue
 * is added without touching runtime code (Phase 9 requirement: "future
 * exchanges added without modifying runtime code").
 *
 * REAL VENUES ONLY: the registry serves live public-endpoint connectors. The
 * legacy synthetic "DEMO" venue is NOT resolvable here — the deterministic
 * fixture connector lives in src/ci/ (CI/test only) and is never reachable
 * from the production daemon (fail-closed).
 */

import type { Exchange } from "@nexus/core";
import type { ExchangeConnector } from "./types.js";
import { createDeribitConnector } from "./deribit.js";
import { createBinanceConnector } from "./binance.js";

export type { ExchangeConnector } from "./types.js";
export { createDeribitConnector } from "./deribit.js";
export { createBinanceConnector } from "./binance.js";

/**
 * Returns the connector for `exchange`. DERIBIT and BINANCE are real
 * public-endpoint venues. DEMO (legacy synthetic) and BYBIT (reserved, not yet
 * implemented) throw fail-closed rather than silently degrading.
 */
export function resolveConnector(exchange: Exchange): ExchangeConnector {
  switch (exchange) {
    case "DERIBIT":
      return createDeribitConnector();
    case "BINANCE":
      return createBinanceConnector();
    case "DEMO":
      throw new Error(
        "the synthetic DEMO venue has been removed from the runtime — configure a real venue (DERIBIT, BINANCE)",
      );
    case "BYBIT":
      throw new Error("BYBIT connector is not implemented yet (fail-closed)");
    default: {
      const never: never = exchange;
      throw new Error(`unknown exchange: ${String(never)}`);
    }
  }
}
