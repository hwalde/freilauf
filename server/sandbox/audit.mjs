// Freilauf — the per-run sandbox audit, and the one export an auditor is handed
// (SANDBOX_RESEARCH.md §7.14).
//
// A sandboxed run leaves four files in `~/agents/runs/<id>/` — `sandbox.json`
// (the spec as launched, digest included), `proxy.yaml` (the policy the egress
// proxy really ran on), `egress.jsonl` (one line per request the proxy saw) and
// `docker-events.jsonl` (the container's lifecycle) — plus its rows in the
// `events` table. Four files and a table are five places to look; this module
// turns them into ONE JSONL stream, in time order, with a hash chain over it.
//
// ---------------------------------------------------------------------------
// WHAT THE CHAIN PROVES, AND WHAT IT DOES NOT
//
// It proves that the exported COPY was not edited after it was written: every
// line carries the SHA-256 of (previous line's hash + this line's content), the
// first line names the run and the hub's own commit, and the last line names how
// many lines there are — so an edited line, an inserted line, a deleted line and
// a truncated tail all break the chain, and `verifyAuditChain()` says which.
//
// It does NOT prove that the hub wrote the truth. The hash is computed by the
// same process that produced the records, from files that process could have
// written differently; anyone with write access to the hub could produce a
// perfectly valid chain over invented lines. Nor is it a signature: there is no
// key here, so a determined editor who re-runs the chaining gets a valid file
// again — what the chain buys is that editing the copy is not free and not
// silent, which is the property an auditor asks for when a report is handed
// around by mail.
//
// **And it does not prove the INPUTS were not edited before the export.** Three
// of the four files below live in `~/agents/runs/<id>/`, which a sandboxed run
// has bind-mounted read-write at its own uid (§7.11) — so the agent under audit
// can truncate `egress.jsonl` before it reports, and the chain will hash-chain
// what is left into a file that verifies perfectly. The chain is evidence about
// the COPY, not about the collection. That is a real gap and it is named here,
// in the header record of every export (`inputs`) and on the run's page, rather
// than left for a reader to discover: the fix is to write these files somewhere
// the container cannot reach, which is a change to the mount list and to the
// three writers (see the note on AUDIT_AGENT_WRITABLE).
//
// Saying that plainly is worth more than a claim: a tamper-evidence promise the
// reader over-reads is worse than none, because they stop asking the question it
// does not answer.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, appendFileSync, mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import db from '../db.mjs'
import { RUNS_DIR, hubVersion } from '../util.mjs'

/**
 * The four files, in the order they are folded into the export. `kind` is what
 * a record from that file is called in the stream; `format` says how the file
 * is read — one JSON object per line, one JSON document, or plain text.
 */
export const AUDIT_FILES = [
  { name: 'sandbox.json', kind: 'spec', format: 'json' },
  { name: 'proxy.yaml', kind: 'proxy_config', format: 'text' },
  { name: 'egress.jsonl', kind: 'egress', format: 'jsonl' },
  { name: 'docker-events.jsonl', kind: 'docker_event', format: 'jsonl' },
]

/**
 * Every one of them resolves under `<RUNS_DIR>/<runId>/`, and `buildRunArgv()`
 * mounts exactly that directory read-write into the container at the agent's own
 * uid — so **the run under audit can write its own audit files**. Truncating
 * `egress.jsonl` before reporting leaves a shorter file that exports and
 * verifies without a complaint.
 *
 * The constant exists so the claim travels with the export rather than living in
 * a comment: `buildAuditChain()` puts it in the header record, and a reader who
 * only ever sees the `.jsonl` is told.
 *
 * **What would close it** (all of it outside this module, hence a note and not a
 * fix): give the audit its own directory — `<RUNS_DIR>/<runId>/audit/`, created
 * 0700 and NOT covered by the run-directory mount, or a path under the hub's
 * data directory entirely — and point the four writers at it. Three of them are
 * elsewhere: `writeSpecFile()` and the docker-events tail in `sandbox/index.mjs`,
 * the egress writers in `sandbox/proxy.mjs` and `sandbox/ironproxy.mjs` (the
 * latter also hands `proxy.yaml` to the proxy container, so that file has to stay
 * readable by it — a read-only mount of the one file, which is what it already
 * gets). `auditPaths()` is the single place this module would follow them.
 * Mounting a sub-path of a mounted directory needs the runtime's own mount list
 * to name it (`addMount` refuses a collision), which is why this is one change
 * across two owners and not four independent ones.
 */
