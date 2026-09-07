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

## 2026-09-07

### Fixed

- **Giving a finished run more work through its terminal did not clear the
  alarm about the previous instruction.** When you type new work into a
  finished run's session, the hub starts holding it to the expected duration
  again and, if it runs long, says "follow-up far over the expected duration"
  and sends you a message. The next instruction was supposed to start that
  clock over and take the old statement back — and it did, but only when it was
  typed into the run page's *message* box. The terminal writes straight into
  tmux, so an instruction typed there left the old alarm standing. Measured on
  run 49a26807: the alarm went up on Sunday evening, the operator typed the
  next instruction on Monday afternoon and had an answer within a minute, and
  the run still showed a red dot over the Sunday statement a day later. Two
  things that cost: the alarm could not be switched off (typing the next
  instruction is exactly the gesture that should clear it), and, because the
  hub remembers that it already messaged you about this overrun, a later
  instruction that really did run long could never reach you. Both ways in now
  start the clock afresh. Only a line you submit does — a tool call the agent
  makes on its own does not, or the alarm could never fire at all.

- **A run whose agent kept saying "I am waiting" was called idle every half
  hour anyway.** The hub believes a coding agent's own word about whether it is
  working or sitting at its prompt, unless measured activity runs past the
  moment it said so — but the moment was only recorded when the word CHANGED,
  so an agent that kept repeating itself never renewed its own witness and any
  activity that ever happened afterwards counted as a contradiction for the rest
  of the run. Measured on run 4eeaa0bc: its claude ended a turn about every 32
  minutes and reported itself idle a minute after each one, while the recorded
  moment stood a day behind — so the "no activity" watchdog ran under an agent
  that was demonstrably at its prompt, and the run wrote and retracted
  `anomaly:no_activity` 41 times in 29 hours. Each of those was a yellow dot on
  the overview and a refresh in every open browser. The moment is now renewed
  whenever the agent says the same thing again; the event, and with it the live
  update, is still written only on a real change.

- **A blocked merge said "integration error" and nowhere said which one.**
  `blocked_error` covers every git, network, auth and pre-push-hook failure
  there is, and the sentence that tells them apart was recorded and then shown
  to no one: the run's event list renders event kinds only, so a run whose push
  was refused offered five identical `merge_error` lines and no cause, and the
  only route to it was reading the database by hand. The detail page's
  Integration block now carries the reason behind a fold, from the same record
  the notification is built from, so the page and the message cannot disagree.

- **…and that reason had been cut off before the part that explains anything.**
  It kept the first 1200 characters, while a hook's verdict is its last line and
  its evidence is everything before it. Measured on run 149a666b: the operator's
  private-value guard printed 33 lines about hits it waved through and only then
  the file it actually refused over — the cause sat at offset 3325 of 4089 and
  the record held none of it. Both ends are kept now, tail-weighted, with the
  number of dropped lines named in between; the excerpt reaches 4000 characters,
  which is what a failed merge check next to it already kept. The message sent
  to the operator is excerpted the same way instead of keeping its first 300
  characters, which were git's "failed to push" — something the word "blocked"
  beside it had already said.

- **A run with an open follow-up showed a duration that had nothing to do with
  the alarm next to it.** The "duration / expectation" pair and the follow-up
  overrun both measure against the same `expected_minutes`, but from different
  starts: the cell counted the first attempt, the alarm counted the commission.
  So run 49a26807's row read "477 Min. / 800 Min." — comfortably inside — with a
  red dot and "follow-up far over the expected duration" beside it, because the
  commission had been open for 24 hours and that number appeared nowhere.
  Neither cell was wrong on its own and together they were unreadable. While a
  commission is open the pair is now about the commission, like the status word,
  the sort and the sidebar's counts already were, and the detail page's runtime
  line marks which clock it is on. A follow-up sitting in the finish gate keeps
  the attempt's clock, because there the deadline is the gate's own.

- **A claude run's token counts were wrong in both directions at once, and the
  "out" figure was one no model could have produced.** The transcript reader
  added `cache_creation_input_tokens` — a prompt-side field, named and billed as
  input — to the OUTPUT total: run 8ee6a523 ran 79 seconds and its detail page
  credited it with 416 105 output tokens, 5 267 a second, where the transcript's
  own `output_tokens` come to 10 775. The inflation was not a constant one could
  read past either (38× there, 2.6× on two others), because what was being added
  is the cache traffic and not the answer. At the same time the sums covered only
  the last 500 records of the transcript, so a run's token count silently *shrank*
  as it grew past that and changed retroactively on every pass — 149a666b was
  credited with 104 885 of the 143 975 output tokens it had written, and
  4e9d5819 with 65 % of its own. Both counts are now what the whole file says,
  with cache writes and cache reads counted as the input they are. Existing runs
  keep the figure they were recorded with; a run still going is corrected on the
  next watcher pass.
- **The sessions page and the status sidebar beside it printed different totals
  for the same tmux memory.** The page measures the machine itself (it needs a
  row per session) and summed that list for its headline, while the sidebar
  rendered into the very same response served its own cached measurement — both
  honest, up to eight minutes apart, and nearly a gigabyte apart on screen
  ("31,3 GB" against "32,2 GB in 42 Sessions"), with nothing to tell the reader
  which one the machine was actually holding. The page now publishes the reading
  it has just paid for, and the sidebar quotes that — one number, and the next
  sidebar refresh does not shell out again for a measurement that already exists.

