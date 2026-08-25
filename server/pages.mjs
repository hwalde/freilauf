// cc-hub — pages: server-rendered HTML, vanilla JS, red/yellow/green as the
// only colors (planning 10). Repo switcher + switch states in the header.
// All UI strings go through i18n (lang/<code>.json; English is the default).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import db, { getRepo, getRun } from './db.mjs'
import { escapeHtml as e, validCron, WOCHENTAGE, scheduleText, parseDbUtc, fmtRelativeTime, fmtDateTime } from './util.mjs'
import { claudeQuota, openrouterCredits } from './quota.mjs'
import {
  enabledCodingAgents, listCodingAgents, saveCodingAgent,
  deleteCodingAgent, unconfiguredHarnessIds,
} from './coding-agents.mjs'
import {
  runDefFields, runDefFromForm, saveAgent, lastRunChoice, rememberRunChoice,
  runTitleField, runStartTimeFields, runStartFromForm,
} from './run-def.mjs'
import { runTitle, titleModelsMru, rememberTitleModel, DEFAULT_TITLE_MODEL } from './title.mjs'
import { getHarness, harnessLabel, detectInstalled } from './harnesses/index.mjs'
import { providerLabel } from './providers/index.mjs'
import { subscriptionUsage } from './usage.mjs'
import { ampelAusVorfaellen, offeneVorfaelle, alleVorfaelle, brauchtMensch } from './incidents.mjs'
import { TYP_TEXT } from './detect.mjs'
import { llmModelleMru, llmModellMerken } from './pruefer.mjs'
import { skillListe, skillAnzeige } from './zusaetze.mjs'
import { attachmentSummary, flowSection } from './flows/attach.mjs'
import { t, LANGUAGES, currentLanguage, setLanguage, clientCatalog } from './i18n.mjs'

/**
 * Input errors belong on a page with a way back — not in a 500 ("internal
 * error") or a bare text response that swallows the inputs.
 */
function problemPage(res, title, problems, backHref) {
  const body = `<h2>${e(title)}</h2>
  <ul class="err">${problems.map(p => `<li>${e(p)}</li>`).join('')}</ul>
  <p><a class="btn" href="${e(backHref)}">${e(t('problem.back'))}</a></p>`
  res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(layout(title, '', body))
}

/** State of the global AND gate for scheduled starts. */
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

/** Name of an incident type, also for 'provider_down:openrouter'. */
export function typName(typ) {
  const [kopf, rest] = String(typ).split(':')
  const name = t(`incident.${kopf}`) !== `incident.${kopf}` ? t(`incident.${kopf}`) : (TYP_TEXT[kopf] ?? kopf)
  return name + (rest ? ` (${rest})` : '')
}

/** Open incidents of a run as a table cell: type, count, resolve button. */
function vorfallZelle(runId, repoId, runStatus = null) {
  const offen = offeneVorfaelle(runId)
  if (!offen.length) return '<span class="dim">–</span>'
  return offen.map(v => {
    // '!' marks the ones that are waiting for hands — in a table of many runs
    // that mark is the whole difference between a to-do and a note.
    const handeln = brauchtMensch(v, runStatus)
    return `<span class="vorfall ${v.schwere}" title="${e(v.beleg ?? '')}">${handeln ? '❗ ' : ''}${e(typName(v.typ))} ${v.anzahl}×
    <span class="dim">${e(v.zuletzt_gesehen.slice(5, 16))}</span></span>
    <form method="post" action="/api/incidents/${v.id}/resolve" class="inline" onclick="event.stopPropagation()">
      <input type="hidden" name="back" value="/?repo=${repoId}"><button title="${e(t('incidents.resolve_hint'))}">${e(t(handeln ? 'incidents.mark_handled' : 'incidents.dismiss'))}</button></form>`
  }).join('<br>')
}

/** Global incidents (provider pulse) above all pages. */
function globalesBanner() {
  const offen = offeneVorfaelle(null)
  if (!offen.length) return ''
  return `<div class="banner rot">${offen.map(v => `🔴 <b>${e(typName(v.typ))}</b> ${e(t('incidents.global_since', { ts: v.erst_gesehen }))} (${e(t('incidents.checked', { n: v.anzahl }))}) — ${e(v.beleg ?? '')}
    <form method="post" action="/api/incidents/${v.id}/resolve" class="inline"><input type="hidden" name="back" value="/"><button>${e(t(brauchtMensch(v) ? 'incidents.mark_handled' : 'incidents.dismiss'))}</button></form>`).join('<br>')}</div>`
}

/** Top bar shown on every page while no coding agent is configured. */
function setupBanner() {
  if (enabledCodingAgents().length) return ''
  return `<div class="banner setup">⚙️ ${e(t('banner.no_coding_agent'))}
    <a class="btn" href="/settings/coding-agents">${e(t('banner.no_coding_agent_cta'))}</a></div>`
}

