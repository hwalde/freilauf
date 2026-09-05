# Freilauf

Web UI for managing autonomous coding agents (claude / opencode / hermes / cursor).
Agents run in tmux sessions, every run in its own git worktree. The hub schedules,
observes, collects reports and — optionally — notifies through a notification
plugin (Telegram ships with it).

> **No private information in this file.** Everything machine- and operator-specific
> (real ports, VPN addresses, hostnames, firewall details, certificate paths) belongs
> in `CLAUDE.local.md` — gitignored, versioned in the private sister repo
> `cc-hub-private`. Claude Code loads both files automatically. References to
> "Planung x.y" in code comments mean the internal planning document (also in the
> sister repo, not part of this repo).

## Project language

The project language is **English**: source files, comments, documentation,
SKILL.md files and commit messages. UI strings are never hardcoded — they live in
the translation files (see below). Two custom subagents guard this
(`.claude/agents/english-enforcer.md` and `.claude/agents/i18n-checker.md`);
cursor registers them as subagents too. Legacy German identifiers still exist in
older modules and are renamed opportunistically — new code must use English
identifiers.

## AGENTS.md / CLAUDE.md convention

`AGENTS.md` is the canonical instruction file (readable by every agent CLI).
Next to **every** `AGENTS.md` sits a `CLAUDE.md` containing exactly one line —
`@AGENTS.md` — so Claude Code picks up the same content via its include
mechanism. **We never write content into a `CLAUDE.md` in this project**: it is
the include and nothing else, so there is only ever one file to keep current and
the two cannot drift. Add an `AGENTS.md` anywhere, and its `CLAUDE.md` is part
of the same commit. A unit test (`test/unit.mjs`, group "Docs") enforces both
the pairing and that the CLAUDE.md contains nothing but the include.

## The public-facing documents, and who keeps them current

Six files exist for people who are not us — they are the whole first
impression, and a stale one costs more than a missing feature. They are part of
a change, not a follow-up to it:

| File | For whom | Rule |
|---|---|---|
| `README.md` | humans, English — the reference version | what the project is, why, the security model, install, tests |
| `README.zh-CN.md` / `README.de.md` | Chinese and German readers | **maintained together with the English one.** The primary audience is Chinese and American, then German — so English is the reference and the two translations follow in the same commit, not "later" |
| `SETUP_WITH_AGENT.md` | **coding agents**, English only | how the system works and how to set it up, written to be handed to an agent. Linked from the top of all three READMEs |
| `CONTRIBUTING.md` | contributors | PRs are welcome; the ground rules and the pre-submit checklist |
| `CHANGELOG.md` | anyone asking what changed | **every change that a user or operator would notice is written down there, in the same commit** |
| `ROADMAP.md` | anyone asking what is coming, English only | see below |

**The roadmap is the changelog's mirror image, and it is deliberately
incomplete.** `CHANGELOG.md` records everything a user would notice, in the
commit that changed it; `ROADMAP.md` announces only the few changes big enough
that somebody might plan around them — today that is exactly one, running
agents in a sandbox ([SANDBOX_RESEARCH.md](SANDBOX_RESEARCH.md)). It says so
about itself in its own first paragraph, because a roadmap read as a promise of
completeness turns every unlisted feature into a surprise and every unshipped
item into a broken promise. So: no dates, no version milestones (there are no
releases to hang them on), and an item that lands moves OUT of the roadmap and
into the changelog rather than being ticked off in place. It is **English
only** — the one public-facing document besides the README that a reader might
expect translated, and deliberately not, because a roadmap maintained in three
languages goes stale in two of them; all three READMEs link it and name the
language. It is also where feature requests are invited, so the GitHub issues
URL lives there and in the three READMEs.

**The changelog format**, in one sentence: it follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — the categories
Added / Changed / Deprecated / Removed / Fixed / Security — but since Freilauf
has no releases (it is deployed from `main` whenever something lands), a section
is not a version but a **day**, headed by its ISO 8601 date (`YYYY-MM-DD`),
newest at the top. So a change goes into today's section, and today's section is
created when the day's first change lands. An entry says what changed for
somebody who uses or operates the hub, not which function was renamed; a unit
test (`test/unit.mjs`, group "Docs") checks that the dates are real ISO dates in
strictly descending order, because entries written out of order is the one way
a chronology quietly stops being one.

**Keep `SETUP_WITH_AGENT.md` current.** It is the one document a stranger's
agent acts on, so it goes stale in the most expensive way — the reader is a
machine that will follow it literally. If a change touches installation, the
setup scripts, the prompt an agent receives, the plugin contracts, the flow
building blocks or the seams listed under "Make it yours", update it in the same
commit. It deliberately stays **short on internals**: it says what exists, where
to look and what to do, and points at `AGENTS.md`, `docs/plugins.md` and
`server/flows/AGENTS.md` for the depth. Details that belong in the code stay in
the code.

The three language rules together: the **UI** is trilingual (`lang/*.json`, see
below), the **README** is trilingual, and everything else — source, comments,
`AGENTS.md`, `SETUP_WITH_AGENT.md`, `CONTRIBUTING.md`, `docs/` — is English
only.

## License

CC BY 4.0 (`LICENSE`) — anyone may use, change and ship this commercially, as
long as they name the author and link back. Consequences for us: the license
section at the bottom of all three READMEs and the licensing line in
`CONTRIBUTING.md` state the same thing, and a contribution is accepted under
the same license. Do not add a differently-licensed file into the tree without
saying so next to it.

## Multilingual UI

The web UI is multilingual: **English is the default**, German and Chinese are
selectable under Settings → UI language. All UI strings go through
`server/i18n.mjs` (`t('key')`); client-side strings reach `public/hub.js` via
the injected `window.FREILAUF_I18N` catalog.

- Language files: **`lang/en.json`** (reference), **`lang/de.json`**,
  **`lang/zh.json`** — flat `key → string` maps with `{placeholder}`
  interpolation.
- **They must be maintained together**: every key added to `en.json` needs a
  translation in `de.json` and `zh.json`. A unit test enforces identical key
  sets and non-empty values.
- A missing key falls back to English; an unknown key renders as the key itself
  (never crash a page over a string).

## Architecture

```
Browser --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux sessions
(via WireGuard)    vpn-proxy.mjs           server/hub.mjs      fl-<name>-<id>
                   freilauf-vpn.service    freilauf.service    fl-oc-/he-/cu-…
                   └──── both units run from ~/agents/deploy/freilauf ────┘
                         (the deploy checkout; bin/freilauf-deploy owns it)

~/projects/freilauf  = where a HUMAN works. No service starts from it any more.

(8790/8791 are the code defaults; the real values come from ~/.config/freilauf/env.)
```

- **`server/hub.mjs`** binds firmly to `127.0.0.1` — never directly reachable from
  the network. HTTP + WebSocket terminal + scheduler + watcher run in this one process.
- **`vpn-proxy.mjs`** binds exclusively to the WireGuard address. If the firewall
  fails, nothing listens to the outside anyway. Host allowlist + origin check are the
  rebinding/CSRF fence (`FREILAUF_ALLOWED_HOSTS` in `~/.config/freilauf/env`).
- **systemd user units**: `freilauf.service` starts automatically, `freilauf-vpn.service`
  deliberately does **not** (fail-closed). Control: `freilauf on|off|status|logs`.
  Both start `%h/agents/deploy/freilauf/…` — a checkout that belongs to the hub
  alone, never the one a human edits in (see "Deploying" below).
- **Runs** are created exclusively via `bin/fl-start` (installed to
  `~/.local/bin`); agents report back via `bin/fl-report` (HTTP to the hub,
  fallback `inbox.jsonl`). All `fl-*` scripts are part of this repo (`bin/`),
  installed by `setup/02-install-scripts.sh`.
- State: SQLite at `~/.local/share/freilauf/freilauf.db`, run data in `~/agents/runs`,
  worktrees in `~/agents/worktrees`, external plugin packages in
  `~/.local/share/freilauf/plugins` (`FREILAUF_PLUGIN_DIR`). All paths can be
  redirected via `FREILAUF_*` variables — exactly that is what the test suite lives
  on, and `FREILAUF_PLUGIN_DIR` is a **test fence** as much as a setting: a suite
  that does not point it into its own sandbox loads the operator's real packages
  and stops being reproducible.

### Deploying: the service runs from its own checkout

The units used to start `%h/projects/freilauf/server/hub.mjs` — the directory the
operator and interactive coding sessions work in. So a restart loaded *whatever
lay in that directory*: half-finished edits, or the state from before the last
merge, for as long as nobody ran `git pull` there. Both happened, and the second
one is in "Pitfalls" with the hour it cost. It also contradicted the rule the
integrator is built on: `integrate.mjs` deliberately never merges in the working
checkout — but the service started out of it.

The hub therefore runs from **`~/agents/deploy/freilauf`**, and
**`bin/freilauf-deploy`** owns that directory:

- a **clone of its own** (`--init [--from <dir> | --url <url>]`), not a
  `git worktree` of the working copy: a worktree hangs on that copy's `.git`, and
  a service must not die because a human moved or re-cloned his repository.
- always **detached on a commit**, never on a branch. Nobody commits there,
  `git status` stays empty, and no local work can ever refuse a checkout.
