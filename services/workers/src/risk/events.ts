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
import type { RiskJournalInput, RiskJournalRecord } from "./types.js";

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
 * Fail-closed on read: a non-contiguous or out-of-order `seq` is genuine corruption and
 * throws (recovery then halts trading). A single unparseable TRAILING line is tolerated
 * as a torn write — because the engine appends BEFORE acting on the outcome, a torn
 * final line means that decision never took effect either, so discarding it keeps disk
 * and the live state consistent.
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
      let parsed: RiskJournalRecord;
      try {
        parsed = JSON.parse(line) as RiskJournalRecord;
      } catch (err) {
        // A torn final line is an incomplete (never-committed) append — tolerate it.
        if (isLastNonEmpty) break;
        throw new RiskJournalCorruptionError(
          `${this.path}: line ${i + 1} is not valid JSON (mid-file corruption): ${(err as Error).message}`,
        );
      }
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
