/**
 * Connector registry — resolves a canonical Exchange to its ExchangeConnector
 * implementation. The live daemon and seal harness depend ONLY on this factory,
 * so a new venue is added without touching runtime code (Phase 9 requirement:
 * "future exchanges added without modifying runtime code").
 */

import type { Exchange } from "@nexus/core";
import type { ExchangeConnector } from "./types.js";
import { createDemoConnector } from "./demo.js";
import { createDeribitConnector } from "./deribit.js";
import { createBinanceConnector } from "./binance.js";

export type { ExchangeConnector } from "./types.js";
export { createDemoConnector } from "./demo.js";
export { createDeribitConnector } from "./deribit.js";
export { createBinanceConnector } from "./binance.js";

export interface ResolveConnectorOptions {
  /** Seed for the Demo connector (ignored by live venues). */
  demoSeed?: number;
}

/**
 * Returns the connector for `exchange`. DEMO is deterministic/offline; DERIBIT
 * and BINANCE are real public-endpoint venues. BYBIT is reserved (not yet
 * implemented) and throws fail-closed rather than silently degrading.
 */
export function resolveConnector(
  exchange: Exchange,
  opts: ResolveConnectorOptions = {},
): ExchangeConnector {
  switch (exchange) {
    case "DEMO":
      return createDemoConnector(opts.demoSeed);
    case "DERIBIT":
      return createDeribitConnector();
    case "BINANCE":
      return createBinanceConnector();
    case "BYBIT":
      throw new Error("BYBIT connector is not implemented yet (fail-closed)");
    default: {
      const never: never = exchange;
      throw new Error(`unknown exchange: ${String(never)}`);
    }
  }
}
