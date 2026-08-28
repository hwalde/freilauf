# Gates: Quick Run → full run form handoff

OWNS: server/favorites.mjs, server/pages.mjs, server/web.mjs, public/hub.js, public/hub.css, lang/en.json, lang/de.json, lang/zh.json, test/browser.mjs

Scope: The Quick Run dialog gains a "More settings" action that opens the
single-run form (`/runs/new`) in a new window prefilled with the dialog's
favorite setup, task, branch rule and start time.

- [x] G1: the favorite can act as the run form's template; the form renders its setup
  CHECK: node -e "import('./server/favorites.mjs').then(m=>{const f=m.favoriteTemplate({harness:'claude',model:'x',provider:'p',or_provider:'q',effort:'high',skills:'[\"unlazy\"]',flows:null});if(f.harness!=='claude'||f.model!=='x'||f.provider!=='p'||f.or_provider!=='q'||f.effort!=='high'||f.skills!=='[\"unlazy\"]')process.exit(1);console.log('favoriteTemplate ok')})"
  EXPECT: favoriteTemplate ok
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/2e0daa4e-detached; path=69c70278aaa2/8 entries; output=(node:1066039) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] G2: the Quick Run dialog offers the handoff, and i18n key sets stay identical
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/2e0daa4e-detached; path=69c70278aaa2/8 entries; output=(Use `node --trace-warnings ...` to show where the warning was created) | [coding-agents] seed entry skipped: unknown coding agent: quatsch

- [x] G3: a browser click on "More settings" opens the run form in a new window with the dialog's state carried over
  CHECK: node test/browser.mjs
  EXPECT: Browser tests:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/2e0daa4e-detached; path=69c70278aaa2/8 entries; output=(node:1066057) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)

- [x] G4: the hub's own suites still pass end to end
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=~/agents/worktrees/cc-hub/2e0daa4e-detached; path=69c70278aaa2/8 entries; output=(node:1066963) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-warnings ...` to show where the warning was created)
