# Gates: the run detail page shows its prompt in a collapsible block near the top

OWNS: server/pages.mjs, public/hub.css, lang/en.json, lang/de.json, lang/zh.json,
test/browser.mjs, test/e2e.mjs, PLAN.md, GATES.md

Scope: The run detail page renders the run's prompt in a collapsed `<details>`
block high on the page — between the title and the fact chips. The block is
styled like the existing detail-page cards, carries a dedicated i18n key in all
three languages, and is verified by a browser test (presence, collapsed state,
toggle, position) and an e2e assertion (prompt text on the page, position).

- [x] G1: the run detail page renders the prompt block between title and chips
  CHECK: node test/e2e.mjs
  EXPECT: checks passed
  EVIDENCE: met — the e2e suite passed 245 checks, incl. "the detail page shows
    the prompt in a collapsible block near the top": the page carries
    `id="run-prompt"`, the run's prompt text, and the three markers in order
    title → prompt → chips. Full evidence lives in the machine-local .unlazy/
    (gitignored).

- [x] G2: the block is collapsed by default and unfolds on the summary click
  CHECK: node test/browser.mjs
  EXPECT: checks passed
  EVIDENCE: met — the browser suite passed 56 checks, incl. "the prompt block
    sits between title and chips, folded away, and unfolds": `#run-prompt` is
    closed at page load, stands between `#run-head` and `ul.chips`, carries the
    prompt text, and opens on the summary click.

- [x] G3: the i18n key sets stay identical across all three language files
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — the unit suite passed 270 checks, incl. the key-set test; the
    new `run.prompt` key exists in en, de and zh with non-empty values.

- [x] G4: the whole unit suite stays green with the new key
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — the same 270-check run covers this gate (see G3).
