# Changelog

Everything worth knowing that changed in Freilauf, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) —
the categories **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**
and **Security**, in that order, and an entry says what changed for someone who
uses or operates the hub, not which function was renamed.

**There are no version numbers, because there are no releases.** Freilauf is
deployed from `main` whenever something lands there, so a version would be a
number nobody could point at. The unit of this changelog is therefore the **day**:
one section per day on which something changed, headed by its
[ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) date (`YYYY-MM-DD`), newest
day at the top — the same shape a Keep-a-Changelog release section has, with the
date doing the work the version number does elsewhere. A day with no section is
a day on which nothing was released.

## 2026-09-05

### Added

- **A run says whether its agent is working or waiting for input.** The
  coding agents' own hooks tell the hub when they start processing input and
  when their turn is over (claude: UserPromptSubmit / PreToolUse and Stop /
  idle notification; cursor: beforeSubmitPrompt and stop; opencode: the
  installed plugin forwards the root session's busy/idle; hermes: two shell
  hooks `setup/02-install-scripts.sh` appends to `~/.hermes/config.yaml`,
  answered by the new `fl-hermes-hook`). The overview, the detail page and the
  sidebar show a new status word, **Waiting for input**, when an agent has
  ended its turn and sits at its prompt — and go back to **Running** the
  moment it works again. A subagent finishing never counts as waiting.
  `GET /api/runs/<id>` carries `liveness.agent_state` and a `waiting_input`
  verdict; the events are `agent_working` / `agent_waiting`; the Plugins page
  states for every coding agent how (or that it does not) report this.
- **Typing into a finished run's terminal counts as follow-up work.** The
  terminal on the run page writes straight into tmux, so a conversation there
  used to leave a `done` run reading "done" while the agent worked. The agent's
  own "working" hook now opens the follow-up commission — the run displays as
  running again, exactly as if the send form had been used. An answer typed
  into the terminal likewise ends a help call (`Waiting for help` → `Running`).
  The two or three tool calls an agent makes after `fl-report done` do NOT
  count: only a submitted line opens a follow-up at once, a tool call only
  after a two-minute grace window since the report
  (`FREILAUF_ATTENTION_GRACE_MS`), so a finished run reads "Done", not
  "Waiting for input", once its agent goes quiet.
- **The watcher believes the agent.** No "no activity" flag and no follow-up
  overrun while the agent says it waits for input; a running run whose agent
  stopped without reporting turns yellow instead.
- **Typing into the terminal clears "Waiting for input" at the first key.**
  The coding agents' hooks only say "working" once a line is submitted (or,
  for opencode, once it starts) — so while you were typing, scrolling, in a
  menu or answering a one-key dialog the run still read "Waiting for input".
  The browser terminal and the send form now flip it to **Running** the
  moment you do something, for every coding agent alike; mouse clicks, the
  wheel and the window gaining focus do not count, and the read-only terminal
  never does. Nothing else changes on that key: a follow-up commission still
  starts with a submitted line, and a help call still ends with an answer.
  The run's history records it (`agent_working` with source `terminal` or
  `send`).
- **A lost tmux session is resumed, not aborted.** When a run's session
  vanishes without the hub ending it — a server reboot, an update that took
  the tmux server, a dead server — the run is resumed in a new session:
  all four coding agents continue their conversation (with a short
  continuation prompt naming what was already committed; measured for all
  four), a plugin without a resume form is started afresh with
  its original task behind a header saying the same. hermes 0.21 keeps its
  session in `~/.hermes/state.db` and, on a TTY, stays interactive after
  `-q` like the other three — the old "hermes exits when done" no longer
  holds. Capped at 3 automatic resumes per run
  (`FREILAUF_RESUME_MAX`), after which the run ends the way it used to. One
  message per watcher pass names every run that was resumed, instead of one
  "aborted, work not merged" message per run. Deliberate ends — the kill
  button, the sessions page, retention, archiving, a flow — are still aborts.
  Events on the run: `session_lost`, `resumed`, `resume_failed`,
  `resume_refused`.
