# Gates: Freilauf skills — shipped, installed, kept current, offered

OWNS: skills/**, server/skills.mjs, server/read-api.mjs, bin/fl-api, server/harnesses/*.mjs, server/plugins/registry.mjs, server/plugins/web.mjs, server/harnesses/index.mjs, server/pages.mjs, server/welcome.mjs, server/web.mjs, server/hub.mjs, public/hub.js, public/hub.css, lang/*.json, setup/02-install-scripts.sh, bin/fl-help, test/*.mjs, AGENTS.md, docs/plugins.md, SETUP_WITH_AGENT.md, README*.md

Scope: Freilauf ships six agent skills that teach any coding agent how to drive
it; where a coding agent reads skills is a plugin declaration; the hub installs
them into the smallest covering set of user directories, keeps them current and
removes only what it wrote; the operator is asked once in the Welcome wizard and
can change it under Settings → Freilauf skills; a read-only JSON API and
`bin/fl-api` are what the skills talk to.

- [x] G1: unit suite green — the covering set, the install/remove round trip, the frontmatter contract of every shipped skill, i18n parity across three catalogs
  CHECK: node test/unit.mjs
  EXPECT: Unit tests: 388 checks passed
  EVIDENCE: 388 checks passed (1.1 s). New group "Freilauf skills: where they go, and what may be removed" — 10 checks incl. the covering set for seven plugin combinations, install → idempotent → repair → auto-update-off → remove, and the refusal to touch a foreign directory.

- [x] G2: e2e suite green — the settings page, the installation through HTTP, the read-only API, the six-step wizard
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests: 295 checks passed
  EVIDENCE: 295 checks passed (84.9 s). New group "Freilauf skills: the page, the installation, and the read-only API" — 9 checks, one of which runs the skill's OWN shipped script against the sandbox hub; the wizard group updated to six steps and now posts `/welcome/skills`; plus "active is a checkbox, and a spelled-out 0 means off rather than on".

- [x] G3: browser suite green — unticking the installation asks before anything is deleted
  CHECK: node test/browser.mjs
  EXPECT: Browser tests: 63 checks passed
  EVIDENCE: 63 checks passed (19.8 s). Group A18: saving unchanged asks nothing, unticking opens the server-rendered dialog and submits nothing, cancel leaves the setting on, confirming saves.

- [x] G4: the whole shipped suite green — nothing regressed
  CHECK: npm test
  EXPECT: post-merge: 19 checks passed
  EVIDENCE: unit 392, e2e 300, proxy 4, deploy 22, post-merge 19, browser 66 — all green.

- [x] G5: the covering set is really the smallest one on this machine's four coding agents
  EVIDENCE: measured against the four built-in declarations — claude alone → `~/.claude/skills`; cursor alone → `~/.cursor/skills`; opencode alone → `~/.config/opencode/skill`; hermes alone → `~/.hermes/skills`; all four → exactly two directories (`~/.claude/skills` serving claude+cursor+opencode, `~/.hermes/skills` serving hermes). Asserted in the unit suite against synthetic declarations so the RULE is tested, not the current plugin files.

- [x] G6: every declared skill directory was read out of the installed CLI, not guessed
  EVIDENCE: cursor's `src/utils/skill-path-utils.ts` search list read from `~/.local/share/cursor-agent/versions/*/index.js`; opencode's own configuration table read from its binary ("Global skills", "External skills (auto-loaded)"); `hermes skills trust --help` plus `hermes_cli/config_defaults.py` (`skills.external_dirs` empty by default, project discovery `./.hermes/skills` and `./.agents/skills`); claude's documented personal/project locations.

- [x] G7: the skills are valid Agent Skills by the open specification, not just by our own reading
  CHECK: node test/unit.mjs
  EXPECT: Unit tests: 388 checks passed
  EVIDENCE: the unit group asserts, per shipped skill, that the frontmatter starts on line 1, carries ONLY the six spec keys (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`), that `name` equals the directory name and matches `^[a-z0-9]+(-[a-z0-9]+)*$`, and that the description is between 40 and 1024 characters.

- [x] G8: every route the six skills name really exists
  EVIDENCE: 49 distinct `/api/…` paths extracted from `skills/` and each one matched against `server/web.mjs`, `server/read-api.mjs`, `server/flows/web.mjs` — every one is a live route (the uuid ones through their regexes at web.mjs:400-748).

