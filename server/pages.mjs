// cc-hub — Seiten: serverseitig gerendertes HTML, Vanilla-JS, nur Rot/Gelb/Grün
// als Farben (Planung 10). Repo-Umschalter + Schalter-Status im Kopf.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import db, { getRepo, getRun } from './db.mjs'
import { escapeHtml as e, validCron, WOCHENTAGE, scheduleText } from './util.mjs'
import { claudeQuota, openrouterCredits } from './quota.mjs'
import { providerFuerHarness, effortOptionen } from './models.mjs'
import { ampelAusVorfaellen, offeneVorfaelle, alleVorfaelle } from './incidents.mjs'
import { TYP_TEXT } from './detect.mjs'
import { llmModelleMru, llmModellMerken } from './pruefer.mjs'
import { skillFelder, skillsAusFormular, skillListe, skillAnzeige } from './zusaetze.mjs'

/**
 * Eingabefehler gehören auf eine Seite mit Weg zurück — nicht in einen 500er
 * ("interner Fehler") oder eine nackte Textantwort, die die Eingaben verschluckt.
 */
function problemPage(res, title, problems, backHref) {
  const body = `<h2>${e(title)}</h2>
  <ul class="err">${problems.map(p => `<li>${e(p)}</li>`).join('')}</ul>
  <p><a class="btn" href="${e(backHref)}">Zurück zum Formular</a></p>`
  res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(layout(title, '', body))
}

/** Zustand des globalen Und-Gatters für geplante Starts. */
function pipelineAn() {
  return db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get()?.value === '1'
}

function ampel(run) {
  const vf = ampelAusVorfaellen(run.id)
  const red = vf === 'rot' || ['waiting_help', 'failed'].includes(run.status)
    || db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind LIKE 'anomaly:%' AND kind NOT IN ('anomaly:no_activity','anomaly:soft_overrun','anomaly:unpushed') LIMIT 1`).get(run.id)
  const yellow = !red && (
    vf === 'gelb' || run.status === 'deferred'
    || db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind IN ('anomaly:no_activity','anomaly:soft_overrun','anomaly:unpushed') LIMIT 1`).get(run.id))
  return red ? 'rot' : yellow ? 'gelb' : 'gruen'
}

const AMPEL_DOT = { rot: '<span class="dot rot" title="rot"></span>', gelb: '<span class="dot gelb"></span>', gruen: '<span class="dot gruen"></span>' }

function lastAnomaly(runId) {
  const r = db.prepare(`SELECT kind, ts FROM events WHERE run_id=? AND (kind LIKE 'anomaly:%' OR kind='help') ORDER BY id DESC LIMIT 1`).get(runId)
  return r ? `${r.kind} (${r.ts})` : '–'
}

/** Name eines Vorfalltyps, auch für 'provider_down:openrouter'. */
export function typName(typ) {
  const [kopf, rest] = String(typ).split(':')
  return (TYP_TEXT[kopf] ?? kopf) + (rest ? ` (${rest})` : '')
}

/** Offene Vorfälle eines Laufs als Zelle: Typ, Anzahl, Lösen-Knopf. */
function vorfallZelle(runId, repoId) {
  const offen = offeneVorfaelle(runId)
  if (!offen.length) return '<span class="dim">–</span>'
  return offen.map(v => `<span class="vorfall ${v.schwere}" title="${e(v.beleg ?? '')}">${e(typName(v.typ))} ${v.anzahl}×
    <span class="dim">${e(v.zuletzt_gesehen.slice(5, 16))}</span></span>
    <form method="post" action="/api/incidents/${v.id}/resolve" class="inline" onclick="event.stopPropagation()">
      <input type="hidden" name="back" value="/?repo=${repoId}"><button title="Vorfall als erledigt markieren — tritt er erneut auf, geht der Alarm wieder an">lösen</button></form>`).join('<br>')
}

/** Globale Vorfälle (Provider-Puls) über allen Seiten. */
function globalesBanner() {
  const offen = offeneVorfaelle(null)
  if (!offen.length) return ''
  return `<div class="banner rot">${offen.map(v => `🔴 <b>${e(typName(v.typ))}</b> seit ${e(v.erst_gesehen)} UTC (${v.anzahl}× geprüft) — ${e(v.beleg ?? '')}
    <form method="post" action="/api/incidents/${v.id}/resolve" class="inline"><input type="hidden" name="back" value="/"><button>lösen</button></form>`).join('<br>')}</div>`
}

