# PLAN — Freilauf skills: authored, installed, kept current, offered (tree 4)

## Goal

Freilauf ships a family of **agent skills** that teach any coding agent how to
drive this hub — its agents, repos, runs, flows, statistics and its model
choices. They are part of this repository, they are installed at **user level**
into the directories the installed coding agents really read, they are kept
current, and they are offered once during the Welcome wizard.

Four things make this more than "write six Markdown files", and each is a rule
in this plan:

- **Where a coding agent looks for skills is the coding agent's own knowledge.**
  It therefore belongs in its plugin descriptor, like `launch`, `goal` and
  `hookFiles` — separately for user level and project level. The hub must not
  carry a table of vendor paths.
- **A skill installed twice is a skill answered twice.** Three of the four
  shipped coding agents read `~/.claude/skills`; only hermes does not. So the
  installer computes the **smallest set of directories that covers every enabled
  coding agent**, and installs once per directory — not once per agent.
- **Removal must never touch somebody else's file.** The installer records what
  it wrote (path + content hash) and removes only that. A directory that holds a
  skill of the operator's own under the same name is left alone and reported.
- **A recommendation goes stale the moment it is copied.** The static model
  advice lives in one skill (`freilauf-models`); everything installation-specific
  — which coding agents are configured, which favorites exist, which models a
  provider serves — is *asked at runtime* through the hub's own API, never baked
  into the file.

## Measured facts this plan rests on

Read out of the installed CLIs on this machine, not assumed:

| Coding agent | user-level skill roots | project-level skill roots |
|---|---|---|
| claude | `~/.claude/skills` | `.claude/skills` |
| cursor | `~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.grok/skills`, `~/.agents/skills` | the same names inside the workspace |
| opencode | `~/.config/opencode/skill`, plus **auto-loaded** `~/.claude/skills` and `~/.agents/skills` | `.opencode/skill` |
| hermes | `~/.hermes/skills` | `.hermes/skills`, `.agents/skills` (trusted repos only) |

Sources: cursor's `skill-path-utils.ts` search list inside
`~/.local/share/cursor-agent/versions/*/index.js`; opencode's own configuration
table inside its binary (`Global skills`, `External skills (auto-loaded)`);
`hermes skills trust --help` and `hermes_cli/config_defaults.py`;
`~/.claude/skills` for claude.

Consequence: the covering set for all four is **two** directories,
`~/.claude/skills` (claude + cursor + opencode) and `~/.hermes/skills` (hermes).
Nothing about that is hardcoded — it falls out of the declarations.

## Depth tree

```
root — Freilauf skills
├── 1  The platform seam
│   ├── 1.1  Declaration and resolution
│   │   ├── 1.1.1  `skills` declaration on the harness contract (4 plugins + docs)
│   │   └── 1.1.2  server/skills.mjs — covering set, install, remove, sync, state
│   ├── 1.2  Operator surface
│   │   ├── 1.2.1  Settings → Skills (two switches, save, i18n ×3)
│   │   ├── 1.2.2  The removal confirmation (hub.js modal + CSS)
│   │   ├── 1.2.3  The Welcome wizard step
│   │   └── 1.2.4  Sync triggers (startup, settings save, plugin install/enable)
│   └── 1.3  What the skills talk to
│       ├── 1.3.1  Read-only JSON API the skills need
│       └── 1.3.2  bin/fl-api — the CLI a skill actually calls
├── 2  The skills
│   ├── 2.1  The shared one
│   │   └── 2.1.1  freilauf-models
│   ├── 2.2  Work
│   │   ├── 2.2.1  freilauf-runs
│   │   └── 2.2.2  freilauf-agents
│   └── 2.3  Structure
│       ├── 2.3.1  freilauf-repos
│       ├── 2.3.2  freilauf-flows
│       └── 2.3.3  freilauf-stats
└── 3  Proof
    ├── 3.1  Tests (unit, e2e, browser)
    └── 3.2  Documentation (AGENTS.md, docs/plugins.md, SETUP_WITH_AGENT.md, READMEs ×3)
```

## Contracts fixed before any leaf starts

### The plugin declaration

```js
// server/harnesses/<id>.mjs
skills: {
  // Ordered by the plugin's own preference; the resolver treats the order as a
  // tie-break only, because coverage decides. Paths starting with '~' are
  // resolved against the home directory.
  user:    ['~/.claude/skills'],
  // Relative to a workspace/worktree root. Declared for completeness and shown
  // on the Plugins page; the installer does not write into a repository.
  project: ['.claude/skills'],
}
```

Absent = this coding agent has no skill mechanism the hub knows about; it is
skipped without comment.

### The state file

`<dataDir>/skills-installed.json` (`FREILAUF_SKILLS_STATE` overrides it):

```json
{ "version": 1,
  "entries": [ { "dir": "~/.claude/skills/freilauf-runs",   // absolute in the real file
                 "skill": "freilauf-runs", "hash": "<sha256 of the payload>",
                 "at": "2026-09-03T10:00:00Z" } ] }
```

### The settings keys

- `skills_install` — `'1'` / `'0'`, default `'0'`. User-level installation on.
- `skills_auto_update` — `'1'` / `'0'`, default `'1'`. Re-sync on start and on
  every plugin change.

### The source of the skills

`skills/<name>/SKILL.md` in this repository, plus optional
`skills/<name>/scripts/`, `skills/<name>/references/`. Copied verbatim.

## Ownership

| Leaf | owns |
|---|---|
| 1.1.1 | `server/harnesses/*.mjs`, `docs/plugins.md` (contract table + new section) |
| 1.1.2 | `server/skills.mjs` |
| 1.2.1 | `server/pages.mjs` (settings section), `server/web.mjs` (route), `lang/*.json` |
| 1.2.2 | `public/hub.js`, `public/hub.css` |
| 1.2.3 | `server/welcome.mjs` |
| 1.2.4 | `server/hub.mjs`, `server/plugins/web.mjs` |
| 1.3.1 | `server/web.mjs` (JSON routes) |
| 1.3.2 | `bin/fl-api`, `setup/02-install-scripts.sh` |
| 2.x | `skills/**` |
| 3.1 | `test/unit.mjs`, `test/e2e.mjs`, `test/browser.mjs` |
| 3.2 | `AGENTS.md`, `SETUP_WITH_AGENT.md`, `README*.md` |

The leaves under 1.2 touch shared files (`pages.mjs`, `web.mjs`), so they run
**sequentially in this session**, not as concurrent subagents. Only the leaves
under 2 are dispatched in parallel — they own disjoint directories.