export const AUDIT_AGENT_WRITABLE = true

/** Where a run's audit files live. A pure path answer — the directory need not exist. */
export function auditPaths(runId) {
  const dir = join(RUNS_DIR, String(runId))
  const out = { dir }
  for (const f of AUDIT_FILES) out[f.kind] = join(dir, f.name)
  return out
}

/**
 * Append one record to a run's JSONL audit file — the writing half of this
 * module, for whoever collects docker events or a proxy line outside the proxy
 * itself.
 *
 * Fail-soft in every direction: the audit is evidence, never a reason to take a
 * run down. A run directory that cannot be written costs the line, not the run.
 */
export function appendAuditFile(runId, name, record) {
  const file = join(RUNS_DIR, String(runId), name)
  try {
    mkdirSync(join(RUNS_DIR, String(runId)), { recursive: true })
    // `'a'` FOLLOWS a symlink, and this directory is bind-mounted rw into the
    // container at the agent's own uid (see AUDIT_AGENT_WRITABLE): a link left
    // at `egress.jsonl` would have the hub append to whatever it points at, as
    // the hub user. Refusing is right in both directions — the audit line is
    // lost, which is a fact `appendAuditFile()` already returns, and nothing is
    // written somewhere it does not belong. Same guard as `seedHomeFiles()`.
    try { if (lstatSync(file).isSymbolicLink()) return false } catch { /* not there yet: create it */ }
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Which hosts this run's proxy turned away, out of its own audit file.
 *
 * `action` is 'deny' for a policy in force and 'would_deny' for audit-only
 * (§7.12.5) — the same file answers both questions, which is the whole point of
 * audit-only: the rollout path is "watch what a real run reaches, then enforce
 * it", and the two readings must not come from two different sources or they
 * would eventually disagree.
 *
 * The events table carries `sandbox:blocked` for the same denials and is the
 * source the live channel hangs on; this one is the RECORD, and it survives a
 * database that was archived away. Both are offered because they answer at
 * different times: the event during the run, the file afterwards.
 */
export function blockedHosts(runId, { action = 'deny' } = {}) {
  const wanted = Array.isArray(action) ? action : [action]
  const byHost = new Map()
  const spec = AUDIT_FILES.find(f => f.kind === 'egress')
  for (const rec of readAuditFile(auditPaths(runId).egress, spec)) {
    const d = rec.data ?? {}
    if (!wanted.includes(d.action) || !d.host) continue
    const cur = byHost.get(d.host) ?? { host: d.host, count: 0, first: rec.at, last: rec.at, reason: null }
    cur.count += 1
    if (rec.at && (!cur.first || rec.at < cur.first)) cur.first = rec.at
    if (rec.at && (!cur.last || rec.at > cur.last)) cur.last = rec.at
    cur.reason = d.rejected_by ?? cur.reason
    byHost.set(d.host, cur)
  }
  return [...byHost.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
}

// ------------------------------------------------------------- the chain ----

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * Canonical JSON: keys sorted, so two runs of the exporter over the same record
 * hash the same. `JSON.stringify` preserves insertion order, and insertion order
 * is not a property anybody should have to reproduce to check a hash.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

/**
 * One link. `record` is the line's content WITHOUT the two chain fields; the
 * hash covers the previous hash and the canonical content, so re-ordering two
 * lines breaks both of them.
 */
export function chainLine(prevHash, record) {
  const body = { ...record, prev_hash: prevHash ?? null }
  const hash = sha(`${prevHash ?? ''}\n${canonical(record)}`)
  return { record: { ...body, hash }, hash }
}

/**
 * Read one audit file into records. A line that is not JSON is not dropped: it
 * is carried as `{ raw }`, because a broken line in an audit is itself a fact
 * and an exporter that swallows it is worse than one that shows it.
 */
function readAuditFile(path, spec) {
  if (!existsSync(path)) return []
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  if (spec.format === 'text') {
    return text.trim() === '' ? [] : [{ kind: spec.kind, at: null, data: { text } }]
  }
  if (spec.format === 'json') {
    try { return [{ kind: spec.kind, at: null, data: JSON.parse(text) }] }
    catch { return [{ kind: spec.kind, at: null, data: { raw: text } }] }
  }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let data
    try { data = JSON.parse(line) } catch { data = { raw: line } }
    out.push({ kind: spec.kind, at: typeof data?.at === 'string' ? data.at : null, data })
  }
  return out
}

/**
 * The run's own event rows — the hub's side of the story, next to the proxy's.
 *
 * The timestamp column is **`ts`** (db.mjs), and getting that wrong was not a
 * typo with a small blast radius: the query threw `no such column: created_at`,
 * the `catch` below swallowed it, and every export silently carried no events at
 * all — kinds `["audit_header", "egress", "audit_footer"]` for a run whose whole
 * story was in the table. The chain over that file verified perfectly, which is
 * the worst shape this can take: integrity green, content gone. `auditKinds()`
 * exists so a test can assert what is IN the export and not only that it hashes.
 *
 * The `catch` stays — an audit must not fail a page over a database hiccup — but
 * it is now the only thing between a schema change and an empty export, so the
 * suite asserts the events are there.
 */
function eventRecords(runId) {
  let rows = []
  try {
    rows = db.prepare('SELECT id, kind, payload, ts FROM events WHERE run_id=? ORDER BY id').all(String(runId))
  } catch { return [] }
  return rows.map(r => {
    let payload = null
    if (r.payload) { try { payload = JSON.parse(r.payload) } catch { payload = { raw: r.payload } } }
    // The events table stores 'YYYY-MM-DD HH:MM:SS' in UTC; the export speaks
    // ISO 8601 throughout, so a reader can sort the whole file by one field.
    const at = r.ts ? `${String(r.ts).replace(' ', 'T')}Z` : null
    return { kind: 'event', at, data: { id: r.id, kind: r.kind, payload } }
  })
}

/**
 * Which record kinds an export actually carries, in order. The one question the
 * hash chain cannot answer — a two-line file of nothing but a header and a
 * footer verifies exactly as well as a complete one — and therefore the question
 * the suite has to ask separately.
 */
export function auditKinds(runId) {
  return buildAuditChain(runId).map(line => { try { return JSON.parse(line).kind } catch { return 'unparsable' } })
}

/**
 * Everything about one run, in one order.
 *
 * The spec and the proxy configuration come first — they are the policy the
 * rest of the file has to be read against, and neither carries a time of its
 * own. Everything that does is sorted by it, stably, so two records of the same
 * millisecond keep the order their source had. A record with no time sorts
 * where it stands rather than to the front: an audit is read top to bottom.
 */
export function auditRecords(runId) {
  const paths = auditPaths(runId)
  const head = []
  const timed = []
  for (const spec of AUDIT_FILES) {
    const recs = readAuditFile(paths[spec.kind], spec)
    for (const r of recs) (r.at ? timed : head).push(r)
  }
  for (const r of eventRecords(runId)) (r.at ? timed : head).push(r)
  timed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return [...head, ...timed]
}

/**
 * The export as an array of JSONL lines (without the trailing newlines).
 *
 * The header names the run and the hub's own sha, because "which code produced
 * this" is the first question anybody reading an audit asks. The footer names
 * the line count, and that is what makes a TRUNCATED file detectable at all: a
 * chain whose last lines were simply cut off is internally consistent right up
 * to the cut.
 */
export function buildAuditChain(runId, opts = {}) {
  const run = opts.run ?? (() => {
    try { return db.prepare('SELECT id, repo_id, harness, sandbox, sandbox_container, status FROM runs WHERE id=?').get(String(runId)) }
    catch { return null }
  })()
  const generatedAt = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString()
  const records = auditRecords(runId)

  const lines = []
  let prev = null
  let seq = 0
  const push = (record) => {
    const link = chainLine(prev, { seq: seq++, ...record })
    prev = link.hash
    lines.push(JSON.stringify(link.record))
  }

  push({
    kind: 'audit_header',
    at: generatedAt,
    run: String(runId),
    hub_sha: hubVersion() || null,
    sandbox: run ? (run.sandbox ? 1 : 0) : null,
    container: run?.sandbox_container ?? null,
    harness: run?.harness ?? null,
    status: run?.status ?? null,
    // Said in the file itself, so a copy that travels without this repository
    // still carries the limit of what it proves.
    note: 'Hash-chained export. Proves this copy was not edited after export; does not prove the hub recorded the truth.',
    // …and the limit that is about the COLLECTION rather than the copy. A
    // reader who is handed only this file has no other way to learn it.
    inputs: {
      dir: auditPaths(runId).dir,
      agent_writable: AUDIT_AGENT_WRITABLE && (run ? !!run.sandbox : null),
      note: AUDIT_AGENT_WRITABLE
        ? 'The audit files live in the run directory, which a sandboxed run has mounted read-write: the run under audit could have shortened them before this export. The chain covers the copy, not the collection.'
        : null,
    },
  })
  for (const r of records) push({ kind: r.kind, at: r.at, data: r.data })
  // +1 for the footer itself: `lines` is the number of lines in the finished file.
  push({ kind: 'audit_footer', at: generatedAt, lines: lines.length + 1 })
  return lines
}

/**
 * Check a chain the way somebody who was handed the file would.
 *
 * Returns `{ ok, lines, problems }`; `problems` are English strings and not
 * i18n keys, because this answers a machine (the test, an auditor's script)
 * rather than a page. The four ways a copy can be wrong each get their own
 * message, so "it does not verify" is never the whole answer.
 *
 * **`ok: true` means exactly one thing: the bytes of this file are the bytes
 * that were exported.** It is not a statement about completeness. A file that
 * never contained a record cannot be told from one that always should have — an
 * export whose events query silently returned nothing verified perfectly for as
 * long as that bug existed, and an export of files the audited run had truncated
 * first (AUDIT_AGENT_WRITABLE) verifies too. Whoever reads `ok` has to read the
 * header record's `inputs` block next to it; whoever tests this module has to
 * assert on `auditKinds()` as well, because a two-line chain of header + footer
 * is a perfectly valid chain.
 */
export function verifyAuditChain(input) {
  const lines = Array.isArray(input)
    ? input
    : String(input ?? '').split('\n').filter(l => l.trim() !== '')
  const problems = []
  if (!lines.length) return { ok: false, lines: 0, problems: ['empty: an audit export has at least a header and a footer'] }

  let prev = null
  const parsed = []
  for (const [i, line] of lines.entries()) {
    let obj
    try { obj = JSON.parse(line) } catch {
      problems.push(`line ${i + 1}: not JSON`)
      return { ok: false, lines: lines.length, problems }
    }
    parsed.push(obj)
    const { hash, prev_hash: prevHash, ...content } = obj
    if (content.seq !== i) problems.push(`line ${i + 1}: seq is ${content.seq}, expected ${i} — a line was inserted or removed`)
    if ((prevHash ?? null) !== prev) problems.push(`line ${i + 1}: prev_hash does not match the line before it`)
    const expected = sha(`${prev ?? ''}\n${canonical(content)}`)
    if (hash !== expected) problems.push(`line ${i + 1}: content does not match its hash — the line was edited`)
    prev = hash
  }

  const first = parsed[0]
  if (first?.kind !== 'audit_header') problems.push('the first line is not the header')
  const last = parsed.at(-1)
  if (last?.kind !== 'audit_footer') {
    problems.push('the last line is not the footer — the end of the file is missing')
  } else if (last.lines !== lines.length) {
    problems.push(`the footer names ${last.lines} lines, the file has ${lines.length} — lines were removed or added`)
  }
  return { ok: problems.length === 0, lines: lines.length, problems }
}

/**
 * Stream the export onto an HTTP response.
 *
 * Written line by line rather than joined: `egress.jsonl` of a long run is the
 * one file here that can be large, and a response assembled in one string is a
 * copy of it in the hub's memory for no reason.
 */
export function streamAuditChain(runId, res, opts = {}) {
  const lines = buildAuditChain(runId, opts)
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-disposition': `attachment; filename="freilauf-audit-${String(runId)}.jsonl"`,
    'cache-control': 'no-store',
  })
  for (const line of lines) res.write(`${line}\n`)
  res.end()
  return lines.length
}
