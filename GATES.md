# Gates: two-part reports, notification reliability, run link in messages

OWNS: server/reports.mjs, server/integrate.mjs, server/notify.mjs, server/util.mjs, server/db.mjs, server/pages.mjs, server/hub.mjs, server/watcher.mjs, server/runner.mjs, bin/fl-report, lang/*.json, test/*.mjs

Scope: The agent delivers a short report (the Telegram text) and a detailed report (the attached document); the double-send of reports is fixed; the run link appears in the message text; the notification hostname is configurable in Settings.

- [ ] G1: unit suite green — pure logic (i18n parity, publicBase host resolution, fl-report --detail payload, replay-dedupe helper)
  CHECK: node test/unit.mjs
  EXPECT: unit suite passed
  EVIDENCE: pending

- [ ] G2: e2e suite green — a report with a detail reaches the channel with both parts, a replayed inbox report is not double-sent, nothing regressed
  CHECK: node test/e2e.mjs
  EXPECT: e2e suite passed
  EVIDENCE: pending

- [ ] G3: browser suite green — the settings page renders the new field and the run detail page shows the detail report
  CHECK: node test/browser.mjs
  EXPECT: browser suite passed
  EVIDENCE: pending

- [ ] G4: docs agree — SETUP_WITH_AGENT.md mentions the public-host setting and the two-part report where the seams it describes were touched
  EVIDENCE: pending