## 2026-09-06

### Added

- **Settings → Sandbox now says which images this installation needs and whether
  it has them**, and builds one in the background instead of holding the request
  open. A build used to be an awaited call inside the click: a hung browser tab
  for two to seven minutes, no step, no percentage, and two operators clicking
  at once ran two identical builds. Now the page shows a row per image with its
  state — built, not built yet, building (with the step it is on), or *the
  runtime did not answer*, which is deliberately not the same as "not built" —
  and the progress arrives on the live channel. The list is derived from the
  **enabled** coding agents plus the base image, any image a repository names
  and the proxy engine's own, so a coding agent that arrived as a plugin appears
  there too; it used to be five names written out in the page.
- **A missing sandbox image is now built the first time a run needs it.** That
  is what the settings page had claimed for months while nothing did it: the
  launch path only ever *pulled*, and `freilauf/agent-*` is a local tag no
  registry can answer for, so the run died with "not on this machine and could
  not be fetched — build it under Settings → Sandbox". The first run that needs
  an image now builds it (the base first, if that is missing too) and says so on
  its own event list; a second run needing the same image joins that build
  rather than starting another. Building ahead of time on the settings page is
  still the difference between a run that starts in seconds and one that starts
  in minutes.

### Fixed

- **An alarm nobody has dismissed yet now switches itself off too.** The fix
  below stopped a repainted screen line from *reopening* an alarm somebody had
  closed. It could not help an alarm that was still open — and that is where
  the same repaint did the real damage: every repetition pushed the "nothing
  has happened for ten minutes" deadline forward by thirty seconds, so the
  alarm could never reach it. Seen the next day on the same run: still red
  thirteen hours after the rate limit had lifted, 255 recorded occurrences,
  and the agent committing code the whole time. The hub now applies the rule it
  already had — an agent that is demonstrably still working is not blocked by an
  API error — to open alarms as well, so the alarm settles by itself about ten
  minutes after the agent gets going again. An agent that really is stuck goes
  quiet, and there nothing is vetoed and the alarm behaves exactly as before.
- **A repeat of an alarm no longer fills the run's own history.** Every one of
  those repetitions was written into the run's event list and pushed to every
  open browser — 1296 of them for one run in twelve hours, burying the six
  steps that actually described what the run did. A repetition the hub has
  decided to ignore now goes only into the detector log, where "seen and
  ignored" belongs.
- **"Quota exhausted" is taken back when the window refills.** A quota window
  resets — that is what a quota window does, and the hub even wrote down when.
  It never looked at it again: a run flagged at eight in the morning still
  carried "quota exhausted (5h · 08:49)" in the overview thirteen hours later,
  while the account reported that same window at 2 % and the run was working
  normally. The flag now comes off as soon as the window has room again. It
  deliberately stays on while the account says nothing at all — a reading that
  failed is not a reading that says the quota is free.
- **A claude run's "last activity" is what the agent wrote, not when its file
  was touched.** The hub read the age of the transcript file, on the assumption
  that only the agent ever writes it. It is not so — claude rewrites
  transcripts it is not working in, several at a time: on this installation one
  run's file carried a timestamp twenty-one hours newer than the newest thing
  in it. Three things hang on that figure, and all three were wrong in the
  expensive direction. The activity line on the detail page claimed work that
  never happened. A run whose agent was sitting idle at its prompt looked busy,
  which paged a human about follow-up work that was in fact waiting for that
  very human. And the safeguard that stops the hub raising an alarm about an
  agent that is plainly coping was reading the same figure, so it could vouch
  for an agent that had been stuck for hours. The hub now reads the newest entry
  the agent actually wrote, and falls back to the file's age only for a
  transcript that carries no times at all.
- **An alarm you have dismissed now stays dismissed.** A coding agent's terminal
  repaints itself, and everything it repaints is written to the run's log a
  second time — so an error message still sitting on the agent's screen came
  past the hub's log scanner again and again as if it had just happened. Seen on
  a run that hit a genuine rate limit in the morning: hours after the limit had
  lifted, with the agent visibly working again, the hub was still recording that
  same line every thirty seconds. The incident could never settle by itself,
  because "nothing has happened for ten minutes" can never come true that way —
  and dismissing it by hand did not help either: the next check brought it
  straight back, with a fresh notification. The hub now applies the rule it
  already had elsewhere: an agent that is demonstrably still working is not
  blocked by an API error, so a repeat of the same message while it works is
  noted and nothing more. An agent that really is stuck goes quiet, and there
  the alarm comes back and announces itself exactly as before.
- **A run you gave follow-up work to is measured again while it works.** From
  the moment a run reported for the first time, nothing looked at it any more:
  its "last activity", its tokens and its cost froze at that report and stayed
  frozen while the agent went on working in the very same session for hours.
  Seen on a run whose page claimed its last activity was the previous
  afternoon while its transcript had been written forty-five minutes earlier —
  twenty-one hours of work, none of it counted, and the figure presented itself
  as current. Two things follow from the fix besides an honest activity line
  and honest token and cost figures. The follow-up work now shows up in the
  numbers as it happens. And the safeguard that stops the hub believing a stale
  "waiting for input" mark works here too: it compares the mark against
  measured activity, so on a follow-up run — where that activity could never
  move — it could never fire, and a run whose agent had stopped reporting
  properly could keep its follow-up overrun alarm switched off indefinitely.
