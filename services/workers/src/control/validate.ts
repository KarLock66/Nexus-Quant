/**
 * Phase 11C Stage 3 (Batch 2) — control-plane store admission.
 *
 * The control tables cross a process boundary: their domains exist only as
 * comments in schema.prisma (`state` is a plain String, `affectedComponents` a
 * Json column), so any actor with DB access can put anything in them. This
 * module is the ONE place where those untrusted values become trusted
 * RuntimeState / ControlComponent[] domain values: structural rejection only —
 * a well-formed value is returned UNMODIFIED (no repair, no filtering, no
 * coercion), so admission can never transform a row, only refuse it. The
 * accept-domains are built from the canonical RUNTIME_STATES /
 * CONTROL_COMPONENTS tuples in @nexus/control — the tuples are the types'
 * single source, so these validators cannot drift from the type.
 */

import {
  CONTROL_COMPONENTS,
  RUNTIME_STATES,
  type ControlComponent,
  type RuntimeState,
} from "@nexus/control";

/** Which control row shape failed admission (stable machine code, per-table). */
export type ControlDataCode =
  | "MALFORMED_RUNTIME_STATE"
  | "MALFORMED_STATE_TRANSITION"
  | "MALFORMED_INCIDENT";

/** A control row that failed admission — every consumer handles it fail-closed. */
export class ControlDataError extends Error {
  readonly code: ControlDataCode;
  constructor(message: string, code: ControlDataCode) {
    super(message);
    this.name = "ControlDataError";
    this.code = code;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const RUNTIME_STATE_SET: ReadonlySet<string> = new Set(RUNTIME_STATES);
const CONTROL_COMPONENT_SET: ReadonlySet<string> = new Set(CONTROL_COMPONENTS);

/** Admit one persisted runtime-state string. THROWS ControlDataError when out of domain. */
export function assertValidRuntimeState(
  v: unknown,
  ctx: string,
  code: ControlDataCode,
): asserts v is RuntimeState {
  if (!isNonEmptyString(v) || !RUNTIME_STATE_SET.has(v)) {
    throw new ControlDataError(
      `${ctx}: "${String(v)}" is not a RuntimeState (${RUNTIME_STATES.join("|")}) — fail-closed, nothing repaired`,
      code,
    );
  }
}

/**
 * Admit a persisted affectedComponents Json value. null/undefined → [] (absence
 * stays legitimate — the pre-admission `?? []` contract, preserved verbatim);
 * otherwise the value must be an array whose EVERY element is a known component.
 * One bad element rejects the whole value — no silent filtering. A valid array
 * is returned as the same reference, unmodified.
 */
export function admitControlComponents(
  v: unknown,
  ctx: string,
  code: ControlDataCode,
): ControlComponent[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new ControlDataError(
      `${ctx}: not an array (got ${typeof v}) — fail-closed, nothing repaired`,
      code,
    );
  }
  for (const el of v) {
    if (!isNonEmptyString(el) || !CONTROL_COMPONENT_SET.has(el)) {
      throw new ControlDataError(
        `${ctx}: element "${String(el)}" is not a ControlComponent (${CONTROL_COMPONENTS.join("|")}) — fail-closed, nothing filtered`,
        code,
      );
    }
  }
  return v as ControlComponent[];
}
