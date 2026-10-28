// Freilauf — the pages of the deputy and the daily digest.
//
// Settings → Reports (the mode, the operator's rules, the digest, the two LLM
// jobs), "Test rules", the Daily digests page, and the deputy's card on a run's
// detail page. Its own module and its own save, like Merge and Review: a key
// that renders on one page and is saved by another page's allowlist is the
// failure `settingsKeys()` in pages.mjs warns about.
import db, { setSetting, getRun, addEvent, mruList, mruRemember } from './db.mjs'
import { escapeHtml as e, fmtDbUtc } from './util.mjs'
import { t } from './i18n.mjs'
import { redirect } from './web-helpers.mjs'
import { layout, problemPage, llmSourceFields, llmFallbackFields, saveJobRouting } from './pages.mjs'
import { llmSources } from './llm/sources.mjs'
import { REASONING_CHOICES } from './llm/job.mjs'
import { parseMarkup, toHtml } from './rich.mjs'
import {
  notifyMode, digestOn, triageWanted, triageUsable, markTriageSince, NOTIFY_MODES, NOTIFY_RESULT,
  DEFAULT_TRIAGE_MODEL, TRIAGE_RETRY, askDeputy, decideLevel, reassess, endedByOperator,
} from './triage.mjs'
import {
  digestTime, digestQuietDays, DEFAULT_DIGEST_MODEL, DIGEST_RETRY, markDigestSince,
  previewDigest, sendDigestNow, getDigest,
} from './digest.mjs'
import { displayName, projectName } from './report-context.mjs'

const TRIAGE_MRU = 'llm_triage_models_mru'
const DIGEST_MRU = 'llm_digest_models_mru'

const html = (res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })

/** One line for the settings page: which mode, digest on or off. */
export function reportsSettingsSummary() {
  const mode = t(`reports.mode_${notifyMode()}`)
  return digestOn() ? t('reports.summary_digest', { mode, time: digestTime() }) : mode
}

/** The default rules in the UI language — what an empty field means. */
function defaultRules() { return t('triage.default_rules') }

function select(name, current, options) {
  return `<select name="${e(name)}">${options.map(([v, label]) =>
    `<option value="${e(v)}" ${current === v ? 'selected' : ''}>${e(label)}</option>`).join('')}</select>`
}

function jobFieldset(prefix, s, sources, { legend, hint, model, defaultModel, mru, retryDefaults }) {
  return `<fieldset data-llm-job><legend>${e(legend)}</legend>
      <p class="dim">${e(hint)}</p>
      ${llmSourceFields(prefix, s, sources)}
      <label>${e(t('reports.llm_model'))} <input name="${prefix}_model" list="${prefix}-mru" value="${e(s[`${prefix}_model`] || '')}" placeholder="${e(defaultModel)}">
        <datalist id="${prefix}-mru">${[...new Set([defaultModel, ...mruList(mru)])].map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">${e(model)}</span></label>
      ${llmFallbackFields(prefix, s, sources)}
      <label>${e(t('reports.reasoning'))} ${select(`${prefix}_reasoning`, REASONING_CHOICES.includes(s[`${prefix}_reasoning`]) ? s[`${prefix}_reasoning`] : 'off',
        REASONING_CHOICES.map(v => [v, t(`reports.reasoning_${v}`)]))}
        <span class="dim">${e(t('reports.reasoning_hint'))}</span></label>
      <label>${e(t('reports.retry_attempts'))} <input name="${prefix}_retry_attempts" type="number" min="0" max="10" step="1" value="${e(s[`${prefix}_retry_attempts`] ?? '')}" placeholder="${e(String(retryDefaults?.attempts ?? t('reports.retry_global')))}">
        <span class="dim">${e(t('reports.retry_attempts_hint'))}</span></label>
      <label>${e(t('reports.retry_deadline'))} <input name="${prefix}_retry_deadline_ms" type="number" min="0" step="1000" value="${e(s[`${prefix}_retry_deadline_ms`] ?? '')}" placeholder="${e(String(retryDefaults?.deadlineMs ?? t('reports.retry_global')))}">
        <span class="dim">${e(t('reports.retry_deadline_hint'))}</span></label>
    </fieldset>`
}

