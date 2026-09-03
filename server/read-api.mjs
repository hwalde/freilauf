// Freilauf — the read-only JSON API.
//
// Everything the hub does was already reachable from a script: the forms take
// urlencoded bodies and `answer()` hands a caller with `accept: application/json`
// a JSON answer instead of a redirect. What was NOT reachable was *looking*:
// there was no way to ask "which runs are there", "which agents", "which
// repos", "which favorites" without parsing a rendered page.
//
// That is what this module is for, and the reason it exists at all is the
// skills this repository ships (`skills/`, see server/skills.mjs): a coding
// agent that is told to find a run, read its errors and check whether the
// agent behind it is still alive must not be told to scrape HTML. Screen
// scraping is how a skill goes stale the first time a column moves.
//
// Three rules:
//
//   - **Read only.** Nothing here writes. Every change still goes through the
//     existing POST routes, which validate — a second write path is a second
//     set of rules to keep in step, and run-def.mjs exists precisely so there
//     is only one.
//   - **The row as it is stored**, plus what cannot be read from the row: the
//     tmux verdict, the file paths, the events, the incidents. No formatting,
//     no translation — a JSON consumer wants `status: "waiting_help"`, not
//     "waiting for an answer".
//   - **Bounded.** Every list takes a limit and enforces a ceiling, because a
//     hub that has been running for a year holds thousands of runs and an
//     unbounded answer is one nobody can read.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import db, { getRun, getRepo } from './db.mjs'
import { RUNS_DIR, WORKTREES_DIR, kurzid } from './util.mjs'
import { alleVorfaelle } from './incidents.mjs'
import { listFavorites, FAVORITES_MAX, favoriteSummary } from './favorites.mjs'
import { listSessions, sessionMemory, paneAlive } from './sessions.mjs'
import { harnessLabel } from './harnesses/index.mjs'
import {
  availableSkills, harnessSkillRoots, skillTargets, installedOverview,
  skillsInstallOn, skillsAutoUpdate,
} from './skills.mjs'
import { t } from './i18n.mjs'

const LIMIT_MAX = 200
const LIMIT_DEFAULT = 50

function limitOf(url) {
  const n = Number(url.searchParams.get('limit'))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), LIMIT_MAX) : LIMIT_DEFAULT
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(body)
}

/** The columns a run list carries — the whole row would be a page of JSON per run. */
const RUN_LIST_COLUMNS = `r.id, r.title, r.status, r.repo_id, r.agent_id, r.harness, r.model, r.provider,
  r.effort, r.branch_expected, r.branch_reported, r.pr_url, r.started_at, r.ended_at, r.expected_minutes,
  r.finish_state, r.merge_status, r.merged_sha, r.archived_at, r.followup_since, r.followups,
  r.start_mode, r.start_at, r.tmux_session, r.workdir_effective, r.exit_code, r.cost_eur, r.cost_usd,
  r.tokens_in, r.tokens_out, r.last_activity_at, r.resolves_run_id`

/**
 * Where a run's files are. Answered even when they do not exist yet, with a
 * flag — "the report is not written" is the answer to a question a caller is
 * really asking, and a missing key would make them guess the path themselves.
 */
function runFiles(run) {
  const dir = join(RUNS_DIR, run.id)
  const one = (name) => { const p = join(dir, name); return { path: p, exists: existsSync(p) } }
  return {
    dir,
    prompt: one('prompt.md'),
    report: one('report.md'),
    report_detail: one('report-detail.md'),
    log: one('log.txt'),
    detector: one('detektor.jsonl'),
    inbox: one('inbox.jsonl'),
  }
}

/**
 * The one question a run's page cannot answer on its own: is the coding agent
 * still there? Four independent signals, each with what it means — because
 * `status: "done"` says the run reported, not that the process is gone, and
 * three of the four coding agents deliberately stay in their TUI afterwards.
 */
async function livenessOf(run) {
  const session = run.tmux_session ?? null
  const alive = session ? await paneAlive(session) : null
  return {
    tmux_session: session,
    // true / false / null — null means tmux could not be asked, which is NOT
    // the same as "gone" (see AGENTS.md, "tmux did not answer").
    pane_alive: alive,
    status: run.status,
    finish_state: run.finish_state ?? null,
    followup_open: run.followup_open ? 1 : 0,
    followup_since: run.followup_since ?? null,
    last_activity_at: run.last_activity_at ?? null,
    // The sentence a caller should act on rather than deriving it themselves.
    verdict: alive === null && session ? 'unknown'
      : alive ? (['running', 'waiting_help'].includes(run.status) ? 'working' : 'idle_in_tui')
        : session ? 'process_gone' : 'no_session',
  }
}

/** The worktree the run works in — read back from the run row, not guessed. */
function worktreeOf(run) {
  const repo = run.repo_id ? getRepo(run.repo_id) : null
  const dir = run.workdir_effective ?? null
  return { path: dir, exists: dir ? existsSync(dir) : false, root: repo ? join(WORKTREES_DIR, repo.name) : null }
}

/**
 * `GET /api/…` for everything that only reads. Returns `true` when it answered.
 * Anything it does not know is left to the caller's own 404, so a new route
 * added here never shadows one that already exists.
 */
