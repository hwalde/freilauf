// cc-hub — HTTP: server-rendered HTML + JSON API (planning 5).
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import db, { getRepo, getRun, setSetting, addEvent, announceRun } from './db.mjs'
import { handleReport } from './reports.mjs'
import { modelList, orEndpoints, standVon, effortOptionen } from './models.mjs'
import { providersForHarness, listCodingAgents } from './coding-agents.mjs'
import { detectInstalled } from './harnesses/index.mjs'
import { subscriptionUsage } from './usage.mjs'
import { providerBalances } from './balances.mjs'
import { sseHandler } from './events.mjs'
import { launchRun } from './runner.mjs'
import { startRun } from './scheduler.mjs'
import { runDefFromForm, runStartFromForm, saveAgent, rememberRunChoice, lastRunChoiceFor } from './run-def.mjs'
import { runTitle, TITLE_MAX } from './title.mjs'
import {
  pageOverview, pageAgents, pageRunForm, pageRun, pageRepos, pageSettings, pageSessions,
  pageArchive,
  runNewPost, agentEdit, agentSave, agentToggle, agentStart,
  agentDelete, agentMovePage, agentMovePost,
  repoEdit, repoSave, settingsSave, settingsTestTelegram,
  telegramSetup, telegramTokenSave, telegramChatSave, telegramChats,
  pageCodingAgents, codingAgentSave, codingAgentDelete,
  pageFavorites, favoriteEdit, favoriteSave, favoriteDelete,
  pageMergeSettings, mergeSettingsSave,
  headerStatus, usagePanel, statusSidebar, runRow, runsBody, overviewRuns, runDetailHead, runMetrics, runEvents, sessionRow,
  integrationSection, problemPage,
} from './pages.mjs'
import { getFavorite, favoriteToFormBody } from './favorites.mjs'
import { mergeByHand, skipMerge, resetIntegration } from './integrate.mjs'
import { redirect, body as readBody, parseForm, rememberRepo } from './web-helpers.mjs'
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
  if (req.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/static/') && url.searchParams.has('repo')) {
    const id = Number(url.searchParams.get('repo'))
    if (Number.isInteger(id) && getRepo(id)) rememberRepo(res, id)
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

  // --- Telegram setup assistant ---
  if (req.method === 'GET' && path === '/telegram-setup') return telegramSetup(req, res, url)
  if (req.method === 'POST' && path === '/telegram-setup/token') return telegramTokenSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/telegram-setup/chat') return telegramChatSave(req, res, url, formBody)

  // --- pages ---
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
  if (req.method === 'GET' && path === '/settings') return pageSettings(req, res, url)
  if (req.method === 'POST' && path === '/settings/save') return settingsSave(req, res, url, formBody)
  if (req.method === 'POST' && path === '/settings/test-telegram') return settingsTestTelegram(req, res)
  // Coding agents (Settings → Coding agents)
  if (req.method === 'GET' && path === '/settings/coding-agents') return pageCodingAgents(req, res, url)
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
  if (req.method === 'GET' && path === '/api/telegram/chats') return telegramChats(req, res)
  if (path.startsWith('/api/flows') || path.startsWith('/api/flow-runs')) return flowApi(req, res, url)

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
  // The report endpoint answers 200 with `{ ok, message }`, and the message is
  // the point: with the repo's integration switched on the finish gate has
  // something to SAY back ("your worktree is dirty", "this conflicts"), and
  // cc-report prints it into the agent's running turn. It must be a 2xx —
  // cc-report treats anything else as "hub unreachable" and files the report in
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
  if (req.method === 'POST' && path === '/api/runs/quick') {
    const b = await form(req)
    const fav = getFavorite(b.favorite_id)
    if (!fav) return json(res, 400, { ok: false, error: t('qr.err_favorite') })
    const problems = []
    const def = await runDefFromForm({ ...favoriteToFormBody(fav), ...pickQuickFields(b) }, problems)
    const start = runStartFromForm(b, problems)
    if (problems.length) return json(res, 400, { ok: false, error: problems.join(' · ') })
    rememberRunChoice(def)
    const r = await startRun(def, { repoId: +b.repo_id, ...start })
    if (!r.ok) return json(res, 500, { ok: false, error: r.error ?? t('run.start_failed') })
    const run = getRun(r.runId)
    return json(res, 200, {
      ok: true, runId: r.runId, deferred: !!r.deferred, scheduled: !!r.scheduled,
      title: run?.title ?? null, favorite: fav.name,
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
    if (['running', 'waiting_help', 'scheduled', 'deferred'].includes(run.status)) {
      return answer(req, res, 400, { ok: false, error: t('api.archive_only_finished') }, `/runs/${run.id}`)
    }
    db.prepare(`UPDATE runs SET archived_at=COALESCE(archived_at, datetime('now')) WHERE id=?`).run(run.id)
    announceRun(run.id, 'archived')
    const b = await form(req)
    return answer(req, res, 200, { ok: true, archived: true }, b.back || `/runs/${run.id}`)
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
    } else {
      addEvent(run.id, 'message_sent', { text: text.slice(0, 500) })
    }
    return answer(req, res, 200, { ok: true }, `/runs/${run.id}`)
  }
  if (req.method === 'POST' && (m = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/kill$/))) {
    const run = getRun(m[1])
    const { sh } = await import('./util.mjs')
    if (run?.tmux_session) await sh('tmux', ['kill-session', '-t', `=${run.tmux_session}`])
    // A run that is ALREADY over only loses the session it left standing. Writing
    // 'aborted' over it would turn a run that came through cleanly into a failed
    // one — and since the coding agents keep their session after the work is
    // done, that is not a corner case but the ordinary state of a finished run.
    // Same rule, and same event, as reconcileClosedSession(). Only the three
    // terminal statuses count: a 'scheduled' or 'deferred' run is cancelled
    // through this very endpoint, and cancelling it IS setting it to 'aborted'.
    if (['done', 'failed', 'aborted'].includes(run?.status ?? '')) {
      db.prepare(`UPDATE runs SET tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')) WHERE id=?`).run(m[1])
      if (run && !run.tmux_closed_at) addEvent(m[1], 'tmux_closed', { source: 'user' })
      return answer(req, res, 200, { ok: true }, `/runs/${m[1]}`)
    }
    // Set tmux_closed_at right away: otherwise the detail page tries to attach
    // a terminal to the dead session until the next watcher tick (410 in the browser).
    db.prepare(`UPDATE runs SET status='aborted', ended_at=COALESCE(ended_at, datetime('now')),
                tmux_closed_at=COALESCE(tmux_closed_at, datetime('now')), finish_state=NULL WHERE id=?`).run(m[1])
    // Same event kind reconcileClosedSession() writes, so "why did this run
    // stop?" has one answer to look for rather than two.
    addEvent(m[1], 'aborted', { by: 'user' })
    // An end somebody ASKED for is an abort, even in the finish gate — and what
    // it leaves behind is assessed like any other unfinished run (no Telegram:
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
    db.prepare(`UPDATE runs SET status='running', ended_at=NULL, report_md=NULL, archived_at=NULL,
                goal_sent_at=NULL WHERE id=?`).run(m[1])
    // …and so does the integration: everything the finish gate and the
    // integrator wrote about the previous attempt is gone.
    resetIntegration(m[1])
    addEvent(m[1], 'retry', { previous_status: run.status })
    const r = await launchRun(m[1])
    return answer(req, res, r.ok ? 200 : 500, r, `/runs/${m[1]}`)
  }
  // ---- integration by hand (server/integrate.mjs, buttons on the detail page) ----
  //
  // "Mark as done" is exactly what `cc-report done` is, only typed by a human:
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
    // The status filter travels with the request. Without it the first live
    // update would replace a filtered list by the unfiltered one — the page
    // would silently stop showing what the user asked it to show.
    const status = url.searchParams.get('status')
    return fragment(res, runsBody(overviewRuns(+repo, status), { repoId: +repo, status }))
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
      + integrationSection(run, getRepo(run.repo_id)) + runMetrics(run) + runEvents(run.id))
  }

  // A session row. listSessions() asks tmux, so this is the one fragment that
  // costs a process — and the reason the sessions page does not poll it in bulk.
  if (path === '/api/fragments/session-row') {
    const name = url.searchParams.get('name') ?? ''
    const { listSessions } = await import('./sessions.mjs')
    const s = name ? (await listSessions()).find(x => x.name === name) : null
    return fragment(res, s ? sessionRow(s, {}) : '')
  }

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
