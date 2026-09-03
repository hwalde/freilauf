# PLAN — dead-code elimination, second pass (tree 3)

## Goal

Find code that nothing reaches any more and remove it — with the burden of
proof on removal, not on keeping. A symbol, route, attribute or key is only
removed when a full-text scan over **every** tracked file (source, tests, docs,
shell, translations, HTML, CSS) finds no reference to it beyond its own
declaration, and when a reading of the surrounding code confirms it is neither a
documented public seam nor reached through a name built at runtime.

The first pass (`e871322`, 2026-08-31) removed 15 identifiers, 18 translation
keys and 12 dead import bindings. Seventeen commits landed after it — the
rename to Freilauf, the timezone setting, the two-part reports, the follow-up
commissions, the claude-usage rework, the welcome-wizard fix, the post-merge
deploy. This pass asks the same question of the tree that grew since, and asks
it in **more places** than the first pass could: the first pass looked at
symbols, imports and translation keys, and never at routes, rendered
attributes, element ids, object members or file-local declarations.

## What makes a naive sweep dangerous here (unchanged, and re-confirmed)

- **Names are built at runtime.** `t('status.' + run.status)`,
  `t(\`flows.step.${type}\`)`, and the `{ target: 'flows.target.', source:
  'flows.source.' }` prefix map in `public/flows.js`. Measured this pass: **217
  of 1178** keys in `lang/en.json` have no literal occurrence outside `lang/`,
  and **every one of them** is produced by a prefix that is written down
  somewhere. A literal search would have deleted all 217.
- **Element ids are swapped generically.** `tauscheNachId()` in `public/hub.js`
  replaces *every* element of a fragment by its own id. So `id="run-metrics"`,
  `id="sessions-body"`, `id="notify-switch"` and six more occur exactly once in
  the whole tree and are all load-bearing.
- **Deliberate survivors look dead.** The `cc-hub` → `Freilauf` shims, the
  `CCHUB_*`/`CC_*` fallbacks, the `telegram` flow-step alias, the
  `location.reload()` after a kill, `runs.telegram_on`. AGENTS.md states why
  each exists. None of them is dead code.
- **A third party's class names are not ours.** `.sqd-toolbox` and
  `.sqd-smart-editor` in `public/flows.css` match nothing in this repository
  and are emitted at runtime by `sequential-workflow-designer` (verified
  against `node_modules/sequential-workflow-designer/dist/index.umd.js`).
- **An export is not a call site.** Over-export is not dead code; it is
  reported, not changed.

## Depth tree

```
Root: eliminate dead code, second pass
├── 1  Measure — build the scanners and prove they can fail
│   ├── 1.1  Symbol level
│   │    ├── 1.1.1  top-level declarations, imports, destructured bindings
│   │    ├── 1.1.2  declarations at ANY indentation (local helpers)
│   │    └── 1.1.3  per-FILE locals (catches names shared across files)
│   ├── 1.2  Non-symbol level
│   │    ├── 1.2.1  translation keys, with dynamic-prefix awareness
│   │    ├── 1.2.2  CSS classes and ids, element ids, data-* attributes,
│   │    │          window globals, object-literal members
│   │    └── 1.2.3  HTTP routes, setting keys, DB columns, shell functions
│   │               and shell variables, unreferenced files
│   └── 1.3  Negative control — every scanner is run against `4669f3d`, the
│            tree before the FIRST dead-code pass, and must rediscover what
│            that pass removed. A scanner that cannot fail proves nothing.
├── 2  Remove what has provably zero consumers
│   ├── 2.1  Unreachable HTTP routes
│   │    ├── 2.1.1  GET  /api/fragments/session-row   (server/web.mjs)
│   │    ├── 2.1.2  GET  /api/flows/step-defaults     (server/flows/web.mjs)
│   │    └── 2.1.3  POST /settings/coding-agents/delete (server/web.mjs)
│   ├── 2.2  The page handler the last of those was the only caller of
│   │    └── 2.2.1  pages.mjs codingAgentDelete + its deleteCodingAgent import
│   └── 2.3  Rendered attributes nothing reads
│        ├── 2.3.1  data-active on #repo-switch          (server/pages.mjs)
│        └── 2.3.2  data-llm-prefix on the LLM-source select (server/pages.mjs)
└── 3  Re-measure and report
     ├── 3.1  Import cascades — an import orphaned BY a removal above
     ├── 3.2  The whole pipeline at exactly its pre-change count
     └── 3.3  What was found and deliberately KEPT, named in the report
```

## Decisions