export async function readApi(req, res, url) {
  if (req.method !== 'GET') return false
  const path = url.pathname
  let m

  // ---- repos -------------------------------------------------------------
  if (path === '/api/repos') {
    // Every repo by default, each carrying its `active` flag — a read API shows
    // what is there. `active=1` / `active=0` narrows it; the UI's dropdowns show
    // only the active ones, so a repo missing from a form while this route
    // still lists it is an inactive repo rather than a bug.
    const want = url.searchParams.get('active')
    const where = want === '1' ? ' WHERE active=1' : want === '0' ? ' WHERE active=0' : ''
    const repos = db.prepare(`SELECT * FROM repos${where} ORDER BY name`).all()
      .map(r => ({ ...r, extras: JSON.parse(r.worktree_extras || '[]') }))
    json(res, 200, { ok: true, repos })
    return true
  }

  // ---- agents ------------------------------------------------------------
  if (path === '/api/agents') {
    const repo = url.searchParams.get('repo')
    const rows = repo
      ? db.prepare('SELECT * FROM agents WHERE repo_id=? ORDER BY name').all(Number(repo))
      : db.prepare('SELECT * FROM agents ORDER BY repo_id, name').all()
    const repos = new Map(db.prepare('SELECT id, name FROM repos').all().map(r => [r.id, r.name]))
    json(res, 200, {
      ok: true,
      agents: rows.map(a => ({
        ...a,
        repo_name: repos.get(a.repo_id) ?? null,
        harness_label: harnessLabel(a.harness),
        skills: JSON.parse(a.skills || 'null'),
        flows: JSON.parse(a.flows || 'null'),
      })),
    })
    return true
  }

  // ---- favorites ---------------------------------------------------------
  if (path === '/api/favorites') {
    json(res, 200, {
      ok: true,
      max: FAVORITES_MAX,
      favorites: listFavorites().map(f => ({ ...f, summary: favoriteSummary(f) })),
    })
    return true
  }

  // ---- the run list, and finding one -------------------------------------
  // `q` searches title, prompt and id — the three things somebody actually
  // remembers about a run they are looking for.
  if (path === '/api/runs') {
    const repo = url.searchParams.get('repo')
    const status = url.searchParams.get('status')
    const agent = url.searchParams.get('agent')
    const q = (url.searchParams.get('q') ?? '').trim()
    const archived = url.searchParams.get('archived')     // '1' = only archived, 'all' = both
    const where = []
    const args = []
    if (repo) { where.push('r.repo_id = ?'); args.push(Number(repo)) }
    if (status) { where.push('r.status = ?'); args.push(status) }
    if (agent) { where.push('r.agent_id = ?'); args.push(Number(agent)) }
    if (archived === '1') where.push('r.archived_at IS NOT NULL')
    else if (archived !== 'all') where.push('r.archived_at IS NULL')
    if (q) {
      where.push('(r.title LIKE ? OR r.prompt LIKE ? OR r.id LIKE ?)')
      args.push(`%${q}%`, `%${q}%`, `${q}%`)
    }
    const sql = `SELECT ${RUN_LIST_COLUMNS}, a.name AS agent_name, p.name AS repo_name
      FROM runs r LEFT JOIN agents a ON a.id = r.agent_id LEFT JOIN repos p ON p.id = r.repo_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(r.started_at, r.start_at) DESC LIMIT ?`
    const runs = db.prepare(sql).all(...args, limitOf(url))
      .map(r => ({ ...r, short_id: kurzid(r.id) }))
    json(res, 200, { ok: true, count: runs.length, limit: limitOf(url), runs })
    return true
  }

  // ---- one run, in full --------------------------------------------------
  if ((m = path.match(/^\/api\/runs\/([0-9a-f-]{36})$/))) {
    const run = getRun(m[1])
    if (!run) { json(res, 404, { ok: false, error: t('api.unknown_run') }); return true }
    const events = db.prepare('SELECT id, ts, kind, payload FROM events WHERE run_id=? ORDER BY id').all(run.id)
      .map(ev => ({ ...ev, payload: ev.payload ? JSON.parse(ev.payload) : null }))
    const agent = run.agent_id ? db.prepare('SELECT id, name FROM agents WHERE id=?').get(run.agent_id) : null
    const repo = run.repo_id ? getRepo(run.repo_id) : null
    json(res, 200, {
      ok: true,
      run: { ...run, short_id: kurzid(run.id), harness_label: harnessLabel(run.harness) },
      agent: agent ?? null,
      repo: repo ? { id: repo.id, name: repo.name, path: repo.path, base_branch: repo.base_branch, merge_mode: repo.merge_mode } : null,
      liveness: await livenessOf(run),
      worktree: worktreeOf(run),
      files: runFiles(run),
      events,
      incidents: alleVorfaelle(run.id),
    })
    return true
  }

  // ---- tmux sessions -----------------------------------------------------
  // Three subprocesses per call (tmux ×2 and one ps), so it is not something to
  // poll — but it is the only way to see what the MACHINE holds, foreign
  // sessions included.
  if (path === '/api/sessions') {
    const sessions = await listSessions()
    let memory = null
    try { memory = await sessionMemory() } catch { memory = null }
    json(res, 200, { ok: true, memory, sessions })
    return true
  }

  // ---- the hub's own skills ----------------------------------------------
  if (path === '/api/skills') {
    const roots = harnessSkillRoots()
    const { targets, skipped } = skillTargets(roots)
    json(res, 200, {
      ok: true,
      install: skillsInstallOn(),
      auto_update: skillsAutoUpdate(),
      skills: availableSkills().map(s => ({ name: s.name, title: s.title, description: s.description, hash: s.hash })),
      harnesses: roots,
      targets,
      skipped,
      installed: installedOverview(),
    })
    return true
  }

  return false
}