- **The tmux server has a unit of its own** (`freilauf-tmux.service`), started
  before the hub, so no hub restart or deploy can reach the agent sessions —
  whatever the hub's unit is called. On a machine whose server was spawned by
  an earlier hub the unit waits and adopts the socket when that server exits;
  `freilauf status` says who owns the server. `setup/03-install-services.sh`
  and every deploy enable it.
- **Missed schedule slots are caught up.** After a restart the hub looks back
  (Settings → "Catch up missed schedule slots", default 6 hours, 0 = off) for
  cron and weekly slots that fell into the downtime and starts each affected
  agent once, at its newest missed slot (`schedule_catchup` on the run).
- **`freilauf drain [minutes]`** for a planned reboot or update: pipeline off,
  every running agent is told in its own session to commit and report within
  the window, and the command waits until nothing is working any more.
  `freilauf undrain` switches the pipeline back on.
- **`fl-start --resume <id>`**: the resume form per coding agent; a plugin
  declares its own as `launch.resume` with `{resume_id}` and may answer the id
  with `resumeId(run)` (`docs/plugins.md`). For opencode the continuation is
  pasted into the editor after the TUI has drawn, because `--session <id>
  --prompt` drops the text (measured with 1.18.29); for hermes it is
  `chat --in <worktree> --resume <id> -q`.
- `setup/03-install-services.sh` runs `loginctl enable-linger`, so the hub and
  the tmux server start at boot and not at the first login; `SETUP_WITH_AGENT.md`
  says what to do about OS updates and reboots.
- **Marking text in the browser terminal copies it to the clipboard.** Drag
  across the terminal and the selection is in your system clipboard the moment
  you let go, and the marking is cleared — the same gesture a terminal on your
  own machine has, and it works the same whichever coding agent is in the
  session. (It used to depend on that: claude leaves the mouse to tmux, which
  marks and copies for you, while opencode takes the mouse and does nothing
  with a drag — so marking produced nothing at all there.) A selection made
  with the keyboard in tmux's copy-mode lands in the clipboard too. A short
  toast names every copy, because a clipboard written from a remote session
  must not be written silently, and it says so as well when the browser refused
  the clipboard. A request from inside the session to *read* the clipboard is
  never answered.
- **The 🖱 button above the terminal gives the mouse back to the agent**, for
  the rare session you want to click around in rather than read: the agent then
  receives clicks and drags again, and marking there needs Shift held down like
  in any terminal. The choice is remembered for every terminal. When a drag
  comes up empty in that mode, the page says why and names both ways back,
  once per page instead of leaving you guessing.

### Changed

- Toasts stay visible while the terminal is in full screen.
- The opencode plugin in `~/.config/opencode/plugins/freilauf.js` (rewritten
  by `setup/02-install-scripts.sh`, which every deploy runs) no longer reports
  `session.idle` of every session; it reports the root session's busy/idle. A
  plugin instance loaded before the deploy keeps sending the old `_idle`, which
  the hub still accepts as a note and nothing more.
- hermes runs are launched with `--accept-hooks`, so the shell hooks in
  `~/.hermes/config.yaml` run without the consent prompt hermes would show at
  a TTY nobody sits at.
- Watcher and scheduler run their first pass two seconds after a start instead
  of 30 seconds later, so a deferred run, a planned start, a pending goal or a
  lost session is looked at at once.
- A run whose session was lost shows "session lost — resuming in a new one"
  under its status word until the new session stands.
- The `tmux_gone` incident says that the runs are being resumed.

### Fixed

- **A run that came through no longer keeps calling for attention.** A run that
  took longer than expected, or was quiet for a while, collected an anomaly and
  wore its traffic light for ever — so a run that had reported done and had its
  work merged into `main` sat in the overview with a red dot titled "needs
  attention", beside a run that had genuinely called for help and was green.
  An anomaly is a statement about a run *in flight*, and reaching the end
  answers it, the same way a `done` run's incidents already close themselves.
  The colour ends; the record does not — the row still names the anomaly as
  history, next to a duration column saying the same thing. A `failed` or
  `aborted` run keeps its colour: there the anomaly is the explanation of why
  it did not come through.