- **A consumer is a consumer, even when it is a test.** 21 exported symbols
  have no production caller at all; the test suite is their only consumer
  (`stripAnsi`, `fmtDuration`, `autoCloseCandidates`, `remainingIn`, `envIs`,
  `envNames`, `whenFromOutcomes`, `harnessSupportsGoal`, `goalMax`,
  `deployDir`, `setPluginEnabled`, plus the eight `_`-prefixed test seams and
  the two documented gate wrappers). They are **reported, not removed**: the
  instruction for this run was to delete nothing that might still be used, and
  a green assertion is use. Deleting them means deleting their tests, and that
  trades a dead-symbol count for real coverage — the same trade the first pass
  refused for `scripts/gates-msg-header.mjs`.
- **A name written into the reference documentation is not orphaned.** Three
  findings sit on that line and are left alone: `/api/fragments/header-status`
  and `/api/fragments/usage` (no client asks for either any more, and AGENTS.md
  says in so many words that they still exist), and the pair
  `unconfiguredHarnessIds` / `openrouterGateBlocked` that the first pass
  already recorded here for the same reason.
- **A route with no form, no link, no test and no document IS dead.** That is
  what separates 2.1 from the paragraph above. `/api/fragments/session-row` is
  never asked for — `public/hub.js` names its four fragment URLs literally and
  builds none of them. `/api/flows/step-defaults` has no caller in
  `public/flows.js`. `/settings/coding-agents/delete` has no form pointing at
  it: the delete button on the favourites page borrows the `ca.delete` *label*
  and posts to `/settings/favorites/delete`, and the Plugins page that replaced
  the coding-agents page has its own `/settings/plugins/remove`.
- **The function behind a dead route may still be alive.** `defaultProps()`
  stays in `flows/steps.mjs` (the unit suite calls it four times) and
  `deleteCodingAgent()` stays in `coding-agents.mjs` (`docs/plugins.md` lists
  it in the adapter's API table and the unit suite calls it six times). Only
  the route and the unreachable page handler go.
- **An attribute that is rendered and never read is dead weight on every page.**
  `data-active` sits on the repo switcher in the header of *every* page and
  nothing — not `hub.js`, not the CSS, not a test — ever reads it.
  `data-llm-prefix` is on every LLM-source select on the settings page, and the
  code that would have used it says in its own comment that it is "DELEGATED
  and namespaced by the field names rather than by ids".
- **The database schema is not touched.** `runs.main_sha_start` is written by
  `runner.mjs` at launch and read by nothing — a genuinely dead column. It is
  reported and kept: dropping a column means rebuilding the table, and this
  project's own rule (`openrouter_min_eur` holding dollars, `runs.telegram_on`
  after the notifier rebuild) is that such a rebuild is a migration for nothing.
  Stopping the *write* would not free the column and would throw away forensic
  data that costs nothing to keep.
- **A passing test is never dead code** (the first pass's rule, re-confirmed).
  `scripts/gates-msg-header.mjs` and `test/verify-agent-lifecycle.mjs` are
  unreferenced by `package.json`, by every suite and by every document — and
  both still run green, and both are the only coverage of what they check (the
  `repo / AGENT name REPORT:` message header; the `UNIQUE(repo_id, name)`
  rebuild, the move suffix, delete-keeps-runs). They stay.
- **`setup/fw-inspect.sh` is not an unreferenced file, it is an operator tool.**
  Nothing calls it because a human calls it (`sudo ./setup/fw-inspect.sh`)
  before `04-firewall.sh`. That no document points at it is a documentation
  gap, reported here, not a reason to delete a working tool.
- **Removal cascades are re-measured, not assumed.** Deleting a route can
  orphan the import it was the only user of. Every scanner is re-run after the
  edits, and its zero-reference list must be empty of anything not on the
  documented keep list.

## Status log

- [x] 2026-09-03: baseline measured on the unchanged tree — unit 371, e2e 285,
      browser 61, proxy 4, deploy 22.
- [x] 2026-09-03: five scanners written and each proved against `4669f3d`; the
      symbol scanner rediscovers 14 of the 15 symbols and all 7 dead imports
      that the first pass removed, the i18n scanner rediscovers
      `runform.branch_mode` and `settings.coding_agents_hint`, the per-file
      scanner rediscovers `uiTimezone`, `lastCleanupRun` and `moveSuffix`.
- [x] 2026-09-03: scanned — 0 dead top-level symbols, 0 dead imports, 0 unused
      destructured bindings, 0 orphaned translation keys, 0 dead CSS classes,
      0 dead shell functions, 0 dead shell variables, 0 unreferenced source
      files; 3 unreachable routes, 1 unreachable page handler, 2 unread
      rendered attributes.
- [x] 2026-09-03: plan and gates written before the first edit.
- [x] 2026-09-03: implemented — 3 routes, 1 page handler, 3 orphaned import
      bindings and 2 rendered attributes removed across 3 files. Cascades
      re-measured: every scanner's zero list is empty again.
- [x] 2026-09-03: verified — GATES.md 6 of 6 met, every suite at exactly its
      pre-change count, and the absence check proved against a positive control
      on the pre-change sha.
