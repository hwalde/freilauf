// Freilauf — plugin configuration in the database.
//
// The registry says what the hub COULD drive; this module holds what the
// operator has actually configured: which plugins are enabled, which model
// providers a coding agent may use, and the credentials — the answer to "use a
// different API key" and "read it from a different environment variable".
//
// One table for both kinds, because the two questions are the same question:
// `coding_agents` only ever knew coding agents, so a provider had no place to
// carry a credential, a setting or an enabled flag. The old table is left
// in place untouched after the one-time migration, so a rollback works.
import db, { getSetting, setSetting } from '../db.mjs'
import { getPlugin, pluginKind, pluginSource } from './registry.mjs'

db.exec(`
CREATE TABLE IF NOT EXISTS plugin_config (
  plugin_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  -- {providers: [], credentials: {}, settings: {}}
  config     TEXT NOT NULL DEFAULT '{}',
  source     TEXT NOT NULL DEFAULT 'builtin',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discovery (
  id          TEXT PRIMARY KEY,          -- '<kind>:<pluginId>'
  kind        TEXT NOT NULL,             -- harness | provider
  plugin_id   TEXT NOT NULL,
  detail      TEXT,                      -- JSON: {bin, path, envVar}
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  asked_at    TEXT,                      -- the operator was asked once
  answer      TEXT                       -- added | dismissed
);
`)

/**
 * One-time migration out of `coding_agents`.
 *
 * Guarded by a settings key rather than by "is the new table empty": an
 * operator who deletes every coding agent after the migration must not get the
 * old rows back on the next restart. The old table stays as it is — nothing
 * reads it any more, and a rollback to the previous hub finds its data.
 */
