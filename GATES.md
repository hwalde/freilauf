# Gates: archived runs' tmux sessions are closed (configurable)

OWNS: server/sessions.mjs, server/web.mjs, server/watcher.mjs, server/pages.mjs,
lang/en.json, lang/de.json, lang/zh.json, test/unit.mjs, test/e2e.mjs, AGENTS.md,
GATES.md, PLAN.md

Scope: Archiving a finished run closes its tmux session. The whole rule can be
switched off in settings, or given a keep time in hours (default 0 = close right
away). Pure logic in server/sessions.mjs, immediate close in the archive route,
a watcher pass for keep > 0, i18n keys in all three languages, tests, AGENTS.md.

- [x] G1: the pure session functions decide correctly
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — the unit suite passed 262 checks, incl. the
    "archive-session rule: on by default with keep 0, switchable off" and
    "an archived run is closed once its keep time after the archive has passed"
    groups. Full evidence lives in the machine-local .unlazy/ (gitignored).

- [x] G2: archiving closes the session right away by default (e2e)
  CHECK: node test/e2e.mjs
  EXPECT: checks passed
  EVIDENCE: met — the e2e suite passed 235 checks, incl.
    "archiving closes the tmux session right away by default": after the archive
    click the session answers `has-session` with failure, the run record carries
    `tmux_closed_at` and a `tmux_closed` event.

- [x] G3: a switched-off rule keeps the session, a keep time defers the close (e2e)
  CHECK: node test/e2e.mjs
  EXPECT: checks passed
  EVIDENCE: met — the same suite passed "a switched-off archive rule keeps the
    session" (archive_session_on=0: session survives, tmux_closed_at stays null)
    and "a keep time defers the close to the watcher pass"
    (archive_session_keep_hours=2: session survives the archive, is closed by
    the watcher after archived_at moves three hours into the past).

- [x] G4: the i18n key sets stay identical across all three language files
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — the unit suite enforces identical key sets and non-empty
    values; the four new `settings.archive_session*` keys exist in en, de and
    zh, and the unit suite passed (see G1).

- [x] G5: the settings page offers both new fields
  CHECK: node test/e2e.mjs
  EXPECT: checks passed
  EVIDENCE: met — the e2e suite passed "the archive-session rule is
    configurable on the settings page" (`name="archive_session_on"` and
    `name="archive_session_keep_hours"` are rendered), and POST /settings/save
    accepts both keys (SETTINGS_KEYS allowlist).

- [x] G6: no machine-specific value in the committed state — the pre-push
  check's own scan of HEAD finds nothing
  CHECK: bash pruefe-vor-push.sh
  EXPECT: OK: no forbidden patterns in the committed state.
  EVIDENCE: met — the hook printed the OK line on the committed state.