- its own `node_modules`, installed with `npm ci --omit=dev` **only when
  `package-lock.json` changed** (its hash lives in `.deploy-lock-hash` next to
  `node_modules`, gitignored, excluded from the deploy's `git clean`). `node-pty`
  compiles natively; doing that on every deploy would turn a five-second restart
  into minutes.
- `~/.config/freilauf/env`, the database, `~/agents/runs`, `~/agents/worktrees`,
  `~/agents/integrate` and the certificates stay where they are — the hub
  resolves them from `$HOME`, and everything inside the repo (`public/`,
  `lang/*.json`, `node_modules` for the static xterm files, the flow modules
  served to the browser) from `import.meta.url`, never from the process's working
  directory. `WorkingDirectory` in the unit is therefore a courtesy, not a
  requirement: a hub started by hand from anywhere still finds its files.

`freilauf-deploy [ref]` is one path with a fence at the end:

1. `flock` — two deploys at once do not exist (`--no-wait` fails instead of
   waiting).
2. `fetch`, target = `<ref>` or `origin/<base>` (base from the hub's own DB for
   the repo named `Freilauf`, else `main`, override `FREILAUF_DEPLOY_BASE`).
3. target == what is checked out and no `--force` → `already deployed`, exit 0,
   **no restart**. A restart is not free: it kills flow runs in flight.
4. write `previous-sha`, `checkout --detach`, `git clean -fdx` (minus
   `node_modules` and the hash file), dependencies if the lockfile moved,
   `setup/02-install-scripts.sh` — so `fl-report` and `fl-start` in `~/.local/bin`
   always match the hub that is running; that used to be a step one had to
   remember. Unit files are installed only when they really differ, then one
   `daemon-reload`.
5. restart `freilauf.service`, and start `freilauf-vpn.service` again if it *was* on —
   `Requires=freilauf.service` takes it down with the hub.
6. **health check**: `curl` against `127.0.0.1:$FREILAUF_LOCAL_PORT` until it answers
   `200` (20 s), plus `systemctl is-active`. The journal since the restart is
   read and printed but is **not** a verdict of its own: the hub writes the word
   "Error" in the course of normal operation (a provider that answered badly, an
   agent that died), and a service that rolls itself back over someone else's
   log line would be worse than the problem.
7. not healthy → **rollback** to `previous-sha`, the same steps again, health
   check again. Exit 1 with `deploy of <sha> FAILED (<reason>), rolled back to
   <previous>`. Rollback also unhealthy → exit 2, and the journal with it.
8. **A notification on failure, always** — through `bin/fl-notify`, which loads
   the plugins and calls the hub's own facade, so it reaches whatever channel the
   operator configured and nothing at all when they configured none. On success
   only with `--notify`. Best effort in every direction: no `fl-notify` on the
   PATH, no channel, no network, no consequence. (It used to be a second,
   independent Telegram implementation in bash — read the bot token out of the
   database, curl the Bot API — which no facade could reach and no other channel
   could ever be added to.)

`freilauf deploy [ref]` is the front door, `freilauf restart` stays a plain restart
without a deploy, and `freilauf status` names the deployed sha and how far
`origin/<base>` has moved on (`freilauf-deploy --status`, `--rollback`).

**The sidebar prints the running sha** (`hubVersion()` in `util.mjs`,
`headerStatus()`): asked once, at the module's own directory, cached, empty when
there is no git. Deliberately no "N behind origin" — that would be a `git fetch`
on every page render.

And the flow **"Restart Freilauf after merge"** is now a single detached
`shell_command`: `sleep 3; freilauf-deploy`. It used to pull the working checkout,
branch on whether that worked and restart — three steps, of which only the first
two could ever report anything, because a step that restarts the hub kills the
process running the flow (see `server/flows/AGENTS.md`, "Restarting the hub from
a flow"). Everything that has to be checked *after* the restart therefore has to
be checked by the script, and it is: health check, rollback, notification.

### Surviving restarts: the tmux server has a unit, a lost session is resumed

Two facts were measured on this installation before any of this existed. The
hub restarted **164 times in 30 days** (every deploy is a restart), and it
survived those only because of one line — `KillMode=process` — since the tmux
server is spawned by the first run after a reboot and therefore lived in the
hub unit's cgroup; before commit 334ba06 every deploy took every agent with it.
And a **server reboot** was not survived at all: the watcher found every
session gone, aborted every run one by one ("tmux session ended", one
notification each) and opened a `tmux_gone` incident — while worktree,
`prompt.md`, log and, for claude, the whole conversation were still on disk.
`launchRun()` had six callers and none was reachable from the place that
noticed a lost session. Four pieces fix that, and each is its own rule:

**The tmux server has a unit of its own.** `deploy/freilauf-tmux.service` runs
`bin/fl-tmux-server`, which is `tmux -D`: the server in the foreground, on the
DEFAULT socket, with `exit-empty` off — measured on tmux 3.4: the process IS the
server, a server with zero sessions stays up, and `tmux attach`, `fl-attach`,
the terminal page and the e2e suite notice nothing. `freilauf.service` carries
`Wants=`/`After=` on it, so the first run after a reboot finds a server that is
NOT in the hub's cgroup. On a machine where a server already exists (spawned by
an earlier hub, or by hand) `tmux -D` cannot take the socket, so the script
**waits and adopts** it when that server exits — nothing is ever killed by
this; `freilauf status` says who owns the server right now. `fl-start` asks the
unit to start the server when it finds none (best effort: a laptop without the
unit still gets its session), `setup/03` and `freilauf-deploy`'s `sync_units`
enable it, and no deploy ever restarts it: stopping THAT unit is the reboot.
`KillMode=process` stays as the fence for the adoption stretch. `setup/03` also
runs `loginctl enable-linger`, which was in no document: without it a user's
units start at the first login, and a hub machine is the machine nobody logs
into after a reboot.

**A lost session is resumed, not aborted** (`resumeRun()` in runner.mjs, the
seventh caller of `launchRun()`). The watcher's `watchRun()` is the only
caller that decides a session was LOST: `has-session` says gone and the run is
still `running`/`waiting_help`. Every deliberate end — the kill route, the
sessions page, retention, archiving, a flow's `kill_run` — goes through
`reconcileClosedSession()` directly and aborts exactly as before; a resume
happens only for what the hub did not end itself. A run in the **finish
gate** is not resumed either: it has reported, and its agent vanishing there
is the integrator's `agent_gone` escalation as before — the leftovers are
named, and the operator's buttons decide. `resumeRun()` marks the run
(`runs.resume_pending`), retracts what the silence produced (the
`no_activity`/overrun anomalies, the same `clearAnomalies` a raised duration
uses), shifts `started_at` forward by the gap since the run's last activity
(the expected duration is about the agent's work, and a night the server spent
off is not work — the original start is in the `session_lost` event), resets
`goal_sent_at` so the watcher delivers the goal into the new session, asks the
ordinary budget gate (blocked = `deferred` with the mark kept, so the retry
resumes rather than restarts) and calls `launchRun()`. That function knows a
resume by the mark: the worktree is reused as it stands, `prompt.md` is left
alone (it is the record of the task), `base_sha` and the quota marks are kept
(the interrupted half of the work is still what the run wants merged, and the
cost's start does not move), and the CLI is launched in its **resume form** —
`fl-start --resume <id>`: claude `--resume <run id>` (the session id IS the run
id since the hub launches with `--session-id`), cursor `--resume <chat id>`
(the transcript's basename), opencode `--session <root session id>` out of its
store (a run is a session tree, and "the last session" is usually a finished
subagent) — with the continuation PASTED into the editor by fl-start's
launcher, because `--session <id> --prompt "…"` drops the text (measured
1.18.29, see Pitfalls) — a plugin whatever its `launch.resume` declares. The continuation
prompt is short and says what the worktree says: the commits since
`base_sha`, uncommitted files, the last progress reports — an agent told
"continue" without being told where it stood redoes work. **The prompt is not
optional**, and that was measured: `claude --resume <id> "<text>"` continues
with the text as the next turn, `claude --resume <id>` alone waits for input
whatever the permission mode. hermes resumes too, since 0.21: `hermes chat --in
<worktree> --resume <id> -q "<text>"`, the id out of `~/.hermes/state.db`
(`sessions.cwd` = the worktree, the same table the watcher reads for tokens),
`latest` when the store does not say — measured: the code word from the first
turn came back, and `-q` now seeds an interactive session on a TTY instead of
exiting. Only a plugin that declares no `launch.resume` is started afresh from
its original prompt, behind a header that names what it had already
committed. `resumeId(run)` on the plugin answers the id; `null` means the
same fresh start (cursor with no transcript yet).

Three fences. **A cap**: `resume_attempts`, `RESUME_MAX` (3,
`FREILAUF_RESUME_MAX`) — past it the run ends the old way (`resume_refused`
on the run, then `aborted`), because a CLI that dies at every start must not
be restarted every pass for ever; a deliberate caller (a reason other than
`session_lost` — the sandbox reconfiguration SANDBOX_RESEARCH.md plans) does
not count against it. **"Could not try" is not "tried and died"**: a launch
that fails on a resume — right after a reboot the tmux server itself may be a
beat behind — leaves the mark standing and returns `retry`; the next pass's
`retryPendingResumes()` launches again, and `verwaisteLaeufeAbschliessen()`
skips a pending run instead of failing it as an orphan. **One message per
pass, not per run** (`announceResumes()`): a reboot takes every session at
once, and six "aborted, work not merged" texts for one event was the shape the
old path had; muted runs are left out, the `tmux_gone` incident stays and
says the runs are being resumed. `runs.retry` resets both columns — a retry
is a new attempt, not a resume.

**Missed schedule slots are caught up** (`catchUpMissed()` in scheduler.mjs).
`scheduleDue()` matches the exact minute, so a hub that was off at 03:00 never
started the 03:00 agent — the next tick is a different minute. Every tick
writes `last_tick_at` (a settings row, written whether or not the pipeline is
on: it means "the hub was alive"); the first tick with the pipeline on walks
the minutes between then and now through `lastMissedSlot()` (util.mjs, pure,
asks `scheduleDue()` itself so it cannot disagree with the tick), bounded by
`schedule_catchup_hours` (Settings, default 6, `0` = off — a hub that was off
for a week must not start a week of agents), and starts each affected agent
ONCE, at its newest missed slot, with `schedule_catchup` on the run. The same
busy / inactive-repo / capacity rules as a tick (`startBlocked()`, now shared),
the same `fired` debounce. One-off schedules always caught up and still do.

**And no blind window after a start.** Watcher and scheduler were plain
30-second intervals, so after a restart a deferred run, a planned start, a
pending goal, a lost session and a missed slot were all in the database and
looked at by nobody for half a minute. `hub.mjs` runs both ticks two seconds
after listen (`FREILAUF_FIRST_PASS_OFF=1` for a test that wants none).

What the operator does before a **planned** reboot: `freilauf drain [minutes]`
— pipeline off, every running agent told in its own session to commit and
report within the window, and the command waits until nothing is working any
more (exit 1 with what is still open; `freilauf undrain` afterwards). It kills
nothing: a run that does not make it is resumed after the reboot like any
other. `SETUP_WITH_AGENT.md` carries the machine rules (unattended upgrades
are fine, `Automatic-Reboot` stays off, never stop `freilauf-tmux.service` by
hand). The flow side has its own small net for restarts: a `waiting` flow run
whose trigger run was marked dispatched at load is still resumed
(`endedRunsWithWaiters()`, see `server/flows/AGENTS.md`). What deliberately
did NOT change: a flow run caught `running` by a restart is still closed as
failed (the step in flight is not idempotent), and the cchub → freilauf unit
migration stays an operator's `freilauf-deploy --migrate`.

The e2e group "Surviving a lost tmux server" kills a stub run's session by
hand — the way a reboot looks to the watcher, never through a hub route —
and asserts the resume, the cap, and that a session the hub ends itself is
still an abort.

### The rename: this used to be called cc-hub, and the old names still answer

The project was `cc-hub` and its scripts were `cc-start`, `cc-report`, `cc-attach`,
`cc-kill`, `cc-help`, `cc-notify`, `cc-session-cleanup`, `cc-oc-sync-agents`, with
`cchub`/`cchub-deploy` as the CLI, `CCHUB_*` as every seam, `CC_RUN_ID` as what an
agent carried, `cc-` as the tmux prefix and `cchub.service` as the unit. All of it
is `Freilauf` / `freilauf` / `fl-*` / `FREILAUF_*` / `FL_*` / `fl-` /
`freilauf.service` now.

**A rename cannot reach the places those names are written down.** They sit in an
operator's `~/.config/…/env`, in a systemd unit, in a cron line, in the prompt of
a run that is working right now, in the `.cursor/hooks.json` and the claude
settings inside that run's worktree, and in the name of the tmux session it is
sitting in. And the first deploy of this code is done BY the old
`cchub-deploy`, INTO the old checkout, restarted by the old unit, with
`EnvironmentFile=~/.config/cc-hub/env`. So the release under the new name has to
run, unchanged, in the old world:

| Seam | Where the rule lives | What it does |
|---|---|---|
| environment variables | `server/env.mjs` (`env('X')`), `fl_env` in `bin/fl-paths.sh` | `FREILAUF_X`, then `CCHUB_X`, then the caller's own default. `CCHUB_CC_START`/`CCHUB_CC_REPORT` changed their whole name, so they are named aliases of `FREILAUF_START_SCRIPT`/`FREILAUF_REPORT_SCRIPT` |
| directories and the database | `server/paths.mjs` (`pick`), the same functions in `bin/fl-paths.sh` | the new path when it exists, the old one when only that exists, the new one otherwise — config dir, data dir, deploy dir, cert dir, and `freilauf.db` vs `cc-hub.db` inside whichever data dir won |
| script names | `setup/02-install-scripts.sh` | installs the `fl-*` scripts AND a one-line shim under every old name (`exec "$(dirname "$0")/fl-…" "$@"`) |
| agent-side variables | `bin/fl-report`, the opencode plugin | `FL_RUN_ID` falling back to `CC_RUN_ID`, `FL_HUB_URL` to `CC_HUB_URL`; `runner.mjs` exports BOTH pairs into a new session |
| tmux prefix | `bin/fl-harness-tags.sh` (`FL_PREFIXES`), `server/terminal.mjs` | `fl-` is what is created; `fl-` **and** `cc-` are listed, attached to, killed and opened in the terminal |
| systemd unit | `fl_unit` / `fl_vpn_unit` in `bin/fl-paths.sh` | the unit that is really **active or enabled** — not the unit file that exists, because a deploy copies the new files in long before anything enables them |

Three of those deserve the reason spelled out. **The env helper returns
`undefined`, never a default**, so `Number(env('X') ?? 60_000)` still means what
it meant — the `Number('')` entry under "Pitfalls" is exactly the trap a helper
that "helpfully" normalised would double. **`dbPath()` asks two questions at
once**, because the directory may still be the old one *and* the file inside it
may still carry the old name; creating `freilauf.db` next to a populated
`cc-hub.db` would look like a hub that lost every run it ever did. And the
**unit resolver goes by what systemd is running**, because `sync_units` installs
`freilauf.service` on the very first deploy — a resolver that went by file
existence would then restart a unit that is neither enabled nor started, and
leave the hub down.

**`setup/migrate-from-cc-hub.sh`** (also `freilauf-deploy --migrate`) is the one
explicit step that ends all of the above: it stops the old units, moves the three
directories, rewrites `CCHUB_` → `FREILAUF_` inside `env` (backup next to it,
everything else byte for byte), renames the database and the deploy log, repoints
the deploy checkout's `origin` at the renamed GitHub repository, installs and
enables `freilauf.service`, removes the old unit files, rewrites `cchub-deploy`
inside stored flow definitions, deletes the old opencode plugin file (opencode
loads every file in that directory — two of them would report every idle and
every API error twice), re-runs `setup/02-install-scripts.sh`, and starts the hub
again, switching access back on only if it was on. Idempotent, `--dry-run`, and
it **refuses rather than merges** when both an old and a new directory exist —
that is the one state a script must not resolve on the operator's behalf. What it
deliberately leaves alone: `~/agents/runs`, `~/agents/worktrees`,
`~/agents/integrate`, `~/agents/zusaetze` (never named after the product), the
operator's own checkout, and the hub's `repos` row called `cc-hub` — that row is
their checkout, and its name is theirs.

The shims and the fallbacks are for **one** transition release. A later commit
deletes `setup/02-install-scripts.sh`'s shim block, the `CCHUB_`/`CC_` halves of
the two env helpers, the old halves of `pick()`, the `cc-` prefix in
`FL_PREFIXES` and `SESSION_RE`, and the migration script itself.

## The run definition: agent and single run are the same thing

An agent and a single run differ in exactly **two** things: an agent has a name
and a schedule and can be started again. Everything else — coding agent,
provider, model, effort, prompt, branch rule, expected duration, extra skills,
attached flows —
is one and the same **run definition**, and it lives in **`server/run-def.mjs`**:

| What | Function | Used by |
|---|---|---|
| Form block (HTML) | `runDefFields(values)` | agent form + single-run form |
| Its second prompt, for the harnesses that know one | `goalFields` | both forms (see below) |
| Its setup half, on its own | `runSetupFields`, `branchFields` | favorite form, Quick-Run dialog |
| What each branch rule MEANS — label, explanation, agent sentence | `BRANCH_MODE_INFO`, `branchRuleText`, `branchContext` | `branchFields` + `launchRun` (see below) |
| Form → definition, incl. all validation | `runDefFromForm(body, problems)` | both forms + `POST /api/runs` |
| Its setup half, on its own | `runSetupFromForm(body, problems)` | favorites (see below) |
| Agent row → definition | `defFromAgent(row)` | scheduler, "start now", flows |
| Write an agent (INSERT/UPDATE) | `saveAgent(...)` | agent form + "save as agent" |
| Field list for the flow designer | `RUN_DEF_FLOW_FIELDS`, `defFromFlowProps` | `flows/steps.mjs` |
| Last used setup, **per coding agent** | `rememberRunChoice`, `lastRunChoice`, `lastRunChoiceFor` | both forms (preselection, and the reset on switching the coding agent) |
| Title + start time (single run only) | `runTitleField`, `runStartTimeFields`, `runStartFromForm` | single-run form + `POST /api/runs` |

### Agent lifecycle: delete, move, per-repo names

An agent lives in exactly one repo, and its **name is unique per repo** —
two repos may each carry an agent called "nightly". The agents table enforces
`UNIQUE(repo_id, name)`; databases from before the change are rebuilt once at
startup (`agentNameUniquePerRepo()` in db.mjs). The form reports a duplicate
inside one repo as a readable problem (`agents.name_taken`), never a 500.

Three lifecycle operations, all in `server/run-def.mjs` next to `saveAgent`:

| Operation | Function | Notes |
|---|---|---|
| Delete | `deleteAgent(id)` | NULLs `runs.agent_id` first, then drops the row — the runs survive with their definition copy and title snapshot (`POST /agents/delete`) |
| Move | `moveAgent(id, repoId)` | `UPDATE agents SET repo_id, name`; a name collision in the target repo appends a `YYYYMMDD-HHMMSS` suffix (`POST /agents/move`, page `GET /agents/move`) |
| Name free? | `agentNameTaken(repoId, name, excludeId)` | mirrors the UNIQUE constraint for validation |

And there is exactly **one** way from a definition to a running run:
**`startRun(def, { repoId, agentId, promptExtra, title, startMode, startAt })`**
in `server/scheduler.mjs` — including the budget gate (`budgetGate(harness, model,
provider)`, also used by the watcher when picking a deferred run back up).
`startForAgent(agent)` is only its wrapper for a stored definition.

`keep_on_branch` (0/1) is the newest field and went exactly that way: the form
block, `runDefFromForm`, `defFromAgent`, `saveAgent`, `createRun`,
`RUN_DEF_FLOW_FIELDS`/`defFromFlowProps`, two columns — and
`pickQuickFields`'s allowlist in web.mjs, which is the one place a field can
fall off silently because it is an allowlist and not a spread. It is
deliberately NOT part of `rememberRunChoice`: it belongs to the task, not to the
setup.

A new field of a run therefore needs **one** change in `run-def.mjs`, not four.
Before that, the copies had already drifted: the single-run form dropped the
branch mode it had been prefilled with, `POST /api/runs` saved an agent without
provider/effort/skills, only the agent form checked the branch rule, and only
the agent path knew the budget gate — a single run started into an exhausted
quota and died at the first API call instead of being deferred.

New forms/steps that start a run go through these functions. What is
deliberately **not** part of the definition: the repo (it is the context, and
the switcher in the header sets it), the name and the schedule (they make an
agent an agent).

### The weekly schedule: a day carries times, not a time

A weekly schedule used to be one time for all chosen days — "Tuesday at 08:00
**and** 11:00, Wednesday at 14:17" was only expressible as a cron expression,
which is the expert field precisely because most people should never need it.
It is now the ordinary form, and both halves of the generalization go through
**one** reader, `weeklySlots(agent)` in `util.mjs`:

| Storage | Says | When |
|---|---|---|
| `schedule_days` + `schedule_time` | the same times on every chosen day; `schedule_time` may name **several**, comma-separated (`08:00,11:00`) | the usual case, and every agent written before this existed |
| `schedule_slots` (JSON, `{"2":["08:00","11:00"],"3":["14:17"]}`) | each weekday its own times, and a weekday that is not in it does not run | the escalation, and it **outranks** the two columns |

Two storages and no drift, because nothing downstream knows which of them an
agent carries: `scheduleDue()`, `scheduleText()` and the form all read
`weeklySlots()` and get `[{day, times}]` in the order a week is read. The flat
columns stayed for the same reason `openrouter_min_eur` still holds dollars —
they are what every existing row, the read API, the agent skill and
`agent-edit.py` speak, and a migration would have bought nothing. `schedule_days`
is therefore kept filled in the per-day case too, with the days that have
times: it is what "which days does this agent run on" is read from outside
`weeklySlots()`, and NULL there would read as "none".

The form has one radio pair for it — "same times on every selected day" /
"different times per weekday" — and **only the chosen mode is stored**, exactly
as only the chosen `schedule_kind` is: leftovers from the other mode would be a
second, contradictory statement about one schedule, and the one that outranks
would silently win. In per-day mode the weekday checkboxes are gone; the grid
of seven rows IS the day selection, because a day with no time is a day that
does not run and saying that twice is how the two say different things. A time
is a chip whose value stays editable in place, `Number('')`'s cousin is fenced
off (an emptied chip means "removed", a half-typed one is a refusal, never a
silently dropped time), and a new chip starts an hour after the last one so a
second time is one click and no typing.

The repo is not just the path — under **Repos** each repo can carry its own
**repo prompt** (`repos.prompt`): instructions that are added to **every** run
of that repo, agents and single runs alike. Like `base_branch` and
`worktree_extras` it is read live at launch (`repoPromptZusatz()` in
runner.mjs composes it as a labeled section into `prompt.md`) — repo config is
not snapshotted into the run, so editing it affects the next run, never a
running or finished one.

### The goal: the second prompt, and the only one that is typed in

The prompt says what to do. A **goal** says when it is **done**: claude's
`/goal <condition>` sets a completion condition, has a small model check it
after every turn, and while it does not hold claude takes another turn by
itself — until it holds, until claude judges it impossible, or until someone
clears it. So it belongs in the run definition (`agents.goal`, snapshotted into
`runs.goal`), under the prompt, folded away, and only in the two forms that
describe a run: the agent form and the single-run form. Deliberately **not** in
Quick Run — that dialog asks for the task and the time, and a favorite carries
no task.

It is the one definition field that never reaches the agent through
`prompt.md`, because **there is no CLI flag for it**. The command exists only
inside the session, so the hub types it in **after** the start —
`server/goal.mjs`, one delivery function and two ways into it:

| Way in | When | Why both |
|---|---|---|
| `launchRun()` | right after the session stands, not awaited | it waits for the TUI to draw, and a start must not hang on that |
| watcher pass | every run that still owes its session a goal | a hub restarted between the start and the delivery, a session that had not drawn yet, a run that was answering a help call |

`runs.goal_sent_at` is what keeps the two from typing it in twice, and what
lets the detail page answer "did the goal ever arrive?". Only from status
`running`: `waiting_help` means the agent asked a question and is waiting, so a
goal typed in there would **be** the answer. A retry clears the mark — a retry
is a new session, and a `/goal` typed into the old one went with it.

**Who knows a goal is the plugin's answer, not the form's** (`goal` in the
harness plugin, see [docs/plugins.md](docs/plugins.md)). The form block writes
that list into `data-goal-harnesses`, hub.js shows or hides the block on it —
and hiding **disables** the field, because a hidden field that still submits is
a text one can neither see nor correct: switching the coding agent would
otherwise send along a condition meant for claude. What was typed stays in the
DOM, so switching back and forth does not cost it.

### Every run has a title

An agent run is recognizable by its agent — a single run is not: it is not
stored anywhere, it only exists as a prompt. So `runs.title` carries a name for
**every** run:

1. what was typed into the single-run form's title field, otherwise
2. the agent's name, otherwise
3. the first meaningful line of the prompt (`fallbackTitle`) — and in the
   background a cheap model replaces it with a real one.

The generated title **never** holds a start up: the run carries the fallback
from the first moment and `applyGeneratedTitle()` writes over it afterwards —
and only if it is still the fallback, so a rename by hand always wins over the
model. Everything about this is fail-soft (`server/title.mjs`), the exact
opposite of the check LLM: without a usable source, switched off or on any error
the run simply keeps the fallback. Source, model and on/off live under
**Settings → Run titles** — `llm_title_source` (unset = `provider:openrouter`,
which is what it always was) and `llm_title_model` (default
`deepseek/deepseek-v4-flash`, ~$0.05 per million input tokens — a title costs a
fraction of a cent). It is **not OpenRouter-only any more**: any plugin
declaring `llm` can answer, including a coding agent on a subscription that is
already being paid for.

Every run can be **renamed inline** in the overview and on its detail page
(`POST /api/runs/<id>/title`, pencil next to the title). That touches only the
run: the agent keeps its name, and its next run is called by it again. An
emptied title falls back to the agent's name.

### A single run may also start later

The single-run form carries what an agent's schedule carries — minus the
repetition, because a single run happens once. Three ways to wait, all ending
in status `scheduled` (which the CHECK rule always knew and nothing ever used):

| Kind | Stored | Started by |
|---|---|---|
| at a date and time | `start_mode='at'`, `start_at` (UTC) | `pickUpScheduled()` once the moment has passed — a missed one is caught up, like an agent's one-off schedule |
| in n minutes | the same, resolved in the form | as above |
| when no other run of this repo is going | `start_mode='idle'` | `pickUpScheduled()` as soon as the repo is free |

`pickUpScheduled()` (scheduler.mjs) runs in the **watcher** pass, not in the
scheduler tick: the pipeline switch gates the scheduled AGENT starts, and a
single run sent off by hand is not one of those — same rule as the "start now"
button. Per repo and pass exactly **one** run starts, because after the first
one the repo is not free any more. The budget gate applies as at any other
start; blocked means `deferred`, not lost. Waiting runs stand at the top of the
overview next to the deferred ones and can be cancelled on their detail page.

### Runs can be archived

`runs.archived_at` (NULL = visible) moves a finished run out of the overview —
the record, report, log and incidents stay intact and the detail page keeps
working. Only terminal statuses may go (`done`/`failed`/`aborted`): a running
one is still being watched and a deferred/scheduled one would start later
anyway, so archiving it would hide work that is not over. One click per row in
the overview (`POST /api/runs/<id>/archive`) or on the detail page; the
**Archive** page (`/archive`, per repo like the overview) lists them
newest-archived first with pagination (50 per page,
`FREILAUF_ARCHIVE_PAGE_SIZE`) and a restore button
(`POST /api/runs/<id>/unarchive`). Nothing else in the code filters on
`archived_at` — the watcher, the flows and the incidents keep their view of a
run whether it is archived or not. **One display does**, and for a reason that
is about the display and not about incidents: the sidebar's incident count is a
LINK into the overview, and no archived run is in an overview
(`openIncidents()` in pages.mjs). Measured on this installation — two open
incidents, both on runs the operator had archived, so two repos said "1 needs
you" and both clicks landed on "no runs yet". A number that promises rows nobody
can see is the same lie the run multi-select has a rule about.

**And a list is put away in one gesture, not row by row.** Forty finished runs
of which four are worth keeping were forty clicks; the overview therefore
carries a checkbox per archivable row, a bulk bar UNDER the table (where the
hand ends up after going down the list and deciding)
("select all", "Archive selected (n)") and `POST /api/runs/archive` with one
`run=<id>` field per run — the same shape the sessions page's bulk end already
had, because it is the same gesture. Four rules, each of them a way it would
otherwise go wrong:

- **Only an archivable run gets a checkbox at all.** A row still in flight has
  an empty cell, so "select all" can never promise something `archiveRecord()`
  would refuse.
- **Both routes archive through `archiveRecord()`** (web.mjs), which writes the
  record and returns the session that should go with it; the caller closes the
  sessions — one `killSessions()` call for forty runs instead of forty. Two
  copies of the "only finished runs" rule is how one of them would eventually
  archive a running run.
- **A refusal does not hold up the rest.** The answer is `results: [{run, ok,
  error}]` per run: what went is struck from the table, what did not is handed
  back to the operator with its reason. An unknown id is a refused row, not a
  500.
- **The selection lives in a Set in hub.js, not in the checkboxes.** The live
  channel replaces a row whenever its run changes and the whole tbody whenever
  a run appears — a tick that lived only in the DOM would be thrown away by
  somebody else's run starting. `syncRunPicks()` writes the selection back onto
  whatever boxes are on the page now and is called after every swap; a run that
  has left the table leaves the selection with it, because a count promising
  rows nobody can see is a lie. Same family as the rename guard next to it.

**Archiving also closes the run's tmux session** — the gesture is "put this
finished work away", and the screen it left standing goes with it. Default:
right away (Settings → Sessions → `archive_session_keep_hours`, `0` = at the
click). Two settings, two exceptions: `archive_session_on` switches the whole
rule off (an archived session then follows the ordinary retention like any
other), and `archive_session_keep_hours` gives the session a grace period
counting from `archived_at`. The close happens on two paths so a session is
never missed: the archive route kills a keep-0 session at the click
(`killSessions`, the same reconciliation the sessions page uses), and the
watcher pass `closeArchivedSessions()` closes whatever still owes one — a run
with a keep > 0, one archived while the hub was down, one from before the rule
existed. A restored run does not get its session back; a session is not
recreated.

### A run is not set in stone: duration while it runs, prompt, repo, branch rule and start time before it starts

Five things about an existing run can be changed, and the rule behind all of
them is: **whatever is read at the moment it is used can be edited until then.**
`server/run-edit.mjs` is the one place that decides what a status allows
(`runEditAllowed()`), and the "Edit this run" card on the detail page
(`runEditCard()`) renders from exactly that table — the form can never offer an
edit the endpoint (`POST /api/runs/<id>/edit`) would refuse:

| Field | `scheduled` | `deferred` | `running` / `waiting_help` | `done` / `failed` / `aborted` |
|---|---|---|---|---|
| **expected duration** | ✓ | ✓ | ✓ | — |
| **prompt** | ✓ | ✓ | — | — |
| **repo** | ✓ | ✓ | — | — |
| **branch rule** | ✓ | ✓ | — | — |
| **start time** | ✓ | — | — | — |

- **The duration is read live.** The watcher's traffic-light thresholds
  (soft_overrun at 80 %, overrun at 100 %), the metrics and the overview all
  read `runs.expected_minutes` per pass, so a new value takes effect at once —
  which is what changing it on a *running* run is for (a single run that turns
  out to need longer stops firing false alarms; one that is being watched less
  urgently stops being silent). Raising it also RETRACTS the statement the old
  value produced: `anomaly:soft_overrun`/`anomaly:overrun` go the same
  `cleared:*` way they go on a progress report (clearAnomalies in reports.mjs,
  exported for exactly this caller), and the `notified:overrun` flag with
  them — so a genuine overrun of the NEW duration can page once again. The
  running agent is deliberately NOT told: the
  minutes in its prompt are informational, and editing a session that stands
  would fight it.
- **The prompt, the repo and the branch rule are read at launch.**
  `launchRun()` reads `runs.prompt`, the repo's `base_branch`/`prompt`/extras
  and `runs.repo_id` when it starts, and `makeWorktree()` reads the branch mode,
  pattern and keep-on-branch (the agent's prompt quotes the sentence they
  produce) — so changing them moves the run's *future*, not its past. A started
  run has no way back to this — its session is already running the old text in
  a worktree of the old repo, hence the refusal.
- **"Not started" = `scheduled` + `deferred`.** Both have no session and no
  worktree, and both reach `launchRun()` eventually; a `deferred` run waits on
  quota exactly as a `scheduled` one waits on its time — same rule, same edit.
- **The start time is edited the way it was planned.** A `scheduled` run's card
  embeds the SAME block the single-run form plans one with
  (`runStartTimeFields`, prefilled with what the run currently waits for) and
  the edit goes through the SAME parser (`runStartFromForm`), so re-deciding
  the "when" cannot mean something else than the form's own reading of the same
  inputs. "at" and "in" write a new point in time, "idle" makes the run wait
  for a free repo — and "now" **starts it immediately**
  (`scheduler.startScheduledNow`, same budget gate as at any other start; a
  blocked one becomes `deferred` instead of dying). Deliberately NOT offered on
  a `deferred` run: it waits on quota, and `retryDeferred` starts it the moment
  the gate opens whatever `start_at` says — a start-time edit there would be a
  lie.
- **A prompt change re-derives a prompt-derived title.** If the run's title is
  still the fallback of the old prompt (nobody renamed it, no LLM answer
  landed), it becomes the fallback of the new one and the title LLM gets
  another chance — an operator's name or an LLM title is never overwritten.
- **Moving to the repo the run already lives in is a no-op**, not an error: the
  combined form pre-fills the select, and a duration-only edit must not fail on
  its own untouched field.
- **The card is part of the run-detail fragment**, so a status change (a
  scheduled run starts) swaps the fields by themselves; hub.js skips that swap
  while the card has focus (`#run-edit :focus`) so an edit is never thrown away
  mid-typing, and removes the card once the fragment no longer renders one. The
  schedule block inside it is driven by the same `data-start-switch` handler as
  the run form and the Quick-Run dialog — bound as **event delegation**, because
  a direct listener would die when the fragment replaces the card.

### Favorites and Quick Run: the setup without the task

Picking a coding agent, a provider, a model out of ~200 slugs and an effort level
is the half of starting a run that is the same every time and says nothing about
the task. A **favorite** (`server/favorites.mjs`, table `favorites`, Settings →
Favorites) is exactly that half under a name: harness, provider, model, serving
provider, effort — plus the two opt-ins that behave like a setting rather than
like a task, the **extra skills including their dial** and the **attached
flows**. Deliberately not part of it: prompt, branch rule, expected duration,
start time. Room for `FAVORITES_MAX` of them (3, `FREILAUF_FAVORITES_MAX`), because
a shortcut one has to read is not one.

The **Quick Run** button sits in the header of *every* page and opens a dialog
asking for what a favorite does not carry: the task and the start time, both
open, and — folded away — the branch rule. When a run happens is decided in the
same breath as what it does, so that block stands next to the task rather than
behind a click; the branch rule is the one of the three usually left as it
is. It does **not** navigate: `POST
/api/runs/quick` answers JSON, the page stays where it was and a toast says
whether the run started, was planned or was deferred, with a link to it. Being
torn to a detail page is what would make a quick start not quick.

**And it does not wait for the launch either.** The dialog used to stand still
until the run was really running, which is two to seven seconds of somebody
else's work: `git fetch` (~0.7 s), the worktree checkout (measured on this
machine — 0.5 s for a repository of 154 files, **4.1 s** for one of 16 000),
`fl-start` with its own second, and the tmux session. A quick start that holds
a modal open for that is not quick, and none of it is a question the operator
can answer. So `startRun()` takes **`detached`** (scheduler.mjs): everything
that DECIDES — the favorite, the definition's validation, the budget gate —
stays in the request, because it is milliseconds and it says whether the run
runs at all; `launchRun()` is handed back to the hub, the answer carries
`pending: true`, and the dialog closes at once. A launch that fails there ends
in `failRun()` exactly as it does when somebody waits — the caller has already
answered, so a thrown error must become the same visible `failed` row.

Three consequences, each of them the point rather than a side effect:

- **The toast follows the start to its end.** `freilaufToast()` grew a
  `pending` kind (a spinner, and it does *not* disappear by itself — a toast
  that said "starting…" and then vanished would leave the reader believing a
  start they were never told the end of) and a `replace` option, so the outcome
  lands in the line that is already there instead of stacking a second one
  under it. `verfolgeStart()` asks the run's own record (`GET /api/runs/<id>`)
  every 900 ms: `tmux_session` set means the session stands, `deferred` /
  `failed` / `aborted` say what happened instead, and the failure carries the
  first line of what `failRun()` wrote. Deliberately **polled and not driven
  off the live channel** — `/api/events` is filtered by the repo of the PAGE,
  and the dialog's own repo select may well have started the run somewhere
  else; a toast that then never resolved would be the worse failure. It costs
  two or three requests, and only while a start is in flight.
- **The page does not have to stay open.** The start runs in the hub, not in
  the browser. Closing the tab loses the toast and nothing else — and
  **`failRun()` now says so on the channel** (`notifyRun(…, 'start_failed')`,
  imported lazily and not awaited, because that function is synchronous and
  sits on the launch path). That was missing long before this change: a
  scheduled agent start has no caller at all, so a run that never got off the
  ground was a red row nobody was told about — the most expensive shape a fault
  can take, because everything above it reads as "the run is in the list".
- **The row appears immediately.** `startRun()` calls `announceRun(runId,
  'created')` right after `createRun()`. Before, the overview's first news of a
  run was its `started` event — which lands after the checkout, so a run
  started from a dialog that closes at once would have been invisible for those
  seconds. One of the few announcements not carried by an event (like the
  generated title and archiving): "the row is there" is not a transition worth
  recording.

What deliberately did **not** become detached: every other caller of
`startRun()`. The flow step that waits for a run's result, the single-run form
and the tests all have a next line that depends on the session standing, and
`detached` defaults to false so none of them noticed.

The one exit that does lead away is **More settings**: the moment one wants more
than the dialog asks, the run stops being quick. It opens the FULL single-run
form in a new window (`/runs/new?repo=…&favorite=…`): the favorite becomes the
form's template (`favoriteTemplate()` in favorites.mjs, the counterpart of
`favoriteToFormBody()`), and hub.js parks the task, the branch rule and the
start time in `sessionStorage` (key `freilauf:qrfull`) — a window opened by the
opener inherits a copy, and the form page restores the fields onto the MAIN
form before its start-time and branch syncs run. What the dialog does not ask
for stays as the favorite's template rendered it; there is still no second
definition builder involved.

There is **no second definition builder** behind any of this, which is the whole
reason a favorite stores only the setup half:

| Direction | Function | Ends in |
|---|---|---|
| form → favorite | `favoriteFromForm()` → `runSetupFromForm()` | the same validation the run form applies |
| favorite → form | `favoriteToFormBody()` | `runDefFromForm()` — the ordinary start path |

`runSetupFromForm()` is `runDefFromForm()`'s own first half (harness enabled,
provider possible for this harness, effort really accepted), and
`runSetupFields()` / `branchFields()` are the form blocks both run forms already
use. So what is saved under a name cannot come to mean something else than what
the run form would have made of the same inputs — the drift `run-def.mjs` exists
to prevent, one field further out.

The Quick-Run endpoint takes exactly four fields from the request
(`pickQuickFields`: repo, prompt, branch mode, branch pattern) and lets the
favorite fill in the rest. An allowlist and not a spread: otherwise a request
could quietly replace the favorite's coding agent, model or skills and start
something other than the name on the button promised. The e2e suite asserts
precisely that.

Two page-level consequences worth knowing: the dialog lives in `layout()`, so
the single-run form now carries the planned-start block **twice** — hence
`data-start-switch` instead of an id, scoped per fieldset. And favorites are
edited on a page of their own rather than three side by side, because the
provider/model/effort block is driven through `#prov`, `#model` and `#effort`,
and three of those would be three elements sharing one id.

## Plugin architecture: coding agents and model providers

> **The depth is one document: [docs/plugins.md](docs/plugins.md).** It is the
> reference a capable LLM is meant to be handed on its own — the full descriptor
> contract for both kinds, the injected context, the gate, `llm` and `launch`
> declarations, the storage, and how to add either. What follows here is what
> the *rest of the hub* has to know about it, and nothing that is written down
> there.

Coding agents (harnesses) and model providers are **dynamically loaded
plugins**: a descriptor object per file, collected by one mutable registry
(`server/plugins/registry.mjs`). Built-ins live where they always did —
`server/harnesses/<id>.mjs`, `server/providers/<id>.mjs`; `index.mjs` in both
folders is a front door that **re-exports the registry's own objects**, the same
identity and not a copy, which is why every importer survived the rebuild
untouched. An **external** plugin is a package directory under
`FREILAUF_PLUGIN_DIR` (default `~/.local/share/freilauf/plugins`) holding a
`plugin.json` manifest and a module with the descriptor as its default export;
`loadExternalPlugins()` registers them in `hub.mjs` *before anything reads the
registry*, because a plugin that arrives after the first form was rendered is a
plugin the operator cannot choose. One bad package never costs the hub: every
load failure is collected (`registryErrors()`) and printed on the Plugins page
instead of thrown, and a **duplicate id is refused, never overridden** — a
package calling itself `claude` must not be able to replace the coding agent the
operator's runs start with.

**What made this possible was deleting a `CHECK`.** `db.mjs` used to generate
`CHECK(harness IN (…))` on the `agents` table out of the harness registry, so
`db.mjs` imported the registry — and that import was the cycle: a coding agent
known only at runtime cannot be named in a constraint written at schema time,
plugin files were forbidden to import `db.mjs`, and the budget gate could not go
through the aggregators. `harnessCheckAufloesen()` removes the clause once and
idempotently. Nothing is lost, because the database never decided this:
`runDefFromForm()`, `saveAgent()`, `createRun()` and `saveCodingAgent()` all
validate against the registry and always did — which is also why `runs.harness`
has carried no CHECK since the beginning.

