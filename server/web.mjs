// cc-hub — HTTP: server-rendered HTML + JSON API (planning 5).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import db, { getRepo, getRun, setSetting } from './db.mjs'
import { handleReport } from './reports.mjs'
import { modelList, orEndpoints, standVon, effortOptionen } from './models.mjs'
import { providersForHarness, listCodingAgents } from './coding-agents.mjs'
import { detectInstalled } from './harnesses/index.mjs'
import { subscriptionUsage } from './usage.mjs'
import { openrouterCredits } from './quota.mjs'
import { launchRun } from './runner.mjs'
import { startRun } from './scheduler.mjs'
import { runDefFromForm, runStartFromForm, saveAgent, rememberRunChoice, lastRunChoiceFor } from './run-def.mjs'
import { runTitle, TITLE_MAX } from './title.mjs'
import {
  pageOverview, pageAgents, pageRunForm, pageRun, pageRepos, pageSettings, pageSessions,
  pageArchive,
  runNewPost, agentEdit, agentSave, agentToggle, agentStart,
  agentDelete, agentMovePage, agentMovePost,
  repoEdit, repoSave, settingsSave, settingsTestTelegram,
  telegramSetup, telegramTokenSave, telegramChatSave, telegramChats,
  pageCodingAgents, codingAgentSave, codingAgentDelete,
  pageFavorites, favoriteEdit, favoriteSave, favoriteDelete,
} from './pages.mjs'
import { getFavorite, favoriteToFormBody } from './favorites.mjs'
import { redirect, body as readBody, parseForm } from './web-helpers.mjs'
import { vorfallLoesen, vorfaelleLoesen, vorfall } from './incidents.mjs'
import { t } from './i18n.mjs'
import { flowRoute, flowApi } from './flows/web.mjs'
import { flowsTick } from './flows/triggers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------- helpers ----------------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
}

/** urlencoded POST body as a flat object (JSON API and forms share this). */
async function form(req) {
  return parseForm(await readBody(req))
}

/**
 * Some API endpoints are BOTH: fetched from browser JS and the target of a
 * classic <form method="post">. In the second case the user would land on a
 * bare JSON page. A browser navigation request is recognizable by
 * 'Accept: text/html' — then better redirect back to the page.
 */
function wantsHtml(req) {
  return (req.headers.accept ?? '').includes('text/html')
}
/**
 * What a Quick Run may say for itself: the task, the branch rule, the repo — the
 * three things a favorite deliberately does not carry. An allowlist and not a
 * spread, so a request cannot quietly replace the favorite's coding agent, model
 * or skills and start something else than the name on the button promised.
 * The duration is not asked for and takes the default.
 */
function pickQuickFields(b) {
  return {
    repo_id: b.repo_id,
    prompt: b.prompt,
    branch_mode: b.branch_mode,
    branch_pattern: b.branch_pattern,
  }
}

function answer(req, res, code, obj, backTo) {
  if (backTo && wantsHtml(req)) return redirect(res, backTo)
  return json(res, code, obj)
}

// ---------------- router ----------------
export async function route(req, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const formBody = async () => parseForm(await readBody(req))
  try { await dispatch(req, res, url, path, formBody) }
  catch (e) {
    console.error('[http]', e)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('internal error: ' + e.message)
  }
}

