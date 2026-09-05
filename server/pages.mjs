// Freilauf — pages: server-rendered HTML, vanilla JS, red/yellow/green as the
// only colors (planning 10). Repo switcher + switch states in the header.
// All UI strings go through i18n (lang/<code>.json; English is the default).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import db, { getRepo, getRun } from './db.mjs'
import { KNOWN_QUANTIZATIONS, REGIONS, parseRoutingConfig } from './providers/openrouter-routing.mjs'
import { escapeHtml as e, validCron, WOCHENTAGE, weeklySlots, slotsUniform, splitTimes, scheduleText, parseDbUtc, catchupHours, fmtRelativeTime, fmtDateTime, fmtDbUtc, fmtClock, fmtDatePart, fmtNum, fmtPercent, tzAbbrev, uiTimezone, setTimezone, setPublicHost, TIMEZONE_OPTIONS, hubVersion, publicBase, WORKTREES_DIR, RUNS_DIR } from './util.mjs'
import { cookieRepo, requestRepo } from './web-helpers.mjs'
import { providerBalances } from './balances.mjs'
import { enabledCodingAgents, saveCodingAgent, deleteCodingAgent } from './coding-agents.mjs'
import {
  runDefFields, runDefFromForm, saveAgent, lastRunChoice, rememberRunChoice,
  runTitleField, runStartTimeFields, runStartFromForm,
  runSetupFields, runSetupFromForm, branchFields, branchContext,
  agentNameTaken, moveAgent, deleteAgent, EMPTY_SCHEDULE,
} from './run-def.mjs'
import {
  listFavorites, getFavorite, saveFavorite, deleteFavorite,
  favoriteFromForm, favoriteTemplate, favoriteSummary, FAVORITES_MAX,
} from './favorites.mjs'
import { runTitle, titleModelsMru, rememberTitleModel, DEFAULT_TITLE_MODEL } from './title.mjs'
import { extrasModelsMru, rememberExtrasModel, DEFAULT_EXTRAS_MODEL } from './extras-suggest.mjs'
import { runEditAllowed } from './run-edit.mjs'
import { harnessLabel } from './harnesses/index.mjs'
import { getProvider, providerLabel } from './providers/index.mjs'
// What a coding agent holds in its OWN credential store — asked of the plugin,
// cached there, `null` when it cannot be established. See providerChoiceBlock().
import { harnessOwnCredentials } from './models.mjs'
import { subscriptionUsage } from './usage.mjs'
import { panelValues, panelState } from './panels.mjs'
import { ampelAusVorfaellen, offeneVorfaelle, alleVorfaelle, brauchtMensch } from './incidents.mjs'
import { TYP_TEXT } from './detect.mjs'
import { llmModelleMru, llmModellMerken } from './pruefer.mjs'
import { skillListe, skillAnzeige, skillFelder, skillsAusFormular } from './zusaetze.mjs'
import { resumeCommand } from './integrate.mjs'
import { listSessions, sessionMemory, sessionKeepHours, currentKeepMs, paneAlive, archiveSessionKeepHours } from './sessions.mjs'
import { cleanupSettings, cleanupConfigured, cleanupRunInFlight } from './cleanup.mjs'
import { attachmentSummary, flowSection, flowAttachFields, mergeFlowsBlock, mergeFlowsHint } from './flows/attach.mjs'
import { flowRunKeepDays } from './flows/db.mjs'
// "Freilauf found N things on this machine it could use" — derived, not passed,
// exactly like setupBanner() above: the layout calls it on every page and it
// answers out of the discovery table. It lives with the page that answers it.
import { discoveryBanner, checkbox } from './plugins/web.mjs'
import {
  availableSkills, harnessSkillRoots, skillTargets, installedOverview, removalPlan,
  skillConflicts, foreignCopies, skillsInstallOn, skillsAutoUpdate, syncSkills, rootExists,
  selectedSkillNames,
} from './skills.mjs'
// The budget-gate thresholds are no longer typed into this file: every plugin
// that declares a gate brings its own fields, and the historic keys survive
// because a built-in field names them itself (`settingKey`).
import { gatePlugins, pluginFields, pluginSettingKey, allPluginSettingKeys } from './plugins/settings.mjs'
import { pluginHasCredential } from './plugins/store.mjs'
// Which model source answers the hub's own questions — the picker above each
// of the three LLM model fields.
import { llmSources, DEFAULT_SOURCE } from './llm/sources.mjs'
// The flow block of the detail page is rendered in server/flows/ and belongs to
// that module; it is re-exported here so a fragment has ONE place to ask for a
// piece of a page, whichever module happens to build it.
export { flowSection }
import { t, LANGUAGES, currentLanguage, setLanguage, clientCatalog } from './i18n.mjs'
import { env } from './env.mjs'

/**
 * Input errors belong on a page with a way back — not in a 500 ("internal
 * error") or a bare text response that swallows the inputs.
 */
export async function problemPage(req, res, title, problems, backHref) {
  const body = `<h2>${e(title)}</h2>
  <ul class="err">${problems.map(p => `<li>${e(p)}</li>`).join('')}</ul>
  <div class="btn-row"><a class="btn" href="${e(backHref)}">${e(t('problem.back'))}</a></div>`
  res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, title, '', body))
}

/** State of the global AND gate for scheduled starts. */
function pipelineAn() {
  return db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get()?.value === '1'
}

/**
 * `incidents.schwere` is a STORED value ('gelb'/'rot'), the CHECK on the table
 * spells it that way and a rename would be a migration. The markup is not the
 * database, though — the stylesheet speaks English — so the two meet here
 * instead of the German word leaking into a class attribute.
 */
const SEVERITY_CLASS = { rot: 'red', gelb: 'yellow' }
/** …and the same value as a word on the incident line — it used to print raw. */
const SEVERITY_TEXT = { rot: 'incidents.severity_red', gelb: 'incidents.severity_yellow' }

function ampel(run) {
  const vf = ampelAusVorfaellen(run.id)
  const red = vf === 'rot' || ['waiting_help', 'failed'].includes(run.status)
    || db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind LIKE 'anomaly:%' AND kind NOT IN ('anomaly:no_activity','anomaly:soft_overrun','anomaly:followup_soft_overrun','anomaly:unpushed') LIMIT 1`).get(run.id)
  // A run in the finish gate is at least yellow: it has reported, and something
  // is still keeping its work off the base branch. A blocked_* one is red
  // through its incident anyway.
  const yellow = !red && (
    vf === 'gelb' || run.status === 'deferred' || !!run.finish_state
    || db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind IN ('anomaly:no_activity','anomaly:soft_overrun','anomaly:followup_soft_overrun','anomaly:unpushed') LIMIT 1`).get(run.id))
  return red ? 'red' : yellow ? 'yellow' : 'green'
}

/**
 * The traffic light as a dot. All three carry the same kind of label, and it is
 * a translated one: the red dot used to say `title="rot"` — a raw German word,
 * on every row of the overview — while yellow and green said nothing at all.
 * Colour alone is not a channel everyone has, and the dot answers more than the
 * status word beside it does (incidents and anomalies feed `ampel()` too).
 */
const AMPEL_DOT = {
  red: () => `<span class="dot red" title="${e(t('ampel.red'))}"></span>`,
  yellow: () => `<span class="dot yellow" title="${e(t('ampel.yellow'))}"></span>`,
  green: () => `<span class="dot green" title="${e(t('ampel.green'))}"></span>`,
}

/**
 * The last anomaly of a run, in words, or null when there is none.
 *
 * null rather than '–': it is the second line of the status cell now, and a
 * dash on its own line is a line that says nothing while costing a row's
 * height on every run that is simply fine.
 *
 * The event kind is a database value (`anomaly:no_activity`) and was printed
 * raw for as long as it had a column of its own to hide in. Same treatment as
 * an incident type in `typName()`: a key if there is one, the raw kind if the
 * watcher ever invents a new one — a page must not go blank over a word.
 *
 * Some anomalies carry a named subject in their payload — `quota_full` names
 * the window it saw full ('5h', '7d Fable', …) — and that word goes into the
 * line, because "quota exhausted" without the window is exactly the case where
 * one cannot tell whose quota ran out.
 */
function lastAnomaly(runId) {
  const r = db.prepare(`SELECT kind, ts, payload FROM events WHERE run_id=? AND (kind LIKE 'anomaly:%' OR kind='help') ORDER BY id DESC LIMIT 1`).get(runId)
  if (!r) return null
  const key = `anomaly.${String(r.kind).replace(/^anomaly:/, '')}`
  const name = t(key) === key ? r.kind : t(key)
  let fenster = ''
  try {
    const p = JSON.parse(r.payload ?? 'null')
    if (p && p.window) fenster = `${p.window} · `
  } catch {}
  return `${name} (${fenster}${fmtDbUtc(r.ts)})`
}

/** Name of an incident type, also for 'provider_down:openrouter'. */
export function typName(typ) {
  const [kopf, rest] = String(typ).split(':')
  const name = t(`incident.${kopf}`) !== `incident.${kopf}` ? t(`incident.${kopf}`) : (TYP_TEXT[kopf] ?? kopf)
  return name + (rest ? ` (${rest})` : '')
}

/**
 * Open incidents of a run as a compact badge, with the resolving action on
 * hover.
 *
 * It used to be a framed box with a permanently visible "Dismiss" button, and
 * on its own it drove the row height to ~130px — for a column that is empty on
 * almost every run. Same rule as the pencil and the archive button now: the
 * badge is what one reads, the action appears where one is about to click, and
 * the keyboard reaches it because focus inside the form reveals it too.
 */
function vorfallZelle(runId, repoId, runStatus = null) {
  const offen = offeneVorfaelle(runId)
  if (!offen.length) return '<span class="leer">–</span>'
  return `<div class="incident-cell">${offen.map(v => {
    // '!' marks the ones that are waiting for hands — in a table of many runs
    // that mark is the whole difference between a to-do and a note.
    const handeln = brauchtMensch(v, runStatus)
    const titel = `${typName(v.typ)} · ${t('incidents.last')} ${fmtDbUtc(v.zuletzt_gesehen)}${v.beleg ? `\n${v.beleg}` : ''}`
    return `<span class="incident ${SEVERITY_CLASS[v.schwere]}" title="${e(titel)}">${handeln ? '❗ ' : ''}${e(typName(v.typ))} ${v.anzahl}×</span>
    <form method="post" action="/api/incidents/${v.id}/resolve" class="inline" onclick="event.stopPropagation()">
      <input type="hidden" name="back" value="/?repo=${repoId}"><button title="${e(t('incidents.resolve_hint'))}">${e(t(handeln ? 'incidents.mark_handled' : 'incidents.dismiss'))}</button></form>`
  }).join('')}</div>`
}

/** Global incidents (provider pulse) above all pages. */
function globalesBanner() {
  const offen = offeneVorfaelle(null)
  if (!offen.length) return ''
  return `<div class="banner red">${offen.map(v => `🔴 <b>${e(typName(v.typ))}</b> ${e(t('incidents.global_since', { ts: fmtDbUtc(v.erst_gesehen) }))} (${e(t('incidents.checked', { n: v.anzahl }))}) — ${e(v.beleg ?? '')}
    <form method="post" action="/api/incidents/${v.id}/resolve" class="inline"><input type="hidden" name="back" value="/"><button>${e(t(brauchtMensch(v) ? 'incidents.mark_handled' : 'incidents.dismiss'))}</button></form>`).join('<br>')}</div>`
}

/**
 * The page belongs to one repo, and the header points somewhere else.
 *
 * A page that shows a single object cannot follow the switcher — a run belongs
 * to its repo, and rendering repo B's overview under `/runs/<id>` would be a 404
 * with extra steps. So it reloads as itself and only the CHOICE moves (the rule
 * lives in `layout()`, see there). That is right, and it is silent: the header
 * then names a repo the content in front of one has nothing to do with, and the
 * sidebar counts somebody else's runs. This one line says so.
 *
 * It offers the way the click was probably meant to go — the chosen repo's
 * overview — because a hint that only states the problem makes the reader hunt
 * for the switcher again.
 */
function otherRepoBanner(pageRepo, headerRepo, repos) {
  const name = (id) => repos.find(r => r.id === id)?.name ?? getRepo(id)?.name ?? String(id)
  return `<div class="banner other-repo">↔ ${e(t('layout.other_repo', { page: name(pageRepo), header: name(headerRepo) }))}
    <a class="btn ghost" href="/?repo=${headerRepo}">${e(t('layout.other_repo_cta', { repo: name(headerRepo) }))}</a></div>`
}

/** Top bar shown on every page while no coding agent is configured. */
function setupBanner() {
  if (enabledCodingAgents().length) return ''
  return `<div class="banner setup">⚙️ ${e(t('banner.no_coding_agent'))}
    <a class="btn" href="/settings/coding-agents">${e(t('banner.no_coding_agent_cta'))}</a></div>`
}

/**
 * Quick Run — a run from a favorite, startable from every page.
 *
 * It sits in the layout, so it is reachable wherever one happens to be: the
 * moment one wants to send a task off is rarely the moment one is standing on
 * the run form. The dialog asks for the three things a favorite deliberately
 * does NOT carry — the task, the start time, the branch rule — and nothing else.
 * The first two stand open, because a run one wants at eight tonight is decided
 * in the same breath as the task; only the branch rule is folded away, being the
 * one of the three that is usually left as it is.
 *
 * It does not navigate. `POST /api/runs/quick` answers with JSON, the page stays
 * where it was and a toast says what happened, with a link to the run for
 * whoever wants to look. Being torn to a detail page is exactly what makes a
 * quick start not quick.
 *
 * The one exit that does lead away is "More settings": it opens the FULL
 * single-run form in a new window (`/runs/new?repo=…&favorite=…`) with the
 * dialog's state carried over — the favorite becomes the form's template, and
 * hub.js parks the task, the branch rule and the start time in sessionStorage
 * so the new window restores them. The moment one wants more than the dialog
 * asks, the run stops being quick, and the full form is the place it belongs.
 */
function quickRunDialog(repos, selectedRepo) {
  const favs = listFavorites()
  const body = !repos.length
    ? `<p class="dim">${e(t('qr.no_repo'))}</p><p><a class="btn" href="/repos/edit">${e(t('norepo.cta'))}</a></p>`
    : !favs.length
      ? `<p class="dim">${e(t('qr.no_favorite'))}</p><p><a class="btn" href="/settings/favorites">${e(t('fav.create'))}</a></p>`
      : `<form id="qr-form" class="form-grid">
    <label>${e(t('layout.repo'))} <select name="repo_id">${repos.map(r =>
      `<option value="${r.id}" ${r.id == selectedRepo ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select></label>
    <label>${e(t('qr.favorite'))} <select name="favorite_id" id="qr-fav">${favs.map(f =>
      `<option value="${f.id}" data-summary="${e(favoriteSummary(f))}">${e(f.name)}</option>`).join('')}</select>
      <span class="fav-tip"><button type="button" class="fav-info" id="qr-fav-info"
        aria-describedby="qr-fav-tip" aria-label="${e(t('qr.favorite_info'))}">i</button>
        <span class="tip" id="qr-fav-tip" role="tooltip"></span></span></label>
    <label>${e(t('qr.prompt'))} <textarea name="prompt" rows="8" required placeholder="${e(t('qr.prompt_ph'))}"></textarea></label>
    ${runStartTimeFields({})}
    <details class="qr-more"><summary>${e(t('qr.more'))}</summary>
      ${branchFields({ branch_mode: 'keiner' }, branchContext(selectedRepo))}
    </details>
    <p class="err" id="qr-error" hidden></p>
    <menu class="qr-actions">
      <button type="button" class="ghost" data-qr-full>${e(t('qr.full'))}</button>
      <button type="button" class="ghost" data-qr-close>${e(t('qr.cancel'))}</button>
      <button type="submit">${e(t('qr.start'))}</button>
    </menu>
  </form>`
  return `<dialog id="qr-dialog" class="qr">
    <h3>⚡ ${e(t('qr.title'))} <button type="button" class="mini" data-qr-close aria-label="${e(t('qr.cancel'))}">✕</button></h3>
    ${body}
  </dialog>`
}

/**
 * The routing note a run whose serving provider was resolved by "auto" carries:
 * the requirements it asked for and the order it got — the run page answers
 * "what did this run actually launch with" without a trip to the log.
 */
function runRoutingNote(orRouting) {
  const cfg = runRoutingJson(orRouting)
  if (!cfg || cfg.mode !== 'auto') return ''
  const order = Array.isArray(cfg.order) && cfg.order.length ? cfg.order.join(' → ') : (cfg.best ? `${cfg.best}` : '')
  return ` (${t('or.mode_auto')}${cfg.unresolved ? ` — ${t('run.pinned_unresolved')}` : ''}${order ? `: ${order}` : ''})`
}

/** Tolerant reader: the column is TEXT and may hold junk from older rows. */
function runRoutingJson(s) {
  try { return JSON.parse(s ?? '') ?? null } catch { return null }
}

/**
 * The "find worktree extras" dialog — repo create AND edit form. The repo path
 * checks path existence and "is a git project" algorithmically first (the
 * endpoint answers those without a model), and only a path that passes both
 * reaches the LLM. The warning before starting is load-bearing: the suggestion
 * REPLACES the current JSON completely, it does not extend it.
 */
function extrasDialog() {
  return `<dialog id="extras-dialog" class="qr">
    <h3>${e(t('repos.extras_dialog_title'))} <button type="button" class="mini" data-extras-close aria-label="${e(t('qr.cancel'))}">✕</button></h3>
    <p class="dim">${e(t('repos.extras_dialog_hint'))}</p>
    <p>${e(t('repos.path'))}: <code id="extras-path"></code></p>
    <p class="warn">${e(t('repos.extras_warn'))}</p>
    <p class="err" id="extras-error" hidden></p>
    <p id="extras-working" hidden><span class="spinner"></span> ${e(t('repos.extras_working'))}</p>
    <menu class="qr-actions">
      <button type="button" class="ghost" data-extras-close>${e(t('qr.cancel'))}</button>
      <button type="button" id="extras-start">${e(t('repos.extras_start'))}</button>
    </menu>
  </dialog>`
}

/**
 * The "free memory" dialog — the ONE modal both triggers (the sidebar's small
 * button and the box on the Sessions page) open. It asks the single thing a
 * manual cleanup needs: the target, in GB. The optional keep-runs field is
 * rendered only on the Sessions page, where naming the runs to protect is a
 * natural part of the manual action — everywhere else a cleanup starts with
 * "target, go".
 *
 * `memGb` is the current total tmux memory, shown so the answer is a number
 * on the same scale as the question. It is the sidebar's cached measurement
 * (sessionMemory) — the same number the block next to the button shows.
 */
async function cleanupDialog({ withKeep = false, memGb = null } = {}) {
  const s = cleanupSettings()
  const current = memGb != null
    ? `<p class="dim">${e(t('cleanup.dialog_current', { gb: memGb }))}</p>`
    : ''
  const keepField = withKeep
    ? `<label>${e(t('cleanup.dialog_keep'))} <input name="keep" placeholder="${e(t('sessions.free_keep_ph'))}">
        <span class="dim">${e(t('cleanup.dialog_keep_hint'))}</span></label>`
    : ''
  return `<dialog id="cleanup-dialog" class="qr cleanup">
    <h3>${e(t('sessions.free_title'))} <button type="button" class="mini" data-cleanup-close aria-label="${e(t('qr.cancel'))}">✕</button></h3>
    <p class="dim">${e(t('cleanup.dialog_hint'))}</p>
    ${current}
    <form id="cleanup-dialog-form" class="form-grid">
      <label>${e(t('cleanup.target'))} <input type="number" name="target" min="0" step="0.1" value="${e(String(s.targetGb))}">
        <span class="dim">${e(t('cleanup.target_hint'))}</span></label>
      ${keepField}
      <p class="err" id="cleanup-dialog-error" hidden></p>
      <menu class="qr-actions">
        <button type="button" class="ghost" data-cleanup-close>${e(t('qr.cancel'))}</button>
        <button type="submit">${e(t('sessions.free_btn'))}</button>
      </menu>
    </form>
  </dialog>`
}

/**
 * The cleanup dialog for the current page. Rendered only when a cleanup agent is
 * configured (then there is a trigger to open it); the keep field is the
 * Sessions page's own manual concern. The memory shown next to the target is the
 * sidebar's cached measurement — the same number the block beside the button
 * shows, so the two can never disagree.
 */
async function cleanupDialogHtml(active) {
  if (!cleanupConfigured()) return ''
  let memGb = null
  try {
    const m = await sessionMemory()
    if (m?.rssKb) memGb = +(m.rssKb / 1024 / 1024).toFixed(1)
  } catch { /* no tmux: the dialog still opens, just without the reading */ }
  return cleanupDialog({ withKeep: active === '/sessions', memGb })
}

/**
 * ONE quota bar for the whole application.
 *
 * There used to be two: `bar()` in the header and `pctBar()` in the usage
 * panel. Same reading, two markups, two track colours, and the thresholds
 * spelled out twice — so "80 % is yellow" was a statement the code made in two
 * places and could have made differently in each. That duplication is the
 * reason the status sidebar exists at all: everything that says how much is
 * left now comes out of here.
 */
export function quotaBar(pct, { label = '', note = '', title = '' } = {}) {
  const klasse = pct == null ? '' : pct >= 90 ? 'r' : pct >= 80 ? 'y' : ''
  return `<span class="quota"${title ? ` title="${e(title)}"` : ''}>${
    label ? `<span class="quota-label">${e(label)}</span>` : ''}<span class="track"><span class="fill ${klasse}" style="width:${Math.min(pct ?? 0, 100)}%"></span></span><span class="quota-pct">${fmtPercent(pct)}</span>${
    note ? `<span class="dim">${e(note)}</span>` : ''}</span>`
}

/**
 * The pipeline switch as a state with weight, not as a sentence.
 *
 * Name, id and fragment route still say "header" because that is where this
 * block used to sit and because the live channel from phase 2 addresses it by
 * exactly that id. It lives in the status sidebar now — a reading that belongs
 * on every page does not belong in a bar that has to stay one line high.
 */
export function headerStatus() {
  const pipeline = pipelineAn()
  // The running version next to the pipeline switch: since the service runs from
  // its own deploy checkout, no directory tells you any more what is live. Only
  // the sha — deliberately no "N behind origin", which would mean a git fetch on
  // every page render.
  const version = hubVersion()
  return `<div id="header-status" title="${e(t('layout.pipeline_hint'))}">
    <span class="dim">${e(t('layout.pipeline'))}</span>
    <b class="${pipeline ? 'ok' : 'warn'}">${e(pipeline ? t('layout.on') : t('layout.off'))}</b>
    ${version ? `<span class="dim">${e(t('status.version'))} <code>${e(version)}</code></span>` : ''}</div>`
}

/** The four statuses that mean "there is work in flight", in reading order. */
const WORK_STATUSES = ['running', 'waiting_help', 'scheduled', 'deferred']

/** A run status as a word one can read, in the operator's language. */
export function statusText(status) {
  const key = `status.${status}`
  const txt = t(key)
  return txt === key ? String(status) : txt
}

/**
 * Is a FINISHED run working again? True while a follow-up commission is open:
 * the operator typed new work into the session (`followup_since`, cleared when
 * the follow-up reports or its session ends), or a follow-up is in the gate /
 * being merged (`followup_open`). The run's `status` keeps telling the truth
 * about the first attempt — what changed is displayed: "running" again, with a
 * line saying it is follow-up work.
 */
export function followUpActive(run) {
  return !!run && ['done', 'failed', 'aborted'].includes(run.status)
    && !!(run.followup_since || run.followup_open)
}

/** The status word a run displays under — "running" while a follow-up is open. */
export function displayStatus(run) {
  return followUpActive(run) ? 'running' : run.status
}

/** How much work is in flight in this repo, per status, linked into the overview. */
function workBlock(repoId) {
  if (repoId == null) return ''
  const zeilen = WORK_STATUSES.map(s => {
    const n = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL AND status=?`).get(repoId, s).c
    // A finished run with an open follow-up commission is work in flight and is
    // counted where the operator looks for it: under "running". The same rows
    // the status filter (overviewRuns) puts behind that link.
    const nachfolge = s === 'running'
      ? db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL
          AND status IN ('done','failed','aborted') AND followup_since IS NOT NULL`).get(repoId).c
      : 0
    const gesamtN = db.prepare(`SELECT count(*) c FROM runs WHERE archived_at IS NULL AND status=?`).get(s).c
    const gesamtNachfolge = s === 'running'
      ? db.prepare(`SELECT count(*) c FROM runs WHERE archived_at IS NULL
          AND status IN ('done','failed','aborted') AND followup_since IS NOT NULL`).get().c
      : 0
    if (!(n + nachfolge)) return null
    return {
      status: s,
      n: n + nachfolge,
      // The sum of ALL repos for that status — the reading "1 running" that does
      // not add up only makes sense against the other repos' loads.
      gesamt: gesamtN + gesamtNachfolge,
    }
  }).filter(Boolean)
  if (!zeilen.length) return `<div class="side-block"><span class="side-label">${e(t('side.work'))}</span>
    <span class="dim">${e(t('side.work_none'))}</span></div>`
  return `<div class="side-block"><span class="side-label">${e(t('side.work'))}</span>
    <ul class="side-counts">${zeilen.map(z =>
      `<li><a href="/?repo=${repoId}&amp;status=${e(z.status)}"><span class="n">${z.n}</span> <span>${e(statusText(z.status))} <span class="dim">${e(t('side.work_here'))}</span></span></a>
      ${z.gesamt > z.n ? `<span class="overall dim">${e(t('side.work_overall', { n: z.gesamt }))}</span>` : ''}</li>`).join('')}</ul></div>`
}

/**
 * Open incidents of this repo, split the way incidents.mjs splits them: what is
 * waiting for hands, and what the hub merely wrote down. Zero of a group means
 * the group is absent — a "0" is not information, it is furniture.
 *
 * An ARCHIVED run's incidents are not counted. Everywhere else in the hub an
 * archived run keeps its incidents — the watcher, the flows and the detail page
 * all go on seeing them, and that is deliberate. Here it is not, for one
 * reason: this count is a LINK, and it links into the overview, which no
 * archived run is ever in. Measured on this installation — two open incidents,
 * both on runs the operator had archived, so both repos said "1 needs you" and
 * both clicks landed on "no runs yet". A number that promises rows nobody can
 * see is the same lie the run multi-select has a rule about; archiving is the
 * operator saying "put this away", and the record stays readable in the archive
 * and on the run's own page.
 *
 * Global incidents (run_id IS NULL — the provider pulse, a lost tmux server) do
 * stay counted: they need hands and belong to no run. They are also the one
 * group the filtered overview cannot show, which is why `linkable` exists —
 * see incidentBlock().
 */
function openIncidents(repoId) {
  const offen = db.prepare(`SELECT i.*, r.status AS run_status FROM incidents i
    LEFT JOIN runs r ON r.id = i.run_id
    WHERE i.geloest_am IS NULL AND (i.run_id IS NULL OR (r.repo_id = ? AND r.archived_at IS NULL))`).all(repoId ?? -1)
  const handeln = offen.filter(v => brauchtMensch(v, v.run_status)).length
  return {
    offen: offen.length, handeln, noticed: offen.length - handeln,
    linkable: offen.filter(v => v.run_id !== null).length,
  }
}

function incidentBlock(repoId) {
  const { offen, handeln, noticed, linkable } = openIncidents(repoId)
  if (!offen) return ''
  // The counts link into the overview filtered to the runs that carry an open
  // incident — the same gesture as the work-in-flight block above: a click on
  // a number shows the rows behind it, not a hunt through every run. With
  // nothing but global incidents open there are no rows to show, and then the
  // number is a number: a link to an empty list reads as a page that lost the
  // thing it just counted. The global ones carry their own banner on every
  // page, with the button that clears them.
  const ziel = `/?repo=${repoId}&amp;incidents=1`
  const zahl = (klasse, n, text) => linkable
    ? `<div><a href="${ziel}"><b class="${klasse}">${n}</b> ${text}</a></div>`
    : `<div><b class="${klasse}">${n}</b> ${text}</div>`
  return `<div class="side-block side-incidents"><span class="side-label">${e(t('incidents.title'))}</span>
    ${handeln ? zahl('err', handeln, e(t('incidents.needs_you_short'))) : ''}
    ${noticed ? zahl('warn', noticed, e(t('incidents.noticed_short'))) : ''}</div>`
}

/**
 * What every tmux session on this machine costs in memory, together.
 *
 * It belongs on every page and not only on /sessions, because that is the
 * reading one does not go looking for: a session outlives its agent on purpose
 * (`fl-start --keep`), so the bill runs quietly and only ever surprises. Thirty
 * sessions and 15 GB is a measured number from this installation, and nothing
 * in the hub said so until one navigated to the page that lists them.
 *
 * The value comes from sessionMemory(), whose eight-minute cache IS the update
 * interval: the sidebar re-fetches itself every 30 s, and behind that the tmux
 * and `ps` calls happen at most every eight minutes. So the block SAYS that,
 * with the exact measuring time in the tooltip — a number that is up to eight
 * minutes old and presents itself as live is the quiet staleness the claude
 * quota panel was already caught on.
 *
 * The interval is read out of the answer rather than written into the string,
 * because the TTL is an environment variable. And the measuring time is a
 * `title`, not a ticking relative time: this block is rendered both into the
 * page and into the sidebar fragment, and the e2e suite holds those two to be
 * byte for byte identical — a text that changes every second could not be.
 */
async function memoryBlock() {
  let mem = null
  try { mem = await sessionMemory() } catch { mem = null }
  if (!mem) return ''
  const cleanup = cleanupConfigured() ? cleanupSettings() : null
  const free = cleanup
    ? `<div class="mem-free">
        <button type="button" class="btn ghost mem-free-open" data-cleanup-open>${e(t('side.mem_free'))}</button>
      </div>`
    : `<a class="side-cleanup-link" href="/settings/cleanup">${e(t('side.mem_free_none'))}</a>`
  return `<div class="side-block" id="side-mem"><span class="side-label">${e(t('side.mem'))}</span>
    <div><a href="/sessions"><b>${e(mem.rssKb ? byteText(mem.rssKb) : '0 MB')}</b></a>
      <span class="dim">${e(t('side.mem_sessions', { n: mem.sessions }))}</span></div>
    <div class="dim"${mem.measuredAtMs ? ` title="${e(fmtDateTime(mem.measuredAtMs))}"` : ''}>${
      e(t('side.mem_every', { min: Math.max(1, Math.round(mem.intervalMs / 60_000)) }))}</div>
    ${free}</div>`
}

/**
 * The note under a panel's numbers, in a Markdown subset.
 *
 * Escaped FIRST and marked up afterwards, in that order — the string comes from
 * a producer in somebody else's repository and usually carries text an agent
 * wrote. Three constructs and no more: `**bold**`, `` `code` `` and
 * `[text](url)`, the last one only for a link the browser can follow
 * (`hrefOk()`, the same rule the value's own href goes through). Everything
 * else stays the characters it was.
 *
 * This is the escape hatch the "data, never markup" rule needs to be liveable:
 * it buys most of "I want to say it differently" without letting a `<div>` into
 * a 240px column, and the escaping stays in the hub where it is written once.
 */
function noteHtml(note) {
  let out = e(String(note))
  out = out.replace(/`([^`]{1,80})`/g, (_, code) => `<code>${code}</code>`)
  out = out.replace(/\*\*([^*]{1,80})\*\*/g, (_, bold) => `<b>${bold}</b>`)
  out = out.replace(/\[([^\]]{1,80})\]\(([^)\s]{1,300})\)/g, (whole, label, url) => {
    // The URL sits inside an already-escaped string, so `&amp;` has to travel
    // back into the attribute as it stands; only the shape is checked here.
    const clean = url.replaceAll('&amp;', '&')
    if (!/^https?:\/\//i.test(clean) && !(clean.startsWith('/') && !clean.startsWith('//'))) return whole
    return `<a href="${url}">${label}</a>`
  })
  return out
}

