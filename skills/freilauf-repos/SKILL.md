---
name: freilauf-repos
description: >
  Manage the git repositories Freilauf runs agents in — list them, create one,
  change its base branch, repo prompt, worktree extras, parallelism or merge
  mode. Use this skill when someone asks to add a project to the hub, says a
  repo is missing from the dropdown, wants a `.env` or `node_modules` inside
  every worktree, wants instructions that apply to every run of one project,
  wants Freilauf to merge finished work into main (or to stop doing that), wants
  a project put away, deactivated or reactivated, asks to delete or rename a
  repo, asks how many runs a project may do at once, or asks where worktrees
  live on disk — even if the word "Freilauf" is never used.
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
---

# Freilauf repositories

A **repo row** is the operator's own git checkout. Every run gets its own
`git worktree` under it, so runs never fight over the checkout. Agents, runs,
flows and the integrator all hang off a repo.

Read this whole file before changing a repo. Read
`references/integration.md` **when — and only when — `merge_mode` is or becomes
`hub`**, or when a run is stuck in a merge state.

## The routes, in full

| What | Route |
|---|---|
| list repos (JSON) | `GET /api/repos` |
| list repos (page) | `GET /repos` |
| create form | `GET /repos/edit` |
| edit form | `GET /repos/edit?id=<id>` |
| **write** (create) | `POST /repos/edit` |
| **write** (update) | `POST /repos/edit?id=<id>` |
| suggest worktree extras | `POST /api/repos/extras-suggest` (body: `path`) |
| **deactivate / activate** | `POST /repos/toggle` (body: `id`, optional `active=1\|0`) |
| delete | `POST /repos/delete` — **exists, and is not yours to call.** See "Deleting" |

There is exactly **one** write route for the repo's fields, and it takes the
*whole* form. See "Editing overwrites everything" before you POST.

## Listing

```bash
fl-api /api/repos
```

```jsonc
{ "ok": true, "repos": [
  { "id": 1, "name": "my-project", "path": "/home/<user>/projects/my-project",
    "base_branch": "main",
    "worktree_extras": "[{\"path\":\".env\",\"mode\":\"copy\"}]",
    "extras": [ { "path": ".env", "mode": "copy" } ],
    "prompt": null, "created_at": "2026-01-02 10:00:00",
    "merge_mode": "off", "merge_check": null,
    "finish_timeout_min": 15, "merge_max_attempts": 2, "conflict_parallel": 1,
    "notify_running": 1, "max_parallel": 0, "last_push_at": null,
    "active": 1 } ] }
```

`fl-api /api/repos active=1` lists only the active ones — which is what every
repo dropdown in the UI shows. See "Deactivating a repo".

`worktree_extras` is the raw stored text; `extras` is the same thing parsed —
use `extras`. Ordered by `name`.

**If `/api/repos` answers 404, the running hub predates the read-only JSON API.**
That is a deploy problem, not a wrong path — `GET /repos` (HTML) still works.

## Creating and editing

`POST /repos/edit` (create) or `POST /repos/edit?id=<id>` (update),
form-encoded. The complete body:

| field | required | default | rule |
|---|---|---|---|
| `name` | yes | — | must be non-empty. **Globally unique** (see gotchas) |
| `path` | yes | — | the main checkout. A leading `~` is expanded. **`<path>/.git` must exist** |
| `base_branch` | no | `main` | empty falls back to `main` |
| `prompt` | no | `NULL` | the repo prompt; trimmed, empty → `NULL` |
| `worktree_extras` | no | `[]` | JSON, see below |
| `merge_mode` | no | `off` | anything other than the literal `hub` is stored as `off` |
| `merge_check` | no | `NULL` | shell command; trimmed, empty → `NULL` |
| `finish_timeout_min` | no | `15` | integer ≥ 1 |
| `merge_max_attempts` | no | `2` | integer ≥ 0 |
| `conflict_parallel` | no | `1` | integer ≥ 1 |
| `notify_running` | no | `1` | checkbox: `1`/`on` = yes, anything else = no |
| `max_parallel` | no | `0` | integer ≥ 0, `0` = unlimited |

