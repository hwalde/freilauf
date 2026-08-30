// cc-hub — running a coding agent's CLI as a one-shot model source.
//
// A coding agent can answer the hub's own small questions (a run title, whether
// a log line is a real outage, what a report contains) on the subscription the
// operator already pays for. It is slower and dearer than a model provider —
// a whole session is started for one question — which is why every harness that
// offers it declares `llm.overhead: true` and the UI says so. But it is the one
// way to try the hub out with nothing configured but a coding agent.
//
// The four CLIs disagree about almost everything: which stream carries an
// error, whether the answer is an envelope or plain text, whether a schema can
// be handed over at all. What they DO share is the spawning — and that half is
// here, once, because every one of its three rules was learned the hard way:
//
//   1. **stdin is always redirected.** claude burns a fixed three seconds
//      waiting on a terminal that never speaks; opencode wants /dev/null.
//   2. **there is always a wall-clock timeout, with a SIGKILL behind it.** A
//      TUI that decides to draw instead of exiting would otherwise hold the
//      hub's own question open forever.
//   3. **stdout and stderr are captured separately.** cursor reports its
//      failures on stderr, opencode writes dozens of harmless "unknown format
//      uint64" lines there every single run. Merging the two would make one
//      CLI's noise look like another's error.
//
// Nothing in this file imports the database or the registry: it is used from
// plugin files, and a plugin file must stay importable on its own.
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How long a killed process gets to die politely before SIGKILL. */
const KILL_GRACE_MS = 2_000

/**
 * Run a command to completion.
 *
 * Returns `{ code, signal, stdout, stderr, timedOut, spawnError }` — never
 * throws for a process that merely failed. A binary that is not installed comes
 * back as `spawnError`, which is a normal answer here (the operator may not
 * have that coding agent).
 */
export function runCli(bin, args, { stdin = null, timeoutMs = 120_000, env = process.env, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      // `detached` puts the CLI in a process group of its own, which is what
      // makes the timeout below able to end the whole thing. A coding agent
      // starts helpers, and killing only the process we spawned leaves them
      // holding our stdout pipe — measured: `sh -c "sleep 30"` with a one
      // second timeout returned after thirty, because the timer killed the
      // shell and the sleep it had forked kept the pipe open.
      child = spawn(bin, args, { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: err.message })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let hardKill = null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    // Rule 1: the child never inherits a terminal. Whatever the prompt is, it
    // goes in here and the pipe is closed immediately afterwards, so a CLI
    // reading "until EOF" gets its EOF.
    try {
      if (stdin !== null && stdin !== undefined) child.stdin.end(String(stdin))
      else child.stdin.end()
    } catch { /* a child that died before we could write is reported by 'close' */ }

    // The whole group, so a helper the CLI forked goes with it.
    const signal = (sig) => {
      try { process.kill(-child.pid, sig) } catch {
        try { child.kill(sig) } catch { /* already gone */ }
      }
    }

    let settled = false
    const done = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (hardKill) clearTimeout(hardKill)
      resolve({ code: null, signal: null, stdout, stderr, timedOut, spawnError: null, ...extra })
    }

    // Rule 2: a wall clock, and a SIGKILL behind the polite signal. After the
    // grace period this ANSWERS — it does not wait for 'close', because 'close'
    // waits for every inherited pipe and a stuck grandchild would hold the
    // hub's own question open for as long as it liked.
    const timer = setTimeout(() => {
      timedOut = true
      signal('SIGTERM')
      hardKill = setTimeout(() => { signal('SIGKILL'); done({ code: null }) }, KILL_GRACE_MS)
    }, Math.max(1_000, Number(timeoutMs) || 120_000))

    child.on('error', (err) => done({ spawnError: err.message }))
    child.on('close', (code, sig) => done({ code, signal: sig }))
  })
}

/**
 * The shape every CLI adapter fails with, so the caller can tell a timeout
 * ("the coding agent is still thinking") from a missing binary ("it is not
 * installed") from the CLI's own complaint.
 */
export function cliFailure(bin, r, message = null) {
  if (r.spawnError) return new Error(`${bin}: ${r.spawnError}`)
  if (r.timedOut) return new Error(`${bin}: timed out`)
  const detail = message || String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400)
  return new Error(`${bin}: exit ${r.code}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Every JSON object on its own line, tolerantly.
 *
 * opencode streams NDJSON and prefixes nothing; a line that is not JSON (a
 * warning, a blank) is simply not an event and is skipped rather than turned
 * into a parse error for the whole answer.
 */
export function ndjson(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    if (!s || (s[0] !== '{' && s[0] !== '[')) continue
    try { out.push(JSON.parse(s)) } catch { /* not an event line */ }
  }
  return out
}

/**
 * The lines a listing command prints — through a FILE, never through a pipe.
 *
 * `opencode models --pure` prints 568 lines and loses chunks at process exit
 * when node reads them through a pipe (measured: 168, 244, 260, 307 instead of
 * 360 OpenRouter models, with perfectly stable output in a shell). A silently
 * halved catalog is worse than none. models.mjs uses the same detour for the
 * form's model list; it is repeated here because a plugin file may not import
 * models.mjs — that module reaches the registry, which imports the plugin files.
 */
export async function cliLines(command, { timeoutMs = 120_000 } = {}) {
  const file = join(tmpdir(), `cc-hub-cli-${process.pid}-${Date.now()}.txt`)
  try {
    const r = await runCli('sh', ['-c', `${command} > ${JSON.stringify(file)}`], { timeoutMs })
    if (r.spawnError || r.timedOut || r.code !== 0) return []
    return readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  } catch {
    return []
  } finally {
    try { rmSync(file, { force: true }) } catch { /* cleanup is best-effort */ }
  }
}