Four optional declarations are what turn a file into something an operator can
actually run with, and each of them removes a hardcoded vendor from the hub:

| Declaration | What it buys | Where it surfaces |
|---|---|---|
| `credentials` | the operator may supply an **own API key**, or name a **different environment variable** — resolved once in `credentialValue()` (stored value → named variable → the plugin's declared `envKeys`) and reached everywhere through `ctx.secret()` | Plugins page, `modelArgs()`, `balance()`, the LLM layer |
| `gate` | thresholds and a `check()` — the plugin's own budget gate | Settings → Budget gates renders it **by itself** |
| `llm` | this plugin can answer the hub's own four direct questions | the model-source pickers under Settings |
| `launch` | how to start this CLI in a tmux session — `bin/fl-start --spec` | `launchSpec()` in runner.mjs, for an external coding agent |

**A plugin is handed a context, never `process.env` or `db.mjs`.**
`pluginCtx(id)` (`server/plugins/context.mjs`) carries `json()` (fetch with a
timeout and the one `HTTP <n>` error shape), `registry()` (the cached models.dev
snapshot), `provider(id)` (another provider's descriptor), `env`, `secret()`,
`setting()` and `log()`. That single indirection is what makes an external
package work without importing anything of ours *and* makes the operator's own
credential honoured everywhere at once.

**`provider(id)` is on there because the static import was a cycle.**
`providers/index.mjs` re-exports the registry, and the registry's module body
builds `{claude, opencode, hermes, cursor}` out of the very plugin files that
would import it — so `import { getProvider } from '../providers/index.mjs'` at
the top of `harnesses/opencode.mjs` and `harnesses/hermes.mjs` made those two
files unimportable **on their own** (`ReferenceError: Cannot access 'opencode'
before initialization`). It was invisible inside the running hub, where
`registry.mjs` is always reached first, and it broke the rule
[docs/plugins.md](docs/plugins.md) and `harnesses/cli-llm.mjs` both state. The
context resolves at **call** time, after every module has evaluated; where a
context is missing and an `await` is allowed the lazy
`(await import('../providers/index.mjs')).getProvider(id)` does the same job. In
a **synchronous** method there is no third way, so `modelArgs()` without a
context uses the provider id verbatim and passes no credential — `runner.mjs`,
the only caller that launches a run, always hands one over. `test/echt.mjs`
imports every plugin file in a process of its own, because that is the only
place the cycle shows.

### Configured plugins, and where they are configured

The registry says what the hub **could** drive; **`plugin_config`** holds what
the operator has **configured** — one row per plugin, both kinds, with an
enabled flag, the allowed providers of a coding agent, the credentials and the
plugin's own settings. `coding_agents` only ever knew coding agents, so a model
provider had no place to carry an enabled flag or a key of its own; the old
table is migrated once (guarded by the settings key `plugins_migrated`) and then
**left in place untouched**, so a rollback to an earlier hub finds its data.
`server/coding-agents.mjs` survives as a byte-compatible adapter over the new
table — its call sites and both test groups never noticed.

An unconfigured **coding agent is off**, an unconfigured **provider is on**, and
that asymmetry is deliberate: a fresh installation has no coding agent and nags
until one is configured, while providers had no enable flag before this table
and inventing an off-by-default one would have switched off working
installations.

The page moved: **Settings → Plugins** (`/settings/plugins`) replaces Settings →
Coding agents, which is now a 303 redirect. One page answers the whole question
"what can this hub drive, and with whose credentials": what the startup scan
found on the machine, one card per coding agent, one per model provider, and the
external packages with their versions, paths and load errors. The optional seed
is unchanged — on first start with nothing configured the hub imports
`~/.config/freilauf/coding-agents.json` (override: `FREILAUF_AGENTS_SEED`).

**Discovery asks once.** `scanSystem()` records, for every registered plugin,
whether its CLI is on the `PATH` and whether any of its declared credential
variables is set — from `hub.mjs` after the server listens, fire-and-forget, and
again from the "Scan again" button. A **found credential is named, never read**:
the row carries the NAME of the variable and nothing else, because a discovery
row is rendered into a page and travels with a database copy. The banner above
the content shows what is worth suggesting, and answering it (Add or Not now)
writes the answer — so a dismissal stays dismissed across restarts.

### Notifications are a plugin, and they are optional

Telegram used to be wired into ~30 files: `server/telegram.mjs` plus direct
imports in reports, incidents, the watcher, the integrator, the LLM alerts, the
flow actions and a second implementation of the whole thing in bash inside
`bin/freilauf-deploy`. So "which channel" was not a question anybody could answer
differently, and an installation that wanted none had to leave a token unset and
hope every caller checked.

A **notifier** is the third plugin kind now — same registry, same duplicate-id
rule, same external packages under `FREILAUF_PLUGIN_DIR` (`"kind": "notifier"`),
same `registryErrors()`. The full contract is in
[docs/plugins.md](docs/plugins.md); what the rest of the hub has to know is
this:

- **`server/notify.mjs` is the only way anything is said.** `notify(message)`
  dispatches to every enabled, configured notifier in parallel, catches every
  failure, and **never throws**. `notifiersConfigured()` is the question of
  whether a message would go anywhere at all.
- **NOTHING configured is a complete installation.** The hub schedules,
  watches, merges, records and reports exactly as it does with three channels —
  it simply stays quiet. There is no banner, no warning, no required step in the
  Welcome wizard, and no call site that treats it as an error. That is the whole
  point, and it is what every future change here has to keep true.
- **The message is normalized**: `{ kind, text, url, linkLabel, runId,
  attachment }`. The hub composes plain text; how a channel renders it — HTML
  with an inline button, a JSON body, a mail — is the channel's business. That
  is what lets a third party's webhook or Slack package be a drop-in.
- **`server/notifiers/telegram.mjs`** is the one built-in, and it is not
  special: its token and chat are ordinary declared `settings` carrying
  `settingKey: 'telegram_token'` / `'telegram_chat'`, so **no settings
  migration** was needed and an existing installation finds its token exactly
  where it left it. Its old `/telegram-setup` wizard is now the plugin's own
  `setup` declaration, and `/telegram-setup` is a 303 to it.
- **Settings → Notifications** (`/settings/notifications`) is one card per
  registered notifier — enabled flag, its settings, its credentials, a "send
  test message" button, a link to its wizard — built from the same card blocks
  the Plugins page uses. It opens by saying that all of it is optional.
- **`bin/fl-notify "<text>"`** is the facade from outside the hub process, for
  `freilauf-deploy`: it loads the plugins and calls `notify()`. Exit 0 when
  delivered *or* when nothing is configured — a deploy must not fail because
  there is nobody to tell.
- **The flow step is `notify`**, channel-neutral. `telegram` is still accepted
  as a stored step type (`server/flows/aliases.mjs`), because a step's type is
  data that sits in every saved flow.

**The per-run flag was renamed and the column was not**, and the difference is
the rule: `notifyRun()` writes `notified:<type>` (and still READS
`telegram_sent:<type>`, so a run told about its overrun before the deploy is not
told again after it), because an event kind is queried by name and rendered into
a run's history — a stored kind that says "telegram" after a message went to
Slack is a lie in the data. `runs.telegram_on` keeps its name, because renaming
a column is a table rebuild and this project's own rule about
`openrouter_min_eur` says that is a migration for nothing.

### The Welcome wizard

A fresh installation has nothing, so every page it renders is about something
the operator has not got yet — and the one document that would fix all of it,
`SETUP_WITH_AGENT.md`, is a file in a checkout nobody was told about.
**`server/welcome.mjs`** is the six screens that say so: hello and the pointer
to that document, what the scan found, a model provider, the source for the
hub's own questions, whether to install the hub's own agent skills, and what to
do next. `STEPS` is the single counter — the breadcrumb, the header, the
"step n of total" line and the clamp on `?step=` all derive from it, so adding
a screen is that constant plus a `stepN()`, a heading key and an endpoint. `GET /` redirects to `/welcome` for a
browser navigation until the operator ticks **"Do not show this again"**
(`welcome_hide`).

It is built in the shape of the notifier setup wizards and for the same reasons: server-
rendered steps, each its own `<form method="post">` to its own endpoint, state
in `settings` / `plugin_config` / `discovery` from the moment a form is
submitted — closing the tab in the middle loses nothing, and a reload cannot
show a state the database does not hold. Every write goes through the same
functions the Plugins page writes through, so **the wizard cannot create a state
the rest of the hub chokes on**.

Three rules about getting out of it, because a wizard one cannot leave is worse
than no wizard:

- the checkbox is on **every** step of an unlocked page, not only the last (with
  the hidden `0` companion — an unticked box is simply absent from a POST body,
  so without it the wizard could never be switched back on);
- **leaving is a session answer too**, a `freilauf_welcome` cookie the `/`
  redirect honours, because a plain link back to `/` would otherwise bounce
  straight into the wizard again;
- and **every way off an unlocked page is a submit of the form the checkbox is
  in**. That was the expensive one. A returning operator makes one gesture —
  tick "Do not show this again", then leave — and the exits were `<a href>`
  links in the footer, outside that form: the tick was never submitted, so the
  wizard greeted them again on the very next page load, having been told twice
  not to. `primary()` therefore renders the way out as a
  `<button name="exit">` next to the primary button, `stepFoot()` is the step
  counter and nothing else, and `afterStep()` saves the box, marks the session
  and redirects home. The banner's own button is the single remaining link and
  points at `?welcome=skip`, never at `/`. On step 1 the primary button is also
  labelled for who is reading it: "Start the setup" while locked, "Go through
  the setup again" for a revisit — a button that describes something the reader
  is not doing is a button they will not press.

### The hub's own questions: `server/llm/`

The hub asks a small model four things of its own — a name for a run, whether a
log line is a real outage, what a report contains, which worktree extras a
repository wants. All four used to be hardcoded OpenRouter, each with its own
copy of the URL, the bearer header, `response_format` and
`JSON.parse(choices[0].message.content)`. Four copies of one call is how a seam
like `FREILAUF_OPENROUTER_BASE` ends up honoured in exactly one of them (it did),
and how a source that is not OpenRouter cannot be added at all.

**`llmJson()`** (`server/llm/index.mjs`) is the one entry point now, and it
**never throws** — the four callers have four different error styles and every
one of them expects a value. What stays in the callers is what genuinely differs
and must not be unified: their error style (a title fails soft to null, the
check fails loud, a flow step throws, the extras endpoint returns a translated
message), their throttles and their defaults. Only the transport is shared.

A **source** is `provider:<id>` or `agent:<id>` — a model provider that declares
`llm`, or a **coding agent** that does. The two are one flat list on purpose: a
coding agent's model identifiers already carry the provider
(`anthropic/claude-…`, `openrouter/…`), so there is no second "which provider"
field anywhere and the model picker is filled by the chosen source's own
`models()`. A bare value with no prefix means `provider:openrouter` — not a
convenience but the backwards-compatible reading of everything the settings
table holds today, which is what makes an installation that changes nothing
behave byte for byte as it did.

The strategy comes from the source's declared `llm.schema`, and **the adapters
do no coaxing of their own**, because two places persuading one model is how
answers stop being reproducible:

| declared | what happens |
|---|---|
| `native` | the schema goes over the wire as a schema; nothing is added to the prompt |
| `json_object` | the vendor promises valid JSON but takes no schema, so the flag goes out **and** the prompt carries the shape |
| `prompt` | the schema is a paragraph of strict instructions and nothing else |

**`native` says the schema TRAVELS natively, not that the model obeys it.**
claude's `--json-schema` is a forced tool call, and a model may decline a tool:
five runs of one adversarial prompt on `haiku` gave four with
`stop_reason: tool_use` and a conforming `structured_output`, and a fifth with
`stop_reason: end_turn`, no `structured_output` and prose in `result`. The
declaration is still right — the schema really does go over the wire, so the
strict paragraph really is unnecessary — and that is exactly why the two lines
under it are not optional: the adapter falls back to `result` when
`structured_output` is missing, and the reprompt below catches what that leaves.

Whatever comes back is read tolerantly (`json.mjs` — fences stripped, prose cut
by a character scanner that respects strings, the common damages repaired; it
**never evaluates** the text), measured against the schema (`schema.mjs`, whose
`validate()` also **coerces**: a small model answering `"true"` is right about
the answer and wrong about the type), and on failure asked for again **exactly
once** with the complaint attached (`llm_retries`, default 1). Then it gives up
and says so, with a `stage` of `config` / `transport` / `parse` / `validate`.
A **transport failure is not reprompted**: a 401, a timeout or a missing binary
does not become right by asking the same thing again — it moves DOWN THE CHAIN
instead.

### The chain: fallback first, backoff second (`server/llm/job.mjs`)

Every place that picks a model source for one of the hub's own questions plans
the same shape now, in **one** module: **`server/llm/job.mjs`**. The plan is a
chain — the primary source (`llm_<p>_source`) first, then the fallbacks
(`llm_<p>_fallback`, a select in each of the three settings fieldsets; the
value reads as a comma-separated list, so a hand-edited row may carry an
ordered chain, and the parse is deliberately STRICT: junk means "no fallback",
never OpenRouter). `llmJson()` executes the plan:

| Failure | What happens |
|---|---|
| `transport` on one entry (5xx, rate limit, timeout, network) | the **next source of the chain** takes the question — no backoff, no wait; the fallback exists precisely so the answer does not have to wait for the primary to recover |
| `config` on one entry (unknown source, missing credential) | skipped the same way, but NOT counted as an attempt — no amount of waiting makes a missing key appear; an all-config chain returns the **primary's** config answer and alerts nobody |
| the whole chain down | **exponential backoff with jitter** (`backoffDelayMs()` — the pause doubles per round, ±50 % jitter, `llm_retry_base_ms`/`llm_retry_max_ms` as floor and ceiling), and the chain is walked again, until `llm_retry_attempts` (default 10, **hard cap 10**) transport attempts have been made in total; the FIRST walk always runs to the end, so a configured fallback is tried even at 0 |
| `parse` / `validate` on one entry | NEITHER: the source answered, so the provider is up — the repair rounds on the same source are the answer, and falling back would hide which source cannot obey the schema |

One exhausted call raises exactly ONE alert, keyed on the primary (the job the
operator configured) and naming every source that was tried. A fallback needs
its own model name (`llm_<p>_fallback_model`, empty = the primary's model) —
**unless it is an agent source**: `llmJson()` accepts an AGENT source without a
model (claude picks its own default), which is what makes
**`agent:claude` — claude's print-only mode (`claude -p`, lean flag set, no
session persistence) — a zero-config fallback** every question on the hub can
degrade to. The fallback picker offers the same flat list as the primary
(providers, then agents), and the gates (`titleLlmActive` & co.) ask
`chainUsable()`: a primary without a key and a fallback that has one is a
working job, not an off one.

The three callers' private `orRoutingAusSetting()` copies died here too —
`jobRouting()` is the one reader of the per-job routing settings. The flow
`extract` step inherits the check job's chain and may name its own fallback
(`fallback`, `fallbackModel`) per step. What a chain does NOT change: the four
callers' error styles, throttles and context caps stay exactly where they were.

**The channel must never be bombarded** (`alerts.mjs`): one message per failure
*signature* (`purpose|source|model|errorClass`) per `llm_alert_window_min`
(default 30), the suppressed occurrences counted and named in the next message
for that signature, a global ceiling of `llm_alert_max_per_hour` (default 6),
switchable off with `llm_alert_on`, and fail-soft in every direction. And
deliberately **no alert for a `config` stage**: a feature switched off, a source
nobody configured a key for, an empty model field — those are states the
operator chose, and alarming about them is exactly the channel-that-cries-wolf
this module exists to prevent.

**A coding agent as a model source declares `overhead: true`**, and the UI says
so wherever such a source can be picked: it starts a whole session to answer one
question, slower and dearer than a model provider. It is also the one way to run
the hub with nothing configured but a subscription that is already being paid
for — which is why the Welcome wizard offers it.

### Subscription usage

Harness plugins may implement `usage()`; `server/usage.mjs` aggregates and
caches the results for the overview panel and `GET /api/usage`. Claude asks the
account (see below), cursor asks the Cursor API with the CLI's own token
(`~/.config/cursor/auth.json`): `GetCurrentPeriodUsage` reports spend, the
included amount and the cycle end of the running period in cents — the bar
therefore measures against the amount the account really has, on every plan.
Cursor documents that amount nowhere and its public APIs are admin-only, so this
internal dashboard endpoint is the only source; it has no contract. When it
stays silent the configurable `cursor_included_usd` setting (default 20) steps
in as a fallback and the UI marks the value as estimated.

#### Claude's windows come from the account, not off the floor

`~/.claude/quota.json` is not Freilauf's file, and it is not claude's either:
claude **never writes it**. It hands the windows to the **status line**, and a
status line only renders while an interactive session is open; the per-model
week (`seven_day_fable`) is put there by a script belonging to an entirely
different project. So the panel's freshness hung on two things Freilauf does not
control, and it failed **silently** — the numbers looked current. Measured
2026-08-28, with the sidebar's own 30 s refresh working perfectly, re-fetching a
fragment rendered from a seven-hour-old file:

| window | shown | real |
|---|---|---|
| 5 h | 3 % | 5 % |
| 7 d | 77 % | 78 % |
| 7 d Fable | 80 % | **88 %** |

Eight points on the window that **binds a run on that model** (see below): the
budget gate defers a start at 95 %, so a stale 80 lets runs into a quota that is
nearly gone.

**`server/claude-usage.mjs`** asks the account itself —
`GET https://api.anthropic.com/api/oauth/usage`, bearer token out of
`~/.claude/.credentials.json`. Its `limits[]` array is preferred over the flat
`five_hour`/`seven_day` keys next to it because it is self-describing: each entry
carries its own `group` (`session` | `weekly`), `percent`, `resets_at` and, for a
per-model window, the model's display name. **Nothing about "Fable" is
hardcoded** — a second scoped window appears in the panel by itself, and that
window finally has the reset time the file never carried for it.

Five rules, each load-bearing:

1. **Never write `quota.json`.** It belongs to the status line and to that other
   project's script. Freilauf reads it — as the **fallback** — and nothing else.
2. **Never refresh the OAuth token.** An expired token is a reason to stay
   silent, not to mint a new one: racing claude for its own credentials file
   could invalidate the operator's live session, and no panel is worth that.
   `expiresAt` is checked, and that is all.
3. **Fail soft in every direction.** No credentials, no network, a renamed
   field, an HTTP error — all of them mean "no live answer", and `claudeQuota()`
   is then byte for byte the function it was before.
4. **The gate stays synchronous.** `claudeQuota()` sits on the launch path, in
   the watcher pass and in the cost calculation. So the *refresh* is async and
   fills a cache (`refreshClaudeLimits()`, called from the watcher pass and from
   the usage aggregator) while the *read* is not. `claudeQuota()` merges the two
   **per field**, live winning: an expired token leaves the live side empty and
   the status line's minutes-old 5-hour window is still worth having. A live
   answer older than the TTL is dropped — an hour-old live number is worse than
   the file, which a running claude session at least keeps moving.
   **A failed refresh backs off** instead of being retried on the next pass:
   each failure doubles the wait (2 min → 30 min cap, `CLAUDE_USAGE_BACKOFF_MS`/
   `CLAUDE_USAGE_BACKOFF_MAX_MS`), the vendor's `Retry-After` wins when it is
   longer, and a success clears it. Measured 2026-09-01: the account rate-limits
   this endpoint, and the old failure path left the cache empty — so the hub
   asked again every watcher pass, exactly when it had been told to wait.

And a fifth one, learned from the bar that would not stand still:

5. **The last live answer is remembered, and the sources are merged by AGE.** A
   429, an expired token or an expired TTL all look the same from here: no live
   window at all. For the per-model week the file's `seven_day_fable` then
   stepped in — written by that other project's script on its own occasions:
   measured 2026-08-29, 80 % with a `fetched_at` **45 hours** older than the
   `five_hour` block written into the same file the same minute. So the bar
   jumped 88 → 80 → 88 → 80, and always fell to the older number. And the same
   jump ran the other way for the general windows: a rate-limited stretch made
   the 5-hour bar drop to whatever the file last held and back on every gap.
   `claude-usage.mjs` therefore keeps **every** window of the last live answer —
   the general ones per field, the scoped ones per label, each with the time it
   was read, in `~/.local/share/freilauf/claude-windows.json`
   (`FREILAUF_CLAUDE_WINDOWS_JSON`), because this hub deploys often and a
   restart would drop straight back to older knowledge. quota.mjs decides per
   window: the live answer wins, otherwise the **newest** reading — the file
   wins when its date says it is fresher (for `five_hour`/`seven_day` that date
   is the file's mtime, which is honest for exactly those two windows, because
   the status line writes them and only while a session is open; the per-model
   week is dated 0 unless its own `fetched_at` says otherwise, since the file's
   mtime belongs to a window that entry does not describe). A remembered window
   past its own `resets_at` is **forgotten** (24 h when it carries none):
   stale-but-conservative is fine for a display and not fine for the budget
   gate, which would otherwise defer runs against a quota that has long since
   refilled. Everything that is not the current live reading is marked `stale`
   and carries its `at`, and the panel prints "as of …" next to it — a number
   that looks current and is two days old is the failure this whole section
   exists about, and hiding the jump without naming the age would only have
   made it quieter.

Two traps the tests now pin down. `Number(null)` is `0` **and finite**, and the
endpoint really does send nulls for windows the account does not have
(`seven_day_opus: null` sits in the same response) — without the guard a missing
window arrives as a confident 0 %, which is not merely wrong but counts as an
answer and shuts out the file fallback for a whole TTL. And an answer carrying no
window at all is **not an answer**: returning it would let an empty success
shadow the file for the same TTL.

The **rail** (the folded sidebar's whole glance) shows `seven`, the fullest
window — not the general week. They are not the same number, and a rail reading
78 next to a per-model week at 88 reads as comfortable right up to the point
where the runs on that model get deferred. The panel below still breaks the
windows out one by one and names each of them.

#### Which 7-day window binds is a question about the RUN, not about the account

`seven` — the maximum of the weekly windows — was what the budget gate, the
"quota full" anomaly and the cost delta all read. So a Fable week at 96 %
deferred a run on **Sonnet**, a window that run does not draw from at all, and
`Freilauf` sat still with 60 % of its general week unused.

The rule is one sentence: **the general week binds every claude run, a per-model
week only a run on that model.** Four functions in `quota.mjs` carry it, and
every caller that knows a model asks one of them instead of `seven`:

| Function | Answers |
|---|---|
| `windowAppliesToModel(label, model)` | does this per-model window concern that model? |
| `weeklyBinding(quota, model)` | the fullest window that does — with its name and its reset time |
| `sevenFor(quota, model)` | the same as a bare percentage |
| `sevenForRun(run, quota)` | the same for a run row; a non-claude harness filters nothing |

**The match is on the model IDENTIFIER, because that is the only thing a run
carries.** The account names its scoped window with a display name (`Fable`),
and the same model reaches the CLI as the alias `fable` and as
`claude-fable-5` — so a naming token of the label occurring in the identifier is
the whole test. Nothing about fable is hardcoded: an `Opus` window matches
`claude-opus-5` by the same rule, and the words that name no model (`claude`
first of all, or a label like `Claude Fable 5` would match every claude
identifier there is) are filtered out of it.

Two cases deliberately answer **yes** and stay conservative, because letting a
run into a window that is full costs more than deferring it: a run with **no
model** (claude then picks its own default and the hub does not know which one),
and a window whose label names no model at all (`claude-usage.mjs` falls back to
the surface name or a bare `7d`).

Where it is asked, and why each of them:

- **`budgetGate(harness, model, provider)`** (scheduler.mjs) — the model
  travels with every call: from the definition on the way in, from the run row
  when the watcher picks a deferred run back up. A block also **names the
  window** in its reason and hands out **that window's** reset time; a 7-day
  block used to publish the 5-hour reset into the deferred event and into
  the notification as the moment the run would start again.
- **`anomaly:quota_full`** (watcher) — a red flag on a run for somebody else's
  window is noise, in both directions: only a **claude** run is measured against
  the claude windows at all (a run on another harness draws nothing from them,
  so an exhausted claude quota must not colour its row red), and within claude
  only a window that binds THIS run's model can flag it. The event **names the
  window** (`quotaFullWindow()`: '5h', '7d', '7d Fable') and the overview prints
  it, so "quota exhausted" comes with the answer to whose quota ran out.
- **`quota7_start` / `quota7_end`** (runner.mjs, `finishCosts`) — both ends of
  the cost subtraction now describe one window. Taking the maximum made a run on
  Sonnet expensive because a Fable week filled up while it ran.

Only the **display** still asks for the maximum: `seven` is the account's worst
case, which is what one dot on the rail can honestly show.

#### The gate is a rule the operator configures — and can overrule

The thresholds were hardcoded (5 h ≥ 90, 7 d ≥ 95) and the settings page still
carried a "quota threshold" field that nothing read — the gate looked
configurable and was not, and a DeepSeek or OpenRouter run was measured against
whichever gate a claude budget was blamed for. Both are fixed by one rule:
**what a run draws from decides which gate is asked, and every gate is optional.**

- **Every gate is declared by the plugin that owns the account behind it**
  (`gate` in the descriptor), and `budgetGate(harness, model, provider)` names
  no vendor at all any more. It asks the **coding agent's** gate when it
  declares one (claude and cursor run on their own subscription, and no provider
  is involved), otherwise the **model provider's** (OpenRouter credits, the
  DeepSeek balance), otherwise nothing — a known provider without a gate
  (opencode-zen reports no balance) draws on nothing the hub can meter. The old
  fallthrough survives as the named constant `LEGACY_DEFAULT_GATE =
  'openrouter'`: every provider-based harness ran on OpenRouter before there was
  a provider column, and a hand-typed `openrouter/author/slug` model still
  arrives with `provider = null`.
- **The switch is handled by the caller, not by `check`.** `askGate()` reads the
  gate's on/off value and answers `null` without asking the plugin, so a plugin
  cannot forget it — switching a gate off *is* the decision that this window
  does not govern starts. And **a gate that throws does not block**: a broken
  plugin is a reason to say so in the log, never to stop the hub starting runs.
- Every gate still has an **on/off switch** and its own **thresholds**, all
  under Settings → Budget gates — but the fieldset is **generated** from
  `gatePlugins()`, so an installed plugin's gate appears there by itself and a
  disabled one does not. Nothing about claude, cursor, OpenRouter or DeepSeek is
  typed into `pages.mjs`. The historic keys are unchanged
  (`claude_gate_on/_5h/_7d/_fable`, `cursor_gate_on` + `cursor_gate_pct`,
  `openrouter_gate_on` + `openrouter_min_eur`, `deepseek_gate_on` +
  `deepseek_min_usd`), because a `SettingField` may declare a `settingKey` — the
  escape hatch that let the whole rebuild happen with **no settings migration**.
  A field without one is stored as `plugin_<id>_<key>`, which is what makes two
  plugins declaring a `threshold` harmless. A cleared numeric field falls back
  to the field's own default (the fable week to the general 7-day threshold);
  `''` has to mean "not set" and never `0`, because the settings page writes
  every input as a string. `quota_threshold` is gone — it was the field the gate
  never read.
- **Each window is judged against its own threshold.** `claudeGateBlocked`
  measures the 5-hour window against `_5h`, the general week against `_7d`, a
  per-model week called "Fable" against `_fable` — so a fable run can be
  deferred earlier (or later) than everything else without touching the general
  week. The reason names the blocking window and its reset time.
- **The DeepSeek gate** asks the provider plugin directly (same cycle rule as
  OpenRouter): it blocks on the account's own `is_available=false` verdict or
  on a USD balance below the threshold. A CNY-only account reports no USD,
  which is "no signal" — the gate stays open, like a missing key.
- **The cursor gate** measures the running period's usage — spend divided by
  the included amount, from the account's own `GetCurrentPeriodUsage` (the
  same answer the usage panel shows) — against `cursor_gate_pct`. The included
  amount is only assumed when that endpoint stays silent
  (`cursor_included_usd`). No token, no answer, no included amount: all three
  mean no signal, and the gate stays open.
- **A deferred run can be started anyway.** The gate is a rule that must not
  overrule a deliberate decision (same principle as `repos.max_parallel`), so
  the detail page and the overview row carry a "Start anyway" button
  (`POST /api/runs/<id>/start`, event `forced_start`). It shares one function
  with the watcher's auto-retry — `startDeferredRun(runId, { forced })` — and
  only a `deferred` run may go: a scheduled one is waiting for its time, not
  for a quota.

The e2e sandbox points `FREILAUF_CLAUDE_CREDENTIALS` at a file that does not exist,
so the suite never touches the real endpoint (same fence as `FREILAUF_CURSOR_AUTH`)
and the quota fixture stays the only source — which also keeps the operator's
real plan string out of the suite.

### Provider balances

The sibling of the above, and the reason it exists: `openrouterCredits()` used
to sit in `quota.mjs` with one vendor's URL, auth header and response shape
hard-coded into it — exactly the provider-specific knowledge `docs/plugins.md`
says belongs in a plugin. It is a **`balance()` contract** on the provider
plugin now, aggregated by `server/balances.mjs`.

The shape is **normalized rather than passed through**, because the two
providers that implement it disagree on almost everything: OpenRouter keeps one
pot, reports it as numbers and says nothing about whether calls still go
through; DeepSeek reports **strings**, **one entry per currency** (an account
can hold CNY and USD at once) and adds `is_available`, which nobody else has.
Folding those into a single number would silently drop one of the two pots. The
full contract and its four rules are in `docs/plugins.md`.

Two consequences worth knowing. The panel printed `{eur} €` for a dollar figure
until the currency became part of the answer; the setting behind the gate is
still called `openrouter_min_eur`, because renaming a stored key would need a
migration for nothing. And **the budget gate does NOT go through the
aggregator**: it needs one number from one plugin, and it sits on the launch
path, so it asks that plugin directly through the two vendor-free meters that
stayed behind in `quota.mjs` — `balanceGateBlocked(pluginId, …)` for a provider
that reports a balance and `usageGateBlocked(pluginId, …)` for an account that
reports spend against an included amount. (That used to be a *hard* rule, forced
by the import cycle `balances.mjs → coding-agents.mjs → db.mjs → harness
registry`. The cycle is gone with the CHECK; the reason to keep it is now
simply that an aggregator is the wrong thing to wake up for one number.)

**Both caches are keyed on the configuration, not only on time**
(`usage.mjs`, `balances.mjs`): the set of enabled coding agents decides who is
asked at all, so changing it does not make the answer old, it makes it about
something else. And the in-flight flag is released by the promise, never at the
end of the body — with nothing configured the loop has no `await`, so the body
ran to completion (flag reset included) *before* the assignment that set the
flag, and every later call got that one stale promise for the life of the
process. Both only became visible when the status sidebar started asking on
every page, the first of which happens before anything is configured.

### Best-provider selection for OpenRouter (`serving provider: auto`)

OpenRouter serves one model from many serving providers that disagree in
quantization (fp4 … bf16), price (up to 3× for the same slug) and health — the
free routing regularly lands on a stronger-quantized host under the same model
name. The hub therefore ships an automatic best-provider selection next to the
old single-tag pin. The pure decision rule lives in
**`server/providers/openrouter-routing.mjs`** (no hub imports — the same licence
as `cli-llm.mjs`), the I/O and the cache in the OpenRouter plugin's `routing`
capability, and the whole contract is in `docs/plugins.md` ("OpenRouter
best-provider routing"). What the rest of the hub has to know:

- **The form block has three modes**: *open* (OpenRouter routes freely — the
  old default), *auto* (the hub selects) and *pin* (one tag, the old
  checkbox). One widget, so "pin" and "auto" can never be stored as two
  contradictory statements about one run; `runs.or_provider` keeps the pinned
  tag, `runs.or_routing` (agents/runs/favorites) holds the auto requirements
  JSON. **Visible on every harness when the provider is OpenRouter** — the old
  checkbox hid the whole question on anything but opencode, which read as a
  bug; where the setting cannot be passed through (hermes has no per-run
  provider routing, measured), the block says so and `providerFromForm()`
  drops it, exactly as it always dropped the pin.
- **The auto requirements fold away** behind `<details>`: minimum
  quantization (a LOWER bound — "fp8" admits bf16 and fp32, excludes fp4;
  the parser accepts the wide family fp4/fp5/fp6/q4/q4_K_M/nf4/awq/int8/fp8/
  bf16/… and ranks them by effective precision), provider region
  (US / EU / DE / China; anything the region map cannot place drops out),
  max input/output price (USD per Mio). Providers without a quantization
  statement are always out — `null` is "no statement", never "unquantized".
- **The rank, not an enumeration, is the guarantee** (learned from the
  measured source algorithm): a `quantizations` enumeration ages upward — the
  day an endpoint reports fp16, an enumeration would lock out MORE precision
  than asked for. The rank stands in `openrouter-routing.mjs` alone and is
  never copied into a request; `quantizationsFrom(min)` derives the API
  enumeration from it. `int8` deliberately ranks BELOW `fp8`: same bits, unsafe
  direction of a lower bound. `fp16`/`bf16` tie deliberately.
- **No minimum = the best quantization a reliable provider serves.** With a
  minimum, everything at or above it competes on price. Both rules end in an
  ordered chain (up to four tags), not a single pick: the cheapest provider is
  the most rate-limited one, and an `order` of one name was exactly the
  failure that started the whole subject over there.
- **Cached per model+config, 24 h**, in
  `~/.local/share/freilauf/openrouter-routing.json` (`FREILAUF_OR_ROUTING_JSON` —
  a test fence like `FREILAUF_CURSOR_AUTH`): the next run that picks the same
  model with the same requirements gets the SAME order, not a re-rolled one. A
  fresh failure falls back to the stale answer marked `veraltet`, never to
  nothing — an unpinned call is the worse failure.
- **Only opencode receives it per run** (measured: hermes has no per-run
  provider routing; its `providers:` config is global). `resolveRouting()` in
  scheduler.mjs resolves auto to a concrete order BEFORE `createRun()` and
  freezes it into the run's definition copy; every failure launches unpinned
  and logs — a start never fails on its own convenience feature.
- **Every OpenRouter call site of the hub carries the same three modes now.**
  The settings page's own LLM jobs (title, check, extras) render the SAME
  open/auto/pin widget with the folded requirements, stored as
  `llm_<purpose>_or_routing` (JSON) next to the historic `llm_<purpose>_or_provider`
  tag; `settingsSave()` derives the two stored values from the mode, and only
  where the body actually carried the block (fragment saves of unrelated
  sections must not reset a configured routing). The consumers pass it as
  `orRouting` to `llmJson()` → `complete()`. The flow designer's
  "start single run" step carries the same choice as flat fields
  (`orMode`/`orProvider`/`orQuant`/`orRegion`/`orMaxIn`/`orMaxOut`),
  validated by `defFromFlowProps()` the same way the form validates it; the
  "start agent" step inherits the agent's stored definition and needs nothing.
  `GET /api/or-routing` is the preview endpoint the form's auto hint asks —
  same cache, so the preview cannot promise what the start would not deliver.

## The live channel: a run announces itself

The hub rendered a whole page and then never spoke again. A title generated
after the fact only appeared on the next reload, a run that ended left the
overview showing work that was over, and killing a run needed
`location.reload()` to make the page agree with reality.

**`server/events.mjs`** is the channel that fixes that: an event bus and one SSE
endpoint, `GET /api/events[?repo=<id>]`. It can be this small because HTTP,
scheduler and watcher share **one process** (`hub.mjs`) — whoever changes a run
is in the same memory as whoever holds the browser connection, so a publish is a
function call. No broker, no second port. It imports nothing at all, which is
what lets `db.mjs` import *it* without a cycle.

### It hangs on `addEvent()`, and that was measured

There are **39 `UPDATE runs SET` sites in 10 files**. Publishing from each of
them is the drift `run-def.mjs` exists to prevent, so the channel hangs on the
one place a run's transitions already pass through — `addEvent()` in `db.mjs`.

That this holds was **measured, not assumed**: of the 18 places that write
`status=`, 13 already added an event. The five that did not — ending a run by
hand, answering a help call, retrying, and the two flow equivalents — were a gap
in the run's own event list, not just in the channel. "Why did this run stop?"
had no answer on its own detail page. They write one now (`message_sent`,
`help_answered`, `aborted {by}`, `retry`).

Three changes are visible without writing an event — the generated title,
archiving and unarchiving — and those call `announceRun()` explicitly.

### The event carries a signal, never markup

The browser answers an event by **fetching a fragment** (`/api/fragments/…`),
which the server renders through the same function the full page uses. So a row
keeps exactly ONE renderer, and translations, traffic-light rules and
conditional cells cannot drift between the page and its updates. The event's
`status` field is a **hint**, not the truth: some call sites run `addEvent`
before the `UPDATE` and some after, which is harmless precisely because nobody
renders from it.

**Deliberately no htmx**, and it was tried on paper first. Every swap here is a
special case — an element that may not exist yet, a row that must not be
replaced while it is being renamed, a terminal that must never be touched — and
the inline `onclick` attributes plus the capture-phase rename listener would
have to be reconciled with a library's own handlers. It came to 40 lines of
vanilla instead of a 51 KB dependency.

Three rules the client keeps, each with a test:

- **A row being renamed is skipped.** The half-typed title lives only in the
  DOM; swapping the row throws it away mid-word.
- **A run the page does not show yet re-renders the tbody**, not the row. The
  empty state and the sort order both live there, so a new row cannot be
  appended. The same is true for anything whose *presence* depends on state (the
  scheduled banner, the usage panel): from absent to present is a parent swap.
- **`#term` is never part of a fragment.** Replacing it tears the xterm instance
  off the DOM, leaves the WebSocket open and leaks a tmux client — and every
  attached client rewraps the running agent's window, because tmux runs with
  `window-size=latest`.

**And `location.reload()` after killing a run STAYS.** It looks like a leftover
and is the opposite: it is what closes the terminal's WebSocket, and with it
that tmux client. The send and kill forms also sit outside the fragment and have
to disappear. The reason is in the code, so it does not get modernized away.

## The transport: why the hub felt slow, and what carries it now

Every page rendered in single-digit milliseconds and the hub still hung. That is
the shape of this whole section: **none of it was visible from inside the hub**,
because the requests never got there. Three causes, all in the layer between the
browser and `hub.mjs`, all measured on the running installation.

### One connection per tab, and a browser has six

`vpn-proxy.mjs` was `https.createServer` — HTTP/1.1 only. A browser opens at most
**6 connections per origin** over HTTP/1.1, and since the live channel exists
**every open Freilauf tab holds one of them open forever**: an EventSource is a
response that never ends. Four tabs left the page two connections to load itself
through; six left it none, and every further request simply queued in the browser
until a tab was closed.

It is `http2.createSecureServer` now, `ALPNProtocols: ['h2', 'http/1.1']`. An h2
browser multiplexes pages, fragments, static files and the SSE stream over ONE
connection, and the ceiling stops existing.

`allowHTTP1: true` is what keeps the terminal working: browsers do not run
WebSockets over h2 (RFC 8441 is not advertised here), so they open a separate
HTTP/1.1 connection for the upgrade — and the proxy's `upgrade` event still fires
for it. That was measured against Node 22 before the switch, because the h2
server's compat layer documents `request` but not `upgrade`.

**Hop-by-hop headers become fatal under h2.** `connection`, `keep-alive`,
`transfer-encoding` and `upgrade` describe one connection; node rejects them on
an h2 stream outright. The hub's SSE handler sends `connection: keep-alive`, so
passing the upstream headers straight through would have killed the live channel
for every h2 client — silently, since the throw happens inside the proxy. Both
directions are filtered (`normalizeHeaders`, `responseHeaders`), and the same
function turns an h2 client's `:authority` into the `host` the allowlist reads.

### `pipe()` does not close what it stopped reading

`up.pipe(res)` alone does not survive the client going away. When a browser
closes an SSE stream — a navigation, a closed tab — the downstream `res` ends,
but the **upstream request to the hub was never destroyed**: node's `pipe()`
unpipes a dead destination, it does not tear down the source.

So every page view left behind a socket to the hub, and inside the hub the SSE
client record that hangs on it: an entry in `clients` that receives every
published event, plus a 25 s heartbeat interval, for the life of the process.
Measured before the fix: **7 browser connections, 19 upstream ones**, and the
number only ever went up.

`res.on('close') → upstream.destroy()`. Everything the hub does to notice a gone
client (`req.on('close')` in events.mjs) depends on this socket actually closing
— which is why the fix belongs in the proxy and not there.

### Static files had no validator, and were read from disk every time

`serveStatic` did a `readFileSync` on **every** request and answered with nothing
but a content-type. Two consequences, and the second is the expensive one:

- a synchronous read in the request path blocks the ONE event loop that also
  holds every SSE stream, the terminal WebSocket, the scheduler and the watcher.
  xterm.js alone is 488 KB off disk;
- with no validator a browser cannot revalidate, so it re-downloaded the whole
  set on every page view — ~600 KB per page, ~900 KB on a run detail page.

Now: in memory, with an ETag from the file's mtime+size and `cache-control:
no-cache`. A repeat page view went from 104 KB to 10.5 KB. `no-cache` rather than
a long `max-age` because these URLs carry no content hash — a cached hub.js would
otherwise outlive a deploy. The entry is validated against one `statSync` per
request (metadata, no bytes), so editing `public/hub.js` still takes effect on
the next reload; the dev loop this repo lives on must not be traded for a cache.

### And a page render never waits on somebody else's server

`layout()` awaits `subscriptionUsage()` and `providerBalances()` — the rail and
the panel — on **every** page, and both talk to vendor APIs (cursor's dashboard
endpoint carries a 12 s timeout). With a two-minute cache the hub was fast for
two minutes and then ONE page view paid for everybody.

Both are **stale-while-revalidate** now: an expired entry is returned as it
stands while the refresh runs behind it, and the live channel re-fetches the
sidebar anyway, so the new numbers arrive on their own. `force` (the `/api/usage`
route) still waits — that caller asked for the current answer, not a fast one.
The only request that could still wait on a vendor is the one finding no cached
answer at all, which is why `hub.mjs` **warms both at startup**, fire and forget.
First page view after a restart: 1.15 s before, 11 ms after.

## The status sidebar: one place that says how the machine is doing

`statusSidebar()` in `pages.mjs`, right of the content, on **every** page,
`id="status-sidebar"`. In it, in this order: pipeline state (`headerStatus()`,
`id="header-status"`), work in flight per status for the current repo (each
count links to `/?repo=…&status=…`, the overview's one filter; when the other
repos together hold more of the same status, the sum across ALL repos follows as
a dimmed `(y overall)` suffix outside the link, shown only when it differs), open
incidents split the way `incidents.mjs` splits them (both counts link to
`/?repo=…&incidents=1`, the overview filtered to the runs that carry an open
incident — the same gesture as the work-in-flight counts: a click on a number
shows the rows behind it; the filter travels as `data-incidents` on the tbody so
live updates keep it. **The number and that list are one set**: an archived
run's incidents are not counted here, and where only hub-wide incidents
(`run_id IS NULL` — the provider pulse, a lost tmux server) are open the count
is rendered without a link, because the overview cannot show a row for them and
they carry their own banner on every page), subscription usage and
provider balances (`usagePanel()`, `id="usage-panel"`), and what every tmux
session on the machine holds together (`memoryBlock()`, `id="side-mem"`).

Before this, status stood in three places and fully on exactly one page: two
quota bars in the header, the pipeline switch as running text beside them, and
the usage panel on the overview. The two bars were `bar()` in `layout()` and
`pctBar()` in `usagePanel()` — the same reading, two markups, the thresholds
spelled out twice. There is one `quotaBar()` now, and every bar in the
application comes out of it.

- **`layout()` is `async`** because the panel is: every call site awaits it.
- The header kept **context** (repo switcher) and one **action** (Quick Run) and
  gave up status. It is a line high and has to stay that way.
- **The chosen repo is remembered.** The switcher's choice travels as the
  `freilauf_repo` cookie, so a page that carries no `?repo=` of its own (a menu
  click, a context-less page like settings) keeps the selection instead of
  falling back to the first repo — the reset the overview used to do on every
  navigation. The cookie is written twice on purpose: by the client when the
  switcher changes (so the very next page already shows the choice) and by the
  router whenever a page request names a valid `?repo=` (so followed links and
  "back" redirects persist too) — both through `requestRepo(req)`, so the
  persisted choice and the visible one read the same signal. `selectRepo()`
  answers explicit `?repo=`, then the cookie, then the first repo. An id that no
  longer exists (a deleted repo) is ignored, not trusted. `<body data-repo>` is
  **not** affected: pages without a repo context still set no SSE filter.
- **A page that belongs to ONE repo still shows the chosen one.** Some pages
  cannot follow the switcher: a run belongs to its repo, and rendering another
  repo's overview under `/runs/<id>` would be a 404 with extra steps. So they
  reload as themselves and only the CHOICE moves — which is why `layout()` asks
  in this order and not in the page's:

  1. an explicit `?repo=` in the request — the switcher itself speaking,
  2. the repo context the page handed over (`selectedRepo`),
  3. the cookie, then the first repo.

  Before that, the click wrote the cookie, the next page obeyed it, and the
  dropdown one had just used snapped back to the run's repo. Nothing was broken;
  it read as if the click had been swallowed. **The rule lives in `layout()`, so
  a new page inherits it by being rendered** — there is nothing to remember to
  do, and that is the whole point: the pages that need it (run detail, agent
  form, agent move) never mention it. What stays with the page is `<body
  data-repo>`, the live channel's filter — the run's own events must keep
  arriving while the header talks about somewhere else; the sidebar carries its
  own `data-repo` and follows the choice.
- **…and the page says so** (`otherRepoBanner()`, the note above the content).
  The rule above is right and it is silent: the header names a repo the content
  in front of one has nothing to do with, and the sidebar counts somebody else's
  runs. The note names both repos and links to the chosen one's overview — a
  hint that only states the problem makes the reader hunt for the switcher
  again. It is **derived, not passed**: a page that follows the switcher reads
  the same `?repo=` into its own `selectedRepo` (`selectRepo()`), so there the
  two values are equal by construction and the note cannot appear; only a page
  whose repo is fixed can produce the mismatch, and it does so by handing its
  repo over the way it already does. Which is why `repoEdit` now hands one over
  too — a repo form belongs to one repo exactly as much as a run's page does.
- **While the two differ the live channel listens to both repos.** One filter
  cannot serve a detail page that wants its own run's events and a sidebar that
  counts the chosen repo's, so `hub.js` drops the `?repo=` from `/api/events`
  for that stretch. Nothing misfires on the extra events: every handler is keyed
  on a run id, and the one that is not (the tbody) exists only on pages that
  follow the switcher, where the two repos are the same value anyway.
- **The fold lives on the shell**, not on the sidebar: `#shell.side-closed`,
  written from `localStorage['freilauf.sidebar.open']` in try/catch. The live
  channel replaces `#status-sidebar` **whole** — blocks appear and disappear
  (no open incidents, no incident block), and an element that is not in the DOM
  cannot be swapped in by its own id — so a class on the sidebar itself would
  go with every update. `sidebarSync()` re-applies it after each swap.
- The sidebar carries **its own repo** (`data-repo` on the aside). `<body
  data-repo>` is the SSE filter and is only set where a page really has a repo
  context; the sidebar reads one on every page, so it has to say which.
- Fragment route: `GET /api/fragments/sidebar?repo=`, rendered by the same
  function the page uses. `/api/fragments/header-status` and `…/usage` still
  exist; the client simply asks for the whole aside instead.
- **It refreshes itself every 30 s** (hub.js, `window.FREILAUF_SIDEBAR_POLL_MS` in
  the browser suite). The run events alone were not enough: a long-running
  agent fires none, and the usage/balance numbers sat frozen at page-load
  values. The timer asks the same fragment, the server's panel caches
  (usage.mjs/balances.mjs, now one minute, `FREILAUF_USAGE_CACHE_MS`/
  `FREILAUF_BALANCE_CACHE_MS` in the suite) decide how often the vendors are
  really called, and the stale-while-revalidate refresh lands on the next tick.
- **The tmux memory block works exactly that way, on an eight-minute clock.**
  `sessionMemory()` (sessions.mjs, `FREILAUF_SESSION_MEM_CACHE_MS`) measures the
  total RSS of every tmux session on the machine — foreign ones included, the
  question is what the MACHINE holds — through `listSessions()`, so the sidebar's
  total and the sessions page's own summary are the same number by construction.
  Its cache **is** the update interval: the 30-second timer above asks the same
  fragment, and this TTL decides how often `tmux list-sessions`/`list-panes` and
  a `ps` over every process really run. Stale-while-revalidate like the two
  panels beside it, warmed in `hub.mjs` at startup, and the block **says how
  often it measures** (the exact time is the tooltip) — a reading up to eight
  minutes old that presents itself as live is the quiet staleness the claude
  quota panel was already caught on. Not a ticking relative time, because the
  same markup is rendered into the page and into the fragment and the e2e suite
  holds those two to be byte for byte identical.
- **A cleanup run's end invalidates that cache.** The memory-freeing agent ends
  tmux sessions while it works, so the moment it reports, its number is already
  a lie. `refreshSessionMemoryAfterRun()` (sessions.mjs) drops the cache and
  starts a fresh measurement for every run carrying the `cleanup_run` event —
  called from `handleReport()` BEFORE the end event is published (the client
  answers that event by re-fetching the sidebar fragment ~2 s later, and that
  render then carries the fresh value) and from `reconcileClosedSession()`, so
  a killed or vanished cleanup session is covered too. Any other run leaves the
  cache alone: a session still standing after an ordinary run is exactly what
  the retention measures.
- Under ~1000 px it drops **below** the content. A table narrowed by the
  sidebar is the one thing it must never cause.

### Panels: the one block the hub does not measure itself

Everything above says how the MACHINE is doing. What the sidebar could not say
is how the WORK is doing — how many findings are still open, how many tickets
are unassigned, how many tests fail. That question belongs to the project, its
answer is different in every repository, and its counting rule is nontrivial
often enough that a hub which learned one would be wrong in the next repo.

So the project pushes and the hub renders: `server/panels.mjs`, table
`panel_values` (repo + key), `POST /api/panels`, `GET /api/panels?repo=`,
`bin/fl-panel`, rendered by `panelsBlock()` next to the blocks above. The whole
contract is **[docs/panels.md](docs/panels.md)** — what the rest of the hub has
to know is this:

- **Push, not pull, and that was measured.** The obvious design — a command in
  the repo that the hub runs every couple of minutes — would have run in the
  operator's checkout, and on this machine that checkout was **627 commits
  behind `origin/main`** and did not contain the project's counting tool at
  all. The hub merges into `origin/{base}`; a working checkout learns of it when
  a human runs `git pull`. A producer, on the other hand, is in the right place
  by construction: a run that has just merged `origin/{base}` into its branch,
  or a `run_merged` flow. It also costs a handful of pushes a day instead of 720
  polls, each of which would run somebody's script on the hub machine.
- **Data, never markup**, and deliberately not for security — whoever can push
  here can reach every other POST route on this hub anyway. The reasons are
  duller and outlive any threat model: the folded sidebar's RAIL draws dots out
  of values and can do nothing with HTML; `GET /api/panels` is what a skill or a
  flow condition reads, and a number can be compared and alerted on where markup
  can only be pasted; and markup would freeze this hub's CSS class names into a
  contract with code nobody here can see. The freedom that costs nothing is
  given back instead: a `href` on the headline and every row, and a `note` in a
  Markdown subset (`**bold**`, `` `code` ``, `[text](url)`) the hub renders
  itself — escaped first, marked up after.
- **Three states, and the last two are not the same.** `fresh`, `stale` (past
  the TTL the producer declared) and `error` (the last push said the
  measurement failed). The last two keep the previous numbers on screen, dimmed:
  an operator shown nothing has lost what was already there. Every reading
  carries the time it was made, because a panel that quietly keeps showing an
  old number is the staleness the claude quota panel was already caught by.
- **A refusal is an answer, never a 500.** `setPanelValue()` checks the repo
  itself rather than leaving it to the foreign key, caps the shape (8 rows, 40
  characters a label, 6 panels a repo) and repairs what it can — a count as a
  string, an unknown tone, a ninth row — because a producer is a 40-line script
  in somebody else's repository. `''` becomes `null` and never `0`: in a panel
  that trap does not merely read wrong, it reads as "nothing left to do".

### The overview: seven columns, and forms on a grid

Eleven columns became seven without losing a fact: traffic light + status word
+ last anomaly are **one** statement (`td.status-cell`), and harness/model and
branch/PR are one technical pair each (`td.two-line`). The eighth is nameless
and carries no fact — it is the multi-select box (`th.pick-col`/`td.pick-cell`,
see "Runs can be archived"), which is why the header count is seven titles and
eight columns. `OVERVIEW_COLS` is what the empty state spans. The incident cell is a badge with its action on hover —
the rule the pencil and the archive button already followed, keyboard included
(`:focus-within`, because focus lands *inside* the form). A run's `status` goes
through `t()` (`status.*`), an anomaly kind through `anomaly.*`, a harness
through its plugin label. A table that does not fit scrolls inside
`.table-wrap`; it does not get to decide how wide the page is.

Forms are a two-column grid (`form.form-grid`): captions in one column, fields
in the other, hints in the field's column, and a tall field gets its caption
above it. **Every selector there carries `:not([hidden])`** — `label[hidden] {
display: none }` is the weaker selector of the two, and without the guard the
grid would bring switched-off schedule fields back, visible *and* submitted.

## Integration: a run is done when its work is on main

**No agent merges or pushes to the base branch.** Agents make branches
mergeable; the hub integrates. That one rule is what this whole section is
about, and everything below follows from it.

Before it, a run ended when the agent called `fl-report done`. What it had
committed then sat in its worktree and its branch, and whether it ever reached
`main` depended on whether the agent did it itself — which is how this
repository's reflog came to hold two `reset`s on main, a cherry-pick duplicate
and a finished branch lying unmerged for days.

Now a run is `done` when its work is **on `main`**. The hub checks the `done`
report instead of believing it, lets the still-living agent fix what is missing,
merges itself — serially per repo, in an integration worktree of its own, by
`push origin` — and escalates only when the agent does not deliver: to a fresh
conflict run, and last of all to a human. It all lives in
**`server/integrate.mjs`** and is off unless the repo says so
(`repos.merge_mode='hub'`; `'off'` is byte for byte the old behaviour, including
the prompt).

### The finish gate: `runs.finish_state`, not a new status

`handleReport(runId, {kind:'done'})` is where every end channel already met —
`fl-report done`, cursor's `finishByTurnEnd()`, the inbox fallback. So the check
hangs there. It stores the report first (it is safe from that moment on,
whatever the agent does next), then asks three questions in this order:

1. **uncommitted changes?** → `awaiting_commit`. Dirt outranks everything: half
   a run's work on `main` is the more expensive mistake, so nothing is merged
   while the worktree is dirty — not even the committed part.
2. **no commits at all?** (`tip == base_sha`) → nothing to merge, the run closes
   as it always did and the done message says so.
3. **still mergeable?** — a **dry run with `git merge-tree --write-tree
   --name-only origin/{base} <tip>`**. Measured with git 2.43: exit 1 on
   conflict, the conflicting paths on stdout, and `git status` afterwards empty.
   It touches no worktree, which is the point — anything that checked out a
   branch here would fight the agent for its own.

`runs.finish_state` carries this as a **sub-state of `running`**, and not as a
new value in `runs.status`: that column has a CHECK, and a new value would be a
table rebuild like `harnessCheckErweitern()`. It is also simply true — the run
is still running. Its terminal stays writable, messages reach it, a human can
step in.

`runs.base_sha` is the worktree's HEAD right after it was created. It is what
makes "did this run commit anything" and "what does it want merged" answerable
without guessing at a branch. A run from before that column falls back to
`git merge-base <tip> origin/{base}`.

### The answer has to reach the agent, so `fl-report` prints it

`fl-report` used to call `curl -fsS` and throw the answer away. It now reads the
response and prints the `message` field on stdout — which puts the text into the
agent's **running turn** as that tool's own output, the cheapest moment there
is. Two consequences worth keeping:

- **`POST /api/runs/<id>/report` must answer 2xx.** Anything else is "hub
  unreachable" to `fl-report`, which files the report in `inbox.jsonl` for the
  watcher to replay. A finish gate that answered 4xx would loop.
- Channels with no call to answer (`finishByTurnEnd`, the inbox) get the same
  text typed into the tmux session instead — `handleReport` takes a
  `via: 'http' | 'inbox' | 'internal'` for exactly that. And `'internal'`
  carries a **loop guard for cursor**: `finishByTurnEnd()` fires at every turn
  end of a running cursor run, so an injected message would be answered by
  cursor working, ending its turn, and the hub injecting it again. The same
  message therefore only goes out anew when the state changed or two minutes
  passed.

### The check loop, and what the watcher may not do

Its own timer in `integrate.mjs`, every **5 s** — far denser than the 30-second
watcher, because an agent told "commit first" usually does it in seconds. Per
run a `nextCheckAt`, and the interval is a pure function:
`nextCheckDelayMs(elapsed)` → 5 s under a minute, 15 s under five, 30 s after.
At most **two git checks at a time**; what does not get a turn stays due and is
at the front of the next pass, so nothing starves. A check is kept cheap:
`git --no-optional-locks status --porcelain` (the flag is git-level and has to
stand **before** the subcommand — after it git rejects it as unknown and returns
an empty status, which reads as "clean"), and the conflict dry run only when
`rev-parse HEAD` says the tip has moved.

A run with a `finish_state` **has reported**. So:

- `_pane_died`, `_exit` and `reconcileClosedSession()` do not mark it
  `failed`/`aborted` and write no "ended without report" anomaly — they call
  `escalate(runId, 'agent_gone')`. That is for the **unasked-for** end only: a
  human or a flow ending the run on purpose (`/kill`, the sessions page,
  `kill_run`) still aborts it, and it is assessed like any other unfinished run.
- `watchRun()` writes no `overrun`, `soft_overrun` or `no_activity` for it: it is
  waiting on purpose.
- The deadline is `finish_started_at + repos.finish_timeout_min`, and it **does
  not run while the run is `waiting_help`** — there the agent waits for a human,
  not the other way round; answering the question restarts the clock.
- `integrateTick(nowMs)` takes the time as a parameter, like `pickUpScheduled()`,
  so the tests advance the clock instead of waiting fifteen minutes.

### The integrator: one queue per repo, and a worktree of the hub's own

`Map<repoId, Promise>` — each job hangs on the repo's chain, errors caught so
the chain can never tear. That this needs neither a broker nor a database lock
is the same argument `events.mjs` rests on: HTTP, scheduler and watcher are one
process.

The merge happens in `~/agents/integrate/<repo>` (`FREILAUF_INTEGRATE_DIR`), a
detached worktree that belongs to the hub and is cleaned before every job. **Not
in the operator's checkout**, and that is not politeness: git refuses to push
into a branch that is checked out there, a branch belongs to exactly one
worktree, and `merge`/`reset` in a directory somebody is editing is how work
gets lost. The repo's **worktree extras are applied** to it as well
(`applyExtras()`, shared with `makeWorktree()`) — a `merge_check` like
`node test/unit.mjs` wants the linked `node_modules` as much as an agent does.

Then: `git merge --no-ff` (always, so every run is findable as a merge commit),
the optional `repos.merge_check` **on the merged result**, and
`git push origin HEAD:{base}`. A rejected push is retried once from the top
(somebody was faster); a second rejection is treated as a conflict. Only after
the push does the run become `done`, does the operator hear about it, do the other
agents learn that `main` moved, and do the flows fire — a flow then sees a run
whose work really is on `main`.

**A push that fails for any OTHER reason waits, and the wait is a due time the
loop honours — never a timer of its own** (`pushRetry`, `PUSH_RETRY_MS`). Five
failures escalate; escalating clears `finish_state`, so nothing can pick the run
back up. It used to be a `setTimeout`, and a timer outlives the decision it was
scheduled under: the fifth failure called a human, and the four timers still
pending from the failures before it walked the whole merge again — merging,
force-pushing the backup branch, escalating and notifying afresh, each wave
arming four more. Measured on run 0c1fc610: 28 push attempts, five
`merge_blocked` escalations, five `branch_backed_up` pushes and **five
notifications** about one broken pre-push hook, inside ten minutes. The due time
is also what makes the interval an interval: `integrateTick()` re-enqueues every
run still in `finish_state='merging'` on every 5-second pass, so before this the
five attempts collapsed into twenty seconds.

### The escalation ladder

| Situation | `merge_status` | What happens |
|---|---|---|
| worktree still dirty | `blocked_dirty` | **nothing is merged**, incident + notification, three one-click answers on the detail page |
| conflict, or a red merge check | `resolving` → `blocked_conflict` | a conflict run, up to `repos.merge_max_attempts` of them; then a human |
| git/network/auth error | `blocked_error` | incident + notification, "Merge now" retries |
| no `origin` remote | `blocked_no_remote` | incident + notification; the hub never merges in the operator's checkout |
| ended `failed`/`aborted` | `unmerged_*` | never merged automatically — named, backed up, and the operator decides |

A **conflict run** is an ordinary single run through `startRun()`: budget gate,
title, overview, watcher, incidents, and the same finish gate at its end. Its
setup lives under Settings → Merge and goes back into a run the one way there
is — `setupToFormBody()` → `runDefFromForm()`, the same pair a favorite uses
(the function was lifted out of `favorites.mjs`, where it only happened to sit).
It works on a **fresh branch of its own**, `resolve/<short id>`: a branch belongs
to exactly one worktree and the original's worktree holds its own, so taking it
away under a possibly still-standing session is the trap this file warns about
elsewhere. A branch from the same tip has the same content and costs nothing.
**No conflict run starts a conflict run** — a failed one counts against the
ORIGINAL run's attempts, and that loop guard sits in `escalate()`.

**`repos.conflict_parallel` (default 1)** bounds how many conflict runs work at
once per repo. Keep it at 1 for a small repository where every task touches the
same files: parallel resolvers then invalidate each other and only the first
one's work survives. Raise it for a large repository where conflicts rarely land
on the same files.

### The branch rule under `hub`, and keeping work on a branch

Under `merge_mode='off'` the branch rule answers "does this work survive": no
branch means a detached worktree and throwaway changes. Under `hub` it answers
nothing of the kind — the hub merges **every** run — and only decides under
which NAME the work travels:

| Rule | `off` | `hub` |
|---|---|---|
| **no branch** | detached, throwaway unless the agent pushes it somewhere itself | detached; the commits are merged into `{base}` at the end. Where a name is needed anyway (backup, conflict run) it is `run/<short id>` |
| **new branch** | a branch from the pattern; whether it reaches `{base}` is up to the agent | the same branch, merged into `{base}` at the end — pick it for a readable name on origin |
| **existing branch** | continue across several runs | the same, and merged after **every** run — unless "keep on branch" says otherwise |

The form said none of this, and the prompt sentence for "no branch" still
promised *"changes are throwaway changes"* — in the same prompt where
`MERGE_RULE` promised the opposite. Both now come out of **one** table,
`BRANCH_MODE_INFO` in `run-def.mjs`: the i18n key of each explanation and the
English sentence the agent reads, per merge mode. `branchRuleText()` is what
`launchRun` calls instead of the inline ternary it used to carry, and a unit
test checks that every `explain` key really exists in `lang/en.json` — a table
may not name a string that is not there.

The form renders **both** explanations and lets CSS show the one that fits
`data-merge-mode` on the fieldset. So the static case needs no JavaScript, and
the only form that can change repo without rebuilding the page — the Quick-Run
dialog, which has a repo `<select>` while the header's switcher reloads — just
flips that attribute from a `repoId → mode` map, and rewrites the `<span
data-base>` inside the sentences so a repo with a base branch of its own is not
described with somebody else's.

**"Keep the work on its branch"** (`runs.keep_on_branch`) is for the long-lived
branch: a documentation branch, a spike, an agent that works on the same
`fest` branch for a week. Only offered under `hub` (the checkbox carries
`hidden` from the server as well as the CSS rule, so it is gone without the
stylesheet too), and refused with "no branch" — keeping work on a branch needs a
branch. What the integrator then does is a **short** version of the finish gate:

- the **dirt check stays** — a run is only over when its work is committed, and
  M1 is the same message as ever;
- **no dry run, no merge**; instead the branch is pushed to origin (the same
  `backupBranch()` the backup rule uses), `merge_status='kept_on_branch'`,
  event `branch_kept`, and the done message reads
  `Kept on branch <name> — not merged, as configured`;
- a **failed push is an escalation**, like a merge that cannot be pushed:
  the operator wants nothing living only on this machine;
- it sends no "main has moved" (nothing moved) but still receives one, and it
  fires no `run_merged` flow, because there was no merge;
- the prompt gets the `keep` sentence **instead of** `MERGE_RULE`. Two rules
  about the same thing is one too many — that is the lesson this whole table was
  written from;
- **"Merge now" is offered anyway.** Keeping the work on its branch is what
  happened automatically at the end of the run, not a verdict for all time; the
  click clears the flag and runs the ordinary path, dry run and all.

### The conflict run is not a normal run

`isResolverRun(run)` — `!!run.resolves_run_id`, one predicate in
`integrate.mjs`, and every one of the rules below asks it. A conflict run is a
**tool of the integrator**, not work anybody asked for. It shares the start path,
a worktree, a session, the watcher (activity, incidents, cost) and its row in the
overview, which says what it is for ("conflict run for …"). Everything else is
off:

| What | Why |
|---|---|
| **No notification of its own**, in any state — `notifyRun()` returns at the top | The operator hears about the run it works FOR: T-RESOLVING at the start, the done line naming the resolver after the merge, T-BLOCKED-CONFLICT when it did not get there. Three messages about one problem is two too many. |
| **No flows** — `flows=NULL`, `flow_dispatched=1`, `merge_dispatched=1` at creation | A flow must not fire for a run the operator never started, and the *merge* it carries belongs to the run it worked FOR: `run_merged` fires once per integration, on the original. Both flags are set at creation rather than at the end, because that is what the triggers poll on — and `dispatchMerges()` skips a `resolves_run_id` row for the same reason, so the two sides agree instead of depending on each other. |
| **No generated title** | It is called `Resolve conflicts: <original title>`; a model would only make that less clear. |
| **Never `unmerged_*` / `blocked_*`, never a `merge_blocked` incident** | Everything that goes wrong here is mapped onto the original: `escalate(original, 'resolver_failed')` → attempts → the next conflict run or `blocked_conflict`. It only ever carries `merged` or nothing. |
| **The finish gate is help, not a gate** | M1/M2/M4 reach it while it lives. Deadline gone or agent dead → `escalate(original, 'resolver_failed')` — **never** a conflict run for a conflict run. That is the recursion guard, and it is the reason the predicate exists. |
| **No `assessUnmerged()`** on `failed`/`aborted` | Same: not a decision for the operator, an answer the original still needs. |
| **No "main has moved"** | It has exactly one job; a notice about a moving base branch is noise inside it. |
| **`max_parallel` counts it but never blocks it** | It starts on the manual path. Its own ceiling is `conflict_parallel`. |
| **No retry button** | A conflict run is never repeated — "Merge now" on the original starts a fresh one, with a fresh branch. Renaming and archiving stay. |

### "main has moved" is built in, not a flow

After every merge the other running agents of the repo are told — urgently
(`M5a`) when the merge touched files they are working on too, as a note (`M5b`)
otherwise. Built into the hub on purpose: a flow would have to be attached to
every agent, and a forgotten attachment is invisible. Not to a run in
`waiting_help`, because a text typed into a session that is waiting for a human's
answer is read by the agent AS that answer — which is exactly why the send route
and the flow step switch such a run back to `running` first.

### `failed` and `aborted` are never merged automatically

`assessUnmerged()` runs on every path a run can end badly and writes
`unmerged_commits` / `unmerged_both` / `unmerged_dirty` / `nothing`. A failed
run's work is not automatically wanted — but it is **named**, so nobody has to go
looking, and the notification carries the paragraph plus the resume command
(`resumeCommand(run)`, a plugin capability, see `docs/plugins.md`). The detail
page has the buttons: merge now, commit or discard the leftovers and merge, or
skip. That is why there is no `merge_when` setting.

### Nothing lives only on this machine

The remote is the backup, and that is a rule beyond the integrator:

1. **The integrator knows no local merge.** Its only way out is
   `push origin HEAD:{base}`. A merge that cannot be pushed is thrown away
   (`reset --hard origin/{base}`) and escalated. There is no state "merged, but
   only locally".
2. **The operator's own commits on `{base}` are pushed by the hub**
   (`pushOperatorBase()`, in the watcher pass, throttled to once a minute per
   repo). A **push touches no working tree**, which is why it is the one git
   command the hub runs in the operator's checkout — `merge`, `checkout` and
   `reset` stay forbidden there. Diverged? **Never `--force`**: a global incident
   plus a notification, and a human reconciles it. Success sets `repos.last_push_at`,
   shown on the Repos page.
3. **Work that nobody merged is pushed as a branch** — the run's own branch, or
   `run/<short id>` for a detached worktree (`branch_backed_up`). Same intention
   as the existing `anomaly:unpushed`, only carried out instead of reported.
   Remote branches are **not** deleted after a merge in v1: visible history is
   cheaper than an accidental deletion.

### Follow-up reports: a finished run can report again

Three of the four coding agents stay in their TUI after `fl-report done`, and
the run's terminal stays writable for exactly that reason (see "The work is
done — who is still there"). So the ordinary shape of a day is: the report
arrives, the operator sees that something is not finished, types the rest into
the same session, the agent does it and commits — and until this existed
**nothing happened next**. `handleReport()` refused a finished run, the
commits sat in the worktree, no merge, no flow, no message.

A report from a finished run is a **follow-up report** now
(`handleFollowUp()` in `reports.mjs`). Four decisions, each deliberate:

- **The same command, not a second one.** The agent runs `fl-report done
  --file <report>` again, exactly as the prompt already told it to. The hub
  tells a first report from a follow-up by the run's status; the agent does
  not have to know, and a second verb would be a second thing to forget. The
  prompt's last block (`FOLLOWUP_RULES` in `runner.mjs`) says so, says that
  the same platform processes run again (integration, flows), asks for a
  report about ONLY the follow-up work, and asks for **one report per batch**:
  several requests in one go are one report at the end, not one per request —
  every report is a message to a person's phone. A mere answer that changed
  nothing is not reported unless the human asked for it.
- **Same gate, same integrator, same escalation.** The follow-up's text is
  appended to `report_md` under `## Follow-up report #n (…)` and kept on its
  own in `followup_md`; `followups` counts them. Then `finishGate()` runs as
  for a first report (`finish_started_at` is reset — the deadline counts from
  THIS report), the integrator merges, and `followup_open` is what tells its
  three ends — `finishMerged`, `closeKept`, `blockRun` — that this integration
  belongs to a follow-up. They call `completeFollowUp()`, the one function
  that makes a follow-up visible: the `followup_done` event, the flows fired
  again (`rearmDispatch()` in `flows/db.mjs` takes `flow_dispatched` back,
  and `merge_dispatched` too when the follow-up merged), and the notification.
  Nothing about the merge itself is different, which is why `merged_sha`
  simply moves to the new tip.
- **The status does not change.** A `done` run stays `done`, a `failed` one
  stays `failed`: the record is the truth about the first attempt, and what
  the follow-up delivered is in the merge line and the report. `finishMerged`
  and `escalate` write `status` conditionally for that reason. A run whose
  agent reports `failed`, `help` or `progress` after its end gets the event
  and the message (help calls and failures are never deduplicated) and keeps
  its status; hooks on a finished run are what they always were — nothing —
  except `_exit`/`_pane_died` on a follow-up in the gate (the agent is gone:
  `escalate('agent_gone')`, and `reconcileClosedSession()` does the same for
  a vanished session) and cursor's `_turn_end`.
- **cursor's net exists for follow-ups too, and only for commits.**
  `wantsTurnEndFollowUp()`: a turn end on a finished cursor run counts as its
  follow-up report when the worktree's tip has moved past `merged_sha` — the
  case where work would otherwise never reach the base branch. A follow-up
  that changed nothing (an answer, a list) has to be reported by the agent
  itself; without a `merged_sha` (merge mode off) there is nothing to compare
  against and the net stays out of it.

**The commission is its own half, and it is what the operator sees.** The
follow-up REPORT is the end of the story; its start is the moment the operator
types instructions into a finished run's session (`POST /api/runs/<id>/send`).
That send is a **follow-up commission** now — the exact moment, deterministic,
because a human typing into the session IS the commissioning, and neither
activity nor tmux output can say it earlier or more precisely (an idle TUI
produces no activity, and a log line proves nothing — the log scanner's whole
lesson). `runs.followup_since` carries it, and three things hang on it:

- **The run displays as running again.** `status` keeps the first attempt's
  truth, but the overview and the detail page show the running word, the
  follow-up line names the moment (`run.followup_active`), the sidebar counts
  the run under "running" and the overview sorts and filters it there
  (`followUpActive()` / `displayStatus()` in pages.mjs). The terminal summary
  says "live" again; the button under it stays the finished one — ending such
  a run ends its SESSION, never its record.
- **The expected duration applies from the commission** (`watchFollowUps()` in
  watcher.mjs, its own pass — `watchRun()` only ever sees running runs): soft
  overrun at 80 % (`anomaly:followup_soft_overrun`, yellow, like
  `anomaly:soft_overrun`), overrun at 100 % with a notification
  (`followup_overrun` — its own type, so a first attempt's page does not mute
  the follow-up's). Each new instruction restarts the clock and retracts the
  old statement the way a raised duration retracts one; a follow-up `progress`
  report clears the anomalies (but not the flag, like a first run); the clock
  stops when the follow-up reports (`endFollowUpCommission()`), when the
  session is closed (kill route, `reconcileClosedSession()`) — or when the
  watcher finds the pane dead (`followup_agent_gone`): a process that exited
  can never report, so waiting out the deadline would only produce a
  misleading alarm.
- **The duration stays editable while the commission is open**
  (`runEditAllowed()`): a finished run with `followup_since`/`followup_open`
  allows exactly what a running one does — the live-read expected duration.

**The message says which one it is.** A follow-up arrives as `<repo> / <name>
FOLLOW-UP REPORT #n:` with a `✅ Follow-up #n done` status line that carries
the time since the previous report instead of the run's duration
(`followUpText()`), never deduplicated (type `followup`). A blocked follow-up
sends only the block (`T_BLOCKED_*`, now `dedupe: false` — a run blocked
twice is blocked twice), not a second message about the same moment.

**And the checkbox under the terminal is the answer to "I am sitting right
here".** `runs.telegram_on` (default 1 for every run, `notifySwitch()` in
pages.mjs, `POST /api/runs/<id>/notify`) is read at send time by `notifyRun()`
and by the incident alarms: unticked means **no message about this run** on any
configured channel — reports, follow-ups, alarms, incidents — and nothing else
changes. The integration, the flows and the events happen exactly as before;
a suppressed message is written down as `notify_muted`, and the `notified:*`
flag is deliberately NOT set, so switching the box back on lets the same type
through again. The COLUMN keeps its historic name: renaming one is a table
rebuild, which is the same "a migration for nothing" rule that leaves
`openrouter_min_eur` holding dollars — and `/api/runs/<id>/telegram` stays as an
alias of the route for the same reason. It sits under `#term` and outside the
run-detail fragment for the same reason the terminal does: a live update must
not flip a box the operator just clicked. Deliberately no time-based
heuristic ("the operator wrote into the session two minutes ago, so do not
page"): whether a report is wanted on the phone is the operator's call, and a
box says it in one click where a guess would sometimes be wrong in the
expensive direction.

### Visibility, and the one rule the whole thing hangs on

The overview's status cell carries the finish state under the status word (and
the merge status on a finished run), the detail page has an "Integration" line
with the buttons, and a blocked merge is a `merge_blocked` incident — which puts
it in the sidebar's "Needs you" group on every page. The repo form's
"Integration" block ends with the flows that run **after** a merge
(`mergeFlowsBlock`), and the repo list's Integration column says how many there
are: a `run_merged` flow hangs on the repository, not on an agent, so this is
where one goes looking for it. None of it needs a second
renderer, because **every** change of `finish_state`/`merge_status` goes through
`addEvent()` and the live channel re-fetches the fragment. There is no silent
`UPDATE runs` on this path, and that is not a style preference: it is what makes
the pages agree with the database.

`repos.max_parallel` (0 = unlimited) belongs here too: it bounds the SCHEDULED
starts of a repo — the timetable and the planned single runs. A start the
operator triggers by hand is never blocked, because a limit that overrules a
deliberate decision is a limit one works around.

## Tests

```bash
node test/unit.mjs          # pure logic (cron, schedules, quota gate, parsers, registries, i18n, docs,
                            # the finish gate's decisions and its texts) — ~1 s
node test/e2e.mjs           # complete hub in a sandbox, stub instead of real agents — ~40 s
node test/e2e.mjs --echt    # additionally ONE real run per harness (consumes quota)
node test/e2e.mjs --keep    # keep the sandbox (debugging)
node test/browser.mjs       # public/hub.js in a real Chromium — ~10 s
node test/proxy.mjs         # vpn-proxy.mjs against a stub upstream — <1 s
node test/deploy.mjs        # bin/freilauf-deploy against a bare origin — ~3 s
```

`test/deploy.mjs` is the odd one out because the thing it tests restarts
services and installs scripts into `~/.local/bin`. It therefore runs with `HOME`,
`FREILAUF_DEPLOY_DIR` and `PATH` all pointed into a sandbox, the last of them at a
shim directory holding `systemctl`, `curl`, `npm` and `journalctl`: they log
every call and answer what the test dictates — `curl` reads its HTTP status from
a file, one per line, each consumed once, which is what makes "the deploy is
unhealthy but the rollback is fine" expressible at all. Git, `flock` and the
checkout are real; that is the half a stub could not test.

The same suite covers the whole rename transition, because that is where it
lives: `systemctl`'s shim reads the name of the ACTIVE unit from a file, so
"deployed onto an installation that is still run by `cchub.service`" and
"deployed onto a migrated one" are two tests instead of an argument; the shims
are checked by really running `~/.local/bin/cc-report` and reading what
`fl-report` said back; and `setup/migrate-from-cc-hub.sh` runs against a whole
fake old installation built inside the sandbox `HOME` — old config directory
with `CCHUB_` keys, old data directory with `cc-hub.db`, an old deploy checkout
with the old remote, old unit files, the old opencode plugin, and a `flows` row
whose command still says `cchub-deploy`. `--dry-run` first (and nothing that
moves systemd may be called), then the real run, then a second run to prove it is
a no-op, then the both-directories-exist case, which must refuse.

The e2e suite starts a **second hub** on a free port with its own database, its
own test repo and its own `fl-start` stub. It may therefore run at any time
alongside production: the production database, `~/agents` and foreign tmux
sessions are never touched, and only sessions the suite created itself are
killed (also on Ctrl-C). Watcher passes are triggered directly instead of
waiting for the 30-second interval. That sandbox lives in
**`test/sandkasten.mjs`** — one construction, two suites, because a second copy
of it would drift the way the run definition once did.

**The sandbox kills what its own stub created, and the stub writes the list.**
That used to be a `sessions` Set filled by two helpers, so every run started
along another path — the scheduler, a flow, a conflict run, a retry — created a
tmux session nothing would ever kill. One per suite run is enough: agents working
on this repository run the suite dozens of times a day, and the machine ended up
with 157 live sessions, 11 of them belonging to the running hub, together holding
gigabytes of RSS while it sat in swap. The leftovers are recognizable by their
`-2` suffix — the stub's own collision loop, firing because a retry reuses the
run id while the first session is still standing. The stub knows the name it
created and cannot forget to write it down, so `$SB/sessions.txt` is the list and
`aufraeumen()` reads it. Still no pattern across all `fl-*`: that file holds
exactly the sessions THIS sandbox produced.

The sandbox repo has a **bare `origin`** next to it, which is what lets the
integration be tested for real: the group "Integration: a run is done when its
work is on the base branch" walks a clean run through to a merge commit on
`origin/main`, holds a dirty one and reads the hub's answer, produces a real
conflict, watches a conflict run take over and both runs end up merged, hits the
attempt limit, kills an agent mid-gate, fails a merge check, and pushes an
operator commit to origin. The suite **owns the integrator's clock**
(`FREILAUF_INTEGRATOR_OFF=1`): two processes driving one integration worktree is a
race nobody wants to debug, so the hub still integrates on the report path and
the suite calls `integrateTick(nowMs)` itself. The last test in the group turns
`merge_mode` back to `off` — everything before it is the proof that without the
setting nothing runs differently.

**Why there is a browser suite.** `public/hub.js` was 746 lines with not one
test, because no browser ran in the suite: everything else stops at the HTML the
server sends. And the ways that file breaks are all **silent** — a dead listener
throws nothing, the selects simply never fill, the terminal is a black box, the
pencil does nothing. `test/browser.mjs` therefore drives Chromium against a
sandbox hub and writes down what hub.js does today: the relative times that tick
by themselves, the schedule and start-time blocks (the latter **per fieldset** —
the Quick-Run dialog puts that block on the page twice), the Quick Run that
clears only the task, inline renaming including its guard against sending twice,
the form parked in `sessionStorage` while one builds a flow, the
provider/model/effort cascade, the sessions page's optimistic ending, and both
branches of the terminal. Every test also fails on an exception in the browser
console, because that is where a silent break first shows.

**Why there is a proxy suite.** AGENTS.md has carried the sentence "a green test
against 127.0.0.1 says NOTHING about the path through the TLS proxy" for a long
time, and nothing tested that path at all — which is exactly where the three
slowdowns above were hiding. `test/proxy.mjs` starts `vpn-proxy.mjs` against a
**stub** upstream, because what is being tested is what the proxy does with a
connection and a stub can COUNT its connections: ALPN really offers h2 and still
falls back to http/1.1 for the terminal, an SSE stream survives the hop-by-hop
headers h2 forbids, and eight abandoned streams leave **not one** socket behind.
It is part of `npm test` (it needs only openssl, and reports itself skipped and
green without it).

It is **not** part of `npm test`: it needs `playwright` (a devDependency) and a
Chromium. Without either, the suite reports itself skipped and ends green —
whoever has no browser must not sit in front of a red test.

## Models, providers and reasoning effort

None of this is typed into the code — everything comes from its authoritative
source, and since the rebuild "the code" means the plugin registry rather than a
list in a call site:

| What | From | Why not otherwise |
|---|---|---|
| Which coding agents exist at all | the registry: `server/harnesses/` plus every external package under `FREILAUF_PLUGIN_DIR` | a coding agent known only at runtime cannot be a literal anywhere; that is the CHECK the rebuild deleted |
| Which providers exist at all | the registry: `server/providers/` plus external packages | same |
| Providers per harness | harness plugin (`providers`, `keyFreeProviders`) ∩ operator selection | claude runs only on the subscription; hermes needs a key for Zen/DeepSeek, opencode does not |
| Whether a provider may be offered at all | `pluginHasCredential(id)` — stored value, named variable, or a declared one in the environment | it used to be `providerHasKey()`, which reads `process.env` and nothing else, so a key the operator stored in the UI was honoured at launch and still missing from the form |
| Models for the hub's OWN questions | the chosen source plugin's `llm.models()` | the picker is one flat list of sources; the model list belongs to whichever one is picked |
| Models for opencode | `opencode models --pure` | opencode's provider list is credential-gated; the vendor catalog contains models that would fail here immediately |
| Models for hermes | vendor API or `models.dev` | hermes has no own list |
| Models for claude | maintained list in `server/harnesses/claude.mjs` | without an API key there is no catalog; free input always stays possible |
| Models for cursor | `cursor-agent models` | account-bound (comes from the server); the CLI names the same list when rejecting |
| Effort claude | `claude --effort __probe__` — the CLI names its levels itself | no settings key, no reliable env variable |
| Effort hermes | `hermes chat --help` ∩ model levels | hermes does NOT validate and silently runs with the default on nonsense |
| Effort opencode | model catalog (`~/.cache/opencode/models.json`) | opencode discards an unknown variant **silently** |
| Effort cursor | is part **of the model ID** (`…-low/-medium/-high/-xhigh/-max`) | cursor-agent has no `--effort`; the field stays out of the form |

Pass-through: claude `--effort`, hermes `--reasoning` (fl-start translates),
opencode via `OPENCODE_CONFIG_CONTENT` with `agent.build.{model,variant}` — the
variant only works when the model is set in the same block. Verification:
`~/.local/state/opencode/model.json` records the last used variant per model.
cursor gets **only** `--model` with an ID that `cursor-agent models` printed
verbatim — nothing is assembled there.

### cursor in particular

The ~200 flat IDs are base × effort level × fast, already multiplied out. That is
why the hub does **not** split into base + effort: an ID built that way might
not exist at all, and `<datalist>` filters them just as well as the ~360 from
OpenRouter. IDs ending in `-fast` are cursor's fast mode (more expensive) — they
sort last and are marked; the default is the variant without. `auto` is part of
the same list and hence a valid `--model` value: cursor then routes to its own
models (composer/vega/grok), which draw on the Cursor-models pool of the
included usage rather than the third-party one. It sorts first and is marked.

**cursor reads the Claude configuration along** — measured with canary code
words in an empty repo, all three confirmed:

| Source | Result |
|---|---|
| `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` | loaded as a rules file |
| `.claude/skills/*/SKILL.md` | loaded as a skill |
| `.claude/agents/*.md` | registered as a subagent (real `tool_call`, not file reading) |

In the binary this hangs on `thirdPartyExtensibilityEnabled` (default **on**);
also read are `.claude/settings.json`, `.claude/settings.local.json`,
`.claude/commands` and Claude **hooks**. There is **no** local switch for it —
`allow_third_party_plugin_imports` is a server-side team/enterprise field.

Consequence for Freilauf: a cursor run pulls in `~/.claude/skills` and the
worktree's `CLAUDE.md` **automatically**. The opt-in idea behind
`~/agents/zusaetze/` (deliberately no `.claude/skills` folder) therefore only
half applies to cursor — the run sees more than its prompt plus the checked
extras.

### cursor: when a run is over

**cursor's TUI stays standing after the work is done** ("→ Add a follow-up").
The pane never dies, the process never exits — so `_pane_died` and `_exit`, the
last safety nets under every other harness, never fire. Until this was built, a
cursor run whose agent forgot `fl-report done` stood on `running` **forever**,
and a single run waiting for "when no other run of this repo is going" waited
behind it just as long. Measured on 2026-08-25: one forgotten report held up four
runs, among them the one meant to fix exactly this.

Two channels report the end, and both end in `finishByTurnEnd()`
(`reports.mjs`) — the single place that knows a turn end can be a run's end:

| Channel | What | Speed |
|---|---|---|
| `stop` hook | `runner.mjs` writes `.cursor/hooks.json` into the worktree before the start (`hookFiles()` in the plugin); `stop` fires when the agent ends its turn while the session stays alive, `sessionEnd` when the process really exits | within a second |
| transcript | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` ends a finished turn with `{"type":"turn_ended"}` (`server/cursor-transcript.mjs`) | next watcher pass |

The transcript is not decoration: an existing `.cursor/hooks.json` is **never**
overwritten (a repository may bring its own tooling), and a cursor release could
rename the event. It also finally gives cursor an **activity source** — the file
grows while the agent works (measured: 325 → 693 → 994 → 1302 bytes across three
tool calls, mtime advancing each time), which is what `measureActivity()` reads.

Only from status `running`. `waiting_help` means the agent asked a question and
is deliberately idle until a human answers — ending its turn is correct there,
not the end of the work (the answer via `/api/runs/<id>/send` puts it back on
`running`). A run that reported properly is already `done` when the hook fires,
because `fl-report` is a tool call *inside* the turn and the hook comes after it
— so this only ever catches the case it is meant for. What it writes as the
report is the agent's own closing message from the transcript, plus one line
saying that the platform, not the agent, closed the run.

**Detecting the end three times must still notify once.** Two channels here plus
`sessionEnd`'s `_exit` all run into `handleReport()`, and `handleReport()` is
what notifies — so the fences against a run ringing the phone three times about
the same thing are load-bearing, not incidental: `handleReport()` accepts a run
only in `running`/`waiting_help`, `finishByTurnEnd()` fires only from `running`,
and `notifyRun()` carries a `notified:<type>` flag per run. Whichever channel
gets there first closes the run; the others find it finished and fall out. The
e2e suite fires all three at one run and asserts a single `notified:done` ("all
three end channels together notify exactly once") — remove any of the three
fences and that test goes red.

The hook file is the hub's, not the agent's work: `harnessOwnedPaths()` keeps
the worktree cleanup from counting it as uncommitted changes (the same trap the
worktree extras once fell into), and this repo gitignores `.cursor/hooks.json`.

**And the prompt says it too**, because the detection is the net and not the
plan. `platformSuffix()` builds four sections, and the order is the point:

1. the platform rules (working directory, branch, duration, help/branch/pr/failed)
2. the operator's own addition — **Settings → Platform prompt suffix**
3. the harness's own lines (`promptRules`): cursor is told that its turn ending
   closes the run and that a summary printed into the TUI is not a report
4. **how the run ends** — last, because that is what runs actually fail on:
   write the report to `{report_file}` (→ `~/agents/runs/<id>/report.md`,
   deliberately outside the worktree so a report file cannot leave it dirty),
   then `fl-report done --file <that path>`, then stop.

**Section 4 cannot be removed, and that is a lesson rather than a preference.**
The settings field used to *replace* this whole block. It is called a suffix, it
starts out empty and it looks like a free notepad — so the day somebody wrote
their own working rules into it, every prompt on this hub silently lost the
sentence "at the end always `fl-report done`". The runs kept working and kept not
reporting. Whatever is written there is an addition now, placed where it reads
like one; for rules that concern a single repository the repo prompt is still the
better place.

## No-code flows

`server/flows/` — a self-contained module (own tables, pages, API, designer
client) that reacts to finished runs, a cron schedule or a button with
building blocks: message running agents, start agents/single runs (optionally
waiting for their result), extract structured data from a report via LLM,
branch on the outcome, loop over a list, notify, HTTP, delay.

**A flow is not a place you navigate to** — there is no "Flows" nav entry. A
flow hangs on the agent or the single run whose end starts it: both forms carry
the attachment block (`flowAttachFields` in `flows/attach.mjs`, embedded by
`runDefFields` like the extra skills), and the flow pages are reached from
there and from the button on the agents page. When a run ends, **every**
attached flow starts — all of them in parallel, the way a no-code platform fans
a trigger out.

The one trigger that is **not** an attachment is `run_merged`: it fires once per
merge into a repo's base branch and carries its own filter, the repo, because a
merge belongs to the repository and may be carried by a conflict run that never
hung on an agent — its way in is therefore the repo form, not the agents page.
Together with the `shell_command` block (a command on the hub machine, exit code
as a result rather than a failure, optionally detached) that is what lets a flow
restart the hub after a merge.

The attachment carries the condition (`always`, only on `done`/`failed`/
`aborted`, or `not_done`), so the case distinction is made where one thinks of
it. It does **not** replace `switch_outcome`: that block branches on the result
of a run the flow started **itself**, which no attachment can know about.

Agent side and flow side cannot drift because there is only **one** storage:
`agents.flows` (snapshotted into `runs.flows` when the run is created, like
every other definition field). The agent form writes it, the flow editor's
trigger panel writes the same rows from the other side (`agentsWithFlow`,
`setFlowAttachments`), and the `run_finished` trigger itself carries no filter
at all any more — a filter next to the attachment would be a second copy of the
same statement. Older triggers (`agentIds`/`repoId`/`outcomes`/`singleRuns`)
are converted into attachments once, at startup, in `flows/db.mjs`.

Variables are **typed**, not guessed: `varschema.mjs` knows for every spot in a
flow which variables exist there, of which type and with which allowed values —
so a condition picks its left side from a list, its operator is narrowed to what
that type can answer, and a boolean or an enum is chosen instead of typed. The
same module runs in the browser (served under `/static/flows/`), so the designer
and the server judge a flow by identical code. It also carries the placement
rules: `switch_outcome` needs a finished run, and the designer refuses the drop
with the reason instead of silently not sticking.

Architecture, step registry contract and the integration seams:
**[server/flows/AGENTS.md](server/flows/AGENTS.md)**.

## tmux sessions: the machine, not the bookkeeping

`server/sessions.mjs` + the **Sessions** page. Every other page shows what the
hub *recorded*; this one shows what the machine is actually *holding* — and it
is the only place where a session can be ended by hand.

A session deliberately outlives its agent: `fl-start --keep` sets
`remain-on-exit`, so the screen stays readable afterwards. The price is a
process keeping its memory until the session goes, and with the old rule that
bill ran for days (thirty sessions, 15 GB, measured).

- **Running agents are hidden by default.** The row you must not hit by accident
  is not within reach of the mouse; one checkbox shows them, and the choice
  lives in `localStorage`. Ending one of them asks first — that confirmation is
  the only friction on the page.
- **Oldest first**, because that is the order one cleans up in.
- **Nothing blocks.** A click marks its row "ending …" in the same tick and the
  request goes off in the background; several rows can be clicked away in a row,
  and `POST /api/sessions/kill` takes any number of names and kills them
  concurrently. Only what the server confirms is struck through.
- Shown per session: age, last activity, state, the run behind it, the pane's
  command, and **RSS/CPU of the whole process tree** (one `ps`, summed from the
  pane PID down) — the pane itself is only a shell and would understate it by an
  order of magnitude.
- **The sum of all of it is in the status sidebar**, on every page
  (`sessionMemory()`, see there): the bill this page exists for runs quietly, so
  the one number that says how big it has grown must not need a navigation to be
  seen.

### The work is done — who is still there, and who only left a screen

Three of the four coding agents keep running after the task is finished, and
that is not a detail of the terminal but the reason it exists (measured
2026-08-27, one trivial prompt each):

| Coding agent | Command (`fl-start`) | When the work is done |
|---|---|---|
| claude | `claude --permission-mode dontAsk "$FL_PROMPT"` | stays in its TUI, pane alive — production sessions on `done` runs still had a live `claude` pane 19 h later |
| opencode | `opencode --auto --prompt "$FL_PROMPT"` | stays in its TUI, pane alive |
| cursor | `cursor-agent --force --trust -- "$FL_PROMPT"` | stays at "→ Add a follow-up", pane alive — this is what `finishByTurnEnd()` exists for |
| hermes | `hermes chat -q "$FL_PROMPT" --yolo` | **used to exit**, and since 0.21 stays in its TUI too. Measured 2026-08-27 on the older release: `-q` was "single query (non-interactive mode)", it printed its answer plus a `hermes --resume …` line and the process ended (dead pane, status 0, 9 s after the start). Measured 2026-09-05 on 0.21: on a real TTY `-q` **seeds an interactive session** — the query is submitted as the first turn and the process stays, pane alive, input line drawn; only `--oneshot`, `-Q` or a non-TTY give the old behaviour. The hub's own questions still use `-Q` and get the one-shot |

So a standing session and a reachable agent are two different facts, and only
`pane_dead` tells them apart — `remain-on-exit` keeps a crashed run's screen,
and it kept hermes's screen back when hermes exited. `paneAlive()`
(sessions.mjs) is that one question, one `tmux list-panes` per detail page.

**Which is why the run's terminal is writable as long as its SESSION is**, not
as long as its status says `running`. It used to hang on the status, and that
locked the operator out of the ordinary case: the run reports `done`, the agent
is still sitting in its TUI ready for a follow-up, and the page showed a
read-only screen of it. `pageRun()` therefore asks for the session and the pane,
never for the status; the status only decides the BUTTON underneath — a run
still in flight is ended (`/api/runs/<id>/kill`, sets `aborted`), a finished one
only loses the session it left standing (`/api/sessions/kill` with a `back`,
which leaves the record alone). `/api/runs/<id>/kill` enforces the same rule
from its own side — with one deliberate exception: on `done`/`aborted` it closes
the session and writes `tmux_closed` instead of rewriting a clean run, but a
**`failed` run it sets to `aborted`**. The cancel button was rendered while the
run was still going, so a click landing after the watcher has written `failed`
(measured: two seconds after a pane death) is still a cancel — the final status
says what the CLICK said, not what the race decided. An open follow-up
commission goes with it either way. What is sent
into a finished session is real work that this run no longer records, and the
retention clock keeps counting from the run's end — the page says so.

**Ending a session is a run event, not just a tmux call.**
`reconcileClosedSession()` is the single place that knows this: a run still on
`running`/`waiting_help` becomes `aborted` with an `ended_at` and a report line
saying why, and attached flows fire. Nothing could ever report for that run
again — leaving it on `running` is how the overview came to show runs that did
not exist. The watcher uses the same function when it finds a session gone (it
used to only set `tmux_closed_at` and leave the status alone), and so does the
retention pass.

### "tmux did not answer" is not "the session is gone"

That distinction did not exist, and its absence was the one way this hub could
end a working agent for no reason. `tmux list-sessions` and `tmux has-session`
report "there is no server" and "I could not answer you" through the **same
exit code**, and both call sites spent that as *gone*: `sessionLebt()` was
`sh(...).ok`, and `tmuxSessions()` returned `[]` on any failure. So one flaky
subprocess — the 30 s timeout in `sh()`, a fork that failed under memory
pressure, a server too busy to answer, a missing binary — made `watchRun()`
abort that run, and made the retention pass declare **every** tracked session
missing in one go. The run's own record then said `tmux session ended`, which
was not what had happened. Same family as `--no-optional-locks` reading an empty
status as a clean worktree, and `Number('')` reading as a configured `0`.

`tmuxVerdict(r)` is the three answers, pure and tested without a tmux server:

| verdict | what it means | measured wording (tmux 3.4) |
|---|---|---|
| `ok` | the command answered; its output is the truth | exit 0 |
| `no_server` | there is demonstrably no server, so no sessions. The empty truth | `error connecting to <socket> (No such file or directory)`, older: `no server running on <socket>` |
| `unreachable` | the hub learned **nothing** | everything else |

Four rules follow from it, and each one is a place where "nothing" used to be
spent as "gone":

- **`tmuxSnapshot()` carries the verdict**; `ok: false` means "no answer", never
  "empty". `tmuxSessions()` is its thin wrapper and keeps returning a bare list,
  which is right for the DISPLAY callers (the sessions page, the memory block) —
  showing nothing is the honest rendering of an unanswered question. Anything
  that **ends a run** reads the verdict. `tmuxSessionMap()` is gone on purpose:
  a Map cannot carry a verdict, and that is exactly how an unreachable tmux
  arrived as "no sessions anywhere".
- **`sessionGone(name)` is tri-state** — `true` / `false` / `null`. `watchRun()`
  skips a run entirely on `null` and tries again in 30 s: not knowing is a
  reason to wait, never a reason to end somebody's work. A session that really
  is gone stays gone and is caught on the next tick.
- **A live run's disappearance is confirmed twice** (`confirmGone()`): the
  listing says the session is missing, and `has-session` is then asked directly
  by name. Only `running`/`waiting_help` pays for that second call — for a
  finished run the listing is bookkeeping, for a live one it is somebody's work.
- **Losing every session at once is one fact, not N.** `tmux_gone` (tmux
  positively reports no server while the hub tracked ≥ 2 open sessions) and
  `tmux_unreachable` (no answer at all; the cleanup passes then do nothing)
  are global incidents in the "Needs you" group, and neither resolves by time —
  tmux answering again does not undo the sessions that died. Before this, a dead
  tmux server produced 22 silent `tmux_closed` rows plus one aborted run
  blaming its own session, and the only route to the real cause was reading the
  event log by hand.

**Retention is in hours and counts from the agent's end** (Settings → keep the
tmux session open, `session_keep_hours`, `0` = right away; the old
`retention_days` is still read as a fallback for an installation that has not
saved the field yet). The first version fired on a **dead pane** only — but a
claude that reported `done` and stays in its TUI keeps its pane alive forever,
which is exactly the set of sessions that was piling up. `finishedAtMs()`
therefore takes the **earlier** of the run's end and the process's end.

Automatic closing only ever touches sessions **that carry a run of this hub**.
The e2e suite and other hub instances share the same tmux server, and a pattern
across all `fl-*` would kill theirs; a foreign session is listed and ended by
hand, never by the watcher.

## Extra skills (opt-in)

`~/agents/zusaetze/<name>/SKILL.md` — **deliberately not** a `.claude/skills`
folder, otherwise every claude instance would load them automatically. (The
hub's OWN skills, one section further down, do live in those directories, and
for the opposite reason: they are about the hub, they are opt-in at
installation rather than per run, and an agent never reaches for them unless
the task is about Freilauf.) Every
folder with a SKILL.md appears as a checkbox in the agent and single-run forms
(`zusaetze.mjs`); when selected, the prompt gets the instruction to read and
apply the SKILL.md (full path). Installed commit-pinned via
`setup/02-install-scripts.sh` (currently: `unlazy` for lazy/small models), not
part of this repo. Path override for tests: `FREILAUF_ZUSAETZE_DIR`.

## Putting a repository away: deactivating, and the one delete in the hub

A repo row was create-and-edit only, and the third option people wanted was
"get this out of my way". It has two answers now, and the whole design is about
making sure the reversible one is the one they reach for.

### Deactivating is the answer, and it is reversible

`repos.active` (0/1, DEFAULT 1 so every repo that predates the column is
active). `POST /repos/toggle` — `id`, an optional `active=1|0` to set it
explicitly, an absent `active` to flip. The button sends the value it means; a
script should too, because two flips are a no-op.

What it does, and each half is load-bearing:

- **Gone from every repo-selection dropdown.** One query in `layout()` feeds
  both the header switcher and the Quick-Run dialog (the dialog takes the list
  as a parameter), so that is one place, not two. Plus `runEditCard()`'s
  "move this run", `agentMovePage()`, the agent form's repo fallback, the
  tmux-cleanup settings, `cleanup.mjs`'s default repo, and `reposList()` in
  `flows/web.mjs` for the designer's `repo` field.
- **It starts nothing.** `repoInactive(repoId)` in `scheduler.mjs` is asked by
  the tick (a `schedule_skipped` event with `reason: 'repo_inactive'`), by
  `pickUpScheduled()` (the planned run keeps waiting rather than failing — the
  repo coming back is all it needs), and by `startRun()` itself. The last one
  is why it is checked in ONE place rather than in the six callers, and why it
  is checked *before* `createRun()`: a refused start must not leave a row
  behind. Unlike `max_parallel` it gates the manual path too — a manual start
  is a deliberate decision about a *run*, and putting the *repository* away was
  a deliberate decision as well.
- **Its history stays reachable, and that is what makes it better than
  deleting.** `selectRepo()` resolves an explicit `?repo=` through `getRepo()`,
  which does not filter; only its two fallbacks (the cookie and "the first
  repo") skip an inactive one. So the overview, the archive, the run pages and
  the sidebar all still answer for it — nobody just *lands* there.
- **It stays on the Repos page**, marked, with the button to bring it back.
  That page is the one place that deliberately lists every repo: a repository
  one cannot see again is a repository one has lost.
- **Runs already in flight are not stopped.** Deactivating is about what starts
  next.
- **`pushOperatorBase()` deliberately keeps running for it.** That pass is the
  "nothing lives only on this machine" rule, not a start: it pushes the
  operator's own base-branch commits to origin, touches no working tree, and
  stopping it on a deactivated repo would mean a repository put away quietly
  stops being backed up. `branchContext()` is left unfiltered for the same kind
  of reason — it is a repoId → merge-mode map, and filtering it would blank the
  branch-rule sentence on the pages of an inactive repo's existing runs. So is
  the repo-name map behind `GET /api/agents`, or an agent in an inactive repo
  would lose the name of the repository it lives in.

### Deleting exists, and it is fenced twice

`POST /repos/delete` — `id` and `confirm`, which must equal the repo's exact
name. It removes the row, its agents, its runs, and the `events` and
`incidents` hanging off those runs, child rows first in one `BEGIN`/`COMMIT`.

- **The `confirm` token is not decoration.** This hub has no authentication, so
  everything reachable over HTTP is reachable by any process on the machine — a
  coding agent that misread an instruction included. Typing the name is what
  turns the call into an act, and it is what lets the agent-facing skill say
  "you cannot delete a repo, ask the human" and mean it. The browser keeps the
  button disabled until the typed name matches; the server checks it again,
  because a fence that only exists in the browser is not one.
- **Work in flight refuses.** A `running`, `waiting_help`, `scheduled` or
  `deferred` run would be deleted out from under a live tmux session. The
  refusal says how many.
- **The order of the deletes is required, not tidy.** `foreign_keys` really is
  ON here — `tabelleUmziehen()` switches it back on and leaves it there
  (measured; an earlier version of this section's own skill documentation
  claimed the opposite) — so `DELETE FROM repos` is *refused* while a run still
  references the row. Doing it child-first in a transaction also makes the
  operation all-or-nothing: a failure half way leaves the repository as it was,
  which is the one outcome better than a refused delete.
- **What it deliberately does not touch**, and the dialog says all of it before
  the click: the git checkout at `repos.path`, the worktrees under
  `~/agents/worktrees/<name>/`, the run directories under `~/agents/runs/<id>/`,
  and a `run_merged` flow that was scoped to this repo (it survives and simply
  never fires again). Freilauf removes its own bookkeeping, never somebody's
  code.
- **The dialog is the feature.** It reads the real counts out of the database
  (`repoDeleteFacts()`), names the paths that stay, requires the name, and — the
  reason it exists in this shape — offers **"just deactivate it instead"** right
  there, at the moment somebody is about to do the irreversible thing.

`node:sqlite`'s `DatabaseSync` has **no `.transaction()`**; that is
better-sqlite3's API, and reaching for it here cost a 500 and one e2e run to
notice. `BEGIN`/`COMMIT`/`ROLLBACK` through `db.exec`, like `tabelleUmziehen()`.

## Freilauf's own agent skills — shipped, installed, kept current

`skills/<name>/SKILL.md` in this repository is a family of **agent skills**
written to the open Agent Skills specification (agentskills.io): short
instruction files that teach ANY coding agent how to drive this hub — find and
read runs, create and edit agents and repositories, build flows, read the
status sidebar, and pick a model. They are the answer to a gap that had nothing
to do with features: everything the hub does was reachable from a script, and
nothing told an agent *how*.

They are **not** the mechanism in `zusaetze.mjs`, and the difference is the
whole design. The extra skills are opt-in per run and therefore deliberately
stay out of `.claude/skills`, because everything there is loaded
automatically. These are the opposite by intent — they are about the hub
itself, they are useless to a run that is not talking to it, and an agent's
description matcher never reaches for them otherwise. That is why they may live
in the automatic directories, and why the whole thing is **off** until the
operator says yes.

### Where they go falls out of the plugins, and comes to two directories

Where a coding agent looks for skills is the coding agent's own knowledge, so
it is a plugin declaration next to `launch`, `goal` and `hookFiles` —
`skills: { user: [...], project: [...] }`, user level and project level
separately (see [docs/plugins.md](docs/plugins.md)). All four shipped
declarations were read out of the installed CLIs, not guessed:

| Coding agent | user level | project level |
|---|---|---|
| claude | `~/.claude/skills` | `.claude/skills` |
| cursor | `~/.cursor/skills`, `~/.claude/skills`, `~/.agents/skills` | the same names inside the workspace |
| opencode | `~/.config/opencode/skill`, and **auto-loaded** `~/.claude/skills`, `~/.agents/skills` | `.opencode/skill`, `.claude/skills`, `.agents/skills` |
| hermes | `~/.hermes/skills` | `.hermes/skills`, `.agents/skills` (trusted checkouts only) |

**A skill installed twice is a skill answered twice**, so the installer does not
walk the coding agents — it computes the smallest set of directories that
covers all of them (`coveringUserRoots()`, a greedy set cover with a
deterministic tie-break: coverage first, then the summed preference rank, then
the path). For all four that is **two** directories, because only hermes stands
apart; for a machine running cursor alone it is `~/.cursor/skills`, its own.
Neither answer is written down anywhere.

The hub writes at **user level only**. The project declarations are shown on
the settings page and nothing else — the hub never writes into a repository,
which is also why none of this touches `harnessOwnedPaths()` or the finish
gate's dirty check.

### Removal may only ever take back what the hub wrote

Every installed directory carries `.freilauf-skill.json`, and
`<dataDir>/skills-installed.json` (`FREILAUF_SKILLS_STATE`) lists them. The
marker is the primary answer because it travels WITH the directory: a fresh
data directory loses the state file but not the knowledge of who wrote the
copy. A directory of the operator's own under a name the hub also ships is
**refused, never overwritten**, and reported as a conflict — on the way in and
on the way out.

**Copies, not symlinks.** Claude Code documents that it follows a symlinked
skill directory; the other three document nothing either way, and a symlink
into the deploy checkout dies the day that checkout is moved or re-cloned.

### Two switches, and saving IS the action

`skills_install` (default off) and `skills_auto_update` (default on), on their
own page — **Settings → Freilauf skills** — rather than in the big settings
form, because saving here *deletes files* and a handler that owns the whole
request is what can act on the transition. `syncSkills()` is one function for
both directions: install off removes everything the hub wrote, install on
ensures every skill exists in every target directory. Content is only refreshed
when automatic updating is on, and "current" is **measured** (`skillHash()` over
the target directory), not remembered from the marker — otherwise a copy edited
by hand would look current for ever and the switch would quietly mean "keep the
marker up to date".

**Which skills** is the operator's choice too (`skills_selected`, a JSON list
under "What is shipped"). Absent means ALL, and that is the
backwards-compatible reading rather than a convenience: an installation that
said yes before the setting existed has every skill on disk, and a default of
"none" would uninstall them on the next sync. Deselecting one takes the ordinary
removal path, so it is still marker-guarded and still only ever takes back what
the hub wrote. The `shared` skill is not selectable — nobody picks it — and
rides along whenever anything else is selected, going only when nothing is.
Keeping them current stays **one global switch**, because it is a statement
about maintenance and not about any particular skill.

The picker and the update switch are both `hidden` AND `disabled` while the
installation is off, and the form carries a `skills_pick` marker: a save that
did not carry the picker must not be read as "nothing selected", or saving from
a page where the boxes were invisible would wipe a choice nobody could see.

**Automatic updating is already paused for a copy another installation wrote** —
the foreign check in `syncSkills()` sits before the content comparison, so it
structurally cannot run over one. What was missing was saying so: while that
question is unanswered the page says updating is paused for those directories.
A switch that reads "on" while some directories are deliberately untouched is a
switch that lies.

It re-syncs at startup and after **every** write on the Plugins page, because
that is exactly when the set of target directories changes: a coding agent
switched on may read a directory nothing has been written to yet, and one
switched off leaves copies behind that nothing else would remove.
`syncSkillsQuiet()` never throws and logs only when something moved.

The **Welcome wizard** asks once, as step 5 — after the coding agents are
chosen, because which directories the hub would write to falls out of those
choices, and asking earlier would mean naming none.

Three rules about how the two pages present this, each of them a correction:

- **A `shared` skill is installed but not listed.** `freilauf-models` carries
  `metadata.freilauf_role: shared` in its own frontmatter — the spec's own place
  for a client's private key — and `availableSkills()` reads it out. The other
  five load it by relative path; nobody picks it, and a list that offers a thing
  nobody chooses is a list with noise in it. A footnote says one more comes
  along, without naming it, so the count of installed directories still adds up.
- **Descriptions are printed in full.** They are long because their job is to
  make an agent's matcher fire; truncating them at 240 characters ended
  sentences mid-word and read as a rendering fault rather than as a summary.
- **"Keep them up to date" only exists while the installation is on**, and it is
  `hidden` AND `disabled`, never just hidden. `checkbox()`'s hidden `0`
  companion would otherwise post `skills_auto_update=0` on every save made with
  the installation off, quietly overwriting a preference the operator had left
  on — the same trap the goal field already carries a rule about. Disabled,
  neither input travels, `Object.hasOwn()` is false, and the stored value
  survives. `hub.js` flips both on the install checkbox's own change event.

Both pages also say, in one paragraph, that the skills go in at **user level**
and are therefore available in every project, that scoping them per project is
not supported today, and where to ask for it (`skillScopeNote()`, shared by the
settings page and the wizard step).

### How an installed skill knows where its hub is

A skill is installed at USER level, so it is read by sessions Freilauf never
started — a human's own claude session in an unrelated project. There
`FL_HUB_URL` is unset, `~/.local/bin` may not be on the PATH, and on a machine
with two installations there is no single right answer anyway.

So the installation writes its own coordinates **next to the skill it
installs**: `.freilauf-skill.json` carries an `installation` block with the
data directory (the id — it is what actually distinguishes two hubs, and the
database lives in it), the local URL, the runs and worktrees directories (all
configurable, so a skill that hardcoded `~/agents/runs` would be wrong on half
the machines) and the running sha. The scripts read the file lying beside them.

Two of those coordinates are about the hub's own **files** rather than its API,
and they exist because one document is too long to copy: `app_dir` is the
directory the hub's code runs from — resolved from `skills.mjs` itself, the same
`import.meta.url` idiom as `skillsSourceDir()` and for the same reason, never
from `deployDir()` (a hub started by hand out of a checkout is still that
checkout's hub) and never from the cwd. `plugin_dir` is where an external plugin
package is installed to. Together they are what lets `freilauf-plugins` find
`docs/plugins.md` and list the installed packages **without a single line of
that contract being restated in a skill** — which is the one thing that would
have made the plugin skill worse than no skill at all.

Their order is: `FL_HUB_URL` (set in every run Freilauf starts, so a run always
reaches **its own** hub) → `FREILAUF_HUB_URL` (by hand) → the calling card →
`FREILAUF_LOCAL_PORT` from the operator's `env` → `127.0.0.1:8791`. Each
candidate is probed with `/api/usage` and **not** with a route the skills
themselves use: a hub older than the skill answers 404 for those, and "no hub
found" would send the reader after the wrong problem entirely.

`refreshMarker()` keeps the block current **even when automatic content updates
are off** — a moved port is not a change to the skill, and that switch is about
the skill's content, not about whether the file next to it still tells the truth.

### Two installations on one machine is a question, not a race

Both would target `~/.claude/skills`, and whoever synced last would own it —
including the coordinates the OTHER installation's skills read. They would take
the directory from each other for ever and neither would be right.

So `syncSkills()` compares the marker's `installation.id` with its own and
**leaves a foreign copy alone**, reporting it. Settings → Freilauf skills then
asks the only question worth asking: is this another installation's, or is it
mine wearing a new data directory? The second answer is one button
(`adopt`), which is deliberately an explicit act — a sync that adopted by itself
would be exactly the silent takeover the check exists to prevent.

### The tools the skills ship

`skills/*/scripts/`, standard library Python only, no venv, and written to the
principles a coding agent needs rather than a human's: no arguments prints the
overview, output is Markdown, the lists are capped with a drill-down hint
instead of dumped, and every answer ends in the command that would sensibly
come next.

- **`fl-options.py`** — every dropdown the web UI has, as a list: repos, agents,
  configured coding agents, one coding agent's providers/models/effort levels,
  favorites, flows. Plus `check k=v …`, which validates a run definition against
  THIS installation and names the valid values for whatever is wrong, and
  `new`, which prints a ready command pre-filled from a favorite. It is shipped
  by the runs, agents and flows skills, **byte-identical** — a unit test pins
  that, because three copies is three chances to drift and a skill directory is
  installed standalone, so an import of a sibling skill would break the moment
  somebody copied one and not the other.

  **`check` REFUSES a definition whose coding agent needs a model provider and
  names none**, and that refusal is the tool's one opinion about a field the
  hub itself accepts. An empty `provider` is the hub's legacy path for a
  hand-typed complete model slug (`modelArgs()` in both provider-based
  plugins), so an agent created without one saves, schedules and starts — and
  then launches with a bare `--model`, no credential in the tmux session, and
  on hermes no `--effort` either, since that is passed on the provider branch
  only. Runs made that way through these skills died at their first API call
  looking exactly like a provider outage. The rule is asked, not remembered:
  `provider_rule()` reads `/api/providers`, which answers out of the plugin
  registry — `subscription: true` means send none, a non-empty list means send
  one of those ids, **one entry included**, because "the only one available" is
  still a choice the hub does not make for you. No vendor is named anywhere in
  the three copies, so a coding agent installed as a plugin tomorrow is covered
  by the same call. `coding-agents` prints the rule as a column, `agents` and
  `favorites` name the stored rows that already carry the hole with the
  `agent-edit.py` line that closes each of them, and `agent-edit.py` refuses
  such a save itself (on the BODY, so removing a provider is caught like never
  having had one; `--force` for the deliberate slug case).
- **`run-alive.py`** — the status/verdict gap for one run, a repo or a status.
- **`agent-edit.py`** — the read-modify-write round trip `POST /agents/edit`
  needs, because that route is a full replace and not a patch.
- **`fl-plugins.py`** — the plugin skill's whole reason to exist is that
  [docs/plugins.md](docs/plugins.md) already IS the contract, so the skill must
  not restate a line of it; `docs` finds that file on this machine and prints
  its section index, so an agent reads the two sections its kind needs instead
  of 1450 lines. `list` says what is registered (and names what only the
  Plugins page can answer — there is no JSON route for the registry),
  `install`/`uninstall`/`scan` post to the web UI's own routes and read the
  303-or-problem-page answer honestly, and `new <kind> <id>` scaffolds a
  package that already satisfies `validateManifest()`/`validateDescriptor()`.

### A skill is a whole directory, not `SKILL.md` plus two known folders

Seven of the shipped skills are `SKILL.md` with `references/` and `scripts/`
next to it, and it would be easy to read that shape as the contract. It is not.
`freilauf-agent-flow-builder` is the first one that ships a tree of its own —
`konzepte/<concept>/` with the rationale, the walkthrough, `vorlage/` (the
template of an engine: Python, JSON flow definitions, prompt files) and
`adapter/`. That works because nothing in the pipeline was ever shape-aware:
`payloadFiles()` recurses through whatever it finds and hashes every file byte
for byte, and `installSkill()` is one
`cpSync(source, target, { recursive: true })`. No extension list, no folder
whitelist, nothing to extend when a skill brings a new kind of file.

Two consequences worth stating, because both are easy to get wrong later:

- **The hash covers the whole tree.** Touching one JSON file deep inside
  `vorlage/` changes the skill's hash, and the next sync replaces the installed
  copy. That is exactly right, and it is also why an installed copy somebody
  edited by hand is reported as modified rather than silently kept.
- **`vorlage/` is not `scripts/`.** The Python under `scripts/` is a tool the
  agent RUNS against this hub. The Python under `konzepte/*/vorlage/` is a
  template the agent COPIES into somebody else's repository and edits there. The
  `fl-options.py` byte-identity check does not reach it — it filters on
  `scripts/fl-options.py` — and neither should any future rule about the hub's
  own CLI tools.

And one exclusion, which the first Python-shipping skill made necessary:
`__pycache__/` and `*.pyc` are ignored by `payloadFiles()` **and** by
`copySkill()`. Not for tidiness. An agent that runs a shipped Python file *in
place* writes bytecode into the INSTALLED copy; that directory belongs to no
source, so `installedHash()` stops matching the marker and the hub reports a
copy nobody touched as edited by hand — at every sync, forever. Ignoring
derived, interpreter-version-specific bytes at both ends keeps "is this copy
current?" a question about content. `.gitignore` already keeps them out of the
repository, so this is about the installed side.

### `FREILAUF_SKILLS_HOME` is a test fence, and a load-bearing one

Every other sandbox variable points into the suite's own directory, but a
coding agent's skill directory is derived from `$HOME`. Without this variable a
suite run would install into — and later **delete from** — the operator's real
`~/.claude/skills`. A suite that does not set it is not merely unreproducible,
it is destructive. `test/sandkasten.mjs` and `test/unit.mjs` both set it.

### The read-only JSON API the skills talk to

Screen scraping is how a skill goes stale the first time a column moves, so
`server/read-api.mjs` answers the questions that had no answer before: `GET
/api/repos`, `/api/agents`, `/api/runs` (with `repo`, `status`, `agent`, `q`,
`archived`, `limit`), `/api/runs/<uuid>` (the row plus its events, incidents,
file paths, worktree and a **liveness** block), `/api/favorites`,
`/api/sessions`, `/api/skills`. It is **read only** — every change still goes
through the existing POST routes, because a second write path is a second set
of rules to keep in step and `run-def.mjs` exists precisely so there is only
one. `bin/fl-api` is the shell front door (`fl-api /api/runs repo=3
status=running`), and it resolves the hub's URL itself.

The `liveness` block is the one thing a run's own row cannot say: `status:
"done"` means the run reported, not that the process is gone — three of the four
coding agents stay in their TUI afterwards. It carries `pane_alive` as a
**tri-state** (`null` = tmux could not be asked, which is not "gone") and a
`verdict` of `working` / `idle_in_tui` / `process_gone` / `no_session` /
`unknown`.

## Incidents (rate limit, provider outage)

On a rate limit or provider outage the agent cannot report anything — without an
API there is no tool call. Detection therefore runs from the outside, in three
stages, all ending in `incidents` (one record per run and type; resolve via
button, **reopens** on recurrence and notifies again — auto-alarm
principle):

| Source | Harness | Immediately red? |
|---|---|---|
| Hook `StopFailure` → `fl-report _api_error` | claude | yes (fixed enum) |
| Transcript JSONL `isApiErrorMessage` + `error` | claude | yes (second channel, with timestamp) |
| Plugin `session.error` → `fl-report _api_error` | opencode | yes |
| pipe-pane log, patterns per harness (plugin `logPatterns`, orchestrated in `detect.mjs`) | all; for hermes and cursor the **only** source | no: yellow; red on repetition within 10 min or 5 min of silence — or when the optional check LLM confirms it (Settings → Incident check: `llm_check_source` + `llm_check_model`, any plugin declaring `llm`) |
| Provider pulse (plugin pulse targets, every 5 min) | global | after 2 failures, closes on recovery |

**A working agent is never escalated.** `bewerteLogTreffer()` starts with a veto:
measurable work *after* the last hit means the agent is demonstrably not blocked
by an API error, so the hit was text on its screen — and neither repetition nor
silence may promote it to red. Applying the module's own principle ("a real limit
stands at the end") to only one of the two paths was the hole: an agent scrolling
through source code about API errors produced five hits in two minutes and turned
its own run red. The veto costs nothing where it matters — hermes, the harness
for which the log is the *only* source, has no activity measurement, so it never
applies to it; claude, opencode and cursor each have a second channel that
reports a real error (claude, opencode) or at least the agent's activity
(cursor) independently of the log.

**A hook report from a foreign claude session is ignored.** The run's own claude
is started with `--session-id <run id>`, and every Claude hook event delivers
that id on stdin — `fl-report` forwards it. A claude process the AGENT spawns (a
probe, a test of error handling) inherits the worktree's hooks AND `FL_RUN_ID`
but carries its own session id, and its API errors are the run's subject matter,
not the run's provider problems. Measured 2026-08-30: an agent testing a fake
model id (`nosuch/model-xyz`) opened a red "Model unavailable" on its own healthy
run. The guard (`fremdeClaudeSession()` in detect.mjs, applied in `handleReport`)
only ever narrows: no session id (an older fl-report) means the run's own.

**A session the hub itself stopped is not a provider fault.** An error hook
fires while the agent's process dies, and the hub is very often the one killing
it — the retention pass closing an idle session, `/api/runs/<id>/kill`, a flow's
`kill_run`, archiving. opencode's `session.error` then reports the bare word
`Aborted`, and until `isSessionStopped()` existed that opened a RED incident: the hub
alarming about its own cleanup. Measured on run c532df45 — retention closed the
session at 02:14:32, the incident was opened in the same second, the
`aborted {"source":"retention"}` event followed ten seconds later, and because a
red incident on an aborted run never resolves by itself ("that is WHY the run
did not come through") it was still asking for hands two days on. The end of the
run is recorded by whoever ended it, so nothing is lost by not also filing it as
an outage. Narrow like every pattern in that module: only a message that says
*nothing but* "stopped" — a real error mentioning an abort (`AI_APICallError:
stream aborted`) is still an incident.

**Silence is only an argument where activity is measured.** `measureActivity()`
has a source for claude (transcript mtime), opencode (session store) and cursor
(transcript mtime, see "cursor: when a run is over"); for hermes it has none and
returns nothing. `bewerteLogTreffer()` therefore reads
`letzteAktivitaetMs === null` as *unknown*, never as *silent* — otherwise every
yellow log hit on that harness turned red five minutes later while the agent was
happily working. There, repetition and the check LLM are the escalation paths; a
hit that has not recurred within 30 min expires by itself.

**And the traffic light follows the same rule, which it did not used to.**
`anomaly:no_activity` hangs on `lastAct`, and where nothing is measured that
falls back to the run's START — so every hermes run longer than a quarter of an
hour flagged itself as idle while it worked, in the one place the operator
looks first. `measureActivity()` therefore answers `measured` as well: true in
the three branches that have a source, false in the fallthrough. The flag lives
next to the code that implements it rather than in a second list, so a harness
that gains a source gains the flag in the same edit.

**A statement about silence is retracted when the silence ends.** `no_activity`
used to be cleared by a progress report alone (reports.mjs), so a run that had
been quiet once carried "no activity" in the overview for the rest of its life —
and "no activity" under a running run reads as "this agent is not running". The
watcher now takes it back the moment the run is measurably working again
(`retractNoActivity()`, the same `clearAnomalies()` mechanism a raised expected
duration uses to retract its overrun). It announces explicitly, because nothing
was ADDED: the live channel hangs on `addEvent()`, and a retraction no page
hears about sits in the overview until the next unrelated event.

### opencode's activity: a run is a session TREE

`server/opencode-store.mjs` — split off from watcher.mjs the way
`cursor-transcript.mjs` is, and for the same reason: a harness's activity source
is its own subject, and the half that decides something has to be testable
against a fixture instead of against the operator's live store
(`FREILAUF_OPENCODE_DB` is that fence, and the e2e sandbox sets it).

opencode's task tool opens a **child session per subagent, in the same
directory**. The hub asked for "the newest session of this worktree", so it
landed on whichever subagent had started last — usually one that had already
finished. Measured on run f2d4af1d (2026-09-04, glm-5.3-flash): the run's own
session wrote messages continuously from 15:16 to 15:36, and `last_activity_at`
stood at **15:13:17**, the end of a subagent that had lived 71 seconds. At
15:28:37 the watcher wrote `anomaly:no_activity` under a run that was working,
which is exactly the failure the section above is about. The tokens went the
same way: the row said 49 133 in / 5 049 out and $0.015, while the tree had
spent 303 513 / 24 012 and $0.14.

So the **root** is the newest parentless session of the worktree created with
this run, the **descendants** come off the `parent_id` index and not off the
directory (a subagent may work somewhere else), activity is the newest timestamp
anywhere in the tree, and tokens and cost are **summed** over it — a subagent's
tokens are the operator's tokens.

**And the timestamp comes from three tables**, because `session.time_updated`
moves once per completed message: in the same run one message ran 15:32:31 →
15:36:38, four minutes in which the session row said nothing at all. `message`
and `part` rows move while the turn is still going (a tool call changing state,
streamed text), and `part` is the finest signal this store has. Both fallbacks —
a store without `parent_id`, and a directory with no parentless session — return
what the old code returned, so the change can never answer less than before.

### Gone is gone: incidents resolve themselves

An incident whose condition is demonstrably gone closes itself
(`vorfallWeggrund()` in detect.mjs, applied in the watcher's `vorfaelleBewerten`
pass). The record stays — history, counts, the detector's protocol — but the
sidebar and the notifications stop counting it as open:

| Situation | What happens |
|---|---|
| run reached `done` | every incident of the run closes (`merge_blocked` excepted — the integrator's ladder is not time's) |
| red, run still going | resolves only on **positive evidence**: measurable work after the last occurrence and no recurrence for 10 min. Silence proves nothing — a genuinely blocked agent is silent too |
| yellow | the old 30-minute rule, generalized: no recurrence within half an hour was noise |
| red on `failed`/`aborted` | stays open — that is WHY the run did not come through |
| `merge_blocked`, `provider_down:*` | never by time: the integrator and the pulse own their recovery paths |

### The notification grace period — and the un-ringing

A red incident does **not** page immediately: `notify_at` stores
`occurrence + FREILAUF_INCIDENT_NOTIFY_DELAY_MS` (default 10 min,
0 = immediately), and the watcher pass `vorfaelleMeldenFaellig()` sends only
what has come due and is STILL open. An incident that resolves itself within
the grace period never pages. An incident that WAS announced also announces its
recovery (`✅ Resolved: …`) when it auto-resolves — an alarm that rang is
un-rung, or the operator keeps a problem in mind that no longer exists. The
message names the run first: title, agent or single run, repo, harness/model —
"which work is this about" is the reader's first question, and a bare uuid does
not answer it.

### Does it need a human? (`brauchtMensch`)

Severity says how sure the detector is. It does **not** say whether anything is
left to do — and that was the question the single "resolve" button could not
answer. `incidents.mjs` splits it:

| Group | What | Button |
|---|---|---|
| **Needs you** | `auth_error`, `billing_error`, `model_error` — always. A token, a credit balance or a wrong model ID does not get better by waiting; every following run walks into the same wall. Plus a **red** incident on a run with status `failed`/`aborted`: that is the reason it did not come through. | "Mark as handled" |
| **Noticed** | everything else — rate limit, provider hiccup, global pulse. The hub deferred, retried, or the run simply carried on. | "Dismiss" |

Neither button changes anything about the run; both only silence the entry here
and in the notifications, and a recurrence reopens it. What the watcher adds: incidents
**close by themselves** when their condition demonstrably went away (see "Gone
is gone" above) — since the evidence rule generalized, that includes the
"needs you" types on a run that reached `done`: a run that came through has
already answered what a model or auth hiccup during it meant. The notification
states the group in its second line, so the reader can tell a "get up" from a
"noted" without opening the hub.

cursor, like hermes, has **no** hook for API errors (its hook enum knows
`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`,
`beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `sessionStart`, `sessionEnd`,
`preToolUse`/`postToolUse`, … — nothing for a failed call), and there is no open
pulse endpoint for `api2.cursor.sh`:
`providerVonLauf()` deliberately returns `null` there ("not monitored", not
"healthy"). In return cursor rejects an unknown model **loudly and by name**
(`Cannot use this model: …`) — unlike opencode and hermes. hermes swallows
nonsense silently; opencode does complain, but as a generic `UnknownError` /
"Unexpected server error" that reads exactly like a provider outage (see
Pitfalls), which is arguably worse than silence because it points at the wrong
culprit.

Log and transcript are read by **offset** (`runs.log_offset` /
`transcript_offset`): only new bytes, every line counts once. Every decision is
recorded in `~/agents/runs/<id>/detektor.jsonl`. hermes has **no** hook for API
errors (`post_api_request` only fires after success).

## Pitfalls that already cost time here

- **A branch belongs to exactly one worktree.** Branch expectation "fixed" with
  the base branch (`main`) — which the main checkout itself holds — can never
  work: `git worktree add` refuses it. The hub therefore checks beforehand
  (`branchWorktree()` in `runner.mjs`): `runDefFromForm()` blocks it for every
  form path, so no run is even created, and a start that gets there anyway
  (an agent whose branch was taken afterwards) fails with a readable sentence
  instead of git's "'main' is already used by worktree at …". `--force` would push it
  through, but the main checkout would then carry the agent's commits as
  reverse-modifications in its working tree — never do that.
- **tmux targets need the colon.** `-t "=name"` is no valid target for
  `pipe-pane` and `set-hook` ("can't find pane" / "no such window"); correct is
  `-t "=name:"`. And `tmux display -p -t "=name"` returns exit code 0 for a
  **non-existing** session — whoever checks "session gone?" with it checks
  nothing. That is what `tmux has-session` is for.
- **The terminal is fail-closed, twice.** `/term` only enables write access on an
  explicit `?ro=0` (`terminal.mjs`); without the parameter tmux attaches with
  `-r` AND every input is discarded. The client sets `ro=0` from `data-live` in
  `pages.mjs`, and `data-live` means "session standing AND a process in it" —
  never "the run's status is `running`" (see above). Touching only one of the
  two sides yields a terminal that silently does nothing — exactly how it sat
  for a long time, because `ro=0` appeared nowhere.
- **`tmux attach -r` is only the shorthand for `-f read-only,ignore-size`.** And
  `ignore-size` is useless while `window-size` is `latest` (default): the
  browser rewraps the agent's window to its size while watching — with and
  without write access alike. The remedy would be `window-size manual` on the
  session.
- **Marking in the browser terminal copied nothing, and xterm was not the one
  failing to copy.** `bin/fl-start` sets `mouse on`, so a plain drag never
  reaches xterm at all: it is a mouse report, tmux selects in copy-mode, and
  its default `MouseDragEnd1Pane` binding copies the selection and cancels it.
  Mark, copy, deselect — the gesture was complete; what was missing was the
  last hop out of tmux. tmux does send it: with `set-clipboard` (default
  `external`) and the `clipboard` terminal feature, which tmux 3.4 hands every
  `xterm*` client by itself, the copied text goes to the client as OSC 52.
  Measured against a real tmux client: `ESC ] 52 ; ; <base64> BEL` — note the
  **empty** target field, so a handler matching on `c` sees nothing. xterm.js
  registers no handler for the sequence and dropped it on the floor;
  `hub.js` registers one (`term.parser.registerOscHandler(52, …)`) and writes
  the browser's clipboard. Four things around it, each of them a way it goes
  wrong: a payload of **`?` is a READ request** and is never answered — the
  answer would hand the operator's clipboard to whatever runs in that session;
  **`atob` gives bytes, not characters**, so without a `TextDecoder` every
  umlaut in a copied line arrives broken; both clipboard ways need the document
  focused, which is why an unfocused tab drops the sequence silently instead of
  leaving a failure toast nobody asked for; and an operator whose tmux has
  `set-clipboard off` (a server option — the hub does not touch it) loses this
  path entirely and is left with the second one.
  That second path is xterm's **own** selection, copied on mouse release and
  then cleared, so both feel like one behaviour: it is what covers a read-only
  client (tmux drops its input, so only Shift+drag selects — the page says so
  under such a terminal), an application inside the pane that grabbed mouse
  reporting, and a browser reached over plain http, where `navigator.clipboard`
  does not exist at all and the old `execCommand` textarea is the fallback.
  The drag is tracked from its **mousedown in the terminal**, because it may
  end anywhere on the page and a bare document-wide mouseup would re-copy a
  standing selection on every click.
- **Under the native Fullscreen API only the fullscreen element's subtree is
  rendered.** The toast box sits at the end of `<body>`, so every toast — the
  copy confirmation above first of all — was invisible for as long as somebody
  was in full screen, and nothing said so. It moves into `#term-wrap` with the
  terminal and back out afterwards (`paint()` in hub.js); `position: fixed`
  keeps working there, since a fixed element's containing block is only taken
  away by `transform`/`filter`/`contain`, none of which that wrapper has.
- **Esc belongs to the agent's TUI, so the full-screen terminal asks the
  browser for it.** The icon on the terminal's toggle line puts `#term-wrap`
  into `.term-full` (fixed, inset 0) **and** calls `requestFullscreen()` on it.
  The class alone would already be full screen — but then Esc would have to be
  taken off xterm by hand on every page, and an operator who wants to send Esc
  into a TUI could never do it again. Under the native API the browser eats the
  key itself, fires `fullscreenchange`, and the class comes off there; the
  capture-phase `keydown` handler in hub.js is only the fallback for a request
  that was refused. xterm refits itself either way, through the ResizeObserver
  that already watches `#term`. The way back out is also an icon in the
  terminal's own top right corner, because a keyboard-only exit is a dead end
  for anyone who reached full screen with the mouse.
- **Cinema mode is the same line's second icon, and it measures instead of
  guessing.** `.term-cinema` on `#term-wrap` plus `body.term-cinema-on`: the
  page stays a page, `main` becomes a flex column, the terminal takes `order:
  -1` and the full width, and the status sidebar is hidden — everything that
  stood above the terminal is below it, one scroll away. The HEIGHT is written
  by hub.js as `--cinema-h` from the terminal's own measured top edge, because
  a `calc(100vh - …)` constant is right on one page and one line too tall on
  the next — and one line too tall is exactly what pushes the terminal out of
  the fold the mode exists for. `#term-wrap.term-cinema:not(.term-full)` keeps
  full screen the winner where both are on. The choice is remembered **per
  run** (`localStorage['freilauf.cinema.<run id>']`, in try/catch like the
  sidebar fold): a reload comes back into it, and the next run's report does
  not. The button toggles, so it carries both labels — `title` and
  `data-title-exit`, both rendered by `pages.mjs` through `t()`, so the swap
  needs no `js.*` strings of its own.
- **`fl-start` positional arguments.** `fl-start [name] [directory]`; when the
  name is set via `--name` (that is how the hub calls it), the directory moves
  to position 1. Otherwise the agent starts in the CALLER's working directory
  instead of the worktree.
- **Claude hook format.** Every event is a list of
  `{ matcher?, hooks: [{ type, command }] }`. A bare command list makes Claude
  discard the settings file **completely** and the run hangs at a dialog.
- **cursor's hook format is the other one.** `<workspace>/.cursor/hooks.json` is
  `{ version, hooks: { <event>: [{ command }] } }` — a **flat** list per event,
  exactly the shape Claude rejects. Handing cursor Claude's nesting gets the file
  silently ignored, and a silently ignored end-of-turn hook is the whole bug
  again. cursor also reads `<workspace>/.claude/settings.json`, so the two
  formats really do meet in one directory tree.
- **`StopFailure` exists — but Claude does not wait for it.** (Claude Code
  2.1.241; the enum is in the binary: `rate_limit`, `overloaded`, `server_error`,
  `authentication_failed`, `billing_error`, `model_not_found`, …) The process is
  gone within 100 ms after the event and tears the hook down; `SessionEnd` on
  the other hand is awaited. The hook must therefore detach immediately:
  `setsid -f fl-report _api_error` — the child inherits the stdin pipe with the
  JSON. Simulating without quota: a mini HTTP server answering 429 with
  `anthropic-ratelimit-unified-status: rejected`, and `ANTHROPIC_BASE_URL`
  pointed at it (that is how `test/e2e.mjs` does it).
- **Worktree extras with `mode: "link"`** create a symlink. A `.gitignore` rule
  with a slash (`referenz/`) does **not** match it — the worktree then counts as
  dirty forever and is never cleaned up. Write the rule without the slash.
- **The log scanner hits menu text.** "Upgrade to Max for higher rate limits"
  from the `/` menu once sat in the DB as a rate limit on a production run.
  Patterns in the harness plugins are therefore narrow, there is an exception
  list, and a single log hit is only yellow.
- **`opencode --prompt` stops sending the prompt off when it gets long.** The
  text lands in the TUI's editor either way, but only a short one is submitted
  by itself — measured with opencode 1.18.23: ~2 KB goes, ~20 KB stays put. A
  real hub prompt (task + platform rules + extra skills) is past that, and the
  failure is silent in every direction: tmux session alive, no line in the log,
  the run simply never starts working. `fl-start` therefore presses Enter once
  from the launcher after the TUI has drawn (it waits for the status bar, not
  for a fixed number of seconds). Enter on an empty editor is a no-op in
  opencode — measured — so the case that submitted by itself is not harmed.
  **And the nudge is not enough on its own.** Measured 2026-09-04, run
  1c0076ec: opencode initialised at 23:32:42 and then never created a session
  at all — no `created`, no `loop`, no `stream` in its log. The tmux session
  stood, the pane was alive, the hub said `running`, and nothing whatsoever had
  been asked of the model; the run would have sat there until a human closed
  it. That is the most expensive shape a failure can take, because every layer
  above it reads as healthy. So above a harness-declared size the TASK is
  written to a file and the CLI is launched with the platform's own framing
  plus one sentence naming that file — `offloadPrompt()` in `runner.mjs`,
  `launch.promptFile.maxBytes` in the plugin (opencode: 4000; the platform
  framing alone is ~3 KB, and across the 297 prompts on this machine the median
  is 4.2 KB and the 90th percentile 13.6 KB, so the long tail IS the
  population). Three things make that safe, and each is a way it would
  otherwise go wrong: the file lives INSIDE the worktree
  (`.freilauf/task.md`) because anything outside is an
  `external_directory` question waiting to happen — see the next entry;
  `harnessOwnedPaths()` names `.freilauf` for **every** harness so the finish
  gate does not read it as uncommitted work; and the directory carries a
  `.gitignore` of `*` that ignores itself, because the agent is told to run
  `git add -A && git commit` and would otherwise commit the platform's task
  file into the operator's repository. The agent is asked to delete the file
  once it has read it, so the ordinary case leaves nothing behind — measured
  end to end: `Read .freilauf/task.md` → work done → `rm`, and `git status`
  showed only the agent's own file.
- **`opencode --session <id> --prompt "…"` drops the prompt.** Measured with
  1.18.29 through fl-start, Enter nudge included: the TUI opens the session
  and the text is nowhere — not submitted, not in the editor; `--continue
  --prompt` is the same. `opencode run -s <id> "…"` (print mode) takes it, so
  the flag is not broken, the TUI just ignores it on a resume. fl-start's
  resume form for opencode therefore launches `--auto --session <id>` bare and
  PASTES the continuation into the editor once `ctrl+p` is on the status bar
  (`oc_resume_paste`, the bracketed paste `sendToSession()` uses) — measured:
  the code word from the first turn came back, same session, no second one.
- **`opencode --auto` REFUSES the `external_directory` permission, it does not
  approve it.** Since opencode 1.18.27 every path outside the working directory
  goes through a permission called `external_directory`, and `--auto` is the one
  case where "approves everything not explicitly denied" stops being true: the
  question is auto-rejected (`permission requested: external_directory (…);
  auto-rejecting`), and in the TUI it simply blocks. Freilauf's run directory —
  `~/agents/runs/<id>/`, where the platform prompt sends EVERY agent to write
  `report.md`, deliberately outside the worktree so the finish gate stays clean —
  is exactly such a path, and so is every worktree extra that was linked rather
  than copied (`.venv/`, `node_modules/`, a reference checkout). So the agent was
  blocked precisely where it reports. Measured 2026-09-04 on one repository of this machine:
  fifteen opencode workers sat in their TUI, `Build` spinning, `0 tokens` and
  `$0.00 spent`, one of them for 55 minutes — the assistant message row in
  opencode's own database was created and never updated again. It looks exactly
  like a hung provider and is not one: the same prompt through the OpenRouter API
  answered in 7.3 s, and a SHORT prompt in the same worktree, same model, same
  session ran through in 14 s. `runExternalDirs()` (runner.mjs) now names those
  directories and `modelArgs()` writes them into `OPENCODE_CONFIG_CONTENT` as
  `external_directory` allows. Two things this cost, both worth keeping: the
  workers never failed — they piled up as live sessions, which is how the machine
  came to hold 44 GB in tmux; and a run that cannot report is invisible as a
  fault, because "running" is exactly what it still says.
- **"The newest session in this directory" is not the run's session.** opencode
  opens a child session per subagent in the same worktree, so the newest one is
  usually a subagent — and one that has already finished, which is why the hub
  read a working run as idle and billed it a fraction of its real tokens (see
  "opencode's activity: a run is a session TREE"). Whenever a vendor's store is
  matched by directory, ask whether that vendor puts more than one row in it.
- **opencode reports an unknown model as a server fault.** A model id it does not
  know answers `{"type":"error","name":"UnknownError","data":{"message":
  "Unexpected server error"}}` — byte for byte what a genuine upstream outage
  produces, with no "no such model" anywhere in it. So a typo in a model id and a
  broken vendor look identical from the outside, and telling them apart cost an
  hour. On `UnknownError`, check the id against `opencode models --pure` **before**
  believing the outage. Related, and the other half of the same trap: OpenCode
  Zen's free models (`*-free`) are a shared pool that rotates through 429/500/503
  constantly, so a 5xx from one of them is "try later", not a defect — anything
  built on them must not raise an incident or fail a test on the first one.
- **`\b5\d\d\b` is not an HTTP status.** cursor's own status line
  `⠠⠛ Globbing  555 tokens` opened a "Provider error" incident, because the
  pattern matches a token count just as happily as a 503. A status code counts
  only next to an error word (`HTTP_5XX` in `harnesses/patterns.mjs`, shared by
  cursor/hermes/opencode and `typVonText`).
- **An agent working on Freilauf reads its own alarm texts into the log.** One
  cursor run produced three incidents in seven minutes, all from its own screen:
  the token count above, the hub's section heading `Incidents: rate limit and
  provider errors (auto-alarm)`, and the e2e suite's success line
  `✓ cursor: … and "Cannot use this model" is detected`. The exception for "work
  on exactly this code" existed but was **case-sensitive** (`incidents` vs.
  `Incidents:`). The exception list is `i`-flagged now and additionally skips
  test-runner tick lines and "… is detected"/"is reported" phrasings.
- **And the exception list alone will never be enough.** The very next run — the
  claude run *fixing* the above — went red from two lines of the test file it had
  just written (`scanneZeilen('cursor', ['API Error: 503', …])`), five hits in
  two minutes via the repetition path. Two answers, and the second one is the
  load-bearing one: a call with a quoted argument list is source code, not
  output (no harness prints that shape); and above all, **work after the hit
  vetoes escalation** (see above) — patterns can always be tricked, a run that
  keeps producing output cannot.
- **`cursor-agent -p` is wrong for a run.** `-p/--print` prints and exits — the
  tmux session would be gone immediately. The prompt belongs as a **positional
  argument** after `--` (`cursor-agent --force --trust -- "$FL_PROMPT"`); the
  TUI then works through the task and stays up afterwards, like opencode.
- **Without `--trust` cursor hangs at the dialog** "Do you trust the contents of
  this directory?" — the session lives but does nothing. Same pattern as
  Claude's trust flag, only as a command-line switch instead of an entry in
  `~/.claude.json`.
- **Cursor's bracket syntax is model-dependent and unusable as a foundation.**
  `grok-4.6[effort=high,fast=false]` works, but
  `claude-opus-4-8[context=1m,effort=high,fast=false]` — the example from
  cursor's **own** help — is rejected. Only a flat ID from `cursor-agent models`
  is reliable.
- **`agents.harness` carries a CHECK, `runs.harness` does not.** SQLite cannot
  alter a CHECK, and `CREATE TABLE IF NOT EXISTS` does not apply to an existing
  database — a new harness therefore needs the table rebuild in
  `harnessCheckErweitern()` (db.mjs). It takes the table header from
  `sqlite_master`, keeps the CHECK in sync with the plugin registry and only
  replaces that one spot, so retrofitted columns, defaults and the UNIQUE
  reliably survive.
- **A `<form>` closes an open `<p>`.** The HTML parser does it, so
  `<p><a class="btn">…</a><form class="inline"><button>…</button></form></p>`
  puts the two buttons on two lines and no CSS can talk it out of that — the
  form has become a sibling of the paragraph before the stylesheet ever sees it.
  Buttons that belong next to each other go in a `<div class="btn-row">`.
- **`--no-optional-locks` is a GIT-level option, not a `status` one.**
  `git -C <dir> status --porcelain --no-optional-locks` is rejected as an unknown
  option — and the finish gate read the resulting empty output as "worktree
  clean", so every dirty run sailed straight through to a merge. Correct is
  `git -C <dir> --no-optional-locks status --porcelain`. Found by the e2e test
  that was written for exactly that case, not by reading the code.
- **`tmux` reports "no server" and "I cannot answer" with the same exit code.**
  Reading the second as the first is how the hub came to abort a healthy run:
  `sh('tmux', ['has-session', …]).ok` is false for a timeout, a failed fork and
  a missing binary just as much as for a session that is really gone, and the
  watcher answers "gone" by ending the run. Classify the stderr
  (`tmuxVerdict()`), never the exit code alone — and where the answer is
  unknown, do nothing and ask again next pass.
- **`capture-pane` needs the colon too.** `tmux capture-pane -p -t "=name"`
  answers "can't find pane" — the same trap `pipe-pane` and `set-hook` already
  have an entry for above. `-t "=name:"` is what works, and a test that asserts
  on an empty capture asserts on nothing.
- **The text is on the agent's screen before the event is in the database.**
  `sendToSession()` is a bracketed paste, a 300 ms pause and then Enter; the
  event is written after all three. A test that greps `capture-pane` and then
  reads the events in the same breath is racing itself.
- **A green test only proves the path the test took.** `curl` against the VPN IP
  from the server itself runs over `lo` and says nothing about the firewall;
  check real reachability only from a VPN client.
- **A restart loads the directory, not the branch.** The hub ran for an hour on
  the code from *before* a merge, because the flow after that merge did
  `git pull --ff-only` in the working checkout and the checkout had 279 lines of
  uncommitted work in it — `--ff-only` refused, the restart happened anyway, and
  nothing in the hub said which commit it was serving. Two answers, and both were
  needed: the service runs from a checkout nobody edits (see "Deploying"), and
  the sidebar prints the sha it is running, so "is my change live?" is a glance
  instead of a guess.
- **`claude.mjs` must import `quota.mjs` LAZILY.** A static import at the top of
  the file closes the ring `plugins/registry.mjs → harnesses/claude.mjs →
  quota.mjs → plugins/context.mjs → plugins/store.mjs → plugins/registry.mjs`,
  and `store.mjs` does real work at module evaluation: it creates
  `plugin_config` and `discovery` and runs the one-time migration out of
  `coding_agents`, which calls `pluginSource()` **back into a registry that is
  still evaluating its own module body**. `META` and `HARNESS_PLUGINS` are in
  their temporal dead zone at that moment and the first thing to touch them dies
  there — with a `ReferenceError` from a file nobody was editing. Both places in
  claude.mjs that need the windows are `async` anyway, so
  `await import('../quota.mjs')` inside the function costs nothing. The provider
  gates do the same, for the same reason. **The rule: a plugin file that needs
  something from the hub's own modules imports it inside the function that uses
  it.**
- **`SETTINGS_KEYS` had to become a FUNCTION.** It was a module-level constant,
  and a module-level constant is evaluated before `loadExternalPlugins()` has
  registered anything — so a plugin's declared thresholds rendered on the
  settings form, were submitted by the browser, and were then **silently dropped
  by the allowlist on save**. A form field that looks like it saved and did not
  is the worst shape a bug can take. It is `[...STATIC_KEYS,
  ...allPluginSettingKeys()]`, evaluated per save.
- **`statSync().mtimeMs` is a FLOAT, `Date.now()` is an integer millisecond** —
  so a file written inside the current millisecond carries a timestamp that is
  *larger than now*, and any "which of these readings is newest" comparison
  hands it the win. `mergeGeneral()` in `quota.mjs` compared the live account
  answer, the remembered one and `quota.json`'s mtime that way, and the file
  beat a live answer that had just arrived: measured at
  `seven_general_at = 1788443185118.0244` against a `now` of `1788443185118`,
  which made the unit suite's two merge assertions fail in **6 of 30 runs** —
  and in production the status line writes that file continuously while a
  session renders. The rule was never "newest wins" in the first place: it is
  "**the live answer wins outright**, the newest of the rest wins where it says
  nothing", which is what `mergeScoped()` had always done by applying the live
  windows last. Do not compare a clock against a file's mtime and expect a
  total order.
- **The string `'0'` is truthy, and a checkbox read with `b.x ? 1 : 0` believes
  it.** The agent form's `active` box carries no hidden `0` companion — absent
  IS off there, which is right for a form. But `agentSave` coerced instead of
  comparing, so a caller who spelled the off state out (`active=0`, which is
  what anybody scripting `POST /agents/edit` writes) switched the agent **on**.
  Same family as `Number('')` below: a value that arrives as a string has to be
  compared against the values that mean yes, never coerced. The fix is
  `b.active === '1' || b.active === 'on' || b.active === 'true'`, the shape
  `keep_on_branch` already used.
- **`Number('')` is `0` AND finite.** An unconfigured alert window therefore read
  as a zero-minute window and an unconfigured ceiling as zero messages — silence
  dressed up as a configuration. Every numeric setting has to check for the empty
  string *before* it converts, and only then honour an explicit `0` the operator
  typed. Exactly the trap `Number(null)` already has an entry for under "Claude's
  windows come from the account".
- **A `<form>` inside a `<form>` is not nesting, it is a parse error.** The HTML
  parser drops the inner one and its button submits the **outer** — on the
  Plugins page that would have meant "Remove" quietly *saving* the plugin. Same
  family as "`<form>` closes an open `<p>`" above: the card's footer forms stand
  outside the save form, never inside it.
- **`confirm(${JSON.stringify(...)})` inside a `"`-quoted attribute is broken
  markup** the moment the string contains a quote — and a translated
  confirmation text eventually does. It needs `e(JSON.stringify(...))`: JSON for
  the JavaScript, HTML escaping for the attribute, in that order.
- **`bin/fl-attach` and `bin/fl-kill` each carried their own copy of the session
  prefix → harness table, and both had gone stale in the same way**: `cursor`
  was missing, so every `-cu-` session was reported as claude. There is one
  copy now, `bin/fl-harness-tags.sh`, sourced by all three of them (`fl-help`
  had a third copy) — and a coding agent that arrived as a plugin brings its own
  tag in its launch spec, which `fl-start` notes into
  `~/.local/share/freilauf/harness-tags` the first time it launches one. These
  scripts read tmux, not the hub's database; that file is the only place on the
  machine that knows `fl-fa-` means `fakeagent`.
