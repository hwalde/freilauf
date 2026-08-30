// Freilauf — the Welcome wizard (PLAN §3.12).
//
// A fresh installation has nothing: no coding agent, no model provider, no
// repository. Every page it renders is therefore about something the operator
// has not got yet, and the one document that would fix all of it in ten minutes
// — `SETUP_WITH_AGENT.md`, written to be handed to a coding agent — is a file
// in a checkout nobody has been told about. The wizard is the five screens that
// say so.
//
// It is built in the shape of the notifier setup wizards, and for the same reasons:
//
//   - **Server-rendered steps, never a client-side state machine.** Each step is
//     a `<form method="post">` to an endpoint of its own; what the operator
//     decided lives in `settings`, `plugin_config` and `discovery` from the
//     moment the form is submitted. Closing the tab in the middle of it loses
//     nothing, and a reload cannot show a state the database does not hold.
//   - **Nothing here can create an invalid state.** Every write goes through the
//     functions the Plugins page writes through — `setPluginConfig`,
//     `setPluginProviders`, `setCredential`, `answerDiscovery` — so a value that
//     reaches the database has passed the same validation, and a wizard that is
//     one release behind cannot leave a row the rest of the hub chokes on.
//
// Two rules about getting OUT of it, because a wizard one cannot leave is worse
// than no wizard at all:
//
//   - **"Do not show this again" is on every step, not only the last.** A reader
//     who has seen enough after screen one must be able to say so where they
//     are standing; the checkbox writes `welcome_hide='1'` from wherever it is
//     ticked. It carries the hidden `0` companion this project's settings form
//     was already caught on once — an unticked box is simply ABSENT from a POST
//     body, so without the companion the wizard could never be switched back on.
//   - **"Skip for now" is a session answer, not a permanent one.** `GET /`
//     redirects here while the setting is unset, so a plain link back to `/`
//     would bounce straight into the wizard again. Skipping (and finishing)
//     therefore marks the BROWSER — a session cookie, gone when the browser is —
//     and the redirect honours it. The wizard comes back next time; ticking the
//     box is what makes it stop for good.
import { escapeHtml as e, fmtDateTime } from './util.mjs'
import { getSetting, setSetting } from './db.mjs'
import { redirect } from './web-helpers.mjs'
import { t } from './i18n.mjs'
import { layout, problemPage } from './pages.mjs'
import { allPlugins, getPlugin, pluginKind, pluginSource, detectInstalled } from './plugins/registry.mjs'
import {
  setPluginConfig, setPluginProviders, setCredential,
  pluginConfig, pluginHasCredential, credentialSpec,
} from './plugins/store.mjs'
import { scanSystem, openDiscoveries, answerDiscovery, lastScanAt } from './plugins/discovery.mjs'
import { llmSources, defaultSource } from './llm/sources.mjs'

/** The settings key that switches the wizard off for good. */
export const WELCOME_HIDE = 'welcome_hide'

/** The three settings keys step 4 writes. */
export const LLM_SOURCE_KEYS = ['llm_title_source', 'llm_check_source', 'llm_extras_source']

const STEPS = 5
const HOME = '/'
const SETUP_DOC = 'https://github.com/hwalde/freilauf/blob/main/SETUP_WITH_AGENT.md'
/** The README's FAQ — "can I use my subscription", "what about security", and the rest. */
const README_FAQ = 'https://github.com/hwalde/freilauf#faq'

/** A `<p class="dim">` explanation — the shape the Plugins page uses (PLAN §2). */
const explain = (key) => `<p class="dim">${e(t(key))}</p>`

// ---------------------------------------------------------------------------
// should the wizard be shown at all?
// ---------------------------------------------------------------------------

const SKIP_COOKIE = 'freilauf_welcome'

/** Has this browser said "not now" in the current session? */
export function welcomeSkipped(req) {
  return /(?:^|;\s*)freilauf_welcome=skip(?:;|$)/.test(req?.headers?.cookie ?? '')
}

/**
 * Remember "not now" for this browser session.
 *
 * `set-cookie` is APPENDED, never assigned: `rememberRepo()` writes the same
 * header on the same response, and `setHeader` would silently throw one of the
 * two choices away.
 */
export function markWelcomeSkipped(res) {
  const had = res.getHeader('set-cookie')
  const mine = `${SKIP_COOKIE}=skip; Path=/; SameSite=Lax`
  res.setHeader('set-cookie', had ? [].concat(had, mine) : mine)
}

/**
 * Does a browser navigation to `/` belong in the wizard?
 *
 * Deliberately not asked for API or fragment requests — the caller checks that
 * (`wantsHtml`). A redirect there would answer a JSON fetch with HTML.
 */
export function shouldShowWelcome(req) {
  try {
    if (getSetting(WELCOME_HIDE) === '1') return false
  } catch { return false }   // no database, no wizard — never cost anybody the overview
  return !welcomeSkipped(req)
}

// ---------------------------------------------------------------------------
// the frame every step shares
// ---------------------------------------------------------------------------

/**
 * The "Do not show this again" checkbox, with the companion that makes it
 * switchable in both directions.
 *
 * The hidden field stands BEFORE the box and `parseForm()` keeps the last value
 * of a repeated name: ticked wins, unticked leaves the `0` behind. Without it a
 * form could only ever switch the wizard OFF and never on again.
 */
function hideBox() {
  const on = getSetting(WELCOME_HIDE) === '1'
  return `<div class="welcome-hide">
    <input type="hidden" name="${WELCOME_HIDE}" value="0">
    <label class="chk"><input type="checkbox" name="${WELCOME_HIDE}" value="1" ${on ? 'checked' : ''}> ${e(t('welcome.hide'))}</label>
    <span class="dim">${e(t('welcome.hide_hint'))}</span></div>`
}

/** The one place the checkbox is read, so no step can forget it. */
function applyHide(b) {
  if (Object.hasOwn(b, WELCOME_HIDE)) setSetting(WELCOME_HIDE, b[WELCOME_HIDE] === '1' ? '1' : '0')
}

/** "Step 3 of 5", the Back link where there is a step behind, and the Skip link. */
function stepNav(step, { backHref = null, nextLabel = null, nextHref = null } = {}) {
  const back = step > 1
    ? `<a class="btn ghost" href="${e(backHref ?? `/welcome?step=${step - 1}`)}">${e(t('welcome.back'))}</a>` : ''
  const next = nextHref
    ? `<a class="btn ghost" href="${e(nextHref)}">${e(nextLabel ?? t('welcome.next'))}</a>` : ''
  return `<div class="btn-row welcome-nav">
    ${back}${next}
    <a class="ghost" href="${HOME}?welcome=skip">${e(t('welcome.skip'))}</a>
    <span class="dim">${e(t('welcome.step_of', { n: step, total: STEPS }))}</span></div>`
}

/** The pointer this whole wizard exists to make: hand the setup to an agent. */
function setupDocCard() {
  return `<div class="card">
    <h3>${e(t('welcome.s1_agent_title'))}</h3>
    <p>${e(t('welcome.s1_agent_body'))}</p>
    <p><code>SETUP_WITH_AGENT.md</code> — <a href="${e(SETUP_DOC)}" target="_blank" rel="noreferrer noopener">${e(t('welcome.s1_agent_link'))}</a></p>
  </div>`
}

// ---------------------------------------------------------------------------
// step 1 — hello
// ---------------------------------------------------------------------------

function step1() {
  // The first screen is the pitch, not the manual: the tagline, the "imagine"
  // paragraph, and the one paragraph that explains the name — a freewheel is a
  // ratchet, free and only ever forward. The manual is what the next steps are.
  return `<div class="card">
      <h3>${e(t('welcome.s1_title'))}</h3>
      <p>${e(t('welcome.s1_body'))}</p>
    </div>
    <div class="card">
      <h3>${e(t('welcome.s1_why_title'))}</h3>
      <p>${e(t('welcome.s1_why_body'))}</p>
    </div>
    ${setupDocCard()}
    <form method="post" action="/welcome/hello" class="form-grid">
      ${hideBox()}
      <div class="btn-row"><button>${e(t('welcome.next'))}</button></div>
    </form>
    ${stepNav(1)}`
}

// ---------------------------------------------------------------------------
// step 2 — what is on this machine
// ---------------------------------------------------------------------------

/**
 * Every registered coding agent with what the machine says about it.
 *
 * The discovery rows are the reason this step exists, but they are not the
 * whole list: a discovery row disappears once it has been answered, and an
 * operator who dismissed one yesterday must still be able to switch that agent
 * on today. So the list is the REGISTRY, and discovery only decides what is
 * pre-ticked.
 */
async function harnessRows() {
  let installed = []
  try { installed = await detectInstalled() } catch { installed = [] }
  const installedById = new Map(installed.map(i => [i.id, !!i.installed]))
  let open = []
  try { open = openDiscoveries() } catch { open = [] }
  const found = new Set(open.filter(r => r.kind === 'harness').map(r => r.plugin_id))

  return allPlugins().filter(p => p.kind === 'harness').map(({ id, plugin }) => {
    const configured = !!pluginConfig(id)
    return {
      id,
      plugin,
      installed: installedById.get(id) ?? false,
      configured,
      // Pre-ticked when the machine has it and the hub does not use it yet:
      // that is exactly the suggestion the operator came here for.
      suggest: !configured && (found.has(id) || installedById.get(id) === true),
    }
  })
}

async function step2() {
  const rows = await harnessRows()
  const scanned = lastScanAt()

  const boxes = rows.map(r => {
    const state = r.configured
      ? `<span class="ok">✓ ${e(t('welcome.s2_configured'))}</span>`
      : r.installed
        ? `<span class="ok">✓ ${e(t('welcome.s2_found_bin', { bin: r.plugin.bin ?? r.id }))}</span>`
        : `<span class="dim">${e(t('welcome.s2_not_found'))}</span>`
    return `<label class="chk">
      <input type="checkbox" name="add" value="${e(r.id)}" ${r.suggest ? 'checked' : ''}>
      <b>${e(r.plugin.label ?? r.id)}</b> ${state}</label>`
  }).join('')

  // Provider credentials are found by the same scan but belong to the next
  // step; naming them here is what makes step 3 feel like a consequence rather
  // than a new question.
  let providersFound = []
  try {
    providersFound = openDiscoveries().filter(r => r.kind === 'provider')
      .map(r => r.plugin?.label ?? r.plugin_id)
  } catch { providersFound = [] }

  return `<div class="card">
      <h3>${e(t('welcome.s2_title'))}</h3>
      ${explain('welcome.s2_explain')}
      <div class="btn-row">
        <form method="post" action="/welcome/scan" class="inline"><button class="ghost">${e(t('welcome.s2_scan'))}</button></form>
        <span class="dim">${e(scanned ? t('welcome.s2_last_scan', { at: fmtDateTime(Date.parse(scanned)) }) : t('welcome.s2_never_scanned'))}</span>
      </div>
      <form method="post" action="/welcome/agents" class="form-grid">
        ${boxes || `<p class="dim">${e(t('welcome.s2_none'))}</p>`}
        ${providersFound.length ? `<p class="dim">${e(t('welcome.s2_providers_found', { names: providersFound.join(', ') }))}</p>` : ''}
        ${hideBox()}
        <div class="btn-row"><button>${e(t('welcome.next'))}</button></div>
      </form>
    </div>
    ${stepNav(2)}`
}

// ---------------------------------------------------------------------------
// step 3 — a model provider
// ---------------------------------------------------------------------------

/**
 * The credential fields of one plugin.
 *
 * A deliberately reduced twin of the Plugins page's `credentialsBlock()`: the
 * same FIELD NAMES (`cred_<key>_mode|_env|_value`), the same i18n keys and the
 * same writer (`setCredential`), so what the wizard stores and what the Plugins
 * page stores cannot mean two different things. It renders only the credentials
 * a provider declares, and — like there — the value field is never pre-filled
 * and an empty submit means "keep what is stored".
 */
function credentialFields(pluginId, plugin, env = process.env) {
  const specs = credentialSpec(plugin)
  if (!specs.length) return `<p class="dim">${e(t('welcome.s3_no_credential'))}</p>`
  return specs.map(spec => {
    const entry = pluginConfig(pluginId)?.config.credentials?.[spec.key] ?? null
    const mode = entry?.mode === 'value' ? 'value' : 'env'
    const declaredHit = (spec.envKeys ?? []).find(name => env[name])
    const status = declaredHit
      ? `<span class="ok">✓ ${e(t('plugins.cred_present_env', { name: declaredHit }))}</span>`
      : (entry?.mode === 'value' && String(entry.value ?? '').trim()
        ? `<span class="ok">✓ ${e(t('plugins.cred_present_stored'))}</span>`
        : `<span class="dim">${e(t('plugins.cred_missing'))}</span>`)
    return `<div class="cred">
      <b>${e(t(spec.labelKey))}</b> ${status}
      ${(spec.envKeys ?? []).length ? `<p class="dim">${e(t('plugins.cred_declared', { names: spec.envKeys.join(', ') }))}</p>` : ''}
      ${spec.helpKey ? `<p class="dim">${e(t(spec.helpKey))}</p>` : ''}
      <label>${e(t('plugins.cred_mode'))}
        <select name="cred_${e(spec.key)}_mode">
          <option value="env" ${mode === 'env' ? 'selected' : ''}>${e(t('plugins.cred_mode_env'))}</option>
          <option value="value" ${mode === 'value' ? 'selected' : ''}>${e(t('plugins.cred_mode_value'))}</option>
        </select></label>
      <label>${e(t('plugins.cred_envvar'))}
        <input type="text" name="cred_${e(spec.key)}_env" value="${e(entry?.envVar ?? (spec.envKeys ?? [])[0] ?? '')}" autocomplete="off" spellcheck="false">
        <span class="dim">${e(t('plugins.cred_envvar_hint'))}</span></label>
      <label>${e(t('plugins.cred_value'))}
        <input type="password" name="cred_${e(spec.key)}_value" value="" autocomplete="new-password">
        <span class="dim">${e(t('plugins.cred_value_hint'))}</span></label>
    </div>`
  }).join('')
}

/**
 * The providers, the ones whose credential was already found first.
 *
 * That order is the whole point of the scan: an operator with an
 * `OPENROUTER_API_KEY` in their environment should meet OpenRouter at the top
 * of the list, not somewhere in it.
 */
function providerChoices() {
  return allPlugins().filter(p => p.kind === 'provider')
    .map(p => ({ ...p, hasKey: (() => { try { return pluginHasCredential(p.id) } catch { return false } })() }))
    .sort((a, b) => (Number(b.hasKey) - Number(a.hasKey)) || String(a.plugin.label ?? a.id).localeCompare(String(b.plugin.label ?? b.id)))
}

function step3(url) {
  const choices = providerChoices()
  if (!choices.length) {
    return `<div class="card"><h3>${e(t('welcome.s3_title'))}</h3>
      ${explain('welcome.s3_explain')}
      <p class="dim">${e(t('welcome.s3_none'))}</p></div>
      ${stepNav(3, { nextHref: '/welcome?step=4' })}`
  }
  // Which provider's form is open is a question about the URL, not about the
  // client: picking one is a link, so a reload shows the same screen and the
  // Back button walks the choice backwards like any other page.
  const wanted = String(url?.searchParams?.get('provider') ?? '').trim()
  const selected = choices.find(c => c.id === wanted) ?? choices[0]

  const list = choices.map(c => {
    const on = c.id === selected.id
    const mark = c.hasKey
      ? `<span class="ok">✓ ${e(t('welcome.s3_key_found'))}</span>`
      : `<span class="dim">${e(t('welcome.s3_no_key'))}</span>`
    return `<li>${on
      ? `<b>${e(c.plugin.label ?? c.id)}</b>`
      : `<a href="/welcome?step=3&amp;provider=${encodeURIComponent(c.id)}">${e(c.plugin.label ?? c.id)}</a>`} ${mark}
      ${c.plugin.descriptionKey ? `<span class="dim">${e(t(c.plugin.descriptionKey))}</span>` : ''}</li>`
  }).join('')

  return `<div class="card">
      <h3>${e(t('welcome.s3_title'))}</h3>
      ${explain('welcome.s3_explain')}
      <p>${e(t('welcome.s3_pick'))}</p>
      <ul class="welcome-choices">${list}</ul>
    </div>
    <div class="card ok">
      <h3>${e(selected.plugin.label ?? selected.id)}</h3>
      ${selected.plugin.descriptionKey ? `<p class="dim">${e(t(selected.plugin.descriptionKey))}</p>` : ''}
      <form method="post" action="/welcome/provider" class="form-grid">
        <input type="hidden" name="id" value="${e(selected.id)}">
        <fieldset><legend>${e(t('plugins.credentials_legend'))}</legend>
          ${explain('plugins.credentials_explain')}
          ${credentialFields(selected.id, selected.plugin)}</fieldset>
        ${hideBox()}
        <div class="btn-row"><button>${e(t('welcome.s3_save'))}</button></div>
      </form>
    </div>
    ${stepNav(3, { nextHref: '/welcome?step=4', nextLabel: t('welcome.s3_later') })}`
}

// ---------------------------------------------------------------------------
// step 4 — the hub's own questions
// ---------------------------------------------------------------------------

/** One `<select>` over the available sources, marked and warned as PLAN §2 says. */
function sourceSelect(name, current, sources) {
  const options = sources.map(s => {
    const marks = [
      s.overhead ? t('welcome.s4_agent_marker') : '',
      s.ready ? '' : t('welcome.s4_not_ready'),
    ].filter(Boolean).join(', ')
    return `<option value="${e(s.id)}" ${s.id === current ? 'selected' : ''}>${e(s.label)}${marks ? ` (${e(marks)})` : ''}</option>`
  }).join('')
  return `<select name="${e(name)}">${options}</select>`
}

function step4() {
  let sources = []
  try { sources = llmSources() } catch { sources = [] }
  if (!sources.length) {
    return `<div class="card"><h3>${e(t('welcome.s4_title'))}</h3>
      ${explain('welcome.s4_explain')}
      <p class="dim">${e(t('welcome.s4_none'))}</p></div>
      ${stepNav(4, { nextHref: '/welcome?step=5' })}`
  }
  const known = new Set(sources.map(s => s.id))
  const stored = LLM_SOURCE_KEYS.map(k => (getSetting(k) ?? '').trim() || defaultSource())
  // A stored source whose plugin is gone must not silently select something
  // else in the markup while the database still says otherwise — fall back to
  // the first offered source, which is what the form would then write.
  const pick = (v) => (known.has(v) ? v : sources[0].id)
  const [title, check, extras] = stored.map(pick)
  const same = title === check && check === extras

  // The overhead sentence is rendered whenever a coding-agent source is on
  // offer at all, and called out when one is actually chosen. Without client
  // JavaScript that is the honest version: hiding it until a change event that
  // never fires would mean never showing it.
  const anyOverhead = sources.some(s => s.overhead)
  const chosenOverhead = sources.filter(s => s.overhead).some(s => [title, check, extras].includes(s.id))
  const warning = anyOverhead
    ? `<p class="${chosenOverhead ? 'warn' : 'dim'}">${e(t('welcome.s4_overhead'))}</p>` : ''

  // `details.goal` is this project's existing rule for a folded block inside a
  // form-grid (the second prompt, the Quick-Run branch rule): a margin and a
  // summary that looks clickable. Reused rather than asking for a stylesheet of
  // its own — the three per-question selects are optional exactly the way those
  // are, and most operators pick one source for all three and never open it.
  return `<div class="card">
      <h3>${e(t('welcome.s4_title'))}</h3>
      ${explain('welcome.s4_explain')}
      <form method="post" action="/welcome/llm" class="form-grid">
        <input type="hidden" name="same" value="0">
        <label class="chk"><input type="checkbox" name="same" value="1" ${same ? 'checked' : ''}> ${e(t('welcome.s4_same'))}</label>
        <label>${e(t('welcome.s4_source'))} ${sourceSelect('source', title, sources)}</label>
        ${warning}
        <details class="goal" ${same ? '' : 'open'}>
          <summary>${e(t('welcome.s4_separate'))}</summary>
          <label>${e(t('welcome.s4_title_q'))} ${sourceSelect('source_title', title, sources)}</label>
          <label>${e(t('welcome.s4_check_q'))} ${sourceSelect('source_check', check, sources)}</label>
          <label>${e(t('welcome.s4_extras_q'))} ${sourceSelect('source_extras', extras, sources)}</label>
          <p class="dim">${e(t('welcome.s4_separate_hint'))}</p>
        </details>
        ${hideBox()}
        <div class="btn-row"><button>${e(t('welcome.next'))}</button></div>
      </form>
    </div>
    ${stepNav(4)}`
}

// ---------------------------------------------------------------------------
// step 5 — done
// ---------------------------------------------------------------------------

function step5() {
  return `<div class="card ok">
      <h3>${e(t('welcome.s5_title'))}</h3>
      <p>${e(t('welcome.s5_body'))}</p>
      <div class="btn-row">
        <a class="btn" href="/repos">${e(t('welcome.s5_repo'))}</a>
        <a class="btn" href="/agents">${e(t('welcome.s5_agent'))}</a>
        <a class="btn ghost" href="/settings/plugins">${e(t('welcome.s5_plugins'))}</a>
        <a class="btn ghost" href="/settings/notifications">${e(t('welcome.s5_notify'))}</a>
      </div>
      <p class="dim">${e(t('notify.optional'))}</p>
      <p class="dim">${e(t('welcome.s5_faq_hint'))} <a href="${e(README_FAQ)}" target="_blank" rel="noreferrer noopener">README → FAQ</a></p>
    </div>
    ${setupDocCard()}
    <form method="post" action="/welcome/done" class="form-grid">
      ${hideBox()}
      <div class="btn-row"><button>${e(t('welcome.finish'))}</button></div>
    </form>
    ${stepNav(5)}`
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

/** `GET /welcome[?step=1..5]` — always reachable, whatever `welcome_hide` says. */
export async function pageWelcome(req, res, url) {
  const raw = Number(url?.searchParams?.get('step') ?? 1)
  const step = Number.isInteger(raw) && raw >= 1 && raw <= STEPS ? raw : 1
  const body = step === 1 ? step1()
    : step === 2 ? await step2()
      : step === 3 ? step3(url)
        : step === 4 ? step4()
          : step5()
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(await layout(req, t('welcome.title'), '/welcome', `<h2>${e(t('welcome.title'))}</h2>${body}`))
}

// ---------------------------------------------------------------------------
// the step endpoints
// ---------------------------------------------------------------------------

const to = (res, step) => redirect(res, `/welcome?step=${step}`)

/** Step 1 → 2. It stores nothing but the checkbox. */
export async function welcomeHello(req, res, url, formBody) {
  applyHide(await formBody())
  to(res, 2)
}

/** "Scan again" — re-read the machine and come back to step 2. */
export async function welcomeScan(req, res, url, formBody) {
  applyHide(await formBody())
  try { await scanSystem() } catch (err) { console.warn('[welcome] scan failed:', err.message) }
  to(res, 2)
}

/**
 * Step 2 → 3: switch on the coding agents that were ticked.
 *
 * Every open harness finding is ANSWERED here, ticked or not — that is what
 * "the operator is asked once" means (discovery.mjs): a box left empty is a
 * decision, and leaving the row open would bring the banner back tomorrow.
 */
export async function welcomeAgents(req, res, url, formBody) {
  const b = await formBody()
  applyHide(b)
  const wanted = new Set((b.add_list ?? (b.add ? [b.add] : [])).map(String))
  // The open findings are collected BEFORE anything is configured:
  // `openDiscoveries()` hides a row whose plugin now HAS a configuration, so
  // asking it afterwards would return exactly the ones that were not ticked and
  // the accepted suggestions would stay unanswered forever.
  let open = []
  try { open = openDiscoveries().filter(r => r.kind === 'harness') } catch { open = [] }

  const problems = []
  for (const id of wanted) {
    const plugin = getPlugin(id)
    if (!plugin || pluginKind(id) !== 'harness') { problems.push(t('welcome.problem_unknown', { id })); continue }
    setPluginConfig(id, { kind: 'harness', source: pluginSource(id) ?? 'builtin', enabled: 1 })
    setPluginProviders(id, plugin.providers ?? [])   // drops anything the plugin does not declare
  }
  if (problems.length) return problemPage(req, res, t('welcome.title'), problems, '/welcome?step=2')
  try {
    for (const row of open) answerDiscovery(row.id, wanted.has(row.plugin_id) ? 'added' : 'dismissed')
  } catch (err) { console.warn('[welcome] discovery answer failed:', err.message) }
  to(res, 3)
}

/**
 * Step 3 → 4: enable one model provider and store how its credential is found.
 *
 * `setCredential()` is the same writer the Plugins page uses, including its
 * rule that an empty password field means "keep what is stored" — so walking
 * through the wizard a second time cannot wipe a key that is already there.
 */
export async function welcomeProvider(req, res, url, formBody) {
  const b = await formBody()
  applyHide(b)
  const id = String(b.id ?? '').trim()
  const plugin = getPlugin(id)
  if (!plugin || pluginKind(id) !== 'provider') {
    return problemPage(req, res, t('welcome.title'), [t('welcome.problem_unknown', { id })], '/welcome?step=3')
  }
  setPluginConfig(id, { kind: 'provider', source: pluginSource(id) ?? 'builtin', enabled: 1 })
  for (const spec of credentialSpec(plugin)) {
    setCredential(id, spec.key, {
      mode: b[`cred_${spec.key}_mode`] === 'value' ? 'value' : 'env',
      envVar: b[`cred_${spec.key}_env`] ?? '',
      value: b[`cred_${spec.key}_value`] ?? '',
    })
  }
  // Setting a provider up here IS the answer to the scan's suggestion about it.
  try { answerDiscovery(`provider:${id}`, 'added') } catch { /* a finding is a nicety, never a failure */ }
  to(res, 4)
}

/**
 * Step 4 → 5: which source answers the hub's own questions.
 *
 * A source that is not on offer is refused rather than stored: the three keys
 * fall back to `provider:openrouter` when they hold something unreadable, so a
 * silently rejected value would look like a saved one and behave like the
 * default forever.
 */
export async function welcomeLlm(req, res, url, formBody) {
  const b = await formBody()
  applyHide(b)
  let sources = []
  try { sources = llmSources() } catch { sources = [] }
  const known = new Set(sources.map(s => s.id))
  const same = b.same === '1'
  const chosen = same
    ? [b.source, b.source, b.source]
    : [b.source_title, b.source_check, b.source_extras]
  const problems = []
  for (const value of chosen) {
    const v = String(value ?? '').trim()
    if (v && !known.has(v)) problems.push(t('welcome.problem_source', { source: v }))
  }
  if (problems.length) return problemPage(req, res, t('welcome.title'), problems, '/welcome?step=4')
  LLM_SOURCE_KEYS.forEach((key, i) => {
    const v = String(chosen[i] ?? '').trim()
    if (v) setSetting(key, v)
  })
  to(res, 5)
}

/**
 * "Finished" — and out. The session mark is what keeps a wizard the operator
 * has just walked through from greeting them again on the very next page.
 */
export async function welcomeDone(req, res, url, formBody) {
  applyHide(await formBody())
  markWelcomeSkipped(res)
  redirect(res, HOME)
}
