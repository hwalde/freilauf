# PLAN — carry the weekly "daily" collapse to main with a clean GATES.md (tree 3)

## Goal

Run fbb33d06 implemented the "weekly schedule covering all seven weekdays
reads 'daily'" feature and committed it (e9c3bd5), but the push to main was
blocked: the committed GATES.md carried machine-specific evidence
(`/home/...` paths, the machine's login name), which `pruefe-vor-push.sh`
correctly refuses. The feature never reached main; it lives on the backup
branch `run/fbb33d06`.

This run carries that feature onto current main, with a GATES.md whose
evidence is machine-free (the full evidence stays in the gitignored
`.unlazy/`), and lets the hub's integrator merge it.

## Depth tree

```
Root: the weekly one-liner collapse lands on main, GATES.md clean of private values
├── 1  Server: scheduleText() in server/util.mjs decides the collapse
│    └── 1.1  all 7 weekdays selected AND schedule_weeks <= 1 →
│              t('sched.daily_line', { time }) instead of the weekly_line
├── 2  i18n: one new key in all three language files
│    └── 2.1  lang/en.json + lang/de.json + lang/zh.json: sched.daily_line
│              ("daily at {time}" / "täglich um {time}" / "每天 {time}")
├── 3  Tests: the collapse, the multi-week exception, the unchanged partial
│         selection (test/unit.mjs)
└── 4  Clean merge surface
     └── 4.1  GATES.md evidence without machine paths — a pre-push hook that
               refuses /home/... must stay quiet (pruefe-vor-push.sh)
     └── 4.2  the hub's integrator merges; origin/main carries the feature
```

## Decisions

- **Reuse the feature commit's content, not its GATES.md.** The code, i18n and
  test changes from e9c3bd5 apply cleanly to current main (verified with
  `git apply --check`); the GATES.md of that commit is exactly the problem, so
  it is replaced by one whose evidence is machine-free.
- **The evidence must never contain the working directory.** The gate checker
  records `cwd=/home/...` by default; for the pushed ledger the evidence states
  only the outcome. This is the repo's own precedent (commit 4680116 "GATES:
  strip machine-specific evidence before pushing").
- **Do not push to main by hand.** The hub integrates on `cc-report done`; the
  pushed tree is the same, so the pre-push hook is checked against the local
  committed state before reporting.

## Status log

- [x] 2026-08-29: plan written
- [x] 2026-08-29: feature applied, gates verified (unit 260, browser 52, e2e 231),
      pre-push hook OK on the committed state, committed; report done sent
