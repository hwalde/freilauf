# Gates: Quick Run → full run form handoff

OWNS: server/favorites.mjs, server/pages.mjs, server/web.mjs, public/hub.js, public/hub.css, lang/en.json, lang/de.json, lang/zh.json, test/browser.mjs

Scope: The Quick Run dialog gains a "More settings" action that opens the
single-run form (`/runs/new`) in a new window prefilled with the dialog's
favorite setup, task, branch rule and start time.

- [x] G1: the favorite can act as the run form's template; the form renders its setup
  CHECK: node -e "import('./server/favorites.mjs').then(m=>{const f=m.favoriteTemplate({harness:'claude',model:'x',provider:'p',or_provider:'q',effort:'high',skills:'[\"unlazy\"]',flows:null});if(f.harness!=='claude'||f.model!=='x'||f.provider!=='p'||f.or_provider!=='q'||f.effort!=='high'||f.skills!=='[\"unlazy\"]')process.exit(1);console.log('favoriteTemplate ok')})"
  EXPECT: favoriteTemplate ok
  EVIDENCE: met — the one-liner exited 0 and printed the marker; full evidence
    lives in the machine-local .unlazy/ (gitignored).

- [x] G2: the Quick Run dialog offers the handoff, and i18n key sets stay identical
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — node test/unit.mjs: 188 checks passed.

- [x] G3: a browser click on "More settings" opens the run form in a new window with the dialog's state carried over
  CHECK: node test/browser.mjs
  EXPECT: Browser tests:
  EVIDENCE: met — node test/browser.mjs: 40 checks passed, incl. the new handoff test.

- [x] G4: the hub's own suites still pass end to end
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests:
  EVIDENCE: met — node test/e2e.mjs: 181 checks passed.
