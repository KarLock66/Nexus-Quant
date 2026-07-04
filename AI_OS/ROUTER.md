# ROUTER — What To Do Next

Evaluate top-to-bottom at session start (after reading CHECKPOINT.md + TASK.md)
and after every completed step. First matching rule wins.

```
IF TASK.md status is IN PROGRESS:
    → continue the task
      (resume at CHECKPOINT.md "Current Step"; execute TASK.md "Next Action")

IF TASK.md status is COMPLETED:
    → pull the highest-priority item from BACKLOG.md
      (HIGH-1 first; move it into TASK.md with a fresh step list,
       set status IN PROGRESS, delete it from BACKLOG.md)

IF code changed since the last REVIEW.md entry:
    → review the changes
      (add/refresh a REVIEW.md entry: findings, risks, approval status;
       use /code-review for substantial diffs)

IF review status is ❌ REJECTED:
    → return to execution
      (convert each rejected finding into unchecked steps in TASK.md,
       set status back to IN PROGRESS, route to rule 1)
```

## Tie-breakers & guards

- Only **one** task lives in TASK.md at a time. New user requests that aren't the
  active task go to BACKLOG.md (priority per user) unless the user says "switch" —
  then checkpoint first, swap tasks, and park the old task at the top of BACKLOG HIGH.
- A task whose remaining steps are blocked by environment (e.g. needs Docker) is
  marked BLOCKED with the reason; route to BACKLOG for the next unblocked item.
- Never route around a failing verification step — fix or report, don't skip.
- Phase ordering is binding: don't pull MEDIUM (Phase 2) items while Phase 1
  acceptance items remain in HIGH.
- Before ending any session: CHECKPOINT.md must reflect reality (rule of thumb —
  if you'd be lost reading it cold tomorrow, rewrite it).
