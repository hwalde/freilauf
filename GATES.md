# Gates: two-part reports, notification reliability, run link in messages

OWNS: server/reports.mjs, server/integrate.mjs, server/notify.mjs, server/util.mjs, server/db.mjs, server/pages.mjs, server/hub.mjs, server/watcher.mjs, server/runner.mjs, bin/fl-report, lang/*.json, test/*.mjs

Scope: The agent delivers a short report (the Telegram text) and a detailed report (the attached document); the double-send of reports is fixed; the run link appears in the message text; the notification hostname is configurable in Settings.

- [x] G1: unit suite green — pure logic (i18n parity, publicBase host resolution, fl-report --detail payload, replay-dedupe helper)
  CHECK: node test/unit.mjs
  EXPECT: unit suite passed
  EVIDENCE: 367 checks passed (1.0 s), after merging origin/main too

- [x] G2: e2e suite green — a report with a detail reaches the channel with both parts, a replayed inbox report is not double-sent, nothing regressed
  CHECK: node test/e2e.mjs
  EXPECT: e2e suite passed
  EVIDENCE: 283 checks passed (80.5 s); new tests: "a report with a DETAILED version…", "fl-report --detail hands the detailed report to the hub", "a replayed inbox report is not sent a second time"

- [x] G3: browser suite green — the settings page renders the new field and the run detail page shows the detail report
  CHECK: node test/browser.mjs
  EXPECT: browser suite passed
  EVIDENCE: 61 checks passed (20.0 s); proxy suite 4 checks passed

- [x] G4: docs agree — SETUP_WITH_AGENT.md mentions the public-host setting and the two-part report where the seams it describes were touched
  EVIDENCE: item 4 in "How it works" describes the two-file report; row in "Make it yours" points at Settings → Notification links and the FREILAUF_PUBLIC_URL fallback