// ---------------------------------------------------------------------------
// Settings → Reports
// ---------------------------------------------------------------------------

export async function pageReportSettings(req, res) {
  const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]))
  const sources = llmSources()
  const mode = notifyMode()
  const rules = String(s.notify_rules ?? '').trim() || defaultRules()
  const warnSource = mode === 'smart' && !triageUsable()
    ? `<p class="warn">${e(t('reports.warn_no_source'))}</p>` : ''
  const warnDigestOff = mode === 'smart' && !digestOn()
    ? `<p class="dim">${e(t('reports.hint_digest_off'))}</p>` : ''
  const body = `<h2>${e(t('reports.title'))}</h2>
  <p class="dim">${e(t('reports.intro'))}</p>
  <p><a class="btn" href="/digests">${e(t('digest.page_title'))}</a></p>
  <form method="post" action="/settings/reports" class="settings form-grid" id="reports-form">
    <fieldset><legend>${e(t('reports.mode_legend'))}</legend>
      <label>${e(t('reports.mode'))} ${select('notify_mode', mode, NOTIFY_MODES.map(m => [m, t(`reports.mode_${m}`)]))}</label>
      <ul class="dim">${NOTIFY_MODES.map(m => `<li><b>${e(t(`reports.mode_${m}`))}</b> — ${e(t(`reports.mode_${m}_hint`))}</li>`).join('')}</ul>
      ${warnSource}${warnDigestOff}
      <p class="dim">${e(t('reports.unaffected'))}</p>
    </fieldset>
    <fieldset><legend>${e(t('reports.rules_legend'))}</legend>
      <p class="dim">${e(t('reports.rules_hint'))}</p>
      <textarea name="notify_rules" rows="26">${e(rules)}</textarea>
      <div class="btn-row">
        <button type="submit" formaction="/settings/reports/test" class="ghost">${e(t('reports.test_rules'))}</button>
        <span class="dim">${e(t('reports.test_rules_hint'))}</span></div>
    </fieldset>
    <fieldset><legend>${e(t('reports.digest_legend'))}</legend>
      <p class="dim">${e(t('reports.digest_hint'))}</p>
      <label>${e(t('reports.digest_on'))} ${select('digest_on', digestOn() ? '1' : '0', [['0', t('layout.off')], ['1', t('layout.on')]])}</label>
      <label>${e(t('reports.digest_time'))} <input name="digest_time" type="time" value="${e(digestTime())}">
        <span class="dim">${e(t('reports.digest_time_hint'))}</span></label>
      <label>${e(t('reports.digest_quiet'))} ${select('digest_quiet_days', digestQuietDays() ? '1' : '0', [['1', t('layout.on')], ['0', t('layout.off')]])}
        <span class="dim">${e(t('reports.digest_quiet_hint'))}</span></label>
      <label>${e(t('reports.digest_rules'))} <textarea name="digest_rules" rows="3" placeholder="${e(t('reports.digest_rules_ph'))}">${e(s.digest_rules ?? '')}</textarea></label>
    </fieldset>
    ${jobFieldset('llm_triage', s, sources, {
      legend: t('reports.triage_llm_legend'), hint: t('reports.triage_llm_hint'),
      model: t('reports.triage_model_hint', { model: DEFAULT_TRIAGE_MODEL }), defaultModel: DEFAULT_TRIAGE_MODEL,
      mru: TRIAGE_MRU, retryDefaults: TRIAGE_RETRY,
    })}
    ${jobFieldset('llm_digest', s, sources, {
      legend: t('reports.digest_llm_legend'), hint: t('reports.digest_llm_hint'),
      model: t('reports.digest_model_hint', { model: DEFAULT_DIGEST_MODEL }), defaultModel: DEFAULT_DIGEST_MODEL,
      mru: DIGEST_MRU, retryDefaults: DIGEST_RETRY,
    })}
    <div class="btn-row"><button>${e(t('settings.save'))}</button>
      <a class="btn" href="/settings">${e(t('nav.settings'))}</a></div>
  </form>
  <form method="post" action="/settings/reports/reset-rules" class="inline"
        onsubmit="return confirm(${e(JSON.stringify(t('reports.reset_rules_confirm')))})">
    <button class="ghost">${e(t('reports.reset_rules'))}</button></form>`
  html(res).end(await layout(req, t('reports.title'), '/settings', body))
}

