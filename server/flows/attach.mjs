// cc-hub flows — attaching flows to a run definition.
//
// A flow is not something you go looking for in a menu: it hangs on the agent
// or the single run whose end shall start it. That attachment IS the
// "run finished" trigger — there is exactly ONE place where it is stored
// (`agents.flows`, snapshotted into `runs.flows` when the run is created), so
// the agent form and the flow editor cannot drift apart: both edit the same
// rows. Nothing has to be kept in sync because there is nothing to sync.
//
// The condition ("only when it failed") sits on the attachment, not in the
// flow: the same notify-flow may hang on one agent for failures and on another
// for every outcome. It does NOT replace the `switch_outcome` block — a flow
// that starts runs of its own still needs to branch on THEIR result.
import db from '../db.mjs'
import { listFlows, flowsForMergeOfRepo, mergeTriggerRepoId } from './db.mjs'
import { escapeHtml as e } from '../util.mjs'
import { t } from '../i18n.mjs'

/** The conditions an attachment can carry. Fixed set — a picker, not a filter builder. */
export const WHEN_KINDS = ['always', 'done', 'failed', 'not_done', 'aborted']

const OUTCOMES_FOR = {
  always: ['done', 'failed', 'aborted'],
  done: ['done'],
  failed: ['failed'],
  aborted: ['aborted'],
  not_done: ['failed', 'aborted'],
}

export function outcomesFor(when) { return OUTCOMES_FOR[when] ?? OUTCOMES_FOR.always }

/** The condition that covers exactly this outcome set — for migrating old triggers. */
export function whenFromOutcomes(outcomes) {
  const want = [...new Set(outcomes ?? [])].sort().join(',')
  return WHEN_KINDS.find(k => OUTCOMES_FOR[k].slice().sort().join(',') === want) ?? 'always'
}

/** Stored JSON → [{ flowId, when }]. Never throws; unknown shapes vanish. */
export function parseAttachments(json) {
  let raw = json
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return [] } }
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  return raw.flatMap(a => {
    const flowId = Number(a?.flowId)
    if (!Number.isFinite(flowId) || seen.has(flowId)) return []
    seen.add(flowId)
    return [{ flowId, when: WHEN_KINDS.includes(a?.when) ? a.when : 'always' }]
  })
}

/** [{ flowId, when }] → the column value (NULL when nothing is attached). */
export function serializeAttachments(list) {
  const clean = parseAttachments(list)
  return clean.length ? JSON.stringify(clean) : null
}

/** Does this attachment fire for that outcome? Pure — unit-tested. */
export function attachmentFires(att, outcome) {
  return outcomesFor(att?.when).includes(outcome)
}

/** Flows that can be attached at all: a `run_finished` trigger and nothing else. */
export function attachableFlows() {
  return listFlows().filter(f => (f.trigger?.kind ?? 'manual') === 'run_finished')
}

// ------------------------------------------------------------------ form block

/**
 * The attachment as form fields — embedded identically by the agent form and
 * the single-run form (through `runDefFields`). Same shape as the extra-skills
 * block: a checkbox per flow, a dial next to the checked ones.
 */
export function flowAttachFields(json) {
  const chosen = new Map(parseAttachments(json).map(a => [a.flowId, a.when]))
  const flows = attachableFlows()
  // Only the way INTO a new flow, deliberately not into the flow list: a flow
  // hangs on this agent or this single run, and the list is not part of that
  // thought. hub.js appends `back=<this page>` to the link and parks the form in
  // sessionStorage, so the trip to the editor does not cost what was typed.
  const links = `<p class="dim"><a href="/flows/edit">${e(t('flows.attach.new'))}</a></p>`
  if (!flows.length) {
    return `<fieldset class="flows-attach"><legend>${e(t('flows.attach.legend'))}</legend>
      <p class="dim">${e(t('flows.attach.none'))}</p>${links}</fieldset>`
  }
  return `<fieldset class="flows-attach"><legend>${e(t('flows.attach.legend'))}</legend>
  <p class="dim">${e(t('flows.attach.hint'))}</p>
  ${flows.map(f => {
    const when = chosen.get(f.id)
    return `<label class="chk"><input type="checkbox" name="flows" value="${f.id}" ${when ? 'checked' : ''}>
      <b>${e(f.name)}</b>${f.active ? '' : ` <span class="warn">${e(t('flows.attach.inactive'))}</span>`}
      <a class="dim" href="/flows/edit?id=${f.id}">${e(t('flows.edit'))}</a></label>
    <label class="chk skill-regler">↳ ${e(t('flows.attach.when'))}
      <select name="flow_when_${f.id}">${WHEN_KINDS.map(k =>
        `<option value="${k}" ${(when ?? 'always') === k ? 'selected' : ''}>${e(t(`flows.when.${k}`))}</option>`).join('')}</select></label>`
  }).join('')}
  ${links}</fieldset>`
}

/** Form body → the column value. Only flows that really exist survive. */
export function attachmentsFromForm(b) {
  const roh = Array.isArray(b.flows_list) ? b.flows_list
    : b.flows == null ? [] : Array.isArray(b.flows) ? b.flows : [b.flows]
  const known = new Set(attachableFlows().map(f => f.id))
  return serializeAttachments(roh.map(Number).filter(id => known.has(id)).map(flowId => ({
    flowId,
    when: b[`flow_when_${flowId}`],
  })))
}

