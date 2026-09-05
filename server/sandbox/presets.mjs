// Freilauf — network presets: an allowlist nobody has to type by hand
// (SANDBOX_RESEARCH.md §7.5.3).
//
// An allowlist that has to be written out is an allowlist that gets switched
// off. Four presets cover what a run of this hub actually needs, and each of
// them has a source that already exists:
//
//   `harness`             the coding agent's plugin says which hosts its CLI
//   `provider`            talks to (`sandbox.domains`, §7.9) — the plugin knows,
//                         and this file must never learn a vendor's name,
//   `git-host`            the repository's own `origin`,
//   `package-registries`  the one static list here, the union of Codex's
//                         "common dependencies", Copilot's recommended
//                         allowlist and Claude's devcontainer.
//
// **The resolved list is what the run records.** A preset is a convenience for
// the form, not something that changes meaning after the fact: a run started
// last week keeps the hosts it was launched with, whatever a plugin declares
// today. That is why expansion happens once, at resolution time, and the
// answer is frozen into `runs.sandbox_spec` with everything else.
//
// Nothing here throws. A plugin that declares no `sandbox.domains` contributes
// nothing, an origin URL this file cannot parse contributes nothing — a wrong
// host in an allowlist is worse than a missing one, because the missing one
// announces itself the first time the agent needs it and the wrong one never
// does.
import { getHarness, getProvider } from '../plugins/registry.mjs'
import { sh } from '../util.mjs'

/** The presets `network.presets` may name. */
export const PRESETS = ['harness', 'provider', 'git-host', 'package-registries']

/**
 * The package registries a build reaches for, whatever the language. Static on
 * purpose: it is a fact about the world, not about this installation, and an
 * operator who needs a fifth one adds it to `network.allow`.
 */
export const PACKAGE_REGISTRIES = [
  // JavaScript
  'registry.npmjs.org', '*.npmjs.org',
  // Python
  'pypi.org', 'files.pythonhosted.org',
  // Go
  'proxy.golang.org', 'sum.golang.org',
  // Rust
  'crates.io', 'static.crates.io',
  // JVM
  'repo1.maven.org', 'plugins.gradle.org',
  // Ruby
  'rubygems.org',
  // the distribution's own packages
  'deb.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com',
]

/**
 * The hosts a git host serves a fetch from. `github.com` alone is not enough —
 * a clone pulls its packs from `codeload` and its release assets from
 * `objects.githubusercontent.com`, and an allowlist that names only the one a
 * human types fails at the first fetch.
 */
const GIT_COMPANIONS = {
  'github.com': ['objects.githubusercontent.com', 'codeload.github.com'],
}

/**
 * Does `host` match the allowlist pattern `pattern`?
 *
 * The one matcher, so the proxy and the form judge a host identically — two
 * readings of an allowlist is how a form comes to promise access the proxy
 * then denies. Four forms, and the strictness is the point:
 *
 *   `example.com`    exactly that host, and nothing else. A bare domain does
 *                    NOT imply its subdomains: an allowlist must not be looser
 *                    than it reads, and `github.com` was written by somebody
 *                    who meant github.com.
 *   `.example.com`   the domain AND its subdomains — the explicit shorthand for
 *                    "everything under here", the form curl and cookies use.
 *   `*.example.com`  subdomains only, at any depth: `registry.npmjs.org` and
 *                    `a.b.npmjs.org` match, `npmjs.org` does not. The label
 *                    before the dot may not be empty, which is exactly what
 *                    keeps the bare domain out.
 *   `*`              everything. The only pattern that means "open".
 *
 * A `*` anywhere else never matches. A half-understood glob that quietly
 * matched more than it says is the failure this rule exists to prevent, and a
 * pattern that matches nothing announces itself at the first request.
 */
