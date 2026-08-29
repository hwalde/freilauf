// cc-hub — scheduler (planning 4.2/4.8): the agents' cron expressions, global
// pipeline AND gate, budget gate with deferral instead of discarding.
import db, { addEvent } from './db.mjs'
import { scheduleDue, parseDbUtc } from './util.mjs'
import { createRun, launchRun } from './runner.mjs'
import { claudeGateBlocked, claudeQuota, cursorGateBlocked, deepseekGateBlocked, openrouterGateBlocked } from './quota.mjs'
import { getProvider } from './providers/index.mjs'
import { notifyRun } from './reports.mjs'
import { defFromAgent } from './run-def.mjs'
import { fallbackTitle, applyGeneratedTitle } from './title.mjs'

let timer = null
const fired = new Map()   // "agentId@YYYY-MM-DDTHH:MM" -> true

export function startScheduler() {
  if (timer) return
  timer = setInterval(() => tick().catch(e => console.error('[scheduler]', e.message)), 30_000)
}
export function stopScheduler() { clearInterval(timer); timer = null }

async function tick() {
  const pipelineOn = db.prepare(`SELECT value FROM settings WHERE key='pipeline_on'`).get()?.value === '1'
  if (!pipelineOn) return
  const agents = db.prepare(`SELECT * FROM agents WHERE active = 1 AND schedule_kind <> 'manuell'`).all()
  const now = new Date()
  const slot = now.toISOString().slice(0, 16)
  for (const agent of agents) {
    if (!scheduleDue(agent, now)) continue
    const key = `${agent.id}@${slot}`
    if (fired.get(key)) continue
    fired.set(key, true)
    // The previous run of the same agent is still going? Then do NOT start another —
    // otherwise an agent whose run takes longer than its schedule laps itself
    // and worktrees and LLM sessions pile up. "No fixed limit"
    // (planning 4.2) means different agents, not the same one several times.
    const busy = db.prepare(`SELECT id FROM runs WHERE agent_id=?
      AND status IN ('running','waiting_help','deferred') LIMIT 1`).get(agent.id)
    if (busy) {
      addEvent(busy.id, 'schedule_skipped', { agent: agent.name, slot })
      continue
    }
    // The repo's own ceiling (repos.max_parallel). The slot is marked as fired
    // above, so this is a skipped appointment, not a queue — the next one comes
    // when the schedule says so.
    if (repoAtCapacity(agent.repo_id)) {
      const any = db.prepare(`SELECT id FROM runs WHERE repo_id=? AND status IN ('running','waiting_help')
        ORDER BY started_at DESC LIMIT 1`).get(agent.repo_id)
      if (any) addEvent(any.id, 'schedule_skipped', { agent: agent.name, slot, reason: 'max_parallel' })
      continue
    }
    // One-off schedules fire exactly once and then switch themselves off.
    if (agent.schedule_kind === 'einmalig') {
      db.prepare(`UPDATE agents SET schedule_kind='manuell', run_at=NULL, updated_at=datetime('now') WHERE id=?`).run(agent.id)
    }
    await startForAgent(agent)
  }
  // Bound the map
  if (fired.size > 500) for (const k of fired.keys()) { if (!k.endsWith(slot)) fired.delete(k) }
}

/**
 * Is this repo already running as many runs as it may?
 *
 * repos.max_parallel (0 = unlimited) bounds the SCHEDULED starts only — the
 * agents' timetable and the planned single runs. A start the operator triggers
 * by hand (form, Quick Run, API, "start now") is never blocked: that is a
 * deliberate decision, and a limit that overrules a deliberate decision is a
 * limit one works around.
 */
export function repoAtCapacity(repoId) {
  const limit = Number(db.prepare('SELECT max_parallel FROM repos WHERE id=?').get(repoId)?.max_parallel ?? 0) || 0
  if (limit <= 0) return false
  const n = db.prepare(`SELECT count(*) c FROM runs WHERE repo_id=? AND status IN ('running','waiting_help')`)
    .get(repoId).c
  return n >= limit
}

/**
 * A numeric setting with a fallback. The settings page writes every field as a
 * string, so '' must be treated as "not set", never as 0 — an operator who
 * clears a field must get the default back, not a gate that blocks everything.
 */
function numSetting(key, fallback) {
  const v = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key)?.value
  const n = Number(v)
  return (v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n)) ? n : fallback
}

/** A 0/1 setting with a fallback for installations that have never saved it. */
function flagSetting(key, fallback) {
  const v = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key)?.value
  if (v === undefined || v === null || String(v).trim() === '') return fallback
  return v === '1'
}