/** "review (on failure), notify" — one line for a table cell. */
export function attachmentSummary(json) {
  const flows = new Map(listFlows().map(f => [f.id, f.name]))
  return parseAttachments(json)
    .map(a => `${flows.get(a.flowId) ?? `#${a.flowId}`}${a.when === 'always' ? '' : ` (${t(`flows.when.${a.when}`)})`}`)
    .join(', ')
}

/**
 * The run detail page's flow section: what this run will start when it ends,
 * and what it has already started. Rendered here so pages.mjs needs exactly one
 * import instead of knowing the flow tables.
 */
export function flowSection(run) {
  const attached = parseAttachments(run.flows)
  const runs = db.prepare(`SELECT id, flow_name, status, started_at FROM flow_runs
                           WHERE trigger_run_id = ? ORDER BY started_at`).all(run.id)
  if (!attached.length && !runs.length) return ''
  const names = new Map(listFlows().map(f => [f.id, f.name]))
  const DOT = { running: 'yellow', waiting: 'yellow', done: 'green', failed: 'red', stopped: 'red' }
  return `<h3>${e(t('flows.attach.legend'))}</h3>
  ${attached.length ? `<ul>${attached.map(a => `<li><a href="/flows/edit?id=${a.flowId}">${e(names.get(a.flowId) ?? `#${a.flowId}`)}</a>
    <span class="dim">— ${e(t(`flows.when.${a.when}`))}</span></li>`).join('')}</ul>`
    : `<p class="dim">${e(t('flows.attach.run_none'))}</p>`}
  ${runs.length ? `<ul>${runs.map(fr => `<li><a href="/flows/runs/${fr.id}"><span class="dot ${DOT[fr.status] ?? 'yellow'}"></span>
    ${e(fr.flow_name)}</a> <span class="dim">${e(fr.started_at)}</span></li>`).join('')}</ul>` : ''}`
}

// ------------------------------------------------- the repo side: flows after a merge

/**
 * What runs after a merge of this repo — the repo form's block, rendered here
 * so pages.mjs keeps its one import into this module instead of learning the
 * flow tables.
 *
 * A `run_merged` flow hangs on the REPO, not on an agent, so the attachment
 * block above cannot show it and the agent page is the wrong way in: a merge
 * may be carried by a conflict run that never belonged to an agent. This is
 * that way in — the list plus the button that creates one with the trigger and
 * the repo already filled in.
 *
 * Empty for a repo that is being created: there is no id yet to hang a flow on.
 */
export function mergeFlowsBlock(repo) {
  const id = Number(repo?.id) || 0
  if (!id) return ''
  const flows = flowsForMergeOfRepo(id)
  const back = encodeURIComponent(`/repos/edit?id=${id}`)
  const rows = flows.map(f => `<li><a href="/flows/edit?id=${f.id}">${e(f.name)}</a>
    <span class="${f.active ? 'ok' : 'warn'}">${e(f.active ? t('flows.on') : t('flows.off'))}</span>
    ${mergeTriggerRepoId(f.trigger) === null ? `<span class="dim">${e(t('repos.merge_flows_all'))}</span>` : ''}</li>`).join('')
  return `<fieldset class="merge-flows"><legend>${e(t('repos.merge_flows'))}</legend>
  ${rows ? `<ul>${rows}</ul>` : `<p class="dim">${e(t('repos.merge_flows_none'))}</p>`}
  <p><a class="btn" href="/flows/edit?trigger=run_merged&amp;repo=${id}&amp;back=${back}">${e(t('repos.merge_flows_new'))}</a></p>
  </fieldset>`
}

/**
 * The same fact as one short addition for a table cell (`· 2 flow(s)`), empty
 * when there is none.
 *
 * TODO(spec): its place is the repo list's "Integration" column, behind the
 * merge mode — and that column is built in the merge integrator's branch, not
 * in this one. Whoever merges the two drops this call into that cell; until
 * then the repo form's block above is the only way in, and nothing is lost.
 */
export function mergeFlowsHint(repoId) {
  const n = flowsForMergeOfRepo(repoId).length
  return n ? ` <span class="dim">· ${e(t('repos.merge_flows_count', { n }))}</span>` : ''
}

// ------------------------------------------------- the other side: the flow editor

/** Which agents this flow hangs on — the flow editor's view of the same rows. */
export function agentsWithFlow(flowId) {
  return db.prepare('SELECT a.id, a.name, a.flows, r.name AS repo FROM agents a JOIN repos r ON r.id=a.repo_id ORDER BY a.name')
    .all()
    .flatMap(a => {
      const att = parseAttachments(a.flows).find(x => x.flowId === flowId)
      return att ? [{ agentId: a.id, name: a.name, repo: a.repo, when: att.when }] : []
    })
}

/**
 * Rewrite this flow's attachments from the flow editor: every agent in the list
 * gets it (with its condition), every other agent loses it. Only this flow's
 * entry is touched — the agents' other attachments stay untouched and keep
 * their order.
 */
export function setFlowAttachments(flowId, list) {
  const wanted = new Map()
  for (const x of Array.isArray(list) ? list : []) {
    const id = Number(x?.agentId)
    if (Number.isFinite(id)) wanted.set(id, WHEN_KINDS.includes(x?.when) ? x.when : 'always')
  }
  const upd = db.prepare(`UPDATE agents SET flows=?, updated_at=datetime('now') WHERE id=?`)
  for (const a of db.prepare('SELECT id, flows FROM agents').all()) {
    const before = parseAttachments(a.flows)
    const rest = before.filter(x => x.flowId !== flowId)
    const next = wanted.has(a.id) ? [...rest, { flowId, when: wanted.get(a.id) }] : rest
    const value = serializeAttachments(next)
    if (value !== (a.flows ?? null)) upd.run(value, a.id)
  }
}

/** Remove a deleted flow from every agent — otherwise dead ids pile up. */
export function forgetFlow(flowId) { setFlowAttachments(flowId, []) }
