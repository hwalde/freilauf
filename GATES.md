# Gates: the status sidebar's statistics refresh on their own

OWNS: server/usage.mjs, server/balances.mjs, public/hub.js, test/sandkasten.mjs, test/browser.mjs, test/unit.mjs

Scope: The status sidebar re-fetches itself on a timer (no run event required),
and the server panel caches age after 60 s (env-overridable) so the numbers
actually move. The browser suite proves the Claude usage percentage updates
when quota.json changes, with the page untouched.

- [x] G1: the panel caches honor the 60 s window — fresh within it, refreshed after it
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — node test/unit.mjs: 225 checks passed.

- [x] G2: the sidebar re-fetches itself and shows a changed Claude usage without a run event
  CHECK: node test/browser.mjs
  EXPECT: Browser tests:
  EVIDENCE: met — node test/browser.mjs: 47 checks passed, incl. "the Claude
    usage percentage is updated without a run event" (proves the poll + cache
    change end to end).

- [x] G3: the hub still works end to end
  CHECK: node test/e2e.mjs
  EXPECT: E2E tests:
  EVIDENCE: met — node test/e2e.mjs: 220 checks passed.