For the numeric four, an **empty string means "use the default"**, not `0` — but
a non-integer or an out-of-range number is a *problem*, not a fallback.

```bash
# create
fl-api -X POST /repos/edit \
  name=my-project path='~/projects/my-project' base_branch=main \
  worktree_extras='[{"path":".env","mode":"copy"},{"path":"node_modules","mode":"link"}]'

# change one thing on repo 3 — but see "Editing overwrites everything"
fl-api -X POST '/repos/edit?id=3' name=my-project path=~/projects/my-project \
  base_branch=main max_parallel=2
```

### What the response looks like

- **Success → HTTP 303** (redirect to `/repos`) with an empty body. `fl-api`
  exits **1** on a 303 because it is not 2xx. That is not a failure. Confirm
  with `fl-api --status -X POST …` and then re-read `fl-api /api/repos`.
- **Validation failure → HTTP 400** and an **HTML** problem page listing the
  problems. There is no JSON error shape here; grep the HTML for the sentences.

The exact problem sentences, so you can recognise them:

| trigger | text |
|---|---|
| `name` empty | `Name is missing.` |
| `path` empty | `Path is missing.` |
| no `.git` under `path` | `No git repository at {path} (.git missing).` |
| `worktree_extras` not JSON | `Worktree extras are not valid JSON: {err}` |
| extras wrong shape | `Worktree extras: expected a list of {"path": "…", "mode": "copy"\|"link"}.` |
| bad number | `{field}: a whole number of at least {min} is expected.` |

### Editing overwrites everything

`POST /repos/edit?id=<id>` runs one `UPDATE` over **all twelve columns**. A
field you do not send is not "left alone" — it is written with its default:
an omitted `prompt` becomes `NULL`, an omitted `worktree_extras` becomes `[]`,
an omitted `merge_mode` becomes `off`.

So: **`GET /api/repos`, take the row, and send every field back**, changing only
what you mean to change. `notify_running` is the one exception with a trap of
its own — the HTML form ships a hidden `notify_running=0` *before* the
checkbox, because an unchecked box is simply absent from a POST body and
"absent" would otherwise be indistinguishable from "not mentioned". When you
POST by hand, send `notify_running=1` or `notify_running=0` explicitly.

## Deactivating a repo — the reversible way to put one away

`repos.active` (0/1, `1` for every repo that existed before the column) is what
"I am done with this project for now" looks like. It is the answer to almost
every "can you remove this repo" — reversible, loses nothing, and one call:

```bash
fl-api -X POST /repos/toggle id=<id> active=0     # deactivate
fl-api -X POST /repos/toggle id=<id> active=1     # activate again
fl-api -X POST /repos/toggle id=<id>              # flip, whichever it was
```

Send `active` explicitly whenever you know which state you want. The flip is
for a button, not for a script: two scripts flipping the same repo end up
where they started.

Like `/repos/edit`, this is a page action: **success is a 303**, so `fl-api`
exits 1 because a redirect is not 2xx. That is not a failure — confirm with
`fl-api --status -X POST …`, or just re-read `fl-api /api/repos`. An unknown
`id` is an HTML 400 problem page.

**What deactivating does** — know all of it before you offer it:

| | |
|---|---|
| **gone from every repo dropdown** | the header switcher and the Quick-Run dialog (one list feeds both), the "move this run to another repo" select on a run's page, the agent-move target, the tmux-cleanup settings, and the flow designer's repo field. The single-run and agent forms have no dropdown of their own — they take the repo from the header switcher, which is filtered, so an inactive repo cannot be reached from them either |
| **no new work starts** | the scheduler skips its agents (a `schedule_skipped` event says why), a planned single run is not picked up, and a *manual* start is refused with a readable problem naming the repo |
| **history stays reachable** | an explicit `?repo=<id>` still renders its overview, its archive, its run detail pages and the sidebar. Only the *fallback* — which repo you get when you name none — skips an inactive one |
| **nothing is deleted** | not one row, not one file. Runs, agents, reports, events and incidents are all still there, and activating it again restores exactly the state it had |
| **still visible on `/repos`** | marked inactive, with the button to bring it back |
| **runs already in flight are not stopped** | deactivating is about what starts next. Abort them yourself if that is what you meant |

