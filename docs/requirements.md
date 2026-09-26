# Requirements the code must keep satisfying

One section per area. Each line is an invariant somebody changing that area
must not break; where the reason is not obvious it follows in the same
sentence. The code is the source of truth for *how* any of it is done — a line
here that the code no longer satisfies is removed or corrected, never kept.
Contracts for third parties live elsewhere: `docs/plugins.md`,
`docs/panels.md`, `server/flows/AGENTS.md`, `SANDBOX.md`. Which modules
belong to which section is the "Where is what" table in `AGENTS.md`.

Sections: [Deploying and restarts](#deploying-and-restarts) ·
[Launch and resume](#launch-and-resume) · [Run definition](#run-definition) ·
[Scheduling](#scheduling) · [Quota and gates](#quota-and-gates) ·
[Plugins](#plugins) · [LLM layer](#llm-layer) ·
[Pages and live channel](#pages-and-live-channel) · [Panels](#panels) ·
[Integration](#integration) · [Code review](#code-review) ·
[Reports and follow-ups](#reports-and-follow-ups) ·
[Attention](#attention) · [Watcher and incidents](#watcher-and-incidents) ·
[Sessions](#sessions) · [Repos and archive](#repos-and-archive) ·
[Skills](#skills) · [Tests](#tests)

## Deploying and restarts

- The service runs from `~/agents/deploy/freilauf` — a clone of its own,
  always detached on a commit, owned by `bin/freilauf-deploy`; no service ever
  starts from a human's working checkout.
- The hub resolves everything inside the repo from `import.meta.url` and
  everything outside from `$HOME`/`FREILAUF_*`, never from the process cwd.
- A deploy is one path: flock, fetch, "already deployed" exit 0 without a
  restart (a restart kills flow runs in flight), checkout, clean minus
  `node_modules`, `npm ci` only when the lockfile hash moved, install scripts,
  unit files only when they differ, restart, health check via HTTP 200 plus
  `is-active`, rollback to `previous-sha` on failure, exit 2 if the rollback is
  unhealthy too.
- The journal is printed but is never a verdict: the hub writes "Error" in
  normal operation.
- A failed deploy always notifies through `bin/fl-notify` (the hub's own
  facade); success only with `--notify`; no channel configured is not an error.
- The sidebar prints the running sha, computed once per process and never via
  `git fetch` per render.
- The tmux server has its own unit (`freilauf-tmux.service`, `tmux -D`,
  `exit-empty off`); no deploy restarts it; `KillMode=process` stays as the
  fence while a server spawned elsewhere is being adopted; `enable-linger` is
  part of setup.
- What a restart or reboot does to a run's session and process is answered
  by resuming, never by aborting — see "Launch and resume".
- Missed schedule slots are caught up once per agent at the newest missed slot,
  bounded by `schedule_catchup_hours`; watcher and scheduler run a first pass
  two seconds after listen.
- `freilauf drain` asks every in-flight run (including `waiting_input`) to
  commit and report, and kills nothing.
- The cc-hub names keep answering for one transition release: `CCHUB_*` env,
  old config/data/deploy/cert dirs and `cc-hub.db`, `cc-*` script shims,
  `CC_RUN_ID`/`CC_HUB_URL`, the `cc-` tmux prefix, and the unit that is
  actually active or enabled. `setup/migrate-from-cc-hub.sh` is the explicit
  end of it and refuses when both an old and a new directory exist.

## Launch and resume

- `launchRun()` reads prompt, repo config (`base_branch`, `prompt`, extras)
  and branch rule at launch time, so edits before the start take effect and a
  started run keeps its text.
- A worktree is refused for a branch checked out elsewhere (`branchWorktree()`)
  with a readable sentence; `runDefFromForm()` blocks it for every form path.
- The platform prompt is four sections in this order: platform rules, the
  operator's suffix (an addition, never a replacement), the harness's own
  lines, and last "how the run ends" (`report.md` outside the worktree, then
  `fl-report done`). Section four can never be removed by a setting.
- The branch sentence the agent reads comes from `BRANCH_MODE_INFO` per merge
  mode; a unit test checks every explanation key exists in `lang/en.json`.
- The goal is typed into the session after the start (`server/goal.mjs`),
  from `launchRun()` and again from the watcher until `goal_sent_at` is set,
  only in status `running`; the command word is typed as keystrokes and only
  the argument is pasted, per the plugin's `goal.typed` prefix.
- A task above the harness's `launch.promptFile.maxBytes` is written to
  `.freilauf/task.md` inside the worktree (gitignored, listed in
  `harnessOwnedPaths()` for every harness) and the CLI gets the framing plus
  the file name.
- Every hook file the hub writes into a worktree (`.cursor/hooks.json`,
  `.freilauf/`) is in `harnessOwnedPaths()` so the finish gate does not read
  it as uncommitted work; an existing `.cursor/hooks.json` is never
  overwritten.
- opencode's `external_directory` allows are written for the run directory
  and every linked extra (`runExternalDirs()`).
- `runner.mjs` is the only launcher and always passes a plugin context to
  `modelArgs()`; both env-variable pairs (`FL_*` and `CC_*`) are exported into
  the session.
- A session found LOST (has-session says gone, run still running) is
  resumed, not aborted; every deliberate end goes through
  `reconcileClosedSession()` and still aborts. A run in the finish gate is not
  resumed (its agent vanishing is `agent_gone`).
- A pane killed by SIGHUP, SIGKILL or SIGTERM is resumed too (`signalDeath()`
  reads both the signal field and exit `128+n`); SIGINT is a human and is not,
  SIGSEGV/SIGABRT/SIGQUIT are the agent crashing and are not.
- Resume caps: `RESUME_MAX` for lost sessions, `PANE_RESUME_MAX` as one budget
  for both dead-pane shapes; a deliberate resume (button, sandbox
  reconfiguration) spends no budget; a launch that could not be tried leaves
  `resume_pending` standing for the next pass instead of counting as died
  ("could not try" is not "tried and died").
- One announcement per pass for all resumes, not one per run.
- A resume reuses the worktree, keeps `prompt.md`, `base_sha` and the quota
  marks, shifts `started_at` by the gap, and launches the CLI in its resume
  form with a continuation prompt that names commits since `base_sha`,
  uncommitted files and the last progress reports. `resumeId()` answers `null`
  whenever the plugin cannot name THIS run's own conversation (claude: no
  transcript under the run id) — a resume never continues a guessed session;
  fresh start wins.
- A fresh start of an existing run is a handover (`handoverPrompt()`): the
  record first (worktree state, every report, progress, questions and
  answers, operator messages), then the original task, then the instructions
  with the platform rules inline; `retireConversation()` files a conversation
  away before the CLI would refuse or reuse its id.
- The operator revives any `done`/`failed`/`aborted` run that ever had a
  working directory, as often as wanted, never beside a live agent and never
  a conflict or archived run (`resumable()` in run-state.mjs, shared by page
  and route). A revived `done` run keeps its status, `started_at`, report and
  merge, needs an instruction and opens a follow-up commission; a failed
  revive of it goes through `reviveFailed()`, never `failRun()`.
- The Sessions page offers revive only through the run page's form (a link,
  never a POST — a finished run needs an instruction), for exactly the runs
  `resumable()` admits.
- A revive whose worktree retention removed recreates it at the same path
  (the resume keeps `branch_expected`), because the CLI finds its
  conversation by that path; a working directory that came back elsewhere is
  a handover, never a `--resume`. After a merge `base_sha` and `merged_sha`
  move to the new HEAD (old values on `worktree_recreated`), or the leftovers
  assessment counts the base's history as the run's.
- `resumeRun()` claims `resume_pending` with a conditional UPDATE before any
  await, so two clicks or passes launch one session; a `done` run left
  pending without a launch in flight (`REVIVE_LAUNCH_GRACE_MS`, longer than
  recreate plus fl-start) is taken back by the watcher (`reviveFailed()`),
  and a launch records its session only while the mark is still its own.
- A resume clears the old life's `pane_died` and `sandbox:released`, or the
  release sweep frees the new container at once or never again.
- Untrusted text (instructions, commit subjects) goes into a prompt through
  `fillTemplate()` — one pass, function replacer — never a string `replace`.
- A takeover's retired claude transcripts (`<id>.before-*.jsonl`) still count
  toward the run's tokens.

## Run definition

- Agent and single run share one definition (`server/run-def.mjs`): form
  block, validation, agent row → definition, save, flow-designer fields, last
  used setup per coding agent. A new run field is one change there plus the
  allowlist in `pickQuickFields`; it is never copied into a second builder.
- `startRun(def, …)` in `scheduler.mjs` is the single way from a definition to
  a run, budget gate included; `startForAgent()` is its wrapper.
- Agent names are unique per repo; delete NULLs `runs.agent_id` first; move
  suffixes a colliding name with a timestamp.
- `keep_on_branch` belongs to the task and is not remembered by
  `rememberRunChoice`.
- Weekly schedules are read through one function, `weeklySlots(agent)`:
  `schedule_slots` (per-day JSON) outranks `schedule_days`+`schedule_time`
  (which may list several times); only the chosen mode is stored;
  `schedule_days` is kept filled in the per-day case.
- The repo prompt (`repos.prompt`) is read live at launch like the other repo
  config, never snapshotted.
- The goal (`agents.goal` → `runs.goal`) is offered only in the agent and
  single-run forms and only for harnesses whose plugin declares `goal`; a
  hidden goal field is disabled so it cannot submit.
- Every run has a title: typed → agent name → `fallbackTitle(prompt)`, and a
  cheap model replaces the fallback in the background without holding the
  start up; a manual rename always wins. Failures are recorded
  (`title_failed`, max three attempts), retried in the watcher pass only for
  runs that were asked at least once (`title_attempts > 0`).
- A single run may start `at` a time, `in` n minutes, when the repo is `idle`,
  or `manual` only; `pickUpScheduled()` runs in the watcher pass (not gated by
  the pipeline switch), starts one run per repo per pass, and defers instead
  of dropping on a blocked budget.
- `runEditAllowed()` is the one table of what a status allows to change
  (duration while running; prompt, repo, branch rule and start time before the
  start); the card renders from it so the form never offers what the endpoint
  refuses; raising the duration retracts the overrun anomalies and the
  notified flag; a prompt edit re-derives a fallback title and resets
  `title_attempts`.
- Favorites store the setup half only (harness, provider, model, serving
  provider, effort, skills, flows) and round-trip through
  `runSetupFromForm()`/`favoriteToFormBody()` — no second definition builder.
  Quick Run takes exactly repo, prompt and the branch fieldset (mode,
  pattern, keep, review) from the request (allowlist), answers JSON, closes at once (`detached`), announces the
  row on creation, and the toast polls the run record until the session
  stands; `failRun()` publishes `start_failed`.
- A run page rendered before the session exists says the start is pending
  (`sessionPending()`) and reloads once, never loops.
- Agents carry a `CHECK` on `harness`, runs do not; a new harness needs the
  table rebuild in `db.mjs`; `dropHarnessCheck()` keeps the agents table free
  of a registry-derived CHECK.
- `node:sqlite` transactions are `BEGIN`/`COMMIT`/`ROLLBACK` via `db.exec`.

## Scheduling

- `scheduleDue()` matches the exact minute; `lastMissedSlot()` uses the same
  function for catch-up.
- A start refused by `repoInactive()`, capacity or busy rules happens before
  `createRun()` so no row is left behind; inactive repos gate the manual path
  too, `max_parallel` gates only scheduled starts.
- A conflict run is counted by `max_parallel` but never blocked by it; its
  ceiling is `conflict_parallel`.
- `resolveRouting()` resolves OpenRouter auto-routing to a concrete order
  before `createRun()`; a routing failure launches unpinned and logs — a start
  never fails on a convenience.
- A relaunch of an existing row (retry, deferred, scheduled, resume) moves
  `started_at`; the orphan sweep's grace period reads it.

## Quota and gates

- `budgetGate(harness, model, provider)` names no vendor: it asks the coding
  agent's declared `gate`, else the provider's, else nothing;
  `LEGACY_DEFAULT_GATE='openrouter'` covers a provider-less model slug. The
  on/off switch is read by the caller (`askGate()`), a gate that throws does
  not block, and a blocked start becomes `deferred` with the window and its
  reset time in the reason.
- The Budget gates settings fieldset is generated from `gatePlugins()`; the
  historic keys stay via `settingKey`; a cleared numeric field falls back to
  the field default and `''` never means `0`.
- Claude's windows come from the account endpoint (`claude-usage.mjs`):
  never write `quota.json`, never refresh the OAuth token, fail soft, keep the
  gate read synchronous with an async refresh that backs off on failure and
  honours `Retry-After`. The last live answer is remembered per window; a
  window past its `resets_at` is forgotten; live wins outright, otherwise the
  newest reading, and everything not live is marked `stale` with its age. A
  `null` window is not a reading, and an answer with no window is not an
  answer.
- The general 7-day window binds every claude run, a per-model window only a
  run on that model (`windowAppliesToModel`, matched on the model identifier);
  no model or an unnamed window answers yes. The gate, `quota_full` and the
  cost delta ask `sevenFor()`/`sevenForRun()`; only the display uses the
  maximum.
- `quota_full` is raised only for claude runs and only for a window binding
  that model, names the window, and is retracted when the window refills —
  but only when `quotaKnown()` (no reading, no retraction).
- Provider balances are a `balance()` contract, normalized per currency with
  an availability flag; the budget gate asks the plugin directly through
  `balanceGateBlocked()`/`usageGateBlocked()`, not the aggregator.
- Both panel caches (`usage.mjs`, `balances.mjs`) are keyed on the enabled
  plugin set, stale-while-revalidate, warmed at startup, and release their
  in-flight flag from the promise.
- Cursor's spending percentages are read from the display sentences of
  `GetCurrentPeriodUsage`; dollars are the fallback and
  `cursor_included_usd` the fallback of that; the gate picks the Auto or API
  bucket by the run's model.
- OpenRouter routing (`serving provider: auto`): one widget with open/auto/pin;
  a minimum quantization is a lower bound derived from the rank in
  `openrouter-routing.mjs` (never an enumeration stored anywhere); providers
  without a quantization statement are out; the result is an ordered chain,
  cached per model+config, a failure falls back to the stale answer; only
  opencode receives it per run; every hub-side OpenRouter call site carries the
  same three modes.

## Plugins

- Coding agents, model providers and notifiers are descriptors in one mutable
  registry; external packages under `FREILAUF_PLUGIN_DIR` load before anything
  reads the registry; a load failure is collected and shown, never thrown; a
  duplicate id is refused, never overridden. `FREILAUF_PLUGIN_DIR` is also a
  test fence.
- A plugin gets a context (`pluginCtx`), never `process.env` or `db.mjs`;
  `provider(id)` resolves at call time. A plugin file imports hub modules
  lazily inside the function (`claude.mjs`→`quota.mjs`, the provider gates,
  `discovery.mjs`→`runtimeInfo()`); `test/echt.mjs` imports every plugin file
  in its own process to prove it.
- `plugin_config` is what the operator configured (enabled, allowed providers,
  credentials, settings); `coding_agents` stays untouched after its one-time
  migration. An unconfigured coding agent is off, an unconfigured provider is
  on.
- `credentialValue()` resolves stored value → named variable → declared env
  keys, reached everywhere through `ctx.secret()`; `pluginHasCredential()`
  decides whether a provider is offered. A found credential is named, never
  read, in discovery rows.
- Every gate, `llm` source, `launch` spec, `goal`, `attention`, `skills`,
  `hookFiles`, `usage()`, `balance()`, `resumeId()`/`resumeCommand()` and
  `logPatterns` are plugin declarations: the Budget gates fieldset, the model
  pickers, the usage panel and the launch line are generated from them, and no
  vendor URL, credential name, threshold or model list is typed into
  `pages.mjs`, `scheduler.mjs` or `watcher.mjs`. (`LEGACY_DEFAULT_GATE` and the
  `harness === 'claude'` branches for the claude subscription windows are the
  named exceptions.)
- `notify()` dispatches to every enabled notifier, catches everything, never
  throws; nothing configured is a complete installation with no banner and no
  error. The message shape is normalized; the flow step is `notify` with
  `telegram` accepted as an alias; per-run events are `notified:<type>`
  (`telegram_sent:*` still read), the column `runs.telegram_on` keeps its name.
- The Welcome wizard writes through the same functions as the Plugins page;
  every step carries the "do not show again" box with its hidden `0`; every
  exit is a submit of that form; leaving also sets the session cookie.
- Skills are re-synced at startup and after every Plugins-page write.

## LLM layer

- `llmJson()` is the one transport for the hub's own questions and never
  throws; callers keep their own error style, throttle and defaults.
- Sources are `provider:<id>` or `agent:<id>`; a bare value means
  `provider:openrouter`. Strategy follows the source's declared `llm.schema`
  (`native`/`json_object`/`prompt`) with no extra coaxing; `native` still falls
  back to `result` and reprompts on a missing structured output.
- Responses are parsed tolerantly without evaluating text, validated with
  coercion, reprompted exactly once on parse/validate; a transport failure is
  never reprompted but moves down the chain.
- The chain (`job.mjs`): primary then fallbacks (strict comma list, junk means
  none); `transport` → next source at once; `config` → skipped and not
  counted, an all-config chain returns the primary's answer and alerts nobody;
  whole chain down → exponential backoff with jitter up to
  `llm_retry_attempts` (hard cap 10), first walk always complete. An agent
  source needs no model. `jobRouting()` is the one reader of per-job routing.
- Alerts: one per failure signature per window, a global hourly ceiling,
  suppressed counts named in the next message, no alert for `config`.
- A coding agent as source declares `overhead: true` and the UI says so.

## Pages and live channel

- The hub has no authentication and binds `127.0.0.1` only; `vpn-proxy.mjs`
  binds exclusively to the VPN address (fail-closed: its unit is not enabled
  at boot), and its host allowlist plus origin check are the rebinding/CSRF
  fence. Nothing may open a second listener or relax either check.
- `events.mjs` imports nothing; the channel hangs on `addEvent()` in
  `db.mjs`, and every status write adds an event; title generation, archive
  and unarchive call `announceRun()` explicitly. An event carries a signal,
  never markup; the browser fetches a fragment rendered by the page's own
  function.
- Client rules: a row being renamed is skipped; a run the page does not show
  re-renders the tbody; `#term` is never part of a fragment;
  `location.reload()` after a kill stays (it closes the WebSocket and its tmux
  client); the sidebar swap waits while `#run-edit` or a panel field has
  focus; the run multi-select lives in a Set and is re-synced after every swap.
- `vpn-proxy.mjs` is HTTP/2 with `allowHTTP1` for the WebSocket upgrade,
  filters hop-by-hop headers in both directions, turns `:authority` into
  `host` for the allowlist, and destroys the upstream request when the client
  closes. Static files are served from memory with an ETag and `no-cache`,
  validated by one `statSync`.
- `layout()` is async and never waits on a vendor: usage, balances and session
  memory are stale-while-revalidate and warmed at startup; `force` waits.
- The chosen repo travels as the `freilauf_repo` cookie, written by client and
  router through `requestRepo()`; `layout()` resolves `?repo=` → page context →
  cookie → first repo; a page fixed to one repo shows the other-repo banner
  and the live channel listens to both repos while they differ.
- The status sidebar is one aside on every page, refreshed every 30 s, with
  its own `data-repo`; every bar comes out of `quotaBar()`; counts link to the
  filtered overview; the fold lives on `#shell`. Incidents on archived runs are
  counted separately and link to `/archive?repo=&incidents=1`.
- Session memory is one measurement published by whoever measured it
  (`publishSessionMemory()`), invalidated when a cleanup run ends, and the
  block says how often it measures.
- Forms are `form.form-grid`; every grid selector carries `:not([hidden])`.
  The overview has seven titled columns plus the pick column
  (`OVERVIEW_COLS`).
- `settingsKeys()` (pages.mjs) is a function evaluated per save, so plugin
  settings registered after module load are in the allowlist.
- Terminal: write access only with `?ro=0`, set from `data-live` = session
  standing and pane alive, never from the status; OSC 52 from tmux is written
  to the clipboard (never answered for `?`, decoded via `TextDecoder`); while
  the pane has mouse reporting on, drags are forced to select locally
  (shift re-dispatch) and a click never copies; full screen uses the native
  API, cinema mode measures its height; toasts move into `#term-wrap` under
  full screen.

## Panels

- Panels are push, not pull; values are data, never markup; three states
  `fresh`/`stale`/`error`, the last two keep the old numbers dimmed; every
  reading carries its time; a refusal is an answer, never a 500; `''` becomes
  `null`, never `0`.
- Controls are declared data; an action is `argv` with a required `cwd`,
  placeholders substituted inside one element, no shell, no detach; submitted
  values are checked (range, empty number, unknown select value); `store`
  happens only on exit 0 when combined with an action; the outcome is state on
  the panel row (`lost` past its timeout), one command per panel at a time.

## Integration

- No agent merges or pushes to the base branch; the hub integrates when
  `repos.merge_mode='hub'`, and `'off'` is the old behaviour byte for byte.
- The finish gate hangs in `handleReport()` and stores the report first, then
  asks in order: uncommitted changes (`awaiting_commit`, nothing merged while
  dirty), no commits (`tip == base_sha`, closes as before), mergeable
  (`git merge-tree --write-tree --name-only`, touches no worktree).
- `runs.finish_state` is a sub-state of `running`, not a status value; a run
  in a finish state has reported, so pane death and session loss escalate
  `agent_gone` instead of failing it, the watcher raises no overrun or
  no-activity for it, and the deadline
  (`finish_started_at + repos.finish_timeout_min`) pauses during
  `waiting_help`.
- `fl-report` prints the hub's `message`; the report route must answer 2xx;
  channels without a caller get the text typed into the session, and
  `via:'internal'` carries the cursor loop guard.
- The check loop has its own 5-second timer with `nextCheckDelayMs()`, at most
  two git checks at a time, cheap status via `git --no-optional-locks status
  --porcelain`, dry run only when the tip moved; `integrateTick(nowMs)` takes
  the time as a parameter.
- One job queue per repo; merges happen in the hub's own detached worktree
  under `FREILAUF_INTEGRATE_DIR` with the repo's extras applied; `merge
  --no-ff`, optional `merge_check` on the merged result, `push origin
  HEAD:{base}`; a rejected push retries once, a second rejection is a
  conflict; any other push failure waits on a due time honoured by the loop
  (never a timer of its own), five failures escalate. Only after the push is
  the run `done`, are others told and flows fired — except under code review,
  where the run is `done` on submission and the merge follows the approval.
- Escalation ladder: `blocked_dirty` (three one-click answers),
  `resolving` → `blocked_conflict` after `merge_max_attempts` conflict runs,
  `blocked_error` (the git sentence is stored in `merge_error` and shown via
  `failureExcerpt()`, which keeps both ends), `blocked_no_remote`,
  `unmerged_*` for `failed`/`aborted` (never merged automatically, named,
  backed up, buttons on the detail page).
- A conflict run is an ordinary single run on its own `resolve/<short id>`
  branch, its setup from Settings → Merge via `setupToFormBody()`; it never
  starts a conflict run, never notifies, fires no flows
  (`flow_dispatched=1`, `merge_dispatched=1` at creation), gets no generated
  title, carries only `merged`, a review state (it is reviewed when the
  original is) or nothing, and every failure — a rejected review included —
  maps onto the original run.
- After every merge the other running agents of the repo are told (urgently
  when files overlap), never a run in `waiting_help`.
- Nothing lives only on this machine: the integrator knows no local merge; the
  operator's own base-branch commits are pushed by the hub (push only, never
  `--force`, divergence is a global incident); unmerged work is pushed as a
  branch (`branch_backed_up`); remote branches are not deleted.
- `anomaly:unpushed` means only "ahead of origin" (`branchOnRemote()`), and is
  not asked of a run whose `merge_status` is `merged` or `kept_on_branch`
  (`WORK_ON_ORIGIN`, one list, two readers).
- Branch rule under `hub`: no branch = detached, merged at the end, named
  `run/<short id>` where a name is needed; `keep_on_branch` (hub mode only,
  refused with no branch) keeps the dirt check, skips the merge, pushes the
  branch, fires no `run_merged`, and "Merge now" still works.

## Code review

- Optional and off by default; it only exists under `merge_mode='hub'`, and
  a repo or run without it behaves byte for byte as before.
- Three levels, nearest wins: run/agent `review` → repo `review_mode` →
  Settings → Code review `review_default`; the platform comes from the repo, else
  the global setting. `decideReview()` is the one decision, and `launchRun()`
  freezes it into `runs.review_platform` (`NULL` = legacy, not reviewed), so
  the prompt sentence and the end of the run agree.
- `keep_on_branch` and review exclude each other (the form refuses both), and
  a conflict run of a reviewed run is reviewed too.
- The finish gate is unchanged (clean, mergeable); where it would enqueue the
  merge, `submitForReview()` pushes the branch (`run/<short id>` when
  detached), opens or updates the review and closes the run as `done` with
  `merge_status='in_review'`; `run_merged` fires only on the real merge.
- An approval binds to `review_sha`: `integrateOne()` merges exactly
  `review_approved_sha`, and every path that reaches it unapproved submits
  instead; a later commit goes back to review.
- Change requests (internal comment or forwarded platform comments) are typed
  into the live session as a follow-up commission; the follow-up report
  re-submits the same review; with no session the request is refused, never
  dropped.
- External platforms are `review` plugins (`docs/plugins.md`): the platform
  approves and merges under its own rules, the hub polls `status()` once a
  minute from the integrator tick and records a platform merge through the
  same `finishMerged()`; the token stays in the hub process.
- The reviewer's diff is computed in `repo.path` with `--no-ext-diff
  --no-textconv`, never in the agent's working copy; an open review keeps its
  worktree and its session — retention, the cleanup agent and the archive
  skip it (`inOpenReview()`) — and the review states are in `WORK_ON_ORIGIN`.
- An approval is atomic (one conditional `UPDATE`), a platform change request
  the agent already answered is not re-flagged (`staleChangeRequest()`), and a
  platform link is rendered only for `http(s)` (`safeHref()`: `fl-report pr`
  lets an agent write `pr_url`).
- The trust boundary: review holds back what the HUB merges. An unsandboxed
  agent runs as the operator's user and could push to the base branch or call
  the hub's local API itself; only a sandboxed run is actually fenced off, and
  a platform's branch protection is the stronger guarantee.

## Reports and follow-ups

- `handleReport()` accepts a first report only in `running`/`waiting_help`;
  the three cursor end channels together notify exactly once (`notified:*`
  per run). cursor's `finishByTurnEnd()` fires only from `running`.
- A report from a finished run is a follow-up: same command, appended to
  `report_md` and kept in `followup_md`, same finish gate with
  `finish_started_at` reset, `followup_open` tells the integrator's three ends
  to call `completeFollowUp()` (event, flows re-armed, notification); the
  status never changes.
- A follow-up commission opens when the operator sends into a finished run
  (`POST /send`) or the agent's hook reports a submitted line
  (`_working prompt`); it displays as running, runs the expected duration
  from the commission (`watchFollowUps()`, its own anomalies and notify type),
  restarts its clock on each new human line (`restartCommissionOnWorking()`),
  and measures the runtime pair on that clock (`runtimeClock()`).
- A commission that is given up (`abandonFollowUp()`: closed session, dead
  pane, kill route, the end-followup button) ends the clock and assesses
  leftovers from `merged_sha ?? base_sha`, refusing to write `nothing` over
  an existing answer.
- `runs.telegram_on` unticked means no message about this run on any
  channel; the suppressed message is written as `notify_muted` and the
  notified flag is not set.
- A message names the run first (title, agent, repo, harness/model).

## Attention

- `runs.agent_state` (`working`/`waiting`, NULL for a harness without hooks)
  is written only by the agent's own hooks via `_working`/`_waiting`/
  `_turn_end`; root session only, event only on change, `agent_state_at`
  refreshed every time.
- `_working prompt` opens a follow-up commission at once and ends a help
  call; `_working tool`/`busy` only after the grace window since the last
  report; an `injected` head (`injectedSubmission()`, measured shapes at the
  start of the line, bounded, stored nowhere) opens nothing and answers no
  help call; an absent head is unknown, not injected.
- `agentWaiting()` is the one predicate for the five readers and is the
  agent's word unless `last_activity_at` contradicts it by more than
  `ATTENTION_STALE_MS`; silence never overrules a hook.
- `last_activity_at` is what the agent wrote, never a file mtime that the CLI
  rewrites in batches (`claudeTranscriptReading()` reads the newest record's
  timestamp).
- The first key a person types into the terminal or the send route flips
  `waiting` → `working` and nothing else (`noteOperatorInput()`,
  `isOperatorInput()` drops mouse and focus reports).
- The two columns are NULLed with the session (exit, pane death, kill,
  retry, resume).

## Watcher and incidents

- `tick()` has a re-entrancy guard and `claimOffset()` names the log offset it
  replaces, so two readers cannot report one line twice.
- A hub-ended session is not a provider fault (`isSessionStopped()`); a hook
  report from a foreign claude session id is ignored
  (`foreignClaudeSession()`); a working agent is never escalated
  (`agentCopedAfter()` vetoes repetition, silence, reopen and recurrence on
  an open incident; a dedupe still counts once; an escalating occurrence is
  never an echo); an echo writes no event.
- Silence is an argument only where activity is measured
  (`measureActivity().measured`); an unmeasured harness is unknown, never
  silent, and `no_activity` is not raised while the agent says it waits.
- Both overrun thresholds are measured from the last progress report
  (`overrunClockFrom()`); `notified:overrun` stays set after a retraction.
- `no_activity` is retracted when activity resumes; `quota_full` when the
  window refills; every in-flight anomaly colour ends when the run reaches
  `done` (`anomaliesSettled()`, `IN_FLIGHT_ANOMALIES`; a `failed`/`aborted`
  run keeps its colour; an open commission is not a fence); `unpushed` settles
  when the work is on origin.
- `incidentGoneReason()`: `done` closes everything but `merge_blocked`; red
  on a running run closes only on activity after the last occurrence plus ten
  quiet minutes; yellow after thirty; red on `failed`/`aborted` stays;
  `merge_blocked` and `provider_down:*` never by time.
- A red incident pages after the grace period and only if still open; an
  announced incident announces its recovery.
- `needsHuman(v, run)` takes the run row: auth/billing/model errors always; a
  red incident on a run that did not come through, including a running run
  past the grace period whose agent has not coped since.
- `typeFromText()` files every vendor sentence that means "no money" under
  billing, checked before rate limit; an HTTP status counts only next to an
  error word; the log exception list is case-insensitive and skips source
  lines, test ticks and "is detected" phrasings.
- opencode activity and tokens are read over the run's session TREE (root =
  newest parentless session of the worktree created with the run,
  descendants via `parent_id`, timestamp from session/message/part).
- cursor's end is detected by the `stop` hook and the transcript's
  `turn_ended`; the transcript is its activity source.
- The `_pane_died` format is `|`-separated, `exitStatus()` compares before
  converting, and a missing exit code is never read as 0.
- `pushOperatorBase()` runs for inactive repos too.
- A run's token counts sum only `output_tokens` as output; the three
  prompt-side fields are input; totals cover the whole transcript.

## Sessions

- `tmuxVerdict()` answers `ok`/`no_server`/`unreachable`; `sessionGone()` is
  tri-state and the watcher skips a run on `null`; a live run's disappearance
  is confirmed by `has-session`; `tmux_gone` and `tmux_unreachable` are global
  incidents that do not resolve by time; the cleanup passes do nothing while
  tmux is unreachable.
- "Last activity" is `window_activity`, overriding the session field only
  where newer.
- The sessions page hides running sessions by default (`displayStatus()`
  decides "running", including an open commission), asks before ending one,
  sorts oldest first, never blocks, and `POST /api/sessions/kill` takes any
  number of names.
- Retention counts from the earlier of the run's end and the pane's death;
  an open commission means not finished; a dead pane wins; automatic closing
  touches only sessions carrying a run of this hub.
- The run's terminal is writable as long as its session and pane are;
  `/api/runs/<id>/kill` on a `failed` run sets `aborted`, on `done`/`aborted`
  only closes the session.
- `reconcileClosedSession()` is the single place a closed session becomes a
  run event (abort with reason, flows fired, commission abandoned).
- Session memory is measured through `listSessionsSnapshot()` for the whole
  machine; a sandboxed session's memory is asked of the runtime.
- One prefix table for the shell tools (`bin/fl-harness-tags.sh`, plus the
  `harness-tags` file for plugin tags).

## Repos and archive

- Only terminal statuses are archivable, and not one with an open follow-up
  commission (`archivable()`, one rule for row, bulk box, page and route);
  both routes archive through `archiveRecord()`, a refusal per run never holds
  up the rest; archiving closes the session by the `archive_session_*`
  settings on two paths; the watcher, the flows and the incidents keep their
  view of a run whether it is archived or not — only displays that promise
  rows (the sidebar's overview-linked count, the read API's `archived` filter)
  and the retention and title-retry passes read `archived_at`.
- `repos.active=0` removes the repo from every dropdown and starts nothing
  (manual path included) while history stays reachable through an explicit
  `?repo=`.
- Delete requires the exact name as `confirm`, refuses with work in flight,
  deletes child rows first in one transaction, and touches no checkout,
  worktree or run directory.
- The read API is read-only; `?status=` selects by `displayStatus()` and an
  unknown word is a 400 naming the valid ones; every row carries
  `display_status`; `liveness.pane_alive` is tri-state.

## Skills

- Installed at user level only, into the smallest covering set of directories
  (`coveringUserRoots()`), as copies; every installed directory carries
  `.freilauf-skill.json` with the installation's coordinates; removal takes
  back only what the hub wrote (marker-guarded), a foreign or operator-owned
  directory is refused and reported, adoption is an explicit button.
- `skills_install` off removes everything; content refresh only with
  `skills_auto_update`, measured by hash over the whole tree
  (`__pycache__`/`*.pyc` excluded on both ends); `skills_selected` absent means
  all; the `shared` skill rides along and is not listed.
- The three copies of `scripts/fl-options.py` are byte-identical (unit test);
  `check` refuses a provider-based coding agent without a provider, reading
  the rule from `/api/providers`.
- `FREILAUF_SKILLS_HOME` is set by every suite.

## Tests

- The e2e suite is a second hub in `test/sandbox-env.mjs` with its own port,
  database, repo with a bare origin, stub `fl-start` and credential fences;
  the stub writes every session it creates to `sessions.txt`, both suites
  answer SIGINT/SIGTERM/SIGHUP, and a starting sandbox sweeps a dead one's
  list in parallel (`sandboxOrphaned()` never sweeps a live or kept sandbox).
- The suites own the clocks: `FREILAUF_WATCHER_OFF`,
  `FREILAUF_INTEGRATOR_OFF`, `FREILAUF_SANDBOX_REAPER_OFF`; watcher passes and
  `integrateTick(nowMs)` are called by the test.
- A green run of the container layer proves the hub's own argument shapes and
  refusals only; anything depending on a daemon or image has to be run once
  against a real one.
- `test/browser.mjs` drives real Chromium (Playwright) and fails on any
  console exception; `test/proxy.mjs` counts upstream sockets; both report
  themselves skipped and green without their dependency. `test/deploy.mjs`
  runs with `HOME`, deploy dir and `PATH` in a sandbox and shim binaries.
- A browser test whose premise can give way (a mode set in the pane) asserts
  the premise again after the gesture; a fixture that tmux may not record
  (exit status) is rebuilt until it is.
