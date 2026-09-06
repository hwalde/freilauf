// Freilauf — plugin manifest and descriptor validation.
//
// Pure functions: no I/O, no database, no registry. That is deliberate — this
// is the one part of the plugin machinery that can be unit-tested without a
// sandbox, and it is what decides whether a stranger's package is allowed
// anywhere near the hub.
//
// Every problem string here is ENGLISH and developer-facing: it names a defect
// in a plugin package, it is shown raw on the Plugins page next to the package
// that produced it, and it is not a UI string in the i18n sense.

/** The manifest API version this hub speaks. A package must declare exactly this. */
export const PLUGIN_API = 1

/** Plugin ids: lowercase, digits and dashes, 2..40 characters, never leading dash. */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

/** The kinds of plugin the hub knows. */
export const PLUGIN_KINDS = ['harness', 'provider', 'notifier']

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const isStr = (v) => typeof v === 'string' && !!v.trim()

/**
 * A path a plugin hands the hub to write inside the per-run home, or to mount
 * out of it: relative, and never leaving the home. An absolute path or a `..`
 * segment would let a `seedHome` write into the operator's own `~/.claude` —
 * which is the one thing SANDBOX_RESEARCH.md §7.7 says must never happen.
 */
function badHomePath(p) {
  if (!isStr(p)) return 'must be a non-empty string'
  if (p.startsWith('/') || p.startsWith('~')) return 'must be relative to the sandbox home'
  if (p.split('/').includes('..')) return 'must not contain ".."'
  return null
}

/**
 * A host in a network allowlist: a bare hostname or a `*.` glob of one. No
 * scheme, no path, no port — the proxy matches on the CONNECT host, and a
 * plausible-looking wrong entry is a run that dies at its first API call, so
 * the shape is checked where the declaration is read rather than there.
 */
function badDomain(d) {
  if (!isStr(d)) return 'must be a non-empty string'
  if (/[\s/@]/.test(d) || d.includes('://')) return 'must be a bare host, not a URL'
  if (!/^\*?[a-z0-9.*-]+$/i.test(d)) return 'is not a host name or a glob of one'
  return null
}

/**
 * The inner (agent-native) sandbox levels a plugin may declare a mapping for.
 * `off` is what a sandboxed run gets by default — two boundaries are not
 * stronger than one, they are two things that break (SANDBOX_RESEARCH.md §4.3).
 * A level the plugin does not declare is a level that coding agent cannot do.
 */
export const INNER_SANDBOX_LEVELS = ['off', 'weak', 'full']

/**
 * The optional `sandbox` block, on a coding agent and on a model provider
 * (SANDBOX_RESEARCH.md §7.9, docs/plugins.md "The sandbox declaration").
 *
 * It is validated rather than merely read, and a malformed one is REFUSED
 * rather than dropped: a declaration that is silently ignored produces a run
 * that starts, reaches the network it should not have reached (or fails to
 * reach the one it needs) and says nothing — the worst shape a fault can take
 * in this module. Absent is fine and means "not offered the sandbox", exactly
 * as an absent `launch` means "cannot start a run".
 */
