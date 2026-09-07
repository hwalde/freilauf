# Gates: Dead code, third pass — remove what nothing reaches, prove the rest alive

OWNS: server/sandbox/spec.mjs, server/sandbox/profiles.mjs, server/sandbox/index.mjs, server/sandbox/runtime.mjs, server/watcher.mjs, test/unit.mjs, SANDBOX.md, CHANGELOG.md, PLAN.md, GATES.md

Scope: nine scanners over the whole tree, each proved against `4669f3d` (the
tree before the first dead-code pass) so that an empty result means "measured"
rather than "the expression was wrong". Ten findings are removed; everything
that merely looks unreached is proved alive and named in PLAN.md with its
measurement. No suite count may move: a dead-code pass that changes a number has
removed something that was alive.

The scanners live outside the repository — a dead-code pass must not leave a
scanner behind that nothing runs. The permanent guard is in the unit suite,
which now holds every shipped sandbox profile to the document it is written for
and pins the removed spec leaves in the check that already pinned the two
before them.

- [x] G1: the ten removals are gone from the tree
  CHECK: node /tmp/claude-1000/-home-herbe-agents-worktrees-Freilauf-149a666b-detached/149a666b-4747-450b-9f3a-fdbd314568e3/scratchpad/gate-absence.mjs .
  EXPECT: dead-code absence verified (10 findings)
  EVIDENCE: /bin/sh, cwd = the worktree, exit 0 — `dead-code absence verified (10 findings)`. The ten predicates: `specFileExists`, `buildStates`, the two watcher import bindings, `splitEnvArgs` in the unit suite, `gitFetch` in any shipped profile, `audit.proxyLog` and `audit.export` in DEFAULT_SPEC, the `audit.export` enum in SPEC_VALUES, and the stray screenshot. Mentions in this pass's own prose (PLAN/GATES/CHANGELOG/AGENTS) are excluded by name, not by a wildcard.

- [x] G2: the same ten predicates all answer "present" on the pre-change tree — the negative check has a positive control
  CHECK: node /tmp/claude-1000/-home-herbe-agents-worktrees-Freilauf-149a666b-detached/149a666b-4747-450b-9f3a-fdbd314568e3/scratchpad/gate-absence.mjs /tmp/claude-1000/-home-herbe-agents-worktrees-Freilauf-149a666b-detached/149a666b-4747-450b-9f3a-fdbd314568e3/scratchpad/ctrl-head --expect-present
  EXPECT: positive control: all 10 findings present before the change
  EVIDENCE: exit 0 — `positive control: all 10 findings present before the change`, against `git archive HEAD` unpacked into a directory of its own. An earlier draft of this script scored 5 of 10 and was rewritten rather than believed: two predicates were searching for a word that legitimately survives the removal, and one could not see a file name because the walker filters images out of the content scan.

- [x] G3: no symbol, import binding or destructured binding anywhere in the tree is unreachable
  CHECK: node /tmp/claude-1000/-home-herbe-agents-worktrees-Freilauf-149a666b-detached/149a666b-4747-450b-9f3a-fdbd314568e3/scratchpad/scan-all.mjs .
  EXPECT: dead-code scan clean
  EVIDENCE: exit 0 — `dead-code scan clean`. The same command against `4669f3d` prints `_cleanupGetSetting`, `_cleanupSetSetting`, `integrate._resetState`, `llm/json.firstJsonValue`, `_sourcesReset` and all 10 dead imports the first pass removed, so the empty result is a measurement. One exception is listed by name with its reason: `const { FL_RUN_ID: _r, FL_HUB_URL: _h, ...rest } = process.env` in test/deploy.mjs — bindings whose purpose is to be DROPPED from the rest object, so removing them would stop the two variables being stripped.

- [x] G4: unit suite lands on exactly its pre-change count — and it now pins the removed spec leaves and every shipped profile
  CHECK: node test/unit.mjs
  EXPECT: Unit tests: 721 checks passed
  EVIDENCE: 721 checks passed (3.8 s), identical to the pre-change measurement. Two existing checks grew assertions rather than new checks being added, which is what keeps this count an oracle: "the two inert spec fields are gone" now covers four fields and asserts `audit.dockerEvents` beside them is untouched, and "a shipped profile can start a run" now validates each built-in through `validateSandboxOverrides()`.

- [x] G5: e2e suite lands on exactly its pre-change count
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests: 453 checks passed
  EVIDENCE: 453 checks passed, 1 skipped (138.7 s). Pre-change: 453 passed, 1 skipped (139.4 s).

- [x] G6: the four smaller suites land on exactly their pre-change counts
  CHECK: node test/proxy.mjs && node test/proxy-egress.mjs && node test/deploy.mjs && node test/post-merge.mjs
  EXPECT: post-merge: 19 checks passed
  EVIDENCE: proxy 4, sandbox egress proxy 11, deploy 22, post-merge 19 — each identical to the pre-change measurement.

- [x] G7: browser suite lands on exactly its pre-change count
  CHECK: node test/browser.mjs
  EXPECT: Browser tests: 80 checks passed
  EVIDENCE: 80 checks passed (28.8 s). Pre-change: 80 (28.6 s).

- [x] G8: the shipped-profile assertion can fail — putting one removed field back into one built-in turns it red and names the profile
  EVIDENCE: manual negative control, run before the evidence above was recorded. Re-inserting `gitFetch: 'mirror'` into the Balanced profile alone gives `✗ a shipped profile can start a run — Balanced: names no field the form would refuse: got 1, expected 0` and `Unit tests: 1 of 721 checks failed`; the file was restored from a copy and the suite is green again. Without this the new assertion could have been vacuous.

- [x] G9: the private push check passes — nothing operator-specific is left in the tree
  CHECK: ./pruefe-vor-push.sh
  EXPECT: OK: no forbidden patterns
  EVIDENCE: exit 0 — `OK: no forbidden patterns in the committed state.` (32 hits excused by `pruefe-ausnahmen.txt`, all of them container paths and test fixtures). Worth stating for this pass in particular: the removed screenshot was a picture of a live installation, which no pattern check can read.

Measured: 9 met, 0 unmet, 0 abandoned.
