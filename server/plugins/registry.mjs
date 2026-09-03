// Freilauf — the one plugin registry.
//
// Coding agents ("harnesses") and model providers used to live in two static
// index files that imported their built-ins and exported a frozen object. That
// is what an EXTERNAL plugin cannot join: by the time a package on disk has
// been read, every importer already holds the object.
//
// So the registry is mutable and lives here. `HARNESS_PLUGINS` and
// `PROVIDER_PLUGINS` keep their exact identity — `server/harnesses/index.mjs`
// and `server/providers/index.mjs` re-export these very objects, so all their
// importers (16 static ones plus a dynamic one) are untouched and a plugin
// registered later is simply in the object they already hold.
//
// Built-in plugins still must not import `db.mjs` or `i18n.mjs`: they receive
// everything through an injected context. External plugins may (the CHECK on
// `agents.harness` that made it a cycle is gone, see db.mjs), but the same
// discipline is what keeps a plugin testable.
import { execFile } from 'node:child_process'
import claude from '../harnesses/claude.mjs'
import opencode from '../harnesses/opencode.mjs'
import hermes from '../harnesses/hermes.mjs'
import cursor from '../harnesses/cursor.mjs'
import openrouter from '../providers/openrouter.mjs'
import deepseek from '../providers/deepseek.mjs'
import opencodeZen from '../providers/opencode-zen.mjs'
import telegram from '../notifiers/telegram.mjs'
import { validateDescriptor, PLUGIN_ID_RE, PLUGIN_KINDS } from './manifest.mjs'

/** Coding agent plugins, keyed by id. Mutable — external packages join here. */
export const HARNESS_PLUGINS = { claude, opencode, hermes, cursor }

/** Model provider plugins, keyed by id. Mutable — external packages join here. */
export const PROVIDER_PLUGINS = {
  openrouter,
  deepseek,
  'opencode-zen': opencodeZen,
}

/**
 * Notification channel plugins, keyed by id. Mutable, like the other two.
 *
 * Telegram is the only built-in one and is deliberately not special: the hub
 * asks the facade (`server/notify.mjs`), the facade asks whoever is registered
 * and configured, and an installation with nothing configured simply says
 * nothing at all.
 */
export const NOTIFIER_PLUGINS = { telegram }

// id -> { kind, source: 'builtin' | 'external', manifest, dir }
const META = new Map()
for (const id of Object.keys(HARNESS_PLUGINS)) META.set(id, { kind: 'harness', source: 'builtin', manifest: null, dir: null })
for (const id of Object.keys(PROVIDER_PLUGINS)) META.set(id, { kind: 'provider', source: 'builtin', manifest: null, dir: null })
for (const id of Object.keys(NOTIFIER_PLUGINS)) META.set(id, { kind: 'notifier', source: 'builtin', manifest: null, dir: null })

// Load failures, id collisions and broken descriptors. Nothing here stops the
// hub: one bad package must never cost the operator the other ones, so every
// failure is collected and shown on the Plugins page instead of thrown.
const ERRORS = []

const BUCKETS = { harness: HARNESS_PLUGINS, provider: PROVIDER_PLUGINS, notifier: NOTIFIER_PLUGINS }

function bucket(kind) { return BUCKETS[kind] ?? PROVIDER_PLUGINS }

/**
 * Record a load failure. `where` is what the operator can act on — a package
 * directory, a manifest path — and `error` is one English sentence.
 */
export function addRegistryError(where, error) {
  ERRORS.push({ where: String(where ?? ''), error: String(error ?? ''), at: new Date().toISOString() })
}

/** Everything that went wrong while loading plugins, newest last. */
export function registryErrors() { return ERRORS.slice() }

/**
 * Register a plugin descriptor.
 *
 * An id that is already taken is REFUSED and reported — never silently
 * overridden. A package shadowing `claude` would otherwise be able to replace
 * the coding agent the operator's runs are started with, without saying so.
 */
export function registerPlugin(desc, { source = 'external', manifest = null, dir = null } = {}) {
  const kind = desc?.kind ?? manifest?.kind ?? null
  if (!PLUGIN_KINDS.includes(kind)) {
    const error = `unknown plugin kind ${JSON.stringify(kind)}`
    addRegistryError(dir ?? desc?.id ?? '?', error)
    return { ok: false, error }
  }
  const id = String(desc?.id ?? manifest?.id ?? '')
  if (!PLUGIN_ID_RE.test(id)) {
    const error = `invalid plugin id ${JSON.stringify(id)}`
    addRegistryError(dir ?? id, error)
    return { ok: false, error }
  }
  if (manifest && manifest.id !== id) {
    const error = `manifest id ${JSON.stringify(manifest.id)} does not match the descriptor id ${JSON.stringify(id)}`
    addRegistryError(dir ?? id, error)
    return { ok: false, error }
  }
  if (META.has(id)) {
    const held = META.get(id)
    const error = `plugin id ${JSON.stringify(id)} is already taken by the ${held.source} ${held.kind} plugin — refused`
    addRegistryError(dir ?? id, error)
    return { ok: false, error }
  }
  const check = validateDescriptor(desc, kind)
  if (!check.ok) {
    const error = check.problems.join('; ')
    addRegistryError(dir ?? id, error)
    return { ok: false, error }
  }

  bucket(kind)[id] = desc
  META.set(id, { kind, source, manifest, dir })
  return { ok: true, id, kind }
}

