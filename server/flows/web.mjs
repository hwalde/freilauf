// Freilauf flows — HTTP: pages (/flows, /flows/edit, /flows/runs, /flows/runs/<id>)
// and JSON API (/api/flows/*, /api/flow-runs/*). Mounted by ../web.mjs; the
// page chrome comes from ../pages.mjs (layout), everything else is local.
import db, {
  listFlows, getFlow, saveFlow, deleteFlow, toggleFlow, listFlowRuns, getFlowRun, autoFlowName,
} from './db.mjs'
import { stepsMeta, GROUPS, validateDefinition, definitionHints, defaultProps } from './steps.mjs'
import { OPS } from './template.mjs'
import { FIELD_TYPES } from './llm.mjs'
import { normalizeTrigger, runFlowNow, TRIGGER_KINDS, OUTCOMES } from './triggers.mjs'
import { agentsWithFlow, setFlowAttachments, forgetFlow, WHEN_KINDS } from './attach.mjs'
import { stopFlowRun } from './engine.mjs'
import { layout } from '../pages.mjs'
import { escapeHtml as e, validCron, fmtDbUtc, fmtDateTime, fmtClock } from '../util.mjs'
import { redirect, body as readBody, parseForm } from '../web-helpers.mjs'
import { enabledCodingAgents } from '../coding-agents.mjs'
import { harnessLabel } from '../harnesses/index.mjs'
import { t, clientCatalog } from '../i18n.mjs'

const html = (res, code, page) => res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }).end(page)
const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))

// ---------------- meta for the editor ----------------
function agentsList() { return db.prepare('SELECT a.id, a.name, r.name AS repo FROM agents a JOIN repos r ON r.id=a.repo_id ORDER BY a.name').all() }
// Only ACTIVE repos: the designer's `repo` field is a dropdown like any other,
// and a flow aimed at a deactivated repo would never fire.
function reposList() { return db.prepare('SELECT id, name FROM repos WHERE active=1 ORDER BY name').all() }

export function editorMeta() {
  return {
    steps: stepsMeta(),
    groups: GROUPS,
    agents: agentsList(),
    repos: reposList(),
    harnesses: enabledCodingAgents().map(a => ({ id: a.harness, label: harnessLabel(a.harness) })),
    triggerKinds: TRIGGER_KINDS,
    outcomes: OUTCOMES,
    whenKinds: WHEN_KINDS,
    ops: OPS,
    fieldTypes: FIELD_TYPES,
  }
}

// ---------------- text helpers ----------------
function triggerText(flow) {
  const trig = normalizeTrigger(flow.trigger)
  if (trig.kind === 'cron') return `${t('flows.trigger.cron')}: ${trig.expr || '?'}`
  if (trig.kind === 'manual') return t('flows.trigger.manual')
  if (trig.kind === 'run_merged') {
    // This trigger's filter is its own — the repo, or all of them.
    const repo = trig.repoId ? db.prepare('SELECT name FROM repos WHERE id=?').get(trig.repoId) : null
    return `${t('flows.trigger.run_merged')}: ${repo?.name ?? t('flows.trigger.repo_all')}`
  }
  // The attachments ARE the trigger — so that is what the list shows.
  const on = agentsWithFlow(flow.id)
  const who = on.length
    ? on.map(a => a.when === 'always' ? a.name : `${a.name} (${t(`flows.when.${a.when}`)})`).join(', ')
    : t('flows.trigger.unattached')
  return `${t('flows.trigger.run_finished')}: ${who}`
}

const STATUS_DOT = { running: 'yellow', waiting: 'yellow', done: 'green', failed: 'red', stopped: 'red' }
const statusBadge = (s) => `<span class="dot ${STATUS_DOT[s] ?? 'yellow'}"></span> ${e(t(`flows.status.${s}`))}`