/**
 * What a project says about its own work — open findings, tickets, whatever it
 * counts. Pushed through `POST /api/panels`, stored per repo, rendered here.
 *
 * The hub owns the rendering and the producer owns the numbers, which is why
 * this function is the only place that knows what a panel LOOKS like: the same
 * `ul.side-counts` the work block uses, so a panel cannot come to look like a
 * foreign element in this column.
 *
 * Three states, and the difference between the last two is the point: a value,
 * a value that is past its own TTL (greyed, with its age), and a producer that
 * said its measurement failed (the last numbers, greyed, with the reason). A
 * panel that quietly keeps showing an old number is the staleness this hub has
 * been caught by before — so the reading always carries the time it was made.
 */
function panelsBlock(repoId) {
  if (repoId == null) return ''
  const now = Date.now()
  const bloecke = panelValues(repoId).map((p) => {
    const state = panelState(p, now)
    const when = p.atMs ? fmtClock(p.atMs) : null
    const stand = state === 'error'
      ? `<span class="err">${e(t('panel.failed', { error: p.error }))}</span>`
      : state === 'stale'
        ? `<span class="warn">${e(t('panel.stale', { when: when ?? '?' }))}</span>`
        : `<span class="dim">${e(t('panel.as_of', { when: when ?? '?' }))}</span>`
    const kopf = p.total === null ? '' : (() => {
      const zahl = `<span class="n${p.tone ? ` ${p.tone === 'red' ? 'err' : p.tone === 'yellow' ? 'warn' : 'ok'}` : ''}">${e(fmtNum(p.total))}</span>`
      return `<div class="panel-total">${p.href ? `<a href="${e(p.href)}">${zahl}</a>` : zahl}</div>`
    })()
    const zeilen = p.items.length
      ? `<ul class="side-counts">${p.items.map(it => {
        const zahl = it.count === null ? '–' : e(fmtNum(it.count))
        const klasse = it.tone === 'red' ? ' err' : it.tone === 'yellow' ? ' warn' : it.tone === 'green' ? ' ok' : ''
        const inner = `<span class="n${klasse}">${zahl}</span> <span>${e(it.label)}</span>`
        return `<li>${it.href ? `<a href="${e(it.href)}">${inner}</a>` : inner}</li>`
      }).join('')}</ul>`
      : ''
    return `<div class="side-block side-panel${state === 'fresh' ? '' : ' panel-cold'}" data-panel="${e(p.key)}">
      <span class="side-label">${e(p.title)}</span>
      ${kopf}${zeilen}
      ${p.note ? `<div class="panel-note dim">${noteHtml(p.note)}</div>` : ''}
      <div class="panel-stand"${p.atMs ? ` title="${e(fmtDateTime(p.atMs))}"` : ''}>${stand}</div>
    </div>`
  })
  return bloecke.join('')
}

/**
 * The status sidebar — on every page, right of the content.
 *
 * Before this, status stood in three places and only ever fully on the
 * overview: two quota bars in the header, the pipeline switch as running text
 * next to them, and the usage panel on exactly one page. The question those
 * three answer together — "can I send something off right now, and is anything
 * stuck?" — could therefore only be asked from the overview.
 *
 * It is the natural receiver of the live channel: `id="status-sidebar"` is the
 * swap target, and /api/fragments/sidebar renders it through this very
 * function. The open/closed class deliberately sits on the SHELL around it,
 * not on the sidebar — a swap replaces this element whole and would drop it.
 */
/**
 * The rail — what the sidebar still says once it is folded shut.
 *
 * Measured before it existed: folded, the sidebar was a 107x39 box reading
 * "STATUS" and nothing else. A panel that goes silent when closed is one nobody
 * opens again, so it would simply have stayed open and the fold been pointless.
 *
 * It carries exactly the three things one folds it open FOR — can I start
 * something (pipeline), is anything stuck (incidents), and how full is the
 * quota — as marks rather than words, because 46px is not a column of text.
 * Every mark keeps its sentence in the title attribute.
 */
async function sideRail(repoId) {
  const teile = []
  const pipeline = pipelineAn()
  teile.push(`<span class="rail-dot" title="${e(t('layout.pipeline'))}: ${e(pipeline ? t('layout.on') : t('layout.off'))}">
    <span class="dot ${pipeline ? 'green' : 'yellow'}"></span></span>`)

  const { handeln, noticed } = openIncidents(repoId)
  if (handeln) teile.push(`<span class="rail-dot" title="${e(t('incidents.needs_you_short'))}">
    <span class="dot red"></span>${handeln}</span>`)
  if (noticed) teile.push(`<span class="rail-dot" title="${e(t('incidents.noticed_short'))}">
    <span class="dot yellow"></span>${noticed}</span>`)

  // The same numbers the panel shows, as bars that fill from the bottom. Read
  // through subscriptionUsage() rather than re-derived, so the rail cannot come
  // to disagree with the panel it replaces.
  let usage = []
  try { usage = await subscriptionUsage() } catch { usage = [] }
  for (const u of usage) {
    if (!u.ok) continue
    const d = u.data
    // Claude has named windows; everything else has one number, and its mark is
    // the coding agent it belongs to. Cutting the LABEL gave "Cu" for
    // "Cursor CLI" — two letters that name nothing. The harness id at least
    // reads as itself.
    // The rail is the folded sidebar's whole glance, so its weekly figure is the
    // FULLEST window — `seven`, the highest of the weekly ones — not the general
    // one. They are not the same number: a per-model week at 88 % next to a
    // general week at 78 % is what defers the runs on that model, and a rail
    // showing 78 would read as comfortable right up to the point where they get
    // deferred. Which window binds a given run is a question about that run's
    // model (quota.mjs) and cannot be answered by one dot; the panel below
    // breaks the windows out one by one and names each of them.
    const werte = d.kind === 'claude'
      ? [['5h', d.five], ['7d', d.seven]]
      : [[u.harness.slice(0, 3), d.pct]]
    for (const [kurz, pct] of werte) {
      if (pct == null) continue
      const klasse = pct >= 90 ? 'r' : pct >= 80 ? 'y' : ''
      teile.push(`<span class="rail-dot" title="${e(u.label)} ${e(kurz)}: ${e(fmtPercent(pct))}">
        <span class="rail-bar ${klasse}"><i style="height:${Math.min(pct, 100)}%"></i></span>
        <span class="rail-label">${e(kurz)}</span></span>`)
    }
  }
  return `<div class="side-rail" aria-hidden="true">${teile.join('')}</div>`
}

export async function statusSidebar(repoId = null) {
  // The sidebar carries its own repo. <body data-repo> is the live channel's
  // filter and is only set where a page really HAS a repo context; the sidebar
  // reads a repo on every page (the header's switcher shows one there too), so
  // it has to say which one it counted — otherwise the first live update would
  // ask without a repo and the counts would silently fall away.
  return `<aside id="status-sidebar" class="sidebar"${repoId == null ? '' : ` data-repo="${e(String(repoId))}"`}>
  <div class="side-head">
    <h2>${e(t('side.title'))}</h2>
    <button type="button" class="side-toggle" id="side-toggle" aria-controls="side-body"
      aria-expanded="true" title="${e(t('side.toggle'))}" aria-label="${e(t('side.toggle'))}">▸</button>
  </div>
  ${await sideRail(repoId)}
  <div class="side-body" id="side-body">
    <div class="side-block">${headerStatus()}</div>
    ${workBlock(repoId)}
    ${incidentBlock(repoId)}
    ${panelsBlock(repoId)}
    ${await usagePanel()}
    ${await memoryBlock()}
  </div>
</aside>`
}