- **"Out of credit" is no longer reported as "API error, nothing to do".** The
  two wordings OpenRouter refuses a spent key with — *"requires more credits …
  can only afford"* and *"adjust the key's daily limit"* — name neither 402 nor
  "insufficient credits", so they fell through to the unknown type. That type
  is not one that asks for hands, so four runs that had stopped dead at an
  exhausted daily credit cap were each announced as "Noticed, nothing to do:
  the hub carried on by itself". It had not. They are `Credits/billing` now and
  land in "Needs you", where the hint has named credits all along.
- A flow run waiting on a run that had ended more than an hour before a hub
  restart was never resumed and never pruned; it is resumed now.

## 2026-09-04

### Added

- **Panels: your project's own numbers in the status sidebar.** The sidebar
  could say how the machine is doing — quota, work in flight, incidents,
  memory — and nothing at all about how the *work* is doing. A project can now
  push its own figures into the sidebar of its repo: open findings split by
  type, failing tests, unassigned tickets, whatever it counts. One command,
  `fl-panel set findings --total 33 --item "bug=17:red"`, or a tool of yours
  piping JSON into it; inside a run it needs no arguments at all. Freilauf never
  learns what your numbers mean — the counting rule stays in your repository and
  reaches the hub as a number, with the time it was measured. A reading that is
  past its declared lifetime, or whose producer reported a failed measurement,
  keeps its numbers on screen but says plainly that nobody is confirming them.
  `POST /api/panels` and `GET /api/panels?repo=` are the seam,
  [docs/panels.md](docs/panels.md) is the whole contract.

- **A roadmap** — [ROADMAP.md](ROADMAP.md), linked from all three READMEs. It
  says what is planned that is big enough to plan around (today: running agents
  in a sandbox, with the design study next to it), it says in its own first
  paragraph that it is deliberately incomplete, and it is where feature
  requests are invited: the GitHub issues URL is now in the roadmap, in the
  three READMEs and in `CONTRIBUTING.md`. English only, on purpose — a roadmap
  maintained in three languages goes stale in two of them.
- The overview lets several runs be selected and archived in one gesture: a
  checkbox on every archivable row, a bulk bar under the table, and a per-run
  answer so one refusal does not hold up the rest.
- Long tasks are handed to opencode as a file instead of as a command-line
  argument (`.freilauf/task.md` inside the worktree, gitignored and ignored by
  the finish gate), because opencode silently stops submitting a prompt past a
  few kilobytes — a run that never started work while everything above it read
  as healthy.
- `freilauf-agent-flow-builder`, an agent skill that carries a whole tree of
  its own: the rationale, a walkthrough and a copyable template for setting a
  Freilauf agent/flow concept up in another repository.
- A failed launch now says so on the notification channel. A scheduled start
  has no caller at all, so a run that never got off the ground used to be a
  red row nobody was told about.
- A schema failure of one of the hub's own LLM questions carries the model's
  raw answer — in the alert, and in the flow log for the `extract` step.

### Changed

- Quick Run answers before the launch: the dialog closes at once, the run's
  row appears immediately, and a toast follows the start to its end instead of
  holding a modal open for the seconds a checkout takes.
- The overview's bulk bar sits under the list, where the hand ends up after
  going down the rows.
- opencode runs are allowed the directories outside their worktree that a run
  reports into — `--auto` auto-*rejects* the `external_directory` permission,
  so agents silently blocked exactly where they write their report.
- Offloading a task to a file is decided on the saving, not on the total size:
  it only happens when it saves at least a kilobyte, so a short task under a
  large platform framing is left alone instead of being replaced by a pointer
  of the same size.

### Fixed

