# PLAN — report messages begin with the repo/run or repo/AGENT header (tree 3)

## Goal

The Telegram messages that carry a run's report should identify, at first
glance, which repo and which run or agent is reporting. Before this change the
header sat behind the status line and read `— single run @ repo (harness/model)`
or `— <agent> @ repo (harness/model)`. The operator wanted the attribution
first, and a dedicated shape for agent runs.

## Depth tree

```
Root: report messages begin with the repo/run or repo/AGENT header
├── 1  Header helper: server/reports.mjs
│    ├── 1.1  reportHeader(run): single run → `<repo> / <run-title> REPORT:`
│    └── 1.2  reportHeader(run): agent run → `<repo> / AGENT <agent-name> REPORT:`
├── 2  The three report-carrying messages use it
│    ├── 2.1  done (doneText): header + report, status line after the report
│    ├── 2.2  failed: same header + body shape, `❌ Run failed · <harness>` last
│    └── 2.3  help: same header + body shape, `🆘 Help call · <harness>` last
├── 3  Verification
│    ├── 3.1  scripts/gates-msg-header.mjs: exact header output for both kinds
│    ├── 3.2  unit suite (270 checks)
│    └── 3.3  e2e suite (244 checks)
└── 4  Teardown race in test/sandkasten.mjs: retry the rmSync — a detached
         run_merged flow command (`sleep 1; touch`) can still land in the
         sandbox while the suite cleans up (pre-existing flake, surfaced by 3.3)
```

## Decisions

- **The status line follows the report.** The request fixes the *beginning* of
  the message; `✅ Done · Duration: … · Merged into main: …` stays, but after
  the report body instead of before it.
- **`laufKopf` is replaced, not extended.** Its inline `— name @ repo
  (harness/model)` had no place in the new header; the harness/model label
  moved into the status line (`harnessLabel`).
- **`test/sandkasten.mjs` teardown is hardened** (bounded retry on `rmSync`):
  the `ENOTEMPTY` was a pre-existing race, not a regression of this change, but
  a suite that dies in cleanup after all checks pass makes every gate flaky.

## Status log

- [x] 2026-08-29: plan written
- [x] 2026-08-29: header implemented, three messages updated, gate script
      written; unit 270 + e2e 244 green, GATES.md clean of machine paths;
      committed, report done sent
