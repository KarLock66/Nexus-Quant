/**
 * Phase 7 — Order & Position durability verification (pure folds + a temp file).
 *
 * Proves the Phase 7 guarantees on top of the UNCHANGED Phase 6 market layer:
 *   - the append-only store records every committed execution in commit order
 *   - the JSONL file store survives a "restart" (a fresh instance over the same
 *     file reads back byte-identical records)
 *   - Position / Account / Portfolio state RECONSTRUCT from the journal alone and
 *     equal the live state (event-sourced restart continuity)
 *   - recovery is FAIL-CLOSED: a tampered snapshot (integrity) or a divergent
 *     result (reconcile) HALTS with MarketRecoveryError
 *   - the durable hook is journal-THEN-commit: a journal write failure rejects the
 *     execution and commits NO in-memory state (disk and memory never diverge)
 *
 * IO-free except a single temp file for the file-store path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExecutionStage,
  runExecutionStage,
} from "../execution/stage.js";
import type {
  DecisionEvent,
  DecisionIntent,
  SignalObservation,
} from "../execution/types.js";
import {
  FileMarketEventStore,
  InMemoryMarketEventStore,
  JournalCorruptionError,
  assertValidMarketJournalRecord,
  type MarketEventStore,
  type MarketJournalInput,
  type MarketJournalRecord,
} from "./event-store.js";
import {
  MarketRecoveryError,
  recoverMarketState,
} from "./recovery.js";
import { SimulatedBroker } from "./broker.js";
import { fixtureQuoteProvider } from "../ci/fixtures.js";
import { createMarketExecutionAdapter } from "./stage.js";

// ── Fixtures (mirror the Phase 6 stage-integration fixtures) ───────────────────

const ctx = { log: () => {}, tickId: "p7-t1" };

function decisionEvent(
  symbol: string,
  side: "LONG" | "SHORT",
  confidence: string,
): DecisionEvent {
  const signal: SignalObservation = {
    symbol,
    side,
    decision: side,
    confidence,
    strategyVersionId: "sv-1",
    strategyParams: { rsiLongMin: 55, rsiShortMax: 45, maxRealizedVol: 0.02 },
    featureSnapshotId: `fs-${symbol}`,
    dqReportId: "dq-1",
    datasetHash: "dataset-hash-1",
    featureHash: "feature-hash-1",
  };
  const decision: DecisionIntent = { action: "ENTER", side, confidence, rationale: "fixture" };
  return {
    signal,
    decision,
    execution: null,
    lineage: {
      strategyVersionId: "sv-1",
      featureSnapshotId: `fs-${symbol}`,
      dqReportId: "dq-1",
      datasetHash: "dataset-hash-1",
      featureHash: "feature-hash-1",
      executionStrategyId: "core-technical",
      executionStrategyVersion: 1,
    },
  };
}

const decisions = [
  decisionEvent("BTC-PERP", "LONG", "0.5000"),
  decisionEvent("ETH-PERP", "SHORT", "0.4000"),
];

/** Drive the REAL Phase 5 stage with a durable adapter; return live state + store. */
async function driveDurable(store: MarketEventStore) {
  const adapter = createMarketExecutionAdapter({ eventStore: store, marketData: fixtureQuoteProvider() });
  const deps = createExecutionStage({ adapter });
  const result = await runExecutionStage(decisions, deps, ctx);
  return { adapter, portfolioState: result.portfolioState };
}

/** Rebuild an in-memory store from records, optionally tampering the inputs. */
async function rebuildStore(
  records: MarketJournalRecord[],
  tamper?: (inputs: MarketJournalInput[]) => void,
): Promise<InMemoryMarketEventStore> {
  const inputs = records.map(({ seq: _seq, ...rest }) =>
    structuredClone(rest) as MarketJournalInput,
  );
  tamper?.(inputs);
  const store = new InMemoryMarketEventStore();
  for (const input of inputs) await store.append(input);
  return store;
}

// ── Append-only store ──────────────────────────────────────────────────────────

