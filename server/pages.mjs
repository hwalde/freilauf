// cc-hub — pages: server-rendered HTML, vanilla JS, red/yellow/green as the
// only colors (planning 10). Repo switcher + switch states in the header.
// All UI strings go through i18n (lang/<code>.json; English is the default).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import db, { getRepo, getRun } from './db.mjs'
import { escapeHtml as e, validCron, WOCHENTAGE, scheduleText, parseDbUtc, fmtRelativeTime, fmtDateTime, hubVersion } from './util.mjs'
import { cookieRepo, requestRepo } from './web-helpers.mjs'
import { providerBalances } from './balances.mjs'
import {
  enabledCodingAgents, listCodingAgents, saveCodingAgent,
  deleteCodingAgent, unconfiguredHarnessIds,
} from './coding-agents.mjs'
import {
  runDefFields, runDefFromForm, saveAgent, lastRunChoice, rememberRunChoice,
  runTitleField, runStartTimeFields, runStartFromForm,
  runSetupFields, runSetupFromForm, branchFields, branchContext,
  agentNameTaken, moveAgent, deleteAgent,
} from './run-def.mjs'
import {
  listFavorites, getFavorite, saveFavorite, deleteFavorite,
  favoriteFromForm, favoriteTemplate, favoriteSummary, FAVORITES_MAX,
} from './favorites.mjs'
import { runTitle, titleModelsMru, rememberTitleModel, DEFAULT_TITLE_MODEL } from './title.mjs'
import { extrasModelsMru, rememberExtrasModel, DEFAULT_EXTRAS_MODEL } from './extras-suggest.mjs'
import { runEditAllowed } from './run-edit.mjs'
import { getHarness, harnessLabel, detectInstalled } from './harnesses/index.mjs'
import { providerLabel } from './providers/index.mjs'
import { subscriptionUsage } from './usage.mjs'
import { ampelAusVorfaellen, offeneVorfaelle, alleVorfaelle, brauchtMensch } from './incidents.mjs'
import { TYP_TEXT } from './detect.mjs'
import { llmModelleMru, llmModellMerken } from './pruefer.mjs'
import { skillListe, skillAnzeige, skillFelder, skillsAusFormular } from './zusaetze.mjs'
import { resumeCommand } from './integrate.mjs'
import { listSessions, sessionMemory, sessionKeepHours, currentKeepMs, paneAlive } from './sessions.mjs'
import { attachmentSummary, flowSection, flowAttachFields, mergeFlowsBlock, mergeFlowsHint } from './flows/attach.mjs'
import { flowRunKeepDays } from './flows/db.mjs'
// The flow block of the detail page is rendered in server/flows/ and belongs to
// that module; it is re-exported here so a fragment has ONE place to ask for a
// piece of a page, whichever module happens to build it.
export { flowSection }
import { t, LANGUAGES, currentLanguage, setLanguage, clientCatalog } from './i18n.mjs'

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
    || db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind LIKE 'anomaly:%' AND kind NOT IN ('anomaly:no_activity','anomaly:soft_overrun','anomaly:unpushed') LIMIT 1`).get(run.id)
  // A run in the finish gate is at least yellow: it has reported, and something
  // is still keeping its work off the base branch. A blocked_* one is red
  // through its incident anyway.
  const yellow = !red && (
    vf === 'gelb' || run.status === 'deferred' || !!run.finish_state
    || db.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind IN ('anomaly:no_activity','anomaly:soft_overrun','anomaly:unpushed') LIMIT 1`).get(run.id))
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
 */