- **A merge that cannot be pushed now alarms once instead of five times.** When
  a push kept failing for a reason that is not a conflict, the retry was a timer
  that outlived the decision it was scheduled under: the fifth failure escalated
  the run to a human, and the four timers already pending from the failures
  before it then walked the whole merge again — merging, force-pushing the
  backup branch, escalating and notifying afresh, wave after wave. Measured on
  one production run: 28 push attempts, five blocked-merge notifications and
  five backup pushes inside ten minutes, all about a single broken pre-push
  hook. The wait is now a due time the integrator's own loop honours, so a run
  a human has been called about is left alone. The same change makes the wait a
  wait at all — the loop re-checked every merging run every five seconds, so
  the five attempts used to collapse into twenty of them.

- **The sidebar's incident count no longer points at rows nobody can see.** The
  number links into the overview filtered to the runs carrying an open
  incident, and an archived run is in no overview — so archiving a run with an
  open incident left a "needs you" whose click landed on "no runs yet".
  Archived runs are no longer counted there (their incidents stay on the run's
  own page and in the archive), and where only hub-wide incidents are open the
  number is no longer a link at all — those carry their own banner, with the
  button that clears them.

- **A session the hub itself stopped is not reported as a provider fault.** An
  agent's error hook fires while its process dies, and the hub is very often
  the one killing it — the retention pass closing an idle session, the kill
  button, a flow, archiving. opencode then reports the bare word "Aborted", and
  that opened a red incident about the hub's own cleanup; on an aborted run
  such an incident never clears itself, so it asked for hands indefinitely. The
  end of a run is recorded anyway. A real error that merely mentions an abort
  is still an incident.

- **"Nearing the expected duration" now says so.** The yellow badge a run gets
  at 80 % of its expected duration was labelled "over the expected duration" —
  so a run that finished in 44 of its 45 expected minutes carried a badge
  saying it had run over, next to a cell reading "44 min / 45 min". The
  follow-up twin of the same threshold had said "nearing" all along; the two
  now agree, in all three languages.

- **An opencode run that is working no longer reports "no activity".** Every
  subagent opencode starts gets a session of its own in the same directory, and
  the hub read a run's activity off whichever session had been created last —
  usually a subagent that had already finished. So a run whose agent was
  demonstrably working showed the yellow "no activity" note in the overview,
  and its tokens and cost were that one subagent's numbers (measured on a live
  run: 49 133 tokens shown against 303 513 really spent, $0.015 against $0.14).
  The hub now reads the run's whole session tree — the run's own session plus
  every subagent under it — and takes the newest sign of life anywhere in it,
  down to a tool call inside a turn that is still running.
- **"No activity" is taken back when the agent comes back.** It used to be
  cleared only by a progress report, so a run that had been quiet once carried
  the note for the rest of its life — which reads as "this agent is not
  running" long after it is.
- **hermes runs are no longer flagged as idle.** There is no activity source
  for hermes, and "nothing measured" was being spent as "nothing happening":
  every hermes run longer than a quarter of an hour got the note automatically.
  The traffic light now only says "no activity" where activity is actually
  measured — the rule the incident detector already followed.
- The OpenRouter serving-provider choice (open / auto / pin) is visible again
  on a form that OPENS with OpenRouter already selected — a favorite as
  template, an agent's stored setup, or the last run's choice. The block was
  only shown when the provider was (re-)picked by hand, so the auto/pin
  decision silently stayed at "open" for everyone who did not re-select the
  model they had already selected.
- The agent skills refuse to build a run or an agent without a model provider.
  A coding agent that is not on a subscription needs one — even where only one
  is available — and the hub itself accepts an empty field, because that is its
  path for a hand-typed complete model slug. Agents were being created that
  way: they saved, scheduled, started, and then died at their first API call
  with no credential in the session, which on opencode looks exactly like a
  provider outage. `fl-options.py check` now exits 1 and names the valid ids,
  `fl-options.py agents`/`favorites` name the stored rows that already carry
  the hole, `agent-edit.py` will not save one, and the swarm template refuses a
  route without one. Which coding agent needs a provider is asked of the plugin
  registry, so an installed plugin is covered by the same rule.
- Retrying a run offers its terminal again: the retry now clears the
  closed-session mark the old attempt left behind.