function layout(title, active, content, selectedRepo = null, withTerminal = false) {
  const pipeline = pipelineAn()
  const q = claudeQuota()
  const nav = [['/', 'Übersicht'], ['/agents', 'Agenten'], ['/repos', 'Repos'], ['/settings', 'Einstellungen']]
    .map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`).join('')
  const bar = (label, pct) => `<div class="quota"><span>${label}</span><div class="track"><div class="fill ${(pct ?? 0) >= 90 ? 'r' : (pct ?? 0) >= 80 ? 'y' : ''}" style="width:${Math.min(pct ?? 0, 100)}%"></div></div><span>${pct ?? '?'} %</span></div>`
  const repos = db.prepare('SELECT id,name FROM repos ORDER BY name').all()
  const repoSel = repos.length
    ? `<label class="dim">Repo</label> <select id="repo-switch" data-active="${e(active)}">${repos.map(r => `<option value="${r.id}" ${r.id == selectedRepo ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select>`
    : '<a href="/repos" class="warn">kein Repo angelegt</a>'
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cc-hub — ${e(title)}</title>
<link rel="stylesheet" href="/static/xterm.css"><link rel="stylesheet" href="/static/hub.css"></head>
<body>
<header>
  <span class="brand">cc-hub</span>
  <nav>${nav}</nav>
  ${repoSel}
  <span class="spacer"></span>
  <span title="globales Und-Gatter für geplante Starts">Pipeline: <b class="${pipeline ? 'ok' : 'warn'}">${pipeline ? 'an' : 'aus'}</b></span>
  ${bar('5h', q.five)}${bar('7T', q.seven)}
</header>
<main>${globalesBanner()}${content}</main>
${withTerminal ? '<script src="/static/xterm.js"></script><script src="/static/addon-fit.js"></script>' : ''}
<script src="/static/hub.js"></script></body></html>`
}

// ---------------- Übersicht ----------------
export async function pageOverview(req, res, url) {
  const sel = selectRepo(url)
  if (!sel) return noRepoPage(res, '/', 'Übersicht')
  const runs = db.prepare(`SELECT * FROM runs WHERE repo_id=? ORDER BY
    CASE status WHEN 'waiting_help' THEN 0 WHEN 'failed' THEN 1 WHEN 'running' THEN 2 WHEN 'deferred' THEN 3 ELSE 4 END,
    started_at DESC LIMIT 200`).all(sel.id)
  const credits = await openrouterCredits()
  const rows = runs.map(r => {
    const agent = r.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(r.agent_id)?.name : '(Einzellauf)'
    // Beendete Läufe: Dauer bis zum Ende, nicht bis jetzt — sonst „wächst" ein
    // Lauf von vor drei Tagen in der Übersicht auf 4000 Minuten.
    const endeMs = r.ended_at ? Date.parse(r.ended_at.replace(' ', 'T') + 'Z') : Date.now()
    const durMin = Math.round((endeMs - Date.parse(r.started_at.replace(' ', 'T') + 'Z')) / 60000)
    // Die Zeile bleibt als Ganzes klickbar, der Name ist zusätzlich ein echter Link —
    // sonst käme man mit der Tastatur gar nicht auf die Detailseite.
    return `<tr onclick="location='/runs/${r.id}'">
      <td>${AMPEL_DOT[ampel(r)]}</td>
      <td><a href="/runs/${r.id}">${e(agent)}</a></td>
      <td>${e(r.harness)}${r.model ? `<span class="dim">/${r.provider ? e(r.provider) + ':' : ''}${e(r.model)}</span>` : ''}</td>
      <td>${r.status}</td>
      <td>${durMin > 0 ? durMin + ' min' : ''}<span class="dim"> / ${r.expected_minutes} min</span></td>
      <td>${e(r.branch_reported || r.branch_expected || '–')}</td>
      <td>${r.pr_url ? `<a href="${e(r.pr_url)}">PR</a>` : '–'}</td>
      <td>${vorfallZelle(r.id, sel.id)}</td>
      <td class="dim">${e(lastAnomaly(r.id))}</td>
    </tr>`
  }).join('')
  const body = `
  <p><a class="btn" href="/runs/new?repo=${sel.id}">Einzellauf starten</a></p>
  <table class="list"><thead><tr><th></th><th>Agent</th><th>Harness/Modell</th><th>Status</th><th>Dauer/Erwartung</th><th>Branch</th><th>PR</th><th>Vorfälle</th><th>letzte Auffälligkeit</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="9" class="dim">noch keine Läufe</td></tr>'}</tbody></table>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Übersicht', '/', body, sel.id))
}

function selectRepo(url) {
  const want = url.searchParams.get('repo')
  let sel = want ? getRepo(+want) : null
  if (!sel) sel = db.prepare('SELECT * FROM repos ORDER BY name LIMIT 1').get() ?? null
  return sel   // null = noch kein Repo angelegt → Seiten zeigen Einrichtungs-Hinweis
}

export function noRepoPage(res, active, title) {
  const body = `
  <h2>Erst ein Repo anlegen</h2>
  <p>Agenten und Läufe gehören immer zu genau einem Repo. Beispiel:
     <code>~/projects/mein-projekt</code> mit Basis-Branch <code>main</code>.</p>
  <p><a class="btn" href="/repos/edit">Jetzt Repo anlegen</a></p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(title, active, body))
}

// ---------------- Agenten ----------------
export async function pageAgents(req, res, url) {
  const sel = selectRepo(url)
  if (!sel) return noRepoPage(res, '/agents', 'Agenten')
  if (req.method === 'POST') return void res.writeHead(405).end()
  const agents = db.prepare('SELECT * FROM agents WHERE repo_id=? ORDER BY name').all(sel.id)
  const rows = agents.map(a => `
  <tr>
    <td><form method="post" action="/agents/toggle" class="inline"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${sel.id}"><button>${a.active ? 'aktiv' : 'aus'}</button></form></td>
    <td>${e(a.name)}</td><td>${e(a.harness)}</td><td>${e(a.model || '–')}</td>
    <td>${e(scheduleText(a))}</td><td>${a.expected_minutes} min</td>
    <td><form method="post" action="/agents/start" class="inline"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${sel.id}"><button>jetzt starten</button></form></td>
    <td><a href="/agents/edit?id=${a.id}&repo=${sel.id}">bearbeiten</a></td>
  </tr>`).join('')
  const body = `
  <p><a class="btn" href="/agents/edit?repo=${sel.id}">Agent anlegen</a></p>
  <table class="list"><thead><tr><th>Status</th><th>Name</th><th>Harness</th><th>Modell</th><th>Zeitplan</th><th>Erwartung</th><th></th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="8" class="dim">keine Agenten</td></tr>'}</tbody></table>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Agenten', '/agents', body, sel.id))
}

