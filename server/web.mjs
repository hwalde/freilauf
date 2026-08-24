// cc-hub — HTTP: serverseitig gerendertes HTML + JSON-API (Planung 5).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import db, { getRepo, getRun, setSetting } from './db.mjs'
import { handleReport } from './reports.mjs'
import { modelList, orEndpoints, standVon, providerFuerHarness, effortOptionen } from './models.mjs'
import { launchRun, createRun } from './runner.mjs'
import {
  pageOverview, pageAgents, pageRunForm, pageRun, pageRepos, pageSettings,
  runNewPost, agentEdit, agentSave, agentToggle, agentStart,
  repoEdit, repoSave, settingsSave, settingsTestTelegram,
  telegramSetup, telegramTokenSave, telegramChatSave, telegramChats,
} from './pages.mjs'
import { redirect, body as readBody, parseForm } from './web-helpers.mjs'
import { vorfallLoesen, vorfaelleLoesen, vorfall } from './incidents.mjs'
import { skillsAusFormular } from './zusaetze.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------- Hilfen ----------------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
}

/** urlencodeder POST-Body als flaches Objekt (JSON-API und Formulare teilen sich das). */
async function form(req) {
  return parseForm(await readBody(req))
}

/**
 * Manche API-Endpunkte werden BEIDES: per fetch() aus dem Browser-JS und als Ziel
 * eines klassischen <form method="post">. Im zweiten Fall landet der Nutzer sonst auf
 * einer nackten JSON-Seite. Ein Browser-Navigationsrequest ist an 'Accept: text/html'
 * erkennbar — dann lieber zurück auf die Seite schicken.
 */
function wantsHtml(req) {
  return (req.headers.accept ?? '').includes('text/html')
}
function answer(req, res, code, obj, backTo) {
  if (backTo && wantsHtml(req)) return redirect(res, backTo)
  return json(res, code, obj)
}

// ---------------- Router ----------------
export async function route(req, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const formBody = async () => parseForm(await readBody(req))
  try { await dispatch(req, res, url, path, formBody) }
  catch (e) {
    console.error('[http]', e)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('interner Fehler: ' + e.message)
  }
}

async function dispatch(req, res, url, path, formBody) {
  // --- statisch (xterm.js aus node_modules) ---
  if (req.method === 'GET' && path.startsWith('/static/')) return serveStatic(res, path)

  // --- JSON-API ---
  if (path.startsWith('/api/')) return api(req, res, url)

  // --- Telegram-Setup-Assistent ---
  if (req.method === 'GET' && path === '/telegram-setup') return telegramSetup(req, res, url)
  if (req.method === 'POST' && path === '/telegram-setup/token') return telegramTokenSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/telegram-setup/chat') return telegramChatSave(req, res, url, formBody)

  // --- Seiten ---
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
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nicht gefunden')
}

// ---------------- API ----------------
async function api(req, res, url) {
  const path = url.pathname
  let m
  if (req.method === 'GET' && path === '/api/telegram/chats') return telegramChats(req, res)

  // Welche Provider die gewählte Harness überhaupt kann (und wofür Schlüssel da sind).
  if (req.method === 'GET' && path === '/api/providers') {
    const harness = url.searchParams.get('harness') ?? ''
    return json(res, 200, { ok: true, harness, provider: providerFuerHarness(harness) })
  }

  // Modell-Listen der Provider. Antwortet IMMER mit 200 und ok:false im Fehlerfall —
  // das Formular soll nichts abfangen müssen und bleibt auch ohne Liste bedienbar.
  if (req.method === 'GET' && path === '/api/models') {
    const provider = url.searchParams.get('provider') ?? ''
    // Die Harness entscheidet mit: opencode nimmt nur an, was es selbst kennt.
    const r = await modelList(provider, url.searchParams.get('harness'))
    return json(res, 200, r.liste
      ? { ok: true, provider, models: r.liste, veraltet: r.veraltet, stand: standVon(provider) }
      : { ok: false, error: r.fehler ?? 'Liste nicht erreichbar' })
  }
  // Welche Denk-Stufen diese Kombination WIRKLICH annimmt. Antwortet immer 200:
  // ohne Antwort blendet das Formular das Feld einfach aus.
  if (req.method === 'GET' && path === '/api/effort') {
    const r = await effortOptionen(url.searchParams.get('harness') ?? '',
      url.searchParams.get('provider') ?? '', url.searchParams.get('model') ?? '')
    return json(res, 200, r.stufen ? { ok: true, ...r } : { ok: false, error: r.hinweis })
  }

  if (req.method === 'GET' && path === '/api/or-endpoints') {
    const r = await orEndpoints(url.searchParams.get('model') ?? '')
    return json(res, 200, r.liste
      ? { ok: true, endpoints: r.liste, veraltet: r.veraltet }
      : { ok: false, error: r.fehler ?? 'Serving-Provider nicht abrufbar' })
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
    if (!run?.tmux_session) return answer(req, res, 404, { ok: false, error: 'keine Session' }, `/runs/${m[1]}`)
    const b = await form(req)
    const text = String(b.text || '')
    // Mehrzeilig ohne versehentliches Absenden: Bracketed Paste + Enter (Planung 7.3)
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
    // tmux_closed_at gleich mitsetzen: sonst versucht die Detailseite bis zum nächsten
    // Watcher-Tick noch, ein Terminal an die tote Session zu hängen (410 im Browser).
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
  // Vorfall lösen (Autoalarm aus) — einzeln oder alle eines Laufs.
  if (req.method === 'POST' && (m = path.match(/^\/api\/incidents\/(\d+)\/resolve$/))) {
    const b = await form(req)
    const v = vorfall(+m[1])
    if (!v) return answer(req, res, 404, { ok: false, error: 'Vorfall unbekannt' }, b.back || '/')
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
  // Ohne diesen Abschluss bliebe jeder unbekannte /api/-Pfad UNBEANTWORTET — der
  // Browser wartet dann bis zum Timeout statt einen Fehler zu zeigen.
  return json(res, 404, { ok: false, error: `unbekannter API-Pfad: ${req.method} ${path}` })
}

// ---------------- Statische Dateien ----------------
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
      res.writeHead(404).end('fehlt — npm install ausführen? (' + file + ')')
    }
    return
  }
  res.writeHead(404).end()
}
