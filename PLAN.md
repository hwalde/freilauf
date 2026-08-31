# PLAN — dead-code elimination (tree 3)

## Goal

Find code that nothing reaches any more and remove it — with the burden of
proof on removal, not on keeping. A symbol is only removed when a full-text
scan over **every** file in the repository (source, tests, docs, shell,
translations, HTML) finds no reference to it beyond its own declaration, and
when a reading of the surrounding code confirms it is neither a documented
public seam nor reached through a dynamically built name.

Three things this repository does make a naive sweep dangerous, and each one
is a rule in this plan:

- **Names are built at runtime.** `t('status.' + run.status)`,
  `t(\`flows.step.${type}\`)`, `t(\`welcome.nav_${i + 1}\`)` — 200 of the 1164
  translation keys look orphaned to a literal search and are not. Only a key
  whose whole prefix family is statically written may be touched.
- **Deliberate survivors look dead.** The `cc-hub` → `Freilauf` shims, the
  `CCHUB_*`/`CC_*` fallbacks, the `telegram` flow-step alias, the
  `location.reload()` after a kill, `runs.telegram_on` — AGENTS.md states why
  each exists. None of them is dead code.
- **An export is not a call site.** ~110 symbols are exported and used only
  inside their own file (test seams, plugin surface, historical structure).
  That is over-export, not dead code; removing the keyword is churn with a
  risk and no benefit, so it is reported, not changed.

## Depth tree

```
Root: eliminate dead code
├── 1  Server JavaScript
│   ├── 1.1  Dead exported production symbols
│   │    ├── 1.1.1  pages.mjs pageCodingAgents — the page the Plugins page replaced
│   │    ├── 1.1.2  plugin layer: store.pluginProviders / store.enabledPlugins /
│   │    │          settings.pluginSettingValues / discovery.allDiscoveries
│   │    └── 1.1.3  misc: llm/json.firstJsonValue, telegram TELEGRAM_LIMITS +
│   │               CAPTION_MAX, sessions.currentArchiveKeepMs
│   ├── 1.2  Test seams no suite calls
│   │    ├── 1.2.1  cleanup._cleanupGetSetting / _cleanupSetSetting
│   │    ├── 1.2.2  integrate._resetState
│   │    └── 1.2.3  llm/sources._sourcesReset, plugins/context._registryReset,
│   │               usage._usageCacheAge
│   └── 1.3  Dead imports (the binding is the only occurrence in the file)
│        ├── 1.3.1  node:os homedir in coding-agents / db / plugins/loader
│        ├── 1.3.2  node:fs statSync in extras-suggest
│        └── 1.3.3  cross-module: pages.mjs cleanupPrompt+startCleanupRun,
│                   web.mjs cleanupSettingsSummary, and the db.mjs imports
│                   orphaned by 1.2.1
├── 2  Non-JS assets
│   ├── 2.1  Translation catalogs (en/de/zh in one edit — the parity test)
│   │    ├── 2.1.1  orphaned before this change: runform.branch_mode,
│   │    │          settings.coding_agents_hint, ca.providers_legend,
│   │    │          ca.providers_hint, ca.no_providers
│   │    └── 2.1.2  orphaned BY 1.1.1: the ca.* keys only pageCodingAgents used
│   ├── 2.2  public/hub.css — measured: 0 of 119 classes unreferenced. Nothing to do
│   └── 2.3  bin/*, setup/* — measured: 0 of 46 shell functions unreferenced. Nothing to do
└── 3  Files and test hygiene
     ├── 3.1  unused destructured bindings in test/unit.mjs and
     │        test/verify-agent-lifecycle.mjs
     ├── 3.2  test/echt.mjs homedir
     └── 3.3  orphaned-but-passing verification scripts — REPORTED, not deleted
```

## Decisions

