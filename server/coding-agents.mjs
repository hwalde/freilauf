// cc-hub — configured coding agents.
//
// The harness plugins (server/harnesses) describe what the hub COULD drive;
// this module holds what the operator has actually CONFIGURED in the settings.
// Forms only offer configured & enabled coding agents, and each configured
// coding agent carries its own provider selection.
//
// A fresh installation starts with NO coding agents — every page then shows a
// banner pointing to the settings. A seed file (installed e.g. by a private
// setup repo) can pre-populate the configuration on first start.
//
// Since coding agents and model providers became one kind of thing — plugins —
// the storage is `plugin_config` (server/plugins/store.mjs), which carries both
// kinds plus credentials and per-plugin settings. This module stays as it was
// from the outside: an ADAPTER with the same exported API and the same row
// shape, so its call sites and both test groups keep working. The old
// `coding_agents` table is still created below and left untouched after the
// one-time migration, so a rollback to an earlier hub finds its data.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import db from './db.mjs'
import { getHarness, harnessIds } from './harnesses/index.mjs'
import { providerFuerHarness } from './models.mjs'
import {
  listPluginConfigs, pluginConfig, setPluginConfig, setPluginProviders,
} from './plugins/store.mjs'

db.exec(`
CREATE TABLE IF NOT EXISTS coding_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  harness TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  providers TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

/**
 * A `plugin_config` row in the shape this module has always handed out:
 * `id` is the row's own id (the delete form posts it), `harness` the plugin id.
 */
function asCodingAgent(row) {
  if (!row) return null
  return {
    id: row.id,
    harness: row.plugin_id,
    enabled: row.enabled,
    providers: JSON.stringify(row.config.providers),
    providerIds: row.config.providers,
    plugin: getHarness(row.plugin_id),   // null when the plugin was removed
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** All configured coding agents (also disabled ones) with plugin metadata. */
export function listCodingAgents() {
  return listPluginConfigs('harness').map(asCodingAgent)
}

/** Only enabled coding agents whose plugin still exists. */
export function enabledCodingAgents() {
  return listCodingAgents().filter(a => a.enabled === 1 && a.plugin)
}

export function codingAgentFor(harness) {
  const row = pluginConfig(harness)
  return row && row.kind === 'harness' ? asCodingAgent(row) : null
}

export function isHarnessEnabled(harness) {
  const a = codingAgentFor(harness)
  return !!a && a.enabled === 1 && !!a.plugin
}

/**
 * Providers to offer in the forms for one harness: the plugin capability list
 * (already filtered by available credentials in providerFuerHarness), further
 * restricted to what the operator selected for this coding agent.
 */
export function providersForHarness(harness) {
  const a = codingAgentFor(harness)
  if (!a || !a.plugin || a.plugin.subscription) return []
  const chosen = new Set(a.providerIds)
  return providerFuerHarness(harness).filter(p => chosen.has(p.id))
}

/**
 * Add or update a coding agent. Validates against the plugin registry —
 * unknown harnesses or providers never reach the database.
 * Returns { ok, problems }.
 */
export function saveCodingAgent({ harness, enabled = 1, providers = [] }) {
  const problems = []
  const plugin = getHarness(harness)
  if (!plugin) problems.push(`unknown coding agent: ${harness}`)
  if (problems.length) return { ok: false, problems }
  setPluginConfig(harness, { kind: 'harness', enabled: enabled ? 1 : 0 })
  setPluginProviders(harness, providers)   // drops anything the plugin does not declare
  return { ok: true, problems: [] }
}

export function deleteCodingAgent(id) {
  db.prepare(`DELETE FROM plugin_config WHERE rowid = ? AND kind = 'harness'`).run(id)
}

/** Path of the optional seed file (private setup repos install it there). */
export function seedFilePath() {
  return process.env.CCHUB_AGENTS_SEED ?? join(homedir(), '.config', 'cc-hub', 'coding-agents.json')
}

/**
 * Seed the configuration on first start: only when NO coding agent is
 * configured yet and the seed file exists. Idempotent by construction — a
 * configuration with rows is never touched, so operator edits always win.
 * Returns the number of seeded coding agents (0 = nothing done).
 */
export function seedIfEmpty() {
  if (listCodingAgents().length > 0) return 0
  const file = seedFilePath()
  if (!existsSync(file)) return 0
  let seed
  try { seed = JSON.parse(readFileSync(file, 'utf8')) } catch (err) {
    console.warn(`[coding-agents] seed file ${file} is not valid JSON: ${err.message}`)
    return 0
  }
  let n = 0
  for (const entry of seed?.coding_agents ?? []) {
    const r = saveCodingAgent({
      harness: String(entry.harness ?? ''),
      enabled: entry.enabled === false ? 0 : 1,
      providers: Array.isArray(entry.providers) ? entry.providers.map(String) : [],
    })
    if (r.ok) n++
    else console.warn(`[coding-agents] seed entry skipped: ${r.problems.join(', ')}`)
  }
  if (n) console.log(`[coding-agents] seeded ${n} coding agent(s) from ${file}`)
  return n
}

/** For the "add" dialog: which registered plugins are not configured yet? */
export function unconfiguredHarnessIds() {
  const have = new Set(listCodingAgents().map(a => a.harness))
  return harnessIds().filter(id => !have.has(id))
}
