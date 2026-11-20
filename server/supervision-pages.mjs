// Freilauf — what a HUMAN sees of supervision: the case file section on a run's
// page, the switch that takes a run out of supervision, and the notices on the
// agents pages. Every string through t(); the data comes from supervision.mjs.
// Split from it like report-pages.mjs from triage.mjs, so the case file stays
// importable without rendering anything.
import { escapeHtml as e, fmtDuration, fmtDbUtc, parseDbUtc, shortId } from './util.mjs'
import { t } from './i18n.mjs'
import db from './db.mjs'
import { caseEntries, caseState, activeSupervisorAgent, supervisorAgents, DUE_REASONS, SUPERVISION_SETTINGS,
  supervisionSetting, ROUND_EVENT } from './supervision.mjs'
import { questionForPage } from './supervision-acts.mjs'
import { listEscalations, escalationItem, pendingEscalationCount, anyEscalation,
  ESCALATION_CLASSES, ESCALATION_STATE_FILTERS, ESCALATIONS_LIMIT_MAX } from './escalations.mjs'

/** How many entries the run page shows; the read API reaches further back. */
const PAGE_ENTRIES = 50

/** Who wrote an entry, in the operator's words. A supervisor run links to its page. */
function authorLabel(author) {
  const a = String(author ?? '')
  if (a === 'operator') return e(t('case.author_operator'))
  if (a === 'run') return e(t('case.author_run'))
  if (a === 'hub') return e(t('case.author_hub'))
  if (a.startsWith('resolver:')) return e(t('case.author_resolver', { name: a.slice('resolver:'.length) }))
  return `<a href="/runs/${e(a)}">${e(t('case.author_supervisor', { id: shortId(a) }))}</a>`
}

/** "12 min ago", computed here — never left to the reader's clock arithmetic. */
function ageLabel(ts, nowMs) {
  const ms = parseDbUtc(ts)
  if (!Number.isFinite(ms)) return ''
  return t('case.ago', { age: fmtDuration(Math.max(0, (nowMs - ms) / 1000)) })
}

/** What an entry's data adds to its text, as a sentence; '' for nothing. */
function dataLine(entry) {
  const d = entry.data ?? {}
  if (entry.kind === 'action') {
    if (d.op === 'again') return t('case.action_again', { minutes: d.minutes, at: fmtDbUtc(d.at) })
    if (d.op === 'end') {
      return t(d.outcome === 'aborted' ? 'case.action_end_aborted' : 'case.action_end_closed')
        + (d.followup_abandoned ? ` ${t('case.action_end_followup')}` : '')
    }
    if (d.op === 'park') return t(d.why === 'handouts' ? 'case.action_park_handouts' : 'case.action_park_looks', { count: d.count ?? '?' })
    if (d.op === 'unpark') return t(entry.author === 'operator' ? 'case.action_unpark_operator' : 'case.action_unpark_hub')
    return t('case.action_other', { op: String(d.op ?? '?') })
  }
  if (entry.kind === 'reopened') return t(d.why === 'changed' ? 'case.reopened_changed' : d.why === 'operator' ? 'case.reopened_operator' : 'case.reopened_news')
  if (entry.kind === 'message' && ['help', 'followup', 'running'].includes(d.into)) return t(`case.message_into_${d.into}`)
  if (entry.kind === 'question' && Array.isArray(d.choices) && d.choices.length) {
    return t('case.question_choices', { choices: d.choices.join(' · ') })
  }
  if (entry.kind === 'escalated' && d.escalation) {
    return t('case.escalated_line', { id: d.escalation, cls: ESCALATION_CLASSES.includes(d.class) ? t(`escalation.class_${d.class}`) : String(d.class ?? '') })
  }
  if (entry.kind === 'resolved' && d.escalation) {
    return t('case.resolved_line', { id: d.escalation, outcome: t(`escalation.outcome_${ESCALATION_OUTCOME_WORDS.includes(d.outcome) ? d.outcome : 'other'}`) })
  }
  if (entry.kind === 'note' && d.again_minutes) return t('case.note_again', { minutes: d.again_minutes })
  if (entry.kind === 'answer' && d.choice) return t('case.answer_choice', { choice: d.choice })
  if (entry.kind === 'look' && 'due' in d) {
    if (!d.due) return t('case.look_not_due')
    // A reason this page has no words for is shown as it is, never as "not due".
    return t('case.look_due', { reason: DUE_REASONS[d.due] !== undefined ? t(`case.reason_${d.due}`) : String(d.due) })
  }
  return ''
}

