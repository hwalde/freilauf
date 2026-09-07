# PLAN — Dead code, third pass: what 218 commits of new surface left behind (tree 3)

## Goal

Find and remove code nothing reaches, and — the harder half — prove for
everything that merely *looks* unreached that it is alive, so the tree is not
made smaller at the price of being made wrong.

Two dead-code passes have already run over this repository, and they left a
policy that this pass inherits rather than re-litigates:

- **`e871322` — "remove what nothing reaches, keep what documentation names".**
  15 symbols, 12 import bindings and 18 translation keys went. What
  deliberately stayed: a name written into the reference documentation
  (`openrouterGateBlocked`, `unconfiguredHarnessIds`, `seedFilePath`,
  `server/notifiers/index.mjs`), and two unreferenced files that are still the
  only coverage of what they check (`scripts/gates-msg-header.mjs`,
  `test/verify-agent-lifecycle.mjs`).
- **`4be531f` — "two unreachable routes and two attributes nothing reads".**
  It also wrote down the rule that saves the most time here: **a green
  assertion is use**, so an export whose only consumer is the test suite is
  alive; and `setup/fw-inspect.sh` is an operator tool a human runs by hand,
  not an unreferenced file.

Since `4be531f` the tree has grown by **218 commits and ~67 000 lines**, almost
all of it `server/sandbox/`. That is the surface this pass is about.

## The tree (depth 3)

```
dead-code-3
├── 1  symbol level — is anything declared that nothing names?
│   ├── 1.1  exported symbols with no consumer anywhere
│   ├── 1.2  import bindings and destructured bindings never used
│   └── 1.3  declarations at any indentation, per file
├── 2  artefact level — is anything shipped that nothing reaches?
│   ├── 2.1  HTTP routes, fragments and data-* attributes
│   ├── 2.2  translation keys, CSS classes, shell functions and variables
│   └── 2.3  files no other file names
└── 3  document level — is anything *written down* that nothing reads?
    ├── 3.1  the sandbox spec's own leaves (the `secrets.gitFetch` shape)
    ├── 3.2  the shipped profiles, against the document they are written for
    └── 3.3  plugin descriptor keys, settings keys, env seams, event kinds
```

Branch 3 is the one the previous two passes could not have: it looks at
**data** rather than at symbols, and it is where a field can be declared
correctly, explain itself in prose, and be read by nobody — the shape
`f86fb1e` ("three things that were written down and never read") already found
once in this same subsystem.

## Method: every scanner is proved against a positive control

A scanner that finds nothing is worthless unless it can be shown to find
something. Each of the nine scanners was therefore run first against
**`4669f3d`** — the tree as it stood *before* the first dead-code pass — and
only believed once it rediscovered what that pass removed:

| scanner | rediscovers at `4669f3d` |
|---|---|
| symbols | `_cleanupGetSetting`, `_cleanupSetSetting`, `integrate._resetState`, `llm/json.firstJsonValue`, `_sourcesReset` |
| imports | all 10 dead import bindings, incl. `pages.cleanupPrompt`, `db.homedir` |
| routes | `/api/flows/step-defaults`, `/api/fragments/session-row` |
| data attributes | `data-active`, `data-llm-prefix` |
| i18n / css / shell / files | the same verdicts the two passes recorded |

## What goes

| # | what | why it is dead |
|---|---|---|
| 1 | `specFileExists()` — `server/sandbox/index.mjs` | exported, called by nothing: not code, not a suite, not a document. Its own comment says "Used by the resume path's checks"; that path asks `readSpecFile()` and never this |
| 2 | `buildStates()` — `server/sandbox/runtime.mjs` | exported, called by nothing. Its comment says "for a page that renders all of them"; the page renders `buildStateOf(ref)` per image |
| 3 | `homedir`, `getSetting` — `server/watcher.mjs` | import bindings that are the only occurrence of their name in the file |
| 4 | `splitEnvArgs` — `test/unit.mjs`; `_r`, `_h` — `test/deploy.mjs` | the same, in the suites |
| 5 | `gitFetch: 'mirror'` ×5 — `server/sandbox/profiles.mjs` | the field was removed from `DEFAULT_SPEC`, and `checkNode()` now refuses it by name as an unknown field — but all five shipped profiles still write it |
| 6 | `audit.proxyLog`, `audit.export` — `DEFAULT_SPEC` in `server/sandbox/spec.mjs` | nothing reads either. `proxy.mjs` opens `auditStream()` unconditionally in all three placements, and the export route always streams jsonl, so `false` and `'none'` are promises the hub does not keep. `audit.dockerEvents` beside them IS read twice and stays |
| 7 | `uebersicht-repo3.png` | a 232 KB screenshot of the operator's own live installation, committed by accident in a WIP commit; named by no document, and it carries real run titles and real quota figures into a public repository |

For 5 and 6 the remedy follows the precedent this repository already set and
tested: the leaf leaves `DEFAULT_SPEC`, and its **ordering and narrowing shape
stay** (`MODE_ORDERS`, `SHAPES`) so a profile stored before the removal still
layers exactly as it did instead of freezing as `fixed`.

## What deliberately stays, and the measurement behind each

- **`openrouterGateBlocked`, `unconfiguredHarnessIds`** — the only two symbols
  in the tree whose sole mention outside their own file is prose. Both are
  named in `docs/plugins.md` as part of a contract (a trio of gate wrappers,
  and a byte-compatible adapter API). Settled by `e871322`; re-measured, same
  answer.
- **`scripts/gates-msg-header.mjs`, `test/verify-agent-lifecycle.mjs`,
  `setup/fw-inspect.sh`, `.github/*`** — the four files nothing names. Settled
  by the two earlier passes for reasons that have not changed.
- **`/api/fragments/usage`, `/settings/coding-agents/delete`,
  `/telegram-setup/`** — the three route literals with one mention. All three
  are documented compatibility surfaces; the first two were settled by
  `4be531f`.
- **`data-panel`** — write-only in the server, and asserted twice by the e2e
  suite. A green assertion is use.
- **`.sqd-toolbox`, `.sqd-smart-editor`** — emitted by
  `sequential-workflow-designer`, not by us. Present at `4669f3d` too.
- **`MODE_ORDERS['secrets.gitFetch']`, `SHAPES['filesystem.protected']`** —
  kept on purpose, and their own comments say why.
- **The `cc-*` / `CCHUB_*` transition layer** — `AGENTS.md` says in so many
  words that it is for one transition release and that a later commit deletes
  it. Every fallback in it is reached today; ending the transition is a
  decision, not a dead-code finding.

## Verification

`GATES.md`. Every suite has to land on **exactly** its pre-change count — a
dead-code pass that changes a number has removed something that was alive — and
the absence of each removed name is proved against a positive control on the
pre-change commit, so an empty grep means "measured" and not "the expression
was wrong".