- **A run whose agent is plainly still working no longer reads "waiting for
  input".** The word comes from the coding agent's own hooks — one says it has
  started, another that its turn is over — so where only the second half of that
  pair arrives, the "waiting" mark goes on and never comes off. It happens: the
  hooks that report *working* are younger than the ones that report *waiting*,
  and a session already running cannot be given new ones. Seen on a claude run
  that had been marked "waiting for input" for four and a half hours while it
  finished a turn every few minutes. The hub now stops believing the mark when
  the agent's own transcript has been growing well past it — and with it the
  "no activity" watchdog, which had been switched off for that run the whole
  time. An agent that is genuinely waiting still reads as waiting; a harness
  that measures no activity at all is unaffected, because silence is not
  evidence.
- **A merged run no longer claims its branch was never pushed.** The overview
  showed a yellow "worth a look" dot over the line *branch not pushed* on runs
  whose work the hub had merged into `main` itself — the anomaly was written two
  seconds after the merge, back before the check learned to skip merged runs, and
  once written it went on colouring the row for ever. The check that stops it
  being written now also stops it being *shown*: a run whose work the hub put on
  `origin` (merged, or kept on its branch and pushed there) is not asked the
  question and is not coloured by an older answer to it either. A run that really
  does have work living only on this machine is unaffected — that is what the
  warning is for.
- **A run that lasted less than a minute showed no duration at all.** The
  overview printed `/ 25 min` with nothing before the slash, which reads as "no
  runtime recorded" rather than "under a minute" — and it did so on exactly the
  runs one wants to read, the ones that died seconds after starting. The run's
  own detail page said `0 min` in the same breath. Both now say the same thing.
- **hermes could not start in a container at all** — the pane died immediately
  with exit 127. The host's `~/.local/bin` is mounted read-only into the box so
  `fl-report` is reachable, and it was placed *first* on the container's `PATH`;
  since a sandboxed run launches its agent by bare name, `hermes` resolved to
  the host's wrapper, which runs a python virtualenv that exists only on the
  host. The image's own directories now come first.
- **claude on a subscription could not authenticate in a container.** Its
  terminal showed "Not logged in · Please run /login" while the run said
  `running` and looked healthy from every page. Outside a container claude signs
  in from a file in your home directory that a sandboxed run deliberately does
  not get; that token is now read and passed in as the variable claude documents
  for it. The file itself never enters the container, so nothing in there holds
  a refresh token. For unattended installations `claude setup-token` is still
  the better answer, because an interactive login's token is short-lived and
  cannot be refreshed inside the box.
- **A credential a coding agent cannot start without now refuses the launch**
  instead of starting a session nobody is logged into, and the refusal says what
  to do about it. Only a plugin that declares the credential *required* can
  refuse — cursor is a subscription CLI too and runs without one.
- **A sandboxed run whose agent died went on holding its network and its egress
  proxy.** The reaper asked only whether the tmux session was closed, but a
  crashed run's session is kept open on purpose so its screen stays readable —
  so `fl-proxy-<id>` kept running for hours with nothing behind it, and the
  per-run networks accumulate until no sandboxed run can start. A dead pane now
  counts as evidence that the agent is gone. A finished run whose agent is still
  sitting in its terminal keeps everything, because follow-up work there still
  needs it.

### Changed

- **The sandbox documentation is now one file, [SANDBOX.md](SANDBOX.md), at the
  repository root.** It merges the former `docs/sandbox.md` (the operator
  reference) and `SANDBOX_RESEARCH.md` (the design study), both now deleted: the
  reference comes first, and a second half, "Why it is built this way", carries
  the design study condensed to the measurement behind each decision. Links from
  the READMEs, `AGENTS.md` and `SETUP_WITH_AGENT.md` now point there. The
  roadmap, whose one item (the sandbox) has landed, is back to empty.

## 2026-09-05

### Added

- **A run's agent can work inside a container.** Optional, **off by default**,
  and an installation that never switches it on behaves exactly as it did. Turn
  it on under **Settings → Sandbox**, where the hub says what container runtime
  it found and refuses to be switched on without one. The boundary — network,
  filesystem, resources, secrets — is one profile document that four layers may
  contribute to (hub → repo → agent → run), and **a lower layer may only ever
  narrow what a higher one locked**; an attempt to loosen a locked field is
  refused and written down, never silently applied. A sandboxed run gets a clone
  of its own instead of a linked worktree, its own `HOME`, and a network whose
  only way out is an egress proxy that answers a readable **403** for a host
  that is not on its allowlist; everything the hub does with tmux — the
  terminal, `fl-attach`, `fl-kill`, the log, typed messages — is unchanged,
  because the pane's process is the container's client. **The full reference,
  including a long section on what the sandbox does *not* do, is
  [SANDBOX.md](SANDBOX.md).**
- **Five shipped profiles**: **Balanced**, **Locked down**, **Open network**,
  **Audit** and **No secrets in the box**. The first four run on the built-in
  proxy and pass credentials in as environment variables, so they start a run on
  any machine that has a container runtime and nothing else.
- **A sandboxed run no longer has to be told which image to start from.** Where
  neither the repository nor the profile names one, the run uses the image the
  coding agent's own plugin declares — the same name the Settings page builds,
  so the two cannot drift. `image.pull` fetches a missing image where the
  profile allows it (`if-missing`, `always`), and one that is still missing
  afterwards is a **refusal that names the image**, before the clone, the home
  and the network are created.
