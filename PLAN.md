# PLAN — the run detail page shows its prompt in a collapsible block near the top (tree 3)

## Goal

The run detail page (`/runs/<id>`) never shows the run's prompt — the very
task the run was told to do is the one thing not on its own page. A finished
run keeps only its title and chips; to see what it was asked one has to guess
from the report. This change puts the prompt on the detail page, folded away
(`<details>`), high up so the page answers "what was this run told to do?" at
a glance.

## Depth tree

```
Root: run detail page shows the prompt in a collapsible block near the top
├── 1  Render the block (server/pages.mjs)
│    └── 1.1  runPromptCard(run) — <details id="run-prompt">, collapsed, <pre> content
│         └── 1.1.1  placed in pageRun between runDetailHead and runChips
├── 2  i18n (lang/en.json, lang/de.json, lang/zh.json)
│    └── 2.1  run.prompt key in all three files (identical key sets enforced by unit test)
├── 3  Styling (public/hub.css)
│    └── 3.1  details.run-prompt — card look like details.run-edit
└── 4  Tests
     ├── 4.1  browser: block present, collapsed, unfolds on click, sits above the edit card
     └── 4.2  e2e: block on the page, prompt text present, between title and chips
```

## Decisions

- **`<details>` collapsed by default.** "Aufklappbar" is the request; the block
  is the one thing the page needs when it needs it, and a long prompt must not
  dominate the page it is folded into. One click opens it.
- **Not part of the run-detail fragment.** The prompt does not change while a
  run works, and the fragment swap would reset the open state of a `<details>`
  on every event — the operator reading the prompt would have it closed under
  him. Same rule as the goal card, which is page-only for the same reason.
- **Between title and chips.** "Weit oben" reads as the first block under the
  title; the fact-chips follow. The prompt is content, the chips are metadata.
- **Dedicated i18n key `run.prompt`** ("Prompt" / "Prompt" / "提示词") rather
  than reusing the form label `runform.prompt` — a section heading is not a
  field label, and the key-set test keeps the three files honest.

## Status log

- [x] 2026-08-29: plan written
- [x] 2026-08-29: implemented (runPromptCard in pages.mjs, placement in pageRun,
      i18n run.prompt en/de/zh, details.run-prompt in hub.css); unit 262, e2e 236,
      browser 53, proxy 4, deploy 9 all green; GATES.md all four met via the
      checker with machine-local evidence