export async function layout(req, title, active, content, selectedRepo = null, withTerminal = false) {
  // No "Flows" entry: a flow is not a place you go, it hangs on the agent or the
  // single run that starts it. The flow pages are reached from those two forms.
  const nav = [['/', t('nav.overview')], ['/agents', t('nav.agents')], ['/sessions', t('nav.sessions')],
    ['/repos', t('nav.repos')], ['/settings', t('nav.settings')]]
    .map(([href, label]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${e(label)}</a>`).join('')
  // Only ACTIVE repos are offered. This one query feeds both the header
  // switcher and the Quick-Run dialog (which takes the list as a parameter), so
  // deactivating a repo removes it from both at once — see "Deactivating and
  // deleting a repo" in AGENTS.md.
  const repos = db.prepare('SELECT id,name FROM repos WHERE active=1 ORDER BY name').all()
  // Which repo the HEADER stands on — three answers in this order, and the
  // order is the whole point (see the switcher on a page that belongs to ONE
  // repo, below):
  //
  //   1. an explicit ?repo= in the request      — the switcher itself speaking
  //   2. the repo context the page handed over  — the run, the agent, the list
  //   3. the freilauf_repo cookie, then the first repo
  //
  // The switcher, the sidebar and the Quick Run dialog all read this ONE value,
  // so the header can never show one repo while the sidebar talks about another.
  //
  // Why (1) beats (2): a page that shows a single object cannot follow the
  // switcher — a run belongs to its repo, and rendering repo B's overview under
  // /runs/<id> would be a 404 with extra steps. So those pages reload as
  // themselves, and only the CHOICE moves. Before this the choice moved
  // everywhere except in the header of exactly those pages: the click wrote the
  // cookie, the next page obeyed it, and the dropdown one had just used snapped
  // back to the run's repo. Nothing was broken, it just read as if the click had
  // been swallowed. Because the rule lives here and not in the pages, a new page
  // inherits it by being rendered — there is nothing to remember to do.
  const persist = cookieRepo(req)
  const known = (id) => id != null && repos.some(r => r.id === id)
  const effRepo = [requestRepo(req), selectedRepo, persist]
    .map(id => id == null ? null : Number(id)).find(known) ?? repos[0]?.id ?? null
  // …and when those two differ, the page says so (otherRepoBanner above). It is
  // DERIVED, not passed: a page that follows the switcher reads the same
  // `?repo=` into its own `selectedRepo` (selectRepo()), so there the two values
  // are the same by construction and the banner can never appear. Only a page
  // whose repo is fixed — a run, an agent, a repo form — can produce the
  // mismatch, and it does so by handing its repo over like every such page
  // already does. Nothing to remember, same reason the rule above lives here.
  const ownRepo = selectedRepo == null ? null : Number(selectedRepo)
  const otherRepo = ownRepo != null && effRepo != null && ownRepo !== effRepo && known(ownRepo)
    ? otherRepoBanner(ownRepo, effRepo, repos) : ''
  const repoSel = repos.length
    ? `<label class="dim">${e(t('layout.repo'))}</label> <select id="repo-switch">${repos.map(r => `<option value="${r.id}" ${r.id == effRepo ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select>`
    : `<a href="/repos" class="warn">${e(t('layout.no_repo'))}</a>`
  return `<!doctype html><html lang="${e(currentLanguage())}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Freilauf — ${e(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f6fed'/%3E%3Cpath d='M9 11l5 5-5 5' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M17 21h7' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/xterm.css"><link rel="stylesheet" href="/static/hub.css"></head>
<body${selectedRepo == null ? '' : ` data-repo="${e(String(selectedRepo))}"`}>
${setupBanner()}
<header>
  <span class="brand">Freilauf</span>
  <nav>${nav}</nav>
  <span class="spacer"></span>
  ${repoSel}
  <button type="button" id="qr-open" class="qr-open" title="${e(t('qr.hint'))}">⚡ ${e(t('qr.title'))}</button>
</header>
<div class="shell" id="shell">
<main>${globalesBanner()}${discoveryBanner(active || '/')}${otherRepo}${content}</main>
${await statusSidebar(effRepo)}
</div>
${quickRunDialog(repos, effRepo)}
${await cleanupDialogHtml(active)}
<div class="toasts" id="freilauf-toasts" aria-live="polite"></div>
${withTerminal ? '<script src="/static/xterm.js"></script><script src="/static/addon-fit.js"></script>' : ''}
<script>window.FREILAUF_I18N=${JSON.stringify(clientCatalog())};window.FREILAUF_TZ=${JSON.stringify(uiTimezone())}</script>
<script src="/static/hub.js"></script></body></html>`
}

// ---------------- subscription usage panel ----------------
/**
 * Subscription usage + provider balances. Exported because it is one of the
 * blocks that goes stale on its own clock rather than with the page around it.
 */
export async function usagePanel() {
  let usage = []
  try { usage = await subscriptionUsage() } catch { usage = [] }
  let balances = []
  try { balances = await providerBalances() } catch { balances = [] }
  if (!usage.length && !balances.length) return ''
  // A reset within the next day is a time, everything beyond it needs the date
  // too — '16:30' alone says nothing about a window that runs for a week. Both
  // read the CONFIGURED timezone (not UTC) and carry that zone's abbreviation,
  // so a converted time cannot be mistaken for a UTC one.
  const resetText = (iso) => {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return ''
    return (ms - Date.now() > 24 * 3600_000 ? `${fmtDatePart(ms)} ` : '') + `${fmtClock(ms)} ${tzAbbrev(ms)}`
  }
  // When a window was READ, for a reading that is not the current one. Same idea
  // in the other direction: a time alone is a lie about a value taken two days
  // ago, so anything but today carries its date. "Today" is judged in the same
  // timezone the time is shown in, so the two cannot disagree at a zone boundary.
  const stampText = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const sameDay = fmtDatePart(ms) === fmtDatePart(Date.now())
    return (sameDay ? '' : `${fmtDatePart(ms)} `) + `${fmtClock(ms)} ${tzAbbrev(ms)}`
  }
  const rows = usage.map(u => {
    if (!u.ok) return `<div class="usage-row"><b>${e(u.label)}</b> <span class="dim">${e(t('usage.unavailable'))}</span></div>`
    const d = u.data
    if (d.kind === 'claude') {
      // One bar per window, each with its own reset time — a per-model week runs
      // separately from the general one, and one shared reset behind the row
      // could only ever belong to one of them. A window claude does not report
      // at all stays out of the row, and so does a missing reset time.
      //
      // The per-model windows come as a LIST carrying the vendor's own display
      // names ('Fable'), not as one hardcoded field: the account decides how
      // many there are and what they are called, and the day a second one
      // appears it belongs in the panel without a code change.
      //
      // A window may be the LAST live reading rather than the current one
      // (quota.mjs merges the sources by age; the account reports the scoped
      // window only sometimes, and a rate-limited stretch holds the general
      // ones back too). The bar then keeps standing where it stood — but it
      // says when it was read, because a number that looks current and is two
      // days old is exactly the failure this module was rebuilt over.
      const fenster = (label, pct, iso, stampMs = null) => {
        if (pct == null) return ''
        const note = [
          iso ? t('usage.resets', { time: resetText(iso) }) : '',
          stampMs ? t('usage.as_of', { time: stampText(stampMs) }) : '',
        ].filter(Boolean).join(' · ')
        return quotaBar(pct, { label, note })
      }
      const scoped = (d.weekly_scoped ?? [])
        .map(w => fenster(`7d ${w.label}`, w.pct, w.resets_at, w.stale ? w.at : null)).join('')
      return `<div class="usage-row"><b>${e(u.label)}</b>${d.plan ? ` <span class="dim">${e(d.plan)}</span>` : ''}
        ${fenster('5h', d.five, d.resets_at, d.five_at)}
        ${fenster('7d', d.seven_general, d.seven_resets_at, d.seven_general_at)}
        ${scoped}</div>`
    }
    if (d.kind === 'cursor') {
      // What one reads at a glance is the bar — like the claude rows above. The
      // dollars are the detail and move into the tooltip; only when the included
      // amount is the configured fallback does the text say so (tilde).
      const money = d.spent_usd != null
        ? t(d.included_estimated ? 'usage.spent_est' : 'usage.spent',
          { usd: fmtNum(d.spent_usd, { maximumFractionDigits: 2 }), included: fmtNum(d.included_usd, { maximumFractionDigits: 2 }) })
        : ''
      const days = d.cycle_end != null
        ? Math.max(0, Math.ceil((Date.parse(d.cycle_end) - Date.now()) / 86_400_000)) : null
      return `<div class="usage-row"><b>${e(u.label)}</b>${d.plan ? ` <span class="dim">${e(d.plan)}</span>` : ''}
        ${d.pct != null ? quotaBar(d.pct, { title: money })
          : `<span class="dim">${e(t('usage.unavailable'))}</span>`}
        ${days != null ? `<span class="dim">${e(t('usage.resets_in', { days }))}</span>` : ''}</div>`
    }
    return ''
  }).join('')
  // Provider balances. One line per provider, one figure per CURRENCY — an
  // account can hold CNY and USD at once (DeepSeek does), and folding those into
  // a single number would quietly drop one of them. The name comes from the
  // plugin label, so a new provider appears here without a line of UI code.
  const guthaben = balances.map(b => {
    if (!b.ok) return `<div class="usage-row"><b>${e(b.label)}</b> <span class="dim">${e(t('usage.unavailable'))}</span></div>`
    const betraege = b.data.amounts.map(a => {
      // granted/topped_up are DeepSeek's split and stay in the tooltip: the
      // figure that matters on screen is what is left.
      const detail = a.granted != null && a.topped_up != null
        ? t('usage.balance_detail',
          { granted: fmtNum(a.granted, { maximumFractionDigits: 2 }), topped_up: fmtNum(a.topped_up, { maximumFractionDigits: 2 }) }) : ''
      return `<span${detail ? ` title="${e(detail)}"` : ''}>${
        e(t('usage.remaining', { amount: fmtNum(a.remaining, { maximumFractionDigits: 2 }), currency: a.currency }))}</span>`
    }).join(' <span class="dim">·</span> ')
    // `available:false` is the provider's own verdict and outranks the number
    // next to it — promotional credit can expire while the figure looks healthy.
    const leer = b.data.available === false
      ? ` <b class="err">${e(t('usage.balance_exhausted'))}</b>` : ''
    return `<div class="usage-row"><b>${e(b.label)}</b> ${betraege}${leer}</div>`
  }).join('')
  if (!rows && !guthaben) return ''
  return `<details class="usage" id="usage-panel" open><summary>${e(t('usage.title'))}</summary>${rows}${guthaben}</details>`
}

// ---------------- overview ----------------
export async function pageOverview(req, res, url) {
  const sel = selectRepo(req, url)
  if (!sel) return noRepoPage(req, res, '/', t('nav.overview'))
  // 'scheduled' sits with 'deferred': both are runs that exist and are WAITING —
  // that is exactly what one wants to see at a glance, not somewhere below the
  // finished ones. Archived runs have left the overview entirely (Archive page).
  // The status filter the sidebar's "work in flight" counts link to, and the
  // incidents filter the sidebar's incident counts link to. Anything else in
  // the parameter is simply no filter — a URL must not be able to invent a
  // status the CHECK constraint does not know.
  const wanted = url.searchParams.get('status')
  const filter = WORK_STATUSES.includes(wanted) ? wanted : null
  const nurVorfaelle = url.searchParams.get('incidents') === '1'
  const runs = overviewRuns(sel.id, filter, nurVorfaelle)
  const filterHinweis = [
    filter ? e(t('overview.filtered', { status: statusText(filter) })) : null,
    nurVorfaelle ? e(t('overview.filtered_incidents')) : null,
  ].filter(Boolean).join(' · ')
  const body = `
  <div class="btn-row"><a class="btn" href="/runs/new?repo=${sel.id}">${e(t('overview.start_single'))}</a>
     <a class="btn ghost" href="/archive?repo=${sel.id}">${e(t('nav.archive'))}</a>
     ${filterHinweis ? `<span class="dim">${filterHinweis}</span>
       <a class="btn" href="/?repo=${sel.id}">${e(t('overview.filter_clear'))}</a>` : ''}</div>
  ${overviewTable(runs, { repoId: sel.id, status: filter, incidents: nurVorfaelle })}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('nav.overview'), '/', body, sel.id))
}

/**
 * One run as a table row — the smallest unit of the overview that is worth
 * replacing on its own, and therefore the one place a row is ever built.
 *
 * `ctx` carries what the row cannot know by itself: the repo the overview is
 * currently showing, which is where the inline forms have to return to. It is
 * not state, it is the call site's context handed down.
 */
export function runRow(r, ctx) {
  const repoId = ctx.repoId
  const agentName = r.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(r.agent_id)?.name ?? null : null
  const titel = runTitle(r, agentName, t('overview.single_run'))
  // Under the title stands where the run comes from — the agent by name, or
  // the word for "no agent". A renamed run must not lose that information.
  const herkunft = r.resolves_run_id
    // A row nobody started by hand needs to say why it exists at all.
    ? t('merge.resolver_for', { title: resolvedTitle(r.resolves_run_id) })
    : agentName ? t('overview.from_agent', { agent: agentName }) : t('overview.single_run')
  // Finished runs: duration until the end, not until now — otherwise a run
  // from three days ago "grows" to 4000 minutes in the overview.
  const startedMs = parseDbUtc(r.started_at)
  const endeMs = r.ended_at ? parseDbUtc(r.ended_at) : Date.now()
  const durMin = Math.round((endeMs - startedMs) / 60000)
  const wartend = r.status === 'scheduled'
  // One click moves a finished run into the archive — the record stays, it just
  // leaves the overview. Only finished runs may go: a running or waiting one
  // still has work to do and must not hide (the server enforces this too).
  const archivierbar = ['done', 'failed', 'aborted'].includes(r.status)
  const archivBtn = archivierbar
    ? `<form method="post" action="/api/runs/${r.id}/archive" class="inline" onclick="event.stopPropagation()">
          <input type="hidden" name="back" value="/?repo=${repoId}">
          <button type="submit" class="act" title="${e(t('overview.archive'))}" aria-label="${e(t('overview.archive'))}">${e(t('overview.archive_short'))}</button></form>`
    : ''
  // The checkbox for the bulk archive, and only where archiving is allowed at
  // all: a run still in flight cannot be selected, so "select all" can never
  // promise something the server would refuse. The cell swallows the row click
  // like the title cell does — ticking a box must not navigate away.
  const pickCell = archivierbar
    ? `<td class="pick-cell" onclick="event.stopPropagation()">
        <input type="checkbox" class="run-pick" value="${e(r.id)}" aria-label="${e(t('overview.pick', { title: titel }))}"></td>`
    : '<td class="pick-cell"></td>'
  // The budget gate held a run back and the operator disagrees — one click in
  // the row starts it anyway (POST /start, no gate). Same pattern as the
  // archive button: a small action button, hover for the full word, and the
  // click must not navigate to the detail page.
  const startBtn = r.status === 'deferred'
    ? `<form method="post" action="/api/runs/${r.id}/start" class="inline" onclick="event.stopPropagation()">
          <input type="hidden" name="back" value="/?repo=${repoId}">
          <button type="submit" class="act" title="${e(t('start.force_start'))}" aria-label="${e(t('start.force_start'))}">${e(t('start.force_start_short'))}</button></form>`
    : ''
  // The row stays clickable as a whole, the title is additionally a real link —
  // otherwise the detail page would be unreachable by keyboard. The title cell
  // swallows the row click: renaming must not navigate away.
  const anomaly = lastAnomaly(r.id)
  const branch = r.branch_reported || r.branch_expected
  // Seven cells, not eleven — and not one fact less. Three of the old columns
  // said the same thing in three places (dot, status word, last anomaly) with
  // ~500px between them, and two more were a technical pair each
  // (harness/model, branch/PR) that reads as one line.
  return `<tr id="run-${e(r.id)}" onclick="location='/runs/${r.id}'">
      ${pickCell}
      <td class="status-cell">
        <span class="status-line">${AMPEL_DOT[ampel(r)]()} ${e(statusText(displayStatus(r)))}</span>
        ${wartend ? `<div class="dim">${wartetAuf(r)}</div>` : ''}
        ${r.followup_since ? `<div class="dim">${e(t('run.followup_active', { ts: fmtDbUtc(r.followup_since) }))}</div>` : ''}
        ${integrationLine(r)}
        ${anomaly ? `<div class="dim">${e(anomaly)}</div>` : ''}</td>
      <td class="title-cell" onclick="event.stopPropagation()">
        ${titleInline(r.id, titel)}
        <div class="dim">${e(herkunft)}</div></td>
      <td class="two-line">${e(harnessLabel(r.harness))}${r.model ? `<span class="dim">${r.provider ? e(r.provider) + ':' : ''}${e(r.model)}</span>` : ''}</td>
      <td>${wartend ? plannedCell(r) : startedCell(r.started_at)}</td>
      <td>${wartend ? '' : (durMin > 0 ? e(t('unit.minutes', { n: durMin })) : '')}<span class="dim"> / ${e(t('unit.minutes', { n: r.expected_minutes }))}</span></td>
      <td class="two-line">${branch ? e(branch) : '<span class="leer">–</span>'}${
        r.pr_url ? `<span class="dim"><a href="${e(r.pr_url)}" onclick="event.stopPropagation()">PR</a></span>` : ''}</td>
      <td>${vorfallZelle(r.id, repoId, r.status)}${startBtn}${archivBtn}</td>
    </tr>`
}

/**
 * Where a run's work stands, under the status word — the same place the last
 * anomaly uses, because it answers the same kind of question. A run in the
 * finish gate says what it is waiting for; a finished one says why its work is
 * not on the base branch. 'merged' and 'nothing' say nothing: those are the
 * cases where everything is as it should be.
 */
function integrationLine(r) {
  // A run whose session was lost and is on its way back (runner.mjs,
  // resumeRun): between the loss and the new session it has no tmux session,
  // and a running run with no session would otherwise read as broken.
  if (r.resume_pending && ['running', 'waiting_help', 'deferred'].includes(r.status)) {
    return `<div class="dim">${e(t('run.resuming'))}</div>`
  }
  if (r.finish_state) return `<div class="dim">${e(finishText(r.finish_state))}</div>`
  if (!r.merge_status || ['merged', 'nothing'].includes(r.merge_status)) return ''
  if (!['done', 'failed', 'aborted'].includes(r.status)) return ''
  return `<div class="dim">${e(mergeText(r.merge_status))}</div>`
}

/** The title of the run a conflict run works for — for the one line that explains it. */
function resolvedTitle(runId) {
  const row = db.prepare('SELECT title FROM runs WHERE id=?').get(runId)
  return row?.title || String(runId).split('-')[0]
}

/** How many columns the overview has — the empty state has to span all of them. */
const OVERVIEW_COLS = 8

/** The rows of the overview — including the one row that says there are none. */
export function runRows(runs, ctx) {
  return runs.map(r => runRow(r, ctx)).join('')
    || `<tr><td colspan="${OVERVIEW_COLS}" class="dim">${e(t('overview.no_runs'))}</td></tr>`
}

/**
 * The runs the overview shows, in the order it shows them.
 *
 * Its own function because the live channel re-renders the tbody when a run
 * appears that the page does not know yet — and a second copy of this ORDER BY
 * would be a second opinion about which runs matter. 'scheduled' sits with
 * 'deferred': both are runs that exist and are WAITING, which is what one wants
 * to see at a glance rather than below the finished ones. Archived runs have
 * left the overview entirely (Archive page).
 */
export function overviewRuns(repoId, status = null, incidentsOnly = false) {
  const s = WORK_STATUSES.includes(status) ? status : null
  return db.prepare(`SELECT * FROM runs WHERE repo_id=? AND archived_at IS NULL
    AND (? IS NULL OR status = ?
        OR (? = 'running' AND status IN ('done','failed','aborted') AND followup_since IS NOT NULL))
    ${incidentsOnly ? `AND id IN (SELECT run_id FROM incidents WHERE geloest_am IS NULL AND run_id IS NOT NULL)` : ''}
    ORDER BY
    -- A finished run with an open follow-up commission IS work in flight: it
    -- sorts with the running ones, not below the finished ones.
    CASE WHEN followup_since IS NOT NULL AND status IN ('done','failed','aborted') THEN 2
         WHEN status = 'waiting_help' THEN 0 WHEN status = 'failed' THEN 1 WHEN status = 'running' THEN 2
         WHEN status = 'deferred' THEN 3 WHEN status = 'scheduled' THEN 4 ELSE 5 END,
    started_at DESC LIMIT 200`).all(repoId, s, s, s)
}

/**
 * The tbody on its own — the swap target when a row has to appear or vanish.
 *
 * It carries the active filters as data attributes so the live channel can ask
 * for the SAME selection again. Without it the first update would quietly
 * replace a filtered list with the unfiltered one.
 */
export function runsBody(runs, ctx) {
  return `<tbody id="runs-body"${ctx.status ? ` data-status="${e(ctx.status)}"` : ''}${ctx.incidents ? ' data-incidents="1"' : ''}>${runRows(runs, ctx)}</tbody>`
}

/**
 * The overview table around the rows; the tbody is the anchor for new rows.
 *
 * UNDER it stands the bulk bar — the answer to a list of forty finished runs of
 * which four are worth keeping: tick "select all", untick those four, archive
 * the rest in one gesture. Under and not above, because that is where the hand
 * ends up: one goes down the list deciding, and the button is then where the
 * deciding stopped. The bar sits OUTSIDE the tbody on purpose, because the live
 * channel replaces the tbody whenever a run appears; a control inside it would
 * be rebuilt (and reset) by somebody else's run starting. The button is disabled
 * until something is selected, and hub.js keeps its label counting.
 */
export function overviewTable(runs, ctx) {
  return `<div class="table-wrap"><table class="list runs"><thead><tr><th class="pick-col"></th><th>${e(t('overview.status'))}</th><th>${e(t('overview.title_col'))}</th><th>${e(t('overview.harness_model'))}</th><th>${e(t('overview.started'))}</th><th>${e(t('overview.duration_expected'))}</th><th>${e(t('overview.branch_pr'))}</th><th>${e(t('incidents.title'))}</th></tr></thead>
  ${runsBody(runs, ctx)}</table></div>
  <div class="bulk-bar">
    <label class="chk"><input type="checkbox" id="runs-all"> ${e(t('overview.select_all'))}</label>
    <button type="button" id="runs-archive-selected" disabled>${e(t('overview.archive_selected', { n: 0 }))}</button>
    <span class="dim">${e(t('overview.select_hint'))}</span>
  </div>`
}

/**
 * The title as a link plus a pencil that turns it into an input in place
 * (hub.js). Renaming works on EVERY run, including one an agent started — it
 * changes the run, never the agent behind it.
 */
function titleInline(runId, titel) {
  return `<span class="title-inline" data-run="${e(runId)}">
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

// ---------------- archive ----------------
// Finished runs the overview should not show any more. The record stays complete
// (report, log, incidents) and reachable under its detail page — it only leaves
// the at-a-glance list. Paginated, newest-archived first.
const ARCHIV_SEITE = Number(env('ARCHIVE_PAGE_SIZE') ?? 50) || 50

export async function pageArchive(req, res, url) {
  const sel = selectRepo(req, url)
  if (!sel) return noRepoPage(req, res, '/archive', t('nav.archive'))
  const gewuenscht = Math.max(1, Number(url.searchParams.get('page')) || 1)
  const total = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NOT NULL`).get(sel.id).c
  const seiten = Math.max(1, Math.ceil(total / ARCHIV_SEITE))
  const seite = Math.min(gewuenscht, seiten)
  const runs = db.prepare(`SELECT * FROM runs WHERE repo_id=? AND archived_at IS NOT NULL
    ORDER BY archived_at DESC, started_at DESC LIMIT ? OFFSET ?`)
    .all(sel.id, ARCHIV_SEITE, (seite - 1) * ARCHIV_SEITE)
  const rows = runs.map(r => {
    const agentName = r.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(r.agent_id)?.name ?? null : null
    const titel = runTitle(r, agentName, t('overview.single_run'))
    const herkunft = agentName ? t('overview.from_agent', { agent: agentName }) : t('overview.single_run')
    // The status cell carries integrationLine() — the SAME line the overview
    // puts under the status word, and for the same reason: a finished run whose
    // work never reached the base branch has to say so. Without it an archived
    // run blocked on a merge looked exactly like one that merged cleanly, and
    // the archive is the last place that could still say it — the sidebar's
    // incident count deliberately stops following a run into the archive.
    return `<tr onclick="location='/runs/${r.id}'">
      <td><a href="/runs/${r.id}">${e(titel)}</a>
        <div class="dim">${e(herkunft)}</div></td>
      <td class="two-line">${e(harnessLabel(r.harness))}${r.model ? `<span class="dim">${r.provider ? e(r.provider) + ':' : ''}${e(r.model)}</span>` : ''}</td>
      <td>${e(statusText(r.status))}${integrationLine(r)}</td>
      <td>${e(r.archived_at)}</td>
      <td>${e(r.branch_reported || r.branch_expected || '–')}</td>
      <td>${r.pr_url ? `<a href="${e(r.pr_url)}">PR</a>` : '–'}</td>
      <td><form method="post" action="/api/runs/${r.id}/unarchive" class="inline" onclick="event.stopPropagation()">
        <input type="hidden" name="back" value="/archive?repo=${sel.id}&page=${seite}">
        <button type="submit" title="${e(t('archive.restore_title'))}" aria-label="${e(t('archive.restore_title'))}">${e(t('archive.restore'))}</button></form></td>
    </tr>`
  }).join('')
  const pager = seiten <= 1 ? ''
    : `<div class="pager">
        ${seite > 1 ? `<a class="btn" href="/archive?repo=${sel.id}&page=${seite - 1}">${e(t('archive.prev'))}</a>` : `<span class="dim">${e(t('archive.prev'))}</span>`}
        <span>${e(t('archive.page', { page: seite, pages: seiten }))}</span>
        ${seite < seiten ? `<a class="btn" href="/archive?repo=${sel.id}&page=${seite + 1}">${e(t('archive.next'))}</a>` : `<span class="dim">${e(t('archive.next'))}</span>`}
      </div>`
  const body = `
  <h2>${e(t('archive.title', { repo: sel.name }))}</h2>
  <p class="dim">${e(t('archive.total', { n: total }))}</p>
  <div class="table-wrap"><table class="list"><thead><tr><th>${e(t('overview.title_col'))}</th><th>${e(t('overview.harness_model'))}</th><th>${e(t('overview.status'))}</th><th>${e(t('archive.archived_at'))}</th><th>${e(t('overview.branch'))}</th><th>PR</th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="7" class="dim">${e(t('archive.empty'))}</td></tr>`}</tbody></table></div>
  ${pager}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('nav.archive'), '/archive', body, sel.id))
}

function selectRepo(req, url) {
  const want = url.searchParams.get('repo')
  // An EXPLICIT ?repo= resolves whatever it names, active or not. That is what
  // makes deactivating better than deleting: the overview, the archive, the run
  // pages and the sidebar of an inactive repo all stay reachable by their own
  // links. Only the two FALLBACKS below skip an inactive repo — nobody should
  // land on one by accident.
  let sel = want ? getRepo(+want) : null
  // No ?repo= — or one naming a repo that no longer exists: fall back to the
  // repo chosen in the header, which travels as the freilauf_repo cookie.
  if (!sel) {
    const c = cookieRepo(req) ? getRepo(cookieRepo(req)) : null
    sel = c && c.active ? c : null
  }
  if (!sel) sel = db.prepare('SELECT * FROM repos WHERE active=1 ORDER BY name LIMIT 1').get() ?? null
  return sel   // null = no repo yet → pages show a setup hint
}

export async function noRepoPage(req, res, active, title) {
  const body = `
  <h2>${e(t('norepo.title'))}</h2>
  <p>${e(t('norepo.text'))} <code>~/projects/my-project</code> (${e(t('norepo.base_hint'))} <code>main</code>).</p>
  <p><a class="btn" href="/repos/edit">${e(t('norepo.cta'))}</a></p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, title, active, body))
}

// ---------------- agents ----------------
export async function pageAgents(req, res, url) {
  const sel = selectRepo(req, url)
  if (!sel) return noRepoPage(req, res, '/agents', t('nav.agents'))
  if (req.method === 'POST') return void res.writeHead(405).end()
  const agents = db.prepare('SELECT * FROM agents WHERE repo_id=? ORDER BY name').all(sel.id)
  const body = `
  <p><a class="btn" href="/agents/edit?repo=${sel.id}">${e(t('agents.create'))}</a>
     <a class="btn" href="/flows">${e(t('nav.flows'))}</a>
     <span class="dim">${e(t('agents.flows_hint'))}</span></p>
  ${agentsTable(agents, { repoId: sel.id })}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('nav.agents'), '/agents', body, sel.id))
}

/** One agent as a table row. `ctx.repoId` is where its two forms return to.
 * The destructive actions — move and delete — live on the agent's edit page
 * (the detail page), not here: a cleanup action must not sit a click away from
 * the on/off switch you reach for when editing. */
export function agentRow(a, ctx) {
  const repoId = ctx.repoId
  return `
  <tr id="agent-${a.id}">
    <td><form method="post" action="/agents/toggle" class="inline"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${repoId}"><button>${e(a.active ? t('agents.on') : t('agents.off'))}</button></form></td>
    <td>${e(a.name)}</td><td>${e(harnessLabel(a.harness))}</td><td>${e(a.model || '–')}</td>
    <td>${e(scheduleText(a))}</td><td>${e(t('unit.minutes', { n: a.expected_minutes }))}</td>
    <td class="dim">${e(attachmentSummary(a.flows)) || '–'}</td>
    <td><form method="post" action="/agents/start" class="inline"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${repoId}"><button>${e(t('agents.start_now'))}</button></form>
        <a href="/agents/edit?id=${a.id}&repo=${repoId}">${e(t('agents.edit'))}</a></td>
  </tr>`
}

export function agentRows(agents, ctx) {
  return agents.map(a => agentRow(a, ctx)).join('')
    || `<tr><td colspan="8" class="dim">${e(t('agents.none'))}</td></tr>`
}

export function agentsTable(agents, ctx) {
  return `<table class="list"><thead><tr><th>${e(t('agents.status'))}</th><th>${e(t('agents.name'))}</th><th>${e(t('agents.harness'))}</th><th>${e(t('agents.model'))}</th><th>${e(t('agents.schedule'))}</th><th>${e(t('agents.expected'))}</th><th>${e(t('nav.flows'))}</th><th></th></tr></thead>
  <tbody id="agents-body">${agentRows(agents, ctx)}</tbody></table>`
}

// ---------------- single-run form (= agent form without name and schedule) ----------------
export async function pageRunForm(req, res, url) {
  const sel = selectRepo(req, url)
  if (!sel) return noRepoPage(req, res, '', t('runform.title_short'))
  const agentId = url.searchParams.get('agent')
  const a = agentId ? db.prepare('SELECT * FROM agents WHERE id=?').get(+agentId) : null
  // A favorite as template: the Quick-Run dialog's "more settings" hands its
  // favorite over via ?favorite=<id>, so the form opens with that setup and
  // hub.js restores the dialog's prompt, branch rule and start time on top of
  // it. Explicit beats remembered: an agent, then a favorite, then the last
  // choice — never two templates competing.
  const favId = url.searchParams.get('favorite')
  const fav = favId && !a ? getFavorite(+favId) : null
  const template = a ?? (fav ? favoriteTemplate(fav) : null) ?? lastRunChoice()
  const fields = `
  ${runTitleField({})}
  ${runDefFields(template, branchContext(sel.id))}
  ${runStartTimeFields({})}
  <input type="hidden" name="repo_id" value="${sel.id}">
  <label class="chk"><input type="checkbox" name="save_agent" value="1"> ${e(t('runform.save_agent'))} (<input name="agent_name" placeholder="${e(t('runform.agent_name_ph'))}">)</label>`
  const body = `
  <h2>${e(t('runform.title', { repo: sel.name }))}${a
    ? ` (${e(t('runform.like_agent', { agent: a.name }))})`
    : fav ? ` (${e(t('runform.like_favorite', { favorite: fav.name }))})` : ''}</h2>
  <form method="post" action="/runs/new" class="settings form-grid">${fields}
  <div class="btn-row"><button>${e(t('runform.start'))}</button>
  ${pipelineAn()
    ? `<span class="dim">${e(t('runform.pipeline_on_hint'))}</span>`
    : `<span class="warn">${e(t('runform.pipeline_off_hint'))}</span>`}</div></form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('runform.title_short'), '', body, sel.id))
}