export function layout(title, active, content, selectedRepo = null, withTerminal = false) {
  const pipeline = pipelineAn()
  const q = claudeQuota()
  // No "Flows" entry: a flow is not a place you go, it hangs on the agent or the
  // single run that starts it. The flow pages are reached from those two forms.
  const nav = [['/', t('nav.overview')], ['/agents', t('nav.agents')], ['/repos', t('nav.repos')], ['/settings', t('nav.settings')]]
    .map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${e(label)}</a>`).join('')
  const bar = (label, pct) => `<div class="quota"><span>${label}</span><div class="track"><div class="fill ${(pct ?? 0) >= 90 ? 'r' : (pct ?? 0) >= 80 ? 'y' : ''}" style="width:${Math.min(pct ?? 0, 100)}%"></div></div><span>${pct ?? '?'} %</span></div>`
  const repos = db.prepare('SELECT id,name FROM repos ORDER BY name').all()
  const repoSel = repos.length
    ? `<label class="dim">${e(t('layout.repo'))}</label> <select id="repo-switch" data-active="${e(active)}">${repos.map(r => `<option value="${r.id}" ${r.id == selectedRepo ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select>`
    : `<a href="/repos" class="warn">${e(t('layout.no_repo'))}</a>`
  return `<!doctype html><html lang="${e(currentLanguage())}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cc-hub — ${e(title)}</title>
<link rel="stylesheet" href="/static/xterm.css"><link rel="stylesheet" href="/static/hub.css"></head>
<body>
${setupBanner()}
<header>
  <span class="brand">cc-hub</span>
  <nav>${nav}</nav>
  ${repoSel}
  <span class="spacer"></span>
  <span title="${e(t('layout.pipeline_hint'))}">${e(t('layout.pipeline'))}: <b class="${pipeline ? 'ok' : 'warn'}">${e(pipeline ? t('layout.on') : t('layout.off'))}</b></span>
  ${bar('5h', q.five)}${q.seven_general != null ? bar('7d', q.seven_general) : ''}
</header>
<main>${globalesBanner()}${content}</main>
${withTerminal ? '<script src="/static/xterm.js"></script><script src="/static/addon-fit.js"></script>' : ''}
<script>window.CCHUB_I18N=${JSON.stringify(clientCatalog())}</script>
<script src="/static/hub.js"></script></body></html>`
}

// ---------------- subscription usage panel ----------------
async function usagePanel() {
  let usage = []
  try { usage = await subscriptionUsage() } catch { usage = [] }
  const credits = await openrouterCredits()
  if (!usage.length && !credits) return ''
  // A reset within the next day is a time, everything beyond it needs the date
  // too — '16:30' alone says nothing about a window that runs for a week.
  const resetText = (iso) => {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return ''
    const d = new Date(ms)
    const uhr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const tag = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`
    return (ms - Date.now() > 24 * 3600_000 ? `${tag} ` : '') + `${uhr} UTC`
  }
  const pctBar = (pct) => pct == null ? '' :
    `<div class="track"><div class="fill ${pct >= 90 ? 'r' : pct >= 80 ? 'y' : ''}" style="width:${Math.min(pct, 100)}%"></div></div><span>${pct} %</span>`
  const rows = usage.map(u => {
    if (!u.ok) return `<div class="usage-row"><b>${e(u.label)}</b> <span class="dim">${e(t('usage.unavailable'))}</span></div>`
    const d = u.data
    if (d.kind === 'claude') {
      // Three windows, each with its own bar and its own reset time — the fable
      // week runs separately from the general one, and one shared reset behind
      // the row could only ever belong to one of them. A window claude does not
      // report at all stays out of the row, and so does a missing reset time.
      const fenster = (label, pct, iso) => pct == null ? ''
        : `<span class="quota"><span>${label}</span>${pctBar(pct)}${
          iso ? `<span class="dim">${e(t('usage.resets', { time: resetText(iso) }))}</span>` : ''}</span>`
      return `<div class="usage-row"><b>${e(u.label)}</b>${d.plan ? ` <span class="dim">${e(d.plan)}</span>` : ''}
        ${fenster('5h', d.five, d.resets_at)}
        ${fenster('7d', d.seven_general, d.seven_resets_at)}
        ${fenster('7d fable', d.seven_fable, d.seven_fable_resets_at)}</div>`
    }
    if (d.kind === 'cursor') {
      // What one reads at a glance is the bar — like the claude rows above. The
      // dollars are the detail and move into the tooltip; only when the included
      // amount is the configured fallback does the text say so (tilde).
      const money = d.spent_usd != null
        ? t(d.included_estimated ? 'usage.spent_est' : 'usage.spent',
          { usd: d.spent_usd.toFixed(2), included: d.included_usd })
        : ''
      const days = d.cycle_end != null
        ? Math.max(0, Math.ceil((Date.parse(d.cycle_end) - Date.now()) / 86_400_000)) : null
      return `<div class="usage-row"><b>${e(u.label)}</b>${d.plan ? ` <span class="dim">${e(d.plan)}</span>` : ''}
        ${d.pct != null ? `<span class="quota" title="${e(money)}">${pctBar(d.pct)}</span>`
          : `<span class="dim">${e(t('usage.unavailable'))}</span>`}
        ${days != null ? `<span class="dim">${e(t('usage.resets_in', { days }))}</span>` : ''}</div>`
    }
    return ''
  }).join('')
  const or = credits?.remaining != null
    ? `<div class="usage-row"><b>${e(t('usage.openrouter_credits'))}</b> <span>${e(t('usage.remaining', { eur: credits.remaining }))}</span></div>`
    : ''
  if (!rows && !or) return ''
  return `<details class="usage" open><summary>${e(t('usage.title'))}</summary>${rows}${or}</details>`
}

// ---------------- overview ----------------
export async function pageOverview(req, res, url) {
  const sel = selectRepo(url)
  if (!sel) return noRepoPage(res, '/', t('nav.overview'))
  // 'scheduled' sits with 'deferred': both are runs that exist and are WAITING —
  // that is exactly what one wants to see at a glance, not somewhere below the
  // finished ones.
  const runs = db.prepare(`SELECT * FROM runs WHERE repo_id=? ORDER BY
    CASE status WHEN 'waiting_help' THEN 0 WHEN 'failed' THEN 1 WHEN 'running' THEN 2
                WHEN 'deferred' THEN 3 WHEN 'scheduled' THEN 4 ELSE 5 END,
    started_at DESC LIMIT 200`).all(sel.id)
  const rows = runs.map(r => {
    const agentName = r.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(r.agent_id)?.name ?? null : null
    const titel = runTitle(r, agentName, t('overview.single_run'))
    // Under the title stands where the run comes from — the agent by name, or
    // the word for "no agent". A renamed run must not lose that information.
    const herkunft = agentName ? t('overview.from_agent', { agent: agentName }) : t('overview.single_run')
    // Finished runs: duration until the end, not until now — otherwise a run
    // from three days ago "grows" to 4000 minutes in the overview.
    const startedMs = parseDbUtc(r.started_at)
    const endeMs = r.ended_at ? parseDbUtc(r.ended_at) : Date.now()
    const durMin = Math.round((endeMs - startedMs) / 60000)
    const wartend = r.status === 'scheduled'
    // The row stays clickable as a whole, the title is additionally a real link —
    // otherwise the detail page would be unreachable by keyboard. The title cell
    // swallows the row click: renaming must not navigate away.
    return `<tr onclick="location='/runs/${r.id}'">
      <td>${AMPEL_DOT[ampel(r)]}</td>
      <td class="titelzelle" onclick="event.stopPropagation()">
        ${titleInline(r.id, titel)}
        <div class="dim">${e(herkunft)}</div></td>
      <td>${e(r.harness)}${r.model ? `<span class="dim">/${r.provider ? e(r.provider) + ':' : ''}${e(r.model)}</span>` : ''}</td>
      <td>${r.status}${wartend ? `<div class="dim">${wartetAuf(r)}</div>` : ''}</td>
      <td>${wartend ? plannedCell(r) : startedCell(r.started_at)}</td>
      <td>${wartend ? '' : (durMin > 0 ? durMin + ' min' : '')}<span class="dim"> / ${r.expected_minutes} min</span></td>
      <td>${e(r.branch_reported || r.branch_expected || '–')}</td>
      <td>${r.pr_url ? `<a href="${e(r.pr_url)}">PR</a>` : '–'}</td>
      <td>${vorfallZelle(r.id, sel.id, r.status)}</td>
      <td class="dim">${e(lastAnomaly(r.id))}</td>
    </tr>`
  }).join('')
  const body = `
  ${await usagePanel()}
  <p><a class="btn" href="/runs/new?repo=${sel.id}">${e(t('overview.start_single'))}</a></p>
  <table class="list"><thead><tr><th></th><th>${e(t('overview.title_col'))}</th><th>${e(t('overview.harness_model'))}</th><th>${e(t('overview.status'))}</th><th>${e(t('overview.started'))}</th><th>${e(t('overview.duration_expected'))}</th><th>${e(t('overview.branch'))}</th><th>PR</th><th>${e(t('incidents.title'))}</th><th>${e(t('overview.last_anomaly'))}</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="10" class="dim">${e(t('overview.no_runs'))}</td></tr>`}</tbody></table>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('nav.overview'), '/', body, sel.id))
}

/**
 * The title as a link plus a pencil that turns it into an input in place
 * (hub.js). Renaming works on EVERY run, including one an agent started — it
 * changes the run, never the agent behind it.
 */
function titleInline(runId, titel) {
  return `<span class="titel-inline" data-run="${e(runId)}">
    <a href="/runs/${e(runId)}" data-title-text>${e(titel)}</a>
    <button type="button" class="mini" data-title-edit title="${e(t('overview.rename'))}" aria-label="${e(t('overview.rename'))}">✎</button>
  </span>`
}

/** Relative start ("4 seconds ago"); exact date-time sits in the title tooltip. */
function startedCell(ts) {
  const ms = parseDbUtc(ts)
  if (!Number.isFinite(ms)) return '–'
  return `<time class="reltime" datetime="${new Date(ms).toISOString()}" title="${e(fmtDateTime(ms))}">${e(fmtRelativeTime(ms))}</time>`
}

/** A planned run shows when it WILL start — the same cell, looking forward. */
function plannedCell(run) {
  return run.start_mode === 'idle' ? `<span class="dim">–</span>` : startedCell(run.start_at)
}

/** What a waiting run is waiting for, in one line. */
function wartetAuf(run) {
  if (run.status === 'deferred') return e(t('start.waits_budget'))
  if (run.start_mode === 'idle') return e(t('start.until_free'))
  const ms = parseDbUtc(run.start_at)
  return Number.isFinite(ms) ? e(t('start.waits_until', { time: fmtDateTime(ms) })) : e(t('start.waits'))
}

function selectRepo(url) {
  const want = url.searchParams.get('repo')
  let sel = want ? getRepo(+want) : null
  if (!sel) sel = db.prepare('SELECT * FROM repos ORDER BY name LIMIT 1').get() ?? null
  return sel   // null = no repo yet → pages show a setup hint
}

export function noRepoPage(res, active, title) {
  const body = `
  <h2>${e(t('norepo.title'))}</h2>
  <p>${e(t('norepo.text'))} <code>~/projects/my-project</code> (${e(t('norepo.base_hint'))} <code>main</code>).</p>
  <p><a class="btn" href="/repos/edit">${e(t('norepo.cta'))}</a></p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(title, active, body))
}

// ---------------- agents ----------------
export async function pageAgents(req, res, url) {
  const sel = selectRepo(url)
  if (!sel) return noRepoPage(res, '/agents', t('nav.agents'))
  if (req.method === 'POST') return void res.writeHead(405).end()
  const agents = db.prepare('SELECT * FROM agents WHERE repo_id=? ORDER BY name').all(sel.id)
  const rows = agents.map(a => `
  <tr>
    <td><form method="post" action="/agents/toggle" class="inline"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${sel.id}"><button>${e(a.active ? t('agents.on') : t('agents.off'))}</button></form></td>
    <td>${e(a.name)}</td><td>${e(a.harness)}</td><td>${e(a.model || '–')}</td>
    <td>${e(scheduleText(a))}</td><td>${a.expected_minutes} min</td>
    <td class="dim">${e(attachmentSummary(a.flows)) || '–'}</td>
    <td><form method="post" action="/agents/start" class="inline"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${sel.id}"><button>${e(t('agents.start_now'))}</button></form></td>
    <td><a href="/agents/edit?id=${a.id}&repo=${sel.id}">${e(t('agents.edit'))}</a></td>
  </tr>`).join('')
  const body = `
  <p><a class="btn" href="/agents/edit?repo=${sel.id}">${e(t('agents.create'))}</a>
     <a class="btn" href="/flows">${e(t('nav.flows'))}</a>
     <span class="dim">${e(t('agents.flows_hint'))}</span></p>
  <table class="list"><thead><tr><th>${e(t('agents.status'))}</th><th>${e(t('agents.name'))}</th><th>${e(t('agents.harness'))}</th><th>${e(t('agents.model'))}</th><th>${e(t('agents.schedule'))}</th><th>${e(t('agents.expected'))}</th><th>${e(t('nav.flows'))}</th><th></th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="9" class="dim">${e(t('agents.none'))}</td></tr>`}</tbody></table>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('nav.agents'), '/agents', body, sel.id))
}

