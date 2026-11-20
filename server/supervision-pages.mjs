// Freilauf — what a HUMAN sees of supervision: the case file section on a run's
// page, the switch that takes a run out of supervision, and the notices on the
// agents pages. Every string through t(); the data comes from supervision.mjs.
// Split from it like report-pages.mjs from triage.mjs, so the case file stays
// importable without rendering anything.
import { escapeHtml as e, fmtDuration, fmtDbUtc, parseDbUtc, shortId } from './util.mjs'
import { t } from './i18n.mjs'
import { caseEntries, caseState, activeSupervisorAgent, supervisorAgents, DUE_REASONS } from './supervision.mjs'

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
    return t('case.action_other', { op: String(d.op ?? '?') })
  }
  if (entry.kind === 'note' && d.again_minutes) return t('case.note_again', { minutes: d.again_minutes })
  if (entry.kind === 'answer' && d.choice) return t('case.answer_choice', { choice: d.choice })
  if (entry.kind === 'look' && 'due' in d) {
    return d.due && DUE_REASONS[d.due] !== undefined
      ? t('case.look_due', { reason: t(`case.reason_${d.due}`) }) : t('case.look_not_due')
  }
  return ''
}

/** Where the case stands, in one line; '' when nothing is set. */
function stateLine(state, nowMs) {
  if (!state) return ''
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
 * The form is a plain POST to `/api/runs/<id>/case/answer`; a question's choices
 * (stage B) become `<button name="choice" value="…">` beside the send button.
 */
export function caseSection(run, nowMs = Date.now()) {
  const entries = caseEntries(run.id, { limit: PAGE_ENTRIES })
  const state = caseState(run.id)
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
  // `required` while the form has nothing but the text: an empty answer from the
  // page would otherwise be a 400 the browser shows as nothing happening. A
  // question's choice buttons (stage B) must drop it or carry `formnovalidate`.
  return `<section class="card case-file" id="run-case"${show ? '' : ' hidden'}>
    <h3>${e(t('case.title'))}</h3>
    ${st ? `<p class="dim">${st}</p>` : ''}
    ${items ? `<ol class="case-entries">${items}</ol>` : `<p class="dim">${e(t('case.empty'))}</p>`}
    <form method="post" action="/api/runs/${e(run.id)}/case/answer" class="case-answer">
      <input type="hidden" name="back" value="/runs/${e(run.id)}#run-case">
      <label>${e(t('case.answer_label'))}
        <textarea name="text" rows="3" required placeholder="${e(t('case.answer_ph'))}"></textarea></label>
      <div class="btn-row"><button>${e(t('case.answer_send'))}</button></div>
    </form></section>`
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
 * marked as supervisor: v1 runs one, the lowest id, and says which (SPEC 4.1).
 */
export function supervisorNotice() {
  const all = supervisorAgents()
  if (all.length < 2) return ''
  return `<p class="warn" id="supervisor-notice">${e(t('supervisor.several', {
    name: all[0].name, others: all.slice(1).map(a => a.name).join(', '),
  }))}</p>`
}
