/**
 * Append-only market event store (Phase 7) — Order & Position durability.
 *
 * Phase 6 made Position / Account / Portfolio pure, reconstructable folds but
 * persisted NOTHING — the fill stream lived only in memory, so a restart lost it.
 * Phase 7 adds the missing durable substrate WITHOUT changing any Phase 6 fold:
 * the store records, append-only and in commit order, exactly the events the
 * objective names —
 *
 *   ORDER_* / FILL_*   (the lifecycle stream, incl. every realized fill)
 *   POSITION_UPDATED   (the committed position snapshot for the symbol)
 *   ACCOUNT_UPDATED    (the committed account scalar after the execution)
 *
 * One `MarketJournalRecord` is appended per COMMITTED execution (see stage.ts:
 * journal-then-commit, so disk and memory advance together, fail-closed). From the
 * record stream alone, recovery.ts rebuilds all three states by replaying the SAME
 * pure folds the live path uses (reconstructMarketState over the fills, the
 * portfolio fold over the results) — so deterministic replay holds across a restart
 * exactly as it holds within a run.
 *
 * The store is infrastructure-agnostic behind one interface: the in-memory impl is
 * the deterministic test default; the JSONL file impl is the durable runtime
 * backing (no Postgres/Redis dependency — survives a restart by itself). A Redis
 * Streams / DB-table impl can later satisfy the same interface with no fold change.
 */

import { appendFile, readFile } from "node:fs/promises";
import type { ExecutionResult } from "../execution/types.js";
import {
  NOTIONAL_DP,
  PRICE_DP,
  QTY_DP,
  isCanonicalDecimalString,
} from "./money.js";
import type { Account, OrderEvent, OrderEventKind, Position } from "./types.js";

/**
 * One durable record of a committed execution — the unit recovery replays. It
 * bundles the three event families the objective enumerates so the record is
 * lossless: the order lifecycle (fills are lifted from it on read), the result
 * (the portfolio fold's input), and the position/account snapshots (the integrity
 * anchors recovery checks the recomputed fold against, fail-closed).
 */
export interface MarketJournalRecord {
  /** Global monotonic sequence (0-based) fixing the durable commit order. */
  seq: number;
  intentId: string;
  symbol: string;
  /** ORDER_* / FILL_* lifecycle for this execution (the realized-fill source). */
  orderEvents: OrderEvent[];
  /** The committed ExecutionResult (Phase 5 portfolio-fold input). */
  result: ExecutionResult;
  /** POSITION_UPDATED: the committed net position for `symbol` after this execution. */
  position: Position;
  /** ACCOUNT_UPDATED: the committed account scalar after this execution. */
  account: Account;
}

/** A record before the store assigns its durable sequence number. */
export type MarketJournalInput = Omit<MarketJournalRecord, "seq">;

/**
 * Append-only durable log of committed executions. `append` assigns the next `seq`
 * and persists; `readAll` returns every record in commit order (for recovery).
 * Implementations MUST be append-only — a record, once written, is never mutated
 * or reordered, which is what makes the fold reconstructable and tamper-evident.
 */
export interface MarketEventStore {
  /** Persist `input` as the next record (assigns `seq`); resolves once durable. */
  append(input: MarketJournalInput): Promise<MarketJournalRecord>;
  /** Every record in durable commit order (seq ascending, contiguous from 0). */
  readAll(): Promise<MarketJournalRecord[]>;
}

/** Thrown when the durable log is structurally corrupt (non-contiguous seq, etc.). */
export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalCorruptionError";
  }
}

// ── Record admission (Phase 11C Stage 2) ──────────────────────────────────────
//
// The JSONL read path is the one place untyped data enters the market layer: a
// parsed line used to be trusted via a bare `as MarketJournalRecord` cast, so a
// parseable-but-malformed record could reach the recovery folds — crashing
// untyped (orderEvents not an array), or worse, coercing silently (a damaged
// result.status folds as "not FILLED"; a missing lineage.executionStrategyId
// buckets exposure under "undefined", which reconciliation does NOT check).
// `assertValidMarketJournalRecord` makes the cast provably safe: it validates,
// STRUCTURALLY only, every field the recovery path consumes (fillsFrom, the
// market/portfolio folds, verifyAgainstSnapshots) before the record is admitted.
// Audit-only payloads (non-fill lifecycle fields, lineage beyond the consumed
// strategy bucket) are container-checked only — admission never rejects a
// record a real writer could produce, so well-formed journals replay unchanged.