/** Where the case stands, in one line; '' when nothing is set. */
function stateLine(state, nowMs) {
  if (!state) return ''
  if (state.parked_at) return e(t('case.state_parked', { at: fmtDbUtc(state.parked_at) }))
  if (state.closed_at) {
    return e(t('case.state_closed', { at: fmtDbUtc(state.closed_at), reason: state.closed_reason ?? '' }))
  }
  const again = parseDbUtc(state.look_again_at)
  if (Number.isFinite(again) && again > nowMs) return e(t('case.state_look_again', { at: fmtDbUtc(state.look_again_at) }))
  return ''
}

/**
 * The run's case file, oldest entry first, with author and age, plus the
 * operator's answer form. Always rendered with its fixed id and hidden when
 * there is nothing to show — the live channel swaps by id, and an element absent
 * from the DOM cannot be swapped in (same trick as `#run-attention`). Shown
 * when the file has entries, or while a supervisor agent is active (then an
 * operator may leave a remark before anybody asked).
 *
 * The form is a plain POST to `/api/runs/<id>/case/answer`; an open question's
 * choices become `<button name="choice" value="…" formnovalidate>` beside the
 * send button, so one click answers without a text. `error` is the redirect's
 * `?case_error=empty`: an answer of only spaces passed the browser and was
 * refused, and the operator is told so instead of finding nothing changed.
 */
export function caseSection(run, nowMs = Date.now(), { error = false } = {}) {
  const entries = caseEntries(run.id, { limit: PAGE_ENTRIES })
  const state = caseState(run.id)
  const question = questionForPage(run.id)
  const show = entries.length > 0 || (run.supervisor !== 1 && !!activeSupervisorAgent())
  const items = entries.map(en => {
    const extra = dataLine(en)
    return `<li class="case-entry case-${e(en.kind)}" data-entry="${en.id}">
      <div class="case-meta"><b>${e(t(`case.kind_${en.kind}`))}</b> · ${authorLabel(en.author)} ·
        <span class="dim" title="${e(fmtDbUtc(en.ts))}">${e(ageLabel(en.ts, nowMs))}</span></div>
      ${en.text ? `<div class="case-text">${e(en.text)}</div>` : ''}
      ${extra ? `<div class="dim">${e(extra)}</div>` : ''}</li>`
  }).join('')
  const st = stateLine(state, nowMs)
  // `required` on the text: an empty answer from the page would otherwise be a
  // 400. The choice buttons carry `formnovalidate`, so a click needs no text.
  const choices = (question?.choices ?? []).map(c =>
    `<button name="choice" value="${e(c)}" formnovalidate class="case-choice">${e(c)}</button>`).join('')
  // A parked case is un-parked by the operator here: a plain POST, like the answer.
  const unpark = state?.parked_at ? `<form method="post" action="/api/runs/${e(run.id)}/case/unpark" class="inline" id="case-unpark">
      <input type="hidden" name="back" value="/runs/${e(run.id)}#run-case">
      <button>${e(t('case.unpark'))}</button></form>` : ''
  return `<section class="card case-file" id="run-case"${show ? '' : ' hidden'}>
    <h3>${e(t('case.title'))}</h3>
    ${st ? `<p class="dim">${st}</p>` : ''}${unpark}
    ${items ? `<ol class="case-entries">${items}</ol>` : `<p class="dim">${e(t('case.empty'))}</p>`}
    ${error ? `<p class="warn" id="case-error">${e(t('case.err_answer_empty'))}</p>` : ''}
    <form method="post" action="/api/runs/${e(run.id)}/case/answer" class="case-answer">
      <input type="hidden" name="back" value="/runs/${e(run.id)}#run-case">
      ${question ? `<p class="case-open-question">${e(t('case.question_open'))}</p>` : ''}
      <label>${e(t('case.answer_label'))}
        <textarea name="text" rows="3" required placeholder="${e(t('case.answer_ph'))}"></textarea></label>
      <div class="btn-row"><button>${e(t('case.answer_send'))}</button>${choices}</div>
    </form></section>`
}

