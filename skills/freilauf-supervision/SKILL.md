---
name: freilauf-supervision
description: >
  Set up, tune and understand a Freilauf supervisor — an agent the hub starts by
  itself whenever runs are stuck, and that looks, nudges, ends, asks the
  operator one prepared question or hands a problem outside the hub. Use this
  skill when someone wants something that looks after stuck runs, wants runs
  that wait for input, forget their report, fail, die or will not merge to be
  dealt with without a human starting an agent each time, wants to write or
  improve the supervisor's prompt, or asks what a case file, a nudge
  (`<freilauf-supervisor>`), `fl-supervise`, `fl-report reply`, a parked case
  or an escalation is, or why no supervisor round started — even when the word
  supervisor is never used ("who keeps an eye on the agents at night", "that
  run has been waiting for two weeks and nobody noticed").
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
---

# Freilauf supervision

Runs get stuck: an agent waits for input nobody gives, forgets its report,
cannot merge, hesitates over something it is allowed to do, or dies. The hub
notices most of that and tells the operator — and then nothing happens until a
human looks. A **supervisor** is an agent the hub starts for exactly that
moment. It looks at each stuck run (a **case**), nudges it, ends it, asks the
operator one prepared question, or hands the problem to somebody outside the
hub (an **escalation**).

The rule everything follows: **the supervisor remembers nothing, the case file
remembers everything.** Each supervisor run (a **round**) is short and fresh;
what is known about a run lives in that run's case file. So a supervisor is
only as good as what it writes there — and as its prompt, which is most of
what this skill is about.

The contract — every command, answer, route and limit — is
`docs/supervision.md` in the Freilauf repository; escalations are
`docs/escalations.md`. This skill is the part those documents cannot say: how
to set one up so it is useful rather than a nuisance.

## Is it worth it here?

A round costs real tokens: starting one is roughly a full prompt-cache write
(tens of thousands of tokens) before any work, which is why the hub checks on a
coarse clock (every 60 minutes by default) and starts **nothing** when nothing
is due. A hub with a handful of runs a day that the operator watches anyway
gains little. A hub that runs scheduled agents unattended — overnight, for
days — gains the most: that is where a run sits in "waiting for input" for a
week and silently blocks its agent's schedule.

## Set it up

### 1. Give the supervisor a repository of its own

Every run, a round included, works in a worktree of some repository. Do not
put the supervisor into a project repository:

- its rounds take a slot there — they count against that repository's
  `max_parallel` (without being held back by it), so they crowd the real work;
- with the hub's merging switched on, a round's report goes through that
  project's finish gate, and anything it committed could end up merged there.

A small private git repository with a rule file is the right home: add it with
`../freilauf-repos/SKILL.md`, leave its merging **off**, and give the agent the
branch rule **no branch** (`branch_mode=keiner`), so a round's worktree is
throwaway. Like every repository Freilauf runs in, it needs an `origin` that
carries its base branch — every worktree is checked out from `origin/<base>` —
and a bare repository on the same machine will do. The rule file of that
repository (`AGENTS.md` / `CLAUDE.md`, committed and pushed to that origin) is a
good place for the operator's standing rules, because it stays on the
operator's machine (see step 3).

### 2. Create the agent and flag it

Create it like any agent (`../freilauf-agents/SKILL.md`, and
`../freilauf-models/SKILL.md` for the model — judgement matters more than speed
here, so pick a capable model), with:

| Field | Value | Why |
|---|---|---|
| `supervisor` | `1` (the **Supervisor** checkbox) | the one switch: only runs of a flagged agent may act on other runs |
| `prompt` | the template in `references/prompt-template.md`, filled in | see step 3 |
| `branch_mode` | `keiner` | a round changes no code |
| `expected_minutes` | about 20 | a round open longer than max(2 × interval, 3 × this) is ended by the hub |
| `schedule_kind` | `manuell` | the schedule is ignored anyway: the hub starts a supervisor, never its schedule or a flow |
| sandbox | off, unless it should only look and talk | see "What a supervisor cannot do" |

`POST /agents/edit` is a full replace: a save without `supervisor=1` unflags the
agent and supervision goes quiet. `agent-edit.py` of the agents skill keeps it.

Only one agent supervises a hub: the lowest id among the flagged, switched-on
agents in active repositories. Settings → Supervision names it.

### 3. Write its prompt from the template

`references/prompt-template.md` is a brief to the supervisor: what it is for,
how to look, when to nudge, how to ask, what to write down, how to finish. Copy
it into the agent's prompt and fill in the marked **operator blocks** together
with the operator: which repositories and agents matter most, what the
supervisor may do without asking, what it must never do without asking, who
collects escalations. Ask; do not invent standing rules — a supervisor acts on
them with the operator's authority.

Those standing rules describe the operator's projects and decisions. They
belong in the operator's own configuration — the agent's prompt on this hub,
or the rule file of the supervisor's private repository — and never in a
public repository.

### 4. Tune the clock

Settings → Supervision (all optional; empty means the default):

| Setting | Default | Raise it when … |
|---|---|---|
| interval | 60 min | rounds cost more than the stuck runs do |
| cases per round | 8 | rounds end before they get through the list |
| waiting threshold | 30 min | runs are cases while the operator is still about to answer |
| nudge limit | 3 | — lower it rather; past it the supervisor must ask or escalate |
| escalation grace | 0 min | an external resolver collects escalations and the operator should hear only of the ones it did not take |

Rounds the clock starts also need the pipeline switch on (`freilauf pipeline
on`); every round needs the agent switched on.

### 5. Check it once

1. Settings → Supervision names the agent.
2. "Start now" on the agent runs the due check by hand and starts a round —
   with nothing due, the round is told so and ends at once.
3. Open the round's page: its prompt shows the hub's case block; its report
   says what it did per case.
4. A case's page shows the **Case file** section: every look, note, nudge,
   reply, question and answer, with author and age.

## Living with it

- **Taking a run out.** A run the operator works in by hand should not be
  nudged: the single-run form has a checkbox for that, the run page a switch,
  and `fl-api -X POST /api/runs/<uuid>/supervision off=1` does the same.
- **Answering.** A supervisor's question arrives on the urgent route with a link;
  the answer is given in the run's case file (a choice button or a text) or
  with `fl-api -X POST /api/runs/<uuid>/case/answer text="…" choice="…"`. It
  makes the case due again, so a later round acts on it.
- **Parked cases.** A case looked at six times without anything changing (or
  handed to six rounds that never looked) is parked and announced once.
  Settings → Supervision lists them; the Un-park button in the case file brings
  one back. A parked case usually means the prompt lacks a rule for it.
- **Escalations** are on the Escalations page (it appears once there is a
  supervisor or an escalation) with resolve and dismiss buttons; an external
  resolver uses `docs/escalations.md`.
- **What the operator hears**, all on the urgent route and all silenced by a
  run's mute switch: a question, an escalation, a parked case, a round the hub
  had to end, and — with or without a supervisor — a run that has blocked its
  agent's schedule for more than a day. A round's own success is never
  announced; its report and the case files are the record.

## What the code does not tell you

- **A sandboxed supervisor can look and talk, not repair.** Inside a container
  it reaches the hub only through the report socket, which serves `fl-report`,
  `fl-supervise` and the run's sandbox policy: no `fl-api`, so no reviving, no repair
  runs, no reading another run's worktree. Leave it unsandboxed if it should do
  those.
- **"End" on a done run only closes its session.** Its status stays (a failed
  run becomes aborted, as with the kill button), and unmerged work stays on its
  branch and in its worktree either way; the hub tells the operator about
  unmerged leftovers.
- **Reviving a run** whose session is gone is the operator's Revive button,
  reachable as `fl-api -X POST /api/runs/<uuid>/resume text="<what to do now>"`
  (`mode=fresh` hands the record to a fresh agent instead of continuing the old
  conversation). The hub records it as the operator's, so the supervisor should
  say in a note that it did it.
- **A repair run** is an ordinary single run:
  `fl-api -X POST /api/runs repo_id=<id> harness=<id> prompt="…" branch_mode=neu branch_pattern="fix/{kurz}"`
  (a `provider` too, for a coding agent not on a subscription — see
  `../freilauf-runs/SKILL.md`). It is recorded as an ordinary run, so the
  supervisor notes its id in the case it repairs.
- **A nudge needs a live session** and lands in the agent's conversation as a
  message from the supervisor, on the operator's behalf. Outside a sandbox any
  local process could type the same tag into a session, and
  `tmux show-environment` shows a supervisor run's token to any process of the
  same user: the header is authenticated only as far as that token reaches.
- **The hub never starts a second round** while one is open, and a round
  never sees more than its cases per round; the rest wait for the next round.

## When no round starts

Check in this order:

1. Is the agent flagged, switched on, in an active repository — and the lowest
   id of those? (Settings → Supervision says which agent supervises.)
2. Is the pipeline on? (`freilauf pipeline status`)
3. Is a round still open? One at a time; one stuck past its bound is ended by
   the hub.
4. Did one start less than an interval ago?
5. Is anything due at all? "Start now" answers that: it starts a round, and the
   round's first line says what was due. Runs that ended before supervision
   was first switched on, runs the operator ended, archived runs and runs taken
   out of supervision are never cases.
6. Is `FREILAUF_SUPERVISION_OFF=1` in the hub's environment? It switches the
   clock off; the test suites set it.