// ---------------- pages ----------------
async function pageList(req, res) {
  const flows = listFlows()
  const rows = flows.map(f => {
    const last = db.prepare('SELECT id, status, started_at FROM flow_runs WHERE flow_id=? ORDER BY started_at DESC LIMIT 1').get(f.id)
    return `<tr>
      <td><a href="/flows/edit?id=${f.id}">${e(f.name)}</a></td>
      <td>${e(triggerText(f))}</td>
      <td class="${f.active ? 'ok' : 'warn'}">${e(f.active ? t('flows.on') : t('flows.off'))}</td>
      <td>${last ? `<a href="/flows/runs/${last.id}">${statusBadge(last.status)} <span class="dim">${e(last.started_at)}</span></a>` : '<span class="dim">–</span>'}</td>
      <td class="acts">
        <a class="btn" href="/flows/edit?id=${f.id}">${e(t('flows.edit'))}</a>
        <a class="btn" href="/flows/runs?flow=${f.id}">${e(t('flows.runs'))}</a>
        <form method="post" action="/api/flows/${f.id}/run" class="inline"><button>${e(t('flows.run_now'))}</button></form>
        <form method="post" action="/api/flows/${f.id}/toggle" class="inline"><button>${e(f.active ? t('flows.turn_off') : t('flows.turn_on'))}</button></form>
        <form method="post" action="/api/flows/${f.id}/delete" class="inline" onsubmit="return confirm(${e(JSON.stringify(t('flows.delete_confirm')))})"><button class="danger">${e(t('flows.delete'))}</button></form>
      </td></tr>`
  }).join('')
  const body = `
  <link rel="stylesheet" href="/static/flows.css">
  <p class="crumbs"><a href="/agents">${e(t('nav.agents'))}</a> › ${e(t('nav.flows'))}</p>
  <p><a class="btn" href="/flows/edit">${e(t('flows.new'))}</a> <a class="btn" href="/flows/runs">${e(t('flows.runs.all'))}</a></p>
  <p class="dim">${e(t('flows.intro'))}</p>
  <table class="list flows"><thead><tr><th>${e(t('flows.name'))}</th><th>${e(t('flows.trigger'))}</th><th>${e(t('flows.active'))}</th><th>${e(t('flows.last_run'))}</th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="5" class="dim">${e(t('flows.none'))}</td></tr>`}</tbody></table>`
  html(res, 200, await layout(req, t('nav.flows'), '/flows', body))
}

/**
 * Where "Back" leads. A flow is reached from the agent or single-run form whose
 * end shall start it — that form is where one wants to return to, and it passes
 * itself in `back`. Only a local path is accepted (never `//host`, never a
 * scheme), so the parameter cannot turn the button into an open redirect. The
 * flow list is deliberately NOT the fallback: flows hang on a run definition,
 * not in a menu.
 */
function backTarget(url) {
  const raw = url.searchParams.get('back') ?? ''
  return /^\/(?!\/)[^\\]*$/.test(raw) ? raw : '/agents'
}

/**
 * Trigger and name a NEW flow starts with, from the query
 * (`?trigger=run_merged&repo=<id>`). Only what a page could legitimately have
 * sent: the kind goes through `normalizeTrigger()` like every other trigger,
 * and an unknown repo id simply yields "all repos" instead of a broken filter.
 * An existing flow is never touched by this — its trigger is what was saved.
 */
function newFlowPreset(url) {
  const kind = url.searchParams.get('trigger') ?? 'run_finished'
  const repoId = Number(url.searchParams.get('repo')) || null
  const trigger = normalizeTrigger({ kind, repoId })
  if (trigger.kind !== 'run_merged') return { name: '', trigger: normalizeTrigger({ kind: 'run_finished' }) }
  const repo = repoId ? db.prepare('SELECT name FROM repos WHERE id=?').get(repoId) : null
  if (!repo) trigger.repoId = null
  return { name: repo ? t('flows.name_after_merge', { repo: repo.name }) : '', trigger }
}

