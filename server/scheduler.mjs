// cc-hub — Scheduler (Planung 4.2/4.8): Cron-Ausdrücke der Agenten, globales
// Pipeline-Und-Gatter, Budget-Gate mit Verschieben statt Verwerfen.
import db, { addEvent } from './db.mjs'
import { scheduleDue } from './util.mjs'
import { createRun, launchRun } from './runner.mjs'
import { claudeGateBlocked, openrouterGateBlocked, claudeQuota } from './quota.mjs'
import { notifyRun } from './reports.mjs'

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
    // Der vorige Lauf desselben Agenten läuft noch? Dann NICHT nachlegen — sonst
    // überholt ein Agent, dessen Lauf länger dauert als sein Zeitplan, sich selbst
    // und es stapeln sich Worktrees und LLM-Sessions. „Kein festes Limit"
    // (Planung 4.2) meint verschiedene Agenten, nicht denselben mehrfach.
    const busy = db.prepare(`SELECT id FROM runs WHERE agent_id=?
      AND status IN ('running','waiting_help','deferred') LIMIT 1`).get(agent.id)
    if (busy) {
      addEvent(busy.id, 'schedule_skipped', { agent: agent.name, slot })
      continue
    }
    // Einmalige Termine feuern genau einmal und schalten sich danach selbst ab.
    if (agent.schedule_kind === 'einmalig') {
      db.prepare(`UPDATE agents SET schedule_kind='manuell', run_at=NULL, updated_at=datetime('now') WHERE id=?`).run(agent.id)
    }
    await startForAgent(agent)
  }
  // Map begrenzen
  if (fired.size > 500) for (const k of fired.keys()) { if (!k.endsWith(slot)) fired.delete(k) }
}

/**
 * Startet einen Lauf für einen Agenten (auch „jetzt starten" aus der UI).
 * Liefert {ok, runId?, deferred?, error?}.
 */
export async function startForAgent(agent, promptExtra = null) {
  // Budget-Gates VOR dem Start; blocked → verschieben (Retry im Watcher), nicht verwerfen.
  const gate = agent.harness === 'claude'
    ? (() => { const g = claudeGateBlocked(); return g.blocked ? g : null })()
    : await openrouterGateBlocked(Number(db.prepare(`SELECT value FROM settings WHERE key='openrouter_min_eur'`).get()?.value ?? 5) || 5)
        .then(g => (g.blocked ? g : null))

  let runId
  try {
    runId = createRun({
      repoId: agent.repo_id, agentId: agent.id, harness: agent.harness, model: agent.model,
      provider: agent.provider ?? null, orProvider: agent.or_provider ?? null,
      effort: agent.effort ?? null,
      prompt: agent.prompt, promptExtra, branchMode: agent.branch_mode,
      branchPattern: agent.branch_pattern, expectedMinutes: agent.expected_minutes,
      skills: agent.skills ?? null,
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  if (gate) {
    const q = claudeQuota()
    db.prepare(`UPDATE runs SET status='deferred' WHERE id=?`).run(runId)
    addEvent(runId, 'deferred', { reason: gate.reason, resets_at: gate.resets_at ?? null })
    notifyRun(runId, 'deferred', `🟡 Start verschoben — ${gate.reason}${gate.resets_at ? ` (Reset: ${gate.resets_at})` : ''}`)
    return { ok: true, runId, deferred: true }
  }
  const r = await launchRun(runId)
  return r.ok ? { ok: true, runId } : { ok: false, runId, error: r.error }
}