/**
 * The budget gate for a run: what the run draws from decides which gate is
 * asked, and every gate can be configured — even switched off entirely.
 *
 * - **claude** runs draw on the subscription quota: the claude gate with its
 *   three configurable thresholds (5 h, general 7 d, the fable week). A run on
 *   a per-model week is measured against THAT week's threshold, a run on any
 *   other model against the general one (quota.mjs).
 * - **cursor** runs draw on the cursor subscription: the cursor gate measures
 *   the included usage of the running period against its own threshold.
 * - a run with `provider='deepseek'` draws on the DeepSeek balance.
 * - everything else (openrouter, no provider named) draws on OpenRouter credits
 *   — the historical default for the provider-based harnesses.
 *
 * Each gate is off when its settings switch (`claude_gate_on`,
 * `openrouter_gate_on`, `deepseek_gate_on`) is '0'. A gate that is switched off
 * cannot block — the operator decided that the window does not govern starts.
 *
 * Returns the blocking reason, or null when the start may happen.
 */
export async function budgetGate(harness, model = null, provider = null) {
  if (harness === 'claude') {
    if (!flagSetting('claude_gate_on', true)) return null
    const seven = numSetting('claude_gate_7d', 95)
    const g = claudeGateBlocked(claudeQuota(), model, {
      five: numSetting('claude_gate_5h', 90),
      seven,
      // Cleared fable field = the fable week follows the general 7-day threshold.
      fable: numSetting('claude_gate_fable', seven),
    })
    return g.blocked ? g : null
  }
  if (harness === 'cursor') {
    if (!flagSetting('cursor_gate_on', true)) return null
    const g = await cursorGateBlocked(
      numSetting('cursor_gate_pct', 95),
      numSetting('cursor_included_usd', 20))
    return g.blocked ? g : null
  }
  if (provider === 'deepseek') {
    if (!flagSetting('deepseek_gate_on', true)) return null
    const g = await deepseekGateBlocked(numSetting('deepseek_min_usd', 2))
    return g.blocked ? g : null
  }
  if (provider === 'openrouter') {
    if (!flagSetting('openrouter_gate_on', true)) return null
    const g = await openrouterGateBlocked(numSetting('openrouter_min_eur', 5))
    return g.blocked ? g : null
  }
  // A known provider WITHOUT a balance contract (opencode-zen) draws on nothing
  // the hub can meter — no gate, same as a provider without a key. Unknown or
  // missing providers keep the historical default: the OpenRouter gate, which is
  // what a hand-typed `openrouter/…` model is.
  const plugin = getProvider(provider)
  if (plugin && !plugin.balance) return null
  if (!flagSetting('openrouter_gate_on', true)) return null
  const g = await openrouterGateBlocked(numSetting('openrouter_min_eur', 5))
  return g.blocked ? g : null
}

/**
 * THE start path: definition in, run out — for the scheduler, the "start now"
 * button, the single-run form, the JSON API and the flow steps alike. Before,
 * each of them created and launched its run itself, and only the agent path
 * knew the budget gate; a single run started into an exhausted quota and died
 * at the first API call instead of being deferred.
 *
 * 'title', 'startMode' and 'startAt' come from the single-run form
 * (runStartFromForm); everything else starts immediately and unnamed, exactly
 * as before.
 *
 * Returns {ok, runId?, deferred?, scheduled?, error?}.
 */
