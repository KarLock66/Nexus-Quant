"""Constants mirrored from the TypeScript decision layer.

MIN_DATA_QUALITY_SCORE mirrors `@nexus/core` (packages/core/src/constants.ts).
The TypeScript layer OWNS the DQ admission decision; the copy here exists only
so the quant service can refuse obviously inadmissible feature-compute calls
as defense-in-depth. If the values ever diverge, the TS value is canonical.
"""

MIN_DATA_QUALITY_SCORE = 90