`fl-api /api/repos` shows `active` on every row and takes a filter:
`active=1` (only active), `active=0` (only inactive), omitted = all. **The
dropdowns show only the active ones, so a repo missing from a form while
`/api/repos` still lists it is almost always an inactive repo, not a bug.**

## Deleting: only a human, only in the UI

`POST /repos/delete` exists. **Do not call it, and do not help anybody call it
from a script.** When someone asks you to delete a repo, say what is below and
hand the job back:

> Deleting a repository is only done in the Freilauf UI, on the **Repos** page:
> the row's delete button opens a confirmation that lists exactly what will be
> lost and makes you type the repo's name. I can deactivate it for you instead —
> that hides it from every dropdown, stops new runs, and loses nothing.

Three reasons that is the rule and not timidity:

1. **It is irreversible and it takes the history with it.** The row, its agents,
   its runs, and every event, report and incident hanging off those runs. There
   is no archive and no undo.
2. **The hub has no authentication.** Anything reachable from `fl-api` is
   reachable by any process on the machine, including a coding agent that
   misread an instruction. The route therefore requires `confirm` to equal the
   repo's exact name — a fence against exactly this, and one you should not
   walk around by looking the name up.
3. **The dialog is the feature.** It reads the real counts out of the database,
   names the paths that stay behind, and offers deactivating instead. A script
   call skips the one part that makes the decision an informed one.

What deletion leaves alone, so you can answer the question without calling it:
the **git checkout at `path` is never touched**; the worktrees under
`~/agents/worktrees/<name>/` and the run directories under
`~/agents/runs/<id>/` stay on disk; a `run_merged` flow that was scoped to that
repo survives and simply never fires again. It is also **refused while any run
of the repo is still `running`, `waiting_help`, `scheduled` or `deferred`** —
so "delete it" on a busy repo is a "finish or abort those runs first" in any
case, which is another good reason to deactivate instead.

And the two ordinary alternatives, which are often what was actually meant:
**rename it** (`name`) or **point it at a different checkout** (`path`). Both
are plain edits. Renaming changes where new worktrees go — see gotchas.

## What each column does at runtime

| column | read where | effect |
|---|---|---|
| `path` | `makeWorktree()`, every git call | the main checkout. `git worktree add` runs here |
| `base_branch` | **live at launch** | worktrees start from `origin/<base_branch>`; the integrator merges into it |
| `prompt` | **live at launch** | see "The repo prompt" |
| `worktree_extras` | `applyExtras()` | see below |
| `merge_mode` | `hubMerges(repo)` | `off` = the run ends when the agent reports; `hub` = the finish gate and the integrator |
| `merge_check` | integrator | shell command run **on the merged result before the push**. A red check is treated like a conflict: the agent gets the output and must fix it. Empty = none |
| `finish_timeout_min` | finish gate | minutes the hub waits for the agent to commit/resolve after `done` before escalating. Does **not** count while the run is `waiting_help` |
| `merge_max_attempts` | escalation | how many conflict runs may try before a human is asked |
| `conflict_parallel` | escalation | conflict runs working at once in this repo. Keep `1` for a small repo where tasks touch the same files |
| `notify_running` | after every merge | send the "main has moved" message to the repo's other running agents — urgent when the merge touched files they have open, a note otherwise |
| `max_parallel` | scheduler | upper bound of running runs **for scheduled starts only**; `0` = unlimited. A manual start is **never** blocked by it (a limit that overrules a deliberate decision is a limit people work around) |
| `last_push_at` | written by `pushOperatorBase()` | **not settable from the form.** When the hub last pushed the operator's own base-branch commits to origin. Shown on `/repos` |

