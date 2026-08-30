// cc-hub — what is already on this machine?
//
// A fresh installation has nothing configured and no way of knowing that the
// operator already has three coding agent CLIs installed and two API keys in
// the environment. The scan answers that once: for every registered coding
// agent whether its binary is on the PATH, for every model provider whether
// any of its declared credential variables is set.
//
// Two rules the whole module hangs on:
//
//  - **A found credential is named, never read.** The row carries the NAME of
//    the environment variable, and nothing else. A discovery row is shown in
//    the UI and could be exported with a database; a secret in it would be a
//    secret in places nobody expects one.
//  - **The operator is asked once.** An upsert never overwrites `asked_at` or
//    `answer`: dismissing a suggestion has to stay dismissed across restarts,
//    otherwise the banner comes back forever.
import db, { getSetting, setSetting } from '../db.mjs'
import { allPlugins, binaryPresent } from './registry.mjs'
import { credentialSpec, pluginConfig } from './store.mjs'

/** When the machine was last scanned (ISO string), or null. */
export function lastScanAt() { return getSetting('discovery_last_scan') }

function upsert({ kind, pluginId, detail }) {
  db.prepare(`INSERT INTO discovery(id, kind, plugin_id, detail)
              VALUES(?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                detail = excluded.detail,
                detected_at = datetime('now')`)
    .run(`${kind}:${pluginId}`, kind, pluginId, JSON.stringify(detail ?? {}))
}

/**
 * Scan the machine for installed coding agents and credentials in the
 * environment. Fire-and-forget from hub.mjs after the server listens: never on
 * a request path, never blocking a start. Returns what was found.
 */
export async function scanSystem(env = process.env) {
  const found = []
  for (const { id, kind, plugin } of allPlugins()) {
    try {
      if (kind === 'harness') {
        if (!plugin?.bin) continue
        if (!(await binaryPresent(plugin.bin))) continue
        upsert({ kind, pluginId: id, detail: { bin: plugin.bin } })
        found.push({ kind, pluginId: id, bin: plugin.bin })
      } else {
        // Which variable, never its value.
        const names = credentialSpec(plugin).flatMap(c => c.envKeys)
        const envVar = names.find(name => !!env[name])
        if (!envVar) continue
        upsert({ kind, pluginId: id, detail: { envVar } })
        found.push({ kind, pluginId: id, envVar })
      }
    } catch { /* one plugin's probe must not end the scan */ }
  }
  setSetting('discovery_last_scan', new Date().toISOString())
  return found
}

function shape(row) {
  let detail = {}
  try { detail = JSON.parse(row.detail || '{}') } catch { detail = {} }
  return { ...row, detail }
}

/**
 * What is worth suggesting: a discovery row whose plugin is registered, that
 * the operator has not configured, and that has not been answered.
 */
export function openDiscoveries() {
  const registered = new Map(allPlugins().map(p => [p.id, p]))
  return db.prepare('SELECT * FROM discovery WHERE answer IS NULL ORDER BY kind, plugin_id').all()
    .filter(row => registered.has(row.plugin_id) && !pluginConfig(row.plugin_id))
    .map(row => ({ ...shape(row), plugin: registered.get(row.plugin_id).plugin }))
}

/** Every discovery row, answered ones included (the Plugins page shows them). */
export function allDiscoveries() {
  return db.prepare('SELECT * FROM discovery ORDER BY kind, plugin_id').all().map(shape)
}

/**
 * The operator answered a suggestion: `added` or `dismissed`. Writing
 * `asked_at` here rather than at render time is what makes "asked once" true —
 * a page that only shows something has not asked anybody anything.
 */
export function answerDiscovery(id, answer) {
  const value = answer === 'added' ? 'added' : 'dismissed'
  db.prepare(`UPDATE discovery SET answer = ?, asked_at = datetime('now') WHERE id = ?`)
    .run(value, String(id))
  return { ok: true, answer: value }
}
