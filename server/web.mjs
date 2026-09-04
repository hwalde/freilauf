// Freilauf — HTTP: server-rendered HTML + JSON API (planning 5).
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import db, { getRepo, getRun, setSetting, addEvent, announceRun, allSettings } from './db.mjs'
import { handleReport, clearAnomalies, notifiedFlags } from './reports.mjs'
import { modelList, orEndpoints, standVon, effortOptionen } from './models.mjs'
import { providersForHarness, listCodingAgents } from './coding-agents.mjs'
import { detectInstalled } from './harnesses/index.mjs'
import { subscriptionUsage } from './usage.mjs'
import { providerBalances } from './balances.mjs'
import { sseHandler } from './events.mjs'
import { launchRun } from './runner.mjs'
import { startRun, startDeferredRun, startScheduledNow } from './scheduler.mjs'
import { runDefFromForm, runStartFromForm, saveAgent, rememberRunChoice, lastRunChoiceFor } from './run-def.mjs'
import { runTitle, TITLE_MAX } from './title.mjs'
import {
  pageOverview, pageAgents, pageRunForm, pageRun, pageRepos, pageSettings, pageSessions,
  pageArchive,
  runNewPost, agentEdit, agentSave, agentToggle, agentStart,
  agentDelete, agentMovePage, agentMovePost,
  repoEdit, repoSave, settingsSave,
  codingAgentSave, codingAgentDelete,
  pageFavorites, favoriteEdit, favoriteSave, favoriteDelete,
  pageMergeSettings, mergeSettingsSave,
  pageCleanupSettings, cleanupSettingsSave,
  pageSkillSettings, skillSettingsSave, skillSettingsSync,
  repoToggle, repoDelete,
  headerStatus, usagePanel, statusSidebar, runRow, runsBody, overviewRuns, runDetailHead, runMetrics, runEvents,
  integrationSection, problemPage, runEditCard,
} from './pages.mjs'
import {
  pagePlugins, pluginsSave, pluginsAdd, pluginsRemove,
  pluginsInstall, pluginsUninstall, pluginsScan, pluginsDiscovery,
} from './plugins/web.mjs'
import {
  pageNotifications, notificationsSave, notificationsTest,
  notifierSetupPage, notifierSetupAction, notifierSetupJson,
} from './notifications.mjs'
import { llmSources, sourceModels, getSource } from './llm/sources.mjs'
import {
  pageWelcome, welcomeHello, welcomeScan, welcomeAgents,
  welcomeProvider, welcomeLlm, welcomeSkills, welcomeDone,
  shouldShowWelcome, markWelcomeSkipped,
} from './welcome.mjs'
import { getFavorite, favoriteToFormBody } from './favorites.mjs'
import { getPlugin } from './plugins/registry.mjs'
import { startCleanupRun } from './cleanup.mjs'
import { suggestExtras } from './extras-suggest.mjs'
import { editRun } from './run-edit.mjs'
import { readApi } from './read-api.mjs'
import { mergeByHand, skipMerge, resetIntegration } from './integrate.mjs'
import { redirect, body as readBody, parseForm, rememberRepo, requestRepo } from './web-helpers.mjs'
import { vorfallLoesen, vorfaelleLoesen, vorfall } from './incidents.mjs'
import { t } from './i18n.mjs'
import { flowRoute, flowApi } from './flows/web.mjs'
import { flowsTick } from './flows/triggers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------- helpers ----------------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
}

/** urlencoded POST body as a flat object (JSON API and forms share this). */
async function form(req) {
  return parseForm(await readBody(req))
}

/**
 * Some API endpoints are BOTH: fetched from browser JS and the target of a
 * classic <form method="post">. In the second case the user would land on a
 * bare JSON page. A browser navigation request is recognizable by
 * 'Accept: text/html' — then better redirect back to the page.
 */
function wantsHtml(req) {
  return (req.headers.accept ?? '').includes('text/html')
}
/**
 * What a Quick Run may say for itself: the task, the branch rule, the repo — the
 * three things a favorite deliberately does not carry. An allowlist and not a
 * spread, so a request cannot quietly replace the favorite's coding agent, model
 * or skills and start something else than the name on the button promised.
 * The duration is not asked for and takes the default.
 */
function pickQuickFields(b) {
  return {
    repo_id: b.repo_id,
    prompt: b.prompt,
    branch_mode: b.branch_mode,
    branch_pattern: b.branch_pattern,
    // Part of the branch rule, and rendered by the same branchFields() the run
    // forms use — so it has to be on the allowlist, or a ticked box would be
    // dropped here and nowhere else.
    keep_on_branch: b.keep_on_branch,
  }
}

function answer(req, res, code, obj, backTo) {
  if (backTo && wantsHtml(req)) return redirect(res, backTo)
  return json(res, code, obj)
}

/**
 * Move ONE run into the archive — the record (report, log, incidents) stays
 * intact and reachable, it only leaves the overview. ONLY finished runs: a
 * running one is still being watched, and a deferred/scheduled one would simply
 * start later anyway — the archive must not hide a run that still has work to do.
 *
 * One function because two routes archive: the single button in a row and the
 * overview's multi-select. Two copies of this rule is how one of them would
 * eventually archive a running run.
 *
 * It only writes the RECORD and returns the session that should go with it —
 * closing that session is the caller's step, so a bulk archive can end forty
 * sessions in one call instead of one at a time.
 */
function archiveRecord(run) {
  if (['running', 'waiting_help', 'scheduled', 'deferred'].includes(run.status)) {
    return { error: t('api.archive_only_finished'), session: null }
  }
  db.prepare(`UPDATE runs SET archived_at=COALESCE(archived_at, datetime('now')) WHERE id=?`).run(run.id)
  announceRun(run.id, 'archived')
  return { error: null, session: run.tmux_session || null }
}

/**
 * Archiving is the operator's "put this finished work away" — the sessions those
 * runs left standing go with it, by default right away (keep 0). A configured
 * delay or a switched-off rule leaves them to the watcher
 * (closeArchivedSessions there). killSessions reconciles the records exactly
 * like the sessions page does, and never throws the archive itself off course.
 */
async function closeArchivedSessions(sessions) {
  if (!sessions.length) return
  const { archiveSessionKeepMs, killSessions } = await import('./sessions.mjs')
  if (archiveSessionKeepMs(allSettings()) !== 0) return
  try { await killSessions(sessions, 'archive') }
  catch (err) { console.error('[archive]', err.message) }
}

