/**
 * Distributed decision-bus admission (Phase 11C Stage 3).
 *
 * The Redis/BullMQ bridges deserialize bytes that ANY process with Redis access
 * can have produced. This module is the ONE place where that untrusted `unknown`
 * becomes a trusted `DecisionEvent`: structural rejection only — a well-formed
 * event is returned UNMODIFIED (no defaults, no normalization), so admission can
 * never transform an event, only refuse it. Enum domains and the quantized
 * confidence format are the pipeline validator's own (shared source, no drift);
 * the lineage <-> signal verbatim cross-checks mirror Stage 1's contextual check,
 * restated context-free for the process boundary.
 *
 * The in-process bus never uses this: same process, same typed object, no
 * serialization boundary. Only the decision channel is distributed in production,
 * so this is the only concrete admitter (the bridges take any `admit` codec).
 */

import { SIGNAL_DECISIONS } from "@nexus/core";
import type { DecisionAction, DecisionEvent } from "../execution/types.js";
import { CONFIDENCE_RE, malformedSignalStructureReason } from "../pipeline/validate.js";

/** A bus payload that failed admission — dropped (pub/sub) or dead-lettered (queue). */
export class BusAdmissionError extends Error {
  readonly code = "MALFORMED_BUS_EVENT";
  constructor(message: string) {
    super(message);
    this.name = "BusAdmissionError";
  }
}

/** JSON payload fields must be plain objects here — never arrays, scalars, or null. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function reject(detail: string): never {
  throw new BusAdmissionError(`decision bus event rejected: ${detail}`);
}

const DECISION_SET: ReadonlySet<string> = new Set(SIGNAL_DECISIONS);

// Flags object (compiler-enforced against DecisionAction — adding/removing an
// action breaks this build) -> runtime set, per the event-store enum convention.
const DECISION_ACTION_FLAGS: Record<DecisionAction, true> = {
  ENTER: true,
  HOLD: true,
  STAND_ASIDE: true,
};
const DECISION_ACTIONS: ReadonlySet<string> = new Set(Object.keys(DECISION_ACTION_FLAGS));

/** Lineage ids/hashes that must be non-empty AND carried verbatim from the signal. */
const LINEAGE_VERBATIM_FIELDS = [
  "strategyVersionId",
  "featureSnapshotId",
  "dqReportId",
  "datasetHash",
  "featureHash",
] as const;

/**
 * Admit one untrusted bus payload as a DecisionEvent. THROWS BusAdmissionError
 * on the first structural violation; returns the SAME value (unmodified, now
 * trusted) when every check passes. This is the only unknown -> DecisionEvent
 * conversion point in the distributed path.
 */
export function admitDecisionEvent(v: unknown): DecisionEvent {
  if (!isPlainObject(v)) reject("event is not a JSON object");

  // signal — the persisted-observation contract, context-free (Stage 1's shared check).
  const signal = v["signal"];
  if (!isPlainObject(signal)) reject("signal is not a JSON object");
  const signalReason = malformedSignalStructureReason(signal);
  if (signalReason !== null) reject(`signal ${signalReason}`);

  // decision — the action intent.
  const decision = v["decision"];
  if (!isPlainObject(decision)) reject("decision is not a JSON object");
  const action = decision["action"];
  if (typeof action !== "string" || !DECISION_ACTIONS.has(action)) {
    reject(`decision.action "${String(action)}" not in ${[...DECISION_ACTIONS].join("|")}`);
  }
  const decisionSide = decision["side"];
  if (typeof decisionSide !== "string" || !DECISION_SET.has(decisionSide)) {
    reject(`decision.side "${String(decisionSide)}" not in ${[...DECISION_SET].join("|")}`);
  }
  const decisionConfidence = decision["confidence"];
  if (typeof decisionConfidence !== "string" || !CONFIDENCE_RE.test(decisionConfidence)) {
    reject("decision.confidence is not the quantized 4-decimal string format");
  }
  const dc = Number(decisionConfidence);
  if (!(dc >= 0 && dc <= 1)) reject(`decision.confidence ${decisionConfidence} outside [0, 1]`);
  if (typeof decision["rationale"] !== "string") reject("decision.rationale is not a string");

  // execution — the inert hook: null, or a plan with a known status.
  const execution = v["execution"];
  if (execution !== null) {
    if (!isPlainObject(execution)) reject("execution is not null or a JSON object");
    const status = execution["status"];
    if (status !== "PENDING" && status !== "SKIPPED") {
      reject(`execution.status "${String(status)}" is not PENDING|SKIPPED`);
    }
    if (typeof execution["detail"] !== "string") reject("execution.detail is not a string");
  }

  // lineage — every link present; tickId stays optional (in-flight back-compat).
  const lineage = v["lineage"];
  if (!isPlainObject(lineage)) reject("lineage is not a JSON object");
  for (const field of LINEAGE_VERBATIM_FIELDS) {
    if (!isNonEmptyString(lineage[field])) reject(`lineage.${field} missing or empty`);
  }
  if (!isNonEmptyString(lineage["executionStrategyId"])) {
    reject("lineage.executionStrategyId missing or empty");
  }
  const version = lineage["executionStrategyVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    reject("lineage.executionStrategyVersion is not a finite integer");
  }
  if (lineage["tickId"] !== undefined && !isNonEmptyString(lineage["tickId"])) {
    reject("lineage.tickId present but not a non-empty string");
  }

  // Verbatim cross-checks — a forged event cannot claim lineage its signal lacks.
  for (const field of LINEAGE_VERBATIM_FIELDS) {
    if (lineage[field] !== signal[field]) {
      reject(`lineage.${field} does not match signal.${field} (must be carried verbatim)`);
    }
  }

  // The one sanctioned unknown -> DecisionEvent conversion: every structural
  // check above has passed, so the assertion is earned, not assumed.
  return v as unknown as DecisionEvent;
}