- **The container no longer has to hold your API key.** `secrets.mode: inject`
  routes the run's egress through iron-proxy (`ironsh/iron-proxy`, pinned by
  digest in `sandbox/images/ironproxy.ref`): the agent's container holds
  `fl-token-<random>` and the proxy swaps in the real credential on that
  credential's own declared hosts and on nothing else. That is what the fifth
  profile, **No secrets in the box**, is. It is deliberately not the default —
  it needs the iron-proxy image pulled, a CA on the machine and an `injection`
  declaration on every credential the run uses, and each of those missing is a
  refusal at launch that names what is missing, never a quiet fall back to
  putting the key in the box.
- **A sandboxed run can have an enforced allowlist on a rootless daemon.** This
  was the sandbox's largest documented limit: the built-in egress proxy was a
  listener inside the hub process, a rootless daemon keeps the run's network in
  a namespace of its own, and so three of the four profiles that enforce an
  allowlist could not start a run at all. Where the listener cannot live on the
  host, the hub now runs it as a **container on the run's own network** and the
  agent reaches it by name — the same proxy either way, same allowlist matcher,
  same readable 403, same audit format — and that placement is also the
  **stronger** posture, because the run's network keeps its gateway isolated and
  the container cannot reach services on the host at all. Nothing to configure:
  where the proxy runs is a fact about your daemon, not a field in a profile,
  and `FREILAUF_SANDBOX_PROXY_PLACEMENT` forces one if you must.
- **A hub restart no longer costs a sandboxed run its blocked-host events.** The
  hub takes a running proxy container back over instead of leaving it alone, so
  the run goes on reporting what it was refused and a live policy change reaches
  it again; before, such a run kept enforcing correctly and quietly stopped
  saying anything about it. An iron-proxy container is the exception — its
  management key died with the process that minted it, so a policy change there
  is refused rather than reported as delivered.
- **An allowed tunnel is recorded when it opens, not only when it closes.** A
  keep-alive connection to a run's model provider lives as long as the run, so
  the old close-only line meant a run's own provider appeared nowhere in its
  egress log. Both lines carry a `phase` field and pair into a span.
