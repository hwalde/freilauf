# Gates: edit a run before and during its life

OWNS: server/run-edit.mjs, server/web.mjs, server/pages.mjs, public/hub.js,
lang/en.json, lang/de.json, lang/zh.json, test/unit.mjs, test/e2e.mjs,
test/browser.mjs, AGENTS.md, SETUP_WITH_AGENT.md

Scope: A running/waiting run gets a changeable expected duration; a scheduled
or deferred run additionally gets a changeable prompt and can be moved to
another repo — applied in one server-side place, offered on the detail page,
guarded against losing typing, covered by unit + e2e + browser tests.

- [x] G1: what may be edited per status is decided in one place and unit-tested
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — node test/unit.mjs: 241 checks passed, incl. the
    "Run editing (run-edit.mjs)" group (permission matrix, apply, refusals,
    prompt-title re-derivation, no-op move).

- [x] G2: end to end — a scheduled run is edited (prompt, duration, repo) and
  starts with the new prompt in the new repo; a running run only accepts the
  duration; a started run refuses prompt/repo edits
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests:
  EVIDENCE: met — node test/e2e.mjs: 224 checks passed, incl. the
    "Edit a run before and during its life (run-edit.mjs)" group: a running run
    accepts only the duration, a finished run refuses everything, a scheduled
    run is edited and then starts with its new prompt in its new repo.

- [x] G3: the edit card renders on the detail page with the fields its status
  allows, and the fragment swap does not lose what is being typed
  CHECK: node test/browser.mjs
  EXPECT: Browser tests:
  EVIDENCE: met — node test/browser.mjs: 50 checks passed, incl. the
    "A15 — the Edit this run card" group: running run shows only the duration,
    scheduled run shows prompt + repo prefilled, and an edit in the card
    survives the live channel while focused and lands after blur.

- [x] G4: the documentation says a run is editable before and during its life
  EVIDENCE: met — AGENTS.md "A run is not set in stone: duration while it runs,
    prompt and repo before it starts" (the permission table, the live/lazy reads,
    the fragment + focus rule); SETUP_WITH_AGENT.md "Make it yours" table has the
    card as a seam.
