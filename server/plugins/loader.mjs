// Freilauf — loading external plugin packages from disk.
//
// A package is one directory under FREILAUF_PLUGIN_DIR holding a `plugin.json`
// manifest and the module it names (default `index.mjs`, `export default` the
// descriptor). Nothing else about it is special: once registered it is the
// same kind of object the built-in files export.
//
// The rule this whole module is written around: ONE BAD PACKAGE MUST NEVER
// COST THE HUB. Every step is caught, every failure is recorded in the
// registry's error list and shown on the Plugins page, and the loop carries on
// with the next directory.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateManifest } from './manifest.mjs'
import { registerPlugin, addRegistryError } from './registry.mjs'
import { env } from '../env.mjs'
import { dataDir } from '../paths.mjs'

/** Where external plugin packages live. */
export function pluginDir() {
  return env('PLUGIN_DIR') ?? join(dataDir(), 'plugins')
}

/** Read and validate one package's `plugin.json`. Never throws. */
export function readManifest(dir) {
  const file = join(dir, 'plugin.json')
  if (!existsSync(file)) return { ok: false, problems: ['no plugin.json in this directory'] }
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (err) {
    return { ok: false, problems: [`plugin.json cannot be read: ${err.message}`] }
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch (err) {
    return { ok: false, problems: [`plugin.json is not valid JSON: ${err.message}`] }
  }
  return validateManifest(parsed)
}

/**
 * Load ONE package directory: manifest, module, descriptor, registration.
 * Returns `{ ok, id?, kind?, manifest?, error? }` — never throws.
 */
export async function loadPluginPackage(dir) {
  const m = readManifest(dir)
  if (!m.ok) {
    const error = m.problems.join('; ')
    addRegistryError(dir, error)
    return { ok: false, error }
  }
  const main = resolve(dir, m.value.main)
  if (!main.startsWith(resolve(dir))) {
    const error = `"main" points outside the package directory`
    addRegistryError(dir, error)
    return { ok: false, error }
  }
  if (!existsSync(main)) {
    const error = `${m.value.main} does not exist in this package`
    addRegistryError(dir, error)
    return { ok: false, error }
  }
  let mod
  try {
    mod = await import(pathToFileURL(main).href)
  } catch (err) {
    const error = `${m.value.main} could not be imported: ${err.message}`
    addRegistryError(dir, error)
    return { ok: false, error }
  }
  const desc = mod?.default ?? null
  const r = registerPlugin(desc, { source: 'external', manifest: m.value, dir })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, id: m.value.id, kind: m.value.kind, manifest: m.value }
}

/**
 * Load every package in the plugin directory.
 *
 * Called from hub.mjs BEFORE anything reads the registry — a plugin that
 * arrives after the first form was rendered is a plugin the operator cannot
 * choose. A missing directory is the normal case (nobody has installed
 * anything) and is not an error.
 */
export async function loadExternalPlugins() {
  const dir = pluginDir()
  const loaded = []
  let entries = []
  try {
    if (!existsSync(dir)) return { loaded, dir }
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    addRegistryError(dir, `the plugin directory cannot be read: ${err.message}`)
    return { loaded, dir }
  }
  for (const entry of entries) {
    // A symlinked package is fine — statSync follows it; a stray file is not a
    // package and is skipped without complaint.
    const full = join(dir, entry.name)
    try { if (!statSync(full).isDirectory()) continue } catch { continue }
    if (entry.name.startsWith('.')) continue
    const r = await loadPluginPackage(full)
    if (r.ok) loaded.push(r)
  }
  if (loaded.length) console.log(`[plugins] loaded ${loaded.length} external plugin(s) from ${dir}`)
  return { loaded, dir }
}
