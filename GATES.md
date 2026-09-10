# Gates: dead code — the second pass

OWNS: server/**, public/hub.css, bin/fl-attach, bin/fl-kill, test/unit.mjs, docs/plugins.md, AGENTS.md

Scope: every symbol this repository no longer reaches is gone; every symbol it
does reach is untouched; the documentation that named a removed symbol says
something true again; and no suite moved.

The counts in G1–G4 are **baselines measured on the unchanged tree before the
first edit**, not numbers copied from anywhere: unit 748, e2e 473 + 1 skipped,
proxy 4, egress proxy 11, deploy 22, post-merge 19. The browser suite is not
part of `npm test` and was measured afterwards, separately, in a throwaway
`git worktree` detached on the base commit with `node_modules` linked in: 90.
Each EXPECT below is therefore a comparison, and every gate was executed again
with `--reverify` after the last edit.

The checker writes its own evidence line — exit status, resolved shell, resolved
working directory, a PATH hash and the decisive output. The working directory it
records is an absolute path on the machine that ran it, which `pruefe-vor-push.sh`
refuses (rightly), so each EVIDENCE below is that answer written out without it.

- [x] G1: unit suite green at its pre-change count
  CHECK: node test/unit.mjs
  EXPECT: Unit tests: 748 checks passed
  EVIDENCE: exit=0, EXPECT matched. 748 checks (3.9 s), against 748 on the unchanged tree. The two lines in the captured output are the suite's own deliberate log noise (`unit-broken: the api is on fire`, `seed entry skipped: unknown coding agent: quatsch`).

- [x] G2: e2e suite green at its pre-change count — a whole hub boots, every page renders, the sessions page and the sandbox pages among them
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests: 473 checks passed
  EVIDENCE: exit=0, EXPECT matched. 473 checks + 1 skipped (172.6 s), against 473 + 1 skipped (171.7 s) on the unchanged tree. A whole hub boots in a sandbox: every page renders, the sessions page and the sandbox pages among them.

- [x] G3: browser suite green at its pre-change count
  CHECK: node test/browser.mjs
  EXPECT: Browser tests: 90 checks passed
  EVIDENCE: exit=0, EXPECT matched. 90 checks (37.3 s). The pre-change number was measured separately afterwards, in a throwaway `git worktree` detached on the base commit: 90 checks (37.5 s).

- [x] G4: the rest of the shipped suite green — proxy, egress proxy, deploy, post-merge
  CHECK: node test/proxy.mjs && node test/proxy-egress.mjs && node test/deploy.mjs && node test/post-merge.mjs
  EXPECT: post-merge: 19 checks passed
  EVIDENCE: exit=0, EXPECT matched. proxy 4, egress proxy 11, deploy 22, post-merge 19 — each identical to the pre-change run of `npm test`.

- [x] G5: not one of the removed names is left on a line of CODE anywhere in the tracked tree — a comment or a document may still name what was taken out, and several deliberately do
  CHECK: git grep -nIE '\b(listSessions|tmuxSessions|generateTitle|notifyLong|sandboxAvailable|specFileExists|buildStates|expandPresetsForRepo|PRESETS|ok-bright)\b' -- '*.mjs' '*.js' '*.css' 'bin/*' 'setup/*' 'public/*' | grep -vE ':[0-9]+: *(//|\*|/\*|#)'; [ $? -eq 1 ] && echo dead-names-absent
  EXPECT: dead-names-absent
  EVIDENCE: exit=0, EXPECT matched, output `dead-names-absent`. The seven surviving mentions are all prose: two tombstone comments (sessions.mjs, title.mjs), one comment in sandbox/pages.mjs, two in test/unit.mjs, and two sentences of AGENTS.md history.

- [x] G6: every file this pass touched still parses
  CHECK: node --check server/sandbox/index.mjs && node --check server/sandbox/runtime.mjs && node --check server/sandbox/presets.mjs && node --check server/sessions.mjs && node --check server/title.mjs && node --check server/notify.mjs && node --check server/pages.mjs && node --check server/watcher.mjs && node --check test/unit.mjs && bash -n bin/fl-attach && bash -n bin/fl-kill && echo parses-clean
  EXPECT: parses-clean
  EVIDENCE: exit=0, EXPECT matched, output `parses-clean`. server/reports.mjs, server/notifiers/telegram.mjs and server/sandbox/pages.mjs were checked the same way outside the gate.

- [x] G7: the two unreferenced verification scripts this pass decided to KEEP still pass — the reason they were kept last time is measured, not assumed
  CHECK: node scripts/gates-msg-header.mjs && node test/verify-agent-lifecycle.mjs --migration && node test/verify-agent-lifecycle.mjs --lifecycle && echo kept-scripts-pass
  EXPECT: kept-scripts-pass
  EVIDENCE: exit=0, EXPECT matched: "message-header gates OK", "migration verification passed", "lifecycle verification passed".

- [x] G8: G5's absence check can fail — proved against the pre-change tree as a positive control
  EVIDENCE: the identical pipeline run against the commit (`git grep … HEAD -- …`) prints twelve lines — the definition of every removed symbol plus both `--ok-bright` lines — and exits 0, so the gate fails there. The check therefore measures the removal and not the grep's own emptiness.

- [x] G9: every removed symbol was confirmed by hand to have no code caller, and every remaining mention of it was a comment or a document
  EVIDENCE: full `grep -rn <name> .` output read for each of the nine, printed in this session. `listSessions` had eleven hits and not one caller — six comments, two AGENTS.md sentences, one unused import binding, its own definition, one test comment. `pick()` in sandbox/pages.mjs was inspected separately because it resolves module members by string: its name lists never mention a removed symbol. After the removals the same scan was re-run over the whole tree and reports exactly two exported names with no code caller — `unconfiguredHarnessIds` and `openrouterGateBlocked`, both kept on purpose (see PLAN.md), so nothing was orphaned by what went.