// ---------------- single-run form (= agent form without name and schedule) ----------------
export async function pageRunForm(req, res, url) {
  const sel = selectRepo(url)
  if (!sel) return noRepoPage(res, '', t('runform.title_short'))
  const agentId = url.searchParams.get('agent')
  const a = agentId ? db.prepare('SELECT * FROM agents WHERE id=?').get(+agentId) : null
  // Without an agent as a template: the setup of the last start — in practice
  // the next run wants the same coding agent, provider, model and effort.
  const fields = `
  ${runTitleField({})}
  ${runDefFields(a ?? lastRunChoice())}
  ${runStartTimeFields({})}
  <input type="hidden" name="repo_id" value="${sel.id}">
  <label class="chk"><input type="checkbox" name="save_agent" value="1"> ${e(t('runform.save_agent'))} (<input name="agent_name" placeholder="agent-name">)</label>`
  const body = `
  <h2>${e(t('runform.title', { repo: sel.name }))}${a ? ` (${e(t('runform.like_agent', { agent: a.name }))})` : ''}</h2>
  <form method="post" action="/runs/new">${fields}<button>${e(t('runform.start'))}</button>
  ${pipelineAn()
    ? `<span class="dim"> ${e(t('runform.pipeline_on_hint'))}</span>`
    : `<span class="warn"> ${e(t('runform.pipeline_off_hint'))}</span>`}</form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('runform.title_short'), '', body, sel.id))
}

// ---------------- run detail page ----------------
export async function pageRun(req, res, url, id) {
  const run = getRun(id)
  if (!run) { res.writeHead(404).end(t('run.not_found')); return }
  const repo = getRepo(run.repo_id)
  const agentName = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name ?? null : null
  const titel = runTitle(run, agentName, t('overview.single_run'))
  const herkunft = agentName ? t('overview.from_agent', { agent: agentName }) : t('overview.single_run')
  const events = db.prepare(`SELECT * FROM events WHERE run_id=? AND kind NOT LIKE 'telegram_sent%' ORDER BY id`).all(id)
  // Log (ANSI-cleaned), last excerpt
  const { readFileSync, existsSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const logf = join(process.env.CCHUB_RUNS_DIR ?? `${process.env.HOME}/agents/runs`, id, 'log.txt')
  let logHtml = `<p class="dim">${e(t('run.no_log'))}</p>`
  if (existsSync(logf)) {
    try {
      const size = statSync(logf).size
      const raw = readFileSync(logf).subarray(Math.max(0, size - 100_000)).toString('utf8')
      logHtml = `<pre id="log">${e(raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''))}</pre>`
    } catch {}
  }
  // "live" means: there really is a session one can attach to. Judged only by
  // status, the page promised a terminal that did not exist.
  const live = ['running', 'waiting_help'].includes(run.status) && !!run.tmux_session && !run.tmux_closed_at
  const body = `
  <h2>${AMPEL_DOT[ampel(run)]} ${titleInline(id, titel)} <span class="dim">(${run.status})</span></h2>
  ${run.status === 'scheduled'
    // A planned run must be revocable — otherwise a start you thought better of
    // sits in the future with no way to stop it. 'kill' is exactly right here:
    // there is no session to end, only a record to set to 'aborted'.
    ? `<div class="banner warten">⏳ ${wartetAuf(run)}
       <form method="post" action="/api/runs/${id}/kill" class="inline"><button class="danger">${e(t('start.cancel'))}</button></form></div>`
    : ''}
  <p class="dim">${e(t('run.title', { id: id.slice(0, 8) }))} · ${e(herkunft)} · ${e(t('layout.repo'))} „${e(repo?.name ?? '?')}“, ${e(t('agents.harness'))} ${e(run.harness)}${run.model ? `, ${t('agents.model')} ` + e(run.model) : ''}
   ${run.provider ? `· Provider ${e(run.provider)}${run.or_provider ? ` (${e(t('run.pinned'))}: ${e(run.or_provider)})` : ''} ` : ''}· ${e(t('run.start'))} ${e(run.started_at)}${run.ended_at ? ' · ' + e(t('run.end')) + ' ' + e(run.ended_at) : ''}
   · ${e(t('run.expectation'))} ${run.expected_minutes} min · ${e(t('run.workdir'))} <code>${e(run.workdir_effective ?? '')}</code>
   ${skillListe(run.skills).length ? `· ${e(t('skills.title'))}: <b>${skillAnzeige(run.skills).map(e).join(', ')}</b>` : ''}</p>
  ${run.help_text
    ? run.status === 'waiting_help'
      // open: the agent is waiting for an answer right now
      ? `<div class="help"><b>${e(t('run.help_call'))}:</b> ${e(run.help_text)}
         <form method="post" action="/api/runs/${id}/send"><textarea name="text" rows="3" placeholder="${e(t('run.answer_ph'))}"></textarea><button>${e(t('run.send_answer'))}</button></form></div>`
      // done: show as history, not as an open question
      : `<p class="dim"><b>${e(t('run.help_answered'))}:</b> ${e(run.help_text)}${run.help_answer ? ` → <i>${e(run.help_answer)}</i>` : ''}</p>`
    : ''}
  <details ${live ? 'open' : ''}><summary>${e(t('run.terminal'))} ${e(live ? t('run.terminal_live') : t('run.terminal_closed'))}</summary>
    <div id="term" data-session="${run.tmux_session && !run.tmux_closed_at ? '1' : '0'}" data-live="${live ? '1' : '0'}"></div>
    ${live ? `<form onsubmit="return cchubSend(this,'/api/runs/${id}/send')"><textarea name="text" rows="3" placeholder="${e(t('run.send_text_ph'))}"></textarea><button>${e(t('run.send'))}</button></form>
    <form onsubmit="return cchubKill('${id}')"><button class="danger">${e(t('run.kill'))}</button></form>` : ''}
  </details>
  ${['failed', 'aborted'].includes(run.status)
    ? `<form method="post" action="/api/runs/${id}/retry"><button>${e(t('run.retry'))}</button>
       <span class="dim">${e(t('run.retry_hint'))}</span></form>`
    : ''}
  ${run.report_md ? `<h3>${e(t('run.report'))}</h3><pre>${e(run.report_md)}</pre>` : ''}
  ${flowSection(run)}
  ${vorfallAbschnitt(id, run.status)}
  <h3>${e(t('run.metrics'))}</h3>
  <ul>
    <li>${e(t('run.runtime'))}: ${fmtLaufzeit(run)} · ${e(t('run.expectation'))} ${run.expected_minutes} min</li>
    <li>${e(t('run.tokens'))}: in ${run.tokens_in ?? 0}, out ${run.tokens_out ?? 0}</li>
    <li>${e(t('run.costs'))}: ${run.cost_eur != null ? run.cost_eur.toFixed(2) + ' € (' + e(t('run.abo_delta')) + ')' : run.cost_usd != null ? run.cost_usd.toFixed(4) + ' $' : '–'}</li>
    <li>${e(t('run.activity'))}: ${e(run.last_activity_at ?? '–')}</li>
    <li>${e(t('run.branch_reported'))}: ${e(run.branch_reported ?? '–')} · ${e(t('run.branch_expected'))}: ${e(run.branch_expected ?? '–')} · PR: ${run.pr_url ? `<a href="${e(run.pr_url)}">${e(run.pr_url)}</a>` : '–'}</li>
    <li>Exit: ${run.exit_code ?? '–'}${run.tmux_closed_at ? ' · ' + e(t('run.tmux_closed')) + ' ' + e(run.tmux_closed_at) : ''}</li>
  </ul>
  <h3>${e(t('run.events'))}</h3><ul class="events">${events.map(ev => `<li><span class="dim">${e(ev.ts)}</span> ${e(ev.kind)}</li>`).join('') || `<li class="dim">${e(t('run.none'))}</li>`}</ul>
  <h3>${e(t('run.log'))}</h3>${logHtml}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(titel, '/', body, run.repo_id, true))
}

