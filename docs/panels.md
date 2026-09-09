# Panels — a project's own numbers in the status sidebar

The status sidebar says how the **machine** is doing: pipeline, work in flight,
open incidents, subscription windows, tmux memory. What it could not say is how
the **work** is doing — how many findings are still open, how many tickets are
unassigned, how many tests fail. That question belongs to the project, and its
answer is different in every repository.

A **panel** is that answer: a small block in the sidebar of one repo, pushed by
the project, rendered by the hub. It can also take a value back — a field, a
choice, a switch, a button that calls the project's own command; that half is
["Controls"](#controls-a-panel-may-also-take-a-value) below.

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

Every field is optional except that there must be a `total`, at least one item
or at least one control. Two more fields live in this object and have a section
of their own below: **`controls`** (the fields the block offers) and
**`action`** (the command a press calls).

`tone` is `red | yellow | green` and colours a number, nothing else. A
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

## Controls: a panel may also TAKE a value

Everything above is a number travelling one way. The other direction was asked
for by the same operator on the same day, and about the same block: *how many
swarm workers may run at once, and how many may start per hour* are numbers that
belong right next to the number of open findings — and having to open a terminal
to change one is what makes an operator not change it.

So a panel value may carry **`controls`**: a list of fields the hub renders and
the operator uses.

```
┌─ SCHWARM ────────────┐
│ Findings         33  │
│ at once        [ 2 ] │
│ starts         [ 1 ] │
│ per       [ hour  ▾] │
│            [ Apply ] │
│ as of 14:03          │
│ applied 14:05  OK    │
└──────────────────────┘
```

**A control is data too, and that is the whole reason this fits.** The project
says *"a number between 0 and 6 called `gleichzeitig`"*; the hub decides what
that is in a 240 px column. No project ever writes an `<input>`, which is what
keeps the rail, `GET /api/panels` and this hub's CSS class names out of somebody
else's repository — the same three reasons the rows above are data, one field
further out.

### Two ways a changed value can mean something

Both exist, and they answer different questions about who OWNS the value.

| | **the hub keeps it** (`"store": true`) | **a command is called** (`action`) |
|---|---|---|
| Who holds the truth | the hub. `GET /api/panels` is where the project reads it | the project. The hub only carries the values over |
| What runs on the hub machine | nothing | the command the panel declared, as `argv`, no shell |
| What the declared `value` means | the **seed**, used until somebody sets it | the **last measurement**, always shown |
| When it is written | at once — nothing could still refuse it | only when the command exited 0 |

Prefer the first. It runs nothing, it needs no path on the hub machine, and the
project reads its own setting when it happens to need it — `fl-panel get
<panel> <control>` prints the bare value, so a shell script needs no JSON parser
anywhere near it. Reach for the second when the setting has to take effect
somewhere the hub cannot reach: a file in a repository, a systemd unit, a
database of the project's own.

They combine. A panel may store a value *and* call a command with it; the store
then happens only if the command succeeded, because "the hub holds 4" and "the
project was told 4" have to be the same statement or the panel is lying about
one of them.

### The shape

```json
{
  "title": "Schwarm",
  "total": 1,
  "controls": [
    { "key": "gleichzeitig", "type": "number", "label": "at once",
      "value": 1, "min": 0, "max": 6, "step": 1 },
    { "key": "anzahl", "type": "number", "label": "starts", "value": 1, "min": 0, "max": 99 },
    { "key": "fenster", "type": "select", "label": "per", "value": "stunde",
      "options": [ {"value": "stunde", "label": "hour"},
                   {"value": "woche",  "label": "week"},
                   {"value": "monat",  "label": "month"} ] },
    { "key": "anwenden", "type": "button", "label": "Apply" }
  ],
  "action": {
    "cwd": "/srv/checkouts/beispiel-repo",
    "argv": ["python", "schwarm/dispatch.py", "drossel",
             "--gleichzeitig", "{{gleichzeitig}}",
             "--anzahl", "{{anzahl}}",
             "--fenster", "{{fenster}}"],
    "timeout_s": 60
  }
}
```

**A control**, field by field:

| Field | For | Meaning |
|---|---|---|
| `key` | all | required; lowercase letters, digits, `-` and `_`. It is the name a `{{placeholder}}` refers to |
| `type` | all | `number`, `text`, `select`, `toggle`, `button`. Anything else is refused, never rendered as something near enough |
| `label` | all | what it is called. Defaults to the key |
| `value` | not `button` | the seed (stored controls) or the last measurement (everything else) |
| `hint` | all | one sentence about the field. Shown when the mouse is on the field or the field has focus, and tied to it for a screen reader — it does not stand there permanently, because a 240px column has no room for a third line per control |
| `store` | not `button` | the hub keeps this value; see the table above |
| `submit` | not `button` | does changing it act at once? Default **yes** for a `toggle` (a switch that needs a second click on another widget is not a switch), **no** for a number, a text or a select — those are typed and read back before they are meant, and travel when a button is pressed. A button always submits; it has no second purpose |
| `confirm` | all | a question the operator has to answer before anything happens |
| `min`, `max`, `step` | `number` | the range. Enforced in the browser AND again on the server |
| `placeholder` | `text` | the grey example inside the empty field |
| `options` | `select` | required; a list of strings, or of `{value, label}`. At most 12 |
| `tone` | `button` | `red` draws it as a dangerous action |
| `action` | `button` | a command of its own, instead of the panel's |

**An action:**

| Field | Meaning |
|---|---|
| `cwd` | **required, absolute, no default.** The directory the command runs in |
| `argv` | **required.** The program and its arguments, as a list. At most 24 elements |
| `timeout_s` | how long it may run. Default 60, at most 600 |

**`argv`, never a command string.** A placeholder is substituted *inside* one
element, so `{{n}}` and `--n={{n}}` both work and neither can ever become two
arguments. The number of arguments is decided by the producer and by nobody
else: the first value somebody types with a space, a quote or a `;` in it is
then a non-event instead of a bug nobody finds again. There is no shell
anywhere on this path, which is also why there is no `command` string form — it
could not be made safe, only made to look safe.

Besides the control keys, four names a panel knows about itself: `{{control}}`
(the key of the control that was used — the button that was pressed, or the
switch that was flipped; that is how one command can serve two buttons),
`{{panel}}`, `{{repo}}` and `{{repo_path}}`. A control of the same
name wins, so a project that really wants a control called `panel` gets its own
value.

The same things reach the command as environment variables, for a script that
prefers them there: `FL_PANEL`, `FL_PANEL_REPO`, `FL_PANEL_CONTROL`,
`FL_PANEL_V_<KEY>` per control (uppercased, `-` → `_`), and `FL_HUB_URL` — the
last one so the command can push the panel back without being told where the
hub is.

### `cwd` is required, and here is the measurement behind that

The section "Push, not pull" above is about a working checkout that was **627
commits behind `origin/main`** and did not contain the counting tool at all. A
command with a defaulted working directory would be that measurement happening
again, with a button on it: it would run wherever the hub happened to be, or in
the operator's own checkout, and it would look like it worked.

So there is no default. Point `cwd` at a checkout that is **kept current on
purpose** — the deploy checkout of the project, a clone a timer pulls, or the
directory of a tool that does not live in a repository at all. If the command
has to run against the newest code, make it fetch first; the hub will not do it
for you and will not pretend to.

### What the operator sees when they press

A button that does not say what happened is worse than no button, so every press
ends in a recorded outcome under the panel's own "as of" line:

| Line | When |
|---|---|
| *running …* | the command was started |
| *applied 14:05* + the command's last line | it exited 0 |
| *saved 14:05* | no command; the hub kept the value |
| *failed (exit 3)* + the last line it wrote | it exited non-zero |
| *no answer within 60 s* | it ran too long and was killed |
| *the command could not be started: …* | there is no such program |
| *the working directory does not exist: …* | `cwd` is not there |
| *no answer — the hub was restarted while the command ran* | it was in flight when the hub went down |

That outcome is **stored on the panel**, not shown as a passing message: it is
still there after a reload, in another tab, and for whoever looks next. The
press itself does not hold the click open — the command runs in the hub and the
line updates through the live channel when it is over.

**And this is how you tell whether a value was really taken** when the command
does not push the panel again. The `as of` line belongs to the *numbers* and
only a push moves it; the line under it belongs to the *press*. So
`applied 14:05` standing next to `as of 11:20` says, exactly: the command ran
and succeeded, and the numbers above it have not been confirmed since. The
better producer pushes the panel at the end of its command — then both lines say
14:05 and there is nothing to work out.

One command per panel runs at a time. A second press while one is running is
refused with that sentence, rather than two commands racing for one setting.

### What an unsent entry is worth

The sidebar is replaced whole every half minute and on every run event, and a
value typed or chosen into a control lives nowhere but in that page until it is
sent. So an entry nobody has sent yet is **carried across the refresh** — the
rest of the sidebar goes on saying how the machine is doing, and the field
keeps what the operator put in it, whether or not it still has the focus. Once
it has been sent successfully the panel's own value counts again, so the
browser never holds on to a difference that is over.

The one case worth knowing about as a producer: if a push moves a control's
value while somebody has an unsent entry standing in that field, the entry
still wins — it is the newer human decision — and the field says that the value
moved underneath it and names the value that was pushed. A press then sends the
operator's value, not the pushed one. If a control's value is something your
producer owns and re-pushes on a clock, that is worth remembering when it is
also something an operator sets by hand.

### Caps

At most **6 controls** per panel and **12 options** per select; a label is 40
characters, a value 200, an `argv` 24 elements of 500 characters. A sidebar
column is 240 px wide: a number, a number, a select and a button — the whole
throttle above — is four controls. A panel that wants more is a settings page,
and a page is what `href` is for.

### Security, plainly

The hub listens on `127.0.0.1` only and has no authentication. Whoever can push
a panel can already reach every other POST route on this hub and start a coding
agent with full shell access — so a panel command is **not a new risk**, and
pretending otherwise would be theatre. What is true is worth writing down
anyway:

- the command runs **as the hub's user, on the hub machine**, outside every
  sandbox;
- **no shell**: `execFile` with an argv, so nothing typed into a field can
  become a second command;
- **the command is never in the request.** A press sends values and the name of
  the button; the program comes out of the stored panel. A caller can choose
  what the values are and never what runs;
- **the values are checked before they travel**: a number against its own
  min/max, a select against its own options, a text against its length. An
  invalid value is refused with the reason, never repaired;
- `cwd` is explicit, the timeout is bounded (600 s), the output is capped, and
  there is no `detach` — a command whose outcome cannot be shown has no business
  behind a button.

### Setting one up with `fl-panel`

The compact form, for the by-hand case:

```bash
fl-panel set schwarm --repo 1 --title Schwarm --total 1 \
  --control "gleichzeitig=1:number:0..6" \
  --control "anzahl=1:number:0..99" \
  --control "fenster=stunde:select:stunde|woche|monat" \
  --control "anwenden:button" \
  --action-cwd /srv/checkouts/beispiel-repo \
  -- python schwarm/dispatch.py drossel \
     --gleichzeitig "{{gleichzeitig}}" --anzahl "{{anzahl}}" --fenster "{{fenster}}"
```

`--control` is `key=value:type:extra` — the extra is a range (`0..6`) for a
number, the choices (`a|b|c`) for a select, a placeholder for a text, and
nothing for a toggle or a button. Everything past that (a label that is not the
key, a hint, a confirmation, a step) is a JSON object instead:
`--control '{"key":"n","type":"number","label":"at once","min":0,"max":6}'` —
which is what a script writes anyway, and the reason there is no third grammar.
Everything after `--` is the command, word for word.

The hub-keeps-it way needs no command at all:

```bash
fl-panel set drossel --repo 1 --title Throttle \
  --control "n=1:number:0..6" --control "go:button" --store n
n=$(fl-panel get drossel n --repo 1)      # what the operator set
```

And a producer that already builds JSON simply includes `controls` and `action`
in what it pipes to `fl-panel set` — the shape above is what goes over the wire
either way.

`GET /api/panels?repo=<id>[&panel=<key>]` reports the controls with their
**effective** value (what the hub holds where it holds one, the pushed seed
otherwise), `stored: true|false` per control, and `action_state` for the last
press. That is what a flow condition or a skill reads.

### What did not change

A panel without `controls` behaves exactly as it did — no form, no action line,
the same block it always was. The folded **rail** draws values and never
controls; it could not do anything with a field, and it does not have to. And a
panel that carries controls but no `total` and no `items` is still a panel: "how
many workers may run" is worth its block whether or not the project also counts
something.

Two shapes are refused rather than rendered, because both read as working and do
nothing: a control list where nothing is stored and no command is declared, and
a `button` that is neither the panel's submit nor carries an action of its own.

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