/** JSON columns must be plain objects here — never arrays, scalars, or null. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Runtime mirror of OrderEventKind; Record keys give compile-time drift protection. */
const ORDER_EVENT_KIND_FLAGS: Record<OrderEventKind, true> = {
  ORDER_REQUESTED: true,
  ORDER_SUBMITTED: true,
  ORDER_ACCEPTED: true,
  ORDER_PARTIALLY_FILLED: true,
  ORDER_FILLED: true,
  ORDER_CANCELLED: true,
  ORDER_REJECTED: true,
};
const ORDER_EVENT_KINDS: ReadonlySet<string> = new Set(Object.keys(ORDER_EVENT_KIND_FLAGS));

/**
 * Structural admission of one deserialized journal record. THROWS
 * JournalCorruptionError (fail-closed: recovery halts execution, append refuses
 * to extend a corrupt log) on the first malformed field. Well-formed records —
 * the only kind the live stage writes — pass untouched, byte for byte.
 */
export function assertValidMarketJournalRecord(
  v: unknown,
  where: string,
): asserts v is MarketJournalRecord {
  // Explicitly annotated so TS control-flow treats a reject() call as terminal.
  const reject: (detail: string) => never = (detail) => {
    throw new JournalCorruptionError(`${where}: ${detail} (malformed record — fail-closed)`);
  };

  if (!isPlainObject(v)) reject("record is not a JSON object");
  const seq = v["seq"];
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    reject("seq is not a non-negative integer");
  }
  if (!isNonEmptyString(v["intentId"])) reject("intentId missing or empty");
  if (!isNonEmptyString(v["symbol"])) reject("symbol missing or empty");

  // ORDER_* lifecycle: recovery lifts fills from it (fillsFrom), so fill events
  // must carry sound identity, sign, and economics; other kinds are ignored by
  // the folds and only need a recognizable kind.
  const events = v["orderEvents"];
  if (!Array.isArray(events)) reject("orderEvents is not an array");
  for (let j = 0; j < events.length; j += 1) {
    const e: unknown = events[j];
    if (!isPlainObject(e)) reject(`orderEvents[${j}] is not a JSON object`);
    const kind = e["kind"];
    if (typeof kind !== "string" || !ORDER_EVENT_KINDS.has(kind)) {
      reject(`orderEvents[${j}].kind "${String(kind)}" is not a known order event kind`);
    }
    if (kind === "ORDER_PARTIALLY_FILLED" || kind === "ORDER_FILLED") {
      if (!isNonEmptyString(e["orderId"])) reject(`orderEvents[${j}].orderId missing or empty`);
      if (!isNonEmptyString(e["intentId"])) reject(`orderEvents[${j}].intentId missing or empty`);
      if (!isNonEmptyString(e["symbol"])) reject(`orderEvents[${j}].symbol missing or empty`);
      if (e["side"] !== "BUY" && e["side"] !== "SELL") {
        reject(`orderEvents[${j}].side "${String(e["side"])}" is not BUY|SELL`);
      }
      if (!isCanonicalDecimalString(e["fillQty"], QTY_DP)) {
        reject(`orderEvents[${j}].fillQty is not a canonical ${QTY_DP}dp decimal string`);
      }
      if (!isCanonicalDecimalString(e["fillPrice"], PRICE_DP)) {
        reject(`orderEvents[${j}].fillPrice is not a canonical ${PRICE_DP}dp decimal string`);
      }
      if (!isPlainObject(e["lineage"])) reject(`orderEvents[${j}].lineage is not a JSON object`);
    }
  }

  // ExecutionResult: the portfolio fold consumes status/symbol/side/notional and
  // buckets per-strategy exposure by lineage.executionStrategyId.
  const result = v["result"];
  if (!isPlainObject(result)) reject("result is not a JSON object");
  if (result["status"] !== "FILLED" && result["status"] !== "REJECTED") {
    reject(`result.status "${String(result["status"])}" is not FILLED|REJECTED`);
  }
  if (!isNonEmptyString(result["symbol"])) reject("result.symbol missing or empty");
  if (result["side"] !== "LONG" && result["side"] !== "SHORT") {
    reject(`result.side "${String(result["side"])}" is not LONG|SHORT`);
  }
  if (!isCanonicalDecimalString(result["filledNotional"], NOTIONAL_DP)) {
    reject(`result.filledNotional is not a canonical ${NOTIONAL_DP}dp decimal string`);
  }
  const lineage = result["lineage"];
  if (!isPlainObject(lineage)) reject("result.lineage is not a JSON object");
  if (!isNonEmptyString(lineage["executionStrategyId"])) {
    reject("result.lineage.executionStrategyId missing or empty");
  }

  // POSITION_UPDATED / ACCOUNT_UPDATED snapshots: the fail-closed integrity
  // anchors recovery compares the recomputed folds against, field by field.
  const position = v["position"];
  if (!isPlainObject(position)) reject("position is not a JSON object");
  if (!isNonEmptyString(position["symbol"])) reject("position.symbol missing or empty");
  if (!isCanonicalDecimalString(position["netQty"], QTY_DP)) {
    reject(`position.netQty is not a canonical ${QTY_DP}dp decimal string`);
  }
  if (!isCanonicalDecimalString(position["avgEntryPrice"], PRICE_DP)) {
    reject(`position.avgEntryPrice is not a canonical ${PRICE_DP}dp decimal string`);
  }
  if (!isCanonicalDecimalString(position["realizedPnl"], NOTIONAL_DP)) {
    reject(`position.realizedPnl is not a canonical ${NOTIONAL_DP}dp decimal string`);
  }
  if (!isCanonicalDecimalString(position["markPrice"], PRICE_DP)) {
    reject(`position.markPrice is not a canonical ${PRICE_DP}dp decimal string`);
  }

  const account = v["account"];
  if (!isPlainObject(account)) reject("account is not a JSON object");
  if (!isCanonicalDecimalString(account["cashBalance"], NOTIONAL_DP)) {
    reject(`account.cashBalance is not a canonical ${NOTIONAL_DP}dp decimal string`);
  }
  if (!isCanonicalDecimalString(account["realizedPnl"], NOTIONAL_DP)) {
    reject(`account.realizedPnl is not a canonical ${NOTIONAL_DP}dp decimal string`);
  }
}

