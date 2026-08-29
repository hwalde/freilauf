# PLAN — tmux sessions of archived runs are closed (configurable, default immediately) (tree 3)

## Goal

Today, archiving a run (`runs.archived_at`) leaves its tmux session standing;
the session is only closed by the ordinary retention (`session_keep_hours`,
counting from the run's end). The operator's gesture "put this finished work
away" should also close the session it left behind — by default right away.

New rule: **archiving a finished run closes its tmux session.** Two settings
control it, both under Settings → Sessions:

- `archive_session_on` (0/1, default on) — the whole rule can be switched off;
  an archived session then follows the ordinary retention like any other.
- `archive_session_keep_hours` (default 0) — how long after archiving the
  session may stay. 0 = close right away, the default.

Enforcement on two paths: the archive route closes immediately when the keep
time is 0; a watcher pass closes archived runs' sessions once `archived_at +
keep` has passed — which also catches runs archived before this feature existed.

## Depth tree

```
Root: archiving a run closes its tmux session (default immediately, configurable off/delay)
├── 1  Settings surface
│    └── 1.1  archive_session_on switch + archive_session_keep_hours input
│         └── 1.1.1  SETTINGS_KEYS allowlist + settings form + i18n (en/de/zh)
├── 2  Decision logic, pure (server/sessions.mjs)
│    └── 2.1  archiveSessionKeepMs / archiveSessionKeepHours / shouldCloseArchived
│         └── 2.1.1  counts from archived_at; null when the rule is off
├── 3  Enforcement
│    ├── 3.1  archive route (web.mjs): keep == 0 → killSessions() right away
│    └── 3.2  watcher pass closeArchivedSessions(): close once archived_at + keep passed
│         └── 3.2.1  also covers runs archived before the feature, and keep > 0
└── 4  Tests + docs
     ├── 4.1  unit: archiveSessionKeepMs/Hours, shouldCloseArchived (test/unit.mjs)
     ├── 4.2  e2e: default closes, off keeps, delay defers then closes (test/e2e.mjs)
     └── 4.3  AGENTS.md documents the rule
```

## Decisions

- **Separate on/off switch and keep time.** The task asks for both "disabled in
  settings" and "how long archived sessions stay". One key each, following the
  existing pattern (`pipeline_on`, `session_keep_hours`).
- **Count from `archived_at`, not from the run's end.** The gesture is "I put it
  into the archive" — the clock starts there. The ordinary retention already
  counts from the run's end; this is a second, stricter rule on top.
- **Immediate close in the archive route.** "0 = sofort löschen" means the
  click closes the session, not the next watcher tick. The watcher pass is the
  net under it (keep > 0, a run archived while the hub was down, tmux hiccups).
- **`killSessions([name], 'archive')`** so an already-gone session is a no-op
  and the run record is reconciled exactly like the sessions page does it.
- **The default is ON with keep 0** — that is the "always deleted" the task
  demands; the settings are the exceptions, not the rule.

## Status log

- [x] 2026-08-29: plan written