- Cancelling a run that has just failed (its pane died a second before the
  click) now records it as aborted, instead of leaving the status the watcher
  wrote and only closing the session.
- A refused push during integration records both output streams (and up to
  1200 characters), so the reason a merge was blocked is actually in the
  reason.
- The pre-push guard resolves its own symlink, so a hook installed by the
  setup script really checks the committed state instead of reporting a false
  green.

### Removed

- Two unreachable routes and two unread HTML attributes.

## 2026-09-03

### Added

- Freilauf ships its own agent skills — a family of instruction files that
  teach any coding agent to drive the hub — installed at user level into the
  smallest set of directories that covers every configured coding agent, off
  by default, with the operator picking which ones go in, and a marker file so
  removal can only ever take back what the hub wrote.
- A read-only JSON API and the `fl-api` front door, so a skill asks the hub
  instead of scraping its pages; installed skills find their own hub from a
  calling card written next to them.
- A skill for developing plugins, which points at the contract instead of
  restating it.
- A repository can be **deactivated** — the reversible way to put a project
  away: it disappears from every dropdown and starts nothing, while its
  history stays reachable. Deleting one exists too, fenced by a typed repo
  name and a refusal while work is in flight.
- A weekly schedule may carry several times a day, and different times per
  weekday, without reaching for a cron expression.
- A planned run has a green "Start now" button.
- Full-screen and cinema mode for a run's terminal, the choice remembered per
  run.
- Flow blocks `count_runs` (count running runs without the detour through
  HTTP) and `toggle_agent` (switch an agent's schedule on or off from inside a
  flow).

### Changed

- Every one of the hub's own LLM questions plans a **chain**: the primary
  source first, then the configured fallbacks on a transport failure, and only
  when the whole chain is down an exponential backoff with jitter. A coding
  agent on an existing subscription can be the zero-config fallback.

### Fixed

- A planned run's detail page no longer presents it as running.

## 2026-09-02

### Fixed

- Leaving the Welcome wizard now reliably saves "do not show this again" —
  every way off the page (skip link, nav, browser back link) used to bypass
  the checkbox and bounce back to the wizard.

## 2026-09-01

### Added

- Follow-up commissions: sending a message into a finished run's session marks
  it as commissioned again — it displays as running, and the watcher tracks it
  against the expected duration with its own overrun notifications.
- Reports now come in two parts: a short notification text and a longer
  detailed report attached to the run.
- OpenRouter LLM calls that keep failing schema validation get one extra retry
  through a freshly selected serving provider before the hub gives up.

### Changed

- The public host used in run links is now configurable in settings instead of
  being fixed.
- LLM transport failures are now classified (authentication, credits, missing
  model, rate limit, outage, timeout) and their alert messages are translated.
- A replayed report the run already has is recognized and skipped instead of
  being sent again as a duplicate follow-up.

### Fixed

- The Claude usage panel no longer flickers between live and cached numbers
  when the account's usage endpoint is rate-limited; a failed refresh now
  backs off instead of retrying on every pass.

## 2026-08-31

### Added

- An optional post-merge git hook that automatically redeploys the hub after a
  merge, but only when no run is currently active.
- The READMEs now include a screenshot gallery of a demo installation.

### Removed

- Dead code cleanup: removed the orphaned old "Coding agents" settings page
  renderer (replaced earlier by the Plugins page) and other unreferenced
  helpers left behind by prior refactors.

## 2026-08-30

### Added

- Coding agents and model providers become dynamically loaded **plugins**: a
  third-party package can now be dropped onto the machine and configured
  entirely from the UI — its credentials, its budget-gate thresholds, and
  optionally its ability to answer the hub's own internal questions. Settings
  → Coding agents becomes Settings → Plugins, with a five-step Welcome wizard
  for first-time setup.
- Notifications become a plugin too, and are entirely optional — Telegram is
  now the built-in example rather than a hardwired dependency; a hub with no
  channel configured keeps working and simply stays quiet.