const REPORT_KEYS = ['notify_mode', 'digest_on', 'digest_quiet_days', 'digest_rules']
// The serving-provider routing is not in this list: `saveJobRouting()` derives
// `or_provider` and `or_routing` from the mode the form carries.
const JOB_FIELDS = ['source', 'model', 'fallback', 'fallback_model', 'reasoning', 'retry_attempts', 'retry_deadline_ms']

export async function reportSettingsSave(req, res, url, formBody) {
  const b = await formBody()
  const problems = []
  const wasWanted = triageWanted()
  const wasDigest = digestOn()
  const prevMode = notifyMode()
  if (Object.hasOwn(b, 'notify_mode') && !NOTIFY_MODES.includes(b.notify_mode)) problems.push(t('reports.err_mode'))
  for (const k of REPORT_KEYS) if (Object.hasOwn(b, k) && !(k === 'notify_mode' && problems.length)) setSetting(k, String(b[k] ?? '').trim())
  if (Object.hasOwn(b, 'digest_time')) {
    const v = String(b.digest_time ?? '').trim()
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) setSetting('digest_time', v)
    else problems.push(t('reports.err_time', { value: v }))
  }
  // The rules: the shipped default is stored as "nothing", so it follows the
  // UI language and a later, better default reaches an operator who never
  // changed it.
  if (Object.hasOwn(b, 'notify_rules')) {
    const v = String(b.notify_rules ?? '').replace(/\r/g, '').trim()
    setSetting('notify_rules', v === defaultRules().replace(/\r/g, '').trim() ? '' : v)
  }
  for (const p of ['llm_triage', 'llm_digest']) {
    for (const f of JOB_FIELDS) {
      const k = `${p}_${f}`
      if (!Object.hasOwn(b, k)) continue
      const v = String(b[k] ?? '').trim()
      if (f === 'reasoning' && !REASONING_CHOICES.includes(v)) continue
      if ((f === 'retry_attempts' || f === 'retry_deadline_ms') && v !== '' && !(Number.isFinite(Number(v)) && Number(v) >= 0)) {
        problems.push(t('reports.err_number', { field: k }))
        continue
      }
      setSetting(k, v)
    }
  }
  saveJobRouting(b, ['triage', 'digest'])
  if (String(b.llm_triage_model ?? '').trim()) mruRemember(TRIAGE_MRU, String(b.llm_triage_model).trim())
  if (String(b.llm_digest_model ?? '').trim()) mruRemember(DIGEST_MRU, String(b.llm_digest_model).trim())
  // The deputy mode needs a model source that can answer — switching it on
  // without one would turn every report into a fallback line.
  if (notifyMode() === 'smart' && prevMode !== 'smart' && !triageUsable()) {
    setSetting('notify_mode', prevMode)
    problems.push(t('reports.err_no_source'))
  }
  markTriageSince(wasWanted)
  markDigestSince(wasDigest)
  if (problems.length) return problemPage(req, res, t('reports.title'), problems, '/settings/reports')
  redirect(res, '/settings/reports')
}

export async function reportRulesReset(req, res) {
  setSetting('notify_rules', '')
  redirect(res, '/settings/reports')
}

// ---------------------------------------------------------------------------
// "Test rules": the deputy over the last 30 reports, nothing stored or sent
// ---------------------------------------------------------------------------

const tests = new Map()   // id -> { at, total, done, rows, rules, error }

/** A finished run as the note the deputy would have had for its first report. */
function transientNote(run) {
  return {
    id: 0, kind: 'report', run_id: run.id, seq: 0, launch_no: run.launch_no ?? 0,
    hub_types: JSON.stringify([run.status]), report_short: run.report_md, report_detail: run.report_detail_md,
    created_at: run.ended_at,
  }
}

