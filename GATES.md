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
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/46d79a38-detached; path=69c70278aaa2/8 entries; output=(node:2738977) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] G2: the block is collapsed by default and unfolds on the summary click
  CHECK: node test/browser.mjs
  EXPECT: checks passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/46d79a38-detached; path=69c70278aaa2/8 entries; output=(node:2749115) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] G3: the i18n key sets stay identical across all three language files
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/46d79a38-detached; path=69c70278aaa2/8 entries; output=(Use `node --trace-warnings ...` to show where the warning was created) | [coding-agents] seed entry skipped: unknown coding agent: quatsch

- [x] G4: the whole unit suite stays green with the new key
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/46d79a38-detached; path=69c70278aaa2/8 entries; output=(Use `node --trace-warnings ...` to show where the warning was created) | [coding-agents] seed entry skipped: unknown coding agent: quatsch