async function pageEditor(req, res, url) {
  const id = Number(url.searchParams.get('id')) || null
  const flow = id ? getFlow(id) : null
  if (id && !flow) return html(res, 404, await layout(req, t('nav.flows'), '/flows', `<p>${e(t('web.not_found'))}</p>`))
  // The attachments come from the agents, not from the flow — one storage, two
  // editors, so the agent form and this page can never disagree.
  // A new flow may arrive pre-aimed: the repo page's "new flow after merge"
  // button knows the trigger and the repo, and asking the operator to pick both
  // again on a page they were sent to from exactly there would be a form asking
  // what it was already told.
  const wanted = newFlowPreset(url)
  const data = flow
    ? { id: flow.id, name: flow.name, active: !!flow.active, trigger: normalizeTrigger(flow.trigger),
      definition: flow.definition, attachments: agentsWithFlow(flow.id) }
    : { id: null, name: wanted.name, active: true, trigger: wanted.trigger,
      definition: { properties: {}, sequence: [] }, attachments: [] }
  // Recent finished runs — for "run now with this run as the trigger".
  const recent = db.prepare(`SELECT r.id, r.status, r.ended_at, a.name AS agent FROM runs r LEFT JOIN agents a ON a.id=r.agent_id
    WHERE r.status IN ('done','failed','aborted') ORDER BY r.ended_at DESC LIMIT 30`).all()
  const back = backTarget(url)
  const body = `
  <link rel="stylesheet" href="/static/swd.css"><link rel="stylesheet" href="/static/swd-light.css"><link rel="stylesheet" href="/static/flows.css">
  <div class="flow-head">
    <a class="btn" id="flow-back" href="${e(back)}">${e(t('flows.editor.back'))}</a>
    <input id="flow-name" placeholder="${e(t('flows.name_optional'))}" value="${e(data.name)}">
    <label class="chk"><input type="checkbox" id="flow-active" ${data.active ? 'checked' : ''}> ${e(t('flows.active'))}</label>
    <span class="spacer"></span>
    <span id="flow-status" class="dim"></span>
    <button id="flow-save">${e(t('flows.editor.save'))}</button>
    ${data.id ? `<form method="post" action="/api/flows/${data.id}/run" class="inline" id="flow-run-now">
      <select name="run_id"><option value="">${e(t('flows.editor.sim_none'))}</option>${recent.map(r => `<option value="${r.id}">${e(r.agent ?? t('overview.single_run'))} · ${e(r.status)} · ${e(r.ended_at ?? '')}</option>`).join('')}</select>
      <button>${e(t('flows.run_now'))}</button></form>` : ''}
  </div>
  <div id="flow-designer"></div>
  <script>window.FREILAUF_FLOWS=${JSON.stringify({ i18n: clientCatalog('flows.'), meta: editorMeta(), flow: data }).replace(/</g, '\\u003c')}</script>
  <script src="/static/swd.js"></script><script src="/static/flows.js" type="module"></script>`
  html(res, 200, await layout(req, data.name || t('flows.new'), '/flows', body))
}