export async function reportRulesTest(req, res, url, formBody) {
  const b = await formBody()
  if (!triageUsable()) return problemPage(req, res, t('reports.test_rules'), [t('reports.err_no_source')], '/settings/reports')
  const rules = String(b.notify_rules ?? '').trim()
  const runs = db.prepare(`SELECT * FROM runs WHERE status IN ('done','failed','aborted') AND resolves_run_id IS NULL
    AND report_md IS NOT NULL AND report_md <> '' ORDER BY ended_at DESC LIMIT 30`).all()
  const id = Math.random().toString(36).slice(2, 10)
  const job = { at: Date.now(), total: runs.length, done: 0, rows: [], rules }
  tests.set(id, job)
  for (const [k, v] of tests) if (Date.now() - v.at > 3_600_000) tests.delete(k)
  // Three at a time: thirty questions one after the other would take minutes.
  const queue = [...runs]
  const worker = async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      const r = await askDeputy(transientNote(run), run, { rulesOverride: rules || null }).catch(err => ({ ok: false, error: err.message }))
      job.rows.push({ run, r })
      job.done++
    }
  }
  Promise.all([worker(), worker(), worker()]).catch(() => {})
  redirect(res, `/settings/reports/test?job=${id}`)
}

export async function pageRulesTest(req, res, url) {
  const job = tests.get(url.searchParams.get('job') ?? '')
  if (!job) return problemPage(req, res, t('reports.test_rules'), [t('reports.test_gone')], '/settings/reports')
  const rows = [...job.rows].sort((a, b) => String(b.run.ended_at).localeCompare(String(a.run.ended_at)))
  const running = job.done < job.total
  const line = ({ run, r }) => {
    if (!r.ok) return `<tr><td><a href="/runs/${e(run.id)}">${e(displayName(run))}</a><br><span class="dim">${e(projectName(run))}</span></td><td colspan="4" class="err">${e(r.error)}</td></tr>`
    const a = r.data
    const d = decideLevel({ attention: a.attention, policy: run.notify_result, kind: 'report', mode: 'smart', muted: false, byOperator: endedByOperator(transientNote(run), run) })
    const level = d.level ? t(`triage.level_${d.level}`) : t('reports.not_sent')
    return `<tr><td><a href="/runs/${e(run.id)}">${e(displayName(run))}</a><br><span class="dim">${e(projectName(run))} · ${e(fmtDbUtc(run.ended_at))}</span></td>
      <td><b>${e(level)}</b><br><span class="dim">${e(t(`reports.result_${a.result}`))}</span></td>
      <td>${e(a.reason)}</td><td>${e(a.message)}</td><td class="dim">${e(a.summary)}</td></tr>`
  }
  const body = `<h2>${e(t('reports.test_rules'))}</h2>
  <p class="dim">${e(t('reports.test_intro', { done: job.done, total: job.total }))}</p>
  ${running ? `<p>${e(t('reports.test_running'))}</p><script>setTimeout(function () { location.reload() }, 3000)</script>` : ''}
  <table class="list"><thead><tr><th>${e(t('reports.col_run'))}</th><th>${e(t('reports.col_level'))}</th>
    <th>${e(t('reports.col_reason'))}</th><th>${e(t('reports.col_message'))}</th><th>${e(t('reports.col_summary'))}</th></tr></thead>
  <tbody>${rows.map(line).join('')}</tbody></table>
  <p><a class="btn" href="/settings/reports">${e(t('reports.title'))}</a></p>`
  html(res).end(await layout(req, t('reports.test_rules'), '/settings', body))
}

// ---------------------------------------------------------------------------
// Daily digests
// ---------------------------------------------------------------------------