- [x] G9: `bin/fl-api` works against a real hub, and fails honestly against a route that is not there
  EVIDENCE: `fl-api --url` printed the local base; `fl-api /api/usage` returned the live JSON pretty-printed; `fl-api --status /api/repos` against the hub still running the previous release printed `HTTP 404` on stderr, the JSON body on stdout, and exited 1.

- [x] G10: no operator-specific value entered the repository
  CHECK: ./pruefe-vor-push.sh
  EXPECT: /clean|OK|no private/i
  EVIDENCE: the project's own pre-push check is the oracle here on purpose — it
  reads the forbidden patterns from OUTSIDE the repository
  (`~/.config/freilauf/verbotene-muster`), so this gate cannot restate them and
  become the leak it is testing for. It found ONE, pre-existing: the operator's
  real VPN port used as a test fixture in `test/unit.mjs` since an earlier
  commit, fixed here (a fictional 9443). The `skills/` tree was additionally
  read end to end by a second reviewer for ports, addresses, hostnames and home
  paths — clean.

- [x] G14: a repository can be deactivated and (in the UI, by a human) deleted
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests: 300 checks passed
  EVIDENCE: 300 checks passed. New group "Repos: deactivating takes one out of
  every dropdown, deleting needs its name" — 5 checks: explicit `active=0|1`
  and the flip; absence from the header switcher, the Quick-Run dialog, the
  move target, the cleanup settings and the flow designer's list, while the
  Repos page still lists it marked; a manual start refused BY NAME with no row
  left behind and the overview/archive/sidebar still rendering for it; the
  delete refused on a wrong `confirm` and again on a run in flight; and the
  delete taking runs, agents, events and incidents while `<repo>/.git` survives.
  Unit adds 3 checks (`repoInactive` tri-state, `repoDeleteFacts` counts, and a
  cleanup check that the group leaves the shared database as it found it) and
  the browser suite 3 (the button dead until the typed name matches exactly, the
  field cleared on reopen, cancel changing nothing, "deactivate instead", and a
  real delete) — unit 392, browser 66.

- [x] G15: two defects the feature work turned up were fixed, not worked around
  EVIDENCE: (1) `mergeGeneral()` in `quota.mjs` chose the claude quota window by
  age across all three sources, but `statSync().mtimeMs` is a float and
  `Date.now()` an integer millisecond — so a `quota.json` written inside the
  current millisecond carried an `at` LARGER than `now`
  (1788443185118.0244 vs 1788443185118) and beat a live account answer. Measured
  at 6 failures in 30 suite runs; the rule was always "the live answer wins
  outright", which `mergeScoped()` already did. Fixed, pinned by a test that
  counter-checks (it fails without the fix), 40 consecutive clean runs after.
  (2) `test/unit.mjs` hardcoded `repoId: 1` in the run-definition group, which
  broke the moment another group inserted and removed a repo of its own; it now
  looks the id up. Both written up in the Pitfalls section.

- [x] G13: the six skills were fact-checked against the source by a second reader
  EVIDENCE: an independent pass over all 19 files re-derived every route, field
  name, column, settings key, default and enum from the source and found seven
  wrong claims, all fixed: `/api/effort`'s error shape; the model list of a
  subscription harness travelling in the `provider` parameter, not `harness`;
  the OpenRouter block being rendered for every harness while only `auto` is
  gated on opencode; `agentStart()` not reading `repo`; `capture-pane` without
  the colon exiting 1 rather than 0 (re-measured on tmux 3.4); and two counts
  in the statistics skill. It also executed all nine SQL recipes against a
  throwaway database and drove `agent-edit.py` end to end against a stub server.

- [x] G11: documentation states the contract where a stranger's agent will look for it
  EVIDENCE: `docs/plugins.md` — the `skills` row in the harness table plus a section "Where a coding agent looks for skills" and step 9 of the "adding a coding agent" checklist; `AGENTS.md` — a section of its own plus a new Pitfalls entry for the truthy `'0'`; `SETUP_WITH_AGENT.md` — the wizard is six steps, a numbered item for Settings → Freilauf skills, two rows in "Make it yours", two rows in the file map, one checklist line; all three READMEs carry the feature bullet and the seam.

- [x] G12: the test suites cannot reach the operator's real skill directories
  EVIDENCE: `FREILAUF_SKILLS_HOME` and `FREILAUF_SKILLS_STATE` are set in `test/sandkasten.mjs` (both in the hub's environment and in `watcherVorbereiten`) and at the top of `test/unit.mjs`; the e2e test additionally asserts that every resolved target directory starts with the sandbox home before it installs anything.
