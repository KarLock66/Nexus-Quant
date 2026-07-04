/**
 * PHASE 3 — SSE stream consistency (reconnect via Last-Event-ID).
 *
 * Runs against a FROZEN row set (no worker active), so the expected stream is
 * deterministic: the server backlog is the newest BACKLOG(=50) rows oldest->newest,
 * which equals GET /signals?limit=50 reversed. Validates:
 *   - fresh connect delivers the full backlog in stable order, each with an id
 *   - no duplicate event ids
 *   - reconnect with Last-Event-ID resumes STRICTLY after the cursor: only newer
 *     events, none re-sent (no duplication), none skipped (no gap)
 *
 * FIXTURE OWNERSHIP (F1 fix): the SSE test needs >= 3 signals to exercise a
 * mid-stream reconnect cutoff. It no longer borrows whatever rows earlier phases
 * happened to leave behind (Phase 1 leaves exactly 2 demo rows; Phase 5 deletes
 * its own fixtures before this phase runs — so the composed harness previously
 * had only 2 rows here and failed "need >= 3 signals"). This phase now SEEDS its
 * own deterministic frozen block under a dedicated symbol and removes it in a
 * finally block, so it owns its setup/teardown and is order-independent.
 */

import { ensureSignalDemoChain, Prisma, prisma } from "@nexus/db";
import {
  assert,
  collectSse,
  eventIdOf,
  getJson,
  idsEqual,
  log,
} from "./lib.js";

const BACKLOG = 50; // must match the stream route's BACKLOG
const SSE_SYMBOL = "SSE-TEST";
const SSE_SEED = 6; // >= 3 required; a comfortable margin for the reconnect cutoff

interface SignalDTO {
  id: string;
  createdAt: string;
}

/**
 * Seed a deterministic, well-separated block of EngineSignal rows (one per
 * synthetic FeatureSnapshot) under SSE_SYMBOL. createdAt values are 1s apart so
 * the (createdAt, id) total order is unambiguous. Idempotent via upsert.
 */
async function seedSseRows(featureSetId: string, strategyVersionId: string): Promise<void> {
  const dqReportId = "demo-dq-btc-perp-h1"; // exists after ensureSignalDemoChain
  const baseTs = Date.parse("2026-06-15T00:00:00.000Z");
  const baseCreated = Date.parse("2026-06-16T00:00:00.000Z");

  for (let i = 0; i < SSE_SEED; i++) {
    const snapId = `sse-fs-${i}`;
    const sigId = `sse-sig-${i}`;
    const ts = new Date(baseTs + i * 3_600_000);
    const createdAt = new Date(baseCreated + i * 1_000);
    const side = i % 2 === 0 ? "LONG" : "SHORT";

    await prisma.featureSnapshot.upsert({
      where: { id: snapId },
      update: {},
      create: {
        id: snapId,
        exchange: "DEMO",
        symbol: SSE_SYMBOL,
        timeframe: "H1",
        ts,
        features: { idx: i } as Prisma.InputJsonValue,
        featureHash: `sse-fh-${i}`,
        featureSetId,
        dqReportId,
      },
    });

    await prisma.engineSignal.upsert({
      where: { id: sigId },
      update: { createdAt },
      create: {
        id: sigId,
        createdAt,
        symbol: SSE_SYMBOL,
        side,
        decision: side,
        confidence: "0.5000",
        strategyVersionId,
        strategyParams: {} as Prisma.InputJsonValue,
        featureSnapshotId: snapId,
        dqReportId,
        datasetHash: `sse-ds-${i}`,
        featureHash: `sse-fh-${i}`,
      },
    });
  }
}

/** Remove every SSE-TEST fixture row — they must never outlive the phase. */
async function cleanupSseRows(): Promise<void> {
  await prisma.engineSignal.deleteMany({ where: { symbol: SSE_SYMBOL } });
  await prisma.featureSnapshot.deleteMany({ where: { symbol: SSE_SYMBOL } });
}

export async function runPhase3(baseUrl: string): Promise<void> {
  log("info", "PHASE 3 — SSE stream consistency", { seeded: SSE_SEED });
  const chain = await ensureSignalDemoChain(prisma);
  await seedSseRows(chain.featureSetId, chain.strategyVersion.id);
  try {
    await runPhase3Body(baseUrl);
  } finally {
    await cleanupSseRows();
    log("info", "PHASE 3 cleanup — SSE-TEST fixture rows removed");
  }
}

async function runPhase3Body(baseUrl: string): Promise<void> {
  const streamUrl = `${baseUrl}/api/v1/signals/stream`;

  // Expected ordered stream = newest-BACKLOG rows reversed (matches server backlog).
  const latest = (
    await getJson<{ data: SignalDTO[] }>(`${baseUrl}/api/v1/signals?limit=${BACKLOG}`)
  ).body.data;
  const expected = [...latest].reverse(); // oldest -> newest
  assert(expected.length >= 3, `need >= 3 signals for the SSE test, have ${expected.length}`);
  const expectedIds = expected.map(eventIdOf);

  // ── Fresh connect: full backlog, in order, unique ids. ──────────────────────
  const fresh = await collectSse(streamUrl, {
    stopWhen: (evs) => evs.filter((e) => e.event === "signal").length >= expected.length,
    maxMs: 20_000,
  });
  const freshIds = fresh.events.filter((e) => e.event === "signal").map((e) => e.id ?? "");
  assert(
    freshIds.length === expected.length,
    `fresh stream sent ${freshIds.length} signals, expected ${expected.length}`,
  );
  assert(idsEqual(freshIds, expectedIds), "fresh stream order != expected order");
  assert(new Set(freshIds).size === freshIds.length, "duplicate event id in fresh stream");

  // ── Reconnect from a cutoff: only newer events, no dup, no gap. ──────────────
  const cutoffIdx = expected.length - 2;
  const cutoffEventId = expectedIds[cutoffIdx]!;
  const remainingIds = expectedIds.slice(cutoffIdx + 1);
  const alreadyDelivered = new Set(expectedIds.slice(0, cutoffIdx + 1));

  const reconnect = await collectSse(streamUrl, {
    lastEventId: cutoffEventId,
    stopWhen: (evs) => evs.filter((e) => e.event === "signal").length >= remainingIds.length,
    maxMs: 20_000,
  });
  const reconnectIds = reconnect.events
    .filter((e) => e.event === "signal")
    .map((e) => e.id ?? "");

  for (const id of reconnectIds) {
    assert(!alreadyDelivered.has(id), `reconnect re-sent an already-delivered event: ${id}`);
  }
  assert(
    idsEqual(reconnectIds, remainingIds),
    `reconnect sequence mismatch — got [${reconnectIds.join(", ")}], expected [${remainingIds.join(", ")}]`,
  );

  log("info", "PHASE 3 PASS", {
    backlogDelivered: freshIds.length,
    resumedFrom: cutoffEventId,
    afterReconnect: reconnectIds.length,
    note: "Last-Event-ID resume replayed nothing and skipped nothing",
  });
}