/**
 * In-memory store — the deterministic default for tests and for runtime when no
 * durable path is configured. Durable across ticks within a process, NOT across a
 * restart (use the file store for that). Append order is the source of truth.
 */
export class InMemoryMarketEventStore implements MarketEventStore {
  private readonly records: MarketJournalRecord[] = [];

  async append(input: MarketJournalInput): Promise<MarketJournalRecord> {
    const record: MarketJournalRecord = { ...input, seq: this.records.length };
    this.records.push(record);
    return record;
  }

  async readAll(): Promise<MarketJournalRecord[]> {
    // Defensive copy: callers fold over this; the store stays append-only.
    return this.records.slice();
  }
}

/**
 * Durable JSONL store — one record per line, appended atomically, never rewritten.
 * Survives a restart on its own (no external service). `seq` is cached after the
 * first touch so steady-state appends are O(1); `readAll` parses the whole file
 * (used at boot for recovery, infrequent).
 *
 * Fail-closed on read: a non-contiguous or out-of-order `seq` — or any record
 * that fails structural admission (assertValidMarketJournalRecord, Phase 11C
 * Stage 2) — is genuine corruption and throws (recovery then halts execution).
 * A single unparseable TRAILING line is tolerated as a torn write — because the
 * store is written journal-THEN-commit, a torn final line means that execution
 * never committed in-memory either, so discarding it keeps disk and memory
 * consistent. Admission failures are NEVER torn-tolerated, even on the last
 * line: truncating `JSON.stringify(record)` cannot yield parseable JSON of the
 * wrong shape, so a malformed-but-parseable record is corruption, not a crash.
 */
export class FileMarketEventStore implements MarketEventStore {
  private nextSeq: number | null = null;

  constructor(private readonly path: string) {}

  async append(input: MarketJournalInput): Promise<MarketJournalRecord> {
    if (this.nextSeq === null) this.nextSeq = (await this.readAll()).length;
    const record: MarketJournalRecord = { ...input, seq: this.nextSeq };
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.nextSeq += 1;
    return record;
  }

  async readAll(): Promise<MarketJournalRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no journal yet
      throw err;
    }

    const lines = raw.split("\n");
    const records: MarketJournalRecord[] = [];
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
        throw new JournalCorruptionError(
          `${this.path}: line ${i + 1} is not valid JSON (mid-file corruption): ${(err as Error).message}`,
        );
      }
      // Admission boundary (Phase 11C Stage 2): the record must be structurally
      // sound BEFORE it is trusted as a MarketJournalRecord — a malformed field
      // throws here rather than crashing untyped or coercing silently inside
      // the recovery folds. Never torn-tolerated (see the class doc).
      assertValidMarketJournalRecord(parsed, `${this.path}: line ${i + 1}`);
      // Append-only invariant: seq must be contiguous from 0 in file order.
      if (parsed.seq !== records.length) {
        throw new JournalCorruptionError(
          `${this.path}: record at line ${i + 1} has seq ${parsed.seq} (expected ${records.length}) — log is not append-only`,
        );
      }
      records.push(parsed);
    }
    return records;
  }
}
