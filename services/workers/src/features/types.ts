/**
 * Feature Store consumer contract (STEP 10).
 *
 * The worker is the production consumer of the Python `POST /features/compute`
 * endpoint. It owns DQ >= 90 admission and FeatureSnapshot persistence; the
 * quant service owns the feature math and the canonical `featureHash`.
 *
 * Hash discipline (platform invariant): `featureHash` is computed ONLY in
 * Python. The worker treats it as an OPAQUE STRING — it is never recomputed,
 * normalized, or reserialized. The `features` vector is likewise persisted
 * verbatim (same keys, same casing, same values) exactly as the service
 * returned it.
 */

import type { Exchange, Timeframe } from "@nexus/core";

/** Request the worker submits to POST /features/compute (snake_case wire form). */
export interface FeatureComputeInput {
  dqReportId: string;
  dqScore: number;
  scope: {
    exchange: Exchange;
    symbol: string;
    timeframe: Timeframe;
    /** Optional point-in-time guard; when set, must equal the last candle ts. */
    ts?: Date;
  };
  featureSet: string;
  version: number;
  marketData: {
    candles: Array<{
      ts: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>;
  };
}

/**
 * Decoded response of POST /features/compute. `features` and `featureHash` are
 * carried verbatim — see the hash-discipline note above. `raw` is the exact
 * response body bytes, retained so callers can prove byte-identical handling.
 */
export interface FeatureComputeResult {
  featureSet: string;
  version: number;
  asOfTs: string;
  /** OPAQUE — copied from the service, never recomputed in TS. */
  featureHash: string;
  /** Persisted verbatim (key order / casing / values untouched). */
  features: Record<string, number>;
  inputCandleCount: number;
  dqReportId: string | null;
  /** Exact response body bytes as received over the wire. */
  raw: string;
}

/** Identity + verdict returned after a FeatureSnapshot is persisted. */
export interface PersistedFeatureSnapshot {
  id: string;
  featureHash: string;
  featureSetId: string;
  asOfTs: Date;
}
