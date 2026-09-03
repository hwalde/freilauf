# Integration: `merge_mode = 'hub'`

Read this when a repo is or becomes `merge_mode='hub'`, when changing
`merge_check` / `finish_timeout_min` / `merge_max_attempts` /
`conflict_parallel`, or when a run sits in a `blocked_*` / `unmerged_*` merge
status. Everything here is inert while the repo is `off`.

Source: `server/integrate.mjs`.

## The one rule

**No agent merges or pushes to the base branch. The hub integrates.** Agents
make branches mergeable. A run is `done` when its work is on the base branch —
not when the agent said so.

## The finish gate

`fl-report done` (and cursor's turn-end net, and the inbox replay) all land in
`handleReport()`. With `hub` mode on, the report is stored first — it is safe
from that moment whatever the agent does next — and then three questions are
asked, in this order (`decideFinish()`):

| # | question | verdict | what the agent is told |
|---|---|---|---|
| 1 | uncommitted changes in the worktree? | `awaiting_commit` | **M1** — commit or discard them, then report again. Nothing is merged, not even the committed part |
| 2 | no commits at all (`tip == base_sha`)? | `nothing` | the run closes as it always did |
| 3 | still mergeable? (`git merge-tree --write-tree --name-only origin/<base> <tip>`) | conflict → `awaiting_merge`, else `merging` | **M2** (merge `origin/<base>` yourself and resolve) / **M3** (nothing to do, stay in the session) |

The dirt check filters out what the **hub** put in the worktree — the repo's
worktree extras and the harness's hook files (`ownWorktreePaths()` /
`foreignChanges()`). The dry run touches no worktree.

The verdict lives in `runs.finish_state` — a **sub-state of `running`**, not a
new status: `NULL | checking | awaiting_commit | awaiting_merge | merging |
check_failed`. The run is still running; its terminal is writable and a human
can step in.

`fl-report` prints the hub's answer on stdout, so the text lands inside the
agent's current turn. That is why `POST /api/runs/<id>/report` must answer 2xx
even when it is refusing to finish the run — a 4xx would make `fl-report` file
the report in `inbox.jsonl` and loop.

## The check loop and the deadline

Its own 5-second timer, per run a `nextCheckAt`, interval
`nextCheckDelayMs(elapsed)`: 5 s under a minute, 15 s under five, 30 s after. At
most two git checks at a time.

The deadline is `finish_started_at + repos.finish_timeout_min` and **does not
run while the run is `waiting_help`** — there the agent is waiting for a human.
While a run has a `finish_state`, the watcher writes no `overrun`,
`soft_overrun` or `no_activity` anomaly, and a dead pane or a closed session
does not mark the run `failed`: it calls `escalate(runId, 'agent_gone')`.

## The merge itself

Serial per repo (one promise chain per `repo_id`), in
`~/agents/integrate/<repo name>` — a detached worktree the hub owns, cleaned
before every job, with the repo's **worktree extras applied** (a `merge_check`
wants the linked `node_modules` too).

1. `git merge --no-ff` — always, so every run is findable as a merge commit
2. `repos.merge_check` on the **merged result**, if set
3. `git push origin HEAD:<base>`

A rejected push is retried once from the top (somebody was faster); a second
rejection is treated as a conflict. **There is no local-only merge**: a merge
that cannot be pushed is thrown away (`reset --hard origin/<base>`) and
escalated. Only after the push does the run become `done`, does the operator
hear about it, do the other agents learn the base branch moved, and do the
`run_merged` flows fire.

No `origin` remote → `blocked_no_remote`. The hub never merges in the
operator's checkout.

## The escalation ladder

| situation | `runs.merge_status` | what happens |
|---|---|---|
| worktree still dirty at the deadline | `blocked_dirty` | **nothing merged**, incident + notification, three one-click answers on the detail page |
| conflict, or a red merge check | `resolving` → `blocked_conflict` | a conflict run, up to `repos.merge_max_attempts`; then a human |
| git / network / auth error | `blocked_error` | incident + notification; "Merge now" retries |
| no `origin` remote | `blocked_no_remote` | incident + notification |
| run ended `failed` / `aborted` | `unmerged_commits` / `unmerged_both` / `unmerged_dirty` / `nothing` | never merged automatically — named, the branch backed up to origin, the operator decides |
| merged | `merged` (+ `merged_sha`, `merged_at`) | done |
| "keep on branch" ticked | `kept_on_branch` | pushed to origin, not merged |
| operator pressed skip | `skipped_by_operator` | |

`repos.merge_max_attempts` bounds the conflict runs **per original run**;
`repos.conflict_parallel` bounds how many work at once **per repo**.

## Conflict runs

A conflict run is an ordinary single run through `startRun()` — budget gate,
title, overview row, watcher, incidents, and the same finish gate — but it is a
**tool of the integrator**, not work anybody asked for. `isResolverRun(run)` is
`!!run.resolves_run_id`, and everything below asks it:

- it works on a **fresh branch of its own**, `resolve/<short id of the
  original>` — a branch belongs to exactly one worktree and the original's
  worktree holds its own;
- **no notification of its own**, in any state — the operator hears about the
  run it works *for*;
- **no flows**, **no generated title**, **no retry button**;
- it never carries `blocked_*` / `unmerged_*` and never raises a
  `merge_blocked` incident: everything that goes wrong maps onto the original
  (`escalate(original, 'resolver_failed')`);
- **a conflict run never starts a conflict run.** That is the recursion guard;
- `repos.max_parallel` counts it but never blocks it — it starts on the manual
  path. Its ceiling is `conflict_parallel`.

Its setup — harness, provider, model, effort, skills, extra prompt — is under
Settings → Merge (`merge_resolver_*`). Model choice: `../freilauf-models/SKILL.md`.

## "Keep the work on its branch"

`runs.keep_on_branch` (per run/agent, only offered under `hub`, refused with
"no branch"). The integrator then runs a **short** version of the gate:

- the dirt check stays — a run is only over when its work is committed;
- **no dry run, no merge**; the branch is pushed to origin,
  `merge_status='kept_on_branch'`, event `branch_kept`;
- a **failed push is an escalation** — the operator wants nothing living only
  on this machine;
- it fires no `run_merged` flow and sends no "main has moved" (nothing moved),
  but still receives one;
- the agent's prompt gets the `keep` sentence **instead of** the merge rule;
- "Merge now" is still offered: it clears the flag and runs the ordinary path.

## "main has moved"

After every merge, `repos.notify_running` decides whether the repo's other
running agents are told — **M5A** urgently when the merge touched files they
have open too, **M5B** as a note otherwise. Built into the hub, not a flow: a
flow would have to be attached to every agent and a forgotten attachment is
invisible. Never sent to a run in `waiting_help` — a text typed into a session
waiting for a human is read *as* that answer.

## Nothing lives only on this machine

1. The integrator's only way out is `push origin HEAD:<base>`.
2. The operator's own commits on `<base>` are pushed by
   `pushOperatorBase()` — in the watcher pass, `hub` repos only, throttled to
   once a minute per repo, writing `repos.last_push_at`. A **push touches no
   working tree**, which is why it is the one git command the hub runs in the
   operator's checkout. Diverged → **never `--force`**: a global incident, a
   notification (**T_DIVERGED**), and a human reconciles it.
3. Work nobody merged is pushed as a branch — the run's own, or
   `run/<short id>` for a detached worktree (event `branch_backed_up`). Remote
   branches are **not** deleted after a merge.

## Recovering a stuck run

All per-run, all POST, all form-encoded:

| route | effect |
|---|---|
| `POST /api/runs/<id>/merge` | "Merge now". Optional `leftovers=commit` (stages and commits the worktree as Freilauf) or `leftovers=discard` (`checkout -- .` + `clean -fd`). Bypasses the attempt limit, but the dry run still happens. A refusal comes back with a reason |
| `POST /api/runs/<id>/merge-skip` | `merge_status='skipped_by_operator'`, closes the `merge_blocked` incident |
| `POST /api/runs/<id>/retry` | new session; `resetIntegration()` clears `finish_state`, `finish_started_at`, `merge_status`, `merged_sha`, `merged_at`, `resolver_run_id`, `followup_open` |

```bash
fl-api --status -X POST /api/runs/<run id>/merge leftovers=commit
```

Read the run's state first — `fl-api /api/runs/<run id>` carries
`finish_state`, `merge_status`, `merged_sha`, `resolves_run_id`, the events and
the incidents.

**Do not merge or push by hand in the operator's checkout to "help".** A branch
belongs to exactly one worktree, and `merge`/`checkout`/`reset` in a directory
somebody is editing is how work is lost. If the hub cannot integrate, say so
and let the operator decide.

## Follow-up reports

A finished run can report again: the operator types more work into the still-
standing session and the agent runs `fl-report done --file <report>` once more.
The **same** gate, the same integrator, the same escalation run again; the
run's *status* does not change (a `done` run stays `done`), the merge line and
the report say what the follow-up delivered, and the `run_finished` /
`run_merged` flows fire again (`rearmDispatch()`).

## Switching a repo to `hub`

1. The repo must have an `origin` remote, or every run ends `blocked_no_remote`.
2. `base_branch` must be right — worktrees start from `origin/<base_branch>` and
   that is what gets merged into.
3. Set `merge_check` only to a command that is *green on the base branch today*.
   A permanently red check turns every run into a conflict run.
4. `finish_timeout_min` is how long an agent gets to fix things after it
   reported. Too short escalates working agents; the default 15 is a reasonable
   start.
5. Keep `conflict_parallel` at `1` for a small repo where tasks touch the same
   files.
6. The change takes effect at the next report — it does not retro-fit runs that
   already finished.