describe("MarketEventStore — append-only, contiguous, in commit order", () => {
  it("assigns contiguous seq and preserves commit order", async () => {
    const store = new InMemoryMarketEventStore();
    const { adapter } = await driveDurable(store);
    const records = await store.readAll();
    expect(records.length).toBe(2); // one per committed (FILLED) execution
    expect(records.map((r) => r.seq)).toEqual([0, 1]);
    // Every record carries the lifecycle + the snapshots the objective enumerates.
    for (const rec of records) {
      expect(rec.orderEvents.length).toBeGreaterThan(0);
      expect(rec.result.status).toBe("FILLED");
      expect(rec.position.symbol).toBe(rec.symbol);
    }
    // Sanity: the live adapter has both positions.
    expect(Object.keys(adapter.getMarketState().positions).sort()).toEqual([
      "BTC-PERP",
      "ETH-PERP",
    ]);
  });

  it("only journals COMMITTED executions (rejects write nothing)", async () => {
    const store = new InMemoryMarketEventStore();
    // The real broker throws -> fail-closed REJECTED -> no commit -> no journal record.
    const { RealBroker } = await import("./broker.js");
    const adapter = createMarketExecutionAdapter({ broker: RealBroker, eventStore: store, marketData: fixtureQuoteProvider() });
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage([decisionEvent("BTC-PERP", "LONG", "0.5")], deps, ctx);
    expect(r.rejected).toBe(1);
    expect((await store.readAll()).length).toBe(0);
  });
});

// ── Restart reconstruction (event-sourced continuity) ──────────────────────────

describe("recoverMarketState — rebuilds Position/Account/Portfolio from the journal alone", () => {
  it("reconstructed state equals the live state", async () => {
    const store = new InMemoryMarketEventStore();
    const { adapter, portfolioState } = await driveDurable(store);

    const recovered = await recoverMarketState(store);
    expect(recovered.marketState).toEqual(adapter.getMarketState());
    expect(recovered.portfolioState).toEqual(portfolioState);
    expect(recovered.recordsReplayed).toBe(2);
    expect(recovered.fillsReplayed).toBeGreaterThanOrEqual(2);
  });

  it("a restarted adapter SEEDED with recovery continues consistently (idempotent re-run)", async () => {
    const store = new InMemoryMarketEventStore();
    const { adapter } = await driveDurable(store);
    const recovered = await recoverMarketState(store);

    // Fresh adapter as if after a restart, seeded from the reconstructed history.
    const restarted = createMarketExecutionAdapter({
      eventStore: store,
      marketData: fixtureQuoteProvider(),
      initialMarketState: recovered.marketState,
      initialPortfolioMirror: recovered.portfolioState,
    });
    const deps = createExecutionStage({ adapter: restarted, portfolioState: recovered.portfolioState });
    // Re-running the SAME decisions is a no-op at target and must reconcile.
    const r = await runExecutionStage(decisions, deps, ctx);
    expect(restarted.reconcileWith(r.portfolioState).ok).toBe(true);
    expect(restarted.getMarketState()).toEqual(adapter.getMarketState());
  });

  it("works with the simulated broker (partial fills) too", async () => {
    const store = new InMemoryMarketEventStore();
    const adapter = createMarketExecutionAdapter({
      broker: SimulatedBroker,
      marketData: fixtureQuoteProvider(),
      eventStore: store,
    });
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage(decisions, deps, ctx);
    const recovered = await recoverMarketState(store);
    expect(recovered.marketState).toEqual(adapter.getMarketState());
    expect(recovered.portfolioState).toEqual(r.portfolioState);
  });
});

// ── Fail-closed recovery ───────────────────────────────────────────────────────