async function pageRuns(req, res, url) {
  const flowId = Number(url.searchParams.get('flow')) || null
  const runs = listFlowRuns(flowId)
  const rows = runs.map(fr => `<tr onclick="location='/flows/runs/${fr.id}'">
    <td><a href="/flows/runs/${fr.id}">${e(fr.flow_name)}</a></td>
    <td>${statusBadge(fr.status)}</td>
    <td>${e(t(`flows.trigger.${fr.context.trigger?.kind ?? 'manual'}`))}${fr.trigger_run_id ? ` · <a href="/runs/${fr.trigger_run_id}">${e(fr.context.trigger?.run?.agent_name || t('overview.single_run'))}</a>` : ''}</td>
    <td>${e(fmtDbUtc(fr.started_at))}</td><td>${e(fr.ended_at ? fmtDbUtc(fr.ended_at) : '')}</td>
    <td class="dim">${e(fr.error ?? (fr.log.at(-1)?.msg ?? ''))}</td></tr>`).join('')
  const body = `
  <p><a class="btn" href="${e(flowId ? `/flows/edit?id=${flowId}` : backTarget(url))}">${e(t('flows.editor.back'))}</a></p>
  <table class="list"><thead><tr><th>${e(t('flows.runs.flow'))}</th><th>${e(t('flows.runs.status'))}</th><th>${e(t('flows.trigger'))}</th><th>${e(t('flows.runs.started'))}</th><th>${e(t('flows.runs.ended'))}</th><th>${e(t('flows.runs.last_message'))}</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="6" class="dim">${e(t('flows.runs.none'))}</td></tr>`}</tbody></table>`
  html(res, 200, await layout(req, t('flows.runs.title'), '/flows', body))
}

async function pageRunDetail(req, res, id) {
  const fr = getFlowRun(id)
  if (!fr) return html(res, 404, await layout(req, t('nav.flows'), '/flows', `<p>${e(t('web.not_found'))}</p>`))
  const log = fr.log.map(l => `<tr class="${l.ok ? '' : 'err'}"><td class="dim">${e(fmtClock(Date.parse(l.ts), { seconds: true }))}</td><td>${e(l.name || '')}<span class="dim"> ${e(l.type)}</span></td><td>${e(l.msg)}${l.ms != null ? ` <span class="dim">${l.ms} ms</span>` : ''}</td></tr>`).join('')
  const trig = fr.context.trigger ?? {}
  const body = `
  <p><a class="btn" href="/flows/runs?flow=${fr.flow_id ?? ''}">${e(t('flows.editor.back'))}</a>
  ${fr.flow_id ? `<a class="btn" href="/flows/edit?id=${fr.flow_id}">${e(t('flows.edit'))}</a>` : ''}
  ${['running', 'waiting'].includes(fr.status) ? `<form method="post" action="/api/flow-runs/${fr.id}/stop" class="inline"><button class="danger">${e(t('flows.runs.stop'))}</button></form>` : ''}</p>
  <div class="card"><b>${e(fr.flow_name)}</b> — ${statusBadge(fr.status)}
    <div class="dim">${e(t('flows.runs.started'))}: ${e(fmtDbUtc(fr.started_at))} · ${e(t('flows.runs.ended'))}: ${e(fr.ended_at ? fmtDbUtc(fr.ended_at) : '–')}</div>
    <div>${e(t('flows.trigger'))}: ${e(t(`flows.trigger.${trig.kind ?? 'manual'}`))}${trig.run ? ` · <a href="/runs/${trig.run.id}">${e(trig.run.agent_name || t('overview.single_run'))} (${e(trig.run.outcome)})</a>` : ''}</div>
    ${fr.wait_run_id ? `<div>${e(t('flows.runs.waiting_on'))}: <a href="/runs/${fr.wait_run_id}">${e(fr.wait_run_id)}</a></div>` : ''}
    ${fr.resume_at ? `<div>${e(t('flows.runs.resume_at'))}: ${e(fmtDateTime(Date.parse(fr.resume_at)))}</div>` : ''}
    ${fr.error ? `<div class="err">${e(t('flows.runs.error'))}: ${e(fr.error)}</div>` : ''}
  </div>
  <h3>${e(t('flows.runs.log'))}</h3>
  <table class="list"><thead><tr><th></th><th>${e(t('flows.runs.step'))}</th><th>${e(t('flows.runs.message'))}</th></tr></thead><tbody>${log || `<tr><td colspan="3" class="dim">–</td></tr>`}</tbody></table>
  <h3>${e(t('flows.runs.vars'))}</h3>
  <pre>${e(JSON.stringify(fr.context.vars ?? {}, null, 2))}</pre>
  <details><summary>${e(t('flows.runs.trigger_data'))}</summary><pre>${e(JSON.stringify(trig, null, 2))}</pre></details>`
  html(res, 200, await layout(req, fr.flow_name, '/flows', body))
}

// ---------------- routing ----------------
export async function flowRoute(req, res, url) {
  const path = url.pathname
  let m
  if (req.method === 'GET' && path === '/flows') return pageList(req, res)
  if (req.method === 'GET' && path === '/flows/edit') return pageEditor(req, res, url)
  if (req.method === 'GET' && path === '/flows/runs') return pageRuns(req, res, url)
  if (req.method === 'GET' && (m = path.match(/^\/flows\/runs\/([0-9a-f-]{36})$/))) return pageRunDetail(req, res, m[1])
  res.writeHead(404, { 'content-type': 'text/plain' }).end(t('web.not_found'))
}

const wantsHtml = (req) => (req.headers.accept ?? '').includes('text/html')
const answer = (req, res, code, obj, backTo) => (wantsHtml(req) ? redirect(res, backTo) : json(res, code, obj))

export async function flowApi(req, res, url) {
  const path = url.pathname
  let m
  if (req.method === 'GET' && path === '/api/flows/meta') return json(res, 200, { ok: true, ...editorMeta() })
  if (req.method === 'GET' && path === '/api/flows') return json(res, 200, { ok: true, flows: listFlows() })
  if (req.method === 'POST' && path === '/api/flows/save') {
    let b
    try { b = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { ok: false, problems: ['invalid JSON'] }) }
    // The name is OPTIONAL. A flow hangs on the agent or the single run whose
    // end starts it; whether that is one flow or four, naming each of them is a
    // hurdle, not information. Left empty, the hub picks a free "Flow n" — the
    // row still needs something unique for the lists and for `flow_runs.flow_name`.
    const name = String(b.name ?? '').trim() || autoFlowName()
    const problems = []
    const trigger = normalizeTrigger(b.trigger)
    if (trigger.kind === 'cron' && !validCron(trigger.expr)) problems.push(t('flows.editor.cron_invalid'))
    const definition = b.definition && typeof b.definition === 'object' ? b.definition : { properties: {}, sequence: [] }
    problems.push(...validateDefinition(definition, trigger,
      (p) => t(`flows.placement.${p.code}.why`, { step: p.stepName })))
    if (problems.length) return json(res, 400, { ok: false, problems })
    const dup = db.prepare('SELECT id FROM flows WHERE name = ? AND id <> ?').get(name, Number(b.id) || 0)
    if (dup) return json(res, 400, { ok: false, problems: [t('flows.editor.name_taken')] })
    const id = saveFlow({ id: Number(b.id) || null, name, active: b.active ? 1 : 0, trigger, definition })
    // The attachment list is not part of the flow row — it is written back onto
    // the agents, which is where the agent form reads it from.
    //
    // Only when the request actually CARRIED the list. It used to write on every
    // save, so a caller that left `attachments` out — a partial save, a script,
    // anything but the designer, which always sends it — silently detached the
    // flow from every agent it hung on. Absent is "did not say", not "none";
    // an explicit empty array still detaches, because that is somebody saying it.
    if (trigger.kind !== 'run_finished') forgetFlow(id)   // a flow that no longer reacts to runs must not stay hanging on agents
    else if (Object.hasOwn(b, 'attachments')) setFlowAttachments(id, b.attachments)
    // Hints travel with the answer: saving succeeded, the designer still shows them.
    return json(res, 200, { ok: true, id, hints: definitionHints(definition, trigger) })
  }
  if (req.method === 'GET' && (m = path.match(/^\/api\/flows\/(\d+)$/))) {
    const f = getFlow(+m[1])
    return f ? json(res, 200, { ok: true, flow: f }) : json(res, 404, { ok: false })
  }
  if (req.method === 'GET' && path === '/api/flows/step-defaults') {
    return json(res, 200, { ok: true, properties: defaultProps(url.searchParams.get('type') ?? '') })
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/flows\/(\d+)\/run$/))) {
    const f = getFlow(+m[1])
    if (!f) return answer(req, res, 404, { ok: false, error: 'unknown flow' }, '/flows')
    const b = parseForm(await readBody(req))
    try {
      const flowRunId = await runFlowNow(f, b.run_id || null)
      return answer(req, res, 200, { ok: true, flowRunId }, `/flows/runs/${flowRunId}`)
    } catch (err) { return answer(req, res, 400, { ok: false, error: err.message }, `/flows/runs?flow=${f.id}`) }
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/flows\/(\d+)\/toggle$/))) {
    toggleFlow(+m[1]); return answer(req, res, 200, { ok: true }, '/flows')
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/flows\/(\d+)\/delete$/))) {
    forgetFlow(+m[1]); deleteFlow(+m[1]); return answer(req, res, 200, { ok: true }, '/flows')
  }
  if (req.method === 'GET' && (m = path.match(/^\/api\/flow-runs\/([0-9a-f-]{36})$/))) {
    const fr = getFlowRun(m[1])
    return fr ? json(res, 200, { ok: true, flowRun: fr }) : json(res, 404, { ok: false })
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/flow-runs\/([0-9a-f-]{36})\/stop$/))) {
    const ok = stopFlowRun(m[1]); return answer(req, res, ok ? 200 : 409, { ok }, `/flows/runs/${m[1]}`)
  }
  return json(res, 404, { ok: false, error: `unknown API path: ${req.method} ${path}` })
}
