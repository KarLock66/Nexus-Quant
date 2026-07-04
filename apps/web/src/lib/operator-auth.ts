import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Fail-closed bearer-token guard for the MUTATING control-plane routes
 * (POST /api/v1/control/kill, /api/v1/control/resume, /api/v1/ops/actions).
 *
 * These endpoints change the trading runtime's state; without this guard anyone
 * who can reach the web tier can stop/resume trading. Server-only (node:crypto):
 *  - OPS_CONTROL_TOKEN unset  -> every command is refused with 503 (fail-closed:
 *    an unconfigured control plane accepts NO commands rather than all of them);
 *  - token set                -> the request must carry `Authorization: Bearer <token>`.
 * Tokens are compared as SHA-256 digests via timingSafeEqual so the comparison is
 * constant-time and length differences leak nothing.
 *
 * Read-only control/ops GET routes stay open by design (observability); only
 * state-changing commands are gated.
 */

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Returns `null` when the request is authorized, otherwise the error response to
 * send verbatim. Usage (first line of every mutating handler):
 *   const denied = requireOperatorAuth(req); if (denied) return denied;
 */
export function requireOperatorAuth(req: Request): NextResponse | null {
  const configured = (process.env.OPS_CONTROL_TOKEN ?? "").trim();
  if (configured === "") {
    return NextResponse.json(
      {
        error:
          "control commands are disabled: OPS_CONTROL_TOKEN is not configured on the server (fail-closed)",
      },
      { status: 503 },
    );
  }

  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const presented = (match?.[1] ?? "").trim();
  if (presented === "" || !timingSafeEqual(sha256(presented), sha256(configured))) {
    return NextResponse.json(
      { error: "unauthorized: missing or invalid operator token" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="nexus-control"' } },
    );
  }
  return null;
}