// ---------------- run detail page ----------------
export async function pageRun(req, res, url, id) {
  const run = getRun(id)
  if (!run) { res.writeHead(404).end(t('run.not_found')); return }
  const repo = getRepo(run.repo_id)
  const agentName = run.agent_id ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name ?? null : null
  const titel = runTitle(run, agentName, t('overview.single_run'))
  const herkunft = agentName ? t('overview.from_agent', { agent: agentName }) : t('overview.single_run')
  // Log (ANSI-cleaned), last excerpt
  const { readFileSync, existsSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const logf = join(env('RUNS_DIR') ?? `${process.env.HOME}/agents/runs`, id, 'log.txt')
  let logHtml = `<p class="dim">${e(t('run.no_log'))}</p>`
  if (existsSync(logf)) {
    try {
      const size = statSync(logf).size
      const raw = readFileSync(logf).subarray(Math.max(0, size - 100_000)).toString('utf8')
      logHtml = `<pre id="log">${e(raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''))}</pre>`
    } catch {}
  }
  // "live" means: there really is an agent one can type to — a standing session
  // AND a process in it. Judged by the run's STATUS it meant neither, and both
  // readings were wrong in their own direction:
  //   - status alone promised a terminal for a session that was long gone;
  //   - status as a CONDITION locked the operator out of the case the coding
  //     agents make the normal one. claude, opencode and cursor stay in their
  //     TUI after the work is done; the run says 'done', the agent is still
  //     sitting there waiting for a follow-up, and the page offered a read-only
  //     screen of it. Whether one may type is a fact about the session, never
  //     about the record. (hermes is the counter-example, and the reason the
  //     pane is asked about at all: `chat -q` is one query and then the process
  //     exits — remain-on-exit leaves the screen, not the agent.)
  const sessionOpen = !!run.tmux_session && !run.tmux_closed_at
  // Unknown (null) counts as alive: a tmux that did not answer must not silently
  // take away write access — the handshake is fail-closed on its own.
  const live = sessionOpen && (await paneAlive(run.tmux_session)) !== false
  // Is this run itself still going? That decides the BUTTON, not the typing:
  // ending a run that is over would rewrite its 'done' to 'aborted'.
  const inFlight = ['running', 'waiting_help'].includes(run.status)
  // …but a finished run with an open follow-up commission is working again, and
  // the TERMINAL says so (summary + no "retention keeps counting" hint). The
  // button stays the finished one: whatever ends such a run ends its SESSION.
  const arbeitet = inFlight || followUpActive(run)
  const body = `
  ${runDetailHead(run, { title: titel })}
  ${runPromptCard(run)}
  ${runChips(run, repo, herkunft)}
  ${runEditCard(run)}
  ${integrationSection(run, repo)}
  ${goalCard(run)}
  ${run.help_text
    ? run.status === 'waiting_help'
      // open: the agent is waiting for an answer right now
      ? `<div class="help"><b>${e(t('run.help_call'))}:</b> ${e(run.help_text)}
         <form method="post" action="/api/runs/${id}/send"><textarea name="text" rows="3" placeholder="${e(t('run.answer_ph'))}"></textarea><button>${e(t('run.send_answer'))}</button></form></div>`
      // done: show as history, not as an open question
      : `<p class="dim"><b>${e(t('run.help_answered'))}:</b> ${e(run.help_text)}${run.help_answer ? ` → <i>${e(run.help_answer)}</i>` : ''}</p>`
    : ''}
  <details class="run-term" ${live ? 'open' : ''}><summary>${e(t('run.terminal'))} ${e(terminalState(live, sessionOpen, arbeitet))}${
    // The way in is on the toggle line, because that is the line one is on when
    // one decides the screen is too small. Only where there IS a screen: a run
    // whose session is gone shows a sentence, and a sentence in full screen is
    // still a sentence.
    sessionOpen ? `<button type="button" id="term-full" class="icon-btn term-full-btn" title="${e(t('run.terminal_fullscreen'))}" aria-label="${e(t('run.terminal_fullscreen'))}">⛶</button>` : ''}${
    // Cinema mode next to it — the same line, one step less drastic: the screen
    // stays a page, the terminal just gets all of it above the fold. Both
    // titles are rendered here rather than as js.* strings, because the button
    // toggles and its label has to say which way it now goes; hub.js swaps
    // them. The buttons float right, so the one written FIRST sits rightmost —
    // the full-screen icon keeps the corner it has always had.
    sessionOpen ? `<button type="button" id="term-cinema" class="icon-btn term-cinema-btn" aria-pressed="false" title="${e(t('run.terminal_cinema'))}" aria-label="${e(t('run.terminal_cinema'))}" data-title-exit="${e(t('run.terminal_cinema_exit'))}">▭</button>` : ''}</summary>
    <div id="term-wrap">
      ${sessionOpen ? `<button type="button" id="term-full-exit" class="icon-btn term-exit" title="${e(t('run.terminal_fullscreen_exit'))}" aria-label="${e(t('run.terminal_fullscreen_exit'))}">✕</button>` : ''}
      <div id="term" data-session="${sessionOpen ? '1' : '0'}" data-live="${live ? '1' : '0'}"></div>
    </div>
    ${
    // Selecting copies to the clipboard by itself (hub.js), but only a live
    // client can do it with a plain drag: tmux runs with `mouse on`, so the
    // drag is a mouse report — and a read-only client's input is dropped, by
    // tmux and by terminal.mjs alike. There Shift is what makes the selection
    // xterm's own, and a terminal in which marking silently does nothing is
    // exactly the shape this whole feature was missing.
    sessionOpen && !live ? `<p class="dim">${e(t('run.terminal_copy_hint'))}</p>` : ''}
    ${notifySwitch(run)}
    ${live && !arbeitet ? `<p class="dim">${e(t('run.session_after_hint'))}</p>` : ''}
    ${live ? `<form onsubmit="return freilaufSend(this,'/api/runs/${id}/send')"><textarea name="text" rows="3" placeholder="${e(t('run.send_text_ph'))}"></textarea><button>${e(t('run.send'))}</button></form>` : ''}
    ${inFlight
      ? (live ? `<form onsubmit="return freilaufKill('${id}')"><button class="danger">${e(t('run.kill'))}</button></form>` : '')
      // The run is over — only the session is left. Ending it here must NOT go
      // through /runs/<id>/kill: that sets 'aborted', and it would turn a run
      // that came through cleanly into a failed one. /api/sessions/kill is the
      // one path that ends a session and leaves a finished record alone.
      : sessionOpen ? `<div class="btn-row"><form method="post" action="/api/sessions/kill" class="inline">
          <input type="hidden" name="session" value="${e(run.tmux_session)}">
          <input type="hidden" name="back" value="/runs/${id}">
          <button class="danger">${e(t('run.end_session'))}</button></form>
        <span class="dim">${e(t('run.end_session_hint'))}</span></div>` : ''}
  </details>
  ${['failed', 'aborted'].includes(run.status) && !run.resolves_run_id
    // A conflict run is never retried: the way back in is "Merge now" on the
    // run it works for, which starts a fresh one with a fresh branch.
    ? `<form method="post" action="/api/runs/${id}/retry"><button>${e(t('run.retry'))}</button>
       <span class="dim">${e(t('run.retry_hint'))}</span></form>`
    : ''}
  ${run.report_md ? `<h3>${e(t('run.report'))}</h3><pre>${e(run.report_md)}</pre>` : ''}
  ${run.report_detail_md ? `<h3>${e(t('run.detail_report'))}</h3><pre>${e(run.report_detail_md)}</pre>` : ''}
  ${flowSection(run)}
  ${vorfallAbschnitt(id, run.status)}
  <h3>${e(t('run.metrics'))}</h3>
  ${runMetrics(run)}
  <h3>${e(t('run.events'))}</h3>${runEvents(id)}
  <h3>${e(t('run.log'))}</h3>${logHtml}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, titel, '/', body, run.repo_id, true))
}

/**
 * The notification checkbox, right under the terminal — because that is where
 * the operator stands when the box matters: reading the report, typing the rest
 * into the session, and NOT wanting the phone to ring about a follow-up they
 * are watching land. Ticked for every run by default; unticking silences every
 * message about THIS run (reports, follow-ups, alarms, incidents) on every
 * configured channel and nothing else — the integration and the flows are not
 * touched. Not part of the run-detail fragment, like the terminal it sits
 * under: a live update must not flip a box the operator just clicked.
 *
 * The column behind it is still `runs.telegram_on` (renaming a column is a
 * table rebuild); the id, the route and the label are channel-neutral.
 */
export function notifySwitch(run) {
  const on = run.telegram_on !== 0
  return `<label class="chk notify-switch" id="notify-switch">
    <input type="checkbox" id="notify-on" data-run="${e(run.id)}"${on ? ' checked' : ''}>
    ${e(t('run.notify_on'))} <span class="dim">${e(t('run.notify_on_hint'))}</span></label>`
}

/**
 * The half sentence behind "Terminal" in the summary.
 *
 * Four states, because the two facts behind them are independent: is there a
 * session, and is anybody still sitting in it. "(ended)" for a session whose
 * process has exited would be a lie — the scrollback is there and can be
 * attached to, only nobody answers any more.
 */
export function terminalState(live, sessionOpen, inFlight) {
  if (live) return t(inFlight ? 'run.terminal_live' : 'run.terminal_after')
  return t(sessionOpen ? 'run.terminal_dead' : 'run.terminal_closed')
}

/**
 * The run's prompt, folded away near the top of the detail page.
 *
 * Its own block rather than a chip: the prompt IS the run — everything else on
 * the page answers "what became of it". A <details> keeps a long prompt from
 * dominating the page until it is asked for, and the block deliberately does
 * NOT live in the run-detail fragment: the prompt does not change while a run
 * works, and the fragment swap would close the block under whoever is reading
 * it on every event. Same rule as the goal card, which is page-only for the
 * same reason.
 */
export function runPromptCard(run) {
  const text = String(run.prompt ?? '').trim()
  if (!text) return ''
  return `<details class="run-prompt" id="run-prompt"><summary>${e(t('run.prompt'))}</summary>
    <pre>${e(text)}</pre></details>`
}

/**
 * The goal of a run, and whether it ever reached the session.
 *
 * Its own block rather than a chip: a condition is a sentence, and "was it sent
 * in?" is a fact one only asks about here. A goal that is still waiting is not
 * an error — the delivery waits for the TUI and the watcher picks up the rest —
 * but it is the difference between "claude keeps going until this holds" and
 * "claude does not know about it yet".
 */
export function goalCard(run) {
  if (!run.goal) return ''
  const state = run.goal_sent_at
    ? `<span class="dim">${e(t('goal.sent_at', { ts: run.goal_sent_at }))}</span>`
    : `<span class="warn">${e(t(['done', 'failed', 'aborted'].includes(run.status) ? 'goal.never_sent' : 'goal.pending'))}</span>`
  return `<div class="card" id="run-goal"><b>🎯 ${e(t('goal.title'))}</b> ${state}
    <pre>${e(run.goal)}</pre></div>`
}

/**
 * Head of the detail page: name, traffic light, status — plus the two lines that
 * are only there in certain states (a planned run's cancel banner, the archive
 * row of a finished one). They stand together because they answer one question:
 * what IS this run right now.
 */
export function runDetailHead(run, ctx) {
  const id = run.id
  const titel = ctx.title
  return `<h2 id="run-head">${AMPEL_DOT[ampel(run)]()} ${titleInline(id, titel)} <span class="status-chip">${e(statusText(displayStatus(run)))}</span></h2>
  ${followUpActive(run)
    ? `<div class="banner waiting" id="run-banner">${e(t('run.followup_banner'))}
       ${run.followup_since ? `<span class="dim">${e(t('run.followup_active', { ts: fmtDbUtc(run.followup_since) }))}</span>` : ''}</div>`
    : ''}
  ${run.status === 'scheduled'
    // A planned run must be revocable — otherwise a start you thought better of
    // sits in the future with no way to stop it. 'kill' is exactly right here:
    // there is no session to end, only a record to set to 'aborted'.
    // And the green one starts it ahead of its time — startScheduledNow, the
    // same budget gate as at any other start (a blocked one becomes deferred,
    // it does not die at the first API call).
    ? `<div class="banner waiting" id="run-banner">⏳ ${wartetAuf(run)}
       <div class="btn-row">
         <form method="post" action="/api/runs/${id}/start-now" class="inline"><button class="success">${e(t('start.start_now'))}</button></form>
         <form method="post" action="/api/runs/${id}/kill" class="inline"><button class="danger">${e(t('start.cancel'))}</button></form>
       </div></div>`
    : ''}
  ${run.status === 'deferred'
    // The budget gate held the run back, and the operator disagrees — that is
    // what the button is for: the gate is a rule that must not overrule a
    // deliberate decision (same principle as repos.max_parallel). POST /start
    // starts it without asking the gate again; cancel stays available.
    ? `<div class="banner waiting" id="run-banner">🟡 ${wartetAuf(run)}
       <div class="btn-row">
         <form method="post" action="/api/runs/${id}/start" class="inline"><button>${e(t('start.force_start'))}</button></form>
         <form method="post" action="/api/runs/${id}/kill" class="inline"><button class="danger">${e(t('start.cancel'))}</button></form>
       </div></div>`
    : ''}
  ${['done', 'failed', 'aborted'].includes(run.status)
    // One click into the archive / back out of it. An archived run is hidden
    // from the overview but stays fully reachable here, report and log intact.
    // .btn-row, not <p>: an HTML parser closes an open paragraph at a <form>,
    // so the button and the note beside it would land on two lines whatever
    // the CSS says. One button hides the bug today; a second one shows it.
    ? `<div class="btn-row" id="run-archive"><form method="post" action="/api/runs/${id}/${run.archived_at ? 'unarchive' : 'archive'}" class="inline">
         <input type="hidden" name="back" value="/runs/${id}">
         <button>${e(t(run.archived_at ? 'run.restore' : 'run.archive'))}</button></form>
       ${run.archived_at ? `<span class="dim">${e(t('run.archived_since', { ts: run.archived_at }))}</span>`
         : `<span class="dim">${e(t('run.archive_hint'))}</span>`}</div>`
    : ''}`
}

/** A finish_state / merge_status as a word, falling back to the raw value. */
export function finishText(state) {
  const key = `finish.${state}`
  return t(key) === key ? String(state) : t(key)
}
export function mergeText(status) {
  const key = `merge.${status}`
  return t(key) === key ? String(status) : t(key)
}

/**
 * Where this run's work stands — and the buttons that move it.
 *
 * Only rendered where the repo asked the hub to integrate; with merge_mode 'off'
 * this block does not exist and the page is what it always was. The buttons are
 * ordinary POST forms in the page's own style; the destructive one asks first.
 */
export function integrationSection(run, repo) {
  if (repo?.merge_mode !== 'hub' && !run.merge_status && !run.finish_state) return ''
  const terminal = ['done', 'failed', 'aborted'].includes(run.status)
  const zeilen = []
  if (run.finish_state) zeilen.push(`<b>${e(finishText(run.finish_state))}</b>`)
  if (run.merge_status) zeilen.push(e(mergeText(run.merge_status)))
  if (run.merged_sha) zeilen.push(`<code>${e(run.merged_sha.slice(0, 7))}</code>`)
  if (run.resolver_run_id) {
    zeilen.push(`<a href="/runs/${e(run.resolver_run_id)}">${e(t('merge.resolver_run'))}</a>`)
  }
  if (run.resolves_run_id) {
    zeilen.push(`<a href="/runs/${e(run.resolves_run_id)}">${e(t('merge.original_run'))}</a>`)
  }
  const resume = resumeCommand(run)

  const btn = (action, label, extra = '', confirmKey = null) => `
    <form method="post" action="/api/runs/${e(run.id)}/${action}" class="inline"${
      confirmKey ? ` onsubmit="return confirm(${e(JSON.stringify(t(confirmKey)))})"` : ''}>${extra}
      <button>${e(t(label))}</button></form>`

  const buttons = []
  if (run.status === 'running' && !run.finish_state) {
    buttons.push(btn('mark-done', 'merge.mark_done'))
  }
  const unmerged = String(run.merge_status ?? '')
  // 'kept_on_branch' is in this list on purpose: keeping the work on its branch
  // is what happened automatically at the end of the run, not a verdict for all
  // time. One click still integrates it, the ordinary way.
  if (terminal && ['unmerged_commits', 'blocked_error', 'blocked_conflict', 'blocked_no_remote',
    'kept_on_branch'].includes(unmerged)) {
    buttons.push(btn('merge', 'merge.merge_now'))
  }
  if (['blocked_dirty', 'unmerged_both', 'unmerged_dirty'].includes(unmerged)) {
    buttons.push(btn('merge', 'merge.commit_leftovers', '<input type="hidden" name="leftovers" value="commit">'))
    buttons.push(btn('merge', 'merge.discard_leftovers', '<input type="hidden" name="leftovers" value="discard">',
      'merge.discard_confirm'))
  }
  if (/^(blocked_|unmerged_)/.test(unmerged)) buttons.push(btn('merge-skip', 'merge.skip'))

  return `<div class="banner waiting" id="run-integration">
    <b>${e(t('merge.section'))}:</b> ${zeilen.join(' · ') || `<span class="dim">–</span>`}
    ${resume ? `<div class="dim">${e(t('merge.resume'))}: <code>${e(resume)}</code></div>` : ''}
    ${buttons.length ? `<div class="btn-row">${buttons.join('')}</div>` : ''}
  </div>`
}

/**
 * What this run IS, as chips.
 *
 * Eight facts joined by "·" into one wrapping paragraph is a sentence one has
 * to parse before one can look anything up; every fact wrapped in its own chip
 * with its own caption can be found by looking. Nothing was dropped — repo,
 * coding agent, model, serving provider, start, end, expectation, working
 * directory and the extra skills are all still here.
 */
export function runChips(run, repo, herkunft) {
  const chip = (key, value, opts = {}) => value == null || value === ''
    ? ''
    : `<li><span class="k">${e(t(key))}</span> ${opts.raw ? value : e(String(value))}</li>`
  return `<ul class="chips">
    <li><span class="k">${e(t('run.id_label'))}</span> <code>${e(run.id.slice(0, 8))}</code></li>
    ${chip('layout.repo', repo?.name ?? '?')}
    ${chip('overview.origin', herkunft)}
    ${chip('agents.harness', harnessLabel(run.harness))}
    ${chip('agents.model', run.model)}
    ${chip('model.provider', run.provider
      ? run.provider + (runRoutingJson(run.or_routing)?.mode === 'auto'
        ? runRoutingNote(run.or_routing)
        : run.or_provider ? ` (${t('run.pinned')}: ${run.or_provider})` : '') : null)}
    ${chip('run.start', runStartZeit(run) ? fmtDbUtc(runStartZeit(run)) : null)}
    ${chip('run.end', run.ended_at ? fmtDbUtc(run.ended_at) : null)}
    ${chip('run.expectation', t('unit.minutes', { n: run.expected_minutes }))}
    ${run.workdir_effective ? chip('run.workdir', `<code>${e(run.workdir_effective)}</code>`, { raw: true }) : ''}
    ${skillListe(run.skills).length ? chip('skills.title', skillAnzeige(run.skills).join(', ')) : ''}
  </ul>`
}

/**
 * "Edit this run" — the one card through which a run that still has a future
 * can be changed, folded away like the goal. The fields are rendered from
 * runEditAllowed(), the SAME table the API applies: a running run gets only
 * the expected duration (the watcher's thresholds and the metrics read the
 * column live), a scheduled or deferred run additionally the prompt, the repo
 * and the branch rule (all read at launch), and a scheduled run its start time
 * — through the same block the single-run form plans one with, so the operator
 * re-decides the "when" exactly the way it was decided the first time. A
 * finished run gets no card at all.
 *
 * The card is part of the run-detail fragment, so a status change (a scheduled
 * run starts) swaps the fields by themselves — and hub.js skips that swap while
 * the card has focus, so an edit is never thrown away mid-typing.
 */
export function runEditCard(run) {
  const erlaubt = runEditAllowed(run)
  if (!erlaubt.duration && !erlaubt.prompt && !erlaubt.repo && !erlaubt.startTime && !erlaubt.branch) return ''
  // Moving a run into a deactivated repo is not an offer worth making.
  const repos = db.prepare('SELECT id,name FROM repos WHERE active=1 ORDER BY name').all()
  const zeilen = []
  if (erlaubt.duration) {
    zeilen.push(`<label>${e(t('runform.expected'))}
      <input type="number" name="expected_minutes" min="1" value="${e(run.expected_minutes)}">
      <span class="dim">${e(t('run.edit.duration_hint'))}</span></label>`)
  }
  if (erlaubt.prompt) {
    zeilen.push(`<label>${e(t('runform.prompt'))}
      <textarea name="prompt" rows="8" required>${e(run.prompt)}</textarea>
      <span class="dim">${e(t('run.edit.prompt_hint'))}</span></label>`)
  }
  if (erlaubt.repo) {
    zeilen.push(`<label>${e(t('layout.repo'))} <select name="repo_id">
      ${repos.map(r => `<option value="${r.id}" ${r.id === run.repo_id ? 'selected' : ''}>${e(r.name)}</option>`).join('')}
    </select>
    <span class="dim">${e(t('run.edit.repo_hint'))}</span></label>`)
  }
  if (erlaubt.branch) {
    // The same block the run forms use — repo-switching inside the card flips
    // the explanations through its data-merge-modes/bases, exactly as in the
    // Quick-Run dialog.
    zeilen.push(branchFields(run, branchContext(run.repo_id)))
  }
  if (erlaubt.startTime) {
    // Prefilled with what the run currently waits for: the DB holds UTC, the
    // <input type="datetime-local"> wants local time on this machine (the same
    // assumption runStartFromForm makes the other way round).
    const at = parseDbUtc(run.start_at)
    zeilen.push(runStartTimeFields({
      start_mode: run.start_mode,
      start_at: Number.isFinite(at) ? toDateTimeLocal(at) : '',
    }))
    zeilen.push(`<p class="dim">${e(t('run.edit.start_hint'))}</p>`)
  }
  return `<details class="run-edit" id="run-edit">
    <summary>${e(t('run.edit'))}</summary>
    <form method="post" action="/api/runs/${e(run.id)}/edit" class="settings form-grid">
      ${zeilen.join('')}
      <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
    </form>
  </details>`
}

/** DB UTC ('YYYY-MM-DD HH:MM:SS') → local time in the datetime-local shape. */
function toDateTimeLocal(ms) {
  const d = new Date(ms)
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`
}

/**
 * The figures of a run. Its own block because it is the part that moves —
 * and a definition grid rather than a bullet list, because everyone read those
 * <li>s as a two-column table anyway.
 */
export function runMetrics(run) {
  const zeile = (key, value) => `<dt>${e(t(key))}</dt><dd>${value}</dd>`
  return `<dl class="metrics" id="run-metrics">
    ${zeile('run.runtime', `${fmtLaufzeit(run)} <span class="dim">/ ${e(t('run.expectation'))} ${e(t('unit.minutes', { n: run.expected_minutes }))}</span>`)}
    ${zeile('run.tokens', e(t('run.tokens_value', { in: run.tokens_in ?? 0, out: run.tokens_out ?? 0 })))}
    ${zeile('run.costs', run.cost_eur != null ? e(fmtNum(run.cost_eur, { maximumFractionDigits: 2 })) + ' € (' + e(t('run.abo_delta')) + ')' : run.cost_usd != null ? e(fmtNum(run.cost_usd, { maximumFractionDigits: 4 })) + ' $' : '–')}
    ${zeile('run.activity', e(run.last_activity_at ? fmtDbUtc(run.last_activity_at) : '–'))}
    ${zeile('run.branch_reported', `${e(run.branch_reported ?? '–')} <span class="dim">/ ${e(t('run.branch_expected'))} ${e(run.branch_expected ?? '–')}</span>`)}
    ${zeile('run.pr', run.pr_url ? `<a href="${e(run.pr_url)}">${e(run.pr_url)}</a>` : '–')}
    ${zeile('run.exit', `${run.exit_code ?? '–'}${run.tmux_closed_at ? ` <span class="dim">/ ${e(t('run.tmux_closed'))} ${e(fmtDbUtc(run.tmux_closed_at))}</span>` : ''}`)}
  </dl>`
}

/** The run's history, oldest first — without the notification bookkeeping. */
export function runEvents(runId) {
  // Both names: `notified%` is what is written today, `telegram_sent%` what
  // rows from before the notification rebuild carry.
  const events = db.prepare(`SELECT * FROM events WHERE run_id=?
      AND kind NOT LIKE 'notified%' AND kind NOT LIKE 'telegram_sent%' ORDER BY id`).all(runId)
  return `<ul class="events" id="run-events">${events.map(ev => `<li><span class="dim">${e(fmtDbUtc(ev.ts))}</span> ${e(ev.kind)}</li>`).join('') || `<li class="dim">${e(t('run.none'))}</li>`}</ul>`
}

/**
 * The runtime figure of the metrics block. A run that is still WAITING to start
 * (scheduled, deferred) carries its PLANNING time in `started_at` — the column's
 * default is the moment the row was created, the real start is only written into
 * it when the run launches (pickUpScheduled / startDeferredRun). Counting from
 * it would present the waiting time as runtime — and would call the run
 * "running", which a scheduled run is not. The overview already shows no
 * duration for such a run; the detail page has to say the same thing. Only once
 * the run is actually going (or has gone) does the figure mean "runtime".
 */
function fmtLaufzeit(run) {
  if (run.status === 'scheduled' || run.status === 'deferred') return '–'
  const endeMs = run.ended_at ? Date.parse(run.ended_at.replace(' ', 'T') + 'Z') : Date.now()
  const min = Math.round((endeMs - Date.parse(run.started_at.replace(' ', 'T') + 'Z')) / 60000)
  return `${t('unit.minutes', { n: min })}${run.ended_at ? '' : ' (' + t('run.running') + ')'}`
}

/** The moment a run's clock really starts — or started. Null while it still waits to launch. */
function runStartZeit(run) {
  if (run.status === 'scheduled') return run.start_mode === 'at' ? (run.start_at || null) : null
  if (run.status === 'deferred') return null
  return run.started_at || null
}

/**
 * Incidents on the detail page: open ones with a resolve button, resolved ones
 * as history. The evidence (the line that fired) is shown — otherwise a false
 * alarm cannot be told apart from a real one.
 */
export function vorfallAbschnitt(runId, runStatus = null) {
  const alle = alleVorfaelle(runId)
  if (!alle.length) return ''
  const zeile = (v) => `<li class="incident-row ${v.geloest_am ? 'resolved' : SEVERITY_CLASS[v.schwere]}">
    <b>${e(typName(v.typ))}</b> <span class="dim">(${e(v.quelle)}, ${e(t(SEVERITY_TEXT[v.schwere] ?? 'incidents.severity_red'))})</span>
    · ${v.anzahl}× · ${e(t('incidents.first'))} ${e(fmtDbUtc(v.erst_gesehen))} · ${e(t('incidents.last'))} ${e(fmtDbUtc(v.zuletzt_gesehen))}
    ${v.wieder_geoeffnet ? `· ${e(t('incidents.reopened', { n: v.wieder_geoeffnet }))}` : ''}
    ${v.geloest_am ? `· ${e(t('incidents.resolved_at'))} ${e(fmtDbUtc(v.geloest_am))} (${e(v.geloest_von ?? '')})` : `
      <form method="post" action="/api/incidents/${v.id}/resolve" class="inline"><input type="hidden" name="back" value="/runs/${runId}"><button>${e(t(brauchtMensch(v, runStatus) ? 'incidents.mark_handled' : 'incidents.dismiss'))}</button></form>`}
    ${v.beleg ? `<br><code class="evidence">${e(v.beleg)}</code>` : ''}</li>`
  const offen = alle.filter(v => !v.geloest_am), zu = alle.filter(v => v.geloest_am)
  // The split the single "resolve" button was missing: what is waiting for
  // hands, and what the hub merely wrote down. Both stay visible — but only the
  // first group is a to-do.
  const handeln = offen.filter(v => brauchtMensch(v, runStatus))
  const notiz = offen.filter(v => !brauchtMensch(v, runStatus))
  return `<h3>${e(t('incidents.title'))}</h3>
  ${handeln.length ? `<h4 class="incident-group red">${e(t('incidents.needs_you', { n: handeln.length }))}</h4>
    <p class="dim">${e(t('incidents.needs_you_hint'))}</p>
    <ul class="incidents">${handeln.map(zeile).join('')}</ul>` : ''}
  ${notiz.length ? `<h4 class="incident-group yellow">${e(t('incidents.noticed', { n: notiz.length }))}</h4>
    <p class="dim">${e(t('incidents.noticed_hint'))}</p>
    <ul class="incidents">${notiz.map(zeile).join('')}</ul>` : ''}
  ${offen.length ? `<form method="post" action="/api/runs/${runId}/incidents/resolve-all"><button>${e(t('incidents.resolve_all'))}</button>
    <span class="dim">${e(t('incidents.resolve_hint'))}</span></form>` : ''}
  ${zu.length ? `<details><summary class="dim">${e(t('incidents.resolved_n', { n: zu.length }))}</summary><ul class="incidents">${zu.map(zeile).join('')}</ul></details>` : ''}
  <p class="dim">${e(t('incidents.detector_log'))}: <code>${e(join(env('RUNS_DIR') ?? `${process.env.HOME}/agents/runs`, runId, 'detektor.jsonl'))}</code></p>`
}

// ---------------- repos ----------------
export async function pageRepos(req, res, url) {
  // EVERY repo, active or not — this is the one page an inactive one has to
  // stay visible on, or deactivating would be a way of losing a repository
  // rather than of putting it away.
  const repos = db.prepare('SELECT * FROM repos ORDER BY name').all()
  const rows = repos.map(r => {
    const p = (r.prompt ?? '').trim()
    const kurz = p ? (p.length > 60 ? p.slice(0, 60) + '…' : p) : ''
    const aus = r.active === 0
    return `<tr${aus ? ' class="repo-off"' : ''}><td>${e(r.name)}
      ${aus ? `<div class="dim">${e(t('repos.inactive_mark'))}</div>` : ''}</td>
    <td><code>${e(r.path)}</code></td><td>${e(r.base_branch)}</td>
    <td class="dim">${e(r.worktree_extras)}</td>
    <td>${kurz ? `<span class="dim" title="${e(p)}">${e(kurz)}</span>` : `<span class="dim">—</span>`}</td>
    <td>${e(r.merge_mode === 'hub' ? t('merge.mode_hub') : t('merge.mode_off'))}${mergeFlowsHint(r.id)}
      ${r.last_push_at ? `<div class="dim">${e(t('repos.last_push', { ts: r.last_push_at }))}</div>` : ''}</td>
    <td><div class="btn-row">
      <a class="btn" href="/repos/edit?id=${r.id}">${e(t('agents.edit'))}</a>
      <form method="post" action="/repos/toggle" class="inline">
        <input type="hidden" name="id" value="${r.id}">
        <input type="hidden" name="active" value="${aus ? '1' : '0'}">
        <button class="ghost">${e(t(aus ? 'repos.activate' : 'repos.deactivate'))}</button>
      </form>
      <button type="button" class="ghost repo-delete-open" data-repo="${r.id}">${e(t('repos.delete'))}</button>
    </div></td></tr>`
  }).join('')
  const body = `
  <p><a class="btn" href="/repos/edit">${e(t('repos.create'))}</a></p>
  <table class="list"><thead><tr><th>${e(t('repos.name'))}</th><th>${e(t('repos.path'))}</th><th>${e(t('repos.base'))}</th><th>${e(t('repos.extras'))}</th><th>${e(t('repos.prompt'))}</th><th>${e(t('repos.integration_legend'))}</th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="7" class="dim">${e(t('repos.none'))}</td></tr>`}</tbody></table>
  ${repos.map(repoDeleteDialog).join('')}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('nav.repos'), '/repos', body))
}

