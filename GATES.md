# Gates: the tmux-cleanup agent, selectable setup, sidebar and Sessions triggers

OWNS: server/cleanup.mjs, server/pages.mjs, server/web.mjs, server/watcher.mjs,
server/run-def.mjs, bin/cc-session-cleanup, setup/02-install-scripts.sh,
public/hub.js, public/hub.css, lang/en.json, lang/de.json, lang/zh.json,
test/unit.mjs, test/e2e.mjs, test/browser.mjs, GATES.md, PLAN.md

Scope: A reusable agent+provider+model selection (a styling option on the
existing `runSetupFields()` element), a configurable tmux-cleanup agent that
frees memory down to a target GB by ending the oldest inactive tmux sessions,
an on/off switch plus a threshold in Settings, an unobtrusive "free memory"
button in the sidebar's tmux block and a prominent box on the Sessions page
with an optional keep-runs field, a helper script for the agent, and a
Telegram report line. Machine-specific values (URLs, paths) stay out of the
committed state.

- [x] G1: the reusable setup element gains a pure styling option; existing
      callers stay byte-for-byte identical
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — 270 unit checks green, incl. "runSetupFields: the styling
    option wraps, the default stays untouched" (no wrapper without the option,
    a wrapping fieldset with it, same harness select inside).

- [x] G2: the cleanup planning logic decides correctly: oldest-inactive first,
      protected sessions never chosen, target reached
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — "cleanupPrompt fills the live values into the template",
    "keepSessionsForRuns resolves run ids to session names", "cleanupRunInFlight
    sees a marked run and clears when it ends", "maybeAutoCleanup gates on
    threshold, in-flight and cooldown".

- [x] G3: the cleanup agent starts through the ordinary run path with the
      configured harness/provider/model, a memory-aware prompt, and no flows;
      a second start is refused while one is in flight
  CHECK: node test/e2e.mjs
  EXPECT: checks passed
  EVIDENCE: met — 244 e2e checks green, incl. "the cleanup settings save stores
    agent + switch + numbers", "the cleanup agent starts through the ordinary
    run path" (claude, no flows, target in the prompt, cleanup_run event) and
    "a second start is refused while one is in flight".

- [x] G4: the sessions page and the sidebar render the free-memory controls,
      and the sidebar one works after a live re-render
  CHECK: node test/browser.mjs
  EXPECT: checks passed
  EVIDENCE: met — 55 browser checks green, incl. the A12 group: the sidebar
    button and the Sessions box render, the sidebar one reveals the target
    field, starts the agent (toast → run → cleanup_run event), refuses a
    second start with a reason, and the Sessions box starts one with a keep
    list.

- [x] G5: the agent's helper script is syntactically sound, protects running
      runs and a --keep list, and kills nothing in plan mode
  CHECK: bash -n bin/cc-session-cleanup && node test/e2e.mjs
  EXPECT: checks passed
  EVIDENCE: met — `bash -n` clean; e2e "the agent helper script protects and
    kills nothing in plan mode" green (real tmux: candidates marked kill,
    killed=0 without --kill, a --keep session marked protect). On this
    machine the script also marks the currently running run's session as
    protect.

- [x] G6: the i18n key sets stay identical across all three language files
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — the i18n group enforces identical key sets and placeholder
    sets; 35 new cleanup/sidebar/sessions keys in all of en/de/zh, the suite
    is green.

- [x] G7: no machine-specific value in the committed state
  CHECK: bash pruefe-vor-push.sh
  EXPECT: OK: no forbidden patterns in the committed state.
  EVIDENCE: met — the hook printed the OK line on the committed state (the
    Telegram URL travels as `{sessions_url}`, filled from CCHUB_PUBLIC_URL at
    start time).