async function dispatch(req, res, url, path, formBody) {
  // --- static (xterm.js from node_modules) ---
  if (req.method === 'GET' && path.startsWith('/static/')) return serveStatic(res, path)

  // --- JSON API ---
  if (path.startsWith('/api/')) return api(req, res, url)

  // --- Telegram setup assistant ---
  if (req.method === 'GET' && path === '/telegram-setup') return telegramSetup(req, res, url)
  if (req.method === 'POST' && path === '/telegram-setup/token') return telegramTokenSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/telegram-setup/chat') return telegramChatSave(req, res, url, formBody)

  // --- pages ---
  if (req.method === 'GET' && path === '/') return pageOverview(req, res, url)
  if (req.method === 'GET' && path === '/archive') return pageArchive(req, res, url)
  if (req.method === 'GET' && path === '/agents') return pageAgents(req, res, url)
  if (req.method === 'GET' && path === '/agents/edit') return agentEdit(req, res, url)
  if (req.method === 'POST' && path === '/agents/edit') return agentSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/toggle') return agentToggle(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/start') return agentStart(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/delete') return agentDelete(req, res, url, formBody)
  if (req.method === 'GET' && path === '/agents/move') return agentMovePage(req, res, url)
  if (req.method === 'POST' && path === '/agents/move') return agentMovePost(req, res, url, formBody)
  if (req.method === 'GET' && path === '/runs/new') return pageRunForm(req, res, url)
  if (req.method === 'POST' && path === '/runs/new') return runNewPost(req, res, url, formBody)
  if (/^\/runs\/[0-9a-f-]{36}$/.test(path)) return pageRun(req, res, url, path.split('/')[2])
  if (req.method === 'GET' && path === '/sessions') return pageSessions(req, res, url)
  if (req.method === 'GET' && path === '/repos') return pageRepos(req, res, url)
  if (req.method === 'GET' && path === '/repos/edit') return repoEdit(req, res, url)
  if (req.method === 'POST' && path === '/repos/edit') return repoSave(req, res, url, formBody)
  if (req.method === 'GET' && path === '/settings') return pageSettings(req, res, url)
  if (req.method === 'POST' && path === '/settings/save') return settingsSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/test-telegram') return settingsTestTelegram(req, res)
  // Coding agents (Settings → Coding agents)
  if (req.method === 'GET' && path === '/settings/coding-agents') return pageCodingAgents(req, res, url)
  if (req.method === 'POST' && path === '/settings/coding-agents/save') return codingAgentSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/coding-agents/delete') return codingAgentDelete(req, res, url, formBody)
  // Favorites (Settings → Favorites) — the saved setup a Quick Run starts from.
  if (req.method === 'GET' && path === '/settings/favorites') return pageFavorites(req, res, url)
  if (req.method === 'GET' && path === '/settings/favorites/edit') return favoriteEdit(req, res, url)
  if (req.method === 'POST' && path === '/settings/favorites/edit') return favoriteSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/favorites/delete') return favoriteDelete(req, res, url, formBody)
  // No-code flows (server/flows/) — own router, own pages.
  if (path === '/flows' || path.startsWith('/flows/')) return flowRoute(req, res, url, formBody)
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end(t('web.not_found'))
}