// ---------------- Einzellauf-Maske (= Agenten-Maske ohne Zeitplan) ----------------
export async function pageRunForm(req, res, url) {
  const sel = selectRepo(url)
  if (!sel) return noRepoPage(res, '', 'Einzellauf')
  const agentId = url.searchParams.get('agent')
  const a = agentId ? db.prepare('SELECT * FROM agents WHERE id=?').get(+agentId) : null
  const fields = `
  <label>Harness <select name="harness">
    ${['claude', 'opencode', 'hermes', 'cursor'].map(h => `<option ${a?.harness === h ? 'selected' : ''}>${h}</option>`).join('')}
  </select></label>
  ${modellFelder(a ?? {})}
  <label>Prompt <textarea name="prompt" rows="10" required>${e(a?.prompt ?? '')}</textarea></label>
  <label>Branch-Erwartung <select name="branch_mode">
    <option value="keiner">keiner</option>
    <option value="neu">legt neuen an</option>
    <option value="fest">benutzt festen</option>
  </select></label>
  <label>Branch-Muster/-Name <input name="branch_pattern" placeholder="z. B. agent/deadcode/{date}"></label>
  <label>Erwartete max. Dauer (min) <input type="number" name="expected_minutes" value="${a?.expected_minutes ?? 45}" min="1"></label>
  ${skillFelder(a?.skills)}
  <input type="hidden" name="repo_id" value="${sel.id}">
  <label class="chk"><input type="checkbox" name="save_agent" value="1"> als Agent speichern (Name: <input name="agent_name" placeholder="agent-name">)</label>`
  const body = `
  <h2>Einzellauf — Repo „${e(sel.name)}“${a ? ` (wie Agent „${e(a.name)}“)` : ''}</h2>
  <form method="post" action="/runs/new">${fields}<button>Starten</button>
  ${pipelineAn()
    ? '<span class="dim"> Pipeline ist an — geplante Starts laufen ebenfalls.</span>'
    : '<span class="warn"> Pipeline ist aus — das betrifft nur geplante Starts; dieser Lauf startet sofort.</span>'}</form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Einzellauf', '', body, sel.id))
}

// ---------------- Detailseite ----------------
export async function pageRun(req, res, url, id) {
  const run = getRun(id)
  if (!run) { res.writeHead(404).end('Lauf nicht gefunden'); return }
  const repo = getRepo(run.repo_id)
  const agent = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name : '(Einzellauf)'
  const events = db.prepare(`SELECT * FROM events WHERE run_id=? AND kind NOT LIKE 'telegram_sent%' ORDER BY id`).all(id)
  // Log (ANSI-bereinigt), letzter Ausschnitt
  const { readFileSync, existsSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const logf = join(process.env.CCHUB_RUNS_DIR ?? `${process.env.HOME}/agents/runs`, id, 'log.txt')
  let logHtml = '<p class="dim">Kein Log.</p>'
  if (existsSync(logf)) {
    try {
      const size = statSync(logf).size
      const raw = readFileSync(logf).subarray(Math.max(0, size - 100_000)).toString('utf8')
      logHtml = `<pre id="log">${e(raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''))}</pre>`
    } catch {}
  }
  // „live" heißt: es gibt wirklich eine Session, an die man sich hängen kann.
  // Nur am Status festgemacht, versprach die Seite ein Terminal, das es nicht gab.
  const live = ['running', 'waiting_help'].includes(run.status) && !!run.tmux_session && !run.tmux_closed_at
  const body = `
  <h2>${AMPEL_DOT[ampel(run)]} Lauf ${id.slice(0, 8)} — ${e(agent)} (${run.status})</h2>
  <p class="dim">Repo „${e(repo?.name ?? '?')}“, Harness ${e(run.harness)}${run.model ? ', Modell ' + e(run.model) : ''}
   ${run.provider ? `· Provider ${e(run.provider)}${run.or_provider ? ` (fest: ${e(run.or_provider)})` : ''} ` : ''}· Start ${e(run.started_at)}${run.ended_at ? ' · Ende ' + e(run.ended_at) : ''}
   · Erwartung ${run.expected_minutes} min · Arbeitsverzeichnis <code>${e(run.workdir_effective ?? '')}</code>
   ${skillListe(run.skills).length ? `· Zusatz-Skills: <b>${skillAnzeige(run.skills).map(e).join(', ')}</b>` : ''}</p>
  ${run.help_text
    ? run.status === 'waiting_help'
      // offen: der Agent wartet gerade auf eine Antwort
      ? `<div class="help"><b>Hilferuf:</b> ${e(run.help_text)}
         <form method="post" action="/api/runs/${id}/send"><textarea name="text" rows="3" placeholder="Antwort an den Agenten …"></textarea><button>Antwort senden</button></form></div>`
      // erledigt: als Historie zeigen, nicht als offene Frage
      : `<p class="dim"><b>Hilferuf (beantwortet):</b> ${e(run.help_text)}${run.help_answer ? ` → <i>${e(run.help_answer)}</i>` : ''}</p>`
    : ''}
  <details ${live ? 'open' : ''}><summary>Terminal ${live ? '(live — hineinklicken und direkt tippen)' : '(beendet, Scrollback)'}</summary>
    <div id="term" data-session="${run.tmux_session && !run.tmux_closed_at ? '1' : '0'}" data-live="${live ? '1' : '0'}"></div>
    ${live ? `<form onsubmit="return cchubSend(this,'/api/runs/${id}/send')"><textarea name="text" rows="3" placeholder="Text in die Session schicken (mehrzeilig möglich)"></textarea><button>Senden</button></form>
    <form onsubmit="return cchubKill('${id}')"><button class="danger">Lauf beenden</button></form>` : ''}
  </details>
  ${['failed', 'aborted'].includes(run.status)
    ? `<form method="post" action="/api/runs/${id}/retry"><button>Lauf wiederholen</button>
       <span class="dim">startet denselben Auftrag erneut; ein vorhandener Worktree wird weiterbenutzt</span></form>`
    : ''}
  ${run.report_md ? `<h3>Report</h3><pre>${e(run.report_md)}</pre>` : ''}
  ${vorfallAbschnitt(id)}
  <h3>Metriken</h3>
  <ul>
    <li>Laufzeit: ${fmtLaufzeit(run)} · Erwartung ${run.expected_minutes} min</li>
    <li>Tokens: in ${run.tokens_in ?? 0}, out ${run.tokens_out ?? 0}</li>
    <li>Kosten: ${run.cost_eur != null ? run.cost_eur.toFixed(2) + ' € (Abo-Delta)' : run.cost_usd != null ? run.cost_usd.toFixed(4) + ' $' : '–'}</li>
    <li>Aktivität: ${e(run.last_activity_at ?? '–')}</li>
    <li>Branch gemeldet: ${e(run.branch_reported ?? '–')} · erwartet: ${e(run.branch_expected ?? '–')} · PR: ${run.pr_url ? `<a href="${e(run.pr_url)}">${e(run.pr_url)}</a>` : '–'}</li>
    <li>Exit: ${run.exit_code ?? '–'}${run.tmux_closed_at ? ' · tmux geschlossen ' + e(run.tmux_closed_at) : ''}</li>
  </ul>
  <h3>Ereignisse</h3><ul class="events">${events.map(ev => `<li><span class="dim">${e(ev.ts)}</span> ${e(ev.kind)}</li>`).join('') || '<li class="dim">keine</li>'}</ul>
  <h3>Log (pipe-pane)</h3>${logHtml}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(`Lauf ${id.slice(0, 8)}`, '/', body, run.repo_id, true))
}

function fmtLaufzeit(run) {
  const endeMs = run.ended_at ? Date.parse(run.ended_at.replace(' ', 'T') + 'Z') : Date.now()
  const min = Math.round((endeMs - Date.parse(run.started_at.replace(' ', 'T') + 'Z')) / 60000)
  return `${min} min${run.ended_at ? '' : ' (läuft)'}`
}

/**
 * Vorfälle auf der Detailseite: offene mit Lösen-Knopf, gelöste als Historie.
 * Der Beleg (die Zeile, die gezündet hat) steht dabei — sonst kann man einen
 * Falschalarm nicht von einem echten unterscheiden.
 */