// ---------------- router ----------------
export async function route(req, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const formBody = async () => parseForm(await readBody(req))
  // A full page load that names a repo makes that repo the persisted choice: the
  // switcher's navigation itself and every link carrying ?repo= (the sidebar's
  // counts, the "back" redirects, the overview links). Fragments, the SSE stream
  // and static files never touch it. An invalid id (a deleted repo) leaves the
  // cookie alone — the last valid choice is the better answer.
  if (req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/static/')) {
    const id = requestRepo(req)
    if (id != null && getRepo(id)) rememberRepo(res, id)
  }
  try { await dispatch(req, res, url, path, formBody) }
  catch (e) {
    console.error('[http]', e)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(t('web.internal_error', { msg: e.message }))
  }
}

async function dispatch(req, res, url, path, formBody) {
  // --- static (xterm.js from node_modules) ---
  if (req.method === 'GET' && path.startsWith('/static/')) return serveStatic(req, res, path)

  // --- JSON API ---
  if (path.startsWith('/api/')) return api(req, res, url)

  // --- Notifications (Settings → Notifications) ---
  // `/telegram-setup` was the one setup wizard the hub knew by name; it is the
  // Telegram plugin's own now, and the old address keeps working.
  if (path === '/telegram-setup' || path.startsWith('/telegram-setup/')) {
    return redirect(res, '/settings/notifications/telegram')
  }
  if (req.method === 'GET' && path === '/settings/notifications') return pageNotifications(req, res, url)
  if (req.method === 'POST' && path === '/settings/notifications/save') return notificationsSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/notifications/test') return notificationsTest(req, res, url, formBody)
  // Everything below `/settings/notifications/<id>` belongs to that notifier's
  // own setup wizard: the page, one POST per step, one GET per JSON call it
  // makes. The plugin brings the content; this is only the address.
  let m
  if ((m = path.match(/^\/settings\/notifications\/([a-z0-9][a-z0-9-]{1,39})$/)) && req.method === 'GET') {
    return notifierSetupPage(req, res, url, m[1])
  }
  if ((m = path.match(/^\/settings\/notifications\/([a-z0-9][a-z0-9-]{1,39})\/json\/([a-z0-9_-]{1,40})$/)) && req.method === 'GET') {
    return notifierSetupJson(req, res, url, m[1], m[2])
  }
  if ((m = path.match(/^\/settings\/notifications\/([a-z0-9][a-z0-9-]{1,39})\/([a-z0-9_-]{1,40})$/)) && req.method === 'POST') {
    return notifierSetupAction(req, res, url, m[1], m[2], formBody)
  }

  // --- Welcome wizard ---
  // Reachable whatever the two wizard flags say, and it never redirects to
  // itself: the redirect below is the only place that sends anybody here.
  //
  // The page has two modes and decides between them itself (welcome.mjs,
  // `welcomeLocked`): while the redirect below would send a browser here and the
  // wizard has never been walked to its end (`welcome_done`), it renders in its
  // own minimal shell with no navigation and no way out but the one it offers —
  // otherwise it is an ordinary page inside `layout()`. Lock-in and forced
  // redirect are therefore the same condition, which is what keeps the hub from
  // ever locking somebody into a page it did not send them to.
  if (req.method === 'GET' && path === '/welcome') return pageWelcome(req, res, url)
  if (req.method === 'POST' && path === '/welcome/hello') return welcomeHello(req, res, url, formBody)
  if (req.method === 'POST' && path === '/welcome/scan') return welcomeScan(req, res, url, formBody)
  if (req.method === 'POST' && path === '/welcome/agents') return welcomeAgents(req, res, url, formBody)
  if (req.method === 'POST' && path === '/welcome/provider') return welcomeProvider(req, res, url, formBody)
  if (req.method === 'POST' && path === '/welcome/llm') return welcomeLlm(req, res, url, formBody)
  if (req.method === 'POST' && path === '/welcome/skills') return welcomeSkills(req, res, url, formBody)
  if (req.method === 'POST' && path === '/welcome/done') return welcomeDone(req, res, url, formBody)

  // --- pages ---
  // A fresh installation meets the wizard instead of an overview with nothing in
  // it. Three fences, and each of them is load-bearing:
  //   - only a BROWSER NAVIGATION (`wantsHtml`) — a fragment fetch or an API
  //     caller asking for `/` must never be answered with a redirect to HTML;
  //   - only while `welcome_hide` is unset — the checkbox, which lives on the
  //     wizard's LAST step while somebody is being walked through it (the offer
  //     to leave belongs at the end) and on every step once it is an ordinary
  //     page. Finishing pre-ticks it, so a completed setup stops greeting;
  //     `welcome_done` records the finishing itself and is what unlocks the
  //     page, deliberately a different statement from "stop sending me here";
  //   - `?welcome=skip` is the wizard's own way out coming back — the locked
  //     "Leave the setup for now" card and the revisiting operator's banner
  //     button — and it marks the browser session so neither can bounce into a
  //     loop. (An unlocked step's "Save and back to Freilauf" is a form submit
  //     and marks the session itself; it never travels through this route.)
  if (req.method === 'GET' && path === '/') {
    if (url.searchParams.get('welcome') === 'skip') markWelcomeSkipped(res)
    else if (wantsHtml(req) && shouldShowWelcome(req)) return redirect(res, '/welcome')
  }
  if (req.method === 'GET' && path === '/') return pageOverview(req, res, url)
  if (req.method === 'GET' && path === '/archive') return pageArchive(req, res, url)
  if (req.method === 'GET' && path === '/agents') return pageAgents(req, res, url)
  if (req.method === 'GET' && path === '/agents/edit') return agentEdit(req, res, url)
  if (req.method === 'POST' && path === '/agents/edit') return agentSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/toggle') return agentToggle(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/start') return agentStart(req, res, url, formBody)
  if (req.method === 'POST' && path === '/agents/delete') return agentDelete(req, res, url, formBody)
  if (req.method === 'GET' && path === '/agents/move') return agentMovePage(req, res, url)
  if (req.method === 'POST' && path === '/agents/move') return agentMovePost(req, res, url, formBody)
  if (req.method === 'GET' && path === '/runs/new') return pageRunForm(req, res, url)
  if (req.method === 'POST' && path === '/runs/new') return runNewPost(req, res, url, formBody)
  if (/^\/runs\/[0-9a-f-]{36}$/.test(path)) return pageRun(req, res, url, path.split('/')[2])
  if (req.method === 'GET' && path === '/sessions') return pageSessions(req, res, url)
  if (req.method === 'GET' && path === '/repos') return pageRepos(req, res, url)
  if (req.method === 'GET' && path === '/repos/edit') return repoEdit(req, res, url)
  if (req.method === 'POST' && path === '/repos/edit') return repoSave(req, res, url, formBody)
  // Switching a repo off is the reversible alternative to deleting it; deleting
  // needs the repo's name in `confirm` and refuses while work is in flight.
  // Both live here rather than under /api/: they are page actions, and the
  // agent-facing skill deliberately tells an agent to leave the delete alone.
  if (req.method === 'POST' && path === '/repos/toggle') return repoToggle(req, res, url, formBody)
  if (req.method === 'POST' && path === '/repos/delete') return repoDelete(req, res, url, formBody)
  if (req.method === 'GET' && path === '/settings') return pageSettings(req, res, url)
  if (req.method === 'POST' && path === '/settings/save') return settingsSave(req, res, url, formBody)
  // Plugins (Settings → Plugins) — coding agents, model providers, credentials
  // and the installed packages, all on one page.
  if (req.method === 'GET' && path === '/settings/plugins') return pagePlugins(req, res, url)
  if (req.method === 'POST' && path === '/settings/plugins/save') return pluginsSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/plugins/add') return pluginsAdd(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/plugins/remove') return pluginsRemove(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/plugins/install') return pluginsInstall(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/plugins/uninstall') return pluginsUninstall(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/plugins/scan') return pluginsScan(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/plugins/discovery') return pluginsDiscovery(req, res, url, formBody)
  // The old Coding-agents page became the Plugins page's second section. The
  // GET is a redirect rather than a 404 because the address is in bookmarks,
  // in the setup banner and in the docs; the two POSTs stay because a tab
  // opened before the deploy would otherwise lose what was typed into it.
  // Nothing on the new page posts to them.
  if (req.method === 'GET' && path === '/settings/coding-agents') return redirect(res, '/settings/plugins')
  if (req.method === 'POST' && path === '/settings/coding-agents/save') return codingAgentSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/coding-agents/delete') return codingAgentDelete(req, res, url, formBody)
  // Favorites (Settings → Favorites) — the saved setup a Quick Run starts from.
  if (req.method === 'GET' && path === '/settings/favorites') return pageFavorites(req, res, url)
  if (req.method === 'GET' && path === '/settings/favorites/edit') return favoriteEdit(req, res, url)
  if (req.method === 'POST' && path === '/settings/favorites/edit') return favoriteSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/favorites/delete') return favoriteDelete(req, res, url, formBody)
  // Merge (Settings → Merge) — the conflict resolver's setup. Its own page for
  // the same reason the favorites have one: the provider/model/effort block is
  // driven through #prov, #model and #effort, and those ids exist once per page.
  if (req.method === 'GET' && path === '/settings/merge') return pageMergeSettings(req, res, url)
  if (req.method === 'POST' && path === '/settings/merge') return mergeSettingsSave(req, res, url, formBody)
  // tmux cleanup (Settings → tmux cleanup) — the memory-freeing agent's setup.
  if (req.method === 'GET' && path === '/settings/cleanup') return pageCleanupSettings(req, res, url)
  if (req.method === 'POST' && path === '/settings/cleanup') return cleanupSettingsSave(req, res, url, formBody)
  // Freilauf's own agent skills (server/skills.mjs) — the two switches, and the
  // sync they trigger. Its own page because saving here DELETES FILES, and a
  // handler that owns the whole request is what can act on that transition.
  if (req.method === 'GET' && path === '/settings/skills') return pageSkillSettings(req, res, url)
  if (req.method === 'POST' && path === '/settings/skills') return skillSettingsSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/skills/sync') return skillSettingsSync(req, res, url, formBody)
  // No-code flows (server/flows/) — own router, own pages.
  if (path === '/flows' || path.startsWith('/flows/')) return flowRoute(req, res, url)
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end(t('web.not_found'))
}