function lastAnomaly(runId) {
  const r = db.prepare(`SELECT kind, ts FROM events WHERE run_id=? AND (kind LIKE 'anomaly:%' OR kind='help') ORDER BY id DESC LIMIT 1`).get(runId)
  if (!r) return null
  const key = `anomaly.${String(r.kind).replace(/^anomaly:/, '')}`
  const name = t(key) === key ? r.kind : t(key)
  return `${name} (${r.ts})`
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
    const titel = `${typName(v.typ)} · ${t('incidents.last')} ${v.zuletzt_gesehen} UTC${v.beleg ? `\n${v.beleg}` : ''}`
    return `<span class="incident ${SEVERITY_CLASS[v.schwere]}" title="${e(titel)}">${handeln ? '❗ ' : ''}${e(typName(v.typ))} ${v.anzahl}×</span>
    <form method="post" action="/api/incidents/${v.id}/resolve" class="inline" onclick="event.stopPropagation()">
      <input type="hidden" name="back" value="/?repo=${repoId}"><button title="${e(t('incidents.resolve_hint'))}">${e(t(handeln ? 'incidents.mark_handled' : 'incidents.dismiss'))}</button></form>`
  }).join('')}</div>`
}

/** Global incidents (provider pulse) above all pages. */
function globalesBanner() {
  const offen = offeneVorfaelle(null)
  if (!offen.length) return ''
  return `<div class="banner red">${offen.map(v => `🔴 <b>${e(typName(v.typ))}</b> ${e(t('incidents.global_since', { ts: v.erst_gesehen }))} (${e(t('incidents.checked', { n: v.anzahl }))}) — ${e(v.beleg ?? '')}
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
 * The "find worktree extras" dialog — repo create AND edit form. The repo path
 * is read from the form's path field when the button opens the dialog; the hub
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
    label ? `<span class="quota-label">${e(label)}</span>` : ''}<span class="track"><span class="fill ${klasse}" style="width:${Math.min(pct ?? 0, 100)}%"></span></span><span class="quota-pct">${pct ?? '?'} %</span>${
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

/** How much work is in flight in this repo, per status, linked into the overview. */
function workBlock(repoId) {
  if (repoId == null) return ''
  const zeilen = WORK_STATUSES.map(s => {
    const n = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND archived_at IS NULL AND status=?`).get(repoId, s).c
    if (!n) return null
    return {
      status: s,
      n,
      // The sum of ALL repos for that status — the reading "1 running" that does
      // not add up only makes sense against the other repos' loads.
      gesamt: db.prepare(`SELECT count(*) c FROM runs WHERE archived_at IS NULL AND status=?`).get(s).c,
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
 */
function openIncidents(repoId) {
  const offen = db.prepare(`SELECT i.*, r.status AS run_status FROM incidents i
    LEFT JOIN runs r ON r.id = i.run_id
    WHERE i.geloest_am IS NULL AND (i.run_id IS NULL OR r.repo_id = ?)`).all(repoId ?? -1)
  const handeln = offen.filter(v => brauchtMensch(v, v.run_status)).length
  return { offen: offen.length, handeln, noticed: offen.length - handeln }
}

function incidentBlock(repoId) {
  const { offen, handeln, noticed } = openIncidents(repoId)
  if (!offen) return ''
  return `<div class="side-block"><span class="side-label">${e(t('incidents.title'))}</span>
    ${handeln ? `<div><b class="err">${handeln}</b> ${e(t('incidents.needs_you_short'))}</div>` : ''}
    ${noticed ? `<div><b class="warn">${noticed}</b> ${e(t('incidents.noticed_short'))}</div>` : ''}</div>`
}

/**
 * What every tmux session on this machine costs in memory, together.
 *
 * It belongs on every page and not only on /sessions, because that is the
 * reading one does not go looking for: a session outlives its agent on purpose
 * (`cc-start --keep`), so the bill runs quietly and only ever surprises. Thirty
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
  return `<div class="side-block" id="side-mem"><span class="side-label">${e(t('side.mem'))}</span>
    <div><a href="/sessions"><b>${e(mem.rssKb ? byteText(mem.rssKb) : '0 MB')}</b></a>
      <span class="dim">${e(t('side.mem_sessions', { n: mem.sessions }))}</span></div>
    <div class="dim"${mem.measuredAtMs ? ` title="${e(fmtDateTime(mem.measuredAtMs))}"` : ''}>${
      e(t('side.mem_every', { min: Math.max(1, Math.round(mem.intervalMs / 60_000)) }))}</div></div>`
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
      teile.push(`<span class="rail-dot" title="${e(u.label)} ${e(kurz)}: ${pct} %">
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
  const repos = db.prepare('SELECT id,name FROM repos ORDER BY name').all()
  // Which repo the HEADER stands on — three answers in this order, and the
  // order is the whole point (see the switcher on a page that belongs to ONE
  // repo, below):
  //
  //   1. an explicit ?repo= in the request      — the switcher itself speaking
  //   2. the repo context the page handed over  — the run, the agent, the list
  //   3. the cchub_repo cookie, then the first repo
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
    ? `<label class="dim">${e(t('layout.repo'))}</label> <select id="repo-switch" data-active="${e(active)}">${repos.map(r => `<option value="${r.id}" ${r.id == effRepo ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select>`
    : `<a href="/repos" class="warn">${e(t('layout.no_repo'))}</a>`
  return `<!doctype html><html lang="${e(currentLanguage())}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cc-hub — ${e(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f6fed'/%3E%3Cpath d='M9 11l5 5-5 5' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M17 21h7' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/xterm.css"><link rel="stylesheet" href="/static/hub.css"></head>
<body${selectedRepo == null ? '' : ` data-repo="${e(String(selectedRepo))}"`}>
${setupBanner()}
<header>
  <span class="brand">cc-hub</span>
  <nav>${nav}</nav>
  <span class="spacer"></span>
  ${repoSel}
  <button type="button" id="qr-open" class="qr-open" title="${e(t('qr.hint'))}">⚡ ${e(t('qr.title'))}</button>
</header>
<div class="shell" id="shell">
<main>${globalesBanner()}${otherRepo}${content}</main>
${await statusSidebar(effRepo)}
</div>
${quickRunDialog(repos, effRepo)}
<div class="toasts" id="cchub-toasts" aria-live="polite"></div>
${withTerminal ? '<script src="/static/xterm.js"></script><script src="/static/addon-fit.js"></script>' : ''}
<script>window.CCHUB_I18N=${JSON.stringify(clientCatalog())}</script>
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
  // too — '16:30' alone says nothing about a window that runs for a week.
  const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  const ddmm = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.`
  const resetText = (iso) => {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return ''
    const d = new Date(ms)
    return (ms - Date.now() > 24 * 3600_000 ? `${ddmm(d)} ` : '') + `${hhmm(d)} UTC`
  }
  // When a window was READ, for a reading that is not the current one. Same idea
  // in the other direction: a time alone is a lie about a value taken two days
  // ago, so anything but today carries its date.
  const stampText = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const d = new Date(ms)
    const today = new Date()
    const sameDay = d.getUTCFullYear() === today.getUTCFullYear()
      && d.getUTCMonth() === today.getUTCMonth() && d.getUTCDate() === today.getUTCDate()
    return (sameDay ? '' : `${ddmm(d)} `) + `${hhmm(d)} UTC`
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
      // A per-model window may be the LAST live reading rather than the current
      // one (quota.mjs merges the sources by age; the account reports the scoped
      // window only sometimes). The bar then keeps standing where it stood — but
      // it says when it was read, because a number that looks current and is two
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
        ${fenster('5h', d.five, d.resets_at)}
        ${fenster('7d', d.seven_general, d.seven_resets_at)}
        ${scoped}</div>`
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
        ? t('usage.balance_detail', { granted: a.granted, topped_up: a.topped_up }) : ''
      return `<span${detail ? ` title="${e(detail)}"` : ''}>${
        e(t('usage.remaining', { amount: a.remaining, currency: a.currency }))}</span>`
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
  // The status filter the sidebar's "work in flight" counts link to. Anything
  // else in the parameter is simply no filter — a URL must not be able to
  // invent a status the CHECK constraint does not know.
  const wanted = url.searchParams.get('status')
  const filter = WORK_STATUSES.includes(wanted) ? wanted : null
  const runs = overviewRuns(sel.id, filter)
  const body = `
  <div class="btn-row"><a class="btn" href="/runs/new?repo=${sel.id}">${e(t('overview.start_single'))}</a>
     <a class="btn ghost" href="/archive?repo=${sel.id}">${e(t('nav.archive'))}</a>
     ${filter ? `<span class="dim">${e(t('overview.filtered', { status: statusText(filter) }))}</span>
       <a class="btn" href="/?repo=${sel.id}">${e(t('overview.filter_clear'))}</a>` : ''}</div>
  ${overviewTable(runs, { repoId: sel.id, status: filter })}`
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
  const archivBtn = ['done', 'failed', 'aborted'].includes(r.status)
    ? `<form method="post" action="/api/runs/${r.id}/archive" class="inline" onclick="event.stopPropagation()">
          <input type="hidden" name="back" value="/?repo=${repoId}">
          <button type="submit" class="act" title="${e(t('overview.archive'))}" aria-label="${e(t('overview.archive'))}">${e(t('overview.archive_short'))}</button></form>`
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
      <td class="status-cell">
        <span class="status-line">${AMPEL_DOT[ampel(r)]()} ${e(statusText(r.status))}</span>
        ${wartend ? `<div class="dim">${wartetAuf(r)}</div>` : ''}
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
      <td>${vorfallZelle(r.id, repoId, r.status)}${archivBtn}</td>
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
const OVERVIEW_COLS = 7

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
export function overviewRuns(repoId, status = null) {
  const s = WORK_STATUSES.includes(status) ? status : null
  return db.prepare(`SELECT * FROM runs WHERE repo_id=? AND archived_at IS NULL
    AND (? IS NULL OR status = ?) ORDER BY
    CASE status WHEN 'waiting_help' THEN 0 WHEN 'failed' THEN 1 WHEN 'running' THEN 2
                WHEN 'deferred' THEN 3 WHEN 'scheduled' THEN 4 ELSE 5 END,
    started_at DESC LIMIT 200`).all(repoId, s, s)
}

/**
 * The tbody on its own — the swap target when a row has to appear or vanish.
 *
 * It carries the active status filter as a data attribute so the live channel
 * can ask for the SAME selection again. Without it the first update would
 * quietly replace a filtered list with the unfiltered one.
 */
export function runsBody(runs, ctx) {
  return `<tbody id="runs-body"${ctx.status ? ` data-status="${e(ctx.status)}"` : ''}>${runRows(runs, ctx)}</tbody>`
}

/** The overview table around the rows; the tbody is the anchor for new rows. */
export function overviewTable(runs, ctx) {
  return `<div class="table-wrap"><table class="list"><thead><tr><th>${e(t('overview.status'))}</th><th>${e(t('overview.title_col'))}</th><th>${e(t('overview.harness_model'))}</th><th>${e(t('overview.started'))}</th><th>${e(t('overview.duration_expected'))}</th><th>${e(t('overview.branch_pr'))}</th><th>${e(t('incidents.title'))}</th></tr></thead>
  ${runsBody(runs, ctx)}</table></div>`
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
const ARCHIV_SEITE = Number(process.env.CCHUB_ARCHIVE_PAGE_SIZE ?? 50) || 50

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
    return `<tr onclick="location='/runs/${r.id}'">
      <td><a href="/runs/${r.id}">${e(titel)}</a>
        <div class="dim">${e(herkunft)}</div></td>
      <td class="two-line">${e(harnessLabel(r.harness))}${r.model ? `<span class="dim">${r.provider ? e(r.provider) + ':' : ''}${e(r.model)}</span>` : ''}</td>
      <td>${e(statusText(r.status))}</td>
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
  let sel = want ? getRepo(+want) : null
  // No ?repo= — or one naming a repo that no longer exists: fall back to the
  // repo chosen in the header, which travels as the cchub_repo cookie.
  if (!sel) sel = cookieRepo(req) ? getRepo(cookieRepo(req)) : null
  if (!sel) sel = db.prepare('SELECT * FROM repos ORDER BY name LIMIT 1').get() ?? null
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
  const logf = join(process.env.CCHUB_RUNS_DIR ?? `${process.env.HOME}/agents/runs`, id, 'log.txt')
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
  const body = `
  ${runDetailHead(run, { title: titel })}
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
  <details ${live ? 'open' : ''}><summary>${e(t('run.terminal'))} ${e(terminalState(live, sessionOpen, inFlight))}</summary>
    <div id="term" data-session="${sessionOpen ? '1' : '0'}" data-live="${live ? '1' : '0'}"></div>
    ${live && !inFlight ? `<p class="dim">${e(t('run.session_after_hint'))}</p>` : ''}
    ${live ? `<form onsubmit="return cchubSend(this,'/api/runs/${id}/send')"><textarea name="text" rows="3" placeholder="${e(t('run.send_text_ph'))}"></textarea><button>${e(t('run.send'))}</button></form>` : ''}
    ${inFlight
      ? (live ? `<form onsubmit="return cchubKill('${id}')"><button class="danger">${e(t('run.kill'))}</button></form>` : '')
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
  ${flowSection(run)}
  ${vorfallAbschnitt(id, run.status)}
  <h3>${e(t('run.metrics'))}</h3>
  ${runMetrics(run)}
  <h3>${e(t('run.events'))}</h3>${runEvents(id)}
  <h3>${e(t('run.log'))}</h3>${logHtml}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, titel, '/', body, run.repo_id, true))
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
  return `<h2 id="run-head">${AMPEL_DOT[ampel(run)]()} ${titleInline(id, titel)} <span class="status-chip">${e(statusText(run.status))}</span></h2>
  ${run.status === 'scheduled'
    // A planned run must be revocable — otherwise a start you thought better of
    // sits in the future with no way to stop it. 'kill' is exactly right here:
    // there is no session to end, only a record to set to 'aborted'.
    ? `<div class="banner waiting" id="run-banner">⏳ ${wartetAuf(run)}
       <form method="post" action="/api/runs/${id}/kill" class="inline"><button class="danger">${e(t('start.cancel'))}</button></form></div>`
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
      confirmKey ? ` onsubmit="return confirm(${JSON.stringify(t(confirmKey))})"` : ''}>${extra}
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
      ? run.provider + (run.or_provider ? ` (${t('run.pinned')}: ${run.or_provider})` : '') : null)}
    ${chip('run.start', run.started_at)}
    ${chip('run.end', run.ended_at)}
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
 * column live), a scheduled or deferred run additionally the prompt and the
 * repo (both read at launch). A finished run gets no card at all.
 *
 * The card is part of the run-detail fragment, so a status change (a scheduled
 * run starts) swaps the fields by themselves — and hub.js skips that swap while
 * the card has focus, so an edit is never thrown away mid-typing.
 */
export function runEditCard(run) {
  const erlaubt = runEditAllowed(run)
  if (!erlaubt.duration && !erlaubt.prompt && !erlaubt.repo) return ''
  const repos = db.prepare('SELECT id,name FROM repos ORDER BY name').all()
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
  return `<details class="run-edit" id="run-edit">
    <summary>${e(t('run.edit'))}</summary>
    <form method="post" action="/api/runs/${e(run.id)}/edit" class="settings form-grid">
      ${zeilen.join('')}
      <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
    </form>
  </details>`
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
    ${zeile('run.costs', run.cost_eur != null ? e(run.cost_eur.toFixed(2)) + ' € (' + e(t('run.abo_delta')) + ')' : run.cost_usd != null ? e(run.cost_usd.toFixed(4)) + ' $' : '–')}
    ${zeile('run.activity', e(run.last_activity_at ?? '–'))}
    ${zeile('run.branch_reported', `${e(run.branch_reported ?? '–')} <span class="dim">/ ${e(t('run.branch_expected'))} ${e(run.branch_expected ?? '–')}</span>`)}
    ${zeile('run.pr', run.pr_url ? `<a href="${e(run.pr_url)}">${e(run.pr_url)}</a>` : '–')}
    ${zeile('run.exit', `${run.exit_code ?? '–'}${run.tmux_closed_at ? ` <span class="dim">/ ${e(t('run.tmux_closed'))} ${e(run.tmux_closed_at)}</span>` : ''}`)}
  </dl>`
}

/** The run's history, oldest first — without the Telegram bookkeeping. */
export function runEvents(runId) {
  const events = db.prepare(`SELECT * FROM events WHERE run_id=? AND kind NOT LIKE 'telegram_sent%' ORDER BY id`).all(runId)
  return `<ul class="events" id="run-events">${events.map(ev => `<li><span class="dim">${e(ev.ts)}</span> ${e(ev.kind)}</li>`).join('') || `<li class="dim">${e(t('run.none'))}</li>`}</ul>`
}

function fmtLaufzeit(run) {
  const endeMs = run.ended_at ? Date.parse(run.ended_at.replace(' ', 'T') + 'Z') : Date.now()
  const min = Math.round((endeMs - Date.parse(run.started_at.replace(' ', 'T') + 'Z')) / 60000)
  return `${t('unit.minutes', { n: min })}${run.ended_at ? '' : ' (' + t('run.running') + ')'}`
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
    · ${v.anzahl}× · ${e(t('incidents.first'))} ${e(v.erst_gesehen)} · ${e(t('incidents.last'))} ${e(v.zuletzt_gesehen)} UTC
    ${v.wieder_geoeffnet ? `· ${e(t('incidents.reopened', { n: v.wieder_geoeffnet }))}` : ''}
    ${v.geloest_am ? `· ${e(t('incidents.resolved_at'))} ${e(v.geloest_am)} (${e(v.geloest_von ?? '')})` : `
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
  <p class="dim">${e(t('incidents.detector_log'))}: <code>${e(join(process.env.CCHUB_RUNS_DIR ?? `${process.env.HOME}/agents/runs`, runId, 'detektor.jsonl'))}</code></p>`
}

// ---------------- repos ----------------
export async function pageRepos(req, res, url) {
  const repos = db.prepare('SELECT * FROM repos ORDER BY name').all()
  const rows = repos.map(r => {
    const p = (r.prompt ?? '').trim()
    const kurz = p ? (p.length > 60 ? p.slice(0, 60) + '…' : p) : ''
    return `<tr><td>${e(r.name)}</td><td><code>${e(r.path)}</code></td><td>${e(r.base_branch)}</td>
    <td class="dim">${e(r.worktree_extras)}</td>
    <td>${kurz ? `<span class="dim" title="${e(p)}">${e(kurz)}</span>` : `<span class="dim">—</span>`}</td>
    <td>${e(r.merge_mode === 'hub' ? t('merge.mode_hub') : t('merge.mode_off'))}${mergeFlowsHint(r.id)}
      ${r.last_push_at ? `<div class="dim">${e(t('repos.last_push', { ts: r.last_push_at }))}</div>` : ''}</td>
    <td><a href="/repos/edit?id=${r.id}">${e(t('agents.edit'))}</a></td></tr>`
  }).join('')
  const body = `
  <p><a class="btn" href="/repos/edit">${e(t('repos.create'))}</a></p>
  <table class="list"><thead><tr><th>${e(t('repos.name'))}</th><th>${e(t('repos.path'))}</th><th>${e(t('repos.base'))}</th><th>${e(t('repos.extras'))}</th><th>${e(t('repos.prompt'))}</th><th>${e(t('repos.integration_legend'))}</th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="7" class="dim">${e(t('repos.none'))}</td></tr>`}</tbody></table>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('nav.repos'), '/repos', body))
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
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`
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
    <td>${e(byteText(s.resources.rssKb))}<div class="dim">${s.resources.cpu.toFixed(1)} % CPU</div></td>
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
  const body = `
  <h2>${e(t('sessions.title'))}</h2>
  <p class="dim">${e(t('sessions.intro'))}</p>
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
export async function pageSettings(req, res, url) {
  const s = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]))
  const body = `
  <h2>${e(t('nav.settings'))}</h2>
  <p class="dim">${e(t('settings.global_hint'))}</p>
  <p><a class="btn" href="/settings/coding-agents">${e(t('ca.title'))}</a>
     <span class="dim">${e(t('settings.coding_agents_hint'))}</span></p>
  <p><a class="btn" href="/settings/favorites">${e(t('fav.title'))}</a>
     <span class="dim">${e(t('settings.favorites_hint'))}</span></p>
  <p><a class="btn" href="/settings/merge">${e(t('merge.settings_title'))}</a>
     <span class="dim">${e(t('settings.merge_hint', { setup: mergeSettingsSummary() }))}</span></p>
  <form method="post" action="/settings/save" class="settings form-grid">
    <label>${e(t('settings.language'))} <select name="ui_language">${Object.entries(LANGUAGES).map(([code, label]) =>
      `<option value="${code}" ${(s.ui_language ?? 'en') === code ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>
    <label>${e(t('settings.pipeline'))} <select name="pipeline_on"><option value="1" ${s.pipeline_on === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${s.pipeline_on !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select></label>
    <label>${e(t('settings.telegram_token'))} <input name="telegram_token" type="password" value="${e(s.telegram_token ?? '')}"></label>
    <label>${e(t('settings.telegram_chat'))} <input name="telegram_chat" value="${e(s.telegram_chat ?? '')}"></label>
    <label>${e(t('settings.quota_threshold'))} <input name="quota_threshold" type="number" value="${e(s.quota_threshold ?? '90')}"></label>
    <label>${e(t('settings.openrouter_min'))} <input name="openrouter_min_eur" type="number" step="0.5" value="${e(s.openrouter_min_eur ?? '5')}"></label>
    <label>${e(t('settings.abo_price'))} <input name="abo_price" type="number" value="${e(s.abo_price ?? '200')}">
      <span class="dim">${e(t('settings.abo_price_hint'))}</span></label>
    <label>${e(t('settings.cursor_included'))} <input name="cursor_included_usd" type="number" step="1" value="${e(s.cursor_included_usd ?? '20')}">
      <span class="dim">${e(t('settings.cursor_included_hint'))}</span></label>
    <label>${e(t('settings.session_keep'))} <input name="session_keep_hours" type="number" min="0" step="0.5" value="${e(String(sessionKeepHours(s)))}">
      <span class="dim">${e(t('settings.session_keep_hint'))}</span></label>
    <label>${e(t('settings.flow_runs_keep'))} <input name="flow_runs_keep_days" type="number" min="0" step="1" value="${e(String(flowRunKeepDays(s)))}">
      <span class="dim">${e(t('settings.flow_runs_keep_hint'))}</span></label>
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
    <fieldset><legend>${e(t('settings.extras_legend'))}</legend>
      <p class="dim">${e(t('settings.extras_hint'))} ${process.env.OPENROUTER_API_KEY ? '' : `<b class="warn">${e(t('settings.llm_missing_key'))}</b>`}</p>
      <label>${e(t('settings.extras_on'))} <select name="llm_extras_on"><option value="1" ${(s.llm_extras_on ?? '1') === '1' ? 'selected' : ''}>${e(t('layout.on'))}</option><option value="0" ${(s.llm_extras_on ?? '1') !== '1' ? 'selected' : ''}>${e(t('layout.off'))}</option></select></label>
      <label>${e(t('settings.extras_model'))} <input name="llm_extras_model" list="extras-mru" value="${e(s.llm_extras_model || DEFAULT_EXTRAS_MODEL)}" placeholder="${e(DEFAULT_EXTRAS_MODEL)}">
        <datalist id="extras-mru">${[...new Set([DEFAULT_EXTRAS_MODEL, ...extrasModelsMru()])].map(m => `<option value="${e(m)}">`).join('')}</datalist>
        <span class="dim">${e(t('settings.extras_model_hint', { model: DEFAULT_EXTRAS_MODEL }))}</span></label>
      <label>${e(t('settings.llm_or_provider'))} <input name="llm_extras_or_provider" value="${e(s.llm_extras_or_provider ?? '')}" placeholder="${e(t('settings.llm_or_ph'))}"></label>
    </fieldset>
    <div class="btn-row"><button>${e(t('settings.save'))}</button></div>
  </form>
  ${url.searchParams.get('telegram') === 'ok' ? `<p class="ok">✓ ${e(t('settings.telegram_ok'))}</p>` : ''}
  ${url.searchParams.get('telegram') === 'fehler' ? `<p class="err">${e(t('settings.telegram_fail'))}</p>` : ''}
  <p><a class="btn" href="/telegram-setup">${e(t('settings.telegram_setup'))}</a></p>
  <form method="post" action="/settings/test-telegram"><button>${e(t('settings.telegram_test'))}</button></form>`
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
            onsubmit="return confirm(${JSON.stringify(t('fav.delete_confirm', { name: f.name }))})">
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
    setSetting('merge_resolver_model', setup.model ?? '')
    setSetting('merge_resolver_effort', setup.effort ?? '')
    setSetting('merge_resolver_skills', skillsAusFormular(b) ?? '')
  } else {
    for (const k of ['harness', 'provider', 'or_provider', 'model', 'effort', 'skills']) {
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
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('ca.title'), '/settings', body))
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
import { sendTest } from './telegram.mjs'

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
  <fieldset class="schedule">
    <legend>${e(t('sched.legend'))}</legend>
    <label>${e(t('sched.kind'))} <select name="schedule_kind" id="schedule-kind">
      ${arten.map(([v, txt]) => `<option value="${v}" ${kind === v ? 'selected' : ''}>${e(txt)}</option>`).join('')}
    </select></label>

    <div class="zp" data-kind="woechentlich">
      <div class="weekdays">${WOCHENTAGE.map(w => `
        <label class="weekday"><input type="checkbox" name="schedule_days" value="${w.n}"
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
  ${runDefFields(a, branchContext(repoId))}
  <input type="hidden" name="repo_id" value="${repoId}">
  ${zeitplanFelder(a)}
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
    : +(url.searchParams.get('repo') ?? cookieRepo(req) ?? db.prepare('SELECT id FROM repos ORDER BY name LIMIT 1').get()?.id ?? 0)
  // The destructive actions belong ON this page — the agent's detail page —
  // never in the overview. Delete is a separate form that requires the confirm
  // dialog; move goes to its own page because a collision needs a date-time
  // suffix. A new agent has nothing to delete or move.
  const danger = id ? `
  <div class="btn-row">
    <a class="btn ghost" href="/agents/move?id=${id}&repo=${repoId}">${e(t('agents.move'))}</a>
    <form method="post" action="/agents/delete" class="inline" onsubmit="return confirm(${JSON.stringify(t('agents.delete_confirm', { name: a.name }))})"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="repo" value="${repoId}"><button class="danger">${e(t('agents.delete'))}</button></form>
  </div>` : ''
  const body = `<h2>${e(id ? t('agentform.title_edit') : t('agentform.title_new'))}</h2>
  <form method="post" action="/agents/edit${id ? `?id=${id}` : ''}" class="settings form-grid">${agentFields(a, repoId)}
    <div class="btn-row"><button>${e(t('settings.save'))}</button></div></form>${danger}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, id ? t('agentform.title_edit') : t('agentform.title_new'), '/agents', body, repoId))
}

export async function agentSave(req, res, url, formBody) {
  const id = url.searchParams.get('id')
  const b = await formBody()
  const active = b.active ? 1 : 0
  const back = `/agents/edit${id ? `?id=${id}&repo=${b.repo_id ?? ''}` : `?repo=${b.repo_id ?? ''}`}`
  const problems = []
  const name = (b.name ?? '').trim()
  if (!name) problems.push(t('form.name_missing'))
  // Names are unique per REPO — a duplicate is a readable form problem, not a
  // SQLite constraint that surfaces as a 500. The other repo is free to carry
  // the same name, which is what the move feature relies on.
  else if (agentNameTaken(+b.repo_id, name, id ? +id : null)) problems.push(t('agents.name_taken', { name }))
  const def = await runDefFromForm(b, problems)
  const zp = zeitplanAusFormular(b, problems)
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
  const repos = db.prepare('SELECT id,name FROM repos ORDER BY name').all()
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
const SETTINGS_KEYS = ['pipeline_on', 'telegram_token', 'telegram_chat', 'quota_threshold',
  'openrouter_min_eur', 'abo_price', 'cursor_included_usd', 'session_keep_hours', 'flow_runs_keep_days', 'prompt_suffix',
  'llm_check_on', 'llm_check_model', 'llm_check_or_provider',
  'llm_title_on', 'llm_title_model', 'llm_title_or_provider',
  'llm_extras_on', 'llm_extras_model', 'llm_extras_or_provider', 'ui_language']

export async function settingsSave(req, res, url, formBody) {
  const b = await formBody()
  // Write only what the request actually CARRIED. This used to be `b[k] ?? ''`
  // over the whole list, which meant a body with one field blanked the other
  // fifteen — a settings page that saves a fragment at a time would have wiped
  // the Telegram token the first time somebody switched the language. The e2e
  // suite still has to post everything back to change one value; that was the
  // symptom, and this is the cause.
  //
  // Safe for this form because every field here is a text input or a <select>,
  // and both always post a value — an empty text field arrives as ''. It would
  // NOT be safe for a checkbox: an unchecked one is simply absent, so its "off"
  // would read as "not mentioned". A checkbox added here needs a hidden
  // companion field carrying the 0.
  for (const k of SETTINGS_KEYS) {
    if (Object.hasOwn(b, k)) setSetting(k, b[k] ?? '')
  }
  // The language takes effect immediately — the redirect below already renders in it.
  if (Object.hasOwn(b, 'ui_language')) setLanguage(b.ui_language ?? 'en')
  // "Used" means saved: only now does the model enter the MRU list.
  if (Object.hasOwn(b, 'llm_check_model')) llmModellMerken(b.llm_check_model)
  if (Object.hasOwn(b, 'llm_title_model')) rememberTitleModel(b.llm_title_model)
  if (Object.hasOwn(b, 'llm_extras_model')) rememberExtrasModel(b.llm_extras_model)
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
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await layout(req, t('tg.title'), '/settings', body))
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
    if (!j.ok) return jsonOut(res, 200, { ok: false, error: t('tg.api_error', { msg: j.description ?? t('tg.unknown_error') }) })
    const byId = new Map()
    for (const u of j.result ?? []) {
      for (const key of ['message', 'edited_message', 'channel_post', 'my_chat_member']) {
        const chat = u[key]?.chat
        if (!chat) continue
        const text = u[key]?.text || u[key]?.caption || ''
        const label = [chat.first_name, chat.last_name, chat.title, chat.username && '@' + chat.username].filter(Boolean).join(' ')
        const prev = byId.get(chat.id)
        if (!prev) byId.set(chat.id, { id: chat.id, label: label || t('tg.chat_fallback', { id: chat.id }), last_text: text })
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