`base_branch`, `prompt` and `worktree_extras` are **read live, never snapshotted
into a run**. Editing them affects the *next* run — never one that is already
running or finished.

## `worktree_extras`

A git worktree contains only what git tracks. Extras are what it should *also*
have. Stored as a JSON array of `{ "path": …, "mode": "copy" | "link" }`, applied
by `applyExtras()` to **every run worktree and to the integration worktree**
(a `merge_check` like `node test/unit.mjs` wants the linked `node_modules` as
much as an agent does).

- `path` is relative to the repo root.
- `copy` → recursive copy. For small things: a `.env`, a local config.
- `link` → a **symlink** into the main checkout. For large or shared
  directories: `node_modules`, a reference tree.
- Applying is **idempotent and skipping**: an extra whose source does not exist,
  or whose destination already exists, is silently left alone.

**The pitfall that costs a day.** A `link` extra creates a symlink, and a
`.gitignore` rule written with a trailing slash (`referenz/`) does **not** match
a symlink — git then reports it as an untracked entry in every worktree.
**Write the ignore rule without the slash** (`referenz`).

The hub itself is defended against this: `foreignChanges()` /
`ownWorktreePaths()` strip the repo's declared extras (and the harness's hook
files) out of the dirt check, so a declared extra no longer makes the worktree
"dirty forever" for the finish gate or the worktree cleanup. What it still
costs, and why the rule is worth fixing anyway: the **agent** sees the entry in
its own `git status` and may commit it, and `POST /api/runs/<id>/merge` with
`leftovers=commit` runs `git add -A` in that worktree — which would commit a
symlink into the repository.

### Letting a model suggest them

```bash
fl-api -X POST /api/repos/extras-suggest path='~/projects/my-project'
```

`{ "ok": true, "extras": [...], "model": "…" }` or `{ "ok": false, "error": "…" }`
(the error is already a translated sentence). It checks the path exists and is a
git project first, lists the untracked/ignored top-level entries, asks one LLM
call which of them a worktree needs, and then **validates every path back
against the real directory** — the model cannot invent one. At most 10 come
back. It **replaces** the list; it does not merge with what is there. The model
source is Settings → Worktree extras; if that is off or has no credential the
answer is `Worktree-extras LLM is switched off, …`.

## The repo prompt

`repos.prompt` is added to **every** run of the repo — agents and single runs
alike. `repoPromptZusatz()` composes it into `prompt.md` as its own labelled
section:

```
Repository context (applies to every run of this repo):
<your text>
```

Read live at launch. Three places a rule can live, and they are not
interchangeable:

| where | scope | use for |
|---|---|---|
| the **run's own prompt** | one run | the task |
| **repo prompt** (here) | every run of one repo | this project's build command, its test command, its conventions, "never touch `vendor/`" |
| Settings → **Platform prompt suffix** | every run on the hub | operator-wide working rules |

The platform suffix is an *addition* to the platform rules, not a replacement —
it cannot delete the "report with `fl-report done` at the end" block. Keep
project rules out of it; that is what the repo prompt is for.

## Integration (`merge_mode`)

`off` is the default and means: the run ends when the agent reports `done`, and
**nothing is merged**. Whether the work reaches the base branch is the agent's
or the operator's problem.

`hub` means the hub owns integration: it checks the `done` report instead of
believing it, lets the still-living agent fix what is missing, merges in a
worktree of its own and pushes to `origin`. A run is not `done` until its work
is on the base branch.

The branch rule of a run means different things under the two modes:

| branch rule | under `off` | under `hub` |
|---|---|---|
| **none** (`keiner`) | detached worktree; changes are throwaway unless the agent pushes them itself | detached; the commits are merged into the base branch at the end. Where a name is needed (backup, conflict run) it is `run/<short id>` |
| **new** (`neu`) | a branch from the pattern; whether it reaches the base branch is up to the agent | the same branch, merged into the base branch at the end — pick it for a readable name on origin |
| **existing** (`fest`) | continue across several runs | the same, merged after **every** run — unless the run ticks "keep on branch" |