/**
 * What a repo's deletion would really cost, counted rather than described.
 * `runs` includes archived ones — "archived" is not "gone", and somebody about
 * to lose their history should see the whole number.
 */
export function repoDeleteFacts(repoId) {
  const one = (sql) => db.prepare(sql).get(repoId)?.c ?? 0
  return {
    agents: one('SELECT count(*) c FROM agents WHERE repo_id=?'),
    runs: one('SELECT count(*) c FROM runs WHERE repo_id=?'),
    reports: one(`SELECT count(*) c FROM runs WHERE repo_id=? AND report_md IS NOT NULL AND report_md <> ''`),
    events: one('SELECT count(*) c FROM events WHERE run_id IN (SELECT id FROM runs WHERE repo_id=?)'),
    incidents: one('SELECT count(*) c FROM incidents WHERE run_id IN (SELECT id FROM runs WHERE repo_id=?)'),
    inFlight: one(`SELECT count(*) c FROM runs WHERE repo_id=?
      AND status IN ('running','waiting_help','scheduled','deferred')`),
  }
}

/**
 * The confirmation before a repository goes.
 *
 * One dialog per row, server-rendered — the counts and the paths are facts out
 * of the database and off the disk layout, and a client that composed them
 * would be guessing. The name has to be typed: `hub.js` keeps the delete button
 * disabled until it matches, and `repoDelete()` checks it again, because the
 * hub has no authentication and a fence that only exists in the browser is not
 * a fence.
 *
 * The second action is the point of the whole feature: deactivating is almost
 * always what the operator actually wants, so it is offered HERE, at the moment
 * they are about to do the irreversible thing instead.
 *
 * The delete button carries `danger` and the other two are `ghost`: this is the
 * one button in the dialog that destroys something, and it may not look like
 * its neighbours. Nothing here is the accent colour on purpose — a destructive
 * dialog should have no inviting primary action.
 *
 * It ships `disabled` without exception. `hub.js` arms it only once the typed
 * name matches, and with work in flight there is no name field at all, so it
 * can never be armed at all — which is why there is no condition on it.
 */
function repoDeleteDialog(r) {
  const f = repoDeleteFacts(r.id)
  const wt = join(WORKTREES_DIR, r.name)
  return `<dialog id="repo-del-${r.id}" class="qr cleanup repo-del" data-name="${e(r.name)}">
    <h3>${e(t('repos.del_title', { name: r.name }))}
      <button type="button" class="mini" data-repo-del-close aria-label="${e(t('qr.cancel'))}">✕</button></h3>
    <p class="warn">${e(t('repos.del_lose', {
      runs: f.runs, agents: f.agents, reports: f.reports, events: f.events, incidents: f.incidents,
    }))}</p>
    <p>${e(t('repos.del_keeps_checkout'))} <code>${e(r.path)}</code></p>
    <p class="dim">${e(t('repos.del_leftovers'))}</p>
    <ul class="skill-list"><li><code>${e(wt)}</code></li><li><code>${e(RUNS_DIR)}/&lt;run id&gt;</code></li></ul>
    ${f.inFlight
      ? `<p class="err">${e(t('repos.del_in_flight', { n: f.inFlight }))}</p>`
      : `<label>${e(t('repos.del_type_name', { name: r.name }))}
          <input type="text" class="repo-del-name" autocomplete="off" spellcheck="false"></label>`}
    <menu class="qr-actions">
      <button type="button" class="ghost" data-repo-del-close>${e(t('qr.cancel'))}</button>
      <form method="post" action="/repos/toggle" class="inline">
        <input type="hidden" name="id" value="${r.id}">
        <input type="hidden" name="active" value="0">
        <button class="ghost repo-del-deactivate">${e(t('repos.del_deactivate_instead'))}</button>
      </form>
      <form method="post" action="/repos/delete" class="inline">
        <input type="hidden" name="id" value="${r.id}">
        <input type="hidden" name="confirm" value="" class="repo-del-confirm">
        <button class="repo-del-go danger" disabled>${e(t('repos.del_go'))}</button>
      </form>
    </menu>
  </dialog>`
}

/**
 * Switch a repository off, or on again. `active` sets it explicitly, an absent
 * `active` flips it — the button sends the value it means, a script should too.
 *
 * `'0'` is compared, never coerced: the string is truthy in JavaScript, and
 * that exact trap made `POST /agents/edit` read `active=0` as "switch it on"
 * (see the Pitfalls section in AGENTS.md).
 */
export async function repoToggle(req, res, url, formBody) {
  const b = await formBody()
  const repo = getRepo(+(b.id ?? 0))
  if (!repo) return problemPage(req, res, t('nav.repos'), [t('api.unknown_repo')], '/repos')
  const wanted = b.active === undefined ? (repo.active === 0 ? 1 : 0)
    : (b.active === '1' || b.active === 'on' || b.active === 'true') ? 1 : 0
  db.prepare('UPDATE repos SET active=? WHERE id=?').run(wanted, repo.id)
  const back = String(b.back ?? '')
  redirect(res, back.startsWith('/') && !back.startsWith('//') ? back : '/repos')
}

/**
 * Delete a repository — the row, its agents, its runs and everything hanging
 * off those runs.
 *
 * Two fences, and both are load-bearing:
 *
 *   - **`confirm` must equal the repo's name.** The hub has no authentication,
 *     so anything reachable over HTTP is reachable by any process on this
 *     machine, a coding agent included. Typing the name is what makes this an
 *     act rather than a request, and it is why the agent-facing skill can say
 *     "you cannot delete a repo, ask the human".
 *   - **Work in flight refuses.** A `running`, `waiting_help`, `scheduled` or
 *     `deferred` run would be deleted out from under a live tmux session.
 *     Finish or abort them first; the refusal says how many there are.
 *
 * Everything is deleted EXPLICITLY, child rows first, in one transaction — and
 * the ORDER is not cosmetic. `foreign_keys` really is ON here (measured: the
 * table-rebuild dance in db.mjs switches it back on and leaves it there), so
 * `DELETE FROM repos` would be REFUSED while a run still references the row.
 * Doing it in this order also means the operation is all-or-nothing: a failure
 * half way through leaves the repository exactly as it was rather than
 * half-emptied.
 *
 * What it deliberately does not touch: the git checkout at `repos.path`, the
 * worktrees, the run directories, and a `run_merged` flow that was scoped to
 * this repo (it survives and simply never fires again). The dialog says all of
 * that before the click.
 */
export async function repoDelete(req, res, url, formBody) {
  const b = await formBody()
  const repo = getRepo(+(b.id ?? 0))
  if (!repo) return problemPage(req, res, t('nav.repos'), [t('api.unknown_repo')], '/repos')
  const facts = repoDeleteFacts(repo.id)
  const problems = []
  if (String(b.confirm ?? '') !== repo.name) problems.push(t('repos.del_err_confirm', { name: repo.name }))
  if (facts.inFlight) problems.push(t('repos.del_err_in_flight', { n: facts.inFlight, name: repo.name }))
  if (problems.length) return problemPage(req, res, t('nav.repos'), problems, '/repos')

  // `db.exec('BEGIN')` and not `db.transaction(...)`: this hub runs on
  // `node:sqlite`, whose DatabaseSync has no `transaction()` — that is
  // better-sqlite3's API, and reaching for it here cost a 500 and one e2e run
  // to notice. Same shape as `tabelleUmziehen()` in db.mjs.
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE repo_id=?)').run(repo.id)
    db.prepare('DELETE FROM incidents WHERE run_id IN (SELECT id FROM runs WHERE repo_id=?)').run(repo.id)
    db.prepare('DELETE FROM runs WHERE repo_id=?').run(repo.id)
    db.prepare('DELETE FROM agents WHERE repo_id=?').run(repo.id)
    db.prepare('DELETE FROM repos WHERE id=?').run(repo.id)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    // A half-deleted repository is the one outcome worse than a refused delete,
    // so the operator gets the reason and the repo stays exactly as it was.
    return problemPage(req, res, t('nav.repos'), [t('repos.del_err_failed', { name: repo.name, err: err.message })], '/repos')
  }
  console.log(`[freilauf] repo '${repo.name}' deleted: ${facts.runs} run(s), ${facts.agents} agent(s), `
    + `${facts.events} event(s), ${facts.incidents} incident(s). Checkout at ${repo.path} untouched.`)
  const back = String(b.back ?? '')
  redirect(res, back.startsWith('/') && !back.startsWith('//') ? back : '/repos')
}

// ---------------- tmux sessions ----------------
//
// The one page that shows the machine instead of the hub's bookkeeping: what
// tmux really holds, how old it is and what it costs. Sessions with a RUNNING
// agent are hidden by default — this page exists for cleaning up, and the row
// one must not hit by accident should not be within reach of the mouse.
//
// The filter, the selection and the ending all happen in the browser
// (public/hub.js): every row is rendered once, hiding is a CSS class, and a
// kill is a fetch per session. Nothing here waits for tmux.

const STATE_CLASS = {
  agent_running: 'red', run_ended: 'yellow', dead: 'green', unknown: 'gray',
}

function byteText(kb) {
  if (!kb) return '–'
  return kb >= 1024 * 1024 ? `${fmtNum(kb / 1024 / 1024, { maximumFractionDigits: 1 })} GB` : `${Math.round(kb / 1024)} MB`
}

/**
 * One tmux session as a table row. `ctx` is unused today and stands there for
 * the same reason the other row renderers take one: the call site, not the row,
 * decides what a row needs to know.
 */
export function sessionRow(s, ctx = {}) {
  const run = s.run
  const running = s.state === 'agent_running'
  const title = run ? runTitle(run, run.agent_name, t('overview.single_run')) : s.name
  const age = s.createdMs != null
    ? `<time class="reltime" datetime="${new Date(s.createdMs).toISOString()}" title="${e(fmtDateTime(s.createdMs))}">${e(fmtRelativeTime(s.createdMs))}</time>`
    : '<span class="dim">–</span>'
  const activity = s.activityMs != null
    ? `<time class="reltime" datetime="${new Date(s.activityMs).toISOString()}" title="${e(fmtDateTime(s.activityMs))}">${e(fmtRelativeTime(s.activityMs))}</time>`
    : '<span class="dim">–</span>'
  const stateText = {
    agent_running: t('sessions.state_running'),
    run_ended: t('sessions.state_ended'),
    dead: t('sessions.state_dead'),
    unknown: t('sessions.state_unknown'),
  }[s.state]
  return `<tr id="session-${e(s.name)}" data-session="${e(s.name)}" data-running="${running ? '1' : '0'}">
    <td><input type="checkbox" class="sess-pick" value="${e(s.name)}" aria-label="${e(s.name)}"></td>
    <td><span class="dot ${STATE_CLASS[s.state]}"></span> <span class="sess-state">${e(stateText)}</span>
      ${s.deadStatus ? `<span class="dim">${e(t('sessions.exit', { code: s.deadStatus }))}</span>` : ''}</td>
    <td>${run
      ? `<a href="/runs/${e(run.id)}">${e(title)}</a><div class="dim">${e(statusText(run.status))}${run.repo_name ? ` · ${e(run.repo_name)}` : ''}</div>`
      : `<span class="dim">${e(t('sessions.unknown_hint'))}</span>`}</td>
    <td><code>${e(s.name)}</code>${run ? `<div class="dim">${e(harnessLabel(run.harness))}${run.model ? `/${e(run.model)}` : ''}</div>` : ''}</td>
    <td>${age}</td>
    <td>${activity}</td>
    <td>${e(s.command || '–')}<div class="dim">${e(t('sessions.processes'))}: ${s.resources.count}</div></td>
    <td>${e(byteText(s.resources.rssKb))}<div class="dim">${e(fmtNum(s.resources.cpu, { maximumFractionDigits: 1 }))} % CPU</div></td>
    <td>${s.windows}/${s.paneCount}${s.attached ? ` <b>${e(t('sessions.attached'))}</b>` : ''}</td>
    <td class="dim"><code>${e(s.path)}</code></td>
    <td><button type="button" class="danger sess-kill">${e(t('sessions.end'))}</button></td>
  </tr>`
}