export async function pageDigests(req, res) {
  const rows = db.prepare(`SELECT * FROM digests ORDER BY id DESC LIMIT 60`).all()
  const list = rows.map(d => `<tr><td><a href="/digests/${d.id}">${e(fmtDbUtc(d.period_end))}</a></td>
      <td>${e(d.headline ?? '')}</td><td class="dim">${e(t(`digest.state_${d.state}`))}${d.preview && d.state !== 'preview' ? ` · ${e(t('digest.preview_mark'))}` : ''}</td></tr>`).join('')
  const off = !digestOn() ? `<p class="dim">${e(t('digest.off_hint'))} <a href="/settings/reports">${e(t('reports.title'))}</a></p>` : ''
  const body = `<h2>${e(t('digest.page_title'))}</h2>
  ${off}
  <div class="btn-row">
    <form method="post" action="/digests/preview" class="inline"><button class="ghost">${e(t('digest.preview'))}</button></form>
    <form method="post" action="/digests/send" class="inline" onsubmit="return confirm(${e(JSON.stringify(t('digest.send_confirm')))})"><button>${e(t('digest.send_now'))}</button></form>
    <span class="dim">${e(t('digest.buttons_hint'))}</span>
  </div>
  ${rows.length ? `<table class="list"><thead><tr><th>${e(t('digest.col_when'))}</th><th>${e(t('digest.col_headline'))}</th><th>${e(t('digest.col_state'))}</th></tr></thead><tbody>${list}</tbody></table>`
    : `<p class="dim">${e(t('digest.none'))}</p>`}`
  html(res).end(await layout(req, t('digest.page_title'), '/settings', body))
}

export async function pageDigest(req, res, url, id) {
  const d = getDigest(Number(id))
  if (!d) return problemPage(req, res, t('digest.page_title'), [t('digest.not_found')], '/digests')
  const bodyHtml = toHtml({ blocks: parseMarkup(d.body ?? '', d.refs) })
  const body = `<h2>${e(d.headline ?? t('digest.title'))}</h2>
  <p class="dim">${e(t('digest.period', { from: fmtDbUtc(d.period_start), to: fmtDbUtc(d.period_end) }))} · ${e(t(`digest.state_${d.state}`))}${d.model ? ` · ${e(d.model)}` : ''}</p>
  ${d.error ? `<p class="warn">${e(d.error)}</p>` : ''}
  <div class="card digest-body" style="white-space: pre-line">${bodyHtml || e(t('digest.empty'))}</div>
  <p><a class="btn" href="/digests">${e(t('digest.page_title'))}</a></p>`
  html(res).end(await layout(req, t('digest.page_title'), '/settings', body))
}

export async function digestPreviewAction(req, res) {
  const r = await previewDigest()
  redirect(res, r?.id ? `/digests/${r.id}` : '/digests')
}

export async function digestSendAction(req, res) {
  const r = await sendDigestNow()
  redirect(res, r?.id ? `/digests/${r.id}` : '/digests')
}

// ---------------------------------------------------------------------------
// the deputy's card on a run's detail page
// ---------------------------------------------------------------------------

function noteLabel(n) {
  if (n.kind === 'interim') return t('deputy.kind_interim')
  if (n.kind === 'event') return t('deputy.kind_event', { n: n.seq })
  return n.seq > 0 ? t('deputy.kind_followup', { n: n.seq }) : t('deputy.kind_report')
}

function noteHtml(n, runId) {
  const head = `<b>${e(noteLabel(n))}</b> <span class="dim">${e(fmtDbUtc(n.created_at))}</span>`
  if (['waiting', 'pending', 'asking'].includes(n.state)) return `<li>${head} — ${e(t(`deputy.state_${n.state}`))}</li>`
  if (n.state === 'expired') return `<li>${head} — ${e(t('deputy.state_expired'))}</li>`
  const level = n.level_sent
    ? (n.sent_at ? t('deputy.sent', { level: t(`triage.level_${n.level_sent}`) }) : t('deputy.queued', { level: t(`triage.level_${n.level_sent}`) }))
    : t('deputy.not_sent', { why: t(`deputy.why_${n.silent_why ?? 'deputy'}`) })
  const fb = n.state === 'fallback' ? `<p class="warn">${e(t('deputy.fallback', { error: n.error ?? '' }))}</p>` : ''
  return `<li>${head} — ${e(level)}${n.attention ? ` · ${e(t('deputy.attention', { level: t(`triage.level_${n.attention}`) }))}` : ''}
    ${fb}
    ${n.message ? `<blockquote>${e(n.message)}</blockquote>` : ''}
    ${n.reason ? `<p class="dim">${e(t('deputy.reason', { reason: n.reason }))}</p>` : ''}
    ${n.summary ? `<p class="dim">${e(t('deputy.summary', { summary: n.summary }))}</p>` : ''}
    ${n.state === 'done' || n.state === 'fallback' ? `<form method="post" action="/api/runs/${e(runId)}/reassess" class="inline">
      <input type="hidden" name="note" value="${n.id}"><button class="ghost">${e(t('deputy.reassess'))}</button></form>` : ''}
  </li>`
}

