// Freilauf — what is already on this machine?
//
// A fresh installation has nothing configured and no way of knowing that the
// operator already has three coding agent CLIs installed and two API keys in
// the environment. The scan answers that once: for every registered coding
// agent whether its binary is on the PATH, for every model provider whether
// any of its declared credential variables is set — and whether this machine
// has a container runtime at all, because without one the sandbox is a feature
// the operator can only be told about, never switched on.
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
  const runtime = await scanSandboxRuntime()
  if (runtime) found.push(runtime)
  setSetting('discovery_last_scan', new Date().toISOString())
  return found
}

/**
 * Is there a container runtime on this machine, and what can it do?
 *
 * Recorded as an ordinary discovery row (`sandbox:runtime`) so the Plugins page
 * and the Welcome wizard can say "Sandbox: available / not available (install
 * Docker)" from the same place they say everything else. It is a FACT, not a
 * suggestion: `openDiscoveries()` only offers rows whose `plugin_id` is a
 * registered plugin, and `runtime` is not one, so this never becomes a banner
 * asking the operator to add something.
 *
 * The same rule as the credential scan above applies to every field here: what
 * is recorded is a name, a version and a yes/no — never a socket path's
 * contents, never a token, never the output of `docker info` as it stands. A
 * discovery row is rendered into a page and travels with a database copy.
 *
 * `runtimeInfo()` is imported LAZILY, and that is the plugin rule of AGENTS.md
 * rather than a style choice: `server/sandbox/runtime.mjs` reaches the settings
 * and through them the database, and this module is imported from `hub.mjs`
 * while that ring is still being built. A machine without the module — an
 * installation from before the sandbox existed — answers "not available"
 * instead of failing the whole scan.
 */
async function scanSandboxRuntime() {
  let info = null
  try {
    const { runtimeInfo } = await import('../sandbox/runtime.mjs')
    info = await runtimeInfo()
  } catch (err) {
    info = { available: false, reason: `runtime discovery unavailable: ${err?.message ?? err}` }
  }
  try {
    const detail = {
      available: info?.available === true,
      runtime: info?.id ?? null,          // 'docker' | 'podman' | …
      bin: info?.bin ?? null,
      version: info?.version ?? null,
      // Rootless changes who the agent runs as inside the container (§7.7's uid
      // table), so it is part of the answer and not a detail.
      rootless: info?.rootless ?? null,
      // gVisor: registered as a runtime means a repo may ask for `runsc`.
      runsc: Array.isArray(info?.runtimes) ? info.runtimes.includes('runsc') : null,
      // Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor,
      // which is what kills every bubblewrap-based inner sandbox on this host
      // (SANDBOX_RESEARCH.md §2.4). The hub does not need them — its boundary
      // is the container — but the value explains why an `innerSandbox` above
      // `off` is refused, so it is worth writing down once. Taken from
      // `runtimeInfo()` rather than read here a second time: two readers of one
      // sysctl is how the two eventually disagree.
      userns: info?.userns ?? null,
      reason: info?.reason ?? null,
    }
    upsert({ kind: 'sandbox', pluginId: 'runtime', detail })
    return { kind: 'sandbox', pluginId: 'runtime', ...detail }
  } catch { return null }
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
