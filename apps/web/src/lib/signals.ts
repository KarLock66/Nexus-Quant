import { Prisma, prisma } from "@nexus/db";

/**
 * EngineSignal read model + Prisma queries shared by the REST route and the SSE
 * stream. Reads directly from Prisma (no caching). Decimal -> string and Date ->
 * ISO string so the wire shape is stable and JSON-safe.
 */
export interface SignalDTO {
  id: string;
  symbol: string;
  side: string;
  decision: string;
  confidence: string;
  featureHash: string;
  datasetHash: string;
  strategyVersionId: string;
  featureSnapshotId: string;
  createdAt: string;
  /**
   * Origin venue of the admitting FeatureSnapshot, verbatim from the DB.
   * "DEMO" marks the synthetic bootstrap/demo lineage so consumers can label
   * (never silently blend) non-market data.
   */
  origin: string;
}

const SELECT = {
  id: true,
  symbol: true,
  side: true,
  decision: true,
  confidence: true,
  featureHash: true,
  datasetHash: true,
  strategyVersionId: true,
  featureSnapshotId: true,
  createdAt: true,
  featureSnapshot: { select: { exchange: true } },
} as const;

type Row = {
  id: string;
  symbol: string;
  side: string;
  decision: string;
  confidence: { toString(): string };
  featureHash: string;
  datasetHash: string;
  strategyVersionId: string;
  featureSnapshotId: string;
  createdAt: Date;
  featureSnapshot: { exchange: string };
};

function toDTO(r: Row): SignalDTO {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    decision: r.decision,
    confidence: r.confidence.toString(),
    featureHash: r.featureHash,
    datasetHash: r.datasetHash,
    strategyVersionId: r.strategyVersionId,
    featureSnapshotId: r.featureSnapshotId,
    createdAt: r.createdAt.toISOString(),
    origin: r.featureSnapshot.exchange,
  };
}

/** Total order for paging/streaming: newest first, id as deterministic tiebreak. */
const ORDER_DESC: Prisma.EngineSignalOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

/**
 * Latest signals, newest first (stable order). Optional id-cursor pages backward
 * through history without offset drift; `limit` is always bounded by the caller.
 */
export async function getLatestSignals(
  limit: number,
  cursor?: string,
  offset = 0,
): Promise<SignalDTO[]> {
  // Cursor wins when present (drift-free keyset paging); otherwise fall back to a
  // bounded offset. `take`/`skip` are always finite, so the query can't run away.
  const base = { orderBy: ORDER_DESC, take: limit, select: SELECT };
  const rows = cursor
    ? await prisma.engineSignal.findMany({ ...base, cursor: { id: cursor }, skip: 1 })
    : offset > 0
      ? await prisma.engineSignal.findMany({ ...base, skip: offset })
      : await prisma.engineSignal.findMany(base);
  return rows.map(toDTO);
}

/**
 * Keyset read for the SSE poll: rows strictly after the (createdAt, id) cursor,
 * oldest first. Using the compound key (not createdAt alone) means rows sharing a
 * millisecond timestamp are never skipped and never re-emitted on reconnect.
 */
export async function getSignalsAfterCursor(
  afterTs: Date,
  afterId: string,
  limit: number,
): Promise<SignalDTO[]> {
  const rows = await prisma.engineSignal.findMany({
    where: {
      OR: [
        { createdAt: { gt: afterTs } },
        { createdAt: afterTs, id: { gt: afterId } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: SELECT,
  });
  return rows.map(toDTO);
}