function fmtLaufzeit(run) {
  const endeMs = run.ended_at ? Date.parse(run.ended_at.replace(' ', 'T') + 'Z') : Date.now()
  const min = Math.round((endeMs - Date.parse(run.started_at.replace(' ', 'T') + 'Z')) / 60000)
  return `${min} min${run.ended_at ? '' : ' (' + t('run.running') + ')'}`
}

/**
 * Incidents on the detail page: open ones with a resolve button, resolved ones
 * as history. The evidence (the line that fired) is shown — otherwise a false
 * alarm cannot be told apart from a real one.
 */
function vorfallAbschnitt(runId, runStatus = null) {
  const alle = alleVorfaelle(runId)
  if (!alle.length) return ''
  const zeile = (v) => `<li class="vorfall-zeile ${v.geloest_am ? 'geloest' : v.schwere}">
    <b>${e(typName(v.typ))}</b> <span class="dim">(${e(v.quelle)}, ${v.schwere})</span>
    · ${v.anzahl}× · ${e(t('incidents.first'))} ${e(v.erst_gesehen)} · ${e(t('incidents.last'))} ${e(v.zuletzt_gesehen)} UTC
    ${v.wieder_geoeffnet ? `· ${e(t('incidents.reopened', { n: v.wieder_geoeffnet }))}` : ''}
    ${v.geloest_am ? `· ${e(t('incidents.resolved_at'))} ${e(v.geloest_am)} (${e(v.geloest_von ?? '')})` : `
      <form method="post" action="/api/incidents/${v.id}/resolve" class="inline"><input type="hidden" name="back" value="/runs/${runId}"><button>${e(t(brauchtMensch(v, runStatus) ? 'incidents.mark_handled' : 'incidents.dismiss'))}</button></form>`}
    ${v.beleg ? `<br><code class="beleg">${e(v.beleg)}</code>` : ''}</li>`
  const offen = alle.filter(v => !v.geloest_am), zu = alle.filter(v => v.geloest_am)
  // The split the single "resolve" button was missing: what is waiting for
  // hands, and what the hub merely wrote down. Both stay visible — but only the
  // first group is a to-do.
  const handeln = offen.filter(v => brauchtMensch(v, runStatus))
  const notiz = offen.filter(v => !brauchtMensch(v, runStatus))
  return `<h3>${e(t('incidents.title'))}</h3>
  ${handeln.length ? `<h4 class="vorfall-gruppe rot">${e(t('incidents.needs_you', { n: handeln.length }))}</h4>
    <p class="dim">${e(t('incidents.needs_you_hint'))}</p>
    <ul class="vorfaelle">${handeln.map(zeile).join('')}</ul>` : ''}
  ${notiz.length ? `<h4 class="vorfall-gruppe gelb">${e(t('incidents.noticed', { n: notiz.length }))}</h4>
    <p class="dim">${e(t('incidents.noticed_hint'))}</p>
    <ul class="vorfaelle">${notiz.map(zeile).join('')}</ul>` : ''}
  ${offen.length ? `<form method="post" action="/api/runs/${runId}/incidents/resolve-all"><button>${e(t('incidents.resolve_all'))}</button>
    <span class="dim">${e(t('incidents.resolve_hint'))}</span></form>` : ''}
  ${zu.length ? `<details><summary class="dim">${e(t('incidents.resolved_n', { n: zu.length }))}</summary><ul class="vorfaelle">${zu.map(zeile).join('')}</ul></details>` : ''}
  <p class="dim">${e(t('incidents.detector_log'))}: <code>${e(join(process.env.CCHUB_RUNS_DIR ?? `${process.env.HOME}/agents/runs`, runId, 'detektor.jsonl'))}</code></p>`
}

