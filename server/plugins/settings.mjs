// Freilauf — settings a plugin declares for itself.
//
// A plugin carries two groups of operator-configurable fields: `settings`
// (rendered on the Plugins page, next to the plugin) and `gate.fields` (the
// budget-gate thresholds, rendered under Settings → Budget gates). Both are
// `SettingField` objects:
//
//   { key, type: 'number'|'text'|'password'|'select'|'switch', default,
//     labelKey, hintKey?, options?, min?, max?, step?, settingKey? }
//
// `settingKey` is the escape hatch that keeps history. The built-in gates
// declare the keys they have always used (`claude_gate_5h`, `openrouter_min_eur`
// …), so nothing in an existing settings table has to be migrated. A field
// without one is namespaced `plugin_<id>_<key>`, which is what makes two
// plugins declaring a field called `threshold` harmless.
import { getSetting } from '../db.mjs'
import { allPlugins } from './registry.mjs'
import { isPluginEnabled } from './store.mjs'

/** The settings-table key one declared field is stored under. */
export function pluginSettingKey(pluginId, field) {
  if (field?.settingKey) return String(field.settingKey)
  return `plugin_${pluginId}_${field?.key ?? ''}`
}

/** The fields of one group of a plugin, always as an array. */
export function pluginFields(plugin, group = 'settings') {
  const raw = group === 'gate' ? plugin?.gate?.fields : plugin?.settings
  return Array.isArray(raw) ? raw.filter(f => f && typeof f.key === 'string' && f.key) : []
}

/**
 * The stored value of one field — the settings table, falling back to the
 * field's own default. Always a string or the declared default as it stands,
 * because that is what the settings table holds and what a form renders.
 */
export function pluginSettingValue(pluginId, field) {
  const v = getSetting(pluginSettingKey(pluginId, field))
  return v === null || v === undefined ? (field?.default ?? null) : v
}

/**
 * Every settings key declared by any REGISTERED plugin.
 *
 * This is what extends the `SETTINGS_KEYS` allowlist on the settings page: a
 * key that is not in it is silently dropped when the form is saved, so an
 * installed plugin's own thresholds would look configurable and never stick.
 * Both groups, deduplicated, in registration order.
 */
export function allPluginSettingKeys() {
  const keys = new Set()
  for (const { plugin } of allPlugins()) {
    for (const group of ['settings', 'gate']) {
      for (const field of pluginFields(plugin, group)) keys.add(pluginSettingKey(plugin.id, field))
    }
  }
  return [...keys]
}

/**
 * The plugins whose budget gate the operator can configure: registered,
 * enabled, and declaring gate fields. A disabled plugin's thresholds are not
 * rendered — a form field for something that cannot run is noise.
 */
export function gatePlugins() {
  return allPlugins()
    .filter(p => pluginFields(p.plugin, 'gate').length && isPluginEnabled(p.id))
    .map(p => ({ id: p.id, kind: p.kind, plugin: p.plugin }))
}
