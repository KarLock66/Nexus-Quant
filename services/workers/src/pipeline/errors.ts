/**
 * Pipeline fail-fast error type (extracted from orchestrator.ts in Phase 11C so
 * the validation layer can throw it without a circular import).
 */

/** Missing or malformed upstream data — the tick refuses to run rather than fabricate input. */
export class PipelineDataError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PipelineDataError";
    this.code = code;
  }
}