// ------------------------------------------------------------------ escalations

/** The outcome words the page has a translation for; anything else reads as "other". */
const ESCALATION_OUTCOME_WORDS = ['solved', 'unsolved', 'operator', 'dismissed']

/**
 * The escalations page (`/escalations`): the list for one state filter in the
 * read API's order (waiting ones oldest first), each with the run it is about and, while it
 * is open or claimed, the operator's two buttons — resolve (with an outcome
 * and a note) and dismiss ("not a problem"). Plain POST forms to the page's own
 * routes (`/escalations/<id>/resolve|dismiss`, pages.mjs), never the resolver's
 * contract routes: a resolve from here is the operator's. `error` is the word
 * the redirect brought back when a button was refused.
 */
export function escalationsPageBody(filter = 'open', nowMs = Date.now(), { error = null } = {}) {
  const state = ESCALATION_STATE_FILTERS.includes(filter) ? filter : 'open'
  const list = listEscalations({ state, limit: ESCALATIONS_LIMIT_MAX })
  const tabs = ESCALATION_STATE_FILTERS.map(s =>
    `<a href="/escalations?state=${s}" class="${s === state ? 'on' : ''}">${e(t(`escalation.state_${s}`))}</a>`).join(' · ')
  const rows = (list.rows ?? []).map(row => {
    const it = escalationItem(row)
    const age = t('case.ago', { age: fmtDuration(Math.max(0, (nowMs - parseDbUtc(row.created_at)) / 1000)) })
    const runLabel = it.run.title ?? it.run.short_id
    const pending = ['open', 'claimed'].includes(it.state)
    const claimed = it.claimed_by ? ` · ${e(t('escalation.claimed_by', { name: it.claimed_by }))}` : ''
    const result = it.outcome ? ` · ${e(t(`escalation.outcome_${ESCALATION_OUTCOME_WORDS.includes(it.outcome) ? it.outcome : 'other'}`))}` : ''
    const outcomes = ['solved', 'unsolved', 'operator'].map(o =>
      `<option value="${o}">${e(t(`escalation.outcome_${o}`))}</option>`).join('')
    return `<li class="escalation esc-${e(it.state)}" id="escalation-${it.id}">
      <div><b>#${it.id}</b> · <span class="dim">${e(t(`escalation.class_${it.class}`))}</span> ·
        <span class="dim" title="${e(fmtDbUtc(row.created_at))}">${e(age)}</span> ·
        ${e(t(`escalation.state_${it.state}`))}${claimed}${result}</div>
      <div class="esc-summary">${e(it.summary)}</div>
      <div class="dim">${e(t('escalation.about_run'))} <a href="/runs/${e(it.run.id)}">${e(runLabel)}</a>
        ${it.run.repo ? `· ${e(it.run.repo)}` : ''}</div>
      ${it.note ? `<div class="dim">${e(t('escalation.note'))}: ${e(it.note)}</div>` : ''}
      ${pending ? `<div class="btn-row">
        <form method="post" action="/escalations/${it.id}/resolve" class="inline">
          <input type="hidden" name="state" value="${e(state)}">
          <select name="outcome" aria-label="${e(t('escalation.outcome'))}">${outcomes}</select>
          <input name="note" maxlength="500" placeholder="${e(t('escalation.note_ph'))}">
          <button>${e(t('escalation.resolve'))}</button></form>
        <form method="post" action="/escalations/${it.id}/dismiss" class="inline">
          <input type="hidden" name="state" value="${e(state)}">
          <button>${e(t('escalation.dismiss'))}</button></form></div>` : ''}
    </li>`
  }).join('')
  return `<h2>${e(t('escalation.page_title'))}</h2>
    <p class="dim">${e(t('escalation.intro'))}</p>
    ${['changed', 'gone', 'invalid'].includes(error) ? `<p class="warn" id="escalation-error">${e(t(`escalation.err_${error}`))}</p>` : ''}
    <p class="esc-tabs">${tabs}</p>
    ${rows ? `<ol class="escalations">${rows}</ol>` : `<p class="dim" id="escalations-empty">${e(t('escalation.none'))}</p>`}`
}

