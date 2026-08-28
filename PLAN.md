# PLAN — edit a run before and during its life (tree 3)

## Goal

Three operator wishes, all about a run that exists but has not finished:

1. **Running runs** (especially single runs) get a changeable **expected
   duration** — the traffic-light thresholds (soft_overrun at 80 %, overrun at
   100 %) and the metrics/overview read `runs.expected_minutes` live, so a new
   value takes effect without touching the agent.
2. **Not-yet-started runs** (`scheduled`, `deferred`) get a changeable
   **prompt** — `launchRun()` reads `runs.prompt` when it starts, so the new
   text is what the session actually launches with.
3. **Not-yet-started runs** can be **moved to another repo** — the worktree is
   created from the repo at launch, so changing `runs.repo_id` moves the run's
   future, not its past.

## Depth tree

```
Root: let the operator edit parts of a run that still has a future
├── 1  Server: what may be edited per status, applied in one place
│    └── 1.1  server/run-edit.mjs (new): runEditAllowed() permission matrix,
│              editRun() validates + applies + writes the 'edited' event and
│              re-derives a prompt-derived title
│    └── 1.2  server/web.mjs: POST /api/runs/<id>/edit — form or fetch, with
│              problemPage for an HTML error
├── 2  Detail page: the "Edit this run" card
│    └── 2.1  server/pages.mjs: runEditCard() — rendered on pageRun AND in the
│              run-detail fragment, fields per runEditAllowed()
│    └── 2.2  public/hub.js: the fragment swap must not throw away what is
│              being typed in the card (#run-edit :focus), and the card must
│              disappear once the run is no longer editable
│    └── 2.3  lang/en.json, lang/de.json, lang/zh.json: new keys, identical
│              key set across all three (unit test enforces it)
├── 3  Verify
│    ├── 3.1  test/unit.mjs: the permission matrix and editRun() decisions
│    ├── 3.2  test/e2e.mjs: schedule a run → edit prompt + duration + move it →
│            it starts with the new prompt in the new repo; a running run's
│            duration edit; rejected edits for a started run
│    └── 3.3  test/browser.mjs: the card renders on the detail page with the
│            fields the status allows
└── 4  Docs
     └── 4.1  AGENTS.md + SETUP_WITH_AGENT.md: the run is editable before and
              during its life — where, and what each status allows
```

## Decisions

- **`runs.expected_minutes` is the only thing duration editing touches.** The
  already-running agent is deliberately NOT told — the value in its prompt is
  informational; the watcher's thresholds, the metrics and the overview read
  the column live. New prompt/duration edits for a *running* run would fight
  the session, so only the duration is offered there.
- **"Not started" = `scheduled` + `deferred`.** Both have no session and no
  worktree; both start through `launchRun()` which reads the stored prompt.
  A `deferred` run waits on quota exactly as a `scheduled` one waits on its
  time — same editability, same rule.
- **A prompt change re-derives a prompt-derived title.** If the run's title is
  still the fallback of the OLD prompt (i.e. nobody renamed it), it becomes the
  fallback of the NEW prompt and `applyGeneratedTitle()` gets another chance —
  an operator name or an LLM title is never overwritten.
- **Moving to the repo the run already lives in is a no-op, not an error.**
  The combined form pre-fills the repo select; a duration-only edit would
  otherwise fail on its own untouched field.
- **One combined card on the detail page**, a `<details>` that is closed by
  default, fields rendered per `runEditAllowed()`. Classic `<form method=post>`
  + redirect, like the archive button — the fragment live-updates the card
  afterwards, and the run-detail fragment swap is skipped while the card has
  focus so nothing is lost mid-typing.
- **The 'edited' event goes through `addEvent()`** like every other run
  transition, so the detail page's event list and the live channel stay honest
  without a second announce path.

## Status log

- [x] 2026-08-28: plan written
- [x] 2026-08-28: leaves 1–4 implemented; unit (241), e2e (224, incl. the new
      "Edit a run before and during its life" group), browser (50, incl. the
      A15 card group), proxy (4), deploy (9) green; all four gates met