function validateSandbox(sb, kind, problems) {
  const p = (msg) => problems.push(`${kind === 'harness' ? 'coding agent' : 'model provider'} sandbox: ${msg}`)
  if (!isPlainObject(sb)) { p('must be an object'); return }

  // Not a field here, and saying so is cheaper than a second statement about
  // one fact: whether a run can be picked back up is `launch.resume`'s answer,
  // the one `resumeRun()` reads — in a sandbox exactly as outside one.
  if ('resume' in sb) p('"resume" is not a sandbox field — a coding agent\'s resume form is declared in "launch.resume"')

  if (sb.supported !== undefined && typeof sb.supported !== 'boolean') p('"supported" must be a boolean')

  if (sb.domains !== undefined) {
    if (!Array.isArray(sb.domains)) p('"domains" must be an array')
    else for (const d of sb.domains) { const bad = badDomain(d); if (bad) p(`domain ${JSON.stringify(d)} ${bad}`) }
  }

  if (sb.env !== undefined) {
    if (!isPlainObject(sb.env)) p('"env" must be an object')
    else for (const [k, v] of Object.entries(sb.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) p(`env name ${JSON.stringify(k)} is not an environment variable name`)
      if (typeof v !== 'string') p(`env ${JSON.stringify(k)} must be a string`)
    }
  }

  if (sb.image !== undefined) {
    if (!isPlainObject(sb.image)) p('"image" must be an object')
    else {
      const { ref, dockerfile, args } = sb.image
      if (ref === undefined && dockerfile === undefined) p('"image" needs "ref" or "dockerfile"')
      if (ref !== undefined && !isStr(ref)) p('"image.ref" must be a non-empty string')
      if (dockerfile !== undefined) {
        const bad = badHomePath(dockerfile)
        if (bad) p(`"image.dockerfile" ${bad === 'must be relative to the sandbox home' ? 'must be a path inside this repository' : bad}`)
      }
      if (args !== undefined) {
        if (!isPlainObject(args)) p('"image.args" must be an object')
        else for (const [k, v] of Object.entries(args)) if (typeof v !== 'string') p(`"image.args.${k}" must be a string`)
      }
    }
  }

  if (sb.credentials !== undefined) {
    if (!Array.isArray(sb.credentials)) p('"credentials" must be an array')
    else for (const c of sb.credentials) {
      if (!isPlainObject(c)) { p('every credential must be an object'); continue }
      if (!isStr(c.key)) p('a credential is missing "key"')
      if (c.envKeys !== undefined && (!Array.isArray(c.envKeys) || c.envKeys.some(n => !isStr(n)))) {
        p(`credential ${JSON.stringify(c.key)}: "envKeys" must be an array of variable names`)
      }
      if (c.injection !== undefined) {
        const inj = c.injection
        if (!isPlainObject(inj)) p(`credential ${JSON.stringify(c.key)}: "injection" must be an object`)
        else {
          if (!isStr(inj.header)) p(`credential ${JSON.stringify(c.key)}: "injection.header" must be a header name`)
          if (inj.prefix !== undefined && typeof inj.prefix !== 'string') p(`credential ${JSON.stringify(c.key)}: "injection.prefix" must be a string`)
          // An injection without hosts would hand the real value to whatever the
          // agent connects to — the opposite of what the mode is for.
          if (!Array.isArray(inj.hosts) || inj.hosts.length === 0) p(`credential ${JSON.stringify(c.key)}: "injection.hosts" must be a non-empty array`)
          else for (const h of inj.hosts) { const bad = badDomain(h); if (bad) p(`credential ${JSON.stringify(c.key)}: host ${JSON.stringify(h)} ${bad}`) }
        }
      }
    }
  }

  if (sb.stateDirs !== undefined) {
    if (!Array.isArray(sb.stateDirs)) p('"stateDirs" must be an array')
    else for (const dir of sb.stateDirs) { const bad = badHomePath(dir); if (bad) p(`stateDir ${JSON.stringify(dir)} ${bad}`) }
  }

  if (sb.seedHome !== undefined && typeof sb.seedHome !== 'function') p('"seedHome" must be a function')
  if (sb.launchOverrides !== undefined && typeof sb.launchOverrides !== 'function' && !isPlainObject(sb.launchOverrides)) {
    p('"launchOverrides" must be a function or an object')
  }

  if (sb.innerSandbox !== undefined) {
    if (!isPlainObject(sb.innerSandbox)) p('"innerSandbox" must be an object')
    else for (const [level, value] of Object.entries(sb.innerSandbox)) {
      if (!INNER_SANDBOX_LEVELS.includes(level)) p(`innerSandbox level ${JSON.stringify(level)} — must be one of ${INNER_SANDBOX_LEVELS.join(' | ')}`)
      if (!isPlainObject(value)) p(`innerSandbox "${level}" must be an object`)
    }
  }
}

/**
 * Validate a parsed `plugin.json`.
 *
 * Returns `{ ok, value, problems }`. `value` is a normalized copy — only the
 * fields the hub actually reads, with `main` defaulted to `index.mjs`, so a
 * manifest cannot smuggle extra keys into the registry's metadata.
 */