// ---------------- API ----------------
async function api(req, res, url) {
  const path = url.pathname
  let m
  // Live channel. Stands FIRST because it is the one response that never ends:
  // everything below assumes a request that finishes.
  if (req.method === 'GET' && path === '/api/events') return sseHandler(req, res, url)
  // Pieces of a page, rendered by the very functions the page uses (pages.mjs).
  if (req.method === 'GET' && path.startsWith('/api/fragments/')) return fragmentApi(req, res, url)
  if (path.startsWith('/api/flows') || path.startsWith('/api/flow-runs')) return flowApi(req, res, url)
  // Read-only JSON: repos, agents, runs, favorites, sessions, skills. Stands
  // here so it can decline (`false`) and let the specific routes below answer —
  // a GET it does not know is not its business.
  if (req.method === 'GET' && await readApi(req, res, url)) return

  // Which providers the chosen harness can use — plugin capability, restricted
  // to the operator's per-coding-agent selection and available credentials.
  if (req.method === 'GET' && path === '/api/providers') {
    const harness = url.searchParams.get('harness') ?? ''
    const provider = providersForHarness(harness)
      .map(p => ({ id: p.id, label: p.label, ...(p.hinweisKey ? { hinweis: t(p.hinweisKey) } : {}) }))
    const agents = listCodingAgents()
    const subscription = !!agents.find(a => a.harness === harness)?.plugin?.subscription
    return json(res, 200, { ok: true, harness, subscription, provider })
  }

  // What this coding agent was last run with. The form asks for it when the
  // coding agent is SWITCHED: provider, model and effort of the previous one are
  // not merely unhelpful there, they are incompatible (an opencode slug is
  // nothing claude runs), so they are replaced instead of left standing.
  if (req.method === 'GET' && path === '/api/run-choice') {
    const harness = url.searchParams.get('harness') ?? ''
    const c = lastRunChoiceFor(harness)
    return json(res, 200, {
      ok: true,
      harness,
      choice: {
        provider: c.provider ?? '',
        model: c.model ?? '',
        or_provider: c.or_provider ?? '',
        or_routing: c.or_routing ?? '',
        effort: c.effort ?? '',
      },
    })
  }

  // Configured coding agents + which plugins are installed on this machine
  // (feeds the "add coding agent" dialog).
  if (req.method === 'GET' && path === '/api/coding-agents/detect') {
    const detected = await detectInstalled()
    const configured = new Set(listCodingAgents().map(a => a.harness))
    return json(res, 200, {
      ok: true,
      agents: detected.map(d => ({ ...d, configured: configured.has(d.id) })),
    })
  }

  // Subscription usage (Claude Code, Cursor) + provider account balances.
  // Both lists carry their own ok-flag per row, so a provider that went silent
  // is reported as silent rather than dropped.
  if (req.method === 'GET' && path === '/api/usage') {
    const usage = await subscriptionUsage()
    const balances = await providerBalances()
    return json(res, 200, { ok: true, usage, balances })
  }

  // Model lists of the providers. ALWAYS answers 200 with ok:false on error —
  // the form must not have to catch anything and stays usable without a list.
  if (req.method === 'GET' && path === '/api/models') {
    const provider = url.searchParams.get('provider') ?? ''
    // The harness has a say: opencode only accepts what it knows itself.
    const r = await modelList(provider, url.searchParams.get('harness'))
    return json(res, 200, r.liste
      ? { ok: true, provider, models: r.liste, veraltet: r.veraltet, stand: standVon(provider) }
      : { ok: false, error: r.fehler ?? t('api.model_list_unreachable') })
  }
  // The sources that can answer the hub's OWN questions (run titles, the
  // incident check, a flow's extract, the worktree-extras suggestion) — model
  // providers and coding agents in one flat list, because a coding agent's
  // model ids already carry the provider (see server/llm/sources.mjs).
  if (req.method === 'GET' && path === '/api/llm-sources') {
    return json(res, 200, { ok: true, sources: llmSources() })
  }
  // The models of ONE such source. Same manners as /api/models above: always
  // 200, `ok:false` on failure, because the model field keeps its free-text
  // input and a picker must not break a form over a vendor that went quiet.
  if (req.method === 'GET' && path === '/api/llm-models') {
    const source = url.searchParams.get('source') ?? ''
    if (!getSource(source)) {
      return json(res, 200, { ok: false, error: t('api.unknown_llm_source', { source }) })
    }
    const models = await sourceModels(source)
    return json(res, 200, models.length
      ? { ok: true, source, models }
      : { ok: false, error: t('api.model_list_unreachable') })
  }
  // Which effort levels this combination REALLY accepts. Always answers 200:
  // without an answer the form simply hides the field.
  if (req.method === 'GET' && path === '/api/effort') {
    const r = await effortOptionen(url.searchParams.get('harness') ?? '',
      url.searchParams.get('provider') ?? '', url.searchParams.get('model') ?? '')
    return json(res, 200, r.stufen
      ? { ok: true, ...r, hinweis: r.hinweisKey ? t(r.hinweisKey) : '' }
      : { ok: false, error: r.hinweisKey ? t(r.hinweisKey) : (r.hinweis ?? '') })
  }

  if (req.method === 'GET' && path === '/api/or-endpoints') {
    const r = await orEndpoints(url.searchParams.get('model') ?? '')
    return json(res, 200, r.liste
      ? { ok: true, endpoints: r.liste, veraltet: r.veraltet }
      : { ok: false, error: r.fehler ?? t('api.endpoints_unreachable') })
  }

  // The best-provider selection for a model under the given requirements —
  // the form's "auto" mode calls this so the operator SEES what would be
  // pinned instead of trusting a checkbox. Same plugin the runs resolve
  // through, same cache — a preview never disagrees with the start.
  if (req.method === 'GET' && path === '/api/or-routing') {
    const model = url.searchParams.get('model') ?? ''
    const plugin = getPlugin('openrouter')?.plugin
    if (!plugin?.routing) return json(res, 200, { ok: false, error: t('api.endpoints_unreachable') })
    const cfg = plugin.routing.parseConfig({
      quant_min: url.searchParams.get('quant') ?? '',
      location: url.searchParams.get('location') ?? 'all',
      max_in: url.searchParams.get('max_in') ?? '',
      max_out: url.searchParams.get('max_out') ?? '',
    })
    try {
      const r = await plugin.routing.resolve(pluginCtx('openrouter'), model.trim(), cfg)
      return json(res, 200, r.ok
        ? { ok: true, best: r.best, order: r.order, quant: r.quant, at: r.at,
            cached: !!r.cached, veraltet: !!r.veraltet, prices: r.prices ?? [], dropped: r.dropped ?? [] }
        : { ok: false, error: r.reason ?? t('api.endpoints_unreachable') })
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message })
    }
  }
  // The report endpoint answers 200 with `{ ok, message }`, and the message is
  // the point: with the repo's integration switched on the finish gate has
  // something to SAY back ("your worktree is dirty", "this conflicts"), and
  // fl-report prints it into the agent's running turn. It must be a 2xx —
  // fl-report treats anything else as "hub unreachable" and files the report in
  // inbox.jsonl, where the watcher would replay it.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/report$/))) {
    let b = {}
    try { b = JSON.parse(await readBody(req) || '{}') } catch {}
    const r = await handleReport(m[1], b, 'http')
    return json(res, r.ok ? 200 : 400, r)
  }
  // Same definition, same validation and same start path as the run form
  // (pages.mjs) — this endpoint used to be its own third copy and saved an
  // agent without provider, effort and skills.
  if (req.method === 'POST' && path === '/api/runs') {
    const b = await form(req)
    const problems = []
    const def = await runDefFromForm(b, problems)
    const start = runStartFromForm(b, problems)
    if (problems.length) return json(res, 400, { ok: false, error: problems.join(' · ') })
    rememberRunChoice(def)
    if (b.save_agent === '1') {
      try { saveAgent({ repoId: +b.repo_id, name: b.agent_name || `agent-${Date.now()}`, def }) }
      catch { /* duplicate name: the run is what matters, not the copy */ }
    }
    const r = await startRun(def, { repoId: +b.repo_id, ...start })
    return json(res, r.ok ? 200 : 500, {
      ok: r.ok, runId: r.runId, deferred: r.deferred, scheduled: r.scheduled, error: r.error,
    })
  }
  // Quick Run: a favorite plus a task. The dialog sits in the layout of every
  // page, so this is the one start path that must answer JSON and nothing else —
  // the caller stays where it is and shows a toast.
  //
  // Deliberately NOT its own definition builder: the favorite becomes a form
  // body again (favoriteToFormBody) and goes through runDefFromForm() /
  // runStartFromForm() like the run form. That is the whole point of a favorite
  // storing only the setup half — everything the definition needs beyond it is
  // in this request, and the validation is the one that already exists.
  //
  // `detached: true` is what makes it quick. What this request has to DECIDE —
  // is the favorite real, does the definition validate, is there quota — is
  // milliseconds; what it used to WAIT for is the launch, and that is seconds
  // of git and tmux (measured on this machine: 0.5 s in a 154-file repository,
  // 5 s in one of 16 000 files, plus fl-start's own second). The dialog held
  // still for all of it, which is the one thing a quick start must not do. So
  // the answer says `pending` and the browser follows the run's own record;
  // the start finishes in the hub whether that page stays open or not.
  if (req.method === 'POST' && path === '/api/runs/quick') {
    const b = await form(req)
    const fav = getFavorite(b.favorite_id)
    if (!fav) return json(res, 400, { ok: false, error: t('qr.err_favorite') })
    const problems = []
    const def = await runDefFromForm({ ...favoriteToFormBody(fav), ...pickQuickFields(b) }, problems)
    const start = runStartFromForm(b, problems)
    if (problems.length) return json(res, 400, { ok: false, error: problems.join(' · ') })
    rememberRunChoice(def)
    const r = await startRun(def, { repoId: +b.repo_id, ...start, detached: true })
    if (!r.ok) return json(res, 500, { ok: false, error: r.error ?? t('run.start_failed') })
    const run = getRun(r.runId)
    return json(res, 200, {
      ok: true, runId: r.runId, deferred: !!r.deferred, scheduled: !!r.scheduled,
      pending: !!r.pending, title: run?.title ?? null, favorite: fav.name,
    })
  }
  // tmux cleanup: start the memory-freeing agent by hand. The sidebar's small
  // button and the Sessions page's box both land here. `target_gb` may be empty
  // (then the configured target applies); `keep` lists run ids whose tmux
  // sessions must survive. Answers JSON — the callers stay where they are.
  if (req.method === 'POST' && path === '/api/cleanup/start') {
    const b = await form(req)
    const raw = String(b.target_gb ?? '').trim()
    const targetGb = raw === '' ? null : Number(raw)
    const r = await startCleanupRun({
      targetGb,
      keep: String(b.keep ?? ''),
      source: b.source === 'auto' ? 'auto' : (b.source === 'sessions' ? 'sessions' : 'sidebar'),
    })
    return json(res, r.ok ? 200 : 400, {
      ok: r.ok, runId: r.runId ?? null, deferred: !!r.deferred,
      targetGb: r.targetGb ?? null, error: r.error ?? null,
    })
  }
  // Rename a run — inline editing in the overview and on the detail page. This
  // touches ONLY the run: an agent keeps its name, and its next run is called
  // by it again. An empty title falls back to the agent's name.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/title$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    const b = await form(req)
    const gewuenscht = String(b.title ?? '').trim().slice(0, TITLE_MAX)
    db.prepare('UPDATE runs SET title=? WHERE id=?').run(gewuenscht || null, run.id)
    announceRun(run.id, 'title')
    const agentName = run.agent_id
      ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name ?? null : null
    return answer(req, res, 200,
      { ok: true, title: runTitle({ title: gewuenscht }, agentName, t('overview.single_run')) },
      `/runs/${run.id}`)
  }
  // Archive a run — one click in the overview, the record (report, log, incidents)
  // stays intact and only leaves the overview. ONLY finished runs: a running one is
  // still being watched, and a deferred/scheduled one would simply start later anyway —
  // the archive must not hide a run that still has work to do. Unarchiving is the
  // reverse. Both go through 'answer' so a classic <form method="post"> lands back on
  // the page it came from ('back'), while a fetch gets JSON.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/archive$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    const { error, session } = archiveRecord(run)
    if (error) return answer(req, res, 400, { ok: false, error }, `/runs/${run.id}`)
    await closeArchivedSessions(session ? [session] : [])
    const b = await form(req)
    return answer(req, res, 200, { ok: true, archived: true }, b.back || `/runs/${run.id}`)
  }
  // Several runs in one gesture — the overview's multi-select. A list of forty
  // finished runs of which four are worth keeping was forty clicks before this.
  // Every run goes through the SAME archiveRecord() the single route uses, so
  // one path cannot come to mean something else than the other; a refusal
  // (a run still in flight) does not hold up the rest, it is reported per run,
  // and the sessions are closed in ONE call afterwards instead of one at a time.
  if (req.method === 'POST' && path === '/api/runs/archive') {
    const b = await form(req)
    const ids = b.run_list ?? (b.run ? [b.run] : [])
    if (!ids.length) return answer(req, res, 400, { ok: false, error: t('api.no_run_given') }, b.back || '/')
    const results = []
    const sessions = []
    for (const id of ids) {
      const run = getRun(String(id))
      if (!run) { results.push({ run: String(id), ok: false, error: t('api.unknown_run') }); continue }
      const { error, session } = archiveRecord(run)
      if (session) sessions.push(session)
      results.push({ run: run.id, ok: !error, error: error ?? null })
    }
    await closeArchivedSessions(sessions)
    return answer(req, res, 200, { ok: results.every(r => r.ok), results }, b.back || '/')
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/unarchive$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    db.prepare(`UPDATE runs SET archived_at=NULL WHERE id=?`).run(run.id)
    announceRun(run.id, 'unarchived')
    const b = await form(req)
    return answer(req, res, 200, { ok: true, archived: false }, b.back || `/runs/${run.id}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/send$/))) {
    const run = getRun(m[1])
    if (!run?.tmux_session) return answer(req, res, 404, { ok: false, error: t('api.no_session') }, `/runs/${m[1]}`)
    const b = await form(req)
    const text = String(b.text || '')
    // Multi-line without accidental submit: bracketed paste + Enter (planning 7.3)
    const { sendToSession } = await import('./util.mjs')
    await sendToSession(run.tmux_session, text)
    db.prepare(`UPDATE runs SET last_activity_at=datetime('now') WHERE id=?`).run(run.id)
    // The run's event list is meant to be its history, and a message from a
    // human was missing from it — the flow path has recorded its equivalent
    // ('flow_message') all along.
    if (run.status === 'waiting_help') {
      // The finish gate's deadline does not run while a run waits for a HUMAN —
      // so the clock starts again from the moment the answer arrives, not from
      // the report that came before the question.
      db.prepare(`UPDATE runs SET status='running', help_answer=?,
                  finish_started_at=CASE WHEN finish_state IS NULL THEN finish_started_at
                                         ELSE datetime('now') END WHERE id=?`).run(text, run.id)
      addEvent(run.id, 'help_answered', { text: text.slice(0, 500) })
    } else if (['done', 'failed', 'aborted'].includes(run.status)) {
      // A message into a FINISHED run's session is a follow-up COMMISSION: the
      // operator read the report and asked for more. The run's status keeps
      // telling the truth about the first attempt, but from this moment it
      // displays as running again (pages.mjs), and the watcher holds it to its
      // expected duration counting from NOW — a follow-up that works on and on
      // without reporting is captured, exactly like a first attempt (watcher.mjs
      // watchFollowUps). Every new instruction restarts the clock, so the old
      // "longer than expected" statement of a previous commission is retracted
      // the same way a raised duration retracts it (run-edit.mjs).
      db.prepare(`UPDATE runs SET followup_since=datetime('now') WHERE id=?`).run(run.id)
      addEvent(run.id, 'followup_started', { text: text.slice(0, 500) })
      clearAnomalies(run.id, ['anomaly:followup_soft_overrun', 'anomaly:followup_overrun',
        ...notifiedFlags('followup_overrun')])
    } else {
      addEvent(run.id, 'message_sent', { text: text.slice(0, 500) })
    }
    return answer(req, res, 200, { ok: true }, `/runs/${run.id}`)
  }
  // The notification checkbox under the terminal: on (the default of every run)
  // or off for THIS run. Off silences every message about the run — its reports,
  // the follow-up ones first of all, its alarms and its incidents — on every
  // configured channel, and nothing else: the integration, the flows and the
  // events happen exactly as before (reports.mjs, notifyRun). Read at send time,
  // so the click takes effect on the next message, whatever is in flight.
  //
  // `/telegram` stays as an alias of `/notify`, and the answer carries BOTH
  // keys: the route and the JSON field are somebody else's contract the moment
  // they exist, and there is nothing to gain from breaking one. The column is
  // still `telegram_on` for the reason db.mjs states.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/(?:notify|telegram)$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    const b = await form(req)
    const on = ['1', 'on', 'true'].includes(String(b.on ?? '').trim()) ? 1 : 0
    if (on !== (run.telegram_on === 0 ? 0 : 1)) {
      db.prepare('UPDATE runs SET telegram_on=? WHERE id=?').run(on, run.id)
      addEvent(run.id, on ? 'notify_on' : 'notify_off', {})
    }
    return answer(req, res, 200, { ok: true, notify_on: on, telegram_on: on }, `/runs/${run.id}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/kill$/))) {
    const run = getRun(m[1])
    const { sh } = await import('./util.mjs')
    if (run?.tmux_session) await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    // 'done' and 'aborted' are final answers, so a click can only close the
    // session they left standing: 'done' came through cleanly and must not be
    // rewritten (the coding agents keep their session after the work is done —
    // that is the ordinary state of a finished run, not a corner case), and
    // 'aborted' already IS what the button means. Same rule, and same event,
    // as reconcileClosedSession().
    // 'failed' is deliberately NOT in this list. The button was rendered while
    // the run was still going, so a click that lands after the watcher has
    // written 'failed' (pane died in between — measured: two seconds) is still
    // a cancel, and the final status has to say what the CLICK said, not what
    // the race decided. Cancelling a failed run IS setting it to 'aborted'.
    if (['done', 'aborted'].includes(run?.status ?? '')) {
      // With the session goes the way a follow-up could report: an open
      // follow-up commission (web.mjs /send) is given up with it.
      db.prepare(`UPDATE runs SET tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')), followup_since=NULL WHERE id=?`).run(m[1])
      if (run && !run.tmux_closed_at) addEvent(m[1], 'tmux_closed', { source: 'user' })
      return answer(req, res, 200, { ok: true }, `/runs/${m[1]}`)
    }
    // Set tmux_closed_at right away: otherwise the detail page tries to attach
    // a terminal to the dead session until the next watcher tick (410 in the browser).
    // followup_since=NULL: a FAILED run can carry an open follow-up commission —
    // with the cancel it is given up, like with any other end of the session.
    db.prepare(`UPDATE runs SET status='aborted', ended_at=COALESCE(ended_at, datetime('now')),
                tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')), finish_state=NULL,
                followup_since=NULL WHERE id=?`).run(m[1])
    // Same event kind reconcileClosedSession() writes, so "why did this run
    // stop?" has one answer to look for rather than two.
    addEvent(m[1], 'aborted', { by: 'user' })
    // An end somebody ASKED for is an abort, even in the finish gate — and what
    // it leaves behind is assessed like any other unfinished run (no notification:
    // whoever clicked the button knows).
    const { assessLater } = await import('./sessions.mjs')
    assessLater(m[1], false)
    flowsTick().catch(e => console.error('[flows]', e.message))   // "run finished" triggers, without waiting for the watcher
    return answer(req, res, 200, { ok: true }, `/runs/${m[1]}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/retry$/))) {
    const run = getRun(m[1])
    if (!run) return json(res, 404, { ok: false })
    // Retried = not over any more: it leaves the archive, otherwise an active run
    // would sit hidden in the overview while it works. And the goal starts over
    // with it: a retry is a NEW session, and a `/goal` typed into the old one is
    // gone with it (server/goal.mjs).
    // …and the follow-up reports of the old attempt go with the old report.
    // tmux_closed_at goes with it too: the old SESSION is closed, not this run —
    // the new attempt gets a fresh one, and a stale timestamp would make
    // pageRun() render "no tmux session" for a session that is standing.
    db.prepare(`UPDATE runs SET status='running', ended_at=NULL, report_md=NULL, archived_at=NULL,
                goal_sent_at=NULL, followups=0, followup_md=NULL, followup_open=0, followup_since=NULL,
                tmux_closed_at=NULL, exit_code=NULL WHERE id=?`).run(m[1])
    // …and so does the integration: everything the finish gate and the
    // integrator wrote about the previous attempt is gone.
    resetIntegration(m[1])
    addEvent(m[1], 'retry', { previous_status: run.status })
    const r = await launchRun(m[1])
    return answer(req, res, r.ok ? 200 : 500, r, `/runs/${m[1]}`)
  }
  // "Start anyway": an operator clicking a deferred run into life. The budget
  // gate deferred it for a reason, so the button is the operator's deliberate
  // decision that the window does not govern THIS run — the gate is not asked
  // again (scheduler.startDeferredRun, the same function the watcher's auto
  // retry uses, only marked as forced). Only 'deferred' may go: a scheduled
  // run is waiting for its time, not for a quota, and gets its own cancel.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/start$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    if (run.status !== 'deferred') {
      return answer(req, res, 400, { ok: false, error: t('start.err_not_deferred') }, `/runs/${m[1]}`)
    }
    const r = await startDeferredRun(m[1], { forced: true })
    return answer(req, res, r.ok ? 200 : 500, r, `/runs/${m[1]}`)
  }
  // "Start now": a planned run started ahead of its time. The same function the
  // edit card's "now" choice uses (startScheduledNow) — including the budget
  // gate, so a start into an exhausted quota becomes 'deferred' rather than
  // dying at the first API call. Only a 'scheduled' run may go: a deferred one
  // is waiting for quota, not for a moment, and has its own /start.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/start-now$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    if (run.status !== 'scheduled') {
      return answer(req, res, 400, { ok: false, error: t('start.err_not_scheduled') }, `/runs/${m[1]}`)
    }
    const r = await startScheduledNow(m[1])
    return answer(req, res, r.ok ? 200 : 500, r, `/runs/${m[1]}`)
  }
  // Edit a run that still has a future: the expected duration of a running one
  // (the watcher's thresholds and the metrics read it live), and — while the
  // run has not started — its prompt, its repo, its branch rule and, for a
  // planned run, its start time as well. What each status allows is decided in
  // server/run-edit.mjs, the same table the detail page renders the card from,
  // so the form can never offer an edit the endpoint would refuse. A classic
  // form post lands back on the run; a fetch gets JSON. Editing a planned run
  // to "start now" launches it right here (startScheduledNow, the same budget
  // gate as at any other start).
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/edit$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    const b = await form(req)
    const problems = []
    const branchFelt = b.branch_mode !== undefined
    const r = await editRun(m[1], {
      expectedMinutes: b.expected_minutes !== undefined ? b.expected_minutes : null,
      prompt: b.prompt !== undefined ? b.prompt : null,
      repoId: b.repo_id !== undefined ? b.repo_id : null,
      startMode: b.start_mode !== undefined ? b.start_mode : null,
      startAt: b.start_at !== undefined ? b.start_at : null,
      startInMinutes: b.start_in_minutes !== undefined ? b.start_in_minutes : null,
      branchMode: branchFelt ? b.branch_mode : null,
      branchPattern: branchFelt ? b.branch_pattern : null,
      keepOnBranch: branchFelt ? (b.keep_on_branch === '1' || b.keep_on_branch === 'on' ? 1 : 0) : null,
    }, problems)
    if (problems.length) {
      if (wantsHtml(req)) return problemPage(req, res, t('run.edit'), problems, `/runs/${run.id}`)
      return json(res, 400, { ok: false, error: problems.join(' · ') })
    }
    if (r.startNow) {
      const gestartet = await startScheduledNow(run.id)
      return answer(req, res, gestartet.ok ? 200 : 500, gestartet, `/runs/${run.id}`)
    }
    return answer(req, res, r.ok ? 200 : 400, r, `/runs/${run.id}`)
  }
  // ---- integration by hand (server/integrate.mjs, buttons on the detail page) ----
  //
  // "Mark as done" is exactly what `fl-report done` is, only typed by a human:
  // same path, same finish gate, same everything.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/mark-done$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    const r = await handleReport(run.id, { kind: 'done', text: t('run.marked_done_note') }, 'internal')
    return answer(req, res, r.ok ? 200 : 400, r, `/runs/${run.id}`)
  }
  // "Merge now" and its two variants. An explicit click bypasses the attempt
  // limit — the operator has decided — but the dry run happens anyway, because
  // the base branch may have moved since the run was blocked.
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/merge$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    const b = await form(req)
    const leftovers = ['commit', 'discard'].includes(b.leftovers) ? b.leftovers : null
    const r = await mergeByHand(run.id, leftovers)
    // A refusal has a REASON ("still dirty", "no resolver configured"), and a
    // redirect back to the run would swallow it — the page would look as if the
    // click had done nothing at all.
    if (!r.ok && wantsHtml(req)) return problemPage(req, res, t('merge.section'), [r.error], `/runs/${run.id}`)
    return answer(req, res, r.ok ? 200 : 400, r, `/runs/${run.id}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/merge-skip$/))) {
    const run = getRun(m[1])
    if (!run) return answer(req, res, 404, { ok: false, error: t('api.unknown_run') }, `/runs/${m[1]}`)
    skipMerge(run.id)
    return answer(req, res, 200, { ok: true }, `/runs/${run.id}`)
  }
  // End tmux sessions — one or many in a single call. The page fires this for
  // every row the operator clicks away; the kills run concurrently inside
  // killSessions(), so a batch costs no more wall clock than a single one.
  // Whatever hung on a session is brought in line there too (a run still on
  // 'running' becomes 'aborted', attached flows fire) — that is the whole point
  // of routing this through one function instead of calling tmux from the page.
  if (req.method === 'POST' && path === '/api/sessions/kill') {
    const b = await form(req)
    const names = b.session_list ?? (b.session ? [b.session] : [])
    // Where a classic form post returns to. The sessions page fetches and stays
    // put, but the run's detail page ends its session with a plain form — and
    // it wants to land back on the run, not on the session list. The full
    // navigation is deliberate there: it is what closes the terminal's
    // WebSocket, and with it the tmux client behind it.
    if (!names.length) return answer(req, res, 400, { ok: false, error: t('api.no_session_given') }, b.back || '/sessions')
    const { killSessions } = await import('./sessions.mjs')
    const results = await killSessions(names, 'web')
    return answer(req, res, 200, { ok: results.every(r => r.ok), results }, b.back || '/sessions')
  }
  // Resolve an incident (auto-alarm off) — single or all of one run.
  if (req.method === 'POST' && (m = path.match(/^\/api\/incidents\/(\d+)\/resolve$/))) {
    const b = await form(req)
    const v = vorfall(+m[1])
    if (!v) return answer(req, res, 404, { ok: false, error: t('api.unknown_incident') }, b.back || '/')
    vorfallLoesen(v.id, 'web')
    return answer(req, res, 200, { ok: true }, b.back || (v.run_id ? `/runs/${v.run_id}` : '/'))
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/incidents\/resolve-all$/))) {
    vorfaelleLoesen(m[1], 'web')
    return answer(req, res, 200, { ok: true }, `/runs/${m[1]}`)
  }
  if (req.method === 'GET' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/incidents$/))) {
    const { alleVorfaelle } = await import('./incidents.mjs')
    return json(res, 200, { ok: true, incidents: alleVorfaelle(m[1]) })
  }
  if (req.method === 'POST' && path === '/api/settings/pipeline') {
    setSetting('pipeline_on', (await form(req)).value === '1' ? '1' : '0')
    return json(res, 200, { ok: true })
  }
  // The repo form's "find worktree extras": algorithmic checks first (path
  // exists, is a git project), then a single OpenRouter call. Errors are already
  // translated and arrive as `{ ok:false, error }` — the modal shows them as-is.
  if (req.method === 'POST' && path === '/api/repos/extras-suggest') {
    const b = await form(req)
    const r = await suggestExtras(b.path ?? '')
    return json(res, r.ok ? 200 : 400, r)
  }
  // Without this closing answer any unknown /api/ path would stay UNANSWERED —
  // the browser then waits until timeout instead of showing an error.
  return json(res, 404, { ok: false, error: `unknown API path: ${req.method} ${path}` })
}