// ---------------- repos ----------------
export async function pageRepos(req, res, url) {
  const repos = db.prepare('SELECT * FROM repos ORDER BY name').all()
  const rows = repos.map(r => `
  <tr><td>${e(r.name)}</td><td><code>${e(r.path)}</code></td><td>${e(r.base_branch)}</td>
  <td class="dim">${e(r.worktree_extras)}</td>
  <td><a href="/repos/edit?id=${r.id}">${e(t('agents.edit'))}</a></td></tr>`).join('')
  const body = `
  <p><a class="btn" href="/repos/edit">${e(t('repos.create'))}</a></p>
  <table class="list"><thead><tr><th>${e(t('repos.name'))}</th><th>${e(t('repos.path'))}</th><th>${e(t('repos.base'))}</th><th>${e(t('repos.extras'))}</th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="5" class="dim">${e(t('repos.none'))}</td></tr>`}</tbody></table>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('nav.repos'), '/repos', body))
}

// ---------------- settings ----------------
export async function pageSettings(req, res, url) {
  const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]))
  const body = `
  <h2>${e(t('nav.settings'))}</h2>
  <p class="dim">${e(t('settings.global_hint'))}</p>
  <p><a class="btn" href="/settings/coding-agents">${e(t('ca.title'))}</a>
     <span class="dim">${e(t('settings.coding_agents_hint'))}</span></p>
  <form method="post" action="/settings/save" class="settings">
    <label>${e(t('settings.language'))} <select name="ui_language">${Object.entries(LANGUAGES).map(([code, label]) =>
      `<option value="${code}" ${(s.ui_language ?? 'en') === code ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>
    <label>${e(t('settings.pipeline'))} <select name="pipeline_on"><option value="1" ${s.pipeline_on === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${s.pipeline_on !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select></label>
    <label>${e(t('settings.telegram_token'))} <input name="telegram_token" type="password" value="${e(s.telegram_token ?? '')}"></label>
    <label>${e(t('settings.telegram_chat'))} <input name="telegram_chat" value="${e(s.telegram_chat ?? '')}"></label>
    <label>${e(t('settings.quota_threshold'))} <input name="quota_threshold" type="number" value="${e(s.quota_threshold ?? '90')}"></label>
    <label>${e(t('settings.openrouter_min'))} <input name="openrouter_min_eur" type="number" step="0.5" value="${e(s.openrouter_min_eur ?? '5')}"></label>
    <label>${e(t('settings.abo_price'))} <input name="abo_price" type="number" value="${e(s.abo_price ?? '200')}"></label>
    <label>${e(t('settings.cursor_included'))} <input name="cursor_included_usd" type="number" step="1" value="${e(s.cursor_included_usd ?? '20')}"></label>
    <label>${e(t('settings.retention'))} <input name="retention_days" type="number" value="${e(s.retention_days ?? '3')}"></label>
    <label>${e(t('settings.prompt_suffix'))} <textarea name="prompt_suffix" rows="12">${e(s.prompt_suffix ?? '')}</textarea></label>
    <fieldset><legend>${e(t('settings.llm_legend'))}</legend>
      <p class="dim">${e(t('settings.llm_hint'))} ${process.env.OPENROUTER_API_KEY ? '' : `<b class="warn">${e(t('settings.llm_missing_key'))}</b>`}</p>
      <label>${e(t('settings.llm_on'))} <select name="llm_check_on"><option value="0" ${s.llm_check_on !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option><option value="1" ${s.llm_check_on === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option></select></label>
      <label>${e(t('settings.llm_model'))} <input name="llm_check_model" list="llm-mru" value="${e(s.llm_check_model ?? '')}" placeholder="vendor/model">
        <datalist id="llm-mru">${llmModelleMru().map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">${e(t('settings.llm_mru_hint'))}</span></label>
      <label>${e(t('settings.llm_or_provider'))} <input name="llm_check_or_provider" value="${e(s.llm_check_or_provider ?? '')}" placeholder="${e(t('settings.llm_or_ph'))}"></label>
    </fieldset>
    <fieldset><legend>${e(t('settings.title_legend'))}</legend>
      <p class="dim">${e(t('settings.title_hint'))} ${process.env.OPENROUTER_API_KEY ? '' : `<b class="warn">${e(t('settings.llm_missing_key'))}</b>`}</p>
      <label>${e(t('settings.title_on'))} <select name="llm_title_on"><option value="1" ${(s.llm_title_on ?? '1') === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${(s.llm_title_on ?? '1') !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select></label>
      <label>${e(t('settings.title_model'))} <input name="llm_title_model" list="title-mru" value="${e(s.llm_title_model || DEFAULT_TITLE_MODEL)}" placeholder="${e(DEFAULT_TITLE_MODEL)}">
        <datalist id="title-mru">${[...new Set([DEFAULT_TITLE_MODEL, ...titleModelsMru()])].map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">${e(t('settings.title_model_hint', { model: DEFAULT_TITLE_MODEL }))}</span></label>
      <label>${e(t('settings.llm_or_provider'))} <input name="llm_title_or_provider" value="${e(s.llm_title_or_provider ?? '')}" placeholder="${e(t('settings.llm_or_ph'))}"></label>
    </fieldset>
    <button>${e(t('settings.save'))}</button>
  </form>
  ${url.searchParams.get('telegram') === 'ok' ? `<p class="ok">✓ ${e(t('settings.telegram_ok'))}</p>` : ''}
  ${url.searchParams.get('telegram') === 'fehler' ? `<p class="err">${e(t('settings.telegram_fail'))}</p>` : ''}
  <p><a class="btn" href="/telegram-setup">${e(t('settings.telegram_setup'))}</a></p>
  <form method="post" action="/settings/test-telegram"><button>${e(t('settings.telegram_test'))}</button></form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('nav.settings'), '/settings', body))
}

// ---------------- coding agents (Settings → Coding agents) ----------------

function providerCheckboxes(plugin, chosen, prefix) {
  if (plugin.subscription || !(plugin.providers ?? []).length) {
    return `<p class="dim">${e(t('ca.no_providers'))}</p>`
  }
  return plugin.providers.map(pid => `<label class="chk">
    <input type="checkbox" name="${e(prefix)}" value="${e(pid)}" ${chosen.has(pid) ? 'checked' : ''}>
    ${e(providerLabel(pid))}${(plugin.keyFreeProviders ?? []).includes(pid) ? ` <span class="dim">(${e(t('provider.keyfree'))})</span>` : ''}</label>`).join('')
}

export async function pageCodingAgents(req, res, url) {
  const configured = listCodingAgents()
  const installed = await detectInstalled()
  const installedById = new Map(installed.map(i => [i.id, i.installed]))

  const rows = configured.map(a => {
    const plugin = a.plugin
    if (!plugin) {
      return `<div class="card"><b>${e(a.harness)}</b> <span class="err">${e(t('ca.plugin_missing'))}</span>
      <form method="post" action="/settings/coding-agents/delete" class="inline"><input type="hidden" name="id" value="${a.id}"><button class="danger">${e(t('ca.delete'))}</button></form></div>`
    }
    const chosen = new Set(a.providerIds)
    return `<div class="card ${a.enabled ? 'ok' : ''}">
    <h3>${e(plugin.label)} <span class="dim">(${e(plugin.bin)}${installedById.get(a.harness) ? ` — ${e(t('ca.installed'))}` : ` — <b class="warn">${e(t('ca.not_installed'))}</b>`})</span></h3>
    <form method="post" action="/settings/coding-agents/save">
      <input type="hidden" name="harness" value="${e(a.harness)}">
      <label class="chk"><input type="checkbox" name="enabled" value="1" ${a.enabled ? 'checked' : ''}> ${e(t('ca.enabled'))}</label>
      <fieldset><legend>${e(t('ca.providers_legend'))}</legend>
        <p class="dim">${e(t('ca.providers_hint'))}</p>
        ${providerCheckboxes(plugin, chosen, 'providers')}
      </fieldset>
      <button>${e(t('settings.save'))}</button>
    </form>
    <form method="post" action="/settings/coding-agents/delete" class="inline" onsubmit="return confirm(${JSON.stringify(t('ca.delete_confirm', { label: plugin.label }))})">
      <input type="hidden" name="id" value="${a.id}"><button class="danger">${e(t('ca.delete'))}</button></form>
  </div>`
  }).join('')

  const addable = unconfiguredHarnessIds().map(id => getHarness(id)).filter(Boolean)
    // Installed ones first — those are the natural suggestions.
    .sort((a, b) => (installedById.get(b.id) ? 1 : 0) - (installedById.get(a.id) ? 1 : 0))
  const addBlocks = addable.map(plugin => `
  <div class="card">
    <h3>${e(plugin.label)} ${installedById.get(plugin.id)
      ? `<span class="ok">✓ ${e(t('ca.detected'))}</span>`
      : `<span class="dim">${e(t('ca.not_installed'))}</span>`}</h3>
    ${installedById.get(plugin.id) ? '' : `<p class="dim">${e(t('ca.install_hint'))}: <code>${e(plugin.installHint)}</code></p>`}
    <form method="post" action="/settings/coding-agents/save">
      <input type="hidden" name="harness" value="${e(plugin.id)}">
      <input type="hidden" name="enabled" value="1">
      <fieldset><legend>${e(t('ca.providers_legend'))}</legend>
        ${providerCheckboxes(plugin, new Set(plugin.providers ?? []), 'providers')}
      </fieldset>
      <button>${e(t('ca.add'))}</button>
    </form>
  </div>`).join('')

  const body = `
  <h2>${e(t('ca.title'))}</h2>
  <p class="dim">${e(t('ca.intro'))}</p>
  ${rows || `<p class="dim">${e(t('ca.none'))}</p>`}
  <h2>${e(t('ca.add_title'))}</h2>
  ${addBlocks || `<p class="dim">${e(t('ca.all_configured'))}</p>`}
  <p class="dim">${e(t('ca.detect_note'))}</p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('ca.title'), '/settings', body))
}

export async function codingAgentSave(req, res, url, formBody) {
  const b = await formBody()
  const r = saveCodingAgent({
    harness: String(b.harness ?? ''),
    enabled: b.enabled === '1' || b.enabled === 'on' ? 1 : 0,
    providers: b.providers_list ?? (b.providers ? [b.providers] : []),
  })
  if (!r.ok) return problemPage(res, t('ca.title'), r.problems, '/settings/coding-agents')
  redirect(res, '/settings/coding-agents')
}

export async function codingAgentDelete(req, res, url, formBody) {
  const b = await formBody()
  deleteCodingAgent(+b.id)
  redirect(res, '/settings/coding-agents')
}

// ---------------- form actions ----------------
import { redirect } from './web-helpers.mjs'
import { startForAgent, startRun } from './scheduler.mjs'
import { setSetting } from './db.mjs'
import { sendTest } from './telegram.mjs'

export async function runNewPost(req, res, url, formBody) {
  const b = await formBody()
  const back = `/runs/new?repo=${b.repo_id ?? ''}`
  const problems = []
  const def = await runDefFromForm(b, problems)
  const start = runStartFromForm(b, problems)
  if (problems.length) return problemPage(res, t('runform.title_short'), problems, back)
  rememberRunChoice(def)
  // "Save as agent": the very same definition, only with a name — the run form
  // is the agent form without one.
  if (b.save_agent === 'on' || b.save_agent === '1') {
    try {
      saveAgent({ repoId: +b.repo_id, name: b.agent_name?.trim() || `agent-${Date.now()}`, def })
    } catch { /* duplicate name: the run is what matters, not the copy */ }
  }
  const r = await startRun(def, { repoId: +b.repo_id, ...start })
  if (!r.runId) return problemPage(res, t('runform.title_short'), [r.error ?? 'start failed'], back)
  redirect(res, `/runs/${r.runId}`)
}

/**
 * Schedule selection: four kinds of which only the fitting one is visible
 * (switching lives in hub.js). Cron stays as an expert field — the other three
 * kinds cover what 5-field cron cannot express (n-weekly, one-off date).
 */
function zeitplanFelder(a = {}) {
  const kind = a.schedule_kind ?? 'manuell'
  const tage = String(a.schedule_days ?? '').split(',').filter(x => x !== '').map(Number)
  const heute = new Date().toISOString().slice(0, 10)
  const arten = [
    ['manuell', t('sched.kind_manual')],
    ['woechentlich', t('sched.kind_weekly')],
    ['einmalig', t('sched.kind_once')],
    ['cron', t('sched.kind_cron')],
  ]
  return `
  <fieldset class="zeitplan">
    <legend>${e(t('sched.legend'))}</legend>
    <label>${e(t('sched.kind'))} <select name="schedule_kind" id="schedule-kind">
      ${arten.map(([v, txt]) => `<option value="${v}" ${kind === v ? 'selected' : ''}>${e(txt)}</option>`).join('')}
    </select></label>

    <div class="zp" data-kind="woechentlich">
      <div class="tage">${WOCHENTAGE.map(w => `
        <label class="tag"><input type="checkbox" name="schedule_days" value="${w.n}"
          ${tage.includes(w.n) ? 'checked' : ''}> ${e(t(w.key))}</label>`).join('')}
      </div>
      <label>${e(t('sched.time'))} <input type="time" name="schedule_time" value="${e(a.schedule_time ?? '06:00')}"></label>
      <label>${e(t('sched.interval'))} <select name="schedule_weeks">
        ${[1, 2, 3, 4].map(n => `<option value="${n}" ${Number(a.schedule_weeks ?? 1) === n ? 'selected' : ''}>${e(n === 1 ? t('sched.every_week') : t('sched.every_n_weeks', { n }))}</option>`).join('')}
      </select></label>
      <label>${e(t('sched.anchor'))} <input type="date" name="schedule_anchor" value="${e(a.schedule_anchor ?? heute)}"></label>
    </div>

    <div class="zp" data-kind="einmalig">
      <label>${e(t('sched.once_at'))} <input type="datetime-local" name="run_at" value="${e(a.run_at ?? '')}"></label>
      <p class="dim">${e(t('sched.once_hint'))}</p>
    </div>

    <div class="zp" data-kind="cron">
      <label>${e(t('sched.cron_label'))} <input name="schedule" value="${e(a.schedule ?? '')}" placeholder="${e(t('sched.cron_ph'))}"></label>
      <p class="dim">${e(t('sched.cron_hint'))}</p>
    </div>
  </fieldset>`
}

/**
 * The agent form = the run definition (run-def.mjs) plus what only an agent
 * has: a name, a schedule, an on/off switch.
 */
function agentFields(a = {}, repoId) {
  return `
  <label>${e(t('agents.name'))} <input name="name" value="${e(a.name ?? '')}" required></label>
  ${runDefFields(a)}
  <input type="hidden" name="repo_id" value="${repoId}">
  ${zeitplanFelder(a)}
  <label class="chk"><input type="checkbox" name="active" value="1" ${a.active ?? 1 ? 'checked' : ''}> ${e(t('agents.active'))}</label>`
}

export async function agentEdit(req, res, url) {
  const id = url.searchParams.get('id')
  // A new agent starts from the setup of the last start, an existing one from
  // what is saved.
  const a = id ? db.prepare('SELECT * FROM agents WHERE id=?').get(+id) : lastRunChoice()
  const repoId = +(url.searchParams.get('repo') ?? db.prepare('SELECT id FROM repos ORDER BY name LIMIT 1').get()?.id ?? 0)
  const body = `<h2>${e(id ? t('agentform.title_edit') : t('agentform.title_new'))}</h2>
  <form method="post" action="/agents/edit${id ? `?id=${id}` : ''}" class="settings">${agentFields(a, repoId)}<button>${e(t('settings.save'))}</button></form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(id ? t('agentform.title_edit') : t('agentform.title_new'), '/agents', body, repoId))
}

export async function agentSave(req, res, url, formBody) {
  const id = url.searchParams.get('id')
  const b = await formBody()
  const active = b.active ? 1 : 0
  const back = `/agents/edit${id ? `?id=${id}&repo=${b.repo_id ?? ''}` : `?repo=${b.repo_id ?? ''}`}`
  const problems = []
  if (!b.name?.trim()) problems.push(t('form.name_missing'))
  const def = await runDefFromForm(b, problems)
  const zp = zeitplanAusFormular(b, problems)
  if (problems.length) return problemPage(res, t('agentform.title_edit'), problems, back)

  saveAgent({ id: id ? +id : null, repoId: +b.repo_id, name: b.name.trim(), def, schedule: zp, active })
  rememberRunChoice(def)
  redirect(res, `/agents?repo=${b.repo_id}`)
}

/**
 * Read and validate the schedule from the form. Only the fields of the chosen
 * kind are taken over — otherwise old leftovers would survive a switch and the
 * agent would keep running after a change to "manual".
 */
function zeitplanAusFormular(b, problems) {
  const leer = { schedule: null, kind: 'manuell', days: null, time: null, weeks: null, anchor: null, run_at: null }
  switch (b.schedule_kind) {
    case 'woechentlich': {
      // Several same-named checkboxes: the URLSearchParams collector in
      // web-helpers keeps only the last value — hence the days arrive as a list.
      const tage = (b.schedule_days_list ?? []).map(Number).filter(n => n >= 0 && n <= 6)
      if (!tage.length) problems.push(t('sched.err_days'))
      if (!/^\d{2}:\d{2}$/.test(b.schedule_time ?? '')) problems.push(t('sched.err_time'))
      const weeks = Number(b.schedule_weeks) || 1
      if (![1, 2, 3, 4].includes(weeks)) problems.push(t('sched.err_weeks'))
      if (weeks > 1 && !/^\d{4}-\d{2}-\d{2}$/.test(b.schedule_anchor ?? '')) {
        problems.push(t('sched.err_anchor'))
      }
      return { ...leer, kind: 'woechentlich', days: tage.sort().join(','), time: b.schedule_time,
        weeks, anchor: weeks > 1 ? b.schedule_anchor : null }
    }
    case 'einmalig': {
      const at = (b.run_at ?? '').trim()
      if (!at || Number.isNaN(new Date(at).getTime())) problems.push(t('sched.err_at'))
      return { ...leer, kind: 'einmalig', run_at: at }
    }
    case 'cron': {
      const c = (b.schedule ?? '').trim()
      if (!c) problems.push(t('sched.err_cron_missing'))
      else if (!validCron(c)) problems.push(t('sched.err_cron', { expr: c }))
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
  // A manual start is allowed even with the pipeline switched off (planning
  // 4.8) — the switch only gates the SCHEDULED starts. Both branches used to
  // stand here, doing exactly the same thing.
  const r = await startForAgent(agent)
  redirect(res, r.runId ? `/runs/${r.runId}` : '/agents')
}

export async function repoEdit(req, res, url) {
  const id = url.searchParams.get('id')
  const r = id ? getRepo(+id) : {}
  const body = `<h2>${e(id ? t('repos.edit_title') : t('repos.create_title'))}</h2>
  <form method="post" action="/repos/edit${id ? `?id=${id}` : ''}" class="settings">
    <label>${e(t('repos.name'))} <input name="name" value="${e(r.name ?? '')}" required></label>
    <label>${e(t('repos.path_label'))} <input name="path" value="${e(r.path ?? '')}" placeholder="~/projects/my-project" required></label>
    <label>${e(t('repos.base'))} <input name="base_branch" value="${e(r.base_branch ?? 'main')}"></label>
    <label>${e(t('repos.extras_label'))} <textarea name="worktree_extras" rows="5">${e(r.worktree_extras ?? '[]')}</textarea></label>
    <button>${e(t('settings.save'))}</button>
  </form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('nav.repos'), '/repos', body))
}

export async function repoSave(req, res, url, formBody) {
  const id = url.searchParams.get('id')
  const b = await formBody()
  const back = `/repos/edit${id ? `?id=${id}` : ''}`
  const repoPath = (b.path ?? '').trim().replace(/^~/, process.env.HOME)
  const problems = []
  if (!b.name?.trim()) problems.push(t('form.name_missing'))
  if (!repoPath) problems.push(t('repos.path_missing'))
  // A wrong path would otherwise only surface at the first run ('git worktree' fails).
  else if (!existsSync(join(repoPath, '.git'))) problems.push(t('repos.no_git', { path: repoPath }))
  try {
    const extras = JSON.parse(b.worktree_extras || '[]')
    if (!Array.isArray(extras) || extras.some(x => typeof x?.path !== 'string' || !['copy', 'link'].includes(x?.mode))) {
      problems.push(t('repos.extras_invalid'))
    }
  } catch (err) {
    problems.push(t('repos.extras_json', { err: err.message }))
  }
  if (problems.length) return problemPage(res, t('repos.edit_title'), problems, back)
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
    'openrouter_min_eur', 'abo_price', 'cursor_included_usd', 'retention_days', 'prompt_suffix',
    'llm_check_on', 'llm_check_model', 'llm_check_or_provider',
    'llm_title_on', 'llm_title_model', 'llm_title_or_provider', 'ui_language']) {
    setSetting(k, b[k] ?? '')
  }
  // The language takes effect immediately — the redirect below already renders in it.
  setLanguage(b.ui_language ?? 'en')
  // "Used" means saved: only now does the model enter the MRU list.
  llmModellMerken(b.llm_check_model)
  rememberTitleModel(b.llm_title_model)
  redirect(res, '/settings')
}

export async function settingsTestTelegram(req, res) {
  // Without feedback this button clicks into the void: success and failure looked identical.
  const ok = await sendTest()
  redirect(res, `/settings?telegram=${ok ? 'ok' : 'fehler'}`)
}

// ---------------- Telegram setup assistant (planning 7.6, interactive) ----------------
// Guides through: 1) enter BotFather token  2) send /start to the bot
//                 3) pick the chat from getUpdates  4) send a test message.

export async function telegramSetup(req, res, url) {
  const s = Object.fromEntries(db.prepare(`SELECT key,value FROM settings`).all().map(r => [r.key, r.value]))
  const tokenSet = !!s.telegram_token
  const chatSet = !!s.telegram_chat

  const step1 = `
  <div class="card ${tokenSet ? 'ok' : ''}">
    <h3>${e(t('tg.step1'))}</h3>
    <p class="dim">${e(t('tg.step1_hint'))}</p>
    <form method="post" action="/telegram-setup/token" class="inline">
      <input name="telegram_token" type="password" placeholder="${e(t('tg.token_ph'))}" size="50" required>
      <button>${e(t('tg.token_save'))}</button>
    </form>
    ${tokenSet ? `<p class="ok">✓ ${e(t('tg.token_saved'))}</p>` : ''}
  </div>`

  const step2 = `
  <div class="card ${chatSet ? 'ok' : ''}">
    <h3>${e(t('tg.step2'))}</h3>
    <p class="dim">${e(t('tg.step2_hint'))}</p>
    <button id="tg-fetch">${e(t('tg.fetch'))}</button>
    <div id="tg-chats"></div>
    ${chatSet ? `<p class="ok">✓ ${e(t('tg.chat_saved'))}: <code>${e(s.telegram_chat)}</code></p>` : ''}
  </div>`

  const step3 = `
  <div class="card">
    <h3>${e(t('tg.step3'))}</h3>
    <form method="post" action="/settings/test-telegram"><button>${e(t('tg.send_test'))}</button></form>
    <p class="dim">${e(t('tg.step3_hint'))}</p>
  </div>`

  const body = `
  <h2>${e(t('tg.title'))}</h2>
  ${step1}${step2}${step3}
  <script>
  document.getElementById('tg-fetch')?.addEventListener('click', async () => {
    const box = document.getElementById('tg-chats')
    box.textContent = '…'
    try {
      const r = await fetch('/api/telegram/chats')
      const j = await r.json()
      if (!j.ok) { box.innerHTML = '<p class="err">' + j.error + '</p>'; return }
      if (!j.chats.length) { box.innerHTML = '<p class="warn">${e(t('tg.no_chats'))}</p>'; return }
      box.innerHTML = j.chats.map(c =>
        '<form method="post" action="/telegram-setup/chat"><input type="hidden" name="chat_id" value="' + c.id + '">' +
        '<button>${e(t('tg.use'))}: ' + c.label + ' (ID ' + c.id + ')</button></form>').join('')
    } catch (e2) { box.textContent = String(e2) }
  })
  </script>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(layout(t('tg.title'), '/settings', body))
}

export async function telegramTokenSave(req, res, url, formBody) {
  const b = await formBody()
  const token = b.telegram_token?.trim()
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token ?? '')) { res.writeHead(400).end(t('tg.token_invalid')); return }
  setSetting('telegram_token', token)
  redirect(res, '/telegram-setup')
}

export async function telegramChatSave(req, res, url, formBody) {
  const b = await formBody()
  if (!/^-?\d+$/.test(b.chat_id ?? '')) { res.writeHead(400).end(t('tg.chat_invalid')); return }
  setSetting('telegram_chat', b.chat_id)
  redirect(res, '/telegram-setup')
}

/** Read getUpdates and return known chats, deduplicated. */
export async function telegramChats(_req, res) {
  const token = db.prepare(`SELECT value FROM settings WHERE key='telegram_token'`).get()?.value
  if (!token) return jsonOut(res, 400, { ok: false, error: t('tg.no_token') })
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`, { signal: AbortSignal.timeout(15_000) })
    const j = await r.json()
    if (!j.ok) return jsonOut(res, 200, { ok: false, error: `Telegram: ${j.description ?? 'unknown error'}` })
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
  } catch (err) {
    jsonOut(res, 200, { ok: false, error: t('tg.unreachable', { err: err.message }) })
  }
}

function jsonOut(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
}
