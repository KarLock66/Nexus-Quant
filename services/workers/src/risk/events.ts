/**
 * Append-only Risk Event store (Phase 8, Deliverable 6) — the durable substrate for
 * the risk event model. It records, append-only and in commit order, exactly the
 * events the objective enumerates:
 *
 *   RISK_CHECK_PASSED / RISK_CHECK_FAILED
 *   POSITION_LIMIT_BREACHED / LEVERAGE_LIMIT_BREACHED / DRAWDOWN_LIMIT_BREACHED
 *   KILL_SWITCH_TRIGGERED / TRADING_HALTED / TRADING_RESUMED
 *
 * From the record stream alone, recovery.ts rebuilds the entire RiskControlState
 * (halt status, session baseline, drawdown high-water-mark, counters) by replaying the
 * SAME pure fold the live engine uses (state.ts), so the risk state is replayable and
 * survives a restart with no hidden in-process state.
 *
 * Infrastructure-agnostic behind one interface — modeled byte-for-byte on the Phase 7
 * MarketEventStore so the two journals share durability semantics: the in-memory impl
 * is the deterministic test default; the JSONL file impl is the durable runtime backing
 * (no Postgres/Redis dependency — survives a restart by itself), fail-closed on
 * structural corruption and tolerant of a single torn trailing line.
 */

import { appendFile, readFile } from "node:fs/promises";
import { NOTIONAL_DP, isCanonicalDecimalString } from "./money.js";
import { KILL_SWITCH_TRIGGERS, RISK_EVENT_TYPES } from "./types.js";
import type { CapitalSnapshot, RiskJournalInput, RiskJournalRecord } from "./types.js";

/**
 * Append-only durable log of risk events. `append` assigns the next `seq` and
 * persists; `readAll` returns every record in commit order (for recovery).
 * Implementations MUST be append-only — once written a record is never mutated or
 * reordered, which is what makes the fold reconstructable and tamper-evident.
 */
export interface RiskEventStore {
  /** Persist `input` as the next record (assigns `seq`); resolves once durable. */
  append(input: RiskJournalInput): Promise<RiskJournalRecord>;
  /** Every record in durable commit order (seq ascending, contiguous from 0). */
  readAll(): Promise<RiskJournalRecord[]>;
}

/** Thrown when the durable risk log is structurally corrupt (non-contiguous seq, etc.). */
export class RiskJournalCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskJournalCorruptionError";
  }
}

// ── Record admission (Phase 11C Stage 2) ──────────────────────────────────────
//
// The JSONL read path is the one place untyped data enters the risk layer: a
// parsed line used to be trusted via a bare `as RiskJournalRecord` cast, and the
// state fold (state.ts applyRiskRecord) SILENTLY SKIPS a record whose `type` it
// does not recognize — its exhaustiveness check is compile-time only. That made
// the halt projection fail-OPEN under journal corruption: damage the type string
// of the one TRADING_HALTED / KILL_SWITCH_TRIGGERED record and the recovered
// state is NOT halted — trading would resume after a restart with no operator
// reset, violating the core invariant. Likewise a malformed capital snapshot
// would parseDecimal-coerce to 0 and silently corrupt the session baseline /
// drawdown high-water-mark. `assertValidRiskJournalRecord` closes both: every
// field the fold consumes is validated STRUCTURALLY before the record is
// admitted; anything unrecognizable is corruption and throws (the worker then
// starts HALTED — fail-closed — instead of silently un-halted). Audit-only
// payloads (`order`, free-text reason/detail) are container/type-checked only,
// so no record a real writer produces is ever rejected.

/** JSON columns must be plain objects here — never arrays, scalars, or null. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const RISK_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RISK_EVENT_TYPES);
const KILL_SWITCH_TRIGGER_SET: ReadonlySet<string> = new Set(KILL_SWITCH_TRIGGERS);

/** Every CapitalSnapshot field; Record keys give compile-time drift protection. */
const CAPITAL_FIELD_FLAGS: Record<keyof CapitalSnapshot, true> = {
  accountEquity: true,
  availableCash: true,
  usedMargin: true,
  availableMargin: true,
  unrealizedPnl: true,
  realizedPnl: true,
  grossExposure: true,
  netExposure: true,
};
const CAPITAL_FIELDS = Object.keys(CAPITAL_FIELD_FLAGS);

/**
 * Structural admission of one deserialized risk-journal record. THROWS
 * RiskJournalCorruptionError (fail-closed: recovery surfaces it and the worker
 * starts HALTED rather than trade on a state it cannot prove) on the first
 * malformed field. Well-formed records — the only kind the engine writes —
 * pass untouched, byte for byte.
 */
