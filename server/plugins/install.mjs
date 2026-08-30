// cc-hub — installing and removing external plugin packages.
//
// Installing is a directory copy plus a load: the operator points at a
// directory that holds a `plugin.json`, the hub validates the manifest FIRST
// (a package whose id collides with a built-in must be refused before anything
// is written to disk), copies it into the plugin directory and registers it.
//
// Everything here answers `{ ok, error? }` with an English, developer-facing
// error string — the Plugins page shows it as it stands.
import { cpSync, rmSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { readManifest, loadPluginPackage, pluginDir } from './loader.mjs'
import {
  allPlugins, pluginSource, pluginManifest, pluginDirOf,
  unregisterPlugin, registryErrors,
} from './registry.mjs'
import { forgetPlugin } from './store.mjs'

/**
 * Install a package from a directory on this machine.
 *
 * Refuses anything that is not a directory with a valid `plugin.json`, and
 * refuses an id that is already registered — a package shadowing `claude`
 * would replace the coding agent runs are started with, without saying so.
 */
export async function installFromDirectory(srcPath) {
  const src = resolve(String(srcPath ?? '').trim())
  if (!src) return { ok: false, error: 'no directory given' }
  try {
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      return { ok: false, error: `${src} is not a directory` }
    }
  } catch (err) {
    return { ok: false, error: `${src} cannot be read: ${err.message}` }
  }

  const m = readManifest(src)
  if (!m.ok) return { ok: false, error: m.problems.join('; ') }

  const id = m.value.id
  if (allPlugins().some(p => p.id === id)) {
    const source = pluginSource(id)
    return { ok: false, error: `plugin id "${id}" is already taken by the ${source} plugin — refused` }
  }

  const dir = pluginDir()
  const dest = join(dir, id)
  if (existsSync(dest)) {
    return { ok: false, error: `${dest} already exists — remove it first` }
  }
  // Installing from the plugin directory itself would copy a package onto
  // itself under a different name; nothing good comes of that.
  if (resolve(src) === resolve(dest)) return { ok: false, error: 'the package is already installed' }

  try {
    mkdirSync(dir, { recursive: true })
    cpSync(src, dest, { recursive: true, dereference: true })
  } catch (err) {
    try { rmSync(dest, { recursive: true, force: true }) } catch { /* nothing to clean up */ }
    return { ok: false, error: `copying the package failed: ${err.message}` }
  }

  const r = await loadPluginPackage(dest)
  if (!r.ok) {
    // A package that cannot be loaded is not installed: leaving it on disk
    // would make it fail again on every restart, in the log, forever.
    try { rmSync(dest, { recursive: true, force: true }) } catch { /* nothing to clean up */ }
    return { ok: false, error: r.error }
  }
  return { ok: true, id: r.id, kind: r.kind, path: dest }
}

/**
 * Remove an external package: its directory and its stored configuration.
 * A built-in is refused — it is part of the running code, and a registry that
 * disagreed with the imports would be a lie.
 */
export function uninstallPlugin(id) {
  const pid = String(id ?? '').trim()
  if (!pid) return { ok: false, error: 'no plugin given' }
  const source = pluginSource(pid)
  if (!source) return { ok: false, error: `unknown plugin "${pid}"` }
  if (source === 'builtin') return { ok: false, error: `"${pid}" is a built-in plugin and cannot be removed` }

  const dir = pluginDirOf(pid) ?? join(pluginDir(), pid)
  // Never delete outside the plugin directory, whatever the registry says.
  if (!resolve(dir).startsWith(resolve(pluginDir()))) {
    return { ok: false, error: `"${pid}" does not live in the plugin directory — not removed` }
  }
  const un = unregisterPlugin(pid)
  if (!un.ok) return un
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: `removing ${dir} failed: ${err.message}` }
  }
  forgetPlugin(pid)
  return { ok: true, id: pid }
}

/**
 * The external packages: what is registered, plus what lies in the plugin
 * directory and did NOT register — the operator has to be able to see a broken
 * package, otherwise "I installed it and nothing happened" has no answer.
 */
export function listPackages() {
  const out = []
  const seen = new Set()
  for (const p of allPlugins()) {
    if (p.source !== 'external') continue
    const manifest = pluginManifest(p.id)
    out.push({
      id: p.id,
      kind: p.kind,
      name: manifest?.name ?? p.plugin?.label ?? p.id,
      version: manifest?.version ?? '',
      path: p.dir ?? '',
      source: 'external',
      error: null,
    })
    seen.add(p.dir ?? '')
  }
  const dir = pluginDir()
  let entries = []
  try { entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [] } catch { entries = [] }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (seen.has(full)) continue
    try { if (!statSync(full).isDirectory()) continue } catch { continue }
    if (entry.name.startsWith('.')) continue
    const m = readManifest(full)
    const failure = registryErrors().filter(e => e.where === full).at(-1)
    out.push({
      id: m.ok ? m.value.id : basename(full),
      kind: m.ok ? m.value.kind : null,
      name: m.ok ? m.value.name : basename(full),
      version: m.ok ? m.value.version : '',
      path: full,
      source: 'external',
      error: failure?.error ?? (m.ok ? 'the package was not registered' : m.problems.join('; ')),
    })
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}