export function validateManifest(obj) {
  const problems = []
  if (!isPlainObject(obj)) {
    return { ok: false, value: null, problems: ['plugin.json must contain a JSON object'] }
  }

  if (obj.api !== PLUGIN_API) {
    problems.push(`unsupported manifest api ${JSON.stringify(obj.api)} — this hub speaks api ${PLUGIN_API}`)
  }

  const id = typeof obj.id === 'string' ? obj.id : ''
  if (!id) problems.push('missing "id"')
  else if (!PLUGIN_ID_RE.test(id)) {
    problems.push(`invalid "id" ${JSON.stringify(id)} — lowercase letters, digits and dashes, 2 to 40 characters`)
  }

  const kind = typeof obj.kind === 'string' ? obj.kind : ''
  if (!PLUGIN_KINDS.includes(kind)) {
    problems.push(`invalid "kind" ${JSON.stringify(obj.kind)} — must be one of ${PLUGIN_KINDS.join(' | ')}`)
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!name) problems.push('missing "name"')

  const version = typeof obj.version === 'string' ? obj.version.trim() : ''
  if (!version) problems.push('missing "version"')

  // `main` is relative to the package directory. A path escaping it would let a
  // manifest import anything on the machine, so the loader is handed a plain
  // relative file name and nothing else.
  let main = 'index.mjs'
  if (obj.main !== undefined) {
    if (typeof obj.main !== 'string' || !obj.main.trim()) problems.push('"main" must be a non-empty string')
    else main = obj.main.trim()
  }
  if (main.startsWith('/') || main.includes('..')) {
    problems.push(`invalid "main" ${JSON.stringify(main)} — must be a path inside the package`)
  }

  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const value = {
    api: PLUGIN_API,
    id,
    kind,
    name,
    version,
    main,
    description: str(obj.description),
    homepage: str(obj.homepage),
    author: str(obj.author),
  }
  return { ok: problems.length === 0, value: problems.length ? null : value, problems }
}

/**
 * The minimum contract a registered plugin descriptor must satisfy.
 *
 * This is the same list the unit suite asserts over the built-in plugins — it
 * lives here so an EXTERNAL plugin is held to it before it is registered,
 * rather than crashing a page months later. Everything beyond the minimum
 * (`goal`, `hookFiles`, `balance`, `gate`, `llm`, …) is optional by design:
 * the hub asks for it and does without when it is not there.
 */
export function validateDescriptor(desc, kind) {
  const problems = []
  if (!isPlainObject(desc)) {
    return { ok: false, problems: ['the plugin module must export a descriptor object as its default export'] }
  }
  if (!PLUGIN_KINDS.includes(kind)) {
    return { ok: false, problems: [`unknown plugin kind ${JSON.stringify(kind)}`] }
  }

  if (typeof desc.id !== 'string' || !desc.id) problems.push('descriptor: missing "id"')
  if (typeof desc.label !== 'string' || !desc.label) problems.push('descriptor: missing "label"')

  if (kind === 'harness') {
    if (typeof desc.bin !== 'string' || !desc.bin) problems.push('coding agent: missing "bin"')
    if (typeof desc.subscription !== 'boolean') problems.push('coding agent: "subscription" must be a boolean')
    if (!Array.isArray(desc.providers)) problems.push('coding agent: "providers" must be an array')
    if (!Array.isArray(desc.logPatterns) || desc.logPatterns.length === 0) {
      problems.push('coding agent: "logPatterns" must be a non-empty array')
    }
    for (const fn of ['modelArgs', 'effortOptions', 'usage', 'pulseId']) {
      if (typeof desc[fn] !== 'function') problems.push(`coding agent: "${fn}" must be a function`)
    }
  } else if (kind === 'notifier') {
    // One function and nothing else. Everything a notifier needs to be
    // configurable — `settings`, `credentials`, `setup`, `test` — is optional,
    // because the smallest useful notifier is a webhook with a URL in a setting
    // and a `send` that posts to it.
    if (typeof desc.send !== 'function') problems.push('notifier: "send" must be a function')
  } else {
    const hasEnvKeys = Array.isArray(desc.envKeys)
    const hasCredentials = Array.isArray(desc.credentials)
    if (!hasEnvKeys && !hasCredentials) {
      problems.push('model provider: needs "envKeys" (array) or "credentials" (array)')
    }
    if (typeof desc.fetchModels !== 'function') problems.push('model provider: "fetchModels" must be a function')
  }

  // Optional on both kinds, and the one optional block that is checked rather
  // than left to the reader: see validateSandbox() above for why.
  if (desc.sandbox !== undefined && kind !== 'notifier') validateSandbox(desc.sandbox, kind, problems)

  return { ok: problems.length === 0, problems }
}