export async function startRun(def, {
  repoId, agentId = null, promptExtra = null,
  title = null, startMode = 'now', startAt = null,
} = {}) {
  // What the run is called: the operator's input first, then the agent's name —
  // an agent run needs no title of its own, one knows the agent. Only a single
  // run with no input at all gets one derived from the prompt.
  const agentName = agentId
    ? db.prepare('SELECT name FROM agents WHERE id=?').get(agentId)?.name ?? null
    : null
  const chosen = String(title ?? '').trim() || agentName || null
  const startTitle = chosen ?? fallbackTitle(def.prompt)

  let runId
  try {
    runId = createRun({ ...def, repoId, agentId, promptExtra, title: startTitle || null })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  // The generated title never holds a start up: the run carries the fallback
  // from the first moment, and the model's answer replaces it when it arrives.
  if (!chosen) applyGeneratedTitle(runId, def.prompt).catch(() => {})

  // A planned start: the run exists and is visible in the overview, it just
  // does not run yet. pickUpScheduled() below takes it from here.
  if (startMode === 'at' || startMode === 'idle') {
    db.prepare(`UPDATE runs SET status='scheduled', start_mode=?, start_at=? WHERE id=?`)
      .run(startMode, startMode === 'at' ? startAt : null, runId)
    addEvent(runId, 'scheduled', { start_mode: startMode, start_at: startAt ?? null })
    return { ok: true, runId, scheduled: true }
  }

  // Budget gate BEFORE the start; blocked → defer (retry in the watcher), do not discard.
  const gate = await budgetGate(def.harness, def.model ?? null, def.provider ?? null)
  if (gate) {
    db.prepare(`UPDATE runs SET status='deferred' WHERE id=?`).run(runId)
    addEvent(runId, 'deferred', { reason: gate.reason, resets_at: gate.resets_at ?? null })
    notifyRun(runId, 'deferred', `🟡 Start deferred — ${gate.reason}${gate.resets_at ? ` (reset: ${gate.resets_at})` : ''}`)
    return { ok: true, runId, deferred: true }
  }
  const r = await launchRun(runId)
  return r.ok ? { ok: true, runId } : { ok: false, runId, error: r.error }
}

/**
 * Starts a run for an agent (also "start now" from the UI) — the agent row is
 * only the stored definition.
 * Returns {ok, runId?, deferred?, error?}.
 */
export async function startForAgent(agent, promptExtra = null) {
  return startRun(defFromAgent(agent), { repoId: agent.repo_id, agentId: agent.id, promptExtra })
}

/**
 * Planned single runs whose moment has come — called by the watcher, NOT by the
 * scheduler tick above: the pipeline switch gates the SCHEDULED agent starts,
 * and a single run the operator sent off by hand is not one of those (same rule
 * as the "start now" button).
 *
 * Two kinds of waiting:
 *   'at'   — a point in time. A missed one (hub was off) is caught up, exactly
 *            like an agent's one-off schedule.
 *   'idle' — until no other run of this repo is going. Then exactly ONE run
 *            starts per repo and pass, because after the first one the repo is
 *            not free any more — including the 'at' runs that start in the same
 *            pass, which is why they mark the repo as busy too.
 *
 * Returns the ids that were started.
 */
export async function pickUpScheduled(nowMs = Date.now()) {
  const rows = db.prepare(`SELECT * FROM runs WHERE status='scheduled' ORDER BY started_at`).all()
  if (!rows.length) return []
  const started = []
  const busy = new Set()
  for (const run of rows) {
    if (run.start_mode === 'idle') {
      if (busy.has(run.repo_id)) continue
      const laufend = db.prepare(`SELECT id FROM runs WHERE repo_id=? AND status IN ('running','waiting_help') LIMIT 1`)
        .get(run.repo_id)
      if (laufend) continue
    } else if (run.start_mode === 'at') {
      const ms = parseDbUtc(run.start_at)
      if (!Number.isFinite(ms) || ms > nowMs) continue
    } else {
      continue   // no waiting kind: nothing to wait for, nothing to decide
    }
    // A planned run is a scheduled start too — it simply waits one more pass.
    if (repoAtCapacity(run.repo_id)) continue
    busy.add(run.repo_id)

    // Same gate as at an immediate start — a waiting run must not start into an
    // exhausted quota either; it moves on to 'deferred' and the watcher retries.
    const gate = await budgetGate(run.harness, run.model ?? null, run.provider ?? null)
    if (gate) {
      db.prepare(`UPDATE runs SET status='deferred' WHERE id=?`).run(run.id)
      addEvent(run.id, 'deferred', { reason: gate.reason, resets_at: gate.resets_at ?? null })
      notifyRun(run.id, 'deferred', `🟡 Start deferred — ${gate.reason}${gate.resets_at ? ` (reset: ${gate.resets_at})` : ''}`)
      continue
    }
    // started_at becomes the REAL start: otherwise the overview would count the
    // waiting time as runtime and every planned run would look overdue.
    db.prepare(`UPDATE runs SET status='running', started_at=datetime('now'),
                last_activity_at=datetime('now') WHERE id=?`).run(run.id)
    addEvent(run.id, 'scheduled_start', { start_mode: run.start_mode, start_at: run.start_at ?? null })
    started.push(run.id)
    const r = await launchRun(run.id)
    if (!r.ok) notifyRun(run.id, 'start_failed', `Planned start failed: ${r.error}`)
  }
  return started
}

/**
 * A deferred run actually starts. Two callers, one rule:
 *
 * - the watcher's `retryDeferred` — the gate opened by itself, the run may
 *   start (forced = false);
 * - the detail page's "Start anyway" button — the OPERATOR decided that the
 *   window does not govern THIS run, so the gate is not asked again
 *   (forced = true).
 *
 * `started_at` becomes the real start, exactly as for a planned run: otherwise
 * the overview would count the deferred waiting time as runtime and the run
 * would look overdue the moment it began.
 */
export async function startDeferredRun(runId, { forced = false } = {}) {
  const run = db.prepare(`SELECT * FROM runs WHERE id=? AND status='deferred'`).get(runId)
  if (!run) return { ok: false, error: 'not deferred' }
  db.prepare(`UPDATE runs SET status='running', started_at=datetime('now'),
              last_activity_at=datetime('now') WHERE id=?`).run(runId)
  addEvent(runId, forced ? 'forced_start' : 'deferred_retry', {})
  const r = await launchRun(runId)
  if (!r.ok) notifyRun(runId, 'start_failed', `Start after deferral failed: ${r.error}`)
  return r
}
