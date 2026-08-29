#!/usr/bin/env node
// Gate check for GATES.md G2: the report messages begin with the repo/run or
// repo/AGENT header. Runs against a throwaway database, like the unit suite.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sb = mkdtempSync(join(tmpdir(), 'cchub-msg-hdr-'))
process.env.CCHUB_DATA_DIR = join(sb, 'data')

try {
  const { default: db } = await import('../server/db.mjs')
  const repoId = db.prepare(`INSERT INTO repos (name, path) VALUES ('repoA', '/tmp/a')`).run().lastInsertRowid
  const agentId = db.prepare(`INSERT INTO agents (repo_id, name, harness, prompt, branch_mode, expected_minutes) VALUES (?, 'nightly', 'claude', 'p', 'neu', 45)`)
    .run(repoId).lastInsertRowid
  const { doneText } = await import('../server/reports.mjs')

  const base = { repo_id: repoId, harness: 'claude', model: 'sonnet', started_at: null,
    branch_reported: null, branch_expected: null, pr_url: null }

  const single = { ...base, id: 'r-single', agent_id: null, title: 'my task' }
  const d1 = doneText(single, 'the report', 'Merged into main: abc1234')
  if (!d1.startsWith('repoA / my task REPORT:\n\nthe report\n\n✅ Done · claude/sonnet · Merged into main: abc1234')) {
    throw new Error('single run: ' + JSON.stringify(d1))
  }

  const agent = { ...base, id: 'r-agent', agent_id: agentId, title: 'nightly' }
  const d2 = doneText(agent, 'agent report', null)
  if (!d2.startsWith('repoA / AGENT nightly REPORT:\n\nagent report\n\n✅ Done · claude/sonnet')) {
    throw new Error('agent run: ' + JSON.stringify(d2))
  }

  console.log('message-header gates OK')
} finally {
  rmSync(sb, { recursive: true, force: true })
}