- **A passing test is never dead code.** `scripts/gates-msg-header.mjs` and
  `test/verify-agent-lifecycle.mjs` are unreferenced by `package.json`, by any
  suite and by any document — but both still run green, and both cover
  behaviour (the `repo / AGENT name REPORT:` message header; the
  `UNIQUE(repo_id, name)` rebuild, the move suffix, delete-keeps-runs) that
  **no** maintained suite covers. Deleting them would trade a dead-file count
  for a real coverage hole. They stay, and the report names them.
- **A name written into the reference documentation is not orphaned.** That is
  the line this change draws, and three findings sit on the other side of it —
  each provably uncalled, each left alone, each named in the report:
  - `openrouterGateBlocked` (quota.mjs) is the one of three one-line wrappers
    (`openrouter` / `deepseek` / `cursor`) that no test calls today, and
    `docs/plugins.md` names all three together with the reason they exist (the
    unit suite cache-busts `quota.mjs`, and a delegation into the plugin would
    hand back the previous case's reading).
  - `server/notifiers/index.mjs` and the four registry functions only it
    re-exports (`notifierIds`, `getNotifier`, `notifierLabel`,
    `notifiersWithSetup`) have no importer — `notify.mjs` reaches the registry
    directly through `allPlugins()`. But `docs/plugins.md` describes that file
    as one of the three front doors next to `harnesses/index.mjs` and
    `providers/index.mjs` and lists those four functions in its API table, so
    it is a declared surface, not a leftover.
  - `unconfiguredHarnessIds` (coding-agents.mjs) lost its last caller with
    `pageCodingAgents` — and `coding-agents.mjs` is documented as a
    **byte-compatible adapter** whose exported API is deliberately preserved so
    a rollback and both test groups keep working. `seedFilePath` in the same
    list is in the same position.
- **`_usageCacheAge` went, `_balanceCacheAge` stayed** — not symmetry for its
  own sake: the balances one IS called by the unit suite, the usage one is
  called by nothing.
- **A test seam nothing calls IS dead.** `_cleanupGetSetting`,
  `_cleanupSetSetting`, `_resetState`, `_sourcesReset`, `_registryReset` and
  `_usageCacheAge` exist only to be called from a suite, and no suite calls
  them. Their siblings that ARE called (`_alertReset`, `_notifyLogReset`,
  `_balanceCacheReset`, `_usageCacheReset`, `_sessionMemoryReset/_Age`) stay
  untouched.
- **The database schema is not touched.** A column is dropped by rebuilding
  the table, and this project's own rule (`openrouter_min_eur` holding dollars,
  `runs.telegram_on` after the notifier rebuild) is that such a rebuild is a
  migration for nothing. Nothing found there anyway.
- **Removal cascades are re-measured, not assumed.** Deleting a function can
  orphan the import it was the only user of (`getSetting`/`setSetting` in
  cleanup.mjs) or another symbol whose only mention was its doc comment
  (`_registryReset`, named only in the comment above `_sourcesReset`). The
  scan is therefore run again after the edits, and its ZERO list must be empty
  of anything not on the documented keep list.

## Status log

- [x] 2026-08-31: scanned — 13 zero-reference symbols, 11 dead imports,
      3 unused destructured bindings, 5 orphaned translation keys before the
      page removal, 0 dead CSS classes, 0 dead shell functions, 0 unreferenced
      source files.
- [x] 2026-08-31: plan and gates written before the first edit.
- [x] 2026-08-31: implemented — 15 identifiers, 18 translation keys and 12 dead
      import bindings removed across 20 files; ~200 lines gone, nothing added.
      Every removal cascade re-measured afterwards: the scanner's
      zero-reference list is empty and no import binding is unused any more.
- [x] 2026-08-31: verified — GATES.md 7 of 7 met through the checker, every
      suite at exactly its pre-change count (unit 361, e2e 280, browser 61,
      proxy 4, deploy 22), and the absence check proved against a positive
      control on `HEAD`.
