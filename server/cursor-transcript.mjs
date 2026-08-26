// cc-hub — cursor's transcript: the channel that works without a hook.
//
// cursor writes every conversation as JSONL to
//   <data dir>/projects/<slug>/agent-transcripts/<session id>/<session id>.jsonl
// and appends to it WHILE the agent works (measured: the file grew from 325 to
// 1302 bytes across three tool calls, mtime advancing each time). That makes it
// two things the hub had for claude and opencode but not for cursor:
//
//   activity   the file's mtime — without it measureActivity() returned nothing
//              for cursor, and the traffic light's "no activity for 15 min" plus
//              the incident detector's work-after-the-hit veto were blind on
//              this harness.
//   the end    the last line of a finished turn is {"type":"turn_ended",...}.
//              This is the SECOND channel next to the stop hook: a repository
//              that brings its own .cursor/hooks.json keeps the hub from
//              installing one, and then this is the only one left.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const DATA_DIR = () => process.env.CCHUB_CURSOR_DIR ?? process.env.CURSOR_DATA_DIR ?? `${homedir()}/.cursor`

/**
 * cursor's own slug rule, read from the binary (2026.08.11-e8db854): every
 * character that is not a letter or a digit becomes '-', runs of '-' collapse,
 * the ends are trimmed. The transcripts use the plain form; a second function in
 * the binary shortens a path longer than 92 characters to 84 plus 7 hex
 * characters of its own sha256 — that one writes elsewhere, but the variant is
 * returned as a fallback so a rename inside cursor does not blind the hub
 * silently.
 */
export function projectDirs(workdir) {
  const slug = String(workdir ?? '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) return []
  const full = join(DATA_DIR(), 'projects', slug)
  if (full.length <= 92) return [full]
  return [full, `${full.slice(0, 84)}-${createHash('sha256').update(full).digest('hex').slice(0, 7)}`]
}

/**
 * The transcript OF THIS RUN. A worktree can hold several cursor sessions over
 * time (a retry, an operator attaching by hand), so "the newest file" alone is
 * not an answer: only one that was written at or after the run's start can
 * belong to it. Nothing matching means "not found" — never a foreign session's
 * transcript.
 */
export function transcriptPath(run) {
  if (!run?.workdir_effective || run.harness !== 'cursor') return null
  const startMs = run.started_at ? Date.parse(run.started_at.replace(' ', 'T') + 'Z') - 60_000 : 0
  let best = null
  for (const dir of projectDirs(run.workdir_effective)) {
    const base = join(dir, 'agent-transcripts')
    if (!existsSync(base)) continue
    let ids = []
    try { ids = readdirSync(base) } catch { continue }
    for (const id of ids) {
      const path = join(base, id, `${id}.jsonl`)
      let st
      try { st = statSync(path) } catch { continue }
      if (!Number.isFinite(startMs) || st.mtimeMs < startMs) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { path, mtimeMs: st.mtimeMs }
    }
  }
  return best?.path ?? null
}

/**
 * Read the state out of the JSONL text. Split from the file access on purpose:
 * this half is decidable with fixed input and therefore testable.
 *
 *   turnEnded    the status of a 'turn_ended' record, but ONLY while it is the
 *                last record in the file. A follow-up (the operator typing into
 *                the terminal, the flows' "message a running agent" step) writes
 *                further records after it, and then the turn that ended is
 *                history, not the end of the run.
 *   lastAnswer   the last text an assistant message carried — the agent's own
 *                closing summary, and hence the best report text available for a
 *                run that never called cc-report.
 */
export function stateFromJsonl(text) {
  let turnEnded = null
  let lastAnswer = null
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }   // half a line — next pass
    if (j?.type === 'turn_ended') { turnEnded = String(j.status ?? 'success'); continue }
    turnEnded = null
    if (j?.role !== 'assistant') continue
    const content = j?.message?.content
    if (!Array.isArray(content)) continue
    const texts = content.filter(x => x?.type === 'text' && String(x.text ?? '').trim())
      .map(x => String(x.text).trim())
    if (texts.length) lastAnswer = texts[texts.length - 1]
  }
  return { turnEnded, lastAnswer }
}

/** File version of stateFromJsonl, plus the mtime as the activity timestamp. */
export function transcriptState(run) {
  const path = transcriptPath(run)
  if (!path) return null
  try {
    const st = statSync(path)
    return { path, mtimeMs: st.mtimeMs, ...stateFromJsonl(readFileSync(path, 'utf8')) }
  } catch { return null }
}
