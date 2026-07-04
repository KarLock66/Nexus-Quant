/**
 * Pure deterministic math for the Demo connector.
 *
 * Everything in this module is a pure function (no Date.now, no I/O, no
 * module-level mutable state) so the synthetic series is a reproducible
 * function of its numeric inputs. JS doubles are used internally; callers
 * format to decimal strings at the module border (decimal discipline).
 */

// ── PRNG ────────────────────────────────────────────────────────────────────

/**
 * mulberry32 — fast 32-bit seeded PRNG.
 * Returns a generator of uniform doubles in [0, 1). Identical seeds yield
 * identical sequences on every platform (only 32-bit int ops + one divide).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32-bit string hash — used to derive an independent per-bar /
 * per-point PRNG seed from (seed, symbol, timeframe, index) so any window
 * of a series can be generated without replaying a global stream.
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ── Distributions ───────────────────────────────────────────────────────────

/**
 * Box-Muller transform: one standard-normal draw from two uniforms.
 * Consumes exactly two values from `rand`. Uses 1 - u so the log argument
 * is in (0, 1] (never log(0)).
 */
export function boxMuller(rand: () => number): number {
  const u1 = 1 - rand();
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Standard normal probability density. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Error function, Abramowitz & Stegun 7.1.26 (|error| <= 1.5e-7).
 * Antisymmetric by construction (erf(-x) === -erf(x)), which makes
 * N(x) + N(-x) === 1 exactly — put-call parity then holds to FP precision.
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF via erf. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ── Black-Scholes (r = 0) ───────────────────────────────────────────────────

export interface BlackScholesInput {
  /** Spot price S > 0. */
  spot: number;
  /** Strike K > 0. */
  strike: number;
  /** Time to expiry in years (ACT/365). */
  timeToExpiryYears: number;
  /** Implied volatility as a decimal (0.55 = 55%). */
  vol: number;
  optionType: "CALL" | "PUT";
}

export interface BlackScholesResult {
  /** Option mark price in quote currency. */
  price: number;
  /** dPrice/dSpot — call in (0, 1), put in (-1, 0). */
  delta: number;
  /** d2Price/dSpot2 — same for calls and puts. */
  gamma: number;
  /** Time decay per calendar DAY (annual theta / 365). Negative for longs. */
  thetaPerDay: number;
  /** Sensitivity per 1 volatility POINT (i.e. per 0.01 change in vol). */
  vegaPerVolPt: number;
}

/**
 * Black-Scholes price + greeks with zero rate / zero carry (r = 0, q = 0):
 *   d1 = (ln(S/K) + sigma^2 T / 2) / (sigma sqrt(T)),  d2 = d1 - sigma sqrt(T)
 *   call = S N(d1) - K N(d2)        put = K N(-d2) - S N(-d1)
 * Degenerate inputs (T <= 0 or vol <= 0) fall back to intrinsic value with
 * step deltas and zero gamma/theta/vega.
 */
export function blackScholes(input: BlackScholesInput): BlackScholesResult {
  const { spot, strike, timeToExpiryYears: t, vol, optionType } = input;
  if (!(spot > 0) || !(strike > 0)) {
    throw new Error(
      `blackScholes: spot and strike must be > 0 (spot=${spot}, strike=${strike})`,
    );
  }
  const isCall = optionType === "CALL";

  if (t <= 0 || vol <= 0) {
    const intrinsic = isCall
      ? Math.max(0, spot - strike)
      : Math.max(0, strike - spot);
    const delta = isCall ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0;
    return { price: intrinsic, delta, gamma: 0, thetaPerDay: 0, vegaPerVolPt: 0 };
  }

  const sqrtT = Math.sqrt(t);
  const sigSqrtT = vol * sqrtT;
  const d1 = (Math.log(spot / strike) + 0.5 * vol * vol * t) / sigSqrtT;
  const d2 = d1 - sigSqrtT;
  const pdfD1 = normPdf(d1);

  const price = isCall
    ? spot * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - spot * normCdf(-d1);
  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdfD1 / (spot * sigSqrtT);
  // r = 0 ⇒ the only theta term is the vol-decay term (same for call & put).
  const thetaAnnual = -(spot * pdfD1 * vol) / (2 * sqrtT);
  const thetaPerDay = thetaAnnual / 365;
  const vegaPerVolPt = (spot * pdfD1 * sqrtT) / 100;

  return { price, delta, gamma, thetaPerDay, vegaPerVolPt };
}