// ---------------- HTML fragments ----------------
//
// One piece of a page, on request, as HTML — for a client that wants to refresh
// a single row instead of the document around it.
//
// The point of these endpoints is what they do NOT contain: no markup of their
// own. Every one of them calls the same function the full page calls, so a row
// has exactly ONE renderer. The moment a fragment builds its own <tr>, the two
// drift — that is the lesson server/run-def.mjs was written from.
//
// The terminal block of the detail page is deliberately absent from run-detail:
// swapping #term would tear the xterm instance off the DOM, leave the WebSocket
// open and leak a tmux client that resizes the running agent's window.

/** A fragment that is not there any more is 204, not 404. */
function fragment(res, html) {
  if (!html) return void res.writeHead(204).end()
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
}

async function fragmentApi(req, res, url) {
  const path = url.pathname

  if (path === '/api/fragments/header-status') return fragment(res, headerStatus())
  // Empty when there is neither subscription usage nor a balance — the panel is
  // absent from the page in that case too, and 204 says exactly that.
  if (path === '/api/fragments/usage') return fragment(res, await usagePanel())

  // The whole status sidebar. It is the one fragment that is asked for as a
  // WHOLE rather than piece by piece, and deliberately so: its blocks appear
  // and disappear (no open incidents means no incident block at all), and an
  // element that is absent cannot be swapped into place by its own id. The
  // repo is part of the reading — "work in flight" and "open incidents" are
  // counted for the repo one is looking at.
  if (path === '/api/fragments/sidebar') {
    const repo = url.searchParams.get('repo')
    return fragment(res, await statusSidebar(repo ? +repo : null))
  }

  // The whole tbody. Needed for the one case a row-level swap cannot serve: a
  // run this page does not show YET. The empty state and the sort order both
  // live in the body, so a new row cannot simply be appended — the parent has
  // to be re-rendered, through the very same query the page uses.
  if (path === '/api/fragments/runs-body') {
    const repo = url.searchParams.get('repo')
    if (!repo) return fragment(res, '')
    // The status and incidents filters travel with the request. Without them
    // the first live update would replace a filtered list by the unfiltered
    // one — the page would silently stop showing what the user asked it to
    // show.
    const status = url.searchParams.get('status')
    const incidents = url.searchParams.get('incidents') === '1'
    return fragment(res, runsBody(overviewRuns(+repo, status, incidents), { repoId: +repo, status, incidents }))
  }

  // A row of the overview. Archived counts as gone: the overview does not show
  // archived runs, so the answer is the same as for a run that never existed —
  // 204, and the caller drops the row.
  if (path === '/api/fragments/run-row') {
    const run = getRun(url.searchParams.get('id') ?? '')
    if (!run || run.archived_at) return fragment(res, '')
    const repo = url.searchParams.get('repo')
    return fragment(res, runRow(run, { repoId: repo ? +repo : run.repo_id }))
  }

  // Head, metrics and events of the detail page — the three blocks that change
  // while a run works. Each carries its own id, so they can be placed one by one.
  if (path === '/api/fragments/run-detail') {
    const run = getRun(url.searchParams.get('id') ?? '')
    if (!run) return fragment(res, '')
    const agentName = run.agent_id
      ? db.prepare('SELECT name FROM agents WHERE id=?').get(run.agent_id)?.name ?? null : null
    const title = runTitle(run, agentName, t('overview.single_run'))
    return fragment(res, runDetailHead(run, { title })
      + runEditCard(run) + integrationSection(run, getRepo(run.repo_id)) + runMetrics(run) + runEvents(run.id))
  }

  // There is deliberately no per-session fragment. The sessions page ends a
  // session optimistically in the browser (hub.js marks the row "ending …" in
  // the same tick and strikes it through when the server confirms), so a row
  // never has to be re-rendered from here — and asking would cost a
  // `tmux list-sessions` plus a `ps` over every process for one row.

  return json(res, 404, { ok: false, error: `unknown API path: ${req.method} ${path}` })
}