function vorfallAbschnitt(runId) {
  const alle = alleVorfaelle(runId)
  if (!alle.length) return ''
  const zeile = (v) => `<li class="vorfall-zeile ${v.geloest_am ? 'geloest' : v.schwere}">
    <b>${e(typName(v.typ))}</b> <span class="dim">(${e(v.quelle)}, ${v.schwere})</span>
    · ${v.anzahl}× · erstmals ${e(v.erst_gesehen)} · zuletzt ${e(v.zuletzt_gesehen)} UTC
    ${v.wieder_geoeffnet ? `· ${v.wieder_geoeffnet}× wieder geöffnet` : ''}
    ${v.geloest_am ? `· gelöst ${e(v.geloest_am)} (${e(v.geloest_von ?? '')})` : `
      <form method="post" action="/api/incidents/${v.id}/resolve" class="inline"><input type="hidden" name="back" value="/runs/${runId}"><button>lösen</button></form>`}
    ${v.beleg ? `<br><code class="beleg">${e(v.beleg)}</code>` : ''}</li>`
  const offen = alle.filter(v => !v.geloest_am), zu = alle.filter(v => v.geloest_am)
  return `<h3>Vorfälle</h3>
  ${offen.length ? `<ul class="vorfaelle">${offen.map(zeile).join('')}</ul>
    <form method="post" action="/api/runs/${runId}/incidents/resolve-all"><button>alle lösen</button>
    <span class="dim">Tritt ein gelöster Vorfall erneut auf, geht er wieder auf und Telegram meldet erneut.</span></form>` : ''}
  ${zu.length ? `<details><summary class="dim">${zu.length} gelöste</summary><ul class="vorfaelle">${zu.map(zeile).join('')}</ul></details>` : ''}
  <p class="dim">Protokoll des Detektors: <code>${e(join(process.env.CCHUB_RUNS_DIR ?? `${process.env.HOME}/agents/runs`, runId, 'detektor.jsonl'))}</code></p>`
}

