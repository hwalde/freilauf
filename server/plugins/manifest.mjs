// cc-hub — plugin manifest and descriptor validation.
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

  return { ok: problems.length === 0, problems }
}