function migrateCodingAgents() {
  if (getSetting('plugins_migrated') === '1') return
  const have = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='coding_agents'`).get()
  if (have) {
    let n = 0
    for (const row of db.prepare('SELECT * FROM coding_agents').all()) {
      let providers = []
      try { providers = JSON.parse(row.providers || '[]') } catch { providers = [] }
      db.prepare(`INSERT INTO plugin_config(plugin_id, kind, enabled, config, source, created_at)
                  VALUES(?,'harness',?,?,?,?)
                  ON CONFLICT(plugin_id) DO NOTHING`)
        .run(String(row.harness), row.enabled ? 1 : 0,
          JSON.stringify({ providers }),
          pluginSource(String(row.harness)) ?? 'builtin',
          row.created_at ?? new Date().toISOString())
      n++
    }
    if (n) console.log(`[plugins] migrated ${n} coding agent(s) from coding_agents into plugin_config`)
  }
  setSetting('plugins_migrated', '1')
}
migrateCodingAgents()

const EMPTY_CONFIG = { providers: [], credentials: {}, settings: {} }

function parseConfig(raw) {
  let parsed
  try { parsed = JSON.parse(raw || '{}') } catch { parsed = {} }
  return {
    providers: Array.isArray(parsed.providers) ? parsed.providers.map(String) : [],
    credentials: parsed.credentials && typeof parsed.credentials === 'object' && !Array.isArray(parsed.credentials)
      ? parsed.credentials : {},
    settings: parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)
      ? parsed.settings : {},
  }
}

function shape(row) {
  if (!row) return null
  return { ...row, config: parseConfig(row.config) }
}

/** The stored configuration of one plugin, or null when it has none yet. */
export function pluginConfig(id) {
  return shape(db.prepare('SELECT rowid AS id, * FROM plugin_config WHERE plugin_id = ?').get(String(id)))
}

/** Every stored plugin configuration; `kind` narrows it to one of the two kinds. */
export function listPluginConfigs(kind = null) {
  const rows = kind
    ? db.prepare('SELECT rowid AS id, * FROM plugin_config WHERE kind = ? ORDER BY plugin_id').all(String(kind))
    : db.prepare('SELECT rowid AS id, * FROM plugin_config ORDER BY plugin_id').all()
  return rows.map(shape)
}

/**
 * Write a plugin's configuration. `patch` may carry `enabled`, `kind`,
 * `source` and a `config` object which is merged into the stored one at the
 * top level — so writing providers never drops the credentials next to them.
 */
export function setPluginConfig(id, patch = {}) {
  const pid = String(id)
  const current = pluginConfig(pid)
  const kind = patch.kind ?? current?.kind ?? pluginKind(pid) ?? 'harness'
  const source = patch.source ?? current?.source ?? pluginSource(pid) ?? 'builtin'
  const enabled = patch.enabled === undefined
    ? (current ? current.enabled : 1)
    : (patch.enabled ? 1 : 0)
  const config = { ...EMPTY_CONFIG, ...(current?.config ?? {}), ...(patch.config ?? {}) }
  db.prepare(`INSERT INTO plugin_config(plugin_id, kind, enabled, config, source)
              VALUES(?,?,?,?,?)
              ON CONFLICT(plugin_id) DO UPDATE SET
                kind = excluded.kind,
                enabled = excluded.enabled,
                config = excluded.config,
                source = excluded.source,
                updated_at = datetime('now')`)
    .run(pid, kind, enabled ? 1 : 0, JSON.stringify(config), source)
  return pluginConfig(pid)
}

/**
 * Is this plugin switched on?
 *
 * `defaultOn` is what an UNCONFIGURED plugin answers, and a coding agent is the
 * one kind that differs: it must be configured before the hub starts runs with
 * it (a fresh installation deliberately has none), while a model provider has
 * always been usable the moment its credential existed — there was no enable
 * flag for providers before this table, and inventing an off-by-default one
 * would switch off working installations.
 *
 * A NOTIFIER follows the provider rule, and for the same reason one step
 * further on: an installation that already has a Telegram token in `settings`
 * has no `plugin_config` row for it either, and an off-by-default notifier
 * would silence a channel that was working the minute before the upgrade. The
 * fresh installation stays quiet all the same — being enabled is not being
 * configured, and `notifiersConfigured()` asks the second question.
 */
export function isPluginEnabled(id, defaultOn = pluginKind(id) !== 'harness') {
  const row = pluginConfig(id)
  if (!row) return !!defaultOn
  return row.enabled === 1
}

export function setPluginEnabled(id, on) {
  return setPluginConfig(id, { enabled: on ? 1 : 0 })
}

/**
 * Store the allowed model providers of a coding agent. Only ids the plugin
 * itself declares survive — an unknown provider never reaches the database.
 */
export function setPluginProviders(id, ids = []) {
  const plugin = getPlugin(id)
  const allowed = new Set(plugin?.providers ?? [])
  const chosen = [...new Set((ids ?? []).map(String))].filter(p => allowed.has(p))
  return setPluginConfig(id, { config: { providers: chosen } })
}

/**
 * The credentials a plugin declares, in one shape.
 *
 * A provider written before this existed declares `envKeys` and nothing else;
 * that is a single credential called `api_key`, and saying so here means every
 * caller sees one list instead of two cases.
 */
export function credentialSpec(plugin) {
  if (!plugin) return []
  if (Array.isArray(plugin.credentials)) {
    return plugin.credentials
      .filter(c => c && typeof c.key === 'string' && c.key)
      .map(c => ({
        key: String(c.key),
        envKeys: Array.isArray(c.envKeys) ? c.envKeys.map(String) : [],
        labelKey: c.labelKey ?? 'plugins.credential',
        helpKey: c.helpKey ?? null,
        required: !!c.required,
      }))
  }
  if (Array.isArray(plugin.envKeys) && plugin.envKeys.length) {
    return [{
      key: 'api_key',
      envKeys: plugin.envKeys.map(String),
      labelKey: 'plugins.credential',
      helpKey: null,
      required: false,
    }]
  }
  return []
}

/**
 * The credential the hub should use for this plugin, resolved in one place:
 *
 *  1. a value the operator stored for this plugin,
 *  2. the environment variable the operator NAMED for it,
 *  3. the first of the plugin's own declared variables that is set.
 *
 * A stored value lives in the local SQLite database (`~/.local/share/freilauf`,
 * the hub's own data directory) as plain text — the same file that already
 * holds every other configured secret. It is offered because a machine cannot always be
 * given another environment variable; where it can, naming the variable is the
 * better answer, and the UI says so.
 */
export function credentialValue(pluginId, key = 'api_key', env = process.env) {
  const entry = pluginConfig(pluginId)?.config.credentials?.[key] ?? null
  const stored = typeof entry?.value === 'string' ? entry.value.trim() : ''
  if (stored) return stored
  const named = typeof entry?.envVar === 'string' ? entry.envVar.trim() : ''
  if (named && env[named]) return env[named]
  const spec = credentialSpec(getPlugin(pluginId)).find(c => c.key === key)
  for (const name of spec?.envKeys ?? []) if (env[name]) return env[name]
  return null
}

/**
 * Store how one credential is obtained.
 *
 *  - `mode: 'env'`   — read `envVar` from the environment (the stored value is dropped)
 *  - `mode: 'value'` — use `value` as it stands (the named variable is dropped)
 *  - anything else   — forget the override; the plugin's own declared variables apply again
 */
export function setCredential(pluginId, key, { mode = 'default', envVar = '', value = '' } = {}) {
  const current = pluginConfig(pluginId)?.config.credentials ?? {}
  const credentials = { ...current }
  const k = String(key || 'api_key')
  if (mode === 'env') {
    const name = String(envVar ?? '').trim()
    if (name) credentials[k] = { mode: 'env', envVar: name }
    else delete credentials[k]
  } else if (mode === 'value') {
    const v = String(value ?? '').trim()
    if (v) credentials[k] = { mode: 'value', value: v }
    // An empty value with mode 'value' is "keep what is stored": the form
    // renders a password field it cannot pre-fill, so submitting it blank must
    // not silently delete the credential.
  } else {
    delete credentials[k]
  }
  return setPluginConfig(pluginId, { config: { credentials } })
}

/** Does this plugin have a credential from anywhere at all? */
export function pluginHasCredential(pluginId, env = process.env) {
  const spec = credentialSpec(getPlugin(pluginId))
  if (!spec.length) return false
  return spec.some(c => !!credentialValue(pluginId, c.key, env))
}

/** Drop a plugin's stored configuration entirely (uninstalling a package). */
export function forgetPlugin(id) {
  db.prepare('DELETE FROM plugin_config WHERE plugin_id = ?').run(String(id))
  db.prepare('DELETE FROM discovery WHERE plugin_id = ?').run(String(id))
}