// ---------------- Repos ----------------
export async function pageRepos(req, res, url) {
  const repos = db.prepare('SELECT * FROM repos ORDER BY name').all()
  const rows = repos.map(r => `
  <tr><td>${e(r.name)}</td><td><code>${e(r.path)}</code></td><td>${e(r.base_branch)}</td>
  <td class="dim">${e(r.worktree_extras)}</td>
  <td><a href="/repos/edit?id=${r.id}">bearbeiten</a></td></tr>`).join('')
  const body = `
  <p><a class="btn" href="/repos/edit">Repo anlegen</a></p>
  <table class="list"><thead><tr><th>Name</th><th>Pfad</th><th>Basis</th><th>Worktree-Ergänzungen</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5" class="dim">noch keine Repos — z. B. ~/projects/mein-projekt</td></tr>'}</tbody></table>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Repos', '/repos', body))
}

// ---------------- Einstellungen ----------------
export async function pageSettings(req, res, url) {
  const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]))
  const body = `
  <h2>Einstellungen</h2>
  <p class="dim">Diese Einstellungen gelten <b>global für den gesamten Hub</b> — nicht für das
  oben gewählte Repo. Repo-bezogen sind nur die Angaben unter <a href="/repos">Repos</a>
  (Pfad, Basis-Branch, Worktree-Ergänzungen) und die Agenten selbst.</p>
  <form method="post" action="/settings/save" class="settings">
    <label>Pipeline global <select name="pipeline_on"><option value="1" ${s.pipeline_on === '1' ? 'selected' : ''}>an</option><option value="0" ${s.pipeline_on !== '1' ? 'selected' : ''}>aus</option></select></label>
    <label>Telegram-Bot-Token <input name="telegram_token" type="password" value="${e(s.telegram_token ?? '')}"></label>
    <label>Telegram-Chat-ID <input name="telegram_chat" value="${e(s.telegram_chat ?? '')}"></label>
    <label>Quota-Schwelle für Verschiebung (%) <input name="quota_threshold" type="number" value="${e(s.quota_threshold ?? '90')}"></label>
    <label>OpenRouter-Mindestguthaben (EUR) <input name="openrouter_min_eur" type="number" step="0.5" value="${e(s.openrouter_min_eur ?? '5')}"></label>
    <label>Claude-Code-Abo — Monatspreis für die Kostenrechnung (EUR/Monat) <input name="abo_price" type="number" value="${e(s.abo_price ?? '200')}"></label>
    <label>Aufbewahrung beendeter Sessions (Tage) <input name="retention_days" type="number" value="${e(s.retention_days ?? '3')}"></label>
    <label>Plattform-Prompt-Zusatz (Vorlage; Platzhalter {run_id} {workdir} {branch_rule} {expected_minutes}) <textarea name="prompt_suffix" rows="12">${e(s.prompt_suffix ?? '')}</textarea></label>
    <fieldset><legend>Prüf-LLM für Log-Treffer (optional, über OpenRouter)</legend>
      <p class="dim">Der Scanner findet Zeilen, die nach Rate-Limit oder Provider-Fehler aussehen. Ist das
      Prüf-LLM an, bekommt es die letzten Terminalzeilen und entscheidet strukturiert, ob der Agent wirklich
      blockiert ist (sofort rot) oder ob es ein Menütext/Retry war (kein Vorfall). Aus: Treffer werden gelb
      und nach Wiederholung oder 5 min Stille rot. Gilt für alle Agenten. Höchstens eine Anfrage je Lauf
      und 10 Minuten. ${process.env.OPENROUTER_API_KEY ? '' : '<b class="warn">OPENROUTER_API_KEY fehlt in ~/.config/cc-hub/env — ohne Schlüssel bleibt es aus.</b>'}</p>
      <label>Prüf-LLM <select name="llm_check_on"><option value="0" ${s.llm_check_on !== '1' ? 'selected' : ''}>aus</option><option value="1" ${s.llm_check_on === '1' ? 'selected' : ''}>an</option></select></label>
      <label>Modell (OpenRouter-ID, z. B. <code>openai/gpt-4.1-mini</code>) <input name="llm_check_model" list="llm-mru" value="${e(s.llm_check_model ?? '')}" placeholder="anbieter/modell">
        <datalist id="llm-mru">${llmModelleMru().map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">Liste: die 10 zuletzt gespeicherten Modelle</span></label>
      <label>Fester Serving-Provider (optional, OpenRouter-Tag) <input name="llm_check_or_provider" value="${e(s.llm_check_or_provider ?? '')}" placeholder="leer = OpenRouter wählt"></label>
    </fieldset>
    <button>Speichern</button>
  </form>
  ${url.searchParams.get('telegram') === 'ok' ? '<p class="ok">✓ Telegram-Testnachricht wurde versendet.</p>' : ''}
  ${url.searchParams.get('telegram') === 'fehler' ? '<p class="err">Telegram-Testnachricht fehlgeschlagen — sind Token und Chat-ID gesetzt? Siehe Assistent.</p>' : ''}
  <p><a class="btn" href="/telegram-setup">Telegram-Setup-Assistent öffnen</a></p>
  <form method="post" action="/settings/test-telegram"><button>Telegram-Testnachricht</button></form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Einstellungen', '/settings', body))
}

// ---------------- Formular-Aktionen ----------------
import { redirect } from './web-helpers.mjs'
import { createRun, launchRun } from './runner.mjs'
import { startForAgent } from './scheduler.mjs'
import { setSetting } from './db.mjs'
import { sendTest } from './telegram.mjs'

export async function runNewPost(req, res, url, formBody) {
  const b = await formBody()
  const problems = []
  const pv = providerAusFormular(b, problems)
  const effort = await effortAusFormular(b, problems)
  if (problems.length) return problemPage(res, 'Lauf starten', problems, `/runs/new?repo=${b.repo_id ?? ''}`)
  const skills = skillsAusFormular(b)
  let runId
  try {
    runId = createRun({
      repoId: +b.repo_id, agentId: null, harness: b.harness, model: b.model || null,
      provider: pv.provider, orProvider: pv.or_provider, effort,
      prompt: b.prompt, promptExtra: null, branchMode: b.branch_mode,
      branchPattern: b.branch_pattern || null, expectedMinutes: +b.expected_minutes || 45,
      skills,
    })
  } catch (err) { return problemPage(res, 'Lauf starten', [err.message], `/runs/new?repo=${b.repo_id ?? ''}`) }
  if (b.save_agent === 'on' || b.save_agent === '1') {
    try {
      db.prepare(`INSERT INTO agents(repo_id,name,harness,model,provider,or_provider,effort,prompt,
                  branch_mode,branch_pattern,expected_minutes,skills,active)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'1')`)
        .run(+b.repo_id, b.agent_name?.trim() || `agent-${Date.now()}`, b.harness, b.model || null,
          pv.provider, pv.or_provider, effort, b.prompt, b.branch_mode, b.branch_pattern || null,
          +b.expected_minutes || 45, skills)
    } catch {}
  }
  const r = await launchRun(runId)
  redirect(res, r.ok ? `/runs/${runId}` : `/runs/${runId}`)
}

/**
 * Provider-Angaben aus dem Formular. Ein Serving-Provider wird NUR übernommen, wenn er
 * technisch überhaupt durchgereicht werden kann (opencode + OpenRouter + Häkchen) —
 * sonst stünde in der DB eine Zusage, die beim Start still unter den Tisch fällt.
 */
function providerAusFormular(b, problems) {
  const provider = b.provider ?? ''
  // Nicht nur „kennen wir den Provider", sondern „kann diese Harness ihn hier auch
  // wirklich" — sonst stünde in der DB eine Kombination, die beim Start scheitert.
  const erlaubt = providerFuerHarness(b.harness).map(p => p.id)
  if (provider !== '' && !erlaubt.includes(provider)) {
    problems.push(['claude', 'cursor'].includes(b.harness)
      ? `${b.harness} läuft über das Abo — dort wird kein Provider gewählt, nur das Modell.`
      : `Provider „${provider}“ ist für ${b.harness} hier nicht verfügbar (fehlt ein Schlüssel?). Möglich: ${erlaubt.join(', ') || 'keiner'}`)
    return { provider: null, or_provider: null }
  }
  const pinnen = b.or_pin === '1' && b.harness === 'opencode' && provider === 'openrouter'
  return { provider: provider || null, or_provider: pinnen ? (b.or_provider?.trim() || null) : null }
}

/**
 * Denk-Aufwand prüfen. Dieselbe Strenge wie beim Serving-Provider: übernommen wird nur,
 * was für genau diese Kombination auch wirklich ankommt. opencode verwirft eine
 * unbekannte Stufe still, hermes prüft gar nichts — ein durchgereichter Unsinnswert
 * verpuffte also lautlos und niemand wüsste, dass die Einstellung nichts tut.
 */
async function effortAusFormular(b, problems) {
  const wunsch = (b.effort ?? '').trim()
  if (!wunsch) return null
  const r = await effortOptionen(b.harness, b.provider ?? '', b.model ?? '')
  if (!r.stufen?.includes(wunsch)) {
    problems.push(`Denk-Aufwand „${wunsch}“ ist für ${b.harness}`
      + `${b.model ? ` mit ${b.model}` : ''} nicht möglich`
      + (r.stufen ? ` — möglich: ${r.stufen.join(', ')}` : ` (${r.hinweis})`))
    return null
  }
  return wunsch
}

/**
 * Zeitplan-Auswahl: vier Arten, von denen immer nur die passende sichtbar ist
 * (Umschalten in hub.js). Cron bleibt als Expertenfeld erhalten — die anderen drei
 * Arten decken das ab, was sich mit 5-Feld-Cron nicht ausdrücken lässt
 * (n-wöchentlich, einmaliger Termin).
 */
function zeitplanFelder(a = {}) {
  const kind = a.schedule_kind ?? 'manuell'
  const tage = String(a.schedule_days ?? '').split(',').filter(t => t !== '').map(Number)
  const heute = new Date().toISOString().slice(0, 10)
  const arten = [
    ['manuell', 'nur manuell starten'],
    ['woechentlich', 'an Wochentagen zu fester Uhrzeit'],
    ['einmalig', 'einmalig zu einem Termin'],
    ['cron', 'Cron-Ausdruck (Experten)'],
  ]
  return `
  <fieldset class="zeitplan">
    <legend>Zeitplan</legend>
    <label>Art <select name="schedule_kind" id="schedule-kind">
      ${arten.map(([v, t]) => `<option value="${v}" ${kind === v ? 'selected' : ''}>${t}</option>`).join('')}
    </select></label>

    <div class="zp" data-kind="woechentlich">
      <div class="tage">${WOCHENTAGE.map(w => `
        <label class="tag"><input type="checkbox" name="schedule_days" value="${w.n}"
          ${tage.includes(w.n) ? 'checked' : ''}> ${w.kurz}</label>`).join('')}
      </div>
      <label>Uhrzeit (für alle gewählten Tage) <input type="time" name="schedule_time" value="${e(a.schedule_time ?? '06:00')}"></label>
      <label>Takt <select name="schedule_weeks">
        ${[1, 2, 3, 4].map(n => `<option value="${n}" ${Number(a.schedule_weeks ?? 1) === n ? 'selected' : ''}>${n === 1 ? 'jede Woche' : `alle ${n} Wochen`}</option>`).join('')}
      </select></label>
      <label>Startwoche (nur bei mehrwöchigem Takt) <input type="date" name="schedule_anchor" value="${e(a.schedule_anchor ?? heute)}"></label>
    </div>

    <div class="zp" data-kind="einmalig">
      <label>Termin <input type="datetime-local" name="run_at" value="${e(a.run_at ?? '')}"></label>
      <p class="dim">Läuft genau einmal und stellt sich danach auf „nur manuell“ zurück.
      War der Hub zum Termin aus, wird der Start nachgeholt.</p>
    </div>

    <div class="zp" data-kind="cron">
      <label>Cron-Ausdruck <input name="schedule" value="${e(a.schedule ?? '')}" placeholder="z. B. 0 6 * * 1-5"></label>
      <p class="dim">Fünf Felder: Minute Stunde Tag Monat Wochentag.</p>
    </div>
  </fieldset>`
}

/**
 * Provider- und Modellauswahl. Bewusst EIN Baustein für Agenten-Maske und
 * Einzellauf — vorher war das Modellfeld in beiden Formularen dupliziert und driftete.
 *
 * Die Liste wird nicht serverseitig eingebettet, sondern per fetch nachgeladen:
 * hängt eine Provider-API, steht trotzdem sofort ein Textfeld da, in das man den
 * Slug direkt tippen kann. <datalist> gibt die Suchfunktion gratis dazu.
 */
function modellFelder(a = {}) {
  const prov = a.provider ?? ''
  return `
  <label id="prov-label">Provider
    <select name="provider" id="prov" data-gewaehlt="${e(prov)}">
      <option value="">— keiner: Modell frei eintippen —</option>
    </select>
    <span class="dim" id="prov-hint"></span>
  </label>

  <label>Modell
    <input name="model" id="model" list="modelle" autocomplete="off" value="${e(a.model ?? '')}"
           placeholder="Slug eintippen oder aus der Liste wählen">
    <datalist id="modelle"></datalist>
  </label>
  <p class="dim" id="model-hint"></p>

  <label id="effort-label" hidden>Denk-Aufwand
    <select name="effort" id="effort" data-gewaehlt="${e(a.effort ?? '')}">
      <option value="">— Standard der Harness —</option>
    </select>
    <span class="dim" id="effort-hint"></span>
  </label>

  <fieldset class="zeitplan" id="or-routing" hidden>
    <legend>Serving-Provider (OpenRouter)</legend>
    <label class="chk"><input type="checkbox" name="or_pin" value="1" id="or-pin" ${a.or_provider ? 'checked' : ''}>
      festen Serving-Provider erzwingen</label>
    <label id="or-prov-label" ${a.or_provider ? '' : 'hidden'}>Anbieter
      <select name="or_provider" id="or-prov"><option value="${e(a.or_provider ?? '')}">${e(a.or_provider ?? '')}</option></select>
    </label>
    <p class="dim">Ohne Häkchen entscheidet OpenRouter selbst. Nur für opencode möglich —
    hermes kennt dafür kein Argument pro Lauf.</p>
  </fieldset>`
}

function agentFields(a = {}, repoId) {
  return `
  <label>Name <input name="name" value="${e(a.name ?? '')}" required></label>
  <label>Harness <select name="harness">${['claude', 'opencode', 'hermes', 'cursor'].map(h =>
    `<option ${a.harness === h ? 'selected' : ''}>${h}</option>`).join('')}</select></label>
  ${modellFelder(a)}
  <input type="hidden" name="repo_id" value="${repoId}">
  <label>Prompt <textarea name="prompt" rows="10" required>${e(a.prompt ?? '')}</textarea></label>
  <label>Branch-Erwartung <select name="branch_mode">
    ${['keiner', 'neu', 'fest'].map(m => `<option value="${m}" ${a.branch_mode === m ? 'selected' : ''}>${m === 'neu' ? 'legt neuen an' : m === 'fest' ? 'benutzt festen' : 'keiner'}</option>`).join('')}
  </select></label>
  <label>Branch-Muster / fester Name <input name="branch_pattern" value="${e(a.branch_pattern ?? '')}" placeholder="z. B. agent/deadcode/{date}"></label>
  <label>Erwartete max. Dauer (min) <input type="number" name="expected_minutes" min="1" value="${a.expected_minutes ?? 45}"></label>
  ${skillFelder(a.skills)}
  ${zeitplanFelder(a)}
  <label class="chk"><input type="checkbox" name="active" value="1" ${a.active ?? 1 ? 'checked' : ''}> aktiv</label>`
}

export async function agentEdit(req, res, url) {
  const id = url.searchParams.get('id')
  const a = id ? db.prepare('SELECT * FROM agents WHERE id=?').get(+id) : {}
  const repoId = +(url.searchParams.get('repo') ?? db.prepare('SELECT id FROM repos ORDER BY name LIMIT 1').get()?.id ?? 0)
  const body = `<h2>${id ? 'Agent bearbeiten' : 'Agent anlegen'}</h2>
  <form method="post" action="/agents/edit${id ? `?id=${id}` : ''}" class="settings">${agentFields(a, repoId)}<button>Speichern</button></form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(id ? 'Agent' : 'Neuer Agent', '/agents', body, repoId))
}

export async function agentSave(req, res, url, formBody) {
  const id = url.searchParams.get('id')
  const b = await formBody()
  const active = b.active ? 1 : 0
  const back = `/agents/edit${id ? `?id=${id}&repo=${b.repo_id ?? ''}` : `?repo=${b.repo_id ?? ''}`}`
  const problems = []
  if (!b.name?.trim()) problems.push('Name fehlt.')
  if (!b.prompt?.trim()) problems.push('Prompt ist leer.')
  if (!['claude', 'opencode', 'hermes', 'cursor'].includes(b.harness)) problems.push(`Unbekannte Harness: ${b.harness}`)
  if (!['keiner', 'neu', 'fest'].includes(b.branch_mode)) problems.push(`Unbekannte Branch-Erwartung: ${b.branch_mode}`)
  if (b.branch_mode !== 'keiner' && !b.branch_pattern?.trim()) problems.push('Branch-Muster fehlt (Erwartung ist nicht „keiner“).')
  const zp = zeitplanAusFormular(b, problems)
  const pv = providerAusFormular(b, problems)
  const effort = await effortAusFormular(b, problems)
  const skills = skillsAusFormular(b)
  if (problems.length) return problemPage(res, 'Agent speichern', problems, back)

  if (id) {
    // Ein einziges UPDATE — vorher wurde 'active' erst auf 1 gesetzt und danach
    // aus genau diesem frisch geschriebenen Wert wieder abgeleitet.
    db.prepare(`UPDATE agents SET name=?, harness=?, model=?, prompt=?, branch_mode=?, branch_pattern=?,
                expected_minutes=?, schedule=?, schedule_kind=?, schedule_days=?, schedule_time=?,
                schedule_weeks=?, schedule_anchor=?, run_at=?, provider=?, or_provider=?, effort=?,
                skills=?, active=?, updated_at=datetime('now') WHERE id=?`).run(
      b.name.trim(), b.harness, b.model || null, b.prompt, b.branch_mode, b.branch_pattern || null,
      +b.expected_minutes || 45, zp.schedule, zp.kind, zp.days, zp.time, zp.weeks, zp.anchor, zp.run_at,
      pv.provider, pv.or_provider, effort, skills, active, +id)
  } else {
    db.prepare(`INSERT INTO agents(repo_id,name,harness,model,prompt,branch_mode,branch_pattern,expected_minutes,
                schedule,schedule_kind,schedule_days,schedule_time,schedule_weeks,schedule_anchor,run_at,
                provider,or_provider,effort,skills,active)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      +b.repo_id, b.name.trim(), b.harness, b.model || null, b.prompt, b.branch_mode,
      b.branch_pattern || null, +b.expected_minutes || 45,
      zp.schedule, zp.kind, zp.days, zp.time, zp.weeks, zp.anchor, zp.run_at,
      pv.provider, pv.or_provider, effort, skills, active)
  }
  redirect(res, `/agents?repo=${b.repo_id}`)
}

