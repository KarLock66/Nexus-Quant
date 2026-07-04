# ADR-0001 — featureHash cross-build reproducibility

- **Status:** Proposed — awaiting approval (no implementation yet)
- **Date:** 2026-06-15
- **Branch:** `remediation/step8-featurehash-reproducibility`
- **Driver:** Step 8 adversarial review, CRITICAL finding #7
- **Decision owners:** human approver (KarLock66)
- **Supersedes / relates:** Runtime Truth Contract (MIR-1/2/3); reproducibility quintuple (`docs/architecture/00-overview.md` principle 3)

## Context

`featureHash` is the platform-wide reproducibility/lineage anchor. It is denormalized onto
`FeatureSnapshot`, `Signal`, and `AIAnalysis`, and emitted on `FEATURE_SNAPSHOT_CREATED`. The
governance contracts (MIR-1/2/3) and the audit guarantee — *"prove this signal was derived from
exactly these feature values"* — all rest on it being stable and value-attesting.

Today `compute_feature_hash` (`services/quant/app/features/core_technical.py:125-129`) computes:

```python
sha256(json.dumps(features, sort_keys=True, separators=(",",":"), allow_nan=False))
```

over a `dict[str, float]` whose values come from numpy reductions and libm transcendentals
(`np.log`, `np.std`, `np.mean`). `json.dumps` uses shortest-round-trip `repr`, so **a 1-ULP change
in any value flips the digest**.

## Problem (root cause)

IEEE-754 mandates correct rounding for `+ - * / sqrt` but **not** for transcendentals (`np.log`)
or for the *order* of reductions (numpy uses pairwise/SIMD summation whose tree shape varies with
array length, SIMD width, numpy version, and CPU microarchitecture). Therefore the same admitted
candle batch can produce feature values that differ by ULPs across:

- a numpy/scipy version bump (`pyproject.toml` pins floors only: `numpy>=2.1`, `scipy>=1.14`),
- a different Docker base image / libm (glibc vs musl, version drift),
- a different host CPU microarchitecture (SSE vs AVX2 vs AVX-512 `log` kernels),
- a dev laptop vs the prod container.

Any such ULP delta flips `featureHash`, which (a) breaks the lineage guarantee and (b) produces
phantom "feature changed" churn. This is verified CRITICAL.

### Empirical evidence (read-only probe, this branch)

| Probe | Result |
|---|---|
| `np.std(x)` vs `np.std(x[::-1])` | bit-differ by `1.7e-18` (order-sensitive) |
| `np.sum(np.log(x))` vs reversed | bit-differ by `2.8e-17` |
| `math.fsum` forward vs reversed | **identical** (order-independent, correctly-rounded) |
| Quantize std fwd/rev to 12 sig-figs | **collapse to the same string** `9.09287338417e-03` |
| 1-ULP boundary flips @ 12 sig-figs | `11 / 200,000` (~5.5e-5 / value) |
| 1-ULP boundary flips @ 10 sig-figs | `0 / 200,000` |
| `-0.0` normalization (`v + 0.0`) | works |

Takeaways: (1) `fsum` removes accumulation-order noise for sums/means; (2) quantization collapses
the residual but **cannot reach zero** — boundary flips persist and shrink with coarser precision;
(3) the irreducible core is `np.log` (faithfully- not correctly-rounded), which only a vendored
correctly-rounded log could fully tame.

## Options considered

### A — Deterministic computation at source
Replace numpy reductions with `math.fsum`/scalar loops; hash near-full precision. **MIR-compliant**,
but reproducibility is **weak**: pins no toolchain (an FMA/`-ffast-math` build breaks even the
9 "exact" features), and for `realized_vol_30` it hashes `np.log` at full precision — *maximally*
sensitive to the one residual wobble. The only real fix (vendoring a crlibm/RLIBM correctly-rounded
log) is an exotic, hard-to-audit, slow dependency guarding the platform anchor for a single feature.

### B — Hash the recipe, not the result
`featureHash = sha256(datasetHash + featureSet + version + specVersion)`. **Eliminates** hash
divergence (no float ever serialized) but **VIOLATES MIR-2**: the hash no longer attests to the
values, so two machines emitting *different* vectors collide silently (worse than A's noisy
mismatch). Restoring vector integrity needs a companion `vectorHash` that *reintroduces* the exact
quantization problem — i.e. you need C anyway — plus a schema column, doc redefinition, a load-bearing
`FEATURE_SPEC_VERSION` (omit-and-collide footgun), and a rewrite of both e2e harnesses. `datasetHash`
also covers the whole batch, not the per-feature windows (`-31/-100/-20`), so window changes are
invisible except via the fragile `specVersion`.

### C — Quantize output + pin toolchain + in-image golden test (RECOMMENDED)
Canonicalize every feature to a fixed significant-figure precision **once** at vector assembly, hash
**and return/persist the same canonical dict**; harden reductions with `math.fsum`; pin the numeric
substrate (`==` versions, digest-pinned image, BLAS `threads=1`, constrained SIMD dispatch); add a
golden-hash CI test run **inside the pinned image across a CPU-microarch matrix**.

## Decision

**Adopt Approach C**, with `math.fsum`-based reductions borrowed from A as defense-in-depth.

Rationale: C is the only design that satisfies **all three MIR invariants** *and* attacks the root
cause, with a verification mechanism that converts an invisible production-only lineage hazard into a
deterministic CI failure. It preserves the non-negotiable property
`featureHash == sha256(canonical(persisted vector))` (schema `FeatureSnapshot.featureHash`,
e2e `py_trace.py` `fh_live == fh_direct`). B fails that by definition; A's guarantee is the weakest
in practice and carries a disproportionate vendored-log liability.

### Canonical precision policy

