# PLAN — Dead code: the second pass, and what a prose mention hid (tree 3)

## Goal

Find what nothing in this repository reaches any more and remove it — with the
burden of proof on the removal, never on the keeping. The last such pass was
`e871322` (2026-08-31). Since then the sandbox, the panels, the shipped skills,
the resume path and the follow-up commissions arrived, so the question is worth
asking again.

## The method, and the one thing that made this pass find more than a grep

A full-text scan for every declared symbol is what the previous pass did, and it
is not enough. This repository comments heavily and its `AGENTS.md` names
functions by hand, so **a sentence about a function reads exactly like a caller**
to a literal search. Three of the nine findings below were invisible that way:
`listSessions()` is named in six comments, in `AGENTS.md` twice and in an import
line that never uses it, and has not had a caller since the tmux verdict split.

So every candidate is judged on **code** occurrences only:

| Counted as a use | Not counted |
|---|---|
| an identifier on a line of `.mjs` / `.js` / `.py` / shell code | the same identifier after `//`, or on a line beginning `*`, `/*`, `#` |
| a call, a reference, a re-export | a mention in `.md`, `.json`, `lang/*`, a service file |
| — | **the `import` line itself**: a binding that is imported and never used is dead, not alive |

A dotted occurrence (`bal._balanceCacheAge(...)` — a namespace object from
`await import()`) IS a use, and is counted; that is what keeps the fifteen `_`
test seams alive. Every candidate that survived the scan was then confirmed by
hand with a plain `grep -rn` over the whole tree, printed in full.

## Ownership

One commit, these paths:

`server/sandbox/index.mjs`, `server/sandbox/runtime.mjs`,
`server/sandbox/presets.mjs`, `server/sessions.mjs`, `server/title.mjs`,
`server/notify.mjs`, `server/pages.mjs`, `server/watcher.mjs`,
`public/hub.css`, `bin/fl-attach`, `bin/fl-kill`, `test/unit.mjs`,
`docs/plugins.md`, `AGENTS.md`, `GATES.md`, `PLAN.md`.

## The tree

```
root  dead code is gone and nothing broke
├── 1  server-side JavaScript
│   ├── 1.1  nine exported symbols with no code caller
│   └── 1.2  three import bindings that are never read
├── 2  assets, shell and tests
│   ├── 2.1  one CSS custom property nothing paints with
│   ├── 2.2  two shell assignments nothing reads
│   └── 2.3  one destructured test binding nothing calls
└── 3  proof
    ├── 3.1  absence of every removed name, against a positive control
    ├── 3.2  every suite green at its pre-change count
    └── 3.3  the documentation that named a removed symbol is corrected
```

## Leaf 1.1 — the nine, and why each one is dead

| Symbol | Why it is dead | The sentence its own comment still made |
|---|---|---|
| `sessions.listSessions()` | every caller moved to `listSessionsSnapshot()` when the tmux verdict was introduced; the one import of it (`pages.mjs`) never uses the binding | "the sessions page calls `listSessions()` itself" — it calls the snapshot |
| `sessions.tmuxSessions()` | same split, one layer down: `tmuxSnapshot()` is what everything reads | "right for the DISPLAY callers (the sessions page, the memory block)" — neither is one |
| `title.generateTitle()` | `askTitle()` replaced it when the title retry needed the reason; both callers moved | "which is exactly right for its callers" — it has none |
| `notify.notifyLong()` | the notifier plugins decide about the attachment now; `notify()` takes the normalized message | "kept because four callers think in it" — there are none |
| `sandbox/index.sandboxAvailable()` | the synchronous read nobody performs; all six callers `await refreshSandboxAvailability()` | a paragraph explaining why the read must be synchronous |
| `sandbox/index.specFileExists()` | — | "Used by the resume path's checks." It is not |
| `sandbox/runtime.buildStates()` | the settings page renders from `buildStateOf(ref)` per image | "for a page that renders all of them" |
| `sandbox/presets.expandPresetsForRepo()` | `sandbox/pages.mjs` does `repoOriginUrl()` + `resolvedAllow()` itself; `index.mjs` has `resolveAllowList()` | — |
| `sandbox/presets.PRESETS` | the vocabulary is the `switch` in `expandPresets()`; the three lists that name the four presets are profile VALUES, not validation | "The presets `network.presets` may name" |

## Leaf 1.2 — the import bindings

`pages.mjs` imports `listSessions` (goes with 1.1), `watcher.mjs` imports
`homedir` (a whole `import` line) and `getSetting`. None is read.

## What deliberately stays

- **`unconfiguredHarnessIds`, `seedFilePath`, `openrouterGateBlocked`,
  `server/notifiers/index.mjs`** — `e871322` weighed each of these and kept it
  because `docs/plugins.md` names it as a contract for somebody else's code.
  Reversing another author's recorded decision is not this pass's business.
- **`scripts/gates-msg-header.mjs`, `test/verify-agent-lifecycle.mjs`** — no
  suite runs them and `package.json` does not name them, but both still pass
  (measured, this commit) and both are still the only coverage of what they
  check. Same decision as last time, for the same reason.
- **`setup/fw-inspect.sh`** — nothing references it because nothing is supposed
  to: it is an entry point an operator runs with `sudo`. An entry point is not
  dead for having no caller.
- **161 exports used only inside their own file.** The `export` keyword is
  superfluous on every one of them, and that is a surface question, not dead
  code: the functions run. Narrowing 161 module surfaces would be a diff nobody
  can review against a benefit nobody can measure.
- **263 translation keys with no literal occurrence.** Every one belongs to a
  family built at runtime (`t('status.' + status)`, `` t(`flows.field.${f.key}`) ``,
  `` t(`anomaly.${kind}`) ``, `` t(`welcome.nav_${i + 1}`) ``). Each family's
  builder was found; six members that looked like leftovers
  (`anomaly.worktree_dirty`, `anomaly.sandbox_denied`, `flows.status.stopped`,
  `incident.sandbox_access`, `incident.provider_down`, `merge.skipped_by_operator`)
  were traced to the code that produces them.
- **The cc-hub transition layer** (`CCHUB_*` fallbacks, `pick()`'s old halves,
  the `cc-` prefix, the shims, `setup/migrate-from-cc-hub.sh`). `AGENTS.md`
  says a later commit deletes it; it is not dead today — this installation's
  own `~/.config` still answers to it, and deleting it is a release decision,
  not a scan result.

## What was measured and found clean

Module-local declarations (0 dead), whole files (0 — the three unreferenced ones
are entry points), `lang/*.json` key sets (identical across en/de/zh, 0 orphans),
`public/hub.css` classes (0 of 173) and `public/flows.css` (the two `sqd-*` are
the designer library's own DOM), shell functions in `bin/` and `setup/` (0 of
46), Python in `skills/*/scripts` and the flow-builder template (0), database
columns added by `db.mjs` (0 of 66), the settings allowlist (0 of 36 — three are
read through `` `llm_${purpose}_fallback` ``), the HTTP routes (0 of 79),
`public/hub.js` ids / `data-*` / classes (0), npm dependencies (0 of 6),
`if (false)` and code after `return` (0).