/**
 * Zeitplan aus dem Formular lesen und prüfen. Nur die Felder der gewählten Art
 * werden übernommen — sonst bliebe beim Umschalten alter Kram stehen und der
 * Agent liefe nach einem Wechsel auf „manuell“ trotzdem weiter.
 */
function zeitplanAusFormular(b, problems) {
  const leer = { schedule: null, kind: 'manuell', days: null, time: null, weeks: null, anchor: null, run_at: null }
  switch (b.schedule_kind) {
    case 'woechentlich': {
      // Mehrere gleichnamige Checkboxen: der URLSearchParams-Sammler in web.mjs
      // behält nur den letzten Wert — darum kommen die Tage als Liste herein.
      const tage = (b.schedule_days_list ?? []).map(Number).filter(n => n >= 0 && n <= 6)
      if (!tage.length) problems.push('Bitte mindestens einen Wochentag auswählen.')
      if (!/^\d{2}:\d{2}$/.test(b.schedule_time ?? '')) problems.push('Uhrzeit fehlt oder ist ungültig (Format HH:MM).')
      const weeks = Number(b.schedule_weeks) || 1
      if (![1, 2, 3, 4].includes(weeks)) problems.push('Takt muss 1, 2, 3 oder 4 Wochen sein.')
      if (weeks > 1 && !/^\d{4}-\d{2}-\d{2}$/.test(b.schedule_anchor ?? '')) {
        problems.push('Für einen mehrwöchigen Takt wird eine Startwoche gebraucht.')
      }
      return { ...leer, kind: 'woechentlich', days: tage.sort().join(','), time: b.schedule_time,
        weeks, anchor: weeks > 1 ? b.schedule_anchor : null }
    }
    case 'einmalig': {
      const t = (b.run_at ?? '').trim()
      if (!t || Number.isNaN(new Date(t).getTime())) problems.push('Bitte einen gültigen Termin angeben.')
      return { ...leer, kind: 'einmalig', run_at: t }
    }
    case 'cron': {
      const c = (b.schedule ?? '').trim()
      if (!c) problems.push('Cron-Ausdruck fehlt.')
      else if (!validCron(c)) problems.push(`„${c}“ ist kein 5-Feld-Cron (Minute Stunde Tag Monat Wochentag), z. B. „0 6 * * 1-5“.`)
      return { ...leer, kind: 'cron', schedule: c }
    }
    default:
      return leer
  }
}