/** The nav entry: shown while a supervisor agent is active or any escalation exists, with the pending count. */
export function escalationNav() {
  if (!activeSupervisorAgent() && !anyEscalation()) return null
  const n = pendingEscalationCount()
  return ['/escalations', t('nav.escalations') + (n ? ` (${n})` : '')]
}

/**
 * The switch that takes this run out of supervision or puts it back — a plain
 * POST form in the detail head, like the archive button, so a live swap
 * carries it and no client script is involved. Rendered (hidden) always, shown
 * only while a supervisor agent is active and never on a supervisor run, which
 * is never a case anyway. The route works regardless.
 */
export function supervisionSwitch(run) {
  const show = run.supervisor !== 1 && !!activeSupervisorAgent()
  const off = run.supervision_off === 1
  return `<div class="btn-row" id="run-supervision"${show ? '' : ' hidden'}>${show ? `
    <form method="post" action="/api/runs/${e(run.id)}/supervision" class="inline">
      <input type="hidden" name="off" value="${off ? '0' : '1'}">
      <input type="hidden" name="back" value="/runs/${e(run.id)}">
      <button>${e(t(off ? 'supervision.put_back' : 'supervision.take_out'))}</button></form>
    <span class="dim">${e(t(off ? 'supervision.is_off' : 'supervision.is_on'))}</span>` : ''}</div>`
}

/**
 * The line on the agents page and the agent form when more than one agent is
 * marked as supervisor: v1 runs one, the lowest id, and says which.
 */
export function supervisorNotice() {
  const all = supervisorAgents()
  if (all.length < 2) return ''
  return `<p class="warn" id="supervisor-notice">${e(t('supervisor.several', {
    name: all[0].name, others: all.slice(1).map(a => a.name).join(', '),
  }))}</p>`
}

// ------------------------------------------------------------------ settings

/**
 * The fields of Settings → Supervision, in the order the page shows them:
 * name, settings key, default, accepted range. `''` stored means the default;
 * 0 is a valid value only for the grace ("tell the operator at once").
 */
export function supervisionSettingFields() {
  const S = SUPERVISION_SETTINGS
  return [
    { name: 'interval', key: S.interval.key, dflt: S.interval.dflt, min: S.interval.min, max: S.interval.max },
    { name: 'cases', key: S.cases.key, dflt: S.cases.dflt, min: S.cases.min, max: S.cases.max },
    { name: 'wait', key: S.wait.key, dflt: S.wait.dflt, min: S.wait.min, max: S.wait.max },
    { name: 'nudges', key: S.nudges.key, dflt: S.nudges.dflt, min: S.nudges.min, max: S.nudges.max },
    { name: 'grace', key: S.grace.key, dflt: S.grace.dflt, min: S.grace.min, max: S.grace.max },
  ]
}

/**
 * A posted Settings → Supervision form → `{ values: {key: string}, problems }`.
 * Pure. Each field is `''` (the default) or a whole number in its range,
 * compared as a string before it is converted (`Number('')` is 0). A field the
 * body did not carry is left out, so nothing is overwritten by omission.
 */