/**
 * Remove a plugin from the registry again — uninstalling an external package.
 * A built-in is never removed: it is part of the running code, and a registry
 * that disagreed with the imports would be a lie.
 */
export function unregisterPlugin(id) {
  const meta = META.get(id)
  if (!meta) return { ok: false, error: `unknown plugin ${JSON.stringify(id)}` }
  if (meta.source === 'builtin') return { ok: false, error: `${id} is a built-in plugin and cannot be removed` }
  delete bucket(meta.kind)[id]
  META.delete(id)
  return { ok: true }
}

/** Every registered plugin, both kinds, with its metadata. */
export function allPlugins() {
  return [...META.entries()].map(([id, meta]) => ({
    id,
    kind: meta.kind,
    source: meta.source,
    manifest: meta.manifest,
    dir: meta.dir,
    plugin: bucket(meta.kind)[id] ?? null,
  })).filter(p => p.plugin)
}

/** One registered plugin descriptor, whichever kind it is. */
export function getPlugin(id) {
  const meta = META.get(id)
  return meta ? (bucket(meta.kind)[id] ?? null) : null
}

export function pluginKind(id) { return META.get(id)?.kind ?? null }
export function pluginSource(id) { return META.get(id)?.source ?? null }
export function pluginManifest(id) { return META.get(id)?.manifest ?? null }
export function pluginDirOf(id) { return META.get(id)?.dir ?? null }

// ---------------- the harness half of the old index.mjs ----------------

export function harnessIds() { return Object.keys(HARNESS_PLUGINS) }
export function getHarness(id) { return HARNESS_PLUGINS[id] ?? null }
export function harnessLabel(id) { return HARNESS_PLUGINS[id]?.label ?? id }

/**
 * The goal spec of a coding agent, or null when it knows no second prompt.
 * `{ max, command(condition) }` — see docs/plugins.md and server/goal.mjs.
 */
export function goalSpec(id) { return HARNESS_PLUGINS[id]?.goal ?? null }

/** The coding agents that accept a goal — what the form shows the field for. */
export function harnessesWithGoal() { return harnessIds().filter(id => HARNESS_PLUGINS[id].goal) }

/**
 * Where a coding agent looks for agent skills, or null when it declares
 * nothing. `{ user: [path], project: [path] }` — `~` allowed in the user
 * paths, project paths relative to a workspace root. See server/skills.mjs.
 */
export function skillSpec(id) { return HARNESS_PLUGINS[id]?.skills ?? null }

/** The coding agents the hub can install its own skills for. */
export function harnessesWithSkills() {
  return harnessIds().filter(id => (HARNESS_PLUGINS[id].skills?.user ?? []).length)
}

/**
 * Which of the registered plugins are actually installed on this machine?
 * Used by the "add coding agent" dialog to suggest what can be added.
 * `command -v` is the portable way to ask the shell; a missing binary is a
 * normal answer here, not an error.
 */
export async function detectInstalled() {
  const out = []
  for (const plugin of Object.values(HARNESS_PLUGINS)) {
    out.push({
      id: plugin.id,
      label: plugin.label,
      bin: plugin.bin,
      installed: await binaryPresent(plugin.bin),
      installHint: plugin.installHint,
    })
  }
  return out
}

/** `command -v <bin>` — true when the shell can find it. Never throws. */
export function binaryPresent(bin) {
  if (!bin) return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      execFile('sh', ['-c', `command -v ${bin}`], { timeout: 5000 },
        (err, stdout) => resolve(!err && !!String(stdout).trim()))
    } catch { resolve(false) }
  })
}

// ---------------- the provider half of the old index.mjs ----------------

export function providerIds() { return Object.keys(PROVIDER_PLUGINS) }
export function getProvider(id) { return PROVIDER_PLUGINS[id] ?? null }
export function providerLabel(id) { return PROVIDER_PLUGINS[id]?.label ?? id }

/**
 * Does the environment hold a credential for this provider?
 *
 * Deliberately still the plain environment answer: it is asked on the launch
 * path and from `quota.mjs`, both of which must not reach the database. The
 * richer question — "is there a credential at all, stored one included?" —
 * is `pluginHasCredential()` in store.mjs.
 */
export function providerHasKey(id, env = process.env) {
  return (getProvider(id)?.envKeys ?? []).some(name => !!env[name])
}

// ---------------- the notifier half ----------------

export function notifierIds() { return Object.keys(NOTIFIER_PLUGINS) }
export function getNotifier(id) { return NOTIFIER_PLUGINS[id] ?? null }
export function notifierLabel(id) { return NOTIFIER_PLUGINS[id]?.label ?? id }

/** The notifiers that bring a server-rendered setup wizard of their own. */
export function notifiersWithSetup() {
  return notifierIds().filter(id => typeof NOTIFIER_PLUGINS[id]?.setup?.render === 'function')
}