export async function agentToggle(req, res, url, formBody) {
  const b = await formBody()
  db.prepare('UPDATE agents SET active = 1 - active WHERE id=?').run(+b.id)
  redirect(res, `/agents?repo=${b.repo}`)
}

export async function agentStart(req, res, url, formBody) {
  const b = await formBody()
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(+b.id)
  if (!agent) { res.writeHead(404).end(); return }
  const pipelineOn = db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get()?.value === '1'
  if (!pipelineOn) {
    // Manueller Start trotz ausgeschalteter Pipeline ist erlaubt (Planung 4.8).
    const r2 = await startForAgent(agent, null)
    redirect(res, r2.runId ? `/runs/${r2.runId}` : '/agents')
    return
  }
  const r = await startForAgent(agent)
  redirect(res, r.runId ? `/runs/${r.runId}` : '/agents')
}

export async function repoEdit(req, res, url) {
  const id = url.searchParams.get('id')
  const r = id ? getRepo(+id) : {}
  const body = `<h2>${id ? 'Repo bearbeiten' : 'Repo anlegen'}</h2>
  <form method="post" action="/repos/edit${id ? `?id=${id}` : ''}" class="settings">
    <label>Name <input name="name" value="${e(r.name ?? '')}" required></label>
    <label>Pfad (Haupt-Checkout) <input name="path" value="${e(r.path ?? '')}" placeholder="~/projects/mein-projekt" required></label>
    <label>Basis-Branch <input name="base_branch" value="${e(r.base_branch ?? 'main')}"></label>
    <label>Worktree-Ergänzungen (JSON: [{"path":".env","mode":"copy"},{"path":"referenz/","mode":"link"}]) <textarea name="worktree_extras" rows="5">${e(r.worktree_extras ?? '[]')}</textarea></label>
    <button>Speichern</button>
  </form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Repos', '/repos', body))
}

export async function repoSave(req, res, url, formBody) {
  const id = url.searchParams.get('id')
  const b = await formBody()
  const back = `/repos/edit${id ? `?id=${id}` : ''}`
  const repoPath = (b.path ?? '').trim().replace(/^~/, process.env.HOME)
  const problems = []
  if (!b.name?.trim()) problems.push('Name fehlt.')
  if (!repoPath) problems.push('Pfad fehlt.')
  // Ein falscher Pfad fiele sonst erst beim ersten Lauf auf ('git worktree' scheitert).
  else if (!existsSync(join(repoPath, '.git'))) problems.push(`Kein git-Repository unter ${repoPath} (.git fehlt).`)
  try {
    const extras = JSON.parse(b.worktree_extras || '[]')
    if (!Array.isArray(extras) || extras.some(x => typeof x?.path !== 'string' || !['copy', 'link'].includes(x?.mode))) {
      problems.push('Worktree-Ergänzungen: erwartet wird eine Liste aus {"path": "…", "mode": "copy"|"link"}.')
    }
  } catch (err) {
    problems.push(`Worktree-Ergänzungen sind kein gültiges JSON: ${err.message}`)
  }
  if (problems.length) return problemPage(res, 'Repo speichern', problems, back)
  if (id) {
    db.prepare(`UPDATE repos SET name=?, path=?, base_branch=?, worktree_extras=? WHERE id=?`)
      .run(b.name.trim(), repoPath, b.base_branch || 'main', b.worktree_extras || '[]', +id)
  } else {
    db.prepare(`INSERT INTO repos(name,path,base_branch,worktree_extras) VALUES(?,?,?,?)`)
      .run(b.name.trim(), repoPath, b.base_branch || 'main', b.worktree_extras || '[]')
  }
  redirect(res, '/repos')
}

export async function settingsSave(req, res, url, formBody) {
  const b = await formBody()
  for (const k of ['pipeline_on', 'telegram_token', 'telegram_chat', 'quota_threshold',
    'openrouter_min_eur', 'abo_price', 'retention_days', 'prompt_suffix',
    'llm_check_on', 'llm_check_model', 'llm_check_or_provider']) {
    setSetting(k, b[k] ?? '')
  }
  // „Verwendet" heißt gespeichert: erst jetzt wandert das Modell in die MRU-Liste.
  llmModellMerken(b.llm_check_model)
  redirect(res, '/settings')
}

export async function settingsTestTelegram(req, res) {
  // Ohne Rückmeldung klickt man hier ins Leere: Erfolg und Fehlschlag sahen gleich aus.
  const ok = await sendTest()
  redirect(res, `/settings?telegram=${ok ? 'ok' : 'fehler'}`)
}

// ---------------- Telegram-Setup-Assistent (Planung 7.6, interaktiv) ----------------
// Führt durch: 1) BotFather-Token eintragen  2) /start an den Bot schicken
//              3) Chat aus getUpdates auswählen  4) Testnachricht senden.

export async function telegramSetup(req, res, url) {
  const s = Object.fromEntries(db.prepare(`SELECT key,value FROM settings`).all().map(r => [r.key, r.value]))
  const tokenSet = !!s.telegram_token
  const chatSet = !!s.telegram_chat
  const step = !tokenSet ? 1 : !chatSet ? 2 : 3

  const step1 = `
  <div class="card ${tokenSet ? 'ok' : ''}">
    <h3>Schritt 1 — Bot-Token</h3>
    <p class="dim">In Telegram <b>@BotFather</b> öffnen → <code>/newbot</code> (oder <code>/mybots</code> → vorhandener Bot)
    → den Token kopieren (Form <code>123456789:AA…</code>).</p>
    <form method="post" action="/telegram-setup/token" class="inline">
      <input name="telegram_token" type="password" placeholder="BotFather-Token" size="50" required>
      <button>Token speichern</button>
    </form>
    ${tokenSet ? '<p class="ok">✓ Token ist gespeichert.</p>' : ''}
  </div>`

  const step2 = `
  <div class="card ${chatSet ? 'ok' : ''}">
    <h3>Schritt 2 — Chat-ID ermitteln</h3>
    <p class="dim">Schick deinem Bot in Telegram eine Nachricht (z. B. <code>/start</code>) und klicke dann:</p>
    <button id="tg-fetch">Nach getUpdates suchen</button>
    <div id="tg-chats"></div>
    ${chatSet ? `<p class="ok">✓ Chat-ID gespeichert: <code>${e(s.telegram_chat)}</code></p>` : ''}
  </div>`

  const step3 = `
  <div class="card">
    <h3>Schritt 3 — Testen</h3>
    <form method="post" action="/settings/test-telegram"><button>Testnachricht senden</button></form>
    <p class="dim">Danach hier fertig — Benachrichtigungen gehen an: done / failed / Hilferuf /
    Auffälligkeit / Start verschoben / Quota ≥ 80 %. Jede Nachricht hat den Button „Zur Detailseite“.</p>
  </div>`

  const body = `
  <h2>Telegram-Setup</h2>
  ${step1}${step2}${step3}
  <script>
  document.getElementById('tg-fetch')?.addEventListener('click', async () => {
    const box = document.getElementById('tg-chats')
    box.textContent = 'suche …'
    try {
      const r = await fetch('/api/telegram/chats')
      const j = await r.json()
      if (!j.ok) { box.innerHTML = '<p class="err">' + j.error + '</p>'; return }
      if (!j.chats.length) { box.innerHTML = '<p class="warn">Keine Nachrichten gefunden. Erst dem Bot schreiben (/start), dann erneut klicken.</p>'; return }
      box.innerHTML = j.chats.map(c =>
        '<form method="post" action="/telegram-setup/chat"><input type="hidden" name="chat_id" value="' + c.id + '">' +
        '<button>Nutzen: ' + c.label + ' (ID ' + c.id + ')</button></form>').join('')
    } catch (e2) { box.textContent = String(e2) }
  })
  </script>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout('Telegram-Setup', '/settings', body))
}