- OpenRouter best-provider routing ("serving provider: auto"): the hub can
  automatically pick a serving provider by quantization, region, price and
  health, everywhere OpenRouter is offered — run forms, the hub's own LLM
  jobs, and flow steps — not just as a single pinned tag.
- Follow-up reports: a finished run's agent can keep working and report again,
  with the same integration, merge and flow logic as a first report; a per-run
  switch can silence notifications for one run.
- Incidents now resolve themselves once their condition is demonstrably gone,
  only notify after a grace period (and announce their own recovery), and the
  status sidebar's incident counts link to the overview filtered to open
  incidents.
- A real-integration test suite now exercises actual provider APIs and
  coding-agent CLIs end to end, alongside the existing stubbed test suite.

### Changed

- The project is renamed from cc-hub to Freilauf end to end — CLI, scripts,
  environment variables, directories, database, systemd units, tmux session
  names; a migration script and compatibility shims keep an existing
  installation working through the transition.
- The three READMEs are rewritten for the Freilauf positioning, with the new
  names throughout.
- The Welcome wizard's first step now opens with the product pitch and an
  explanation of the name instead of a feature list, and links to the README's
  FAQ.

### Fixed

- A run is no longer aborted just because tmux failed to answer (timeout, busy
  server, missing binary) — the hub now tells "no server running" apart from
  "no answer at all" and only treats the former as a session actually being
  gone.
- An LLM's automatic retry after an invalid answer used to drop the original
  question, so the repaired answer could be schema-valid and about nothing;
  the retry now repeats the question too.
- Incident detection now ignores hook reports coming from a claude session an
  agent spawned on its own, preventing false alarms on the parent run.

## 2026-08-29

### Added

- New tmux cleanup agent: a selectable setup with its own memory threshold and
  kill target, triggered from a shared "Free memory" dialog reachable from the
  status sidebar and the Sessions page.
- Budget gates now have per-provider optional thresholds (claude, cursor,
  openrouter, deepseek), each with its own on/off switch, plus a "Start
  anyway" button on a deferred run.
- The Claude budget gate, the quota-full anomaly and the cost calculation now
  bind to the correct 7-day window: the general week gates every run, a
  per-model week (e.g. "Fable") only gates a run on that model, instead of the
  account's worst window blocking unrelated runs.
- Status sidebar shows the combined memory held by every tmux session on the
  machine, refreshed on the same interval as the rest of the sidebar and
  immediately after a cleanup run ends.
- New central timezone setting (Settings → Time and numbers): all time
  displays, including the sidebar, follow the chosen zone, defaulting to one
  derived from the UI language; numbers and percentages are formatted using
  the UI language's separators.
- A run's "Edit this run" card can now also edit the planned start time (for a
  scheduled run) and the branch rule (for any not-yet-started run), using the
  same widgets and parser as the run forms.
- The run detail page shows the run's prompt in a collapsible block between
  the title and the chips.
- Weekly schedules covering all seven weekdays now display as "daily at HH:MM"
  instead of listing every day.
- Archiving a finished run now also closes the tmux session it left standing,
  with a configurable grace period (default: immediately) under Settings →
  Sessions.
- New "Find worktree extras" button on the repo form: a modal asks a
  configured model to suggest a repo's worktree extras (copied `.env`, linked
  `node_modules`, etc.), configurable under Settings → Worktree extras.
- Report and notification messages now begin with a header naming the repo and
  either the run's title or the agent that started it, so a message is
  attributable without opening the hub.

### Fixed

- The `quota_full` anomaly is now claude-only and names the exhausted window,
  so a run on a different coding agent is no longer flagged red because a
  claude agent used up its own quota.
- The per-model Claude week no longer falls back to a stale reading from the
  status-line file when the account's live answer is temporarily missing,
  which had made the usage bar jump between old and current values.
- Worktree-extras suggestions that come back empty are now accepted as a valid
  (empty) result instead of showing an error and leaving the dialog open.

## 2026-08-28

### Added

- Finished runs can now be integrated automatically: when merging is enabled
  for a repository, the hub checks the run's work, merges it into the base
  branch itself, and escalates to a conflict-resolution run and then to a
  human when it cannot merge on its own.
