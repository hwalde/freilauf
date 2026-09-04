# Panels — a project's own numbers in the status sidebar

The status sidebar says how the **machine** is doing: pipeline, work in flight,
open incidents, subscription windows, tmux memory. What it could not say is how
the **work** is doing — how many findings are still open, how many tickets are
unassigned, how many tests fail. That question belongs to the project, and its
answer is different in every repository.

A **panel** is that answer: a small block in the sidebar of one repo, pushed by
the project, rendered by the hub.

```
┌─ STATUS ─────────────┐
│ Findings         33  │
│    17  bug           │
│    16  task          │
│     2  blocked       │
│ from `befund.py`     │
│ as of 14:03          │
└──────────────────────┘
```

Nothing about any project is in Freilauf's code, and nothing about Freilauf has
to be in the project: the seam is one HTTP call carrying a small JSON object.

## The shortest possible version

```bash
fl-panel set findings --total 33 --item "bug=17:red" --item "task=16" --title Findings
```

Or, when a tool of the project already prints the numbers as JSON:

```bash
register/befund.py zaehl --json | fl-panel set findings --title Findings
```

Inside a run nothing has to be configured — `FL_RUN_ID` and `FL_HUB_URL` are in
the session and the run knows its repository. Outside one, name the repo:
`--repo <id>` (`fl-api /api/repos` lists them).

## Push, not pull — and why

Freilauf does not fetch these numbers, and that is a decision with a measurement
behind it. On the machine this was built on, the operator's working checkout of
the pilot repository was **627 commits behind `origin/main`** and did not
contain the counting tool at all. The hub merges into `origin/{base}`; a working
checkout learns of that only when a human runs `git pull`. A panel that counted
there would have shown a days-old number on every page, looking current — the
exact staleness this project has been caught by before.

The producer, on the other hand, is in the right place by construction:

| Producer | When it pushes | Why it is right |
|---|---|---|
| **a run itself**, right before it reports done | at the end of its work | the platform rules make it merge `origin/{base}` into its branch before reporting, so its worktree is the truth — and `FL_RUN_ID` means it needs no arguments at all |
| a **`run_merged` flow** with a `shell_command` step | after every merge into the base branch | the moment the number changed |
| a cron flow, a systemd timer, a git hook | on its own clock | for numbers that change without a merge |
| anything at all, over HTTP | whenever | a remote system, a CI job, another machine |

**Where a flow step runs matters more than it looks.** `shell_command` defaults
its `cwd` to `{{trigger.run.repo_path}}` — the operator's own checkout, which
is exactly the one that may be hundreds of commits behind. Use
`{{trigger.run.worktree}}` and fetch first, or point it at a checkout that is
kept current on purpose.

A number that changes a handful of times a day does not want a two-minute poll:
that would ask 720 times for a value that moved five times, and each of those
asks would run somebody's script on the hub machine.

## The value

`POST /api/panels`, form-encoded, exactly like every other write route on this
hub:

| Field | Meaning |
|---|---|
| `key` | which panel — lowercase letters, digits and dashes; a repo carries at most six |
| `repo` | the repo id. Or `run=<run id>`, and the repo is the run's — that is what `fl-panel` sends inside a run |
| `value` | the JSON below |
| `error` | instead of (or next to) a value: the measurement failed. See below |
| `ttl` | minutes after which the reading is shown as outdated. Omitted = never |
| `source` | free text, for the record. `fl-panel` fills in `run:<id>` inside a run |
| `remove=1` | forget this panel |

```json
{
  "title": "Findings",
  "total": 33,
  "tone": "yellow",
  "href": "https://example.test/findings",
  "note": "from `befund.py zaehl` — [the register](https://example.test/register)",
  "items": [
    { "label": "bug",  "count": 17, "tone": "red" },
    { "label": "task", "count": 16 },
    { "label": "blocked", "count": 2, "href": "/runs" }
  ]
}
```

Every field is optional except that there must be a `total` or at least one
item. `tone` is `red | yellow | green` and colours a number, nothing else. A
`href` is followed only when it is an `http(s)://` URL or a path on this hub — a
filesystem path inside the repository is dead in a browser and is dropped.

`GET /api/panels?repo=<id>` reads them back, with the state and the age of each
reading — that is what a skill, a flow condition or a later statistic asks.

## Three states, and the difference between the last two matters

| State | What it looks like | When |
|---|---|---|
| `fresh` | the numbers, and the time they were measured | a push, inside its TTL |
| `stale` | the same numbers, dimmed, "outdated — as of 09:12" | past the TTL the producer declared |
| `error` | the same numbers, dimmed, and the reason | the last push carried an `error` |

A producer that cannot measure should **say so** rather than stay silent:

```bash
register/befund.py zaehl --json | fl-panel set findings \
  || fl-panel error findings "the register tool is not on this branch"
```

The last numbers stay on the screen either way — an operator who is shown
nothing has lost the information that was already there — but they stop
presenting themselves as current. A panel that quietly keeps showing an old
number is the one failure mode this whole design is about.

## Data, never markup

A panel delivers numbers and labels; the hub renders them. Not out of fear of an
attacker — whoever can push here can already reach every other POST route on
this hub — but for three duller reasons that outlive any threat model:

- the folded sidebar's **rail** draws dots and bars out of *values*; it can do
  nothing with a fragment of HTML;
- `GET /api/panels` is what a skill or a flow reads, and **a number can be
  compared, alerted on and drawn** while HTML can only be pasted;
- markup would freeze this hub's own CSS class names into a contract with code
  nobody here can see.

The freedom that costs nothing is given back instead: `href` on the headline and
on any row, and a `note` in a Markdown subset the hub renders itself —
`**bold**`, `` `code` `` and `[text](url)`. Everything else in a label or a note
is shown as the text it is.

The caps: at most 8 rows, 40 characters per label, 200 per note, 6 panels per
repo. A sidebar column is 240 px wide; anything past that is not a panel but a
page, and a page is what the `href` is for.

## The counting rule stays in the project

Freilauf never learns what a "finding" is, and it must not. The pilot project's
register documents its own trap: `grep -c '[BUG]'` counts marker *occurrences*
including prose that merely mentions a marker, and reported 18 where the correct
entry-based count was 16. That rule lives in one script in that repository,
changes with that project, and reaches the hub only as a number.

Which is also why a panel value carries the **time it was measured** and not a
promise about the future. The hub renders what it was told, says when, and says
so plainly when nobody has confirmed it since.

## Setting one up, end to end

1. **A command in the project that prints the JSON above.** If a tool already
   counts, give it a `--json` flag rather than parsing its prose.
2. **Try it by hand once:**
   `your-tool --json | fl-panel set findings --repo <id> --title Findings`
   The sidebar shows it immediately (the live channel carries a `panel` event).
3. **Hang it on the moment it changes.** The cheapest answer is a line in the
   repo prompt telling every run to push before it reports — inside a run
   `fl-panel set findings` needs nothing else. The other is a flow with the
   `run_merged` trigger and one `shell_command` step:
   `cwd = {{trigger.run.worktree}}`, command
   `git fetch origin -q && your-tool --json | fl-panel set findings --repo {{trigger.run.repo_id}}`
   ([server/flows/AGENTS.md](../server/flows/AGENTS.md) has the step contract).
4. **Decide about `--ttl`.** A value pushed on merge needs none: it is correct
   until the next merge. A value pushed by a timer should declare one, so a
   timer that dies is visible instead of silent.