export function assertValidRiskJournalRecord(
  v: unknown,
  where: string,
): asserts v is RiskJournalRecord {
  // Explicitly annotated so TS control-flow treats a reject() call as terminal.
  const reject: (detail: string) => never = (detail) => {
    throw new RiskJournalCorruptionError(`${where}: ${detail} (malformed record — fail-closed)`);
  };

  if (!isPlainObject(v)) reject("record is not a JSON object");
  const seq = v["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    reject("seq is not a non-negative integer");
  }
  // The halt projection folds `type` — an unknown value here is exactly the
  // corruption that used to clear a halt silently.
  const type = v["type"];
  if (typeof type !== "string" || !RISK_EVENT_TYPE_SET.has(type)) {
    reject(`type "${String(type)}" is not a known risk event type`);
  }
  if (typeof v["reason"] !== "string") reject("reason is not a string");
  if (typeof v["detail"] !== "string") reject("detail is not a string");
  if (v["symbol"] !== null && typeof v["symbol"] !== "string") {
    reject("symbol is not a string or null");
  }
  // The session baseline + drawdown high-water-mark fold from the capital
  // snapshot; every field is a quantized 2dp capital string by construction.
  const capital = v["capital"];
  if (capital !== null) {
    if (!isPlainObject(capital)) reject("capital is not a JSON object or null");
    for (const field of CAPITAL_FIELDS) {
      if (!isCanonicalDecimalString(capital[field], NOTIONAL_DP)) {
        reject(`capital.${field} is not a canonical ${NOTIONAL_DP}dp decimal string`);
      }
    }
  }
  const trigger = v["trigger"];
  if (trigger !== null && (typeof trigger !== "string" || !KILL_SWITCH_TRIGGER_SET.has(trigger))) {
    reject(`trigger "${String(trigger)}" is not a known kill-switch trigger or null`);
  }
  const order = v["order"];
  if (order !== null && !isPlainObject(order)) {
    reject("order is not a JSON object or null");
  }
}

/**
 * In-memory store — the deterministic default for tests and for runtime when no
 * durable path is configured. Durable across ticks within a process, NOT across a
 * restart (use the file store for that). Append order is the source of truth.
 */
export class InMemoryRiskEventStore implements RiskEventStore {
  private readonly records: RiskJournalRecord[] = [];

  async append(input: RiskJournalInput): Promise<RiskJournalRecord> {
    const record: RiskJournalRecord = { ...input, seq: this.records.length };
    this.records.push(record);
    return record;
  }

  async readAll(): Promise<RiskJournalRecord[]> {
    // Defensive copy: callers fold over this; the store stays append-only.
    return this.records.slice();
  }
}

/**
 * Durable JSONL store — one record per line, appended atomically, never rewritten.
 * Survives a restart on its own (no external service). `seq` is cached after the first
 * touch so steady-state appends are O(1); `readAll` parses the whole file (used at
 * boot for recovery, infrequent).
 *
 * Fail-closed on read: a non-contiguous or out-of-order `seq` — or any record that
 * fails structural admission (assertValidRiskJournalRecord, Phase 11C Stage 2) — is
 * genuine corruption and throws (recovery then halts trading). A single unparseable
 * TRAILING line is tolerated as a torn write — because the engine appends BEFORE
 * acting on the outcome, a torn final line means that decision never took effect
 * either, so discarding it keeps disk and the live state consistent. Admission
 * failures are NEVER torn-tolerated, even on the last line: truncating
 * `JSON.stringify(record)` cannot yield parseable JSON of the wrong shape, so a
 * malformed-but-parseable record is corruption, not a crash artifact.
 */
export class FileRiskEventStore implements RiskEventStore {
  private nextSeq: number | null = null;

  constructor(private readonly path: string) {}

  async append(input: RiskJournalInput): Promise<RiskJournalRecord> {
    if (this.nextSeq === null) this.nextSeq = (await this.readAll()).length;
    const record: RiskJournalRecord = { ...input, seq: this.nextSeq };
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.nextSeq += 1;
    return record;
  }

  async readAll(): Promise<RiskJournalRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no journal yet
      throw err;
    }

    const lines = raw.split("\n");
    const records: RiskJournalRecord[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      const isLastNonEmpty = lines.slice(i + 1).every((l) => l.trim() === "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        // A torn final line is an incomplete (never-committed) append — tolerate it.
        if (isLastNonEmpty) break;
        throw new RiskJournalCorruptionError(
          `${this.path}: line ${i + 1} is not valid JSON (mid-file corruption): ${(err as Error).message}`,
        );
      }
      // Admission boundary (Phase 11C Stage 2): the record must be structurally
      // sound BEFORE it is trusted as a RiskJournalRecord — an unknown event
      // type or malformed capital snapshot throws here (fail-closed halt)
      // instead of being silently skipped or coerced by the state fold.
      // Never torn-tolerated (see the class doc).
      assertValidRiskJournalRecord(parsed, `${this.path}: line ${i + 1}`);
      // Append-only invariant: seq must be contiguous from 0 in file order.
      if (parsed.seq !== records.length) {
        throw new RiskJournalCorruptionError(
          `${this.path}: record at line ${i + 1} has seq ${parsed.seq} (expected ${records.length}) — log is not append-only`,
        );
      }
      records.push(parsed);
    }
    return records;
  }
}