- **When the sandbox blocks something, you get three buttons and the agent
  gets a sentence.** Every refusal is a `sandbox:blocked` event and a row on
  the run's page: *Allow for this run* (live, no restart), *Allow for this
  repo*, *Deny and tell the agent* (which types the decision into the session).
  The proxy's 403 names the host and tells the agent to run `fl-report access
  "<what and why>"` and carry on with what it can do. Network and resource
  changes apply to a running container; a filesystem change resumes the run in
  a new container with the same clone and the same conversation. **Continue
  without the sandbox** is there for the moment none of that is enough — it
  asks first and is recorded on the run for ever.
- **An agent that the sandbox is standing in the way of can say so, and you
  hear about it.** `fl-report access "<what you need and why>"` opens a red
  **Agent needs access** incident in the **Needs you** group and notifies at
  once, with the agent's own words and the three answers spelled out. The run
  **keeps running** while you decide; asking the same thing twice stays quiet.
- **And you are told even when the agent says nothing.** Hosts the proxy turned
  away become a **Sandbox turned a host away** incident — yellow, because a
  wall doing its job is not a fault, and red once it demonstrably is in the way
  (two or more distinct hosts, or no work since the denial); an agent that kept
  working is never escalated. A container daemon that stops answering
  (**`docker_unreachable`**) lands in "Needs you" too: every sandboxed run on
  the machine is behind it.
- **Audit-only mode, and one button to grow an allowlist out of it.** Nothing
  is blocked; everything that would have been is written down, and the repo
  form then lists the hosts this repository's own runs reached, with counts,
  and adopts the ticked ones into its allowlist. That is the rollout an
  organisation actually does: observe first, enforce second.
- **An audit you can hand to somebody.** *Download the audit* on a run page
  (`GET /api/runs/<id>/audit.jsonl`) folds the run's policy, its proxy
  configuration, every request the proxy saw and the run's own events into one
  hash-chained JSONL file, footed by the line count so a truncated copy is
  detectable. It says on its own first line what it proves and what it does not.
- **Per-repo, per-agent and per-run sandbox fields**, a **Sandbox** block in
  the repo form (default, profile, image, audit-only, run the merge check in
  the sandbox too) with a **Dry run** button that resolves the policy without
  starting anything, the tri-state on agents, single runs, favorites and the
  flow designer's "start single run" step, and a **profile editor** under
  Settings → Sandbox. The Plugins page says per coding agent whether it can be
  sandboxed at all, with its image, the hosts it needs and whether its
  credential was found.
- **The sessions page and the sidebar say "unknown" instead of guessing.** A
  sandboxed session's memory is asked of the runtime, because the pane's
  process tree lives in another namespace and under-reports a container by
  about twentyfold. Where it cannot be measured it says so, and the machine
  total says it is incomplete.
- **`fl-start --sandbox <file>`**, with `--dry-run` to print the whole
  container command line without a runtime present; `sandbox/wrap.sh --print`
  does the same from the shell. **`fl-report access "…"`** is a new report kind
  for an agent that needs something the sandbox blocks. **`fl-kill` stops the
  container before it kills the session**, so ending a sandboxed run no longer
  leaves the agent running.
- **"The daemon did not answer" is never read as "there are no containers".**
  A runtime that times out, cannot be forked or is still coming up after a
  reboot means the hub learned nothing, so it does nothing and asks again next
  pass; only a positive answer ever ends a run, and three silences in a row
  raise the incident above rather than a verdict about anybody's work. A launch
  that failed because the runtime could not be *asked* does not count against a
  run's resume attempts either.
- **A hard runtime ceiling per profile.** `resources.maxRuntimeMinutes` stops
  the container, ends the session and aborts the run, once, with one
  notification.

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

- **The merge check can run inside the box too, and refuses rather than
  quietly running on the host.** With **`merge_check_sandboxed`** ticked, a
  sandboxed run's `repos.merge_check` runs in an ephemeral container of that
  run's own image, and where that container cannot be had (no runtime, a
  missing image, a daemon that is positively not there) the merge is
  **blocked** with *"nothing was merged, and it was NOT run on the host"*
  rather than falling back. A run that is not itself boxed still runs its check
  on the host and now says so on the run's record.
- **Taking a planned run out of its sandbox is written down.** Switching a
  `scheduled` or `deferred` run's sandbox off from its edit card records
  `sandbox:bypassed` on the run, and the overview's status cell says
  *bypassed* from then on, so no route out of a sandbox is silent. It is
  refused outright where the hub mode is `required` or bypassing is switched
  off.

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

### Removed

- **The sandbox profile's `user` field is gone.** It was a policy word — "run
  as the hub's identity" — and never a login name; the container's identity has
  always been decided from the daemon's posture instead (the hub's uid on a
  rootful daemon, nothing at all on a rootless one). But a field on a document
  is a field somebody reads, and one did (see the entry below). A profile
  stored with the field keeps working, and a new one is refused in the
  overrides form as an unknown key.

### Fixed

- **A run whose agent died stayed on "running" — the watcher had never once
  noticed a dead pane.** This is the failure shape the whole project is written
  against: a run that looks alive and is doing nothing. The watcher asks tmux
  every 30 seconds whether the run's pane is dead, and it asked with the wrong
  kind of target — a session name where a *pane* is wanted, one missing
  character. tmux does not refuse that: it answers successfully and says
  nothing at all, so the check read "tmux gave no answer", kept its default and
  never fired. The consequence was the same for every coding agent and every
  kind of run: a CLI that crashed, a process that exited, a sandboxed run whose
  container died at launch — all of them sat in the overview as working agents
  until a human looked. Seen on a sandboxed run whose container died at 19:18
  and which was still "running" twelve minutes later with nothing written down
  anywhere. Such a run is now failed within one pass, with the reason and the
  exit status, and the notification that goes with it. Nothing else about the
  path changed — it was simply never reached.
- **A run whose agent was killed said it had exited cleanly.** The exit status
  of a dead pane and the signal that killed it are two different things, and a
  process the kernel shot (an out-of-memory kill, a `docker` client taken down
  with its daemon) carries no exit status at all. It was recorded as `0` — the
  code for "finished without error" — or, when two empty fields ran together, as
  the pane's death time: an exit code in the billions. The run's record now says
  the real status where there is one, nothing where there is none, and the
  signal number next to it.
- **One log line could raise a red incident and page you.** A watcher pass that
  takes longer than 30 seconds overlapped the next one, and a pass now talks to
  a container daemon, which is exactly the kind of call that takes seconds. Both
  passes then read a run's log from the same position and reported the same line
  twice, and "the same error twice within ten minutes" is what promotes a yellow
  observation to a red incident with a message behind it. Two fences: a pass
  that finds one still running does nothing and says so in the log, and the
  reading position is now *claimed* rather than overwritten, so a second reader
  — including one in another process, which is what the test suite is — reports
  nothing instead of reporting it again. Every log line counts exactly once,
  which is what it was always meant to do.
- **The shipped sandbox profiles were shown in English to every reader.** Each
  declares a translated name and a one-line explanation in all three languages,
  and every page rendered the row's stored English name instead. The name a
  profile is stored under is unchanged, so nothing that names one in a script or
  an API call moves; a profile you renamed yourself is yours and is never
  translated.
- **A deny rule the egress engine cannot enforce is now said out loud.** Under
  `iron-proxy` a deny that narrows a wildcard (`deny: evil.example.com` under
  `allow: *.example.com`) has no expression at all; the hub worked that out and
  then wrote its warning into a field nothing ever read. It is an event on the
  run now, so it stands in the run's own history and travels into the audit
  export next to the spec that promises the rule.
- **Every hermes run in a sandbox raised an incident before it did any work.**
  The plugin declared one host of its own and the CLI reaches for four at
  startup, so all four were refused and a yellow "blocked host" incident opened
  on every single hermes run that then succeeded anyway. Deliberately still
  refused: GitHub — a harness declaration widens *every* run of that harness,
  and where a repository really lives on GitHub the `git-host` preset says so
  from that repo's own origin.
- **A sandboxed claude run could not start, could not authenticate, and then
  stood at a dialog.** Three faults on one path. The `sandbox.env` every
  coding-agent plugin declares — telemetry and auto-update switches, and for
  claude the `IS_SANDBOX=1` that lets `bypassPermissions` be accepted as
  container root — was never read, so under a rootless daemon claude refused the
  launch outright. The declared `sandbox.credentials` were never supplied
  either, so a claude run with its token configured on the hub drew its TUI and
  answered *"Not logged in · Please run /login"*. And past both, the
  bypass-permissions disclaimer waited for a keystroke nobody was there to
  press. Declared environment and credentials now travel with the run —
  `secrets.mode` governs the credentials exactly as it governs a model
  provider's key — and the per-run home carries claude's own acceptance flag. A
  sandboxed cursor or hermes run likewise started without the switches its
  plugin asked for.
- **The egress audit log was empty under iron-proxy, and would have stayed
  empty.** The mapper read the request fields at the top level of each line
  while the real binary puts them inside an `audit` object, so every line a real
  proxy writes would have been dropped — a silence that reads exactly like a
  quiet run.
- **Several iron-proxy policy settings were being written into keys the binary
  ignores**, so a policy could look applied and do nothing. Deny hosts are now
  removed from the allowlist itself, a method restriction is written as the
  per-host rule iron-proxy actually reads, and a deny that engine cannot express
  at all is reported to the operator instead of silently dropped. Credential
  injection also rejected every request it was meant to permit — the config
  asked the proxy to refuse requests to a declared host that do not carry the
  placeholder, which refuses the connection before any header exists; it is no
  longer set.
- **opencode's own model catalog was blocked on every sandboxed opencode run.**
  The harness declared `opencode.ai`, and a bare domain deliberately does not
  imply its subdomains — so `models.opencode.ai` was refused within seconds of
  every launch. The declarations now say `.opencode.ai` where a vendor really
  serves from subdomains; cursor's and the package-registry preset were
  corrected the same way.
- **The blocked-hosts alarm no longer goes red about the operator's own preset
  gaps.** A host counts toward the "several distinct hosts" escalation only where
  the agent was demonstrably at work when it was turned away — never before its
  first turn, never for a host it went on working past. Silence since a denial is
  still judged against every denial, so a provider missing from the allowlist is
  still caught.

- **The first host a sandboxed run was refused could have taken the whole hub
  down.** A client that has been refused a tunnel resets the connection, which
  arrived on a socket with no error handler and killed the proxy a second after
  its first denial. Where that listener runs inside the hub process — a rootful
  daemon, or a published address — the process that died would have been **the
  hub**: scheduler, watcher and every open page, at the moment an agent first
  hit its own allowlist.
- **The hub really could not read a sandboxed run's working copy, for ever, on
  a run that looked perfectly healthy.** Every git call the hub makes inside the
  box — the finish gate's dirt check first of all — ran as a user that exists on
  no image, so the gate answered *"the working copy could not be read"* every
  few seconds and the run stayed `running` with its agent idle in its TUI. The
  identity is answered by one function now, as a numeric uid that needs no
  account to exist.
- **The hub's report socket was never actually mounted.** The mount named the
  path *inside* the container as its source on the host, so Docker created a
  **directory** there and no socket existed for `fl-report` to talk to: every
  report in a sandboxed run silently degraded to the `inbox.jsonl` fallback. The
  two paths no longer share a name; where the hub has no socket listening,
  nothing is mounted and the run records `hub_socket_missing` rather than
  starting with a directory that looks like a channel.
- **The report fallback works inside the container too.** `inbox.jsonl` is
  written to the configured runs directory (see Security below), but that
  setting was not passed into the container, so inside the box it fell back to a
  path the hub never reads — the agent did the work, reported, was told the
  report was safe in the inbox, and nobody ever picked it up. Both channels dead
  at once.
- **A sandboxed container has a name and labels again.** The launch document
  named the run under one key and the launcher read another, so every container
  was started as `--name fl- --label freilauf.run=`: two runs collided on one
  name, stopping a run addressed nothing, the pass that cleans up orphaned
  containers matched nothing, and the sessions page could not ask the runtime
  for that container's memory. A document that names no run is now refused
  rather than started nameless.
- **`docker` in the run's own tmux pane talks to the same daemon as the hub.**
  With no `DOCKER_HOST` the pane fell back to the rootful socket, which on a
  rootless installation is absent or unreadable, and the pane died half a second
  after the start with a permission error. The launcher now exports the endpoint
  the hub resolved, and `sandbox/wrap.sh --print` prints it in front of the
  command line so the copy really is reproducible.
- **A finished sandboxed run's clone is cleaned up again.** Retention checks a
  worktree for uncommitted work before removing it, and by then the run's
  container is always gone, so that check was refused and read as "dirty" —
  every sandboxed run left a full clone behind for ever. The check now falls
  back to the same neutralised host git the operator's own rescue buttons use,
  and where nobody could look at all the record says `unreadable` instead of
  claiming there is uncommitted work.
- **A merge check that runs in the sandbox can execute what it unpacks into
  `/tmp`.** Docker adds the `--tmpfs` options you name to its `noexec` default
  rather than replacing them, so a toolchain that writes a helper into `/tmp`
  and runs it failed the check while the run that produced the code succeeded.
- **A live policy change says which half of it is in force.** The network rules
  go to the egress proxy and memory/CPU/process limits go to the container
  runtime, and the answer now reports them separately: a change that only raises
  a limit is applied even when the hub holds no proxy for that run, a change to
  the network rules with no proxy to carry them is **refused** with the reason,
  and one that carries both is reported as **partly applied**, naming the half
  that did not land. The new policy is recorded on the run either way, so a
  restart comes back with what was asked for.
- **A sandboxed run's `sandbox.json` and `proxy.yaml` are never written through
  a symbolic link.** Both live in the run's own directory, which is mounted
  read-write into the container at the agent's uid, so a link left at one of
  those names made the hub write through it as the hub user. The write is
  refused now, and the refusal is the launch failure it is.
- **A sandboxed run's allowlist really reaches its proxy.** The built-in
  engine's listener bound to `127.0.0.1`, which inside a container is the
  container itself, so `network.mode: allowlist` had never worked end to end
  with that engine. It binds to the run network's own gateway now, and a network
  whose gateway it cannot learn is a **refused launch**, never a fall back to
  loopback — a run that looks sandboxed and routes nothing is the worst outcome
  available here. What that costs is stated rather than hidden: the container
  can then also reach host services on that bridge, which is why the proxy's own
  refusal to connect into loopback, RFC 1918, CGNAT and link-local addresses is
  not optional. All of this is about the in-process placement, which is what a
  rootful daemon gets; on a rootless daemon the proxy moved into a container the
  same day (see *Added*), and the refusal that used to name that combination as
  impossible now survives only for an operator who forces the listener into the
  hub process themselves.
- **A hub restart no longer strips a running sandboxed run of its egress.** The
  built-in proxy lives in the hub process, so a deploy took it with it and left
  the container talking to a dead port for the rest of its life. A watcher pass
  now rebinds the listener on the same port with the same resolved allowlist and
  records `sandbox:proxy_restarted` on the run; a proxy that cannot come back
  leaves a warning on the run and never fails it. A proxy **container** the
  daemon says is gone is started again, one that is still running is taken back
  over (see *Added*), and for an iron-proxy container the hub has no handle and
  does not invent one — so a live policy change there is **refused with "the
  proxy is gone"** instead of reporting a policy it never delivered.
- **The hub's floor holds on every path that writes an override.** A path the
  hub locked could be loosened through the **Reconfigure…** button on a running
  run, through the repo form, through "Adopt these hosts", through the profile
  editor and through a flow step — only the agent and run forms ever enforced
  the rule the whole layering rests on. All of them now resolve the layers above
  first and refuse a loosening by name, the sandbox facade checks it once more
  before a policy reaches a live container, and a flow whose "start single run"
  step carries a loosening override is refused when it is **saved**, not when it
  fires at three in the morning.
- **Claude's transcript is found again for runs whose path contains anything
  but letters and digits.** The hub derived claude's project directory by
  replacing only `/`, while claude replaces **every** non-alphanumeric
  character — so for a worktree path with a dot, an underscore or a hyphen the
  hub silently read no transcript at all: the run looked idle while it worked
  (a false "no activity" flag) and API errors in that transcript were never
  seen. This affects **every** claude run, sandboxed or not.
- **A skipped check no longer counts as a pass.** A check that skipped part way
  through was counted green in the test summary, which is exactly backwards for
  a suite whose skips exist to say "this could not be verified here". The count
  of skipped checks is now printed on a failing run too.
- **A run whose work the hub merged is no longer reported as "branch not
  pushed".** The integrator merges a run's branch into the base branch and
  pushes *that*, which leaves the branch itself one commit **behind** its
  upstream — with not a single commit of its own missing from the remote. The
  watcher's branch reconciliation read any divergence from the upstream as
  unpushed work, so it raised the yellow anomaly and **sent a notification**
  seconds after the merge, about work that was on `origin/main` by then
  (measured on run d4ee07d2: `merged` at 16:47:56, "branch has unpushed
  commits" on the operator's phone at 16:47:59; two such messages went out over
  the last days). Two things changed: a branch that is only behind its upstream
  now counts as pushed, which is what the worktree cleanup beside it already
  said in its own comment; and a run the hub itself put on origin — merged into
  the base branch or kept on its branch — is not asked the question at all.
  A branch with no upstream, one that is genuinely ahead, and one whose
  upstream has been deleted are reported exactly as before.
- **A finished run that is working again cannot be archived out from under its
  own session.** Archiving closes the run's tmux session, and a run whose
  follow-up commission is open is one the operator is typing into right now —
  the overview shows it as **Running** for exactly that reason. It nevertheless
  offered the archive button and the bulk-archive checkbox in that same row,
  and the route took them: one click would have ended a live conversation with
  the agent. The button, the checkbox and the detail page's archive link are
  gone while a follow-up is in progress, the route refuses with a message that
  says why rather than "only finished runs can be archived", and the run
  archives normally once its follow-up has reported.
- **A retried run is no longer killed by the hub seconds after it starts.**
  "Retry run" set the run back to `running` but left `started_at` on the first
  attempt — and that column is what the watcher's sweep for interrupted starts
  measures its five-minute grace period against. So a retry had no grace at
  all: the watcher pass falling into the two or three seconds between the start
  and the tmux session wrote `failed — start interrupted, no session` over a
  run that was starting perfectly well. The agent then worked and reported as
  usual, but because the row said `failed`, its report arrived as a follow-up
  report, which deliberately keeps the run's status — so the run stayed red for
  its whole life while it was doing its job. The same stale timestamp made
  every retried run overdue from its first second and, on a coding agent that
  reports no activity, silent from its first second. A retry now starts both
  clocks afresh, like every other path that starts a waiting run.

- **A killed test suite no longer leaves its tmux sessions on the machine.**
  `node test/e2e.mjs` and `node test/browser.mjs` kill exactly the sessions
  they created — but only when they get to run their cleanup, and a suite
  started inside an agent's tmux session dies of SIGHUP when that session is
  closed, which node answers by exiting without any handler at all. Measured
  on 2026-09-05: 294 live stub sessions from six killed suites, about a
  gigabyte of memory, and the Sessions page — the one page that exists to find
  a real session by its age — buried under 300 rows of test leftovers. Both
  suites answer SIGHUP now, and a starting sandbox first sweeps what a dead one
  left behind: it reads that sandbox's own list of session names and kills
  exactly those, then removes its directory. A sandbox whose owning process is
  still alive is never touched, nor is one kept with `--keep`.

- **A run start no longer dies in the middle of the worktree checkout.** On a
  busy machine the `git worktree add` of a large repository takes longer than
  the hub's 30-second subprocess default; two swarm-worker starts on a
  17 000-file repository were killed at 78 % of the checkout after ~30 s and
  failed with a run that had never really begun. Worktree fetch and checkout
  now get the same generous timeouts the integrator already uses for its git
  calls (2 minutes). Two smaller wounds in the same spot are dressed too: a
  checkout killed half-way left a partial directory that a retry would have
  silently reused as the run's working tree (it is removed now), and the
  stored failure message was megabytes of git progress spam with the actual
  error cut off — the progress lines are stripped, so the stored message
  names the cause.
- **A long goal is really set now.** A goal of more than about 800 characters
  was typed into the session, looked right on the screen and did nothing:
  claude turns a paste that long into a "[Pasted text #n]" placeholder, and a
  placeholder is not read as a slash command — so the condition was submitted
  as an ordinary message and the run ran without a goal, while the run's own
  page said the goal had been delivered. The hub now does what a person does:
  it *types* the `/goal` and pastes only the condition after it. Nothing about
  a short goal changes, and a goal that was already delivered as a message is
  not repeated — the fix takes effect for runs started after the deploy.
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
- **A worktree path with a dot, an underscore or a space made a claude run go
  blind.** Claude stores a session's transcript under a directory named after
  the working directory, and its real rule replaces **every** character that is
  not a letter or a digit — the hub only replaced `/`. So for a worktree whose
  path carried anything else, the hub looked for a transcript that was not
  there: no activity measurement (the run collected "no activity" while it
  worked), no token or cost figures, and the second channel that detects a rate
  limit or a provider outage from claude's own transcript never saw a line. No
  path on the machine this was found on triggered it, which is why it had never
  shown up; a repository or branch name with a dot in it is all it takes.
- **"I could not read the working copy" is no longer read as "there is nothing
  uncommitted".** The finish gate's dirt check answered "clean" whenever the
  `git status` behind it failed for any reason, and "clean" at the finish gate
  means "merge it". It now answers *unknown*, and every caller holds on that:
  the gate keeps the run in the gate and checks again, a run kept on its branch
  is not pushed and called finished, the leftovers of a failed run are shown to
  the operator instead of being reported as none. A run's uncommitted state is
  either something somebody looked at or something nobody knows — never
  silently the first because the second was cheaper to write.
- **A sandboxed run is no longer failed because the container runtime had a
  moment.** For a sandboxed run the tmux pane is the `docker` client, not the
  agent, so a restarted daemon or a `docker run` that never got past `runc
  create` killed the pane and the run was marked `failed` — about an agent that
  was either still working inside its container or had never started at all.
  The hub now asks the **container** what happened: the agent's own exit ends
  the run exactly as before, a client that died hands the run to the ordinary
  resume path (capped), and a daemon that does not answer decides nothing.
- **A sandboxed hermes run's activity and resume id came out of the operator's
  own hermes store.** The one source that still read the host's `$HOME`, so the
  hub looked for the run's session in the wrong file: wrong "last activity",
  and a `--resume` pointing at somebody else's conversation. It reads the home
  the agent actually worked in.

### Security

- **The hub and an agent now have a channel that is only the report API.**
  Until today an agent was handed `FL_HUB_URL`, which is the hub's **whole**
  API — kill any run, type into any session, read the settings that hold the
  notification token and the provider credentials — and `FL_RUN_ID` was the
  only thing standing in front of it. There is now a **unix socket** serving an
  allowlist of exactly two routes (post a report, read this run's own sandbox
  policy), authenticated with a **per-run token** that every run gets. A
  sandboxed run is given the socket and the token and no hub URL at all.
- **The `127.0.0.1` report route still accepts a report with no token**, on
  purpose, for **one transition release**: an agent that is running right now
  was started by a hub that knew no token and its `fl-report` sends none, so
  requiring one would silence every run in flight the moment this is deployed.
  Runs from before the token column keep reporting that way too. A later commit
  removes the exemption.
- The report fallback file (`inbox.jsonl`) is written to the configured runs
  directory rather than to `$HOME/agents/runs`. Inside a container that path
  does not exist, so the last channel a report had would have written into
  nowhere without saying so.
- **A flow's shell command no longer takes text the agent wrote without being
  told to.** A `shell_command` step runs on the hub machine as the hub's user —
  that is what it is for — but its command is a template, and
  `{{trigger.run.report}}`, `{{trigger.run.help_text}}`,
  `{{trigger.run.branch}}`, `{{trigger.run.pr_url}}` and
  `{{trigger.merge.files}}` all carry text a coding agent wrote, substituted
  raw. A flow built the obvious way was therefore a route from inside the
  sandbox to a host shell. The step now names such a variable and refuses,
  unless **"allow text the agent wrote"** is ticked on that step; ticked, it
  works exactly as it always did. What the check cannot see — the same text one
  hop further out, through an `extract` step, another command's output or an
  HTTP response — is written down in [SANDBOX.md](SANDBOX.md) rather than
  pretended away.

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