// ---------------- static files ----------------
const STATIC_MAP = [
  ['/static/xterm.js', '/@xterm/xterm/lib/xterm.js', 'application/javascript'],
  ['/static/xterm.css', '/@xterm/xterm/css/xterm.css', 'text/css'],
  ['/static/addon-fit.js', '/@xterm/addon-fit/lib/addon-fit.js', 'application/javascript'],
  ['/static/hub.css', '/../public/hub.css', 'text/css'],
  ['/static/hub.js', '/../public/hub.js', 'application/javascript'],
  // No-code flow designer (server/flows/, public/flows.js)
  ['/static/flows.js', '/../public/flows.js', 'application/javascript'],
  ['/static/flows.css', '/../public/flows.css', 'text/css'],
  // The two pure flow modules run in the browser as well, so the designer and
  // the server judge a flow by the very same code. The /static/flows/ prefix
  // keeps varschema's relative import of template.mjs resolvable.
  ['/static/flows/template.mjs', '/../server/flows/template.mjs', 'application/javascript'],
  ['/static/flows/varschema.mjs', '/../server/flows/varschema.mjs', 'application/javascript'],
  ['/static/swd.js', '/sequential-workflow-designer/dist/index.umd.js', 'application/javascript'],
  ['/static/swd.css', '/sequential-workflow-designer/css/designer.css', 'text/css'],
  ['/static/swd-light.css', '/sequential-workflow-designer/css/designer-light.css', 'text/css'],
]

