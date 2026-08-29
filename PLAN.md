# PLAN — the tmux-cleanup agent with a selectable setup (tree 3)

## Goal

Let the operator pick an agent+provider+model in Settings (via the existing
`runSetupFields()` element, extended with a styling option), and use that
setup for a special "tmux cleanup" agent: it ends the oldest inactive tmux
sessions until the machine's tmux memory is below a target GB. The feature has
an on/off switch and a threshold (GB) at which the watcher starts the agent
automatically. Two manual triggers: an unobtrusive button in the sidebar's
tmux memory block, and a prominent box on the Sessions page with an optional
"keep these runs' sessions" field. A helper script does the measuring and the
killing; the agent reports "XY GB freed, Z GB remain" via Telegram.

## Depth tree

```
Root: a configurable agent frees tmux memory down to a target, on a switch + threshold
├── 1  Reusable element
│    └── 1.1  runSetupFields(a, { wrapClass }) — a styling option, default unchanged
├── 2  Server logic (server/cleanup.mjs)
│    ├── 2.1  cleanupSettings() — on/off, threshold/target GB, cooldown, repo, setup
│    ├── 2.2  cleanupPrompt() — the id=7 prompt adapted to memory, with {target_gb}
│    │         {threshold_gb} {keep_line} {sessions_url} placeholders
│    ├── 2.3  startCleanupRun() — ordinary startRun path, no flows, 'cleanup_run' event
│    ├── 2.4  cleanupRunInFlight() / lastCleanupRun() — dedupe + cooldown
│    └── 2.5  maybeAutoCleanup() — watcher gate: on + memory ≥ threshold → start
├── 3  Agent helper script
│    └── 3.1  bin/cc-session-cleanup — measures activity+RSS, protects running runs
│             and --keep, decides oldest-inactive-first to a target, --kill executes
│             └── 3.1.1  installed by setup/02-install-scripts.sh
├── 4  Settings page + API
│    ├── 4.1  GET/POST /settings/cleanup — on/off, runSetupFields, GB fields, prompt
│    └── 4.2  POST /api/cleanup/start — target_gb + keep (run ids → session names)
├── 5  UI
│    ├── 5.1  sidebar tmux block: ghost "free memory" button + inline target input
│    └── 5.2  Sessions page: hint box with target input + keep field
├── 6  Watcher auto-trigger (server/watcher.mjs → maybeAutoCleanup)
└── 7  i18n + CSS + docs + tests
     ├── 7.1  lang/en.json + de.json + zh.json (identical key sets)
     ├── 7.2  CSS for the sidebar control and the Sessions box
     ├── 7.3  unit tests (element option, planning, prompt, dedupe)
     ├── 7.4  e2e tests (start path, no double start, script protects)
     └── 7.5  browser tests (sidebar + sessions triggers)
```

## Decisions

- **The reusable element already exists** (`runSetupFields()` + `runSetupFromForm()`,
  used by both run forms, the favorites and the merge settings). It only needs the
  styling option the operator asked for — `wrapClass`. Default output is unchanged,
  which is a unit-tested property.
- **The cleanup agent is a normal single run** through `startRun()`: budget gate,
  overview, watcher, finish gate, Telegram report all apply. `branch_mode='keiner'`
  and `flows=NULL` keep it out of any integration. It works in a detached worktree
  of a configurable repo and is told never to commit.
- **Dedupe via an event**, not a new column: `addEvent(runId, 'cleanup_run', …)`.
  A run carrying that event is a cleanup run; in-flight = status running/deferred.
  The auto-trigger has a cooldown so a run that cannot reach the target does not
  start again every 30 s.
- **The prompt is the id=7 prompt adapted to memory** (German, as the original),
  with the target/keep/URL filled in at start time from settings. The URL comes
  from `publicBase()` — the machine's real URL never enters the repo.
- **The helper script measures itself** (`#{window_activity}`, process-tree RSS,
  sqlite for running runs) and implements the greedy decision in awk, mirroring
  the id=7 prompt's proven commands. Plan mode never kills; `--kill` only with
  an explicit target.
- **On/off governs the automatic watcher trigger.** A deliberate manual "free
  memory" click works whenever a cleanup agent is configured.

## Status log

- [x] plan written
- [x] implemented: reusable element option, server/cleanup.mjs, the helper
      script, settings page + API, sidebar button + Sessions box, watcher gate,
      i18n + CSS, unit/e2e/browser tests, SETUP_WITH_AGENT.md + the three
      READMEs. Test runs: unit 270, e2e 244, browser 55, proxy 4, deploy 9.
      Pre-push hook OK on the committed state. Reported done.