- A flow can trigger right after a merge into a repository's base branch, and
  a new shell-command step lets a flow run a command on the hub machine
  (optionally detached, so a flow can even restart the hub after a merge).
- A run's branch can be kept without merging ("keep the work on its branch"),
  and the branch-rule explanations in the run form now match what actually
  happens under each merge setting.
- A running or waiting run's expected duration can now be changed live, and a
  scheduled or deferred run's prompt and target repository can be edited
  before it starts.
- The status sidebar refreshes subscription usage and per-status run counts on
  its own every 30 seconds, and now shows how many runs of a status are in
  flight across all repositories, not just the current one.
- The chosen repository is remembered across page loads in a cookie, and a
  page now shows a note when it is still tied to a different repository than
  the one selected in the header.
- Old flow-run history is pruned automatically after a configurable number of
  days.
- Quick Run's "More settings" now opens the full run form pre-filled with the
  dialog's choices instead of starting over.
- A new agent-facing setup guide and a trilingual README (English, Chinese,
  German) make the project self-explanatory to a newcomer and their coding
  agent.

### Changed

- The project's license changed from MIT to CC BY 4.0 (attribution required).
- Deleting or moving an agent moved from the overview table to the agent's own
  edit page, behind the confirmation dialog.
- The Archive page is no longer in the header navigation (still reachable from
  the overview and by direct link).
- The hub now runs from its own dedicated deployment checkout instead of the
  directory an operator edits in, so a restart can no longer serve
  half-finished or stale work; deploying gained a scripted
  fetch/checkout/health-check/rollback flow with failure notifications.
- The proxy now speaks HTTP/2, static files are served from an in-memory
  validated cache, and the sidebar's usage and balance panels return instantly
  with stale data while refreshing in the background — pages that used to
  stall on a slow vendor API or a browser's per-origin connection limit now
  respond immediately.

### Fixed

- Claude's usage percentages are now read live from the account instead of a
  local status-line file that could be hours stale, which had let runs start
  against a quota that was actually nearly exhausted.
- The repository dropdown no longer snaps back to a run's own repository after
  switching repos in the header.

## 2026-08-27

### Added

- Agents can be given a "goal" — a completion condition typed into the coding
  agent's own session after the run starts, so it keeps working by itself
  until the condition holds (currently supported by claude).
- Agents can now be deleted (their past runs keep their own definition and
  title) and moved to another repository; agent names are unique per
  repository rather than per hub, with duplicates handled as a readable form
  error or an automatic rename.

### Changed

- A finished run's terminal is now writable based on whether its tmux session
  and agent are still alive, not on the run's stored status — claude, opencode
  and cursor keep running after reporting done, so a finished run can still be
  given follow-up instructions; hermes, which exits when done, is now labeled
  accordingly.
- The favorite's setup summary in the run form now shows as a styled bubble on
  hover/focus instead of a native browser tooltip.
- The DeepSeek provider label in the sidebar was shortened for a cleaner fit.

## 2026-08-26

### Added

- Live UI: runs now announce themselves over a live update channel, so titles,
  statuses and archived/unarchived state refresh in the browser without a page
  reload.
- Redesigned status sidebar, present on every page, showing pipeline state,
  work in flight, open incidents, quota fill and provider balances — replacing
  the old header bars and a usage panel that only existed on the overview.
- Favorites and Quick Run: save a coding agent, provider, model, effort, extra
  skills and attached flows as a named favorite, then start a run from any
  page through a Quick Run dialog that only asks for the task (branch rule and
  start time stay tucked away, folded).
- The Quick Run dialog's start-time choice sits directly next to the task
  instead of behind a fold, since deciding a run's timing is part of deciding
  its task.
- Runs can be archived once finished, moving them off the overview onto a new
  paginated Archive page with a restore button; retrying an archived run
  brings it back automatically.
- cursor runs now end reliably even if the agent never reports being done,
  detected through a stop hook and its transcript log — previously such a run
  stayed "running" forever and blocked every other run waiting for a free
  repository.