// ---------------- API ----------------
async function api(req, res, url) {
  const path = url.pathname
  let m
  if (req.method === 'GET' && path === '/api/telegram/chats') return telegramChats(req, res)
  if (path.startsWith('/api/flows') || path.startsWith('/api/flow-runs')) return flowApi(req, res, url)

  // Which providers the chosen harness can use — plugin capability, restricted
  // to the operator's per-coding-agent selection and available credentials.
  if (req.method === 'GET' && path === '/api/providers') {
    const harness = url.searchParams.get('harness') ?? ''
    const provider = providersForHarness(harness)
      .map(p => ({ id: p.id, label: p.label, ...(p.hinweisKey ? { hinweis: t(p.hinweisKey) } : {}) }))
    const agents = listCodingAgents()
    const subscription = !!agents.find(a => a.harness === harness)?.plugin?.subscription
    return json(res, 200, { ok: true, harness, subscription, provider })
  }

  // What this coding agent was last run with. The form asks for it when the
  // coding agent is SWITCHED: provider, model and effort of the previous one are
  // not merely unhelpful there, they are incompatible (an opencode slug is
  // nothing claude runs), so they are replaced instead of left standing.
  if (req.method === 'GET' && path === '/api/run-choice') {
    const harness = url.searchParams.get('harness') ?? ''
    const c = lastRunChoiceFor(harness)
    return json(res, 200, {
      ok: true,
      harness,
      choice: {
        provider: c.provider ?? '',
        model: c.model ?? '',
        or_provider: c.or_provider ?? '',
        effort: c.effort ?? '',
      },
    })
  }

  // Configured coding agents + which plugins are installed on this machine
  // (feeds the "add coding agent" dialog).
  if (req.method === 'GET' && path === '/api/coding-agents/detect') {
    const detected = await detectInstalled()
    const configured = new Set(listCodingAgents().map(a => a.harness))
    return json(res, 200, {
      ok: true,
      agents: detected.map(d => ({ ...d, configured: configured.has(d.id) })),
    })
  }

  // Subscription usage (Claude Code, Cursor) + OpenRouter credits.
  if (req.method === 'GET' && path === '/api/usage') {
    const usage = await subscriptionUsage()
    const openrouter = await openrouterCredits()
    return json(res, 200, { ok: true, usage, openrouter })
  }

  // Model lists of the providers. ALWAYS answers 200 with ok:false on error —
  // the form must not have to catch anything and stays usable without a list.
  if (req.method === 'GET' && path === '/api/models') {
    const provider = url.searchParams.get('provider') ?? ''
    // The harness has a say: opencode only accepts what it knows itself.
    const r = await modelList(provider, url.searchParams.get('harness'))
    return json(res, 200, r.liste
      ? { ok: true, provider, models: r.liste, veraltet: r.veraltet, stand: standVon(provider) }
      : { ok: false, error: r.fehler ?? 'list unreachable' })
  }
  // Which effort levels this combination REALLY accepts. Always answers 200:
  // without an answer the form simply hides the field.
  if (req.method === 'GET' && path === '/api/effort') {
    const r = await effortOptionen(url.searchParams.get('harness') ?? '',
      url.searchParams.get('provider') ?? '', url.searchParams.get('model') ?? '')
    return json(res, 200, r.stufen
      ? { ok: true, ...r, hinweis: r.hinweisKey ? t(r.hinweisKey) : '' }
      : { ok: false, error: r.hinweisKey ? t(r.hinweisKey) : (r.hinweis ?? '') })
  }

  if (req.method === 'GET' && path === '/api/or-endpoints') {
    const r = await orEndpoints(url.searchParams.get('model') ?? '')
    return json(res, 200, r.liste
      ? { ok: true, endpoints: r.liste, veraltet: r.veraltet }
      : { ok: false, error: r.fehler ?? 'serving providers unreachable' })
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/report$/))) {
    let b = {}
    try { b = JSON.parse(await readBody(req) || '{}') } catch {}
    const r = await handleReport(m[1], b)
    return json(res, r.ok ? 200 : 400, r)
  }
  // Same definition, same validation and same start path as the run form
  // (pages.mjs) — this endpoint used to be its own third copy and saved an
  // agent without provider, effort and skills.
  if (req.method === 'POST' && path === '/api/runs') {
    const b = await form(req)
    const problems = []
    const def = await runDefFromForm(b, problems)
    const start = runStartFromForm(b, problems)
    if (problems.length) return json(res, 400, { ok: false, error: problems.join(' · ') })
    rememberRunChoice(def)
    if (b.save_agent === '1') {
      try { saveAgent({ repoId: +b.repo_id, name: b.agent_name || `agent-${Date.now()}`, def }) }
      catch { /* duplicate name: the run is what matters, not the copy */ }
    }
    const r = await startRun(def, { repoId: +b.repo_id, ...start })
    return json(res, r.ok ? 200 : 500, {
      ok: r.ok, runId: r.runId, deferred: r.deferred, scheduled: r.scheduled, error: r.error,
    })
  }
  // Quick Run: a favorite plus a task. The dialog sits in the layout of every
  // page, so this is the one start path that must answer JSON and nothing else —
  // the caller stays where it is and shows a toast.
  //
  // Deliberately NOT its own definition builder: the favorite becomes a form
  // body again (favoriteToFormBody) and goes through runDefFromForm() /
  // runStartFromForm() like the run form. That is the whole point of a favorite
  // storing only the setup half — everything the definition needs beyond it is
  // in this request, and the validation is the one that already exists.
  if (req.method === 'POST' && path === '/api/runs/quick') {
    const b = await form(req)
    const fav = getFavorite(b.favorite_id)
    if (!fav) return json(res, 400, { ok: false, error: t('qr.err_favorite') })
    const problems = []
    const def = await runDefFromForm({ ...favoriteToFormBody(fav), ...pickQuickFields(b) }, problems)
    const start = runStartFromForm(b, problems)
    if (problems.length) return json(res, 400, { ok: false, error: problems.join(' · ') })
    rememberRunChoice(def)
    const r = await startRun(def, { repoId: +b.repo_id, ...start })
    if (!r.ok) return json(res, 500, { ok: false, error: r.error ?? 'start failed' })
    const run = getRun(r.runId)
    return json(res, 200, {
      ok: true, runId: r.runId, deferred: !!r.deferred, scheduled: !!r.scheduled,
      title: run?.title ?? null, favorite: fav.name,
    })
  }
  // Rename a run — inline editing in the overview and on the detail page. This
  // touches ONLY the run: an agent keeps its name, and its next run is called
  // by it again. An empty title falls back to the agent's name.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/title$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: 'unknown run' }, `/runs/${m[1]}`)
    const b = await form(req)
    const gewuenscht = String(b.title ?? '').trim().slice(0, TITLE_MAX)
    db.prepare('UPDATE runs SET title=? WHERE id=?').run(gewuenscht || null, run.id)
    const agentName = run.agent_id
      ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name ?? null : null
    return answer(req, res, 200,
      { ok: true, title: runTitle({ title: gewuenscht }, agentName, t('overview.single_run')) },
      `/runs/${run.id}`)
  }
  // Archive a run — one click in the overview, the record (report, log, incidents)
  // stays intact and only leaves the overview. ONLY finished runs: a running one is
  // still being watched, and a deferred/scheduled one would simply start later anyway —
  // the archive must not hide a run that still has work to do. Unarchiving is the
  // reverse. Both go through 'answer' so a classic <form method="post"> lands back on
  // the page it came from ('back'), while a fetch gets JSON.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/archive$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: 'unknown run' }, `/runs/${m[1]}`)
    if (['running', 'waiting_help', 'scheduled', 'deferred'].includes(run.status)) {
      return answer(req, res, 400, { ok: false, error: 'only finished runs can be archived' }, `/runs/${run.id}`)
    }
    db.prepare(`UPDATE runs SET archived_at=COALESCE(archived_at, datetime('now')) WHERE id=?`).run(run.id)
    const b = await form(req)
    return answer(req, res, 200, { ok: true, archived: true }, b.back || `/runs/${run.id}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/unarchive$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: 'unknown run' }, `/runs/${m[1]}`)
    db.prepare(`UPDATE runs SET archived_at=NULL WHERE id=?`).run(run.id)
    const b = await form(req)
    return answer(req, res, 200, { ok: true, archived: false }, b.back || `/runs/${run.id}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/send$/))) {
    const run = getRun(m[1])
    if (!run?.tmux_session) return answer(req, res, 404, { ok: false, error: 'no session' }, `/runs/${m[1]}`)
    const b = await form(req)
    const text = String(b.text || '')
    // Multi-line without accidental submit: bracketed paste + Enter (planning 7.3)
    const { sendToSession } = await import('./util.mjs')
    await sendToSession(run.tmux_session, text)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(run.id)
    if (run.status === 'waiting_help') {
      db.prepare(`UPDATE runs SET status='running', help_answer=? WHERE id=?`).run(text, run.id)
    }
    return answer(req, res, 200, { ok: true }, `/runs/${run.id}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/kill$/))) {
    const run = getRun(m[1])
    const { sh } = await import('./util.mjs')
    if (run?.tmux_session) await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    // Set tmux_closed_at right away: otherwise the detail page tries to attach
    // a terminal to the dead session until the next watcher tick (410 in the browser).
    db.prepare(`UPDATE runs SET status='aborted', ended_at=COALESCE(ended_at, datetime('now')),
                tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')) WHERE id=?`).run(m[1])
    flowsTick().catch(e => console.error('[flows]', e.message))   // "run finished" triggers, without waiting for the watcher
    return answer(req, res, 200, { ok: true }, `/runs/${m[1]}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/retry$/))) {
    const run = getRun(m[1])
    if (!run) return json(res, 404, { ok: false })
    // Retried = not over any more: it leaves the archive, otherwise an active run
    // would sit hidden in the overview while it works.
    db.prepare(`UPDATE runs SET status='running', ended_at=NULL, report_md=NULL, archived_at=NULL WHERE id=?`).run(m[1])
    const r = await launchRun(m[1])
    return answer(req, res, r.ok ? 200 : 500, r, `/runs/${m[1]}`)
  }
  // End tmux sessions — one or many in a single call. The page fires this for
  // every row the operator clicks away; the kills run concurrently inside
  // killSessions(), so a batch costs no more wall clock than a single one.
  // Whatever hung on a session is brought in line there too (a run still on
  // 'running' becomes 'aborted', attached flows fire) — that is the whole point
  // of routing this through one function instead of calling tmux from the page.
  if (req.method === 'POST' && path === '/api/sessions/kill') {
    const b = await form(req)
    const names = b.session_list ?? (b.session ? [b.session] : [])
    if (!names.length) return answer(req, res, 400, { ok: false, error: 'no session given' }, '/sessions')
    const { killSessions } = await import('./sessions.mjs')
    const results = await killSessions(names, 'web')
    return answer(req, res, 200, { ok: results.every(r => r.ok), results }, '/sessions')
  }
  // Resolve an incident (auto-alarm off) — single or all of one run.
  if (req.method === 'POST' && (m = path.match(/^\/api\/incidents\/(\d+)\/resolve$/))) {
    const b = await form(req)
    const v = vorfall(+m[1])
    if (!v) return answer(req, res, 404, { ok: false, error: 'unknown incident' }, b.back || '/')
    vorfallLoesen(v.id, 'web')
    return answer(req, res, 200, { ok: true }, b.back || (v.run_id ? `/runs/${v.run_id}` : '/'))
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/incidents\/resolve-all$/))) {
    vorfaelleLoesen(m[1], 'web')
    return answer(req, res, 200, { ok: true }, `/runs/${m[1]}`)
  }
  if (req.method === 'GET' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/incidents$/))) {
    const { alleVorfaelle } = await import('./incidents.mjs')
    return json(res, 200, { ok: true, incidents: alleVorfaelle(m[1]) })
  }
  if (req.method === 'POST' && path === '/api/settings/pipeline') {
    setSetting('pipeline_on', (await form(req)).value === '1' ? '1' : '0')
    return json(res, 200, { ok: true })
  }
  // Without this closing answer any unknown /api/ path would stay UNANSWERED —
  // the browser then waits until timeout instead of showing an error.
  return json(res, 404, { ok: false, error: `unknown API path: ${req.method} ${path}` })
}

// ---------------- static files ----------------
const STATIC_MAP = [
  ['/static/xterm.js', '/@xterm/xterm/lib/xterm.js', 'application/javascript'],
  ['/static/xterm.css', '/@xterm/xterm/css/xterm.css', 'text/css'],
  ['/static/addon-fit.js', '/@xterm/addon-fit/lib/addon-fit.js', 'application/javascript'],
  ['/static/hub.css', '/../public/hub.css', 'text/css'],
  ['/static/hub.js', '/../public/hub.js', 'application/javascript'],
  // No-code flow designer (server/flows/, public/flows.js)
  ['/static/flows.js', '/../public/flows.js', 'application/javascript'],
  ['/static/flows.css', '/../public/flows.css', 'text/css'],
  // The two pure flow modules run in the browser as well, so the designer and
  // the server judge a flow by the very same code. The /static/flows/ prefix
  // keeps varschema's relative import of template.mjs resolvable.
  ['/static/flows/template.mjs', '/../server/flows/template.mjs', 'application/javascript'],
  ['/static/flows/varschema.mjs', '/../server/flows/varschema.mjs', 'application/javascript'],
  ['/static/swd.js', '/sequential-workflow-designer/dist/index.umd.js', 'application/javascript'],
  ['/static/swd.css', '/sequential-workflow-designer/css/designer.css', 'text/css'],
  ['/static/swd-light.css', '/sequential-workflow-designer/css/designer-light.css', 'text/css'],
]
function serveStatic(res, path) {
  for (const [route, file, type] of STATIC_MAP) {
    if (route !== path) continue
    const abs = file.startsWith('/..') ? join(HERE, file) : join(HERE, '..', 'node_modules', file)
    try {
      const data = readFileSync(abs)
      res.writeHead(200, { 'content-type': type }).end(data)
    } catch {
      res.writeHead(404).end('missing — run npm install? (' + file + ')')
    }
    return
  }
  res.writeHead(404).end()
}
