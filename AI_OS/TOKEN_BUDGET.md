# TOKEN_BUDGET — Execution Modes

Default mode: **MEDIUM**. The user can override per session ("LOW mode", "HIGH mode").
When unspecified and the task looks large, ask once — then proceed.

## Token Preservation Rules (apply in every mode)

- Repository-wide scans are **forbidden** unless explicitly required.
- First inspect only:
  - `package.json`
  - `README.md`
  - `app/` (in this repo: `apps/web`, `services/quant/app`)
  - `src/` (in this repo: the `src/` of the service/package named in TASK.md "Active Files")
- If additional files are needed, **request permission before expanding scope**.
- Minimize context consumption at all times — prefer AI_OS files, targeted reads,
  and scoped greps over exploration.

## LOW — surgical

For: one-line fixes, doc updates, single-step continuation, checkpoint updates.

- Execute **exactly one step** from TASK.md, then stop and update CHECKPOINT.md
- **No repo-wide scan** — no recursive globs/greps, no directory walks
- **Maximum two files modified**
- Read at most: CHECKPOINT.md, TASK.md, and the files named in the current step
- No new dependencies, no schema changes, no refactors
- Verification limited to the single most relevant command (one test file, not the suite)

## MEDIUM — normal development (default)

For: implementing a TASK.md step list, a module, an endpoint + tests.

- Execute up to one full task from TASK.md (multiple steps allowed)
- Targeted search only: grep/glob scoped to directories in "Active Files"
- Modify up to ~6 files, all within the active service/package
- Run the relevant test suite + typecheck for the touched workspace
- New files allowed if the architecture already names them; no new top-level dirs
- Update TASK.md checkboxes and CHECKPOINT.md when done

## HIGH — cross-cutting

For: phase kickoffs, schema migrations, multi-service features, reviews of large diffs.
Requires explicit user opt-in.

- Repo-wide search permitted where genuinely needed (still prefer scoped)
- May modify files across multiple services/packages, plus Prisma schema + events
- Full verification: `pnpm build`, `pnpm typecheck`, all touched test suites
- Must still respect CONTEXT.md constraints (no architecture redesign, minimal diffs
  per file, no gate-chain bypass)
- Must end with updated TASK.md, CHECKPOINT.md, and a REVIEW.md entry

## Universal rules (all modes)

- Never read `node_modules/`, `.turbo/`, `__pycache__/`, `pnpm-lock.yaml`
- Prefer reading AI_OS files over re-deriving state from the repository
- If a step balloons past its mode's limits, stop, checkpoint, and report — don't
  silently escalate modes
