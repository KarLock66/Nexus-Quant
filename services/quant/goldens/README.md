# Golden reproducibility fixtures (ADR-0001)

- `inputs/core-technical-v1.json` — **static, committed input** (RNG-free, byte-stable). Safe to edit only via a reviewed change that re-runs the bootstrap.
- `core-technical-v1.golden.json` — **CI-generated baseline** (`tools/golden.py generate`, inside the digest-pinned container). **Never** commit a host-generated baseline; only the gated `bootstrap-reproducibility` workflow may produce it. A baseline commit without CI-bot provenance is a hard policy failure.

Until the bootstrap workflow commits the digest, `requirements.lock`, and this baseline, Phase 1 is **OPEN** and CI fails closed.