/**
 * Every static file that was ever asked for, kept in memory and validated by an
 * ETag — and both halves of that sentence were measured, not assumed.
 *
 * Before this the handler did `readFileSync` on EVERY request and answered with
 * nothing but a content-type. Two consequences, and the second one is the
 * expensive one:
 *
 *  - a synchronous read in the request path blocks the ONE event loop that also
 *    holds every SSE stream, the terminal WebSocket, the scheduler and the
 *    watcher. xterm.js alone is 488 KB off disk;
 *  - with no validator the browser could not revalidate, so it re-downloaded
 *    the whole set on every page view — ~600 KB per page, and ~900 KB on a run
 *    detail page (xterm + addon-fit). Over a connection pool the SSE stream is
 *    already eating into (see vpn-proxy.mjs) that is exactly what "the hub
 *    hangs" felt like.
 *
 * `no-cache` rather than a long `max-age`: these URLs carry no content hash, so
 * a cached hub.js could otherwise outlive a deploy by a day. `no-cache` still
 * means "ask first", and the answer is a 304 of a couple of hundred bytes
 * instead of half a megabyte.
 *
 * The cache is validated against the file's mtime+size on each request — one
 * `statSync` (a metadata lookup, no bytes) instead of a full read. So editing
 * public/hub.js during development still takes effect on the next reload; the
 * dev loop this repo lives on must not be traded away for the cache.
 */
const statCache = new Map()   // route -> { stamp, data, etag }

function serveStatic(req, res, path) {
  for (const [route, file, type] of STATIC_MAP) {
    if (route !== path) continue
    const abs = file.startsWith('/..') ? join(HERE, file) : join(HERE, '..', 'node_modules', file)
    let entry = statCache.get(route)
    try {
      const st = statSync(abs)
      const stamp = `${st.size}-${st.mtimeMs}`
      if (!entry || entry.stamp !== stamp) {
        entry = { stamp, data: readFileSync(abs), etag: `W/"${stamp}"` }
        statCache.set(route, entry)
      }
    } catch {
      statCache.delete(route)
      res.writeHead(404).end('missing — run npm install? (' + file + ')')
      return
    }
    const head = {
      'content-type': type,
      etag: entry.etag,
      'cache-control': 'no-cache',
    }
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, head).end()
      return
    }
    res.writeHead(200, { ...head, 'content-length': entry.data.length }).end(entry.data)
    return
  }
  res.writeHead(404).end()
}
