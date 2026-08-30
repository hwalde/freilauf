# Gates: central timezone + number/percentage formatting

OWNS: server/util.mjs, server/pages.mjs, server/hub.mjs, server/flows/web.mjs,
public/hub.js, lang/en.json, lang/de.json, lang/zh.json,
test/unit.mjs, test/e2e.mjs, test/browser.mjs, PLAN.md, GATES.md

Scope: A timezone selectable centrally under Settings that every time display —
sidebar and detail pages included — follows, plus number and percentage
formatting that follows the UI language. Verified by unit tests (helpers and
i18n key sets), an e2e test (settings save + a converted timestamp on a page)
and a browser test (the relative-time tooltip uses the configured timezone).

- [x] G1: unit suite green with the new central-format helpers
  CHECK: node test/unit.mjs
  EXPECT: /central format[\s\S]*Unit tests: \d+ checks passed/
  EVIDENCE: met — the unit suite passed 280 checks via the checker, incl. the
    four new "central format" tests (timezone resolution by language and by
    explicit choice, fmtClock/fmtDatePart conversion, fmtDateTime/fmtDbUtc,
    fmtNum/fmtPercent per UI locale, tzAbbrev). Raw evidence is
    machine-local under ~/.unlazy/ (gitignored).

- [x] G2: e2e suite green with the settings-save and timezone-render test
  CHECK: node test/e2e.mjs
  EXPECT: /timezone[\s\S]*E2E tests: \d+ checks passed/
  EVIDENCE: met — the e2e suite passed 253 checks via the checker, incl. "the
    settings page offers the timezone and saves it" and "times on a page render
    in the configured timezone" (12:00 UTC shows 08:00 New York, window.FREILAUF_TZ
    injected).

- [x] G3: browser suite green with the configured-timezone tooltip test
  CHECK: node test/browser.mjs
  EXPECT: /configured timezone[\s\S]*Browser tests: \d+ checks passed/
  EVIDENCE: met — the browser suite passed 57 checks via the checker, incl.
    "the relative-time tooltip follows the configured timezone" (the tooltip
    reads the New York clock after the setting is saved).

- [x] G4: proxy and deploy suites still green
  CHECK: node test/proxy.mjs && node test/deploy.mjs
  EXPECT: /Proxy tests: \d+ checks passed[\s\S]*deploy: \d+ checks passed/
  EVIDENCE: met — proxy 4 and deploy 9 checks passed via the checker.