// cc-hub — the Welcome wizard (PLAN §3.12).
//
// A fresh installation has nothing: no coding agent, no model provider, no
// repository. Every page it renders is therefore about something the operator
// has not got yet, and the one document that would fix all of it in ten minutes
// — `SETUP_WITH_AGENT.md`, written to be handed to a coding agent — is a file
// in a checkout nobody has been told about. The wizard is the five screens that
// say so.
//
// It is built in the shape of `/telegram-setup`, and for the same reasons:
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
// ---------------------------------------------------------------------------
// What the first walkthrough taught us, and what this file now does about it
// ---------------------------------------------------------------------------
//
// The owner walked the first version end to end and got lost twice. Both
// findings are structural, so both are answered structurally rather than with
// better wording:
//
// **1. "Save" felt like it did nothing.** Every step carried several buttons —
// a submit, a ghost "Continue", a "Back", a "Skip", a scan — and the submit was
// labelled with the neutral "Continue". Whether a click had SAVED anything was
// nowhere visible, so the reader kept pressing it. The rule now:
//
//   - **one question per step, one primary button**, and that button both saves
//     and advances. It is labelled as what it does ("Save and continue"), never
//     a bare "Save" that lands you back where you were;
//   - **the next step opens by naming what was just decided** (`ackAgents`,
//     `ackProvider`, `ackSources`). Those acknowledgements are read back OUT OF
//     THE DATABASE, not carried in a flash message — so they cannot congratulate
//     the operator on something that was not stored, and a reload shows the same
//     truth. A step that stored nothing says THAT instead, which is still an
//     observable consequence of the click.
//
// **2. There must be no way to wander out of the initial setup.** The wizard
// rendered through `layout()`, which draws the whole hub around it: the nav, the
// repo switcher, the Quick-Run button — plus a "Skip for now" link and a "Do not
// show this again" checkbox on every single step. Six ways out of a five-step
// setup, three of them tempting the reader into a hub that cannot do anything
// yet.
//
// So the wizard has **two modes**, and which one it is in is not a new fact but
// the one that was always there:
//
// | mode | when | what it looks like |
// |---|---|---|
// | **locked** | the wizard is what `GET /` sends a browser to, and it has never been walked to the end | its own minimal shell: brand, step counter, content. No nav, no repo switcher, no Quick Run, no banners. No "skip" link, no "do not show this again" — except the one deliberate exit on step 1 and the checkbox on the last step |
// | **unlocked** | anything else — completed, or the operator has already said "stop showing me this", or skipped for this session | an ordinary page through `layout()`: full navigation, a way back to the hub, the skip link and the checkbox on every step |
//
// `welcomeLocked()` is that one line: `shouldShowWelcome(req) && !welcomeCompleted()`.
// Which means lock-in and forced redirect are the SAME condition — the hub never
// locks somebody into a page it did not send them to. A returning operator who
// opens `/welcome` deliberately gets a normal page with navigation, which is
// exactly the "must not be trapped again" requirement, and it falls out of the
// rule instead of needing a second flag to be kept in sync.
//
// **Why its own shell rather than a parameter to `layout()`.** `layout()` takes
// no such parameter, and adding one would mean every page could half-hide the
// header — a knob nothing else wants. The shell here is fourteen lines, uses the
// same stylesheet, and ships no JavaScript at all, which is what the wizard was
// specified as anyway (no client state machine). Anything it leaves out — the
// setup banner, the discovery banner, the sidebar, the SSE channel, the toasts —
// is furniture about a hub that is not configured yet.
//
// **Two settings keys, two different statements** — this is the third finding:
//
//   - `welcome_hide` = "stop sending me here" — it is what `GET /` reads, and it
//     is the checkbox. It carries the hidden `0` companion this project's
//     settings form was already caught on once: an unticked box is simply ABSENT
//     from a POST body, so without the companion the wizard could never be
//     switched back on.
//   - `welcome_done` = "this was walked to the end" — written by the last step
//     and by nothing else. It is what unlocks the page for good.
//
// They are deliberately not one key. Ticking the box on the last step is a
// preference about being greeted; finishing is a fact about the setup. Finishing
// pre-ticks the box (you have just seen all of it — being greeted again on the
// next page load is the noise the box exists to stop) but leaves it a box, so an
// operator who wants the wizard back next time only has to untick it.
//
// **The one way out while locked** stands on step 1, before anything has been
// decided, as a card of its own with a heading and the honest consequence
// spelled out. Not a link in a row of links: leaving is a decision, and the
// price of it — a hub that cannot start a run yet — is named where it is made.
// From step 2 on there is Back, and Back walks to step 1.
import { escapeHtml as e, fmtDateTime } from './util.mjs'
import { getSetting, setSetting } from './db.mjs'
import { redirect } from './web-helpers.mjs'
import { t, currentLanguage } from './i18n.mjs'
import { layout, problemPage } from './pages.mjs'
import { allPlugins, getPlugin, pluginKind, pluginSource, detectInstalled } from './plugins/registry.mjs'
import {
  setPluginConfig, setPluginProviders, setCredential,
  pluginConfig, isPluginEnabled, pluginHasCredential, credentialSpec,
} from './plugins/store.mjs'
import { scanSystem, openDiscoveries, answerDiscovery, lastScanAt } from './plugins/discovery.mjs'
import { llmSources, defaultSource } from './llm/sources.mjs'

/** The settings key that stops `GET /` from sending a browser here. */
export const WELCOME_HIDE = 'welcome_hide'

/**
 * The settings key that says the wizard was walked to the end.
 *
 * Distinct from `WELCOME_HIDE` on purpose (see the header): hiding is a
 * preference, finishing is a fact, and only the fact may unlock the page.
 */
export const WELCOME_DONE = 'welcome_done'

/** The three settings keys step 4 writes. */
export const LLM_SOURCE_KEYS = ['llm_title_source', 'llm_check_source', 'llm_extras_source']

const STEPS = 5
const HOME = '/'
const SKIP_HREF = '/?welcome=skip'
const SETUP_DOC = 'https://github.com/hwalde/cc-hub/blob/main/SETUP_WITH_AGENT.md'

/** A `<p class="dim">` explanation — the shape the Plugins page uses (PLAN §2). */
const explain = (key) => `<p class="dim">${e(t(key))}</p>`

/** The acknowledgement card a step opens with: what the previous click stored. */
const ack = (text) => `<div class="card ok"><p>✓ ${e(text)}</p></div>`

// ---------------------------------------------------------------------------
// should the wizard be shown at all, and is the operator locked into it?
// ---------------------------------------------------------------------------

const SKIP_COOKIE = 'cchub_welcome'

/** Has this browser said "not now" in the current session? */
export function welcomeSkipped(req) {
  return /(?:^|;\s*)cchub_welcome=skip(?:;|$)/.test(req?.headers?.cookie ?? '')
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

/** Was the wizard ever walked to its last step? */
export function welcomeCompleted() {
  try { return getSetting(WELCOME_DONE) === '1' } catch { return true }
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

/**
 * Is this reader IN the initial setup, rather than visiting the page?
 *
 * Exactly the condition under which `GET /` would have sent them here, minus a
 * wizard that has already been finished. The hub therefore never locks anybody
 * into a page it did not put them on, and a completed wizard is an ordinary
 * page — which is the whole "do not trap a returning operator" rule, expressed
 * once instead of guarded everywhere.
 */
export function welcomeLocked(req) {
  return shouldShowWelcome(req) && !welcomeCompleted()
}

// ---------------------------------------------------------------------------
// the frame every step shares
// ---------------------------------------------------------------------------

/**
 * The wizard's own shell, used while the reader is locked into the setup.
 *
 * Everything `layout()` draws around a page is an invitation to leave: the nav,
 * the repo switcher, the Quick-Run button, the setup and discovery banners. None
 * of them lead anywhere useful before the setup is done, and the first
 * walkthrough got lost in exactly them. So the locked wizard renders its own
 * document — same stylesheet, same favicon, no JavaScript (it needs none, which
 * was the specification anyway) and no way out but the one it offers itself.
 */
function wizardShell(step, body) {
  const crumbs = Array.from({ length: STEPS }, (_, i) => {
    const label = e(t(`welcome.nav_${i + 1}`))
    return i + 1 === step ? `<b>${label}</b>` : `<span class="dim">${label}</span>`
  }).join(' <span class="dim">›</span> ')
  return `<!doctype html><html lang="${e(currentLanguage())}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cc-hub — ${e(t('welcome.title'))}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f6fed'/%3E%3Cpath d='M9 11l5 5-5 5' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M17 21h7' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/hub.css"></head>
<body>
<header>
  <span class="brand">cc-hub</span>
  <span>${e(t('welcome.title'))}</span>
  <span class="spacer"></span>
  <span>${e(t('welcome.step_of', { n: step, total: STEPS }))}</span>
</header>
<main><p class="welcome-crumbs">${crumbs}</p>${body}</main>
</body></html>`
}

/**
 * "Do not show this again", with the companion that makes it switchable in both
 * directions.
 *
 * The hidden field stands BEFORE the box and `parseForm()` keeps the last value
 * of a repeated name: ticked wins, unticked leaves the `0` behind. Without it a
 * form could only ever switch the wizard OFF and never on again.
 *
 * `defaultOn` is for the last step of a first walkthrough, where nothing is
 * stored yet and the honest default is "you have just seen all of it".
 */
function hideBox(defaultOn = false) {
  const stored = getSetting(WELCOME_HIDE)
  const on = stored == null || stored === '' ? defaultOn : stored === '1'
  return `<div class="welcome-hide">
    <input type="hidden" name="${WELCOME_HIDE}" value="0">
    <label class="chk"><input type="checkbox" name="${WELCOME_HIDE}" value="1" ${on ? 'checked' : ''}> ${e(t('welcome.hide'))}</label>
    <span class="dim">${e(t('welcome.hide_hint'))}</span></div>`
}

/**
 * The checkbox where it belongs.
 *
 * While the reader is locked in it exists only on the LAST step — that is where
 * the offer to leave belongs, and a "do not show this again" on step 2 is an
 * escape hatch dressed as a preference. On an unlocked page it is an ordinary
 * setting and stands on every step, where it can be switched in both directions.
 */
function hideField(ctx, step) {
  if (!ctx.locked) return hideBox()
  return step === STEPS ? hideBox(true) : ''
}

/** The one place the checkbox is read, so no step can forget it. */
function applyHide(b) {
  if (Object.hasOwn(b, WELCOME_HIDE)) setSetting(WELCOME_HIDE, b[WELCOME_HIDE] === '1' ? '1' : '0')
}

/** The primary button — it SAVES and it ADVANCES, and it is labelled as both. */
function primary(label, ctx, step) {
  const back = step > 1
    ? `<a class="btn ghost" href="/welcome?step=${step - 1}">${e(t('welcome.back'))}</a>` : ''
  return `<div class="btn-row"><button>${e(label)}</button>${back}</div>`
}

/**
 * The footer under a step: where the reader stands, and — on an unlocked page —
 * the ordinary ways off it.
 *
 * The step counter is the only thing a locked step gets. The skip link and the
 * link back into the hub exist only where the wizard is not the initial setup
 * any more; while it is, the one exit stands on step 1 and says what it costs.
 */
function stepFoot(ctx, step) {
  if (ctx.locked) return `<p class="dim">${e(t('welcome.step_of', { n: step, total: STEPS }))}</p>`
  return `<div class="btn-row welcome-nav">
    <a class="ghost" href="${SKIP_HREF}">${e(t('welcome.skip'))}</a>
    <a class="ghost" href="${HOME}">${e(t('welcome.back_to_hub'))}</a>
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

/**
 * The single deliberate way out of a locked setup, on step 1 and nowhere else.
 *
 * A card with a heading, the consequence in plain words and one clearly-labelled
 * button — the shape a decision has. The previous version was a `<a class=ghost>`
 * in a row with "Back" and "Continue", which is the shape a stray link has.
 */
function leaveCard() {
  return `<div class="card">
    <h3>${e(t('welcome.leave_title'))}</h3>
    <p class="dim">${e(t('welcome.leave_body'))}</p>
    <div class="btn-row"><a class="btn ghost" href="${SKIP_HREF}">${e(t('welcome.leave_btn'))}</a></div>
  </div>`
}

/** The note an unlocked visitor gets: this is a page, not a cage. */
function revisitNote() {
  return `<div class="banner other-repo">${e(t('welcome.revisit_note'))}
    <a class="btn" href="${HOME}">${e(t('welcome.back_to_hub'))}</a></div>`
}

// ---------------------------------------------------------------------------
// what was decided so far — read back out of the database, never carried
// ---------------------------------------------------------------------------

/** The coding agents that are configured AND switched on, by label. */
function enabledHarnessLabels() {
  try {
    return allPlugins().filter(p => p.kind === 'harness')
      .filter(p => !!pluginConfig(p.id) && isPluginEnabled(p.id))
      .map(p => p.plugin.label ?? p.id)
  } catch { return [] }
}

/**
 * The model providers the operator has actually configured.
 *
 * `pluginConfig(id)` has to exist: an unconfigured provider answers
 * `isPluginEnabled` with `true` (providers were always usable the moment their
 * key existed), so asking that alone would report every registered provider as
 * a decision the operator never made.
 */
function configuredProviders() {
  try {
    return allPlugins().filter(p => p.kind === 'provider')
      .filter(p => !!pluginConfig(p.id) && isPluginEnabled(p.id))
  } catch { return [] }
}

/** Step 3 opens with what step 2 stored. */
function ackAgents() {
  const names = enabledHarnessLabels()
  return names.length
    // Deliberately without a count: "3 coding agents" would need a plural rule
    // in three catalogs to be right at one, and the NAMES are the
    // acknowledgement the reader came for anyway.
    ? ack(t('welcome.ack_agents', { names: names.join(', ') }))
    : ack(t('welcome.ack_agents_none'))
}

/** Step 4 opens with what step 3 stored. */
function ackProvider() {
  const rows = configuredProviders()
  if (!rows.length) return ack(t('welcome.ack_provider_none'))
  const names = rows.map(p => {
    const label = p.plugin.label ?? p.id
    let key = false
    try { key = pluginHasCredential(p.id) } catch { key = false }
    return key ? t('welcome.ack_provider_key', { name: label }) : label
  })
  return ack(t('welcome.ack_provider', { names: names.join(', ') }))
}

/** Step 5 opens with what step 4 stored. */
function ackSources() {
  let sources = []
  try { sources = llmSources() } catch { sources = [] }
  if (!sources.length) return ack(t('welcome.ack_llm_none'))
  const byId = new Map(sources.map(s => [s.id, s.label]))
  const chosen = LLM_SOURCE_KEYS.map(k => (getSetting(k) ?? '').trim() || defaultSource())
  const label = (id) => byId.get(id) ?? id
  return chosen[0] === chosen[1] && chosen[1] === chosen[2]
    ? ack(t('welcome.ack_llm_all', { name: label(chosen[0]) }))
    : ack(t('welcome.ack_llm_split', {
      title: label(chosen[0]), check: label(chosen[1]), extras: label(chosen[2]),
    }))
}

// ---------------------------------------------------------------------------
// step 1 — hello
// ---------------------------------------------------------------------------

function step1(ctx) {
  return `<div class="card">
      <h3>${e(t('welcome.s1_title'))}</h3>
      <p>${e(t('welcome.s1_body'))}</p>
    </div>
    ${setupDocCard()}
    <form method="post" action="/welcome/hello" class="form-grid">
      ${hideField(ctx, 1)}
      ${primary(t('welcome.start_btn'), ctx, 1)}
    </form>
    ${ctx.locked ? leaveCard() : ''}
    ${stepFoot(ctx, 1)}`
}

// ---------------------------------------------------------------------------
// step 2 — which coding agents may the hub use
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
      // Already switched on — the step states that as a FACT and offers no
      // checkbox for it. A box one can untick that does not switch anything off
      // would be the "I click and nothing happens" complaint one step further
      // on; and a wizard that switches a working coding agent off because a box
      // was left empty is worse than either. Both are settled by not drawing the
      // control: the wizard adds, and Settings → Plugins is where things are
      // taken away.
      on: configured && isPluginEnabled(id),
      configured,
      // Pre-ticked when the machine has it and the hub does not use it yet:
      // that is exactly the suggestion the operator came here for.
      suggest: !configured && (found.has(id) || installedById.get(id) === true),
    }
  })
}

async function step2(ctx) {
  const rows = await harnessRows()
  const scanned = lastScanAt()
  const anyFound = rows.some(r => r.installed || r.configured)

  const already = rows.filter(r => r.on).map(r => `<p class="ok">✓ <b>${e(r.plugin.label ?? r.id)}</b> — ${e(t('welcome.s2_configured'))}</p>`).join('')
  const boxes = rows.filter(r => !r.on).map(r => {
    const state = r.installed
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
      <p>${e(t(anyFound ? 'welcome.s2_lead' : 'welcome.s2_lead_empty'))}</p>
      ${explain('welcome.s2_explain')}
      <div class="btn-row">
        <form method="post" action="/welcome/scan" class="inline"><button class="ghost">${e(t('welcome.s2_scan'))}</button></form>
        <span class="dim">${e(scanned ? t('welcome.s2_last_scan', { at: fmtDateTime(Date.parse(scanned)) }) : t('welcome.s2_never_scanned'))}</span>
      </div>
      ${already ? `${already}<p class="dim">${e(t('welcome.s2_on_hint'))}</p>` : ''}
      <form method="post" action="/welcome/agents" class="form-grid">
        ${boxes || `<p class="dim">${e(t(already ? 'welcome.s2_all_on' : 'welcome.s2_none'))}</p>`}
        ${providersFound.length ? `<p class="dim">${e(t('welcome.s2_providers_found', { names: providersFound.join(', ') }))}</p>` : ''}
        ${hideField(ctx, 2)}
        ${primary(t('welcome.save_next'), ctx, 2)}
      </form>
    </div>
    ${stepFoot(ctx, 2)}`
}

// ---------------------------------------------------------------------------
// step 3 — a model provider
// ---------------------------------------------------------------------------

/**
 * Where one credential comes from, and how to give it another one.
 *
 * A deliberately reduced twin of the Plugins page's `credentialsBlock()`: the
 * same writer (`setCredential`), the same i18n keys for what a credential IS,
 * and the same rule that an empty password field means "keep what is stored".
 *
 * Two differences, both of them because this page has no JavaScript and asks
 * one question at a time:
 *
 *   - **no mode `<select>`.** Two fields whose meaning depends on a dropdown
 *     three lines above them is a form one has to be taught; here the ANSWER
 *     decides the mode — a pasted key is stored as a value, a named variable is
 *     read from the environment, and both empty means "leave alone". The Plugins
 *     page is where a stored credential is switched back to the environment.
 *   - **the field names carry the plugin id** (`cred_<id>_<key>_value`). Every
 *     provider's block is on the page at once — picking one is a radio, not a
 *     link, so nothing typed is lost by looking at the next provider — and three
 *     blocks sharing one field name would mean `parseForm()` keeping the last
 *     one and the wrong provider's key being stored.
 */
function credentialFields(pluginId, plugin, env = process.env) {
  const specs = credentialSpec(plugin)
  if (!specs.length) return `<p class="dim">${e(t('welcome.s3_no_credential'))}</p>`
  return specs.map(spec => {
    const entry = pluginConfig(pluginId)?.config.credentials?.[spec.key] ?? null
    const declared = spec.envKeys ?? []
    const named = entry?.mode === 'env' ? String(entry.envVar ?? '').trim() : ''
    const hit = (named && env[named] ? named : null) ?? declared.find(name => env[name])
    const status = hit
      ? `<span class="ok">✓ ${e(t('plugins.cred_present_env', { name: hit }))}</span>`
      : (entry?.mode === 'value' && String(entry.value ?? '').trim()
        ? `<span class="ok">✓ ${e(t('plugins.cred_present_stored'))}</span>`
        : `<span class="dim">${e(t('plugins.cred_missing'))}</span>`)
    const n = (suffix) => `cred_${e(pluginId)}_${e(spec.key)}_${suffix}`
    return `<div class="cred">
      <b>${e(t(spec.labelKey))}</b> ${status}
      ${declared.length ? `<p class="dim">${e(t('plugins.cred_declared', { names: declared.join(', ') }))}</p>` : ''}
      ${spec.helpKey ? `<p class="dim">${e(t(spec.helpKey))}</p>` : ''}
      <label>${e(t('welcome.s3_key_label'))}
        <input type="password" name="${n('value')}" value="" autocomplete="new-password">
        <span class="dim">${e(t('welcome.s3_key_hint'))}</span></label>
      <details class="goal"${named ? ' open' : ''}>
        <summary>${e(t('welcome.s3_env_summary'))}</summary>
        <label>${e(t('plugins.cred_envvar'))}
          <input type="text" name="${n('env')}" value="${e(named)}" placeholder="${e(declared[0] ?? '')}" autocomplete="off" spellcheck="false">
          <span class="dim">${e(t('plugins.cred_envvar_hint'))}</span></label>
      </details>
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

function step3(ctx, url) {
  const choices = providerChoices()
  if (!choices.length) {
    // Even with nothing to choose the step keeps its one button: a ghost "next"
    // link here would be the fourth different way to move forward in a wizard
    // whose whole complaint was that moving forward was unclear.
    return `${ackAgents()}
      <div class="card">
        ${explain('welcome.s3_explain')}
        <p class="dim">${e(t('welcome.s3_none'))}</p>
        <form method="post" action="/welcome/provider" class="form-grid">
          <input type="hidden" name="id" value="">
          ${hideField(ctx, 3)}
          ${primary(t('welcome.save_next'), ctx, 3)}
        </form>
      </div>
      ${stepFoot(ctx, 3)}`
  }
  // Which provider is pre-selected is a question about the URL and about what is
  // already configured — never about the client. Picking one is a radio inside
  // the single form, so nothing typed into one provider's field is lost by
  // reading the next one's, and the whole step is still one button.
  //
  // What is pre-selected is deliberately conservative: the one already
  // configured, otherwise the one whose key was found — but ONLY if exactly one
  // was. This machine had keys for two of them, and picking the alphabetically
  // first would have meant the primary button silently switching on a provider
  // the operator never chose. A step that asks a question may not answer it.
  const wanted = String(url?.searchParams?.get('provider') ?? '').trim()
  const configured = new Set(configuredProviders().map(p => p.id))
  const withKey = choices.filter(c => c.hasKey)
  const selected = choices.find(c => c.id === wanted)
    ?? choices.find(c => configured.has(c.id))
    ?? (withKey.length === 1 ? withKey[0] : null)

  const cards = choices.map(c => `<div class="card ${c.id === selected?.id ? 'ok' : ''}">
      <label class="chk"><input type="radio" name="id" value="${e(c.id)}" ${c.id === selected?.id ? 'checked' : ''}>
        <b>${e(c.plugin.label ?? c.id)}</b>
        ${c.hasKey ? `<span class="ok">✓ ${e(t('welcome.s3_key_found'))}</span>` : `<span class="dim">${e(t('welcome.s3_no_key'))}</span>`}</label>
      ${c.plugin.descriptionKey ? `<p class="dim">${e(t(c.plugin.descriptionKey))}</p>` : ''}
      ${credentialFields(c.id, c.plugin)}
    </div>`).join('')

  // "None for now" is a real answer, not a way out of the wizard: claude and
  // cursor bring their own subscription and need no provider at all. It is a
  // radio like the others, so the step still has exactly one button — the ghost
  // "I will do this later" link it replaces was indistinguishable from "Skip".
  const none = `<div class="card">
    <label class="chk"><input type="radio" name="id" value="" ${selected ? '' : 'checked'}>
      <b>${e(t('welcome.s3_none_option'))}</b></label>
    <p class="dim">${e(t('welcome.s3_none_hint'))}</p></div>`

  return `${ackAgents()}
    <div class="card">
      ${explain('welcome.s3_explain')}
      <p>${e(t('welcome.s3_pick'))}</p>
    </div>
    <form method="post" action="/welcome/provider" class="form-grid">
      ${cards}${none}
      ${hideField(ctx, 3)}
      ${primary(t('welcome.save_next'), ctx, 3)}
    </form>
    ${stepFoot(ctx, 3)}`
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

function step4(ctx) {
  let sources = []
  try { sources = llmSources() } catch { sources = [] }
  if (!sources.length) {
    return `${ackProvider()}
      <div class="card">
        ${explain('welcome.s4_explain')}
        <p class="dim">${e(t('welcome.s4_none'))}</p>
        <form method="post" action="/welcome/llm" class="form-grid">
          ${hideField(ctx, 4)}
          ${primary(t('welcome.save_next'), ctx, 4)}
        </form>
      </div>
      ${stepFoot(ctx, 4)}`
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
  return `${ackProvider()}
    <div class="card">
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
        ${hideField(ctx, 4)}
        ${primary(t('welcome.save_next'), ctx, 4)}
      </form>
    </div>
    ${stepFoot(ctx, 4)}`
}

// ---------------------------------------------------------------------------
// step 5 — done, and the offer to leave
// ---------------------------------------------------------------------------

function step5(ctx) {
  return `${ackSources()}
    <div class="card">
      <h3>${e(t('welcome.s5_title'))}</h3>
      <p>${e(t('welcome.s5_body'))}</p>
      <div class="btn-row">
        <a class="btn ghost" href="/repos">${e(t('welcome.s5_repo'))}</a>
        <a class="btn ghost" href="/agents">${e(t('welcome.s5_agent'))}</a>
        <a class="btn ghost" href="/settings/plugins">${e(t('welcome.s5_plugins'))}</a>
      </div>
    </div>
    ${setupDocCard()}
    <form method="post" action="/welcome/done" class="form-grid">
      ${hideField(ctx, 5)}
      ${primary(t('welcome.finish_btn'), ctx, 5)}
    </form>
    ${stepFoot(ctx, 5)}`
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

const HEADINGS = ['welcome.q1', 'welcome.q2', 'welcome.q3', 'welcome.q4', 'welcome.q5']

/** `GET /welcome[?step=1..5]` — always reachable, whatever the two flags say. */
export async function pageWelcome(req, res, url) {
  const raw = Number(url?.searchParams?.get('step') ?? 1)
  const step = Number.isInteger(raw) && raw >= 1 && raw <= STEPS ? raw : 1
  const ctx = { locked: welcomeLocked(req) }
  const body = step === 1 ? step1(ctx)
    : step === 2 ? await step2(ctx)
      : step === 3 ? step3(ctx, url)
        : step === 4 ? step4(ctx)
          : step5(ctx)
  const page = `<h2>${e(t(HEADINGS[step - 1]))}</h2>${body}`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(ctx.locked
      ? wizardShell(step, page)
      : await layout(req, t('welcome.title'), '', `${revisitNote()}${page}`))
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
 *
 * It only ever ADDS. A coding agent that is already switched on is not drawn as
 * a checkbox at all (see `harnessRows`), so there is no box here whose empty
 * state could mean "take that away" — taking away is what Settings → Plugins is
 * for, and a wizard that silently disabled a working coding agent because a box
 * on screen two was empty would be a far more expensive surprise than the one
 * this redesign set out to fix.
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
 * Step 3 → 4: enable one model provider and store where its key comes from.
 *
 * An empty `id` is the "none for now" radio and a legitimate answer — claude and
 * cursor bring their own subscription. A NON-empty id the hub does not know is
 * still a problem page: that is a broken request, not a decision.
 *
 * `setCredential()` is the same writer the Plugins page uses. A pasted key wins,
 * a named variable is second, and BOTH empty leaves what is stored alone — so
 * walking through the wizard a second time cannot wipe a key that is already
 * there (the password field cannot be pre-filled, so an empty submit must never
 * be read as "delete").
 */
export async function welcomeProvider(req, res, url, formBody) {
  const b = await formBody()
  applyHide(b)
  const id = String(b.id ?? '').trim()
  if (!id) return to(res, 4)
  const plugin = getPlugin(id)
  if (!plugin || pluginKind(id) !== 'provider') {
    return problemPage(req, res, t('welcome.title'), [t('welcome.problem_unknown', { id })], '/welcome?step=3')
  }
  setPluginConfig(id, { kind: 'provider', source: pluginSource(id) ?? 'builtin', enabled: 1 })
  for (const spec of credentialSpec(plugin)) {
    const value = String(b[`cred_${id}_${spec.key}_value`] ?? '').trim()
    const envVar = String(b[`cred_${id}_${spec.key}_env`] ?? '').trim()
    if (value) setCredential(id, spec.key, { mode: 'value', value })
    else if (envVar) setCredential(id, spec.key, { mode: 'env', envVar })
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
 * "Finished" — and out.
 *
 * Three writes, and they say three different things: the wizard was walked to
 * the end (`welcome_done`), whether it should greet anybody again
 * (`welcome_hide`, from the checkbox this step is the home of), and the session
 * mark that keeps the very next page from bouncing back here while the redirect
 * is still armed.
 */
export async function welcomeDone(req, res, url, formBody) {
  applyHide(await formBody())
  setSetting(WELCOME_DONE, '1')
  markWelcomeSkipped(res)
  redirect(res, HOME)
}