### Changed

- The overview table drops from eleven columns to seven without losing
  information, by combining status/anomaly and harness/model pairs into single
  cells.
- Both light and dark color schemes are treated as first-class designs, fixing
  missing or inconsistent colors (links, buttons, badges) that only ever had a
  light-mode rule.
- The platform prompt suffix setting now adds to the built-in finishing rules
  instead of silently replacing them — a customized suffix had been dropping
  the instruction to always report when a run is done.

### Fixed

- The DeepSeek reasoning-effort field now appears correctly on a pre-filled
  run form instead of staying hidden.
- Confirmed cursor's three separate end-of-run detection channels (stop hook,
  transcript, process exit) notify exactly once instead of risking duplicate
  messages.

## 2026-08-25

### Added

- A repository can carry its own prompt, added to every run started against
  it.
- A Sessions page listing every tmux session on the machine — age, last
  activity, state, the run behind it, and memory/CPU use — with running agents
  hidden by default and a bulk action to end idle sessions.
- Every run now gets a name: typed in, taken from the agent, or auto-generated
  from the prompt and later refined by a cheap model; any run can be renamed
  inline from the overview or its detail page.
- A single run can be scheduled to start at a given time, after a delay, or as
  soon as its repository is free, the same way an agent's schedule can.
- Flows can be attached directly on the agent form and the single-run form,
  with a condition (always, on success, on failure) chosen right where the
  flow is picked, instead of through a separate menu and a duplicate filter.
- Flow variables are now typed end to end, and placement rules for flow steps
  are enforced identically in the designer and on the server.
- One shared run-definition path now backs every way to start a run (agent
  form, single-run form, API, flow steps) — including the quota/budget check
  that previously only agent-started runs went through.
- The header shows separate 5-hour and 7-day Claude quota bars, each with its
  own reset time, instead of folding two different 7-day windows into one.
- The Cursor usage bar now asks the Cursor account for the real included usage
  instead of assuming a fixed dollar amount, and cursor's "auto" model is
  shown clearly.
- The overview shows when each run started, as a relative time with the exact
  timestamp on hover.

### Changed

- The remembered coding-agent/provider/model/effort setup on the run forms is
  now kept per coding agent, and resets when switching agents instead of
  carrying over incompatible settings.

### Fixed

- Incident detection no longer flags a run red for matching text the agent
  itself produced (its own log lines, or Freilauf's own source/test output); a
  run that keeps producing measurable work now vetoes a false escalation.
- Starting a run with a fixed branch already checked out by another worktree
  now fails with a readable explanation instead of a raw git error.
- Inline renaming in the overview now actually works, and no longer sends the
  same rename twice.
- opencode runs that silently sat idle: long prompts are now submitted with an
  extra Enter press after the editor draws, fixing runs that appeared to start
  but never began working.
- Sessions table row hover contrast fixed in dark mode.
- The help-call box is readable in dark mode.
- A quota percentage rounding artifact (values like 28.000000000000004) is
  fixed.

## 2026-08-24

### Added

- Initial release of the hub: a web UI that manages autonomous coding agents,
  each run in its own tmux session and git worktree, under the MIT license.
- Coding agents and model providers become modules of their own, with a
  settings page to add, edit and remove configured coding agents
  (auto-detecting installed CLIs).
- A subscription usage panel showing Claude Code quota, Cursor usage and
  OpenRouter credits.
- Multilingual UI: English (default), German and Chinese.
- No-code flows: a visual designer and engine for automations triggered by a
  finished run, a cron schedule or a button — messaging running agents,
  starting other runs, extracting structured data from a report, branching,
  looping, notifying, and delaying.

### Changed

- The flow trigger for a finished run uses one scope selector (all runs,
  certain agents, or one repository) instead of a combinable
  agent-and-repository filter that could silently match nothing.

### Fixed

- The flow designer is readable in dark mode instead of showing unreadable
  text on a stuck-white background.
- Restarting the hub's service no longer kills already-running agents' tmux
  sessions.
