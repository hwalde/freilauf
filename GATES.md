# Gates: report messages begin with the repo/run or repo/AGENT header

OWNS: server/reports.mjs, GATES.md, PLAN.md

Scope: The Telegram messages that carry a run's report — `done`, `failed`,
`help` — begin with a header that names the repo and the reporting entity:
`<repo> / <run-title> REPORT:` for a single run, `<repo> / AGENT <agent-name>
REPORT:` for an agent run, followed by a blank line and the report body. The
status line (✅ Done / ❌ Run failed / 🆘 Help call + harness + duration +
branch + merge + incidents) follows the report instead of preceding it.

- [ ] G1: `doneText` begins with the header and the report for a single run,
      and the status line follows the report
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: pending

- [ ] G2: `doneText` names an agent run as `AGENT <agent-name>` and a single
      run by its title
  CHECK: node scripts/gates-msg-header.mjs
  EXPECT: message-header gates OK
  EVIDENCE: pending

- [ ] G3: the `failed` and `help` messages begin with the same header + body
      shape, the status marker moved after the body
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: pending

- [ ] G4: no message-text regression in the e2e suite
  CHECK: node test/e2e.mjs
  EXPECT: checks passed
  EVIDENCE: pending
