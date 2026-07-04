# AI_OS — Development Operating System

Lightweight markdown-based operating system for AI-assisted development of Nexus Quant.
These files are the **single source of truth** for session state. The repository holds
the code; AI_OS holds the *process*.

## Purpose

- Minimize token consumption (read 2–3 small files instead of scanning the repo)
- Survive interruptions (any session can resume from CHECKPOINT.md in one read)
- Maintain continuity across Claude Code sessions on a long-running project
- Keep execution disciplined: one task, explicit steps, bounded scope

## Files

| File | Role |
| --- | --- |
| `CONTEXT.md` | Stable facts: what the project is, constraints, coding rules. Rarely changes. |
| `TASK.md` | The one active task: steps, status, active files. Changes every session. |
| `CHECKPOINT.md` | Resume point: last/current/next step + recovery commands. Update before stopping. |
| `TOKEN_BUDGET.md` | LOW / MEDIUM / HIGH execution modes and their limits. |
| `BACKLOG.md` | Prioritized future tasks. Pull from here when TASK.md completes. |
| `REVIEW.md` | Findings, risks, approval status for completed work. |
| `ROUTER.md` | Decision rules: what to do next given current state. |

## Workflow

```
session start
  └─ read CHECKPOINT.md  → where am I?
  └─ read TASK.md        → what am I doing?
  └─ read CONTEXT.md     → what are the rules? (skim if already known)
  └─ apply ROUTER.md     → continue / pull from BACKLOG / review
work
  └─ execute ONE step from TASK.md at a time
  └─ tick checkboxes in TASK.md as steps complete
  └─ touch only files listed under "Active Files" (extend list deliberately)
session end (or any natural pause)
  └─ update CHECKPOINT.md (last/current/next step)
  └─ update TASK.md status
  └─ if code changed: add entry to REVIEW.md
```

## Interruption Recovery

If a session dies mid-work, the next session needs exactly two reads:

1. `AI_OS/CHECKPOINT.md` — tells you the last completed step, the in-flight step,
   and concrete recovery commands (e.g. which test to run to see current breakage).
2. `AI_OS/TASK.md` — tells you the remaining steps and active files.

Do **not** re-derive state by scanning the repository. If CHECKPOINT.md and reality
disagree (e.g. a file it mentions doesn't exist), trust reality, fix CHECKPOINT.md,
then continue.

## Claude Code Usage

- Start a session with: *"Read AI_OS/CHECKPOINT.md and AI_OS/TASK.md, then continue."*
- Default mode is **MEDIUM** (see TOKEN_BUDGET.md). Say "LOW mode" for surgical
  single-step work, "HIGH mode" for cross-cutting work.
- When asking for new work, add it to BACKLOG.md rather than expanding TASK.md —
  one active task at a time.
- Update these files with minimal diffs, same as code.
