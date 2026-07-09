/**
 * Fail-fast guard in front of every destructive CI-harness database operation
 * (deleteMany on EngineSignal / FeatureSnapshot / control-plane tables).
 *
 * The harness deletes rows as part of fixture setup/teardown. That is safe ONLY
 * against a disposable local database. If DATABASE_URL ever points at a shared or
 * production host (a copy-pasted env file, a leaked host secret), the harness must
 * refuse to run rather than silently destroy data.
 *
 * Policy (fail-closed):
 *   - hostname is localhost / 127.0.0.1 / ::1  -> allowed
 *   - anything else (including unset/unparseable DATABASE_URL) -> refused,
 *     UNLESS the operator explicitly opts in with CI_ALLOW_NONLOCAL_DESTRUCTIVE_DB=1
 *     (intended for a disposable containerized database that is not addressed as
 *     localhost, e.g. a compose service hostname inside a CI network).
 *
 * Kept free of @nexus/db imports so it is unit-testable without a generated
 * Prisma client or a reachable database.
 */

export const DESTRUCTIVE_DB_OPT_IN_ENV = "CI_ALLOW_NONLOCAL_DESTRUCTIVE_DB";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class DestructiveDbGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestructiveDbGuardError";
  }
}

function refuse(reason: string): never {
  throw new DestructiveDbGuardError(
    `destructive DB operation refused: ${reason}. The CI harness deletes rows and must ` +
      `only run against a disposable local database (localhost / 127.0.0.1 / ::1). ` +
      `Set ${DESTRUCTIVE_DB_OPT_IN_ENV}=1 ONLY to explicitly opt in a disposable non-local database.`,
  );
}

/**
 * Throw unless the target database is local or the operator explicitly opted in.
 * Call this BEFORE any destructive operation — never after partial deletes.
 */
export function assertDestructiveDbAllowed(
  databaseUrl: string | undefined = process.env["DATABASE_URL"],
  env: Record<string, string | undefined> = process.env,
): void {
  if (env[DESTRUCTIVE_DB_OPT_IN_ENV] === "1") return;
  if (databaseUrl === undefined || databaseUrl === "") {
    refuse("DATABASE_URL is not set");
  }
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    refuse("DATABASE_URL is not a parseable URL");
  }
  // URL keeps brackets around IPv6 literals ("[::1]"); strip for comparison.
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    refuse(`DATABASE_URL host "${host === "" ? "(empty)" : host}" is not local`);
  }
}