describe("recoverMarketState — FAIL-CLOSED on tamper / divergence", () => {
  it("halts on a tampered position snapshot (integrity mismatch)", async () => {
    const store = new InMemoryMarketEventStore();
    await driveDurable(store);
    const records = await store.readAll();
    const tampered = await rebuildStore(records, (inputs) => {
      inputs[0]!.position.netQty = "999.00000000"; // snapshot disagrees with the fills
    });
    await expect(recoverMarketState(tampered)).rejects.toBeInstanceOf(MarketRecoveryError);
    await expect(recoverMarketState(tampered)).rejects.toThrow(/integrity/i);
  });

  it("halts on a divergent result (broker<->portfolio reconcile mismatch)", async () => {
    const store = new InMemoryMarketEventStore();
    await driveDurable(store);
    const records = await store.readAll();
    const tampered = await rebuildStore(records, (inputs) => {
      // Snapshot + fills stay true (integrity passes); only the portfolio-side
      // result is inflated, so the two derivations reconcile-fail.
      inputs[0]!.result.filledNotional = "999999.00";
    });
    await expect(recoverMarketState(tampered)).rejects.toThrow(/reconcil/i);
  });

  it("halts on a tampered account snapshot (integrity mismatch)", async () => {
    const store = new InMemoryMarketEventStore();
    const adapter = createMarketExecutionAdapter({
      broker: SimulatedBroker, // realizes slippage -> account moves, so the snapshot bites
      marketData: fixtureQuoteProvider(),
      eventStore: store,
    });
    const deps = createExecutionStage({ adapter });
    await runExecutionStage(decisions, deps, ctx);
    const records = await store.readAll();
    const tampered = await rebuildStore(records, (inputs) => {
      const last = inputs[inputs.length - 1]!;
      last.account.cashBalance = "123.45";
    });
    await expect(recoverMarketState(tampered)).rejects.toThrow(/account integrity/i);
  });
});

// ── Journal-then-commit (durable hook is fail-closed) ──────────────────────────

describe("durable hook — journal-then-commit is fail-closed", () => {
  it("a journal write failure rejects the execution and commits NO state", async () => {
    const failing: MarketEventStore = {
      append: async () => {
        throw new Error("disk full");
      },
      readAll: async () => [],
    };
    const adapter = createMarketExecutionAdapter({ eventStore: failing, marketData: fixtureQuoteProvider() });
    const deps = createExecutionStage({ adapter });
    const r = await runExecutionStage([decisionEvent("BTC-PERP", "LONG", "0.5")], deps, ctx);
    expect(r.filled).toBe(0);
    expect(r.rejected).toBe(1);
    expect(r.results[0]!.detail).toMatch(/durable journal write failed/);
    // No in-memory state advanced past the un-journaled fill.
    expect(adapter.getMarketState().positions["BTC-PERP"]).toBeUndefined();
  });
});

// ── JSONL file store — durable across a "restart" ──────────────────────────────

