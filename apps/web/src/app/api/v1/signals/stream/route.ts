import type { SignalDTO } from "@/lib/signals";
import { getLatestSignals, getSignalsAfterCursor } from "@/lib/signals";

/**
 * GET /api/v1/signals/stream — Server-Sent Events stream of EngineSignal rows.
 *
 * Reconnect-safe: every `event: signal` carries an `id: <epochMs>:<rowId>`. The
 * browser echoes the last one as `Last-Event-ID` on auto-reconnect, so the
 * stream resumes STRICTLY after the (createdAt, id) keyset cursor and never
 * replays the backlog — no duplicate emission across reconnects. A fresh client
 * (no cursor) gets the recent backlog once; thereafter the stream polls Prisma
 * for rows after the cursor. (No Redis pub/sub is wired, so this is a DB-poll
 * bridge — new inserts surface within POLL_MS.) Heartbeat comments keep the
 * connection alive; the poll stops on client abort.
 *
 * Server-side failures are emitted as `event: stream-error` — NOT `error`,
 * which the browser dispatches on the EventSource as its built-in connection
 * -error event; a frame literally named "error" would be indistinguishable
 * from a dropped connection and push clients into fallback polling forever.
 */
export const dynamic = "force-dynamic";

const POLL_MS = 3000;
const BACKLOG = 50;

/** SSE id encoding the keyset cursor: `<createdAt epoch ms>:<row id>`. */
function eventId(s: SignalDTO): string {
  return `${new Date(s.createdAt).getTime()}:${s.id}`;
}

/**
 * Parse a `Last-Event-ID` ("<ms>:<id>") back into a keyset cursor. STRICT
 * (Phase 11C): the epoch-ms half must be a plain non-negative integer inside
 * the representable Date range and the id half a bounded opaque id — a
 * malformed cursor is rejected by the caller with a 400, never silently
 * treated as a fresh client (which would replay the whole backlog).
 */
const CURSOR_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_EPOCH_MS = 8.64e15; // ECMA-262 maximum Date time value

function parseCursor(raw: string | null): { ts: Date; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const msRaw = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!/^\d+$/.test(msRaw)) return null;
  const ms = Number(msRaw);
  if (!Number.isSafeInteger(ms) || ms > MAX_EPOCH_MS) return null;
  if (!CURSOR_ID_RE.test(id)) return null;
  return { ts: new Date(ms), id };
}

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let closed = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  // Resume point. A reconnect supplies Last-Event-ID (header, or ?lastEventId=
  // fallback for clients that cannot set it); a fresh client starts from zero.
  // A PRESENT-but-malformed cursor is a 400 (strict rejection), not a silent
  // fresh start — silently replaying the backlog would mask the client bug AND
  // duplicate every event the client already consumed.
  const url = new URL(request.url);
  const headerRaw = request.headers.get("last-event-id");
  const queryRaw = url.searchParams.get("lastEventId");
  const suppliedRaw = headerRaw ?? queryRaw;
  const resume = parseCursor(headerRaw) ?? parseCursor(queryRaw);
  if (suppliedRaw !== null && suppliedRaw !== "" && resume === null) {
    return new Response(
      JSON.stringify({ error: "invalid Last-Event-ID cursor: expected \"<epochMs>:<id>\"" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  let lastTs = resume ? resume.ts : new Date(0);
  let lastId = resume ? resume.id : "";
  const isReconnect = resume !== null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (s: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const sendEvent = (event: string, data: unknown): void =>
        enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const sendSignal = (s: SignalDTO): void => {
        enqueue(`id: ${eventId(s)}\nevent: signal\ndata: ${JSON.stringify(s)}\n\n`);
        lastTs = new Date(s.createdAt);
        lastId = s.id;
      };

      const stop = (): void => {
        if (timer) clearInterval(timer);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      };
      request.signal.addEventListener("abort", stop);

      sendEvent("ready", { ts: new Date().toISOString(), pollMs: POLL_MS, resumed: isReconnect });

      // Backlog only for a FRESH client. On reconnect we resume after the cursor
      // (handled by the poll below), so nothing already delivered is re-sent.
      if (!isReconnect) {
        try {
          const backlog = await getLatestSignals(BACKLOG);
          for (const s of [...backlog].reverse()) sendSignal(s); // oldest -> newest
        } catch (err) {
          sendEvent("stream-error", { detail: String(err) });
        }
      }

      timer = setInterval(() => {
        if (closed || polling) return;
        polling = true;
        void (async () => {
          try {
            const fresh = await getSignalsAfterCursor(lastTs, lastId, 100);
            for (const s of fresh) sendSignal(s);
            enqueue(`: ping ${Date.now()}\n\n`);
          } catch (err) {
            sendEvent("stream-error", { detail: String(err) });
          } finally {
            polling = false;
          }
        })();
      }, POLL_MS);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