/** The card: the run's "report the result" switch and every deputy note. */
export function deputyCard(run) {
  const notes = db.prepare(`SELECT * FROM report_notes WHERE run_id=? ORDER BY id`).all(run.id)
  const cur = NOTIFY_RESULT.includes(run.notify_result) ? run.notify_result : 'auto'
  const sw = `<form method="post" action="/api/runs/${e(run.id)}/notify-result" class="inline">
      <label>${e(t('runform.notify_result'))} <select name="notify_result">
        ${NOTIFY_RESULT.map(v => `<option value="${v}" ${cur === v ? 'selected' : ''}>${e(t(`runform.notify_result_${v}`))}</option>`).join('')}
      </select></label> <button class="ghost">${e(t('settings.save'))}</button></form>`
  if (!notes.length && !triageWanted()) return `<details class="deputy"><summary>${e(t('deputy.title'))}</summary>${sw}<p class="dim">${e(t('deputy.off'))}</p></details>`
  return `<details class="deputy" ${notes.length ? 'open' : ''}><summary>${e(t('deputy.title'))}</summary>
    ${sw}
    ${notes.length ? `<ul class="deputy-notes">${notes.map(n => noteHtml(n, run.id)).join('')}</ul>` : `<p class="dim">${e(t('deputy.none'))}</p>`}
  </details>`
}

/** POST /api/runs/<id>/notify-result — the switch, changed on the run itself. */
export async function runNotifyResultSave(req, res, url, formBody, runId) {
  const run = getRun(runId)
  if (!run) return problemPage(req, res, t('deputy.title'), [t('api.unknown_run')], '/')
  const b = await formBody()
  const v = NOTIFY_RESULT.includes(b.notify_result) ? b.notify_result : 'auto'
  if (v !== run.notify_result) {
    db.prepare('UPDATE runs SET notify_result=? WHERE id=?').run(v, runId)
    addEvent(runId, 'notify_result', { value: v })
  }
  redirect(res, `/runs/${runId}`)
}

/** POST /api/runs/<id>/reassess — ask the deputy again; shown, never stored or sent. */
export async function runReassess(req, res, url, formBody, runId) {
  const b = await formBody()
  const r = await reassess(Number(b.note))
  if (!r.ok) return problemPage(req, res, t('deputy.reassess'), [r.error], `/runs/${runId}`)
  const a = r.data
  const body = `<h2>${e(t('deputy.reassess'))}</h2>
  <p class="dim">${e(t('deputy.reassess_intro'))}</p>
  <div class="card">
    <p><b>${e(t(`triage.level_${a.attention}`))}</b> · ${e(t(`reports.result_${a.result}`))}${a.cause && a.cause !== 'none' ? ` · ${e(a.cause)}` : ''}</p>
    <blockquote>${e(a.message)}</blockquote>
    <p class="dim">${e(t('deputy.reason', { reason: a.reason }))}</p>
    <p class="dim">${e(t('deputy.summary', { summary: a.summary }))}</p>
  </div>
  <p><a class="btn" href="/runs/${e(runId)}">${e(t('deputy.back'))}</a></p>`
  html(res).end(await layout(req, t('deputy.reassess'), '/', body))
}