describe("FileMarketEventStore — durable JSONL, restart-safe, corruption fail-closed", () => {
  it("a fresh instance over the same file reconstructs the live state (restart)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-journal-"));
    const file = join(dir, "market-journal.jsonl");
    try {
      const { adapter, portfolioState } = await driveDurable(new FileMarketEventStore(file));
      // Simulate a process restart: a brand-new store instance over the same file.
      const recovered = await recoverMarketState(new FileMarketEventStore(file));
      expect(recovered.marketState).toEqual(adapter.getMarketState());
      expect(recovered.portfolioState).toEqual(portfolioState);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a torn trailing line (incomplete, never-committed append)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-journal-"));
    const file = join(dir, "torn.jsonl");
    try {
      const store = new FileMarketEventStore(file);
      const { adapter } = await driveDurable(store);
      const good = await store.readAll();
      // Append a torn (unparseable) final line, as a crash mid-write would leave.
      await writeFile(file, `{"seq":${good.length},"intentId":"torn`, { flag: "a" });
      const reread = await new FileMarketEventStore(file).readAll();
      expect(reread.length).toBe(good.length); // torn line discarded, rest intact
      const recovered = await recoverMarketState(new FileMarketEventStore(file));
      expect(recovered.marketState).toEqual(adapter.getMarketState());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on mid-file corruption", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-journal-"));
    const file = join(dir, "corrupt.jsonl");
    try {
      const recs = (await driveStoreless()).records;
      // line0 valid, line1 garbage (NOT last), line2 valid -> mid-file corruption.
      const line0 = JSON.stringify({ ...recs[0], seq: 0 });
      const line2 = JSON.stringify({ ...recs[1], seq: 1 });
      await writeFile(file, `${line0}\n{ broken json\n${line2}\n`);
      await expect(new FileMarketEventStore(file).readAll()).rejects.toBeInstanceOf(
        JournalCorruptionError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a non-contiguous seq (not append-only)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-journal-"));
    const file = join(dir, "gap.jsonl");
    try {
      const recs = (await driveStoreless()).records;
      const line0 = JSON.stringify({ ...recs[0], seq: 0 });
      const lineGap = JSON.stringify({ ...recs[1], seq: 2 }); // gap: expected 1
      await writeFile(file, `${line0}\n${lineGap}\n`);
      await expect(new FileMarketEventStore(file).readAll()).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Drive a run against an in-memory store and expose its records (helper). */
async function driveStoreless(): Promise<{ records: MarketJournalRecord[] }> {
  const store = new InMemoryMarketEventStore();
  await driveDurable(store);
  return { records: await store.readAll() };
}

// ── Structural record admission (Phase 11C Stage 2) ────────────────────────────
//
// Every case writes a journal of REAL records with exactly one field tampered
// into parseable-but-malformed JSON — the corruption class the JSON/seq checks
// cannot see. Before Stage 2 these records were trusted via a bare cast: some
// crashed recovery untyped (non-array orderEvents), others folded SILENTLY
// (a damaged result.status coerces to "not FILLED"; a missing
// lineage.executionStrategyId buckets exposure under "undefined", which
// reconciliation does not check). Now every one is refused at admission with
// the typed corruption error, so the worker halts execution fail-closed.

describe("FileMarketEventStore — structural record admission (Phase 11C Stage 2)", () => {
  /** Write real records as JSONL, tampering the LAST record via `mutate`. */
  async function writeTamperedJournal(
    file: string,
    mutate: (rec: Record<string, any>) => void,
  ): Promise<void> {
    const recs = (await driveStoreless()).records;
    expect(recs.length).toBeGreaterThan(1);
    const lines = recs.map((r, i) => {
      const obj = JSON.parse(JSON.stringify(r)) as Record<string, any>;
      if (i === recs.length - 1) mutate(obj);
      return JSON.stringify(obj);
    });
    await writeFile(file, `${lines.join("\n")}\n`);
  }

  const CASES: Array<{
    name: string;
    mutate: (r: Record<string, any>) => void;
    detail: RegExp;
  }> = [
    {
      name: "orderEvents replaced by a non-array (used to crash recovery untyped)",
      mutate: (r) => {
        r["orderEvents"] = {};
      },
      detail: /orderEvents is not an array/,
    },
    {
      name: "unknown order event kind",
      mutate: (r) => {
        r["orderEvents"][0].kind = "ORDER_TELEPORTED";
      },
      detail: /not a known order event kind/,
    },
    {
      name: "result.status outside FILLED|REJECTED (used to coerce silently to not-FILLED)",
      mutate: (r) => {
        r["result"].status = "FILED";
      },
      detail: /result\.status/,
    },
    {
      name: "result.filledNotional not a canonical decimal (used to parseDecimal to 0)",
      mutate: (r) => {
        r["result"].filledNotional = "garbage";
      },
      detail: /filledNotional/,
    },
    {
      name: 'missing result.lineage.executionStrategyId (used to bucket exposure under "undefined")',
      mutate: (r) => {
        delete r["result"].lineage.executionStrategyId;
      },
      detail: /executionStrategyId/,
    },
    {
      name: "account.cashBalance as a number instead of a decimal string",
      mutate: (r) => {
        r["account"].cashBalance = 1_000_000;
      },
      detail: /cashBalance/,
    },
    {
      name: "position.netQty in exponent form (parseable, non-canonical)",
      mutate: (r) => {
        r["position"].netQty = "1e8";
      },
      detail: /netQty/,
    },
  ];

  for (const { name, mutate, detail } of CASES) {
    it(`fails closed on ${name} — even on the last line (never torn-tolerated)`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "nexus-admit-"));
      const file = join(dir, "tampered.jsonl");
      try {
        await writeTamperedJournal(file, mutate);
        await expect(new FileMarketEventStore(file).readAll()).rejects.toBeInstanceOf(
          JournalCorruptionError,
        );
        await expect(new FileMarketEventStore(file).readAll()).rejects.toThrow(detail);
        // End to end: recovery surfaces the same refusal, so the worker leaves
        // execution UNARMED instead of seeding the adapter from a corrupt log.
        await expect(recoverMarketState(new FileMarketEventStore(file))).rejects.toThrow(detail);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("admits every record a real run writes (round-trip byte-identical, nothing rejected)", async () => {
    const recs = (await driveStoreless()).records;
    expect(recs.length).toBeGreaterThan(0);
    for (const [i, rec] of recs.entries()) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(rec));
      expect(() => assertValidMarketJournalRecord(roundTripped, `record ${i}`)).not.toThrow();
    }
  });
});