export async function pageSessions(req, res, url) {
  const sessions = await listSessions()
  const runningCount = sessions.filter(s => s.state === 'agent_running').length
  const rssTotal = sessions.reduce((n, s) => n + s.resources.rssKb, 0)
  const hours = Math.round(currentKeepMs() / 3_600_000 * 10) / 10
  const cleanup = cleanupSettings()
  const cleanupBox = cleanupConfigured(cleanup)
    ? `<div class="card cleanup-card">
    <h3>${e(t('sessions.free_title'))}</h3>
    <p class="dim">${e(t('sessions.free_hint'))}</p>
    <div class="btn-row">
      <button type="button" class="cleanup-free-open" data-cleanup-open>${e(t('sessions.free_btn'))}</button>
      <span class="dim">${e(t('sessions.free_keep_hint'))}</span>
    </div>
  </div>`
    : `<div class="card">
    <h3>${e(t('sessions.free_title'))}</h3>
    <p class="dim">${e(t('sessions.free_none'))} <a href="/settings/cleanup">${e(t('nav.settings'))}</a></p>
  </div>`
  const body = `
  <h2>${e(t('sessions.title'))}</h2>
  <p class="dim">${e(t('sessions.intro'))}</p>
  ${cleanupBox}
  <div class="sess-bar">
    <label class="chk"><input type="checkbox" id="sess-show-running"> ${e(t('sessions.show_running'))}</label>
    <label class="chk"><input type="checkbox" id="sess-all"> ${e(t('sessions.select_all'))}</label>
    <button type="button" id="sess-kill-selected" class="danger" disabled>${e(t('sessions.end_selected', { n: 0 }))}</button>
    <span class="spacer"></span>
    <span class="dim" id="sess-summary">${e(t('sessions.summary', { n: sessions.length, ram: byteText(rssTotal) }))}</span>
    <a class="btn" href="/sessions">${e(t('sessions.refresh'))}</a>
  </div>
  <p class="dim" id="sess-hidden" hidden></p>
  <p class="dim">${e(t('sessions.auto_hint', { hours: hours }))}
     <a href="/settings">${e(t('nav.settings'))}</a></p>
  ${sessionsTable(sessions, {})}
  <p class="dim">${e(t('sessions.hidden_note', { n: runningCount }))}</p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('sessions.title'), '/sessions', body))
}

export function sessionRows(sessions, ctx = {}) {
  return sessions.map(s => sessionRow(s, ctx)).join('')
    || `<tr><td colspan="11" class="dim">${e(t('sessions.none'))}</td></tr>`
}

export function sessionsTable(sessions, ctx = {}) {
  return `<div class="table-wrap"><table class="list sessions"><thead><tr>
    <th></th><th>${e(t('sessions.col_state'))}</th><th>${e(t('sessions.col_run'))}</th>
    <th>${e(t('sessions.col_session'))}</th><th>${e(t('sessions.col_age'))}</th>
    <th>${e(t('sessions.col_activity'))}</th><th>${e(t('sessions.col_process'))}</th>
    <th>${e(t('sessions.col_resources'))}</th><th>${e(t('sessions.col_windows'))}</th>
    <th>${e(t('sessions.col_path'))}</th><th></th></tr></thead>
  <tbody id="sessions-body">${sessionRows(sessions, ctx)}</tbody></table></div>`
}

// ---------------- settings ----------------

/** The 1/0 select every switch on this page has always been. */
function onOff(name, on, extra = '') {
  return `<select name="${e(name)}"${extra}>
    <option value="1" ${on ? 'selected' : ''}>${e(t('layout.on'))}</option>
    <option value="0" ${on ? '' : 'selected'}>${e(t('layout.off'))}</option></select>`
}

/**
 * One `SettingField` a plugin declared, rendered into THIS form.
 *
 * The name is `pluginSettingKey()` and nothing else: for a built-in gate that
 * is the key the settings table has always carried (`claude_gate_5h`,
 * `openrouter_min_eur`, …), which is why generating these fields migrates
 * nothing and loses nothing.
 *
 * `default: null` is a value, not a missing one — `claude_gate_fable` declares
 * it on purpose, because an EMPTY fable threshold means "follow the 7-day one".
 * Rendering the 7-day default into it would turn that rule off by displaying it.
 */
function settingsField(pluginId, field, s) {
  const name = pluginSettingKey(pluginId, field)
  const stored = s[name]
  const value = stored === undefined || stored === null ? (field.default ?? '') : stored
  const label = e(t(field.labelKey ?? field.key))
  const hint = field.hintKey ? ` <span class="dim">${e(t(field.hintKey))}</span>` : ''
  if (field.type === 'switch') {
    return `<label>${label} ${onOff(name, String(value) === '1' || value === true || value === 1)}${hint}</label>`
  }
  if (field.type === 'select') {
    const options = (field.options ?? []).map(o => {
      const id = typeof o === 'string' ? o : o.value
      const text = typeof o === 'string' ? o : t(o.labelKey ?? o.label ?? o.value)
      return `<option value="${e(id)}" ${String(value) === String(id) ? 'selected' : ''}>${e(text)}</option>`
    }).join('')
    return `<label>${label} <select name="${e(name)}">${options}</select>${hint}</label>`
  }
  const type = field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'
  const num = field.type === 'number'
    ? `${field.min !== undefined ? ` min="${e(field.min)}"` : ''}${field.max !== undefined ? ` max="${e(field.max)}"` : ''}${field.step !== undefined ? ` step="${e(field.step)}"` : ''}`
    : ''
  return `<label>${label} <input type="${type}" name="${e(name)}" value="${e(value)}"${num}>${hint}</label>`
}

/**
 * Budget gates: one block per plugin that declares thresholds, in the
 * registry's order. Nothing about claude, cursor, OpenRouter or DeepSeek is
 * typed here any more — an installed plugin's gate appears by itself, and a
 * disabled one does not (`gatePlugins()` filters on that).
 */
function gatesFieldset(s) {
  const blocks = gatePlugins().map(p => `
    <div class="gate-block">
      <h4>${e(p.plugin.gate?.label ?? p.plugin.label ?? p.id)}</h4>
      ${pluginFields(p.plugin, 'gate').map(f => settingsField(p.id, f, s)).join('')}
    </div>`).join('')
  return `<fieldset><legend>${e(t('settings.gates_legend'))}</legend>
      <p class="dim">${e(t('settings.gates_hint'))}</p>
      ${blocks || `<p class="dim">${e(t('settings.gates_none'))}</p>`}
    </fieldset>`
}

/** What one entry of the source picker reads like. */
function sourceOptionText(src) {
  const parts = [src.label]
  if (src.kind === 'agent') parts.push(t('settings.llm_source_agent'))
  if (!src.ready) parts.push(t('settings.llm_source_not_ready'))
  return parts.length > 1 ? `${parts[0]} — ${parts.slice(1).join(', ')}` : parts[0]
}

/**
 * The source picker of one of the hub's own LLM jobs, plus the things that
 * hang on the chosen source: the overhead warning (a coding agent starts a
 * whole session for one question) and the OpenRouter serving-provider routing —
 * the SAME three modes and requirements the run forms carry (open / auto /
 * pin, with quantization, region and price caps folded away behind
 * <details>), stored under `llm_<purpose>_or_routing` and resolved through the
 * same plugin capability and cache. A provider choice that means something
 * only on OpenRouter means nothing anywhere else.
 *
 * The whole routing block is hidden AND disabled when it does not apply. A
 * hidden field that still submits is a trap this project has been bitten by
 * before — and here it would send an OpenRouter endpoint tag along with a
 * DeepSeek answer.
 */
function llmSourceFields(prefix, s, sources) {
  const key = `${prefix}_source`
  const current = String(s[key] ?? '').trim() || DEFAULT_SOURCE
  const chosen = sources.find(x => x.id === current) ?? null
  // A source whose plugin was removed or switched off is still offered — as
  // itself, marked. Dropping it from the list would silently re-point the job
  // at OpenRouter the next time somebody saves an unrelated field.
  const stale = chosen ? '' : `<option value="${e(current)}" selected>${e(t('settings.llm_source_unknown', { source: current }))}</option>`
  const options = sources.map(src =>
    `<option value="${e(src.id)}" ${src.id === current ? 'selected' : ''}
       data-overhead="${src.overhead ? '1' : '0'}">${e(sourceOptionText(src))}</option>`).join('')
  const overhead = !!chosen?.overhead
  const pin = current === DEFAULT_SOURCE
  let cfg = {}
  try { cfg = JSON.parse(s[`${prefix}_or_routing`] ?? '') ?? {} } catch { /* old rows and nulls */ }
  const tag = s[`${prefix}_or_provider`] ?? ''
  const mode = cfg?.mode === 'auto' ? 'auto' : tag ? 'pin' : 'offen'
  return `<label>${e(t('settings.llm_source'))}
      <select name="${e(key)}" data-llm-source>${stale}${options}</select>
      <span class="dim">${e(t('settings.llm_source_explain'))}</span></label>
    <p class="warn" data-llm-overhead ${overhead ? '' : 'hidden'}>${e(t('settings.llm_source_overhead'))}</p>
    <fieldset class="schedule" data-llm-pin ${pin ? '' : 'hidden'}>
      <div class="btn-row" role="radiogroup" aria-label="${e(t('or.legend'))}">
        <label class="chk"><input type="radio" name="${e(prefix)}_or_mode" value="offen" ${mode === 'offen' ? 'checked' : ''}> ${e(t('or.mode_offen'))}</label>
        <label class="chk"><input type="radio" name="${e(prefix)}_or_mode" value="auto" ${mode === 'auto' ? 'checked' : ''}> ${e(t('or.mode_auto'))}</label>
        <label class="chk"><input type="radio" name="${e(prefix)}_or_mode" value="pin" ${mode === 'pin' ? 'checked' : ''}> ${e(t('or.mode_pin'))}</label>
      </div>
      <label data-or-pin-field ${mode === 'pin' ? '' : 'hidden'}>${e(t('settings.llm_or_provider'))}
        <input name="${e(prefix)}_or_provider" value="${e(tag)}"
          placeholder="${e(t('settings.llm_or_ph'))}"></label>
      <details data-or-auto-details ${mode === 'auto' ? 'open' : ''} hidden>
        <summary>${e(t('or.auto_details'))}</summary>
        <label>${e(t('or.quant'))}
          <select name="${e(prefix)}_or_quant">
            <option value="">${e(t('or.quant_auto'))}</option>
            ${KNOWN_QUANTIZATIONS.map(q => `<option value="${q}" ${cfg.quant_min === q ? 'selected' : ''}>${q}</option>`).join('')}
          </select>
          <span class="dim">${e(t('or.quant_hint'))}</span>
        </label>
        <label>${e(t('or.region'))}
          <select name="${e(prefix)}_or_region">
            ${REGIONS.map(r => `<option value="${r}" ${(cfg.location ?? 'all') === r ? 'selected' : ''}>${e(t('or.region_' + r))}</option>`).join('')}
          </select>
        </label>
        <label>${e(t('or.max_in'))}
          <input type="number" step="0.01" min="0" name="${e(prefix)}_or_max_in" value="${e(cfg.max_in ?? '')}">
          <span class="dim">${e(t('or.max_hint'))}</span>
        </label>
        <label>${e(t('or.max_out'))}
          <input type="number" step="0.01" min="0" name="${e(prefix)}_or_max_out" value="${e(cfg.max_out ?? '')}">
        </label>
      </details>
    </fieldset>`
}

/**
 * The FALLBACK picker of one of the hub's own LLM jobs — the second source the
 * question goes to when the first is down (a provider outage, a rate limit, a
 * timeout), before any retry begins. Stored under `llm_<prefix>_fallback` (one
 * source id; the stored value reads as a list, so a hand-edited row may carry
 * an ordered chain) plus `llm_<prefix>_fallback_model`, because the fallback
 * usually speaks a different vendor's model names.
 *
 * Its own container (`data-llm-fb`) and its own attribute (`data-llm-fb` on
 * the select), NOT the primary's: the primary picker's client wiring scopes
 * itself to the fieldset and would otherwise find two selects fighting over
 * one warning. Empty = no fallback — an installation that changes nothing
 * behaves exactly as before.
 */
function llmFallbackFields(prefix, s, sources) {
  const key = `${prefix}_fallback`
  const current = String(s[key] ?? '').trim()
  const chosen = sources.find(x => x.id === current) ?? null
  const stale = current && !chosen
    ? `<option value="${e(current)}" selected>${e(t('settings.llm_source_unknown', { source: current }))}</option>`
    : ''
  const options = sources.map(src =>
    `<option value="${e(src.id)}" ${src.id === current ? 'selected' : ''}
       data-overhead="${src.overhead ? '1' : '0'}">${e(sourceOptionText(src))}</option>`).join('')
  const overhead = !!chosen?.overhead
  const fbModel = s[`${prefix}_fallback_model`] ?? ''
  return `<div data-llm-fb-block>
    <label>${e(t('settings.llm_fallback'))}
      <select name="${e(key)}" data-llm-fb><option value="" ${!current ? 'selected' : ''}>${e(t('settings.llm_fallback_none'))}</option>${stale}${options}</select>
      <span class="dim">${e(t('settings.llm_fallback_hint'))}</span></label>
    <p class="warn" data-llm-fb-overhead ${overhead ? '' : 'hidden'}>${e(t('settings.llm_source_overhead'))}</p>
    <label data-llm-fb-model ${current ? '' : 'hidden'}>${e(t('settings.llm_fallback_model'))}
      <input name="${e(prefix)}_fallback_model" value="${e(fbModel)}" list="${e(prefix)}_fb_list" placeholder="${e(t('settings.llm_fallback_model_ph'))}">
      <datalist id="${e(prefix)}_fb_list"></datalist>
      <span class="dim">${e(t('settings.llm_fallback_model_hint'))}</span></label>
  </div>`
}

export async function pageSettings(req, res, url) {
  const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]))
  const sources = llmSources()
  // The old warning read `process.env.OPENROUTER_API_KEY` and said "the key is
  // missing" whatever source the job pointed at. It is a statement about ONE
  // source now, and about the credential as the rest of the hub resolves it.
  const missingKey = (prefix) => {
    const id = String(s[`${prefix}_source`] ?? '').trim() || DEFAULT_SOURCE
    if (id !== DEFAULT_SOURCE || pluginHasCredential('openrouter')) return ''
    return ` <b class="warn">${e(t('settings.llm_missing_key'))}</b>`
  }
  const body = `
  <h2>${e(t('nav.settings'))}</h2>
  <p class="dim">${e(t('settings.global_hint'))}</p>
  <p><a class="btn" href="/settings/plugins">${e(t('plugins.title'))}</a>
     <span class="dim">${e(t('settings.plugins_hint'))}</span></p>
  <p><a class="btn" href="/settings/favorites">${e(t('fav.title'))}</a>
     <span class="dim">${e(t('settings.favorites_hint'))}</span></p>
  <p><a class="btn" href="/settings/merge">${e(t('merge.settings_title'))}</a>
     <span class="dim">${e(t('settings.merge_hint', { setup: mergeSettingsSummary() }))}</span></p>
  <p><a class="btn" href="/settings/cleanup">${e(t('cleanup.settings_title'))}</a>
     <span class="dim">${e(t('settings.cleanup_hint', { setup: cleanupSettingsSummary() }))}</span></p>
  <p><a class="btn" href="/settings/skills">${e(t('flskills.title'))}</a>
     <span class="dim">${e(t('settings.skills_hint', { state: t(skillsInstallOn() ? 'layout.on' : 'layout.off') }))}</span></p>
  <form method="post" action="/settings/save" class="settings form-grid">
    <label>${e(t('settings.language'))} <select name="ui_language">${Object.entries(LANGUAGES).map(([code, label]) =>
      `<option value="${code}" ${(s.ui_language ?? 'en') === code ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>
    <fieldset><legend>${e(t('settings.format_legend'))}</legend>
      <p class="dim">${e(t('settings.format_hint'))}</p>
      <label>${e(t('settings.timezone'))} <select name="ui_timezone"><option value="" ${!s.ui_timezone ? 'selected' : ''}>${e(t('settings.timezone_auto'))}</option>
        ${TIMEZONE_OPTIONS.map(z => `<option value="${z}" ${s.ui_timezone === z ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
      <p class="dim">${e(t('settings.numbers_hint'))}</p>
    </fieldset>
    <fieldset><legend>${e(t('settings.public_legend'))}</legend>
      <p class="dim">${e(t('settings.public_hint'))}</p>
      <label>${e(t('settings.public_host'))} <input name="public_host" type="text" placeholder="hub.example.internal" value="${e(s.public_host ?? '')}">
        <span class="dim">${e(t('settings.public_host_hint', { url: `${publicBase()}/runs/<id>` }))}</span></label>
    </fieldset>
    <label>${e(t('settings.pipeline'))} <select name="pipeline_on"><option value="1" ${s.pipeline_on === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${s.pipeline_on !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select></label>
    <label>${e(t('settings.schedule_catchup'))} <input name="schedule_catchup_hours" type="number" min="0" step="1" value="${e(String(catchupHours(s)))}">
      <span class="dim">${e(t('settings.schedule_catchup_hint'))}</span></label>
    ${gatesFieldset(s)}
    <label>${e(t('settings.abo_price'))} <input name="abo_price" type="number" value="${e(s.abo_price ?? '200')}">
      <span class="dim">${e(t('settings.abo_price_hint'))}</span></label>
    <label>${e(t('settings.session_keep'))} <input name="session_keep_hours" type="number" min="0" step="0.5" value="${e(String(sessionKeepHours(s)))}">
      <span class="dim">${e(t('settings.session_keep_hint'))}</span></label>
    <label>${e(t('settings.archive_session'))} <select name="archive_session_on"><option value="1" ${(s.archive_session_on ?? '1') === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${(s.archive_session_on ?? '1') !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select>
      <span class="dim">${e(t('settings.archive_session_hint'))}</span></label>
    <label>${e(t('settings.archive_session_keep'))} <input name="archive_session_keep_hours" type="number" min="0" step="0.5" value="${e(String(archiveSessionKeepHours(s)))}">
      <span class="dim">${e(t('settings.archive_session_keep_hint'))}</span></label>
    <label>${e(t('settings.flow_runs_keep'))} <input name="flow_runs_keep_days" type="number" min="0" step="1" value="${e(String(flowRunKeepDays(s)))}">
      <span class="dim">${e(t('settings.flow_runs_keep_hint'))}</span></label>
    <label>${e(t('settings.prompt_suffix'))} <textarea name="prompt_suffix" rows="12">${e(s.prompt_suffix ?? '')}</textarea></label>
    <fieldset data-llm-job><legend>${e(t('settings.llm_legend'))}</legend>
      <p class="dim">${e(t('settings.llm_hint'))}${missingKey('llm_check')}</p>
      <label>${e(t('settings.llm_on'))} <select name="llm_check_on"><option value="0" ${s.llm_check_on !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option><option value="1" ${s.llm_check_on === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option></select></label>
      ${llmSourceFields('llm_check', s, sources)}
      <label>${e(t('settings.llm_model'))} <input name="llm_check_model" list="llm-mru" value="${e(s.llm_check_model ?? '')}" placeholder="vendor/model">
        <datalist id="llm-mru">${llmModelleMru().map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">${e(t('settings.llm_mru_hint'))}</span></label>
      ${llmFallbackFields('llm_check', s, sources)}
    </fieldset>
    <fieldset data-llm-job><legend>${e(t('settings.title_legend'))}</legend>
      <p class="dim">${e(t('settings.title_hint'))}${missingKey('llm_title')}</p>
      <label>${e(t('settings.title_on'))} <select name="llm_title_on"><option value="1" ${(s.llm_title_on ?? '1') === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${(s.llm_title_on ?? '1') !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select></label>
      ${llmSourceFields('llm_title', s, sources)}
      <label>${e(t('settings.title_model'))} <input name="llm_title_model" list="title-mru" value="${e(s.llm_title_model || DEFAULT_TITLE_MODEL)}" placeholder="${e(DEFAULT_TITLE_MODEL)}">
        <datalist id="title-mru">${[...new Set([DEFAULT_TITLE_MODEL, ...titleModelsMru()])].map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">${e(t('settings.title_model_hint', { model: DEFAULT_TITLE_MODEL }))}</span></label>
      ${llmFallbackFields('llm_title', s, sources)}
    </fieldset>
    <fieldset data-llm-job><legend>${e(t('settings.extras_legend'))}</legend>
      <p class="dim">${e(t('settings.extras_hint'))}${missingKey('llm_extras')}</p>
      <label>${e(t('settings.extras_on'))} <select name="llm_extras_on"><option value="1" ${(s.llm_extras_on ?? '1') === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${(s.llm_extras_on ?? '1') !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select></label>
      ${llmSourceFields('llm_extras', s, sources)}
      <label>${e(t('settings.extras_model'))} <input name="llm_extras_model" list="extras-mru" value="${e(s.llm_extras_model || DEFAULT_EXTRAS_MODEL)}" placeholder="${e(DEFAULT_EXTRAS_MODEL)}">
        <datalist id="extras-mru">${[...new Set([DEFAULT_EXTRAS_MODEL, ...extrasModelsMru()])].map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">${e(t('settings.extras_model_hint', { model: DEFAULT_EXTRAS_MODEL }))}</span></label>
      ${llmFallbackFields('llm_extras', s, sources)}
    </fieldset>
    <fieldset><legend>${e(t('settings.llm_ops_legend'))}</legend>
      <p class="dim">${e(t('settings.llm_ops_hint'))}</p>
      <label>${e(t('settings.llm_retries'))} <input name="llm_retries" type="number" min="0" max="5" step="1" value="${e(s.llm_retries ?? '1')}">
        <span class="dim">${e(t('settings.llm_retries_hint'))}</span></label>
      <label>${e(t('settings.llm_retry_attempts'))} <input name="llm_retry_attempts" type="number" min="0" max="10" step="1" value="${e(s.llm_retry_attempts ?? '10')}">
        <span class="dim">${e(t('settings.llm_retry_attempts_hint'))}</span></label>
      <label>${e(t('settings.llm_retry_base'))} <input name="llm_retry_base_ms" type="number" min="0" step="100" value="${e(s.llm_retry_base_ms ?? '2000')}">
        <span class="dim">${e(t('settings.llm_retry_base_hint'))}</span></label>
      <label>${e(t('settings.llm_retry_max'))} <input name="llm_retry_max_ms" type="number" min="0" step="1000" value="${e(s.llm_retry_max_ms ?? '30000')}">
        <span class="dim">${e(t('settings.llm_retry_max_hint'))}</span></label>
      <label>${e(t('settings.llm_alert_on'))} ${onOff('llm_alert_on', (s.llm_alert_on ?? '1') === '1')}
        <span class="dim">${e(t('settings.llm_alert_hint'))}</span></label>
      <label>${e(t('settings.llm_alert_window'))} <input name="llm_alert_window_min" type="number" min="1" step="1" value="${e(s.llm_alert_window_min ?? '30')}"></label>
      <label>${e(t('settings.llm_alert_max'))} <input name="llm_alert_max_per_hour" type="number" min="1" step="1" value="${e(s.llm_alert_max_per_hour ?? '6')}"></label>
    </fieldset>
    <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
  </form>
  <h3>${e(t('notify.title'))}</h3>
  <p class="dim">${e(t('notify.settings_pointer'))}</p>
  <p><a class="btn" href="/settings/notifications">${e(t('notify.open'))}</a></p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('nav.settings'), '/settings', body))
}

// ---------------- favorites (Settings → Favorites) ----------------
//
// A favorite is the setup half of a run definition under a name (see
// server/favorites.mjs). List and edit page are separate for the same reason the
// agents are: the model/provider/effort block in the run form is ONE block per
// page — hub.js drives it through #prov, #model and #effort — and three of them
// side by side would be three elements sharing one id. So: overview here, and
// one form per favorite on its own page.

export async function pageFavorites(req, res, url) {
  const favs = listFavorites()
  const rows = favs.map(f => `
  <div class="card">
    <h3>${e(f.name)}</h3>
    <p class="dim">${e(favoriteSummary(f))}</p>
    <div class="btn-row"><a class="btn" href="/settings/favorites/edit?id=${f.id}">${e(t('agents.edit'))}</a>
      <form method="post" action="/settings/favorites/delete" class="inline"
            onsubmit="return confirm(${e(JSON.stringify(t('fav.delete_confirm', { name: f.name })))})">
        <input type="hidden" name="id" value="${f.id}"><button class="danger">${e(t('ca.delete'))}</button></form></div>
  </div>`).join('')
  const voll = favs.length >= FAVORITES_MAX
  const body = `
  <h2>${e(t('fav.title'))}</h2>
  <p class="dim">${e(t('fav.intro'))}</p>
  <p class="dim">${e(t('fav.slots', { n: favs.length, max: FAVORITES_MAX }))}</p>
  ${rows || `<p class="dim">${e(t('fav.none'))}</p>`}
  <div class="btn-row">${voll
    ? `<span class="dim">${e(t('fav.full', { max: FAVORITES_MAX }))}</span>`
    : `<a class="btn" href="/settings/favorites/edit">${e(t('fav.create'))}</a>`}
     <a class="btn" href="/settings">${e(t('nav.settings'))}</a></div>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('fav.title'), '/settings', body))
}

export async function favoriteEdit(req, res, url) {
  const id = url.searchParams.get('id')
  const f = id ? getFavorite(+id) : null
  if (id && !f) return void res.writeHead(404).end(t('web.not_found'))
  // A new favorite opens with the setup of the last start — that is almost
  // always the one worth keeping, which is why one is saving it at all.
  const werte = f ?? lastRunChoice()
  const body = `<h2>${e(id ? t('fav.edit_title') : t('fav.create_title'))}</h2>
  <form method="post" action="/settings/favorites/edit${id ? `?id=${id}` : ''}" class="settings form-grid">
    <label>${e(t('fav.name'))} <input name="name" value="${e(f?.name ?? '')}" placeholder="${e(t('fav.name_ph'))}" required></label>
    ${runSetupFields(werte)}
    ${skillFelder(werte.skills)}
    ${flowAttachFields(werte.flows)}
    <div class="btn-row"><button>${e(t('settings.save'))}</button>
      <a class="btn" href="/settings/favorites">${e(t('fav.title'))}</a></div>
  </form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, id ? t('fav.edit_title') : t('fav.create_title'), '/settings', body))
}

export async function favoriteSave(req, res, url, formBody) {
  const id = url.searchParams.get('id')
  const b = await formBody()
  const back = `/settings/favorites/edit${id ? `?id=${id}` : ''}`
  const problems = []
  const fav = await favoriteFromForm(b, problems)
  if (problems.length) return problemPage(req, res, t('fav.title'), problems, back)
  const r = saveFavorite({ id: id ? +id : null, fav })
  if (!r.ok) return problemPage(req, res, t('fav.title'), r.problems, back)
  redirect(res, '/settings/favorites')
}

export async function favoriteDelete(req, res, url, formBody) {
  const b = await formBody()
  deleteFavorite(+b.id)
  redirect(res, '/settings/favorites')
}

// ---------------- merge (Settings → Merge) ----------------
//
// The conflict resolver's setup: which coding agent, provider, model and effort
// the hub starts when a finished run's branch does not merge any more and its
// agent is gone (server/integrate.mjs).
//
// Its own page, like the favorites, and for the same reason: the
// provider/model/effort block is driven by hub.js through #prov, #model and
// #effort, and those ids may exist once per page.
//
// There is no second definition builder behind it. The form block is
// `runSetupFields()` — the one the run form uses — and the way back is
// `runSetupFromForm()`, so what is stored here cannot come to mean something
// else than what the run form would have made of the same inputs.

export async function pageMergeSettings(req, res, url) {
  const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]))
  const werte = {
    harness: s.merge_resolver_harness ?? '',
    provider: s.merge_resolver_provider ?? '',
    or_provider: s.merge_resolver_or_provider ?? '',
    or_routing: s.merge_resolver_or_routing ?? '',
    model: s.merge_resolver_model ?? '',
    effort: s.merge_resolver_effort ?? '',
    skills: s.merge_resolver_skills ?? null,
  }
  const body = `<h2>${e(t('merge.settings_title'))}</h2>
  <p class="dim">${e(t('merge.settings_intro'))}</p>
  ${werte.harness ? '' : `<p class="warn">${e(t('merge.no_resolver_hint'))}</p>`}
  <form method="post" action="/settings/merge" class="settings form-grid">
    ${runSetupFields(werte)}
    ${skillFelder(werte.skills)}
    <label>${e(t('merge.resolver_prompt'))}
      <textarea name="merge_resolver_prompt" rows="8">${e(s.merge_resolver_prompt ?? '')}</textarea>
      <span class="dim">${e(t('merge.resolver_prompt_hint'))}</span></label>
    <div class="btn-row"><button>${e(t('settings.save'))}</button>
      <a class="btn" href="/settings">${e(t('nav.settings'))}</a></div>
  </form>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('merge.settings_title'), '/settings', body))
}

export async function mergeSettingsSave(req, res, url, formBody) {
  const b = await formBody()
  const problems = []
  // An empty coding agent means "no resolver configured" and is a legal state —
  // a conflicting branch is then escalated to the operator directly.
  if (String(b.harness ?? '').trim()) {
    const setup = await runSetupFromForm(b, problems)
    if (problems.length) return problemPage(req, res, t('merge.settings_title'), problems, '/settings/merge')
    setSetting('merge_resolver_harness', setup.harness)
    setSetting('merge_resolver_provider', setup.provider ?? '')
    setSetting('merge_resolver_or_provider', setup.orProvider ?? '')
    setSetting('merge_resolver_or_routing', setup.orRouting ? JSON.stringify(setup.orRouting) : '')
    setSetting('merge_resolver_model', setup.model ?? '')
    setSetting('merge_resolver_effort', setup.effort ?? '')
    setSetting('merge_resolver_skills', skillsAusFormular(b) ?? '')
  } else {
    for (const k of ['harness', 'provider', 'or_provider', 'or_routing', 'model', 'effort', 'skills']) {
      setSetting(`merge_resolver_${k}`, '')
    }
  }
  setSetting('merge_resolver_prompt', String(b.merge_resolver_prompt ?? ''))
  redirect(res, '/settings/merge')
}

/** One line for the settings page: what the resolver is, or that there is none. */
export function mergeSettingsSummary() {
  const harness = db.prepare(`SELECT value FROM settings WHERE key='merge_resolver_harness'`).get()?.value
  if (!harness) return t('merge.not_configured')
  const model = db.prepare(`SELECT value FROM settings WHERE key='merge_resolver_model'`).get()?.value
  return [harnessLabel(harness) || harness, model].filter(Boolean).join(' / ')
}

// ---------------- tmux cleanup (Settings → tmux cleanup) ----------------
//
// The setup for the tmux-cleanup agent: which coding agent runs it (the SAME
// runSetupFields block the run forms use, only styled for a settings page), on
// which threshold (GB) it starts by itself, down to which target (GB) it must
// free, and the prompt. Editing the prompt edits the template; the live values
// are filled in at start time (server/cleanup.mjs).

function cleanupWerte(s) {
  return {
    harness: s.cleanup_harness ?? '',
    provider: s.cleanup_provider ?? '',
    or_provider: s.cleanup_or_provider ?? '',
    or_routing: s.cleanup_or_routing ?? '',
    model: s.cleanup_model ?? '',
    effort: s.cleanup_effort ?? '',
  }
}

export async function pageCleanupSettings(req, res, url) {
  const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]))
  const werte = cleanupWerte(s)
  const repos = db.prepare('SELECT id, name FROM repos WHERE active=1 ORDER BY name').all()
  const repoSel = repos.length
    ? `<label>${e(t('cleanup.repo'))} <select name="cleanup_repo_id">${repos.map(r =>
        `<option value="${r.id}" ${String(s.cleanup_repo_id ?? repos[0].id) === String(r.id) ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select>
      <span class="dim">${e(t('cleanup.repo_hint'))}</span></label>`
    : ''
  const body = `<h2>${e(t('cleanup.settings_title'))}</h2>
  <p class="dim">${e(t('cleanup.settings_intro'))}</p>
  ${werte.harness ? '' : `<p class="warn">${e(t('cleanup.no_agent'))}</p>`}
  <form method="post" action="/settings/cleanup" class="settings form-grid">
    <label>${e(t('cleanup.on'))} <select name="cleanup_on">
      <option value="1" ${s.cleanup_on === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option>
      <option value="0" ${s.cleanup_on !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option>
    </select>
      <span class="dim">${e(t('cleanup.on_hint'))}</span></label>
    ${runSetupFields(werte, { wrapClass: 'cleanup-setup' })}
    <label>${e(t('cleanup.threshold'))} <input name="cleanup_threshold_gb" type="number" min="0" step="0.5" value="${e(String(cleanupSettings().thresholdGb))}">
      <span class="dim">${e(t('cleanup.threshold_hint'))}</span></label>
    <label>${e(t('cleanup.target'))} <input name="cleanup_target_gb" type="number" min="0" step="0.5" value="${e(String(cleanupSettings().targetGb))}">
      <span class="dim">${e(t('cleanup.target_hint'))}</span></label>
    <label>${e(t('cleanup.cooldown'))} <input name="cleanup_cooldown_min" type="number" min="0" step="5" value="${e(String(cleanupSettings().cooldownMin))}">
      <span class="dim">${e(t('cleanup.cooldown_hint'))}</span></label>
    ${repoSel}
    <label>${e(t('cleanup.prompt'))}
      <textarea name="cleanup_prompt" rows="12">${e(s.cleanup_prompt ?? '')}</textarea>
      <span class="dim">${e(t('cleanup.prompt_hint'))}</span></label>
    <div class="btn-row"><button>${e(t('settings.save'))}</button>
      <a class="btn" href="/settings">${e(t('nav.settings'))}</a></div>
  </form>
  ${cleanupRunInFlight() ? `<p class="dim">${e(t('cleanup.running_note'))}</p>` : ''}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('cleanup.settings_title'), '/settings', body))
}

export async function cleanupSettingsSave(req, res, url, formBody) {
  const b = await formBody()
  const problems = []
  if (String(b.harness ?? '').trim()) {
    const setup = await runSetupFromForm(b, problems)
    if (problems.length) return problemPage(req, res, t('cleanup.settings_title'), problems, '/settings/cleanup')
    setSetting('cleanup_harness', setup.harness)
    setSetting('cleanup_provider', setup.provider ?? '')
    setSetting('cleanup_or_provider', setup.orProvider ?? '')
    setSetting('cleanup_or_routing', setup.orRouting ? JSON.stringify(setup.orRouting) : '')
    setSetting('cleanup_model', setup.model ?? '')
    setSetting('cleanup_effort', setup.effort ?? '')
  } else {
    for (const k of ['harness', 'provider', 'or_provider', 'or_routing', 'model', 'effort']) {
      setSetting(`cleanup_${k}`, '')
    }
  }
  setSetting('cleanup_on', b.cleanup_on === '1' ? '1' : '0')
  const zahlen = { cleanup_threshold_gb: 5, cleanup_target_gb: 2, cleanup_cooldown_min: 60 }
  for (const [k, fallback] of Object.entries(zahlen)) {
    const n = Number(b[k])
    setSetting(k, String(Number.isFinite(n) && n >= 0 ? n : fallback))
  }
  if (b.cleanup_repo_id) setSetting('cleanup_repo_id', String(b.cleanup_repo_id))
  setSetting('cleanup_prompt', String(b.cleanup_prompt ?? ''))
  redirect(res, '/settings/cleanup')
}

// ---------------------------------------------------------------------------
// Settings → Freilauf skills
//
// Its own page rather than a fieldset in the big form, and for the reason the
// big form's own comment gives: `/settings/save` writes settings and nothing
// else, while switching this one off DELETES FILES. A handler that owns the
// whole request is what can act on the transition — and it is also what makes
// "install now" and "remove now" one code path with the state it re-establishes.

// Where a wish about this feature goes. Named once and shared with the Welcome
// wizard, which says the same thing to somebody seeing it for the first time.
export const FREILAUF_ISSUES_URL = 'https://github.com/hwalde/freilauf/issues'

/** The paragraph that answers "where do these end up, and can I scope them?" */
export function skillScopeNote() {
  return `<p class="dim">${e(t('flskills.user_level'))}
    <a href="${e(FREILAUF_ISSUES_URL)}" target="_blank" rel="noreferrer noopener">${e(FREILAUF_ISSUES_URL)}</a></p>`
}

/**
 * One row per skill this build ships — what the operator is being offered.
 *
 * A `shared` skill is left OUT: it is a reference the other skills load, not
 * something anybody picks, and a list that offers a thing nobody chooses is a
 * list with noise in it. It is still installed, so the count of directories
 * further down is one higher than this list is long — hence the footnote, which
 * says so without naming it.
 *
 * Descriptions are printed IN FULL. They are long, because their job is to make
 * an agent's matcher fire; cutting them at 240 characters ended sentences
 * mid-word and read as a rendering fault.
 */
function skillCatalogList(installOn) {
  const all = availableSkills()
  const skills = all.filter(s => s.role !== 'shared')
  if (!skills.length) return `<p class="dim">${e(t('flskills.none_shipped'))}</p>`
  const shared = all.length - skills.length
  // Absent = all of them, which is what an installation that said yes before
  // this setting existed has on disk. Only a save from this form writes a list.
  const want = selectedSkillNames()
  const on = (name) => want === null || want.includes(name)
  // Same rule as the update switch: while the installation is off these are
  // switches about nothing, so they are hidden AND disabled — a hidden field
  // that still submits would rewrite the selection nobody could see.
  const off = installOn ? '' : ' disabled'
  return `<ul class="skill-list" id="skills-pick"${installOn ? '' : ' hidden'}>${skills.map(s => `<li>
      <label class="chk"><input type="checkbox" name="skills_selected" value="${e(s.name)}" ${on(s.name) ? 'checked' : ''}${off}>
      <b>${e(s.title)}</b></label>
      ${s.description ? `<div class="dim">${e(s.description)}</div>` : ''}</li>`).join('')}</ul>
    ${installOn ? '' : `<ul class="skill-list">${skills.map(s =>
      `<li><b>${e(s.title)}</b>${s.description ? ` — <span class="dim">${e(s.description)}</span>` : ''}</li>`).join('')}</ul>`}
    ${shared ? `<p class="dim">${e(t('flskills.shared_note', { n: shared }))}</p>` : ''}`
}

/** Which directories this installation writes to, and whom each of them serves. */
function skillTargetList() {
  const roots = harnessSkillRoots()
  const { targets, skipped } = skillTargets(roots)
  const off = roots.filter(r => !r.enabled)
  const rows = targets.length
    ? `<ul class="skill-list">${targets.map(tg =>
        `<li><code>${e(tg.dir)}</code>${rootExists(tg.dir) ? '' : ` <span class="dim">${e(t('flskills.will_create'))}</span>`}
          <br><span class="dim">${e(t('flskills.serves', { agents: tg.harnesses.map(id => harnessLabel(id)).join(', ') }))}</span></li>`).join('')}</ul>`
    : `<p class="warn">${e(t('flskills.no_targets'))}</p>`
  const skippedNote = skipped.length
    ? `<p class="dim">${e(t('flskills.skipped', { agents: skipped.map(x => x.label).join(', ') }))}</p>` : ''
  const offNote = off.length
    ? `<p class="dim">${e(t('flskills.not_configured', { agents: off.map(x => x.label).join(', ') }))}</p>` : ''
  return `${rows}${skippedNote}${offNote}`
}

/** Where the project-level directories are — declared, never written to by the hub. */
function skillProjectList() {
  const roots = harnessSkillRoots().filter(r => r.project.length)
  if (!roots.length) return ''
  return `<details><summary>${e(t('flskills.project_legend'))}</summary>
    <p class="dim">${e(t('flskills.project_hint'))}</p>
    <ul class="skill-list">${roots.map(r =>
      `<li><b>${e(r.label)}</b> — ${r.project.map(p => `<code>${e(p)}</code>`).join(', ')}</li>`).join('')}</ul></details>`
}

/**
 * What the hub cannot write, and why. Recomputed per render, so a directory
 * cleared by hand stops being listed on the next reload — a warning that
 * outlives its cause is a warning people learn to scroll past.
 */
function skillConflictList() {
  const conflicts = skillConflicts()
  if (!conflicts.length) return ''
  return `<p class="warn">${e(t('flskills.conflicts'))}</p>
    <ul class="skill-list">${conflicts.map(c => `<li><code>${e(c.dir)}</code></li>`).join('')}</ul>`
}

/**
 * Copies another Freilauf on this machine wrote — a question, not a warning.
 *
 * Overwriting them would also overwrite the coordinates THAT installation's
 * skills read, and the two hubs would take the directory from each other for
 * ever. So the operator answers it: either those copies belong to the other
 * installation and should be left alone, or this is the same installation
 * wearing a new data directory and the configuration should be brought up to
 * date. The second is one button.
 */
function skillForeignBlock() {
  const fremd = foreignCopies()
  if (!fremd.length) return ''
  const wo = [...new Set(fremd.map(f => f.installation.id))]
  return `<p class="warn">${e(t('flskills.foreign', { n: fremd.length, where: wo.join(', ') }))}</p>
    <ul class="skill-list">${fremd.map(f => `<li><code>${e(f.dir)}</code></li>`).join('')}</ul>
    <form method="post" action="/settings/skills/sync" class="inline">
      <input type="hidden" name="adopt" value="1">
      <button class="ghost">${e(t('flskills.foreign_adopt'))}</button>
    </form>
    <p class="dim">${e(t('flskills.foreign_leave'))}</p>`
}

/** What is on disk right now, per directory. */
function skillInstalledList() {
  const installed = installedOverview()
  if (!installed.length) return `<p class="dim">${e(t('flskills.nothing_installed'))}</p>`
  return `<ul class="skill-list">${installed.map(root =>
    `<li><code>${e(root.dir)}</code><br><span class="dim">${root.skills.map(sk =>
      `${e(sk.name)}${sk.current ? '' : ` (${e(t('flskills.outdated'))})`}`).join(', ')}</span></li>`).join('')}</ul>`
}

/**
 * The confirmation the operator sees before the files go. Rendered server-side
 * — the dialog carries its own translated text, so nothing has to travel as a
 * `js.*` key, which is the same rule the cleanup dialog follows.
 */
function skillRemoveDialog() {
  const plan = removalPlan()
  const list = plan.length
    ? `<ul class="skill-list">${plan.map(p =>
        `<li><code>${e(p.dir)}</code>${p.owned ? '' : ` <span class="dim">${e(t('flskills.remove_foreign'))}</span>`}</li>`).join('')}</ul>`
    : `<p class="dim">${e(t('flskills.nothing_installed'))}</p>`
  return `<dialog id="skills-remove-dialog" class="qr cleanup">
    <h3>${e(t('flskills.remove_title'))} <button type="button" class="mini" data-skills-close aria-label="${e(t('qr.cancel'))}">✕</button></h3>
    <p>${e(t('flskills.remove_body'))}</p>
    ${list}
    <menu class="qr-actions">
      <button type="button" class="ghost" data-skills-close>${e(t('qr.cancel'))}</button>
      <button type="button" id="skills-remove-confirm">${e(t('flskills.remove_confirm'))}</button>
    </menu>
  </dialog>`
}

/**
 * "Keep them up to date" — only there while the installation is on, because
 * without an installation it is a switch about nothing.
 *
 * Both inputs carry `disabled` while it is hidden, and that is the rule this
 * project already learned once on the goal field: a hidden field that still
 * submits is a value nobody can see or correct. Here the consequence is
 * specific — `checkbox()`'s hidden `0` companion would post
 * `skills_auto_update=0` every time the operator saved with the installation
 * off, quietly overwriting a preference they had left ON. Disabled, neither
 * input travels, `Object.hasOwn(b, …)` is false, and the stored value survives
 * untouched until the row is real again.
 *
 * hub.js flips both the `hidden` and the two `disabled` on the install
 * checkbox's own change event, so it appears and disappears without a save.
 */
function autoUpdateRow(installOn) {
  const on = skillsAutoUpdate()
  const off = installOn ? '' : ' disabled'
  // Updating is ALREADY paused for a foreign copy — `syncSkills()` checks the
  // installation id before it ever compares content, so it structurally cannot
  // run over one. What was missing is saying so: a switch that reads "on" while
  // some directories are deliberately untouched is a switch that lies.
  const paused = installOn && on && foreignCopies().length
    ? `<p class="warn">${e(t('flskills.update_paused'))}</p>` : ''
  return `${paused}<div id="skills-auto"${installOn ? '' : ' hidden'}>
    <input type="hidden" name="skills_auto_update" value="0"${off}>
    <label class="chk"><input type="checkbox" name="skills_auto_update" value="1" ${on ? 'checked' : ''}${off}>
      ${e(t('flskills.auto'))} <span class="dim">${e(t('flskills.auto_hint'))}</span></label>
  </div>`
}

export async function pageSkillSettings(req, res, url) {
  const on = skillsInstallOn()
  const report = url?.searchParams?.get('synced') === '1'
  const body = `<h2>${e(t('flskills.title'))}</h2>
  <p class="dim">${e(t('flskills.intro'))}</p>
  <p class="dim">${e(t('flskills.intro2'))}</p>
  ${skillScopeNote()}
  ${report ? `<p class="card ok">${e(t('flskills.synced'))}</p>` : ''}
  <form method="post" action="/settings/skills" class="settings form-grid" id="skills-form" data-was-on="${on ? '1' : '0'}">
    <fieldset><legend>${e(t('flskills.switches_legend'))}</legend>
      ${checkbox('skills_install', on, t('flskills.install'), ` <span class="dim">${e(t('flskills.install_hint'))}</span>`)}
    </fieldset>
    <fieldset><legend>${e(t('flskills.catalog_legend'))}</legend>
      ${on ? '<input type="hidden" name="skills_pick" value="1">' : ''}
      <p class="dim">${e(t(on ? 'flskills.pick_hint' : 'flskills.pick_off'))}</p>
      ${skillCatalogList(on)}
    </fieldset>
    <fieldset><legend>${e(t('flskills.update_legend'))}</legend>
      ${autoUpdateRow(on)}
    </fieldset>
    <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
  </form>
  <h3>${e(t('flskills.targets_legend'))}</h3>
  <p class="dim">${e(t('flskills.targets_hint'))}</p>
  ${skillTargetList()}
  ${skillProjectList()}
  <h3>${e(t('flskills.installed_legend'))}</h3>
  ${skillInstalledList()}
  ${skillForeignBlock()}
  ${skillConflictList()}
  <form method="post" action="/settings/skills/sync" class="inline">
    <button class="ghost">${e(t('flskills.sync_now'))}</button>
  </form>
  ${skillRemoveDialog()}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('flskills.title'), '/settings', body))
}

export async function skillSettingsSave(req, res, url, formBody) {
  const b = await formBody()
  // The hidden `0` companion is what makes an unticked box distinguishable from
  // a field the request never carried — see the settingsSave() comment.
  if (Object.hasOwn(b, 'skills_install')) setSetting('skills_install', b.skills_install === '1' ? '1' : '0')
  if (Object.hasOwn(b, 'skills_auto_update')) setSetting('skills_auto_update', b.skills_auto_update === '1' ? '1' : '0')
  // The selection travels as repeated checkboxes, so parseForm hands it over as
  // `skills_selected_list`. A ticked box is present and an unticked one is
  // simply absent — which is why the marker below is what tells "none selected"
  // from "this form did not carry the block at all". Without it, saving with
  // the installation off (where the boxes are disabled) would wipe the
  // selection nobody could see.
  if (b.skills_pick === '1') {
    const picked = b.skills_selected_list ?? (b.skills_selected ? [b.skills_selected] : [])
    const known = new Set(availableSkills().filter(s => s.role !== 'shared').map(s => s.name))
    setSetting('skills_selected', JSON.stringify([...new Set(picked.filter(n => known.has(n)))]))
  }
  // Saving IS the action: switching on installs, switching off removes. A
  // setting that describes the file system and then waits for a separate button
  // is a setting that lies until somebody presses it.
  syncSkills({ force: true })
  redirect(res, '/settings/skills?synced=1')
}

export async function skillSettingsSync(req, res, url, formBody) {
  const b = await formBody()
  // `adopt` is the answer to the question above: take over the copies another
  // installation wrote and put our own coordinates in them. Deliberately an
  // explicit act — a sync that adopted by itself would be the silent takeover
  // the whole check exists to prevent.
  syncSkills({ force: true, adopt: b.adopt === '1' })
  redirect(res, '/settings/skills?synced=1')
}

/** One line for the settings page: what the cleanup agent is, or that there is none. */
export function cleanupSettingsSummary() {
  const s = cleanupSettings()
  if (!s.harness) return t('cleanup.not_configured')
  const model = s.model ? `/${s.model}` : ''
  return `${s.on ? t('layout.on') : t('layout.off')} · ${s.thresholdGb} GB → ${s.targetGb} GB · ${harnessLabel(s.harness) || s.harness}${model}`
}

// ---------------- the model providers of one coding agent ----------------
//
// ONE renderer, exported, called by the Plugins page and by the coding-agent
// form below. It used to be two copies of the same eight lines, and they had
// already drifted: one printed a hint next to a provider, the other did not, so
// the same DeepSeek was described in two different ways depending on which page
// one had reached it from. Same rule as the fragments — a block a user can meet
// twice has exactly one function behind it.

/**
 * Can this provider be used with no credential at all?
 *
 * Deliberately an EXPLICIT `required: false` on every declared credential, not
 * the absence of `required`: `credentialSpec()` normalises a provider that
 * predates the field to `required: false`, and reading that as "optional" would
 * promise free models where there are none. OpenCode Zen says it outright, and
 * that is what this answers to.
 */
function credentialOptional(providerId) {
  const declared = getProvider(providerId)?.credentials
  return Array.isArray(declared) && declared.length > 0
    && declared.every(c => c && c.required === false)
}

/**
 * One sentence per provider: is there a credential for it, and whose?
 *
 * The page used to print "works without an own key" here, off a hard-coded list
 * on the coding-agent plugin — a guess about somebody else's configuration, and
 * one that reads like a fault report. The order below is what makes it an
 * answer instead:
 *
 *  1. the coding agent's OWN credential store, when the plugin can be asked
 *     (`ownCredentials`) — that is the fact the operator cannot see from here;
 *  2. a credential Freilauf holds, environment variable or stored value alike;
 *  3. the coding agent's declared key-free access — the fallback for when 1
 *     could not be established, and the place where "only the free models" is
 *     the honest half of the sentence;
 *  4. nothing, which is worth saying plainly: this provider will not work.
 */
function providerAccess(plugin, providerId, own) {
  const agent = plugin.label
  if (own && own.includes(providerId)) return t('provider.access_agent_key', { agent })
  if (pluginHasCredential(providerId)) return t('provider.access_hub_key', { agent })
  if ((plugin.keyFreeProviders ?? []).includes(providerId)) {
    return credentialOptional(providerId)
      ? t('provider.access_free_models', { agent })
      : t('provider.access_agent_free', { agent })
  }
  return t('provider.access_missing', { agent })
}

/**
 * The inside of the "allowed model providers" fieldset: the explanation, what
 * the coding agent brings by itself, and one checkbox per provider carrying the
 * sentence above.
 *
 * Async because asking a coding agent what it holds may touch the machine; the
 * probe is cached in models.mjs and fails soft to "unknown", so a card is never
 * held up by it.
 */
export async function providerChoiceBlock(plugin, chosen, { name = 'providers' } = {}) {
  if (plugin.subscription || !(plugin.providers ?? []).length) {
    return `<p class="dim">${e(t('plugins.no_providers'))}</p>`
  }
  let own = null
  try { own = await harnessOwnCredentials(plugin.id) } catch { own = null }
  // What the coding agent contributes, said once instead of implied per row.
  // hermes brings nothing and used to say nothing, which left the reader of an
  // opencode card wondering what the difference was meant to be.
  const brings = own !== null
    ? `<p class="dim">${e(t('plugins.providers_agent_own', { agent: plugin.label }))}</p>`
    : (plugin.keyFreeProviders ?? []).length === 0
      ? `<p class="dim">${e(t('plugins.providers_agent_none', { agent: plugin.label }))}</p>`
      : ''
  const boxes = plugin.providers.map(pid => `<label class="chk">
    <input type="checkbox" name="${e(name)}" value="${e(pid)}" ${chosen.has(pid) ? 'checked' : ''}>
    ${e(providerLabel(pid))} <span class="dim">— ${e(providerAccess(plugin, pid, own))}</span></label>`).join('')
  return `<p class="dim">${e(t('plugins.providers_hint'))}</p>${brings}${boxes}`
}

export async function codingAgentSave(req, res, url, formBody) {
  const b = await formBody()
  const r = saveCodingAgent({
    harness: String(b.harness ?? ''),
    enabled: b.enabled === '1' || b.enabled === 'on' ? 1 : 0,
    providers: b.providers_list ?? (b.providers ? [b.providers] : []),
  })
  if (!r.ok) return problemPage(req, res, t('ca.title'), r.problems, '/settings/coding-agents')
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

export async function runNewPost(req, res, url, formBody) {
  const b = await formBody()
  const back = `/runs/new?repo=${b.repo_id ?? ''}`
  const problems = []
  const def = await runDefFromForm(b, problems)
  const start = runStartFromForm(b, problems)
  if (problems.length) return problemPage(req, res, t('runform.title_short'), problems, back)
  rememberRunChoice(def)
  // "Save as agent": the very same definition, only with a name — the run form
  // is the agent form without one.
  if (b.save_agent === 'on' || b.save_agent === '1') {
    try {
      saveAgent({ repoId: +b.repo_id, name: b.agent_name?.trim() || `agent-${Date.now()}`, def })
    } catch { /* duplicate name: the run is what matters, not the copy */ }
  }
  const r = await startRun(def, { repoId: +b.repo_id, ...start })
  if (!r.runId) return problemPage(req, res, t('runform.title_short'), [r.error ?? t('run.start_failed')], back)
  redirect(res, `/runs/${r.runId}`)
}

/**
 * Schedule selection: four kinds of which only the fitting one is visible
 * (switching lives in hub.js). Cron stays as an expert field — the other three
 * kinds cover what 5-field cron cannot express (n-weekly, one-off date).
 */
/**
 * One editable list of times: a chip per time, plus the button that adds one.
 * `min1` keeps the last chip's delete button away — the "same times" list may
 * not become empty, a weekday's list may (that is how a day is switched off).
 */
function timeList(name, times, { min1 = false } = {}) {
  const chips = times.map(v => `
    <span class="time-chip"><input type="time" name="${e(name)}" value="${e(v)}" required>
      <button type="button" class="time-del" title="${e(t('sched.remove_time'))}" aria-label="${e(t('sched.remove_time'))}">×</button></span>`).join('')
  return `<div class="times" data-time-name="${e(name)}" data-min1="${min1 ? '1' : '0'}"
      data-del-title="${e(t('sched.remove_time'))}">
    ${chips}<button type="button" class="time-add">+ ${e(t('sched.add_time'))}</button>
  </div>`
}

function scheduleFields(a = {}) {
  const kind = a.schedule_kind ?? 'manuell'
  const heute = new Date().toISOString().slice(0, 10)
  // Both storages arrive as one shape, so the form does not have to know which
  // one the agent carries — only which MODE the operator last chose, and that
  // is exactly what a filled schedule_slots says.
  const slots = weeklySlots(a)
  const mode = a.schedule_slots ? 'per_day' : 'same'
  const days = slots.map(s => s.day)
  const sharedTimes = slots.length && slotsUniform(slots) ? slots[0].times : (slots[0]?.times ?? ['06:00'])
  const arten = [
    ['manuell', t('sched.kind_manual')],
    ['woechentlich', t('sched.kind_weekly')],
    ['einmalig', t('sched.kind_once')],
    ['cron', t('sched.kind_cron')],
  ]
  const modes = [['same', t('sched.mode_same')], ['per_day', t('sched.mode_per_day')]]
  return `
  <fieldset class="schedule">
    <legend>${e(t('sched.legend'))}</legend>
    <label>${e(t('sched.kind'))} <select name="schedule_kind" id="schedule-kind">
      ${arten.map(([v, txt]) => `<option value="${v}" ${kind === v ? 'selected' : ''}>${e(txt)}</option>`).join('')}
    </select></label>

    <div class="zp" data-kind="woechentlich">
      <div class="sched-modes" role="radiogroup" aria-label="${e(t('sched.mode_legend'))}">
        ${modes.map(([v, txt]) => `<label class="chk mode"><input type="radio" name="schedule_mode" value="${v}"
          ${mode === v ? 'checked' : ''}> ${e(txt)}</label>`).join('')}
      </div>

      <div class="zpm" data-mode="same">
        <div class="weekdays">${WOCHENTAGE.map(w => `
          <label class="weekday"><input type="checkbox" name="schedule_days" value="${w.n}"
            ${days.includes(w.n) ? 'checked' : ''}> ${e(t(w.key))}</label>`).join('')}
        </div>
        <label class="times-label">${e(t('sched.time'))}
          ${timeList('schedule_time', sharedTimes, { min1: true })}</label>
      </div>

      <div class="zpm" data-mode="per_day">
        <div class="day-times">${WOCHENTAGE.map(w => `
          <div class="day-row">
            <span class="day-name">${e(t(w.key))}</span>
            ${timeList(`schedule_day_time_${w.n}`, slots.find(s => s.day === w.n)?.times ?? [])}
          </div>`).join('')}
        </div>
        <p class="dim">${e(t('sched.per_day_hint'))}</p>
      </div>

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
  ${runDefFields(a, branchContext(repoId))}
  <input type="hidden" name="repo_id" value="${repoId}">
  ${scheduleFields(a)}
  <label class="chk"><input type="checkbox" name="active" value="1" ${a.active ?? 1 ? 'checked' : ''}> ${e(t('agents.active'))}</label>`
}

export async function agentEdit(req, res, url) {
  const id = url.searchParams.get('id')
  // A new agent starts from the setup of the last start, an existing one from
  // what is saved. An EXISTING agent is edited in the repo it lives in: its own
  // repo_id is the truth, not a query parameter — moving happens on the move
  // page (with the name-collision handling), not by editing the hidden field.
  const a = id ? db.prepare('SELECT * FROM agents WHERE id=?').get(+id) : lastRunChoice()
  const repoId = id
    ? a.repo_id
    : +(url.searchParams.get('repo') ?? cookieRepo(req) ?? db.prepare('SELECT id FROM repos WHERE active=1 ORDER BY name LIMIT 1').get()?.id ?? 0)
  // The destructive actions belong ON this page — the agent's detail page —
  // never in the overview. Delete is a separate form that requires the confirm
  // dialog; move goes to its own page because a collision needs a date-time
  // suffix. A new agent has nothing to delete or move.
  const danger = id ? `
  <div class="btn-row">
    <a class="btn ghost" href="/agents/move?id=${id}&repo=${repoId}">${e(t('agents.move'))}</a>
    <form method="post" action="/agents/delete" class="inline" onsubmit="return confirm(${e(JSON.stringify(t('agents.delete_confirm', { name: a.name })))})"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${repoId}"><button class="danger">${e(t('agents.delete'))}</button></form>
  </div>` : ''
  const body = `<h2>${e(id ? t('agentform.title_edit') : t('agentform.title_new'))}</h2>
  <form method="post" action="/agents/edit${id ? `?id=${id}` : ''}" class="settings form-grid">${agentFields(a, repoId)}
    <div class="btn-row"><button>${e(t('settings.save'))}</button></div></form>${danger}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, id ? t('agentform.title_edit') : t('agentform.title_new'), '/agents', body, repoId))
}

export async function agentSave(req, res, url, formBody) {
  const id = url.searchParams.get('id')
  const b = await formBody()
  // A checkbox that is not ticked is simply absent from the body, so ABSENT is
  // what "off" means here — the form carries no hidden `0` companion. But the
  // string `'0'` is truthy in JavaScript, so a caller that spells the off state
  // out (`active=0`, which is what anybody scripting this route writes) used to
  // switch the agent ON. Same family as the `Number('')` entry in AGENTS.md:
  // a value that arrives as a string has to be compared, never coerced.
  const active = b.active === '1' || b.active === 'on' || b.active === 'true' ? 1 : 0
  const back = `/agents/edit${id ? `?id=${id}&repo=${b.repo_id ?? ''}` : `?repo=${b.repo_id ?? ''}`}`
  const problems = []
  const name = (b.name ?? '').trim()
  if (!name) problems.push(t('form.name_missing'))
  // Names are unique per REPO — a duplicate is a readable form problem, not a
  // SQLite constraint that surfaces as a 500. The other repo is free to carry
  // the same name, which is what the move feature relies on.
  else if (agentNameTaken(+b.repo_id, name, id ? +id : null)) problems.push(t('agents.name_taken', { name }))
  const def = await runDefFromForm(b, problems)
  const zp = scheduleFromForm(b, problems)
  if (problems.length) return problemPage(req, res, t('agentform.title_edit'), problems, back)

  saveAgent({ id: id ? +id : null, repoId: +b.repo_id, name, def, schedule: zp, active })
  rememberRunChoice(def)
  redirect(res, `/agents?repo=${b.repo_id}`)
}

/**
 * Delete an agent — the row on the agents page with a confirmation. The runs
 * survive (deleteAgent only cuts the reference; the run keeps its own copy of
 * the definition and title), so an agent can be retired without its history
 * disappearing from the overview.
 */
export async function agentDelete(req, res, url, formBody) {
  const b = await formBody()
  const agent = db.prepare('SELECT repo_id FROM agents WHERE id=?').get(+b.id)
  if (!agent) { res.writeHead(404).end(t('agents.not_found')); return }
  deleteAgent(+b.id)
  redirect(res, `/agents?repo=${agent.repo_id}`)
}

/** Move page: choose the target repo. The name collision handling lives in moveAgent. */
export async function agentMovePage(req, res, url) {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(+url.searchParams.get('id'))
  if (!agent) { res.writeHead(404).end(t('agents.not_found')); return }
  // A deactivated repo is not a move target.
  const repos = db.prepare('SELECT id,name FROM repos WHERE active=1 ORDER BY name').all()
  const body = `
  <h2>${e(t('agents.move_title', { name: agent.name }))}</h2>
  <form method="post" action="/agents/move" class="settings form-grid">
    <input type="hidden" name="id" value="${agent.id}">
    <label>${e(t('agents.move_repo'))} <select name="repo">
      ${repos.map(r => `<option value="${r.id}" ${r.id === agent.repo_id ? 'selected' : ''}>${e(r.name)}</option>`).join('')}
    </select></label>
    <div class="btn-row"><button>${e(t('agents.move'))}</button></div>
  </form>
  <p class="dim">${e(t('agents.move_hint'))}</p>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('agents.move_title', { name: agent.name }), '/agents', body, agent.repo_id))
}

export async function agentMovePost(req, res, url, formBody) {
  const b = await formBody()
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(+b.id)
  const sourceRepo = agent?.repo_id ?? ''
  const r = moveAgent(+b.id, +b.repo)
  if (!r.ok) {
    return problemPage(req, res, t('agents.move_title', { name: agent?.name ?? '' }), [r.error], `/agents?repo=${sourceRepo}`)
  }
  // Back to the repo the operator was looking at — the source, where the agent
  // just disappeared from; the target repo shows it under its (possibly
  // suffixed) new name.
  redirect(res, `/agents?repo=${sourceRepo}`)
}

/**
 * The times of one form field, with a complaint about anything that is neither
 * a time nor empty. An emptied input IS the gesture "this time is gone" — but a
 * half-typed one must not be swallowed, or a schedule would silently be a
 * different schedule than the one that was submitted.
 */
function timesFromField(b, name, problems) {
  const raw = (b[`${name}_list`] ?? (b[name] === undefined ? [] : [b[name]])).map(x => String(x ?? '').trim())
  const good = splitTimes(raw)
  if (raw.some(x => x !== '' && !good.includes(x))) problems.push(t('sched.err_time'))
  return good
}

/**
 * Read and validate the schedule from the form. Only the fields of the chosen
 * kind are taken over — otherwise old leftovers would survive a switch and the
 * agent would keep running after a change to "manual". The same is true one
 * level down for the weekly kind's two modes: exactly one of them is stored, so
 * the times of the other cannot come back to life on the next save.
 */
function scheduleFromForm(b, problems) {
  const empty = { ...EMPTY_SCHEDULE }
  switch (b.schedule_kind) {
    case 'woechentlich': {
      const weeks = Number(b.schedule_weeks) || 1
      if (![1, 2, 3, 4].includes(weeks)) problems.push(t('sched.err_weeks'))
      if (weeks > 1 && !/^\d{4}-\d{2}-\d{2}$/.test(b.schedule_anchor ?? '')) {
        problems.push(t('sched.err_anchor'))
      }
      const cadence = { weeks, anchor: weeks > 1 ? b.schedule_anchor : null }

      // Different times per weekday. Two spellings, one validator: the form's
      // one field per day, and a ready-made `schedule_slots` JSON for whoever
      // writes this over the API instead of through the browser.
      if (b.schedule_mode === 'per_day' || (b.schedule_slots && b.schedule_mode === undefined)) {
        const slots = {}
        if (b.schedule_slots) {
          let obj = null
          try { obj = JSON.parse(b.schedule_slots) } catch { /* reported below */ }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) problems.push(t('sched.err_slots'))
          for (const [key, times] of Object.entries(obj ?? {})) {
            const n = Number(key)
            if (!Number.isInteger(n) || n < 0 || n > 6) { problems.push(t('sched.err_slots')); continue }
            const list = splitTimes(times)
            if (list.length) slots[n] = list
          }
        } else {
          for (const w of WOCHENTAGE) {
            const list = timesFromField(b, `schedule_day_time_${w.n}`, problems)
            if (list.length) slots[w.n] = list
          }
        }
        const withTimes = Object.keys(slots).map(Number)
        if (!withTimes.length) problems.push(t('sched.err_day_times'))
        // schedule_days stays filled with the days that have times: it is what
        // "which days does this agent run on" is read from everywhere outside
        // weeklySlots(), and a NULL there would read as "none".
        return { ...empty, kind: 'woechentlich', ...cadence,
          days: withTimes.sort((x, y) => x - y).join(','), time: null, slots: JSON.stringify(slots) }
      }

      // Several same-named checkboxes: the URLSearchParams collector in
      // web-helpers keeps only the last value — hence the days arrive as a list.
      const days = (b.schedule_days_list ?? []).map(Number).filter(n => n >= 0 && n <= 6)
      if (!days.length) problems.push(t('sched.err_days'))
      const times = timesFromField(b, 'schedule_time', problems)
      if (!times.length) problems.push(t('sched.err_time'))
      return { ...empty, kind: 'woechentlich', ...cadence,
        days: [...new Set(days)].sort((x, y) => x - y).join(','), time: times.join(','), slots: null }
    }
    case 'einmalig': {
      const at = (b.run_at ?? '').trim()
      if (!at || Number.isNaN(new Date(at).getTime())) problems.push(t('sched.err_at'))
      return { ...empty, kind: 'einmalig', run_at: at }
    }
    case 'cron': {
      const c = (b.schedule ?? '').trim()
      if (!c) problems.push(t('sched.err_cron_missing'))
      else if (!validCron(c)) problems.push(t('sched.err_cron', { expr: c }))
      return { ...empty, kind: 'cron', schedule: c }
    }
    default:
      return empty
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

/**
 * The Integration block of the repo form (server/integrate.mjs).
 *
 * `merge_mode='off'` is the default and means exactly the behaviour that existed
 * before this block did: the run ends when the agent reports done, and nothing
 * is merged. Everything below it only matters in 'hub' mode.
 *
 * `notify_running` is a CHECKBOX and therefore carries a hidden companion field
 * with its "0": an unchecked box is simply absent from the body, and "off" would
 * otherwise read as "not mentioned".
 */
function integrationFields(r = {}) {
  const num = (name, value, min, hint) => `
    <label>${e(t(`repos.${name}`))} <input type="number" name="${name}" min="${min}" value="${e(String(value))}">
      <span class="dim">${e(t(hint))}</span></label>`
  const mode = r.merge_mode === 'hub' ? 'hub' : 'off'
  return `
  <fieldset class="schedule">
    <legend>${e(t('repos.integration_legend'))}</legend>
    <label>${e(t('repos.merge_mode'))} <select name="merge_mode">
      <option value="off" ${mode === 'off' ? 'selected' : ''}>${e(t('merge.mode_off'))}</option>
      <option value="hub" ${mode === 'hub' ? 'selected' : ''}>${e(t('merge.mode_hub'))}</option>
    </select>
      <span class="dim">${e(t('repos.merge_mode_hint'))}</span></label>
    <label>${e(t('repos.merge_check'))} <input name="merge_check" value="${e(r.merge_check ?? '')}" placeholder="node test/unit.mjs">
      <span class="dim">${e(t('repos.merge_check_hint'))}</span></label>
    ${num('finish_timeout_min', r.finish_timeout_min ?? 15, 1, 'repos.finish_timeout_hint')}
    ${num('merge_max_attempts', r.merge_max_attempts ?? 2, 0, 'repos.merge_max_attempts_hint')}
    ${num('conflict_parallel', r.conflict_parallel ?? 1, 1, 'repos.conflict_parallel_hint')}
    <input type="hidden" name="notify_running" value="0">
    <label class="chk"><input type="checkbox" name="notify_running" value="1" ${(r.notify_running ?? 1) ? 'checked' : ''}>
      ${e(t('repos.notify_running'))}</label>
    <p class="dim">${e(t('repos.notify_running_hint'))}</p>
    ${num('max_parallel', r.max_parallel ?? 0, 0, 'repos.max_parallel_hint')}
    ${mergeFlowsBlock(r)}
  </fieldset>`
}

/** The Integration numbers out of the form — same strictness as the other repo fields. */
function integrationFromForm(b, problems) {
  const num = (name, min, fallback) => {
    const raw = String(b[name] ?? '').trim()
    if (raw === '') return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min) {
      problems.push(t('repos.err_number', { field: t(`repos.${name}`), min }))
      return fallback
    }
    return n
  }
  return {
    merge_mode: b.merge_mode === 'hub' ? 'hub' : 'off',
    merge_check: String(b.merge_check ?? '').trim() || null,
    finish_timeout_min: num('finish_timeout_min', 1, 15),
    merge_max_attempts: num('merge_max_attempts', 0, 2),
    conflict_parallel: num('conflict_parallel', 1, 1),
    // The last value wins in parseForm, so the checkbox beats its hidden companion.
    notify_running: b.notify_running === '1' || b.notify_running === 'on' ? 1 : 0,
    max_parallel: num('max_parallel', 0, 0),
  }
}

export async function repoEdit(req, res, url) {
  const id = url.searchParams.get('id')
  const r = id ? getRepo(+id) : {}
  const body = `<h2>${e(id ? t('repos.edit_title') : t('repos.create_title'))}</h2>
  <form method="post" action="/repos/edit${id ? `?id=${id}` : ''}" class="settings form-grid">
    <label>${e(t('repos.name'))} <input name="name" value="${e(r.name ?? '')}" required></label>
    <label>${e(t('repos.path_label'))} <input name="path" value="${e(r.path ?? '')}" placeholder="~/projects/my-project" required></label>
    <label>${e(t('repos.base'))} <input name="base_branch" value="${e(r.base_branch ?? 'main')}"></label>
    <label>${e(t('repos.prompt_label'))} <textarea name="prompt" rows="6">${e(r.prompt ?? '')}</textarea></label>
    <label>${e(t('repos.extras_label'))} <textarea name="worktree_extras" rows="5">${e(r.worktree_extras ?? '[]')}</textarea>
      <span class="btn-row"><button type="button" class="ghost" id="extras-find">${e(t('repos.extras_find'))}</button>
      <span class="dim">${e(t('repos.extras_find_hint'))}</span></span></label>
    ${integrationFields(r)}
    <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
  </form>
  ${extrasDialog()}`
  // This form belongs to ONE repo, like a run's detail page: switching the
  // header repo cannot make it show another one, so it hands its own repo over
  // and layout() adds the note saying so. A NEW repo has none yet — the page
  // then follows the switcher like any other, which is to say it follows nothing.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('nav.repos'), '/repos', body, id ? r?.id ?? null : null))
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
  const integ = integrationFromForm(b, problems)
  if (problems.length) return problemPage(req, res, t('repos.edit_title'), problems, back)
  const prompt = (b.prompt ?? '').trim() || null
  const i = [integ.merge_mode, integ.merge_check, integ.finish_timeout_min, integ.merge_max_attempts,
    integ.conflict_parallel, integ.notify_running, integ.max_parallel]
  if (id) {
    db.prepare(`UPDATE repos SET name=?, path=?, base_branch=?, worktree_extras=?, prompt=?,
                merge_mode=?, merge_check=?, finish_timeout_min=?, merge_max_attempts=?,
                conflict_parallel=?, notify_running=?, max_parallel=? WHERE id=?`)
      .run(b.name.trim(), repoPath, b.base_branch || 'main', b.worktree_extras || '[]', prompt, ...i, +id)
  } else {
    db.prepare(`INSERT INTO repos(name,path,base_branch,worktree_extras,prompt,
                merge_mode,merge_check,finish_timeout_min,merge_max_attempts,
                conflict_parallel,notify_running,max_parallel) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.name.trim(), repoPath, b.base_branch || 'main', b.worktree_extras || '[]', prompt, ...i)
  }
  redirect(res, '/repos')
}

/**
 * Every setting this route may write. An allowlist, not the body's own keys —
 * a request must not be able to invent a setting.
 *
 * 'retention_days' is deliberately absent: it stays in the database as the
 * fallback for an installation that has not saved the new field yet
 * (sessionKeepMs), and an empty write would silently reset it.
 */
const STATIC_KEYS = ['pipeline_on', 'schedule_catchup_hours',
  'abo_price', 'session_keep_hours', 'archive_session_on', 'archive_session_keep_hours', 'flow_runs_keep_days', 'prompt_suffix',
  'public_host',
  'llm_check_on', 'llm_check_model', 'llm_check_or_provider', 'llm_check_source', 'llm_check_fallback', 'llm_check_fallback_model',
  'llm_title_on', 'llm_title_model', 'llm_title_or_provider', 'llm_title_source', 'llm_title_fallback', 'llm_title_fallback_model',
  'llm_extras_on', 'llm_extras_model', 'llm_extras_or_provider', 'llm_extras_source', 'llm_extras_fallback', 'llm_extras_fallback_model',
  'llm_retries', 'llm_retry_attempts', 'llm_retry_base_ms', 'llm_retry_max_ms',
  'llm_alert_on', 'llm_alert_window_min', 'llm_alert_max_per_hour',
  'ui_language', 'ui_timezone']

/**
 * The allowlist, computed per request rather than once at import.
 *
 * A module-level constant would be built while this file is still being
 * imported — before `loadExternalPlugins()` has run, so an external plugin's
 * thresholds would be missing from it. They would then render on the form and
 * be dropped on save: configurable-looking and silently not saved, which is
 * the exact failure this allowlist exists to prevent. `allPluginSettingKeys()`
 * walks a Map of a handful of entries; the cost is nothing next to the write.
 *
 * The gate keys that used to stand here by hand (`claude_gate_5h`,
 * `openrouter_min_eur`, `cursor_included_usd`, …) are exactly what it returns
 * now: a built-in plugin declares its historic `settingKey`, so the list is
 * the same strings from a different source.
 */
function settingsKeys() {
  return [...STATIC_KEYS, ...allPluginSettingKeys()]
}

export async function settingsSave(req, res, url, formBody) {
  const b = await formBody()
  // Write only what the request actually CARRIED. This used to be `b[k] ?? ''`
  // over the whole list, which meant a body with one field blanked the other
  // fifteen — a settings page that saves a fragment at a time would have wiped
  // a stored secret the first time somebody switched the language. The e2e
  // suite still has to post everything back to change one value; that was the
  // symptom, and this is the cause.
  //
  // Safe for this form because every field here is a text input or a <select>,
  // and both always post a value — an empty text field arrives as ''. It would
  // NOT be safe for a checkbox: an unchecked one is simply absent, so its "off"
  // would read as "not mentioned". A checkbox added here needs a hidden
  // companion field carrying the 0.
  for (const k of settingsKeys()) {
    if (Object.hasOwn(b, k)) setSetting(k, b[k] ?? '')
  }
  // The LLM jobs' serving-provider routing is THREE form fields (mode + the
  // pin tag + the auto requirements) but TWO stored values — the same
  // derivation the run form does in providerFromForm(). Only where the body
  // actually carried the routing block: the settings page saves a fragment at
  // a time, and a save of an unrelated section must not reset a configured
  // routing (the same rule the loop above follows).
  for (const p of ['title', 'check', 'extras']) {
    if (!Object.hasOwn(b, `${p}_or_mode`)) continue
    const mode = b[`${p}_or_mode`]
    if (mode === 'pin') {
      setSetting(`llm_${p}_or_provider`, String(b[`${p}_or_provider`] ?? '').trim())
      setSetting(`llm_${p}_or_routing`, '')
    } else if (mode === 'auto') {
      const cfg = parseRoutingConfig({
        quant_min: b[`${p}_or_quant`] ?? '', location: b[`${p}_or_region`] ?? 'all',
        max_in: b[`${p}_or_max_in`] ?? '', max_out: b[`${p}_or_max_out`] ?? '',
      })
      setSetting(`llm_${p}_or_provider`, '')
      // A broken requirement stores NOTHING rather than a half config — the
      // caller then keeps the open routing instead of a config that cannot
      // resolve; the widget re-opens with the old values for correcting.
      setSetting(`llm_${p}_or_routing`, cfg?.error ? '' : JSON.stringify(cfg))
    } else {
      setSetting(`llm_${p}_or_provider`, '')
      setSetting(`llm_${p}_or_routing`, '')
    }
  }
  // The language takes effect immediately — the redirect below already renders in it.
  if (Object.hasOwn(b, 'ui_language')) setLanguage(b.ui_language ?? 'en')
  // Same for the timezone: an empty value means "auto (per UI language)".
  if (Object.hasOwn(b, 'ui_timezone')) setTimezone(b.ui_timezone ?? '')
  // …and for the public host, which the notification links read live.
  if (Object.hasOwn(b, 'public_host')) setPublicHost(b.public_host ?? '')
  // "Used" means saved: only now does the model enter the MRU list.
  if (Object.hasOwn(b, 'llm_check_model')) llmModellMerken(b.llm_check_model)
  if (Object.hasOwn(b, 'llm_title_model')) rememberTitleModel(b.llm_title_model)
  if (Object.hasOwn(b, 'llm_extras_model')) rememberExtrasModel(b.llm_extras_model)
  redirect(res, '/settings')
}

