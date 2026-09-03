# The finish gate and the integration ladder

Read this when a run reported `done` but will not close, when `merge_status`
says `blocked_*`, when a "conflict run" appears that nobody started, or when you
need to know where a finished run's commits ended up.

All of it is `server/integrate.mjs`, and **all of it is off unless the repo says
`merge_mode='hub'`** (`fl-api /api/repos` shows it per repo). With `merge_mode
= 'off'` a `done` report simply closes the run, exactly as it always did.

The rule the whole thing exists for: **no agent merges or pushes to the base
branch.** Agents make branches mergeable; the hub integrates.

---

## The finish gate

A `done` report is checked, not believed. In this order:

1. **Uncommitted changes in the worktree?** → `finish_state='awaiting_commit'`.
   Dirt outranks everything — nothing is merged while the worktree is dirty, not
   even the committed part. The agent is told to commit or discard, and to run
   `fl-report done --file <report>` again.
2. **No commits at all** (`tip == base_sha`) → nothing to merge; the run closes
   and says so (`merge_status='nothing'`).
3. **Still mergeable?** A dry run with
   `git merge-tree --write-tree --name-only origin/<base> <tip>` — it touches no
   worktree. A conflict means `finish_state='awaiting_merge'` and the agent is
   told to `git fetch origin && git merge origin/<base>`, resolve, commit and
   report again.

`finish_state` is a **sub-state of `running`**, not a status. While it is set,
the run is still running: its terminal is writable, messages reach it, a human
can step in — and the watcher writes no overrun / no-activity anomalies for it,
because it is waiting on purpose.

The answer reaches the agent because `fl-report` **prints the hub's `message`**
on stdout, which puts it into the agent's running turn. Where there is no call
to answer (cursor's turn-end detection, the `inbox.jsonl` replay) the same text
is typed into the tmux session instead.

The check loop runs on its own 5-second timer (backing off to 15 s after a
minute and 30 s after five), at most two git checks at a time. The deadline is
`finish_started_at + repos.finish_timeout_min`, and it **does not run while the
run is `waiting_help`** — there the agent is waiting for a human.

### `finish_state` values

`checking`, `awaiting_commit`, `awaiting_merge`, `merging`, `check_failed`
(the repo's `merge_check` command failed on the merged result). NULL = not in
the gate.

---

## The merge itself

One queue per repo, in `~/agents/integrate/<repo>` — a detached worktree that
belongs to the hub, with the repo's worktree extras applied. Never in the
operator's checkout: git refuses to push into a checked-out branch, and
`merge`/`reset` in a directory somebody is editing is how work gets lost.

Then `git merge --no-ff` (always, so every run is findable as a merge commit),
the optional `repos.merge_check` on the merged result, and
`git push origin HEAD:<base>`. A rejected push is retried once from the top;
a second rejection counts as a conflict.

**There is no state "merged, but only locally."** A merge that cannot be pushed
is thrown away (`reset --hard origin/<base>`) and escalated. Only after the push
does the run become `done`, does the operator hear about it, do the other
running agents of the repo learn that the base branch moved, and do the
`run_merged` flows fire.

---

## `merge_status`, and what to do about each

| value | meaning | your move |
|---|---|---|
| `merged` | on the base branch; `merged_sha` says where | nothing |
| `merging` | in flight | wait |
| `resolving` | a conflict run is working on it | wait; it has its own row in the overview |
| `kept_on_branch` | `keep_on_branch` was set: pushed to origin, deliberately not merged | `POST /api/runs/<id>/merge` merges it after all |
| `nothing` | the run committed nothing | nothing |
| `blocked_dirty` | worktree still dirty | `/merge leftovers=commit` or `/merge leftovers=discard`, or fix it by hand |
| `blocked_conflict` | conflicts, and the attempt limit is used up | resolve by hand, then `/merge` |
| `blocked_error` | git / network / auth failure | fix, then `/merge` retries |
| `blocked_no_remote` | the repo has no `origin` | add one; the hub never merges in the operator's checkout |
| `skipped_by_operator` | `/merge-skip` was used | nothing |
| `unmerged_commits` / `unmerged_dirty` / `unmerged_both` | the run ended `failed`/`aborted` — never merged automatically, but **named and backed up** as a branch | the operator decides: `/merge`, `/merge leftovers=…`, or `/merge-skip` |

Every `blocked_*` also opens a `merge_blocked` incident, which is in the "Needs
you" group and does not resolve itself.

### Doing it by hand

```bash
fl-api -X POST /api/runs/<uuid>/merge                      # dry run + merge + push
fl-api -X POST /api/runs/<uuid>/merge leftovers=commit     # commit the leftovers first
fl-api -X POST /api/runs/<uuid>/merge leftovers=discard    # throw the leftovers away
fl-api -X POST /api/runs/<uuid>/merge-skip                 # give up; closes the incident
```

`/merge` bypasses the attempt limit (the operator has decided) but **still runs
the dry run**, because the base branch may have moved since the run was blocked.
It also clears `keep_on_branch`. Still dirty afterwards → `blocked_dirty` and an
error, nothing is merged. `leftovers=commit` commits in the **agent's** worktree
as `Freilauf <Freilauf@localhost>` — never in the operator's checkout.

---

## Conflict runs

When the dry run conflicts, the hub starts an ordinary single run to fix it:
same start path, budget gate, worktree, session, watcher and finish gate. It
works on a **fresh branch** `resolve/<short id>` (a branch belongs to exactly
one worktree, and the original's worktree still holds its own), up to
`repos.merge_max_attempts` times, bounded by `repos.conflict_parallel` per repo.

Recognise one by `resolves_run_id` being set on the row. It is a **tool of the
integrator**, not work anybody asked for, so almost everything is off for it:

- no notification of its own — the operator hears about the run it works *for*;
- no flows, no generated title (it is called `Resolve conflicts: <original>`);
- never `blocked_*` or a `merge_blocked` incident of its own — every failure is
  mapped onto the original run;
- **no conflict run ever starts a conflict run** — that is the recursion guard;
- no retry button: the way back in is `/merge` on the **original**, which starts
  a fresh one with a fresh branch.

If you are asked to look at "the run that failed", check `resolves_run_id`
first: the useful run is the one it points at.

---

## `keep_on_branch`

For a long-lived branch (a documentation branch, a spike, an agent working the
same branch for a week). Only under `merge_mode='hub'`, and refused with
`branch_mode=keiner`. The integrator then runs a **short** version of the gate:

- the dirt check stays — a run is only over when its work is committed;
- **no dry run, no merge**; the branch is pushed to origin,
  `merge_status='kept_on_branch'`, event `branch_kept`;
- a failed push is an escalation, like a merge that cannot be pushed: nothing
  may live only on this machine;
- the agent's prompt gets the "keep" sentence instead of the merge rule;
- `/merge` still works later — keeping the work on its branch is what happened
  automatically at the end of the run, not a verdict for all time.

---

## After a merge

Every other **running** agent of the repo is told that the base branch moved —
urgently when the merge touched files it is working on too, as a note otherwise.
Deliberately not sent to a run in `waiting_help`: a text typed into a session
that is waiting for a human's answer is read by the agent **as** that answer.

The `run_merged` flow trigger fires once per integration, on the original run,
and hangs on the **repo**, not on an agent — its way in is the repo form.

Remote branches are not deleted after a merge: visible history is cheaper than
an accidental deletion.