Canonicalize every finite feature value exactly once, at vector assembly, **before** hashing and
returning:

```python
def _canon(x: float) -> float:
    q = float(f"{x:.9e}")   # 10 significant figures, normalized scientific
    return 0.0 if q == 0.0 else q   # normalize -0.0 -> 0.0
```

- **Significant figures, not fixed decimals** — the vector spans ~8 decades (`realized_vol_30 ~1e-3`,
  `volume_zscore_100 ~O(1)`, `rsi_14 ∈ [0,100]`, `ema_200`/`donchian ~1e4-1e5`). A fixed-decimal grid
  is scale-blind; sig-figs give a uniform *relative* grid.
- **Scientific (`e`) format** — single canonical textual form per value (no `100.0` vs `1e2`).
- **`-0.0` normalization is mandatory** — `volume_zscore` numerator / flat-series subtraction can
  yield `-0.0`; `json.dumps` emits `"-0.0"` (distinct bytes), flipping the hash on sign noise alone.
  The `isfinite` guard does not catch this (`-0.0` is finite).

**Precision constant — DECIDED (approver, 2026-06-15): 10 significant figures (`:.9e`).**

| `P` (format) | Sig-figs | 1-ULP boundary-flip rate (probe) | Signal fidelity | Status |
|---|---|---|---|---|
| **`:.9e`** | **10** | **0 / 200k** | lossless-in-practice | **SELECTED** |
| `:.11e` | 12 | ~5.5e-5 / value (`11/200k`) | maximal | rejected (narrower margin) |

Rationale: the project's priority order places *reproducibility above profitability*; 10 sig-figs
loses no economically meaningful resolution for indicators built on 8-decimal OHLCV, yet drove 1-ULP
boundary flips to zero in 200k trials and gives a ~3-decade wider margin for the (discouraged)
heterogeneous-microarch case. **This constant is now part of `core-technical` v1's immutable
identity — changing it later is a new feature-set version, never an edit.**

### Reduction hardening
Replace `np.mean` seeds (`_ema`, `_rsi_wilder`, `_atr_wilder`) and `np.std` (`realized_vol_30`,
`volume_zscore_100`) variances with `math.fsum`-based equivalents (correctly-rounded, order-invariant).
`np.max`/`np.min` (donchian) select existing elements and stay. This pushes residual noise below the
quantization grid wherever physically possible; `np.log` remains the irreducible term.

### Toolchain pinning (prerequisite — currently absent)
- `pyproject.toml`: floors → exact `==` pins; add a hash-locked lockfile/constraints. **Resolve the
  pins inside the Docker 3.12 image, not the local 3.14 venv** (local: numpy 2.4.6 / scipy 1.17.1).
- Dockerfile: pin base image by **digest** (`python:3.12-slim` is a moving tag).
- Image env: BLAS `threads=1`; constrain SIMD dispatch (`NPY_DISABLE_CPU_FEATURES` / `OPENBLAS_CORETYPE`).
- Deploy constraint: certify a single canonical microarch class, or run the golden test on a CPU matrix.

### Test strategy
- Replace the same-process determinism test (necessary but blind to cross-build drift) with a
  **golden-hash regression test**: a committed frozen input fixture + the expected `featureHash` and
  expected canonical vector as literals; assert equality **and** `sha256(canonical(returned vector)) ==
  returned featureHash` (re-asserts MIR-2 in-process).
- Run it in the **pinned image across a microarch matrix**; a flip on any leg is a hard CI failure.
- Add a targeted `realized_vol_30` cross-arch `np.log` bit-comparison to keep the irreducible hazard
  visible, and a "policy-lock" test asserting the precision constant is unchanged.
- `test_constant_series` exact values (100.0, 50.0, 20.0, 0.0, 110.0, 90.0) are exactly representable
  and survive canonicalization unchanged.

## Consequences

**Positive:** root-cause fix; MIR-1/2/3 preserved by construction; reproducibility hazard becomes a
CI tripwire; API/schema shape unchanged (same keys, `featureHash` still 64-hex); near-zero migration
cost now.

**Negative / residual:** does **not** eliminate the cross-microarch boundary tail for `realized_vol_30`
(`np.log`) — reduced to a golden-test-detectable tail, not zero; much of the guarantee lives in
build/deploy discipline (pins, digest, BLAS/SIMD env), so partial application silently degrades it;
the precision constant is a permanent, irreversible v1 contract decision.

## Migration impact

**Near-zero now, by design of the Phase-1 window.** No `FeatureSnapshot`/`Signal`/`AIAnalysis` rows
exist (DB not migrated, no live feature consumer), so re-minting every `featureHash` invalidates no
persisted data and no event consumers. The wire contract is unchanged, so TS/`stage-b-client` and the
e2e harnesses keep working. The only mechanical change: regenerate golden/exact-value test
expectations **once, inside the pinned image**. **This must be locked before any `FeatureSnapshot` is
written** — after Phase 1 it becomes a breaking lineage event requiring a new feature-set version.

## MIR compliance

- **MIR-1 (mint once):** `_canon` applied at exactly one site (fold into `compute_feature_hash`; hash-and-return the same dict).
- **MIR-2 (hash == sha256(persisted vector)):** preserved — the canonical dict is hashed, returned, and persisted; never raw-persist-while-hashing-quantized.
- **MIR-3 (one hash, one author):** unchanged — Python sole author; TS holds an opaque string and never recomputes.

## Follow-ups (separate, lower-priority Step-8 findings — not this ADR)
HIGH: OI ts idempotency; Stage-B-unavailable vs data-failure distinction + health events.
MEDIUM cluster: DQReport idempotency key; datasetHash recomputable-from-DB; candle admission linkage;
documented gap-admission boundary; dead `cross_exchange_divergence` path.