export function hostGlobMatch(pattern, host) {
  const p = String(pattern ?? '').trim().toLowerCase().replace(/\.$/, '')
  // A host may arrive with a port (CONNECT sends `host:443`) and with a
  // trailing root dot; neither is part of the name being judged.
  const h = String(host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (!p || !h) return false
  if (p === '*') return true
  if (p.startsWith('*.')) {
    const base = p.slice(2)
    return base !== '' && h.endsWith(`.${base}`) && h.length > base.length + 1
  }
  if (p.startsWith('.')) {
    const base = p.slice(1)
    return base !== '' && (h === base || h.endsWith(`.${base}`))
  }
  if (p.includes('*')) return false
  return h === p
}

/**
 * The hosts of a git remote URL. Understands the two forms a `remote get-url`
 * answers with — `git@host:owner/repo.git` and any URL scheme — and answers
 * with nothing at all for a path, a relative remote or something it cannot
 * read. Pure, so a test can hand it the odd ones.
 */
export function gitHostDomains(originUrl) {
  const url = String(originUrl ?? '').trim()
  if (!url) return []
  let host = null

  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9._-]+):(?!\/\/)(?!\d)/.exec(url)   // git@github.com:owner/repo.git
  if (scp) host = scp[1]
  else {
    try {
      const u = new URL(url)
      if (['file:', 'data:'].includes(u.protocol)) return []
      host = u.hostname || null
    } catch { return [] }
  }
  if (!host || !host.includes('.')) return []      // a bare hostname is a LAN name, not a git host
  host = host.toLowerCase()
  return [host, ...(GIT_COMPANIONS[host] ?? [])]
}

/** `git remote get-url origin`, and nothing bad ever happens. */
export async function repoOriginUrl(repoPath) {
  if (!repoPath) return null
  const r = await sh('git', ['-C', String(repoPath), 'remote', 'get-url', 'origin'], { timeout: 5_000 })
  const out = r.ok ? r.stdout.trim() : ''
  return out || null
}

/** A plugin's declared domains, read defensively — an absent block is silence. */
function pluginDomains(plugin) {
  const list = plugin?.sandbox?.domains
  return Array.isArray(list) ? list.filter(d => typeof d === 'string' && d.trim()) : []
}

/**
 * Expand `network.presets` into the hosts they stand for.
 *
 * Pure and synchronous: everything it needs is in `ctx`, including the origin
 * URL, because reading a git remote is I/O and this function is also what the
 * form previews with. `expandPresetsForRepo()` next to it is the one that goes
 * and asks git.
 *
 * ctx: `{ harness, provider, originUrl, harnessDomains, providerDomains }` —
 * the two `*Domains` fields let a caller (and a test) hand the declarations
 * over directly instead of going through the registry.
 */
export function expandPresets(names, ctx = {}) {
  const wanted = Array.isArray(names) ? names : []
  const out = []
  const add = (list) => { for (const d of list) if (d && !out.includes(d)) out.push(d) }

  for (const name of wanted) {
    switch (name) {
      case 'harness':
        add(ctx.harnessDomains ?? pluginDomains(ctx.harness ? getHarness(ctx.harness) : null))
        break
      case 'provider':
        add(ctx.providerDomains ?? pluginDomains(ctx.provider ? getProvider(ctx.provider) : null))
        break
      case 'git-host':
        add(gitHostDomains(ctx.originUrl))
        break
      case 'package-registries':
        add(PACKAGE_REGISTRIES)
        break
      default:
        break   // an unknown preset contributes nothing; the form refuses it earlier
    }
  }
  return out
}

/** `expandPresets()` with the one piece of I/O it needs: the repo's origin. */
export async function expandPresetsForRepo(names, ctx = {}) {
  const originUrl = ctx.originUrl ?? await repoOriginUrl(ctx.repo?.path ?? ctx.repoPath)
  return expandPresets(names, { ...ctx, originUrl })
}

/**
 * The whole allow list a spec resolves to: its presets, then what it names by
 * hand. This is what the run records and what the proxy is configured from.
 */
export function resolvedAllow(spec, ctx = {}) {
  const out = expandPresets(spec?.network?.presets ?? [], ctx)
  for (const d of spec?.network?.allow ?? []) if (d && !out.includes(d)) out.push(d)
  return out
}