"Keep the work on its branch" (`keep_on_branch` on a run/agent) only exists
under `hub`, and is refused together with "no branch".

**Read `references/integration.md` before switching a repo to `hub`, before
changing `merge_check`, `finish_timeout_min`, `merge_max_attempts` or
`conflict_parallel`, and whenever a run sits in a `blocked_*` or `unmerged_*`
merge status.** It has the finish gate, the escalation ladder, the conflict-run
rules and the per-run recovery routes.

## Flows that hang on a repo

A `run_merged` flow fires **once per merge into a repo's base branch** and
carries exactly one filter: the repo. It is attached to the **repository**, not
to an agent — a merge may be carried by a conflict run that never belonged to
an agent — so the repo form is where it is found and created
(`mergeFlowsBlock()`), linking to
`/flows/edit?trigger=run_merged&repo=<id>`. The repo list's Integration column
shows how many there are. Everything else about flows: `../freilauf-flows/SKILL.md`.

## Where things live on disk

| path | what |
|---|---|
| `<repo.path>` | the operator's own checkout |
| `~/agents/worktrees/<repo.name>/<shortid>-<branch\|detached>` | one worktree per run. `/` in a branch name becomes `-` |
| `~/agents/integrate/<repo.name>` | the hub's own detached merge worktree, cleaned before every job |
| `~/agents/runs/<run id>/` | `prompt.md`, `report.md`, `log.txt`, `detektor.jsonl`, `inbox.jsonl` |

Overridable with `FREILAUF_WORKTREES_DIR`, `FREILAUF_INTEGRATE_DIR`,
`FREILAUF_RUNS_DIR`.

**The rule the whole design rests on: the hub never runs `merge`, `checkout` or
`reset` in the operator's checkout.** The only git command it runs there is a
`push` (`pushOperatorBase()`, throttled to once a minute per repo, `hub` mode
only, and **never** `--force` — a diverged base branch raises a global incident
and waits for a human). Everything else happens in a worktree the hub owns,
because a branch belongs to exactly one worktree and `reset` in a directory
somebody is editing is how work is lost.

## Gotchas

- **`repos.name` is `UNIQUE`, and the form does not check it.** A duplicate name
  reaches SQLite, throws, and comes back as **HTTP 500 plain text**, not a
  problem page. Check `fl-api /api/repos` for the name first.
- **The name is a directory name.** Worktrees go to
  `~/agents/worktrees/<name>/` and the merge worktree to
  `~/agents/integrate/<name>/`. Renaming a repo does not move them: existing
  worktrees are orphaned under the old directory and new ones start under the
  new one. Rename only when nothing is running, and clean the old directory by
  hand.
- **A wrong `path` is caught at save time**, by checking `<path>/.git` — but a
  path that is a git repo *and* the wrong one is not. The `~` is expanded from
  `$HOME` of the hub process.
- **A branch already checked out somewhere cannot be a run's fixed branch** —
  git grants a branch to exactly one worktree. The main checkout holds
  `base_branch`, so `branch_mode=fest` with the base branch is the classic
  case: the run forms check it (`branchWorktree()`) and refuse with the
  occupying worktree named, and `git worktree add` would fail anyway. Never
  `--force` past it — the main checkout would then carry the agent's commits as
  reverse-modifications in its working tree.
- **`max_parallel` does not stop a manual start**, an operator's "start now", or
  a conflict run. If runs keep starting past the limit, that is why.
- **Changing `merge_mode` does not retro-fit running runs.** It is read at the
  moment a report arrives, so a run that reports after the switch is treated
  under the new mode; one that already finished is not.
- **Deleting a flow, an agent or a run never deletes a repo.** Deleting a *repo*
  does take its agents and runs with it — which is why that route is the human's
  and not yours. Offer `POST /repos/toggle` with `active=0` instead; see
  "Deactivating a repo" and "Deleting".
- For any harness / provider / model / effort decision that comes up while
  setting up a repo's agents, use `../freilauf-models/SKILL.md` and
  `fl-api /api/favorites`. Nothing about the model lives on the repo row.