export async function telegramTokenSave(req, res, url, formBody) {
  const b = await formBody()
  const t = b.telegram_token?.trim()
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(t ?? '')) { res.writeHead(400).end('Token sieht nicht nach einem BotFather-Token aus.'); return }
  setSetting('telegram_token', t)
  redirect(res, '/telegram-setup')
}

export async function telegramChatSave(req, res, url, formBody) {
  const b = await formBody()
  if (!/^-?\d+$/.test(b.chat_id ?? '')) { res.writeHead(400).end('Ungültige Chat-ID.'); return }
  setSetting('telegram_chat', b.chat_id)
  redirect(res, '/telegram-setup')
}

/** getUpdates auslesen und bekannte Chats dedupliziert liefern. */
export async function telegramChats(_req, res) {
  const token = db.prepare(`SELECT value FROM settings WHERE key='telegram_token'`).get()?.value
  if (!token) return jsonOut(res, 400, { ok: false, error: 'Kein Token gespeichert (Schritt 1).' })
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`, { signal: AbortSignal.timeout(15_000) })
    const j = await r.json()
    if (!j.ok) return jsonOut(res, 200, { ok: false, error: `Telegram: ${j.description ?? 'unbekannter Fehler'}` })
    const byId = new Map()
    for (const u of j.result ?? []) {
      for (const key of ['message', 'edited_message', 'channel_post', 'my_chat_member']) {
        const chat = u[key]?.chat
        if (!chat) continue
        const text = u[key]?.text || u[key]?.caption || ''
        const label = [chat.first_name, chat.last_name, chat.title, chat.username && '@' + chat.username].filter(Boolean).join(' ')
        const prev = byId.get(chat.id)
        if (!prev) byId.set(chat.id, { id: chat.id, label: label || ('Chat ' + chat.id), last_text: text })
        else if (text) prev.last_text = text
      }
    }
    jsonOut(res, 200, { ok: true, chats: [...byId.values()] })
  } catch (e) {
    jsonOut(res, 200, { ok: false, error: 'Erreichbarkeit fehlgeschlagen: ' + e.message })
  }
}

function jsonOut(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
}
