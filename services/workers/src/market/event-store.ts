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
import type { Account, OrderEvent, Position } from "./types.js";

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
 * Fail-closed on read: a non-contiguous or out-of-order `seq` is genuine
 * corruption and throws (recovery then halts execution). A single unparseable
 * TRAILING line is tolerated as a torn write — because the store is written
 * journal-THEN-commit, a torn final line means that execution never committed
 * in-memory either, so discarding it keeps disk and memory consistent.
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
      let parsed: MarketJournalRecord;
      try {
        parsed = JSON.parse(line) as MarketJournalRecord;
      } catch (err) {
        // A torn final line is an incomplete (never-committed) append — tolerate it.
        if (isLastNonEmpty) break;
        throw new JournalCorruptionError(
          `${this.path}: line ${i + 1} is not valid JSON (mid-file corruption): ${(err as Error).message}`,
        );
      }
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
