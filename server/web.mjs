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
import { launchRun, createRun } from './runner.mjs'
import {
  pageOverview, pageAgents, pageRunForm, pageRun, pageRepos, pageSettings,
  runNewPost, agentEdit, agentSave, agentToggle, agentStart,
  repoEdit, repoSave, settingsSave, settingsTestTelegram,
  telegramSetup, telegramTokenSave, telegramChatSave, telegramChats,
  pageCodingAgents, codingAgentSave, codingAgentDelete,
} from './pages.mjs'
import { redirect, body as readBody, parseForm } from './web-helpers.mjs'
import { vorfallLoesen, vorfaelleLoesen, vorfall } from './incidents.mjs'
import { skillsAusFormular } from './zusaetze.mjs'
import { t } from './i18n.mjs'

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
  if (req.method === 'GET' && path === '/agents') return pageAgents(req, res, url)
  if (req.method === 'GET' && path === '/agents/edit') return agentEdit(req, res, url)
  if (req.method === 'POST' && path === '/agents/edit') return agentSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/toggle') return agentToggle(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/start') return agentStart(req, res, url, formBody)
  if (req.method === 'GET' && path === '/runs/new') return pageRunForm(req, res, url)
  if (req.method === 'POST' && path === '/runs/new') return runNewPost(req, res, url, formBody)
  if (/^\/runs\/[0-9a-f-]{36}$/.test(path)) return pageRun(req, res, url, path.split('/')[2])
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
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end(t('web.not_found'))
}

// ---------------- API ----------------
async function api(req, res, url) {
  const path = url.pathname
  let m
  if (req.method === 'GET' && path === '/api/telegram/chats') return telegramChats(req, res)

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
  if (req.method === 'POST' && path === '/api/runs') {
    const b = await form(req)
    try {
      const runId = createRun({
        repoId: +b.repo_id, agentId: null, harness: b.harness, model: b.model || null,
        provider: b.provider || null, orProvider: b.or_provider || null, effort: b.effort || null,
        prompt: b.prompt, promptExtra: null, branchMode: b.branch_mode,
        branchPattern: b.branch_pattern || null, expectedMinutes: +b.expected_minutes || 45,
        skills: skillsAusFormular(b),
      })
      if (b.save_agent === '1') {
        db.prepare(`INSERT INTO agents(repo_id,name,harness,model,prompt,branch_mode,branch_pattern,expected_minutes,active)
                    VALUES(?,?,?,?,?,?,?,?,'1')`)
          .run(+b.repo_id, b.agent_name || `agent-${Date.now()}`, b.harness, b.model || null, b.prompt,
            b.branch_mode, b.branch_pattern || null, +b.expected_minutes || 45)
      }
      const r = await launchRun(runId)
      return json(res, r.ok ? 200 : 500, { ok: r.ok, runId, error: r.error })
    } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/send$/))) {
    const run = getRun(m[1])
    if (!run?.tmux_session) return answer(req, res, 404, { ok: false, error: 'no session' }, `/runs/${m[1]}`)
    const b = await form(req)
    const text = String(b.text || '')
    // Multi-line without accidental submit: bracketed paste + Enter (planning 7.3)
    const { sh } = await import('./util.mjs')
    await sh('tmux', ['send-keys', '-t', `=${run.tmux_session}:`, '-l', '--', '\x1b[200~' + text + '\x1b[201~'])
    await new Promise(r => setTimeout(r, 300))
    await sh('tmux', ['send-keys', '-t', `=${run.tmux_session}:`, 'Enter'])
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
    return answer(req, res, 200, { ok: true }, `/runs/${m[1]}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/retry$/))) {
    const run = getRun(m[1])
    if (!run) return json(res, 404, { ok: false })
    db.prepare(`UPDATE runs SET status='running', ended_at=NULL, report_md=NULL WHERE id=?`).run(m[1])
    const r = await launchRun(m[1])
    return answer(req, res, r.ok ? 200 : 500, r, `/runs/${m[1]}`)
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
