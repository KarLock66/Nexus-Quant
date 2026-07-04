/**
 * PHASE 5 — Pagination / cursor consistency (over the live web API).
 *
 * Seeds a deterministic block of EngineSignal rows (including a createdAt TIE to
 * exercise the id tiebreak), then validates GET /api/v1/signals:
 *   - stable total ordering: createdAt DESC, id DESC
 *   - keyset (cursor) walk reproduces the single-query ordering exactly
 *   - no duplicate id across page boundaries; no missing rows
 *   - offset paging agrees with keyset paging on the same static set
 *
 * Deterministic because no worker runs during this phase — the row set is frozen.
 */

import { ensureSignalDemoChain, Prisma, prisma } from "@nexus/db";
import { assert, getJson, idsEqual, log } from "./lib.js";

const PAGE_SYMBOL = "PAGE-TEST";
const K = 25; // seeded rows -> multiple pages at LIMIT
const LIMIT = 10;

interface SignalDTO {
  id: string;
  createdAt: string;
  symbol: string;
}
interface SignalsEnvelope {
  data: SignalDTO[];
  nextCursor: string | null;
}

async function seedPaginationRows(featureSetId: string, strategyVersionId: string): Promise<void> {
  const dqReportId = "demo-dq-btc-perp-h1"; // exists after ensureSignalDemoChain
  const baseTs = Date.parse("2026-06-10T00:00:00.000Z");
  const baseCreated = Date.parse("2026-06-11T00:00:00.000Z");

  for (let i = 0; i < K; i++) {
    const snapId = `page-fs-${i}`;
    const sigId = `page-sig-${i}`;
    const ts = new Date(baseTs + i * 3_600_000);
    // Last two rows share a createdAt so the (createdAt, id) tiebreak is exercised.
    const createdIdx = i === K - 1 ? K - 2 : i;
    const createdAt = new Date(baseCreated + createdIdx * 1_000);
    const side = i % 2 === 0 ? "LONG" : "SHORT";

    await prisma.featureSnapshot.upsert({
      where: { id: snapId },
      update: {},
      create: {
        id: snapId,
        exchange: "DEMO",
        symbol: PAGE_SYMBOL,
        timeframe: "H1",
        ts,
        features: { idx: i } as Prisma.InputJsonValue,
        featureHash: `page-fh-${i}`,
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
        symbol: PAGE_SYMBOL,
        side,
        decision: side,
        confidence: "0.5000",
        strategyVersionId,
        strategyParams: {} as Prisma.InputJsonValue,
        featureSnapshotId: snapId,
        dqReportId,
        datasetHash: `page-ds-${i}`,
        featureHash: `page-fh-${i}`,
      },
    });
  }
}

async function fetchPage(
  baseUrl: string,
  limit: number,
  cursor?: string,
): Promise<SignalsEnvelope> {
  const q =
    cursor === undefined
      ? `?limit=${limit}`
      : `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
  const r = await getJson<SignalsEnvelope>(`${baseUrl}/api/v1/signals${q}`);
  assert(r.status === 200, `GET /signals${q} -> HTTP ${r.status}`);
  return r.body;
}

function assertOrdered(list: SignalDTO[]): void {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!;
    const b = list[i]!;
    const ok =
      a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
    assert(
      ok,
      `ordering violated at index ${i}: (${a.createdAt},${a.id}) not >= (${b.createdAt},${b.id})`,
    );
  }
}

/**
 * Remove every PAGE-TEST row (seeded signals/snapshots AND any signal a
 * concurrently-running engine generated from a PAGE-TEST snapshot — both carry
 * the symbol). The fixture rows must never outlive the phase: they are synthetic
 * signals and every production read model would serve them as real otherwise.
 */
async function cleanupPaginationRows(): Promise<void> {
  await prisma.engineSignal.deleteMany({ where: { symbol: PAGE_SYMBOL } });
  await prisma.featureSnapshot.deleteMany({ where: { symbol: PAGE_SYMBOL } });
}

export async function runPhase5(baseUrl: string): Promise<void> {
  log("info", "PHASE 5 — pagination / cursor consistency", { seeded: K, limit: LIMIT });

  const chain = await ensureSignalDemoChain(prisma);
  await seedPaginationRows(chain.featureSetId, chain.strategyVersion.id);
  try {
    await runPhase5Body(baseUrl);
  } finally {
    await cleanupPaginationRows();
    log("info", "PHASE 5 cleanup — PAGE-TEST fixture rows removed");
  }
}

async function runPhase5Body(baseUrl: string): Promise<void> {
  // Single-query reference ordering (whole table, bounded).
  const full = await fetchPage(baseUrl, 200);
  assert(full.data.length >= K, `expected >= ${K} rows, got ${full.data.length}`);
  assertOrdered(full.data);
  const referenceIds = full.data.map((d) => d.id);

  // Keyset (cursor) walk must reproduce the reference ordering exactly.
  const pages: string[][] = [];
  const walked: string[] = [];
  let cursor: string | undefined = undefined;
  let guard = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page: SignalsEnvelope = await fetchPage(baseUrl, LIMIT, cursor);
    pages.push(page.data.map((d) => d.id));
    walked.push(...page.data.map((d) => d.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    assert(++guard < 1000, "cursor walk did not terminate");
  }

  assert(
    idsEqual(walked, referenceIds),
    "keyset pagination order != single-query order (cursor drift)",
  );
  assert(
    new Set(walked).size === walked.length,
    "DUPLICATE id across cursor page boundaries",
  );

  // Offset paging must agree with keyset paging on page 2 of the same static set.
  const keysetPage2 = pages[1];
  assert(keysetPage2 !== undefined, "expected at least 2 cursor pages");
  if (keysetPage2 !== undefined) {
    const offsetPage2 = await getJson<SignalsEnvelope>(
      `${baseUrl}/api/v1/signals?limit=${LIMIT}&offset=${LIMIT}`,
    );
    assert(offsetPage2.status === 200, `offset page HTTP ${offsetPage2.status}`);
    assert(
      idsEqual(offsetPage2.body.data.map((d) => d.id), keysetPage2),
      "offset page 2 != keyset page 2 (offset/keyset disagree)",
    );
  }

  log("info", "PHASE 5 PASS", {
    totalRows: referenceIds.length,
    pages: pages.length,
    note: "cursor walk == single query == offset; no duplicates across boundaries",
  });
}