export function supervisionSettingsFromForm(b = {}) {
  const values = {}
  const problems = []
  for (const f of supervisionSettingFields()) {
    if (!Object.hasOwn(b, f.key)) continue
    const raw = String(b[f.key] ?? '').trim()
    if (raw === '') { values[f.key] = ''; continue }
    if (!/^\d+$/.test(raw) || Number(raw) < f.min || Number(raw) > f.max) {
      problems.push(t('supervision.err_number', { field: t(`supervision.set_${f.name}`), min: f.min, max: f.max, dflt: f.dflt }))
      continue
    }
    values[f.key] = String(Number(raw))
  }
  return { values, problems }
}

/** What a field is in effect, as the page shows it under an empty input. */
function effective(name) {
  return supervisionSetting(name)
}

/** The newest supervisor round, for the page: `{ id, status, started_at, display_status }` or null. */
function lastRound() {
  return db.prepare(`SELECT r.* FROM runs r WHERE EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.kind = ?)
    ORDER BY r.started_at DESC LIMIT 1`).get(ROUND_EVENT) ?? null
}

/** The parked cases, newest first, at most 20 — parking is told once, so the page keeps the list. */
function parkedCases() {
  return db.prepare(`SELECT r.id, r.title, c.parked_at FROM case_state c JOIN runs r ON r.id = c.run_id
    WHERE c.parked_at IS NOT NULL AND r.archived_at IS NULL ORDER BY c.parked_at DESC LIMIT 20`).all()
}

/**
 * The body of Settings → Supervision: which agent supervises (and that the
 * lowest id wins when several are flagged), the five numbers, the last round
 * and the parked cases. `stored` is the settings map, so an empty field stays
 * empty and says what it falls back to.
 */
export function supervisionSettingsBody(stored = {}, nowMs = Date.now()) {
  const active = activeSupervisorAgent()
  const who = active
    ? `<p id="supervision-active">${e(t('supervision.active_is'))} <a href="/agents/edit?id=${active.id}&repo=${active.repo_id}">${e(active.name)}</a></p>`
    : `<p class="warn" id="supervision-none">${e(t('supervision.none_active'))}</p>`
  const fields = supervisionSettingFields().map(f => `
    <label>${e(t(`supervision.set_${f.name}`))}
      <input name="${f.key}" type="number" min="${f.min}" max="${f.max}" step="1" value="${e(String(stored[f.key] ?? ''))}"
        placeholder="${e(String(f.dflt))}">
      <span class="dim">${e(t(`supervision.set_${f.name}_hint`, { dflt: f.dflt, now: effective(f.name) }))}</span></label>`).join('')
  const round = lastRound()
  const roundLine = round ? `<p class="dim" id="supervision-last-round">${e(t('supervision.last_round'))}
      <a href="/runs/${e(round.id)}">${e(shortId(round.id))}</a> · ${e(t('case.ago', { age: fmtDuration(Math.max(0, (nowMs - parseDbUtc(round.started_at)) / 1000)) }))}
      · ${e(t(`status.${round.status}`))}</p>` : ''
  const parked = parkedCases()
  const parkedList = parked.length ? `<h3>${e(t('supervision.parked_title'))}</h3>
    <ul id="supervision-parked">${parked.map(p => `<li><a href="/runs/${e(p.id)}#run-case">${e(p.title ?? shortId(p.id))}</a>
      <span class="dim">${e(fmtDbUtc(p.parked_at))}</span></li>`).join('')}</ul>` : ''
  return `<h2>${e(t('supervision.settings_title'))}</h2>
  <p class="dim">${e(t('supervision.settings_intro'))}</p>
  ${who}${supervisorNotice()}
  <form method="post" action="/settings/supervision" class="settings form-grid">${fields}
    <div class="btn-row"><button>${e(t('settings.save'))}</button>
      <a class="btn" href="/settings">${e(t('nav.settings'))}</a></div>
  </form>
  ${roundLine}${parkedList}`
}

/** One line for the settings page: who supervises and how often, or that nobody does. */
export function supervisionSettingsSummary() {
  const active = activeSupervisorAgent()
  if (!active) return t('supervision.summary_none')
  return t('supervision.summary', { name: active.name, interval: supervisionSetting('interval'), cases: supervisionSetting('cases') })
}
