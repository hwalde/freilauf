// Freilauf — the iron-proxy engine (SANDBOX_RESEARCH.md §4.5, §7.5.2, §7.8).
//
// The built-in proxy in proxy.mjs tunnels HTTPS and can therefore judge a HOST
// and nothing finer. iron-proxy terminates TLS with leaf certificates minted
// from a local CA, which is what buys the other two capabilities the spec knows
// about: per-method rules, and the `secrets` transform — the container holds a
// placeholder (`fl-token-<random>`) and the proxy swaps in the real credential
// only on requests to that credential's declared hosts, so no key ever enters
// the agent's environment.
//
// WHAT IS VERIFIED AND WHAT IS NOT — read this before trusting a line of it.
//
// iron-proxy is NOT installed on this machine and there is no container runtime
// here either, so nothing below has been executed against the real binary. The
// config shape, the transform names (`allowlist`, `secrets`), the `warn: true`
// audit-only flag, the management listener with `api_key_env`, the
// `POST /v1/reload` hot reload and the per-request JSON log fields are
// [documented] — they come from §4.5, which was written from the project's
// documentation and hermes' integration notes. Everything that follows from
// them here is UNVERIFIED:
//
//   - the exact YAML key names below (`proxy.tunnel_listen`, `transforms[].name`,
//     `transforms[].config.domains`, `secrets[].source.type`, `proxy_value`,
//     `match_headers`, `rules[].host`, `log.level`, `management.listen`) are
//     transcribed from §4.5's one-page example and have never been parsed by the
//     binary;
//   - the deny half. §4.5 documents a default-deny `domains` allowlist and
//     upstream deny CIDRs, but not a per-config DENY list. `denyDomains` is
//     written as `deny_domains` next to `domains` on the hope that it exists; if
//     it does not, the deny entries have to become an allowlist the hub narrows
//     itself before writing the file. `configWarnings()` says so out loud rather
//     than letting a deny entry vanish into a file nobody reads;
//   - the reload endpoint's request shape (an empty POST is assumed) and its
//     answer;
//   - the log line's own field names, which `tailLog()` maps onto the built-in
//     engine's audit shape. Where a field is missing the mapped line carries
//     null rather than a guess.
//
// The rule the whole module keeps: where the binary is absent, `startIronProxy`
// fails with a READABLE reason and the caller falls back to the built-in engine.
// It never throws something the operator would have to read a stack trace to
// understand, and it never half-starts.
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { t } from '../i18n.mjs'
import { normalizeSpec } from './spec.mjs'
import { proxyPolicy, auditLine } from './proxy.mjs'

/** The listener the agent container's HTTPS_PROXY points at, inside the proxy container. */
export const TUNNEL_PORT = 8080
/** The management listener that answers POST /v1/reload. */
export const MANAGEMENT_PORT = 8081
/** The environment variable iron-proxy reads its management key from (§4.5). */
export const MANAGEMENT_KEY_ENV = 'IRON_MANAGEMENT_API_KEY'

// ------------------------------------------------------------------ the config

/**
 * A per-run placeholder for one credential. It is worthless outside the proxy —
 * which is the entire argument for the pattern (§7.8): an agent that pastes it
 * into a commit has leaked nothing.
 */
export function proxyPlaceholder(key) {
  return `fl-token-${String(key ?? 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomBytes(9).toString('hex')}`
}

function yamlString(s) {
  // Always quoted, always escaped: a domain glob starts with `*`, which bare
  // YAML reads as an alias, and a placeholder may hold anything.
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function yamlList(items) {
  return `[${items.map(yamlString).join(', ')}]`
}

/**
 * The `proxy.yaml` of §4.5 for one run — pure, so it is unit-tested without a
 * binary anywhere. `ctx.secrets` is a list of
 * `{ key, envVar, placeholder, header, hosts }`, one per credential the run's
 * plugins declared for injection (§7.8); an empty list writes no `secrets`
 * transform at all rather than an empty one.
 */
export function ironProxyConfig(spec, ctx = {}) {
  const policy = proxyPolicy(spec, { secretsMode: ctx.secretsMode })
  const net_ = normalizeSpecSafe(spec).network ?? {}
  const allow = [...(policy.allow ?? [])]
  const deny = [...(policy.deny ?? [])]
  const auditOnly = policy.auditOnly === true
  // Methods are read from the spec rather than from the policy: `proxyPolicy()`
  // drops them on an engine that cannot see a method, and this engine can — a
  // config generated for iron-proxy must carry what iron-proxy can enforce even
  // when the profile was last resolved against the built-in.
  const methods = Array.isArray(net_.methods) && net_.methods.length
    ? net_.methods.map((m) => String(m).toUpperCase())
    : null

  const lines = []
  lines.push('# Generated by Freilauf — do not edit; the hub rewrites it on every policy change.')
  lines.push('proxy:')
  lines.push(`  tunnel_listen: ${yamlString(`:${ctx.tunnelPort ?? TUNNEL_PORT}`)}`)
  lines.push('transforms:')
  lines.push('  - name: "allowlist"')
  lines.push('    config:')
  lines.push(`      domains: ${yamlList(allow)}`)
  if (deny.length) lines.push(`      deny_domains: ${yamlList(deny)}`)
  if (methods) lines.push(`      methods: ${yamlList(methods)}`)
  // `warn: true` is iron-proxy's own audit-only mode: everything passes, every
  // would-be denial is logged. It is the rollout mode of §7.12.5 and the reason
  // the allowlist can be grown from a repo's own traffic instead of guessed.
  if (auditOnly) lines.push('      warn: true')

  const secrets = Array.isArray(ctx.secrets) ? ctx.secrets.filter((s) => s && s.envVar && s.placeholder) : []
  if (secrets.length) {
    lines.push('  - name: "secrets"')
    lines.push('    config:')
    lines.push('      secrets:')
    for (const s of secrets) {
      lines.push(`        - source: { type: env, var: ${yamlString(s.envVar)} }`)
      lines.push(`          proxy_value: ${yamlString(s.placeholder)}`)
      lines.push(`          match_headers: ${yamlList([s.header || 'Authorization'])}`)
      lines.push('          require: true')
      const hosts = Array.isArray(s.hosts) ? s.hosts : []
      lines.push(`          rules: [${hosts.map((h) => `{ host: ${yamlString(h)} }`).join(', ')}]`)
    }
  }

  lines.push('log: { level: info, format: json }')
  lines.push('management:')
  lines.push(`  listen: ${yamlString(`0.0.0.0:${ctx.managementPort ?? MANAGEMENT_PORT}`)}`)
  lines.push(`  api_key_env: ${MANAGEMENT_KEY_ENV}`)
  return lines.join('\n') + '\n'
}

/**
 * What this config could not express. Never a throw: a warning the operator can
 * read beats a start that fails on a field they did not know about.
 */
export function configWarnings(spec, ctx = {}) {
  const policy = proxyPolicy(spec, { secretsMode: ctx.secretsMode })
  const out = []
  if ((policy.deny ?? []).length) out.push('deny_domains is UNVERIFIED against the binary')
  if (policy.broken) out.push(`policy could not be built: ${policy.broken}`)
  return out
}

function normalizeSpecSafe(spec) {
  try { return normalizeSpec(spec ?? {}) } catch { return { network: {} } }
}

// ------------------------------------------------------------------- lifecycle

/**
 * Start `fl-proxy-<run id>` as a container. The argv is NOT built here: the
 * container runtime is runtime.mjs's subject, and this module asks it for the
 * command line the same way runner.mjs asks for a launch spec. The import is
 * lazy so a hub with no runtime can still import this file (AGENTS.md's rule for
 * plugin files, and the same reason).
 *
 * Fails with `{ ok: false, reason }` rather than throwing, so `prepareSandbox()`
 * can fall back to the built-in engine and say why in one line.
 */
export async function startIronProxy(run, spec, ctx = {}) {
  const runId = ctx.runId ?? run?.id ?? null
  let runtime
  try {
    runtime = await import('./runtime.mjs')
  } catch (err) {
    return failed(runId, t('sandbox.proxy.engine_missing', { reason: err?.message || String(err) }))
  }

  const info = await runtime.runtimeInfo(normalizeSpecSafe(spec).runtime)
  if (!info?.available) {
    return failed(runId, t('sandbox.proxy.engine_missing', { reason: info?.reason ?? 'no container runtime' }))
  }

  // The config first: a proxy started against a file that does not exist yet is
  // a proxy with somebody else's policy.
  let configPath = null
  if (ctx.runDir) {
    try {
      mkdirSync(ctx.runDir, { recursive: true })
      configPath = join(ctx.runDir, 'proxy.yaml')
      writeFileSync(configPath, ironProxyConfig(spec, ctx), { mode: 0o600 })
    } catch (err) {
      return failed(runId, t('sandbox.proxy.engine_missing', { reason: err?.message || String(err) }))
    }
  }

  const managementKey = ctx.managementKey ?? randomBytes(24).toString('hex')
  const argv = runtime.buildProxyArgv(spec, {
    ...ctx,
    runId,
    configPath,
    tunnelPort: ctx.tunnelPort ?? TUNNEL_PORT,
    managementPort: ctx.managementPort ?? MANAGEMENT_PORT,
    env: { ...(ctx.env ?? {}), [MANAGEMENT_KEY_ENV]: managementKey },
  })
  if (!argv) return failed(runId, t('sandbox.proxy.engine_missing', { reason: 'no proxy command line' }))

  const handle = {
    engine: 'iron-proxy',
    runId, run, spec,
    secretsMode: ctx.secretsMode ?? null,
    policy: proxyPolicy(spec, { secretsMode: ctx.secretsMode }),
    onBlocked: typeof ctx.onBlocked === 'function' ? ctx.onBlocked : null,
    blocked: new Map(),
    wouldBlock: new Map(),
    requests: 0,
    configPath,
    managementKey,
    managementUrl: ctx.managementUrl ?? null,
    container: ctx.containerName ?? (runId ? `fl-proxy-${runId}` : null),
    runtimeId: info.id,
    audit: ctx.runDir ? openAudit(ctx.runDir) : null,
    warnings: configWarnings(spec, ctx),
    tail: null,
  }

  // The command line comes from runtime.mjs — the container runtime's argv is
  // that module's subject, and a second place that knows how to say
  // `docker run` is a second place that would drift. Spawning it is this
  // module's, because the proxy's stdout IS its audit stream (tailLog below).
  try {
    const { spawn } = await import('node:child_process')
    const child = spawn(argv.bin, argv.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', () => {})
    child.stderr?.resume()
    handle.child = child
    tailLog(handle, child.stdout)
  } catch (err) {
    return failed(runId, t('sandbox.proxy.engine_missing', { reason: err?.message || String(err) }))
  }
  return handle
}

function failed(runId, reason) {
  return { engine: 'iron-proxy', runId, ok: false, reason, policy: null, blocked: new Map(), wouldBlock: new Map() }
}

function openAudit(runDir) {
  try {
    mkdirSync(runDir, { recursive: true })
    const s = createWriteStream(join(runDir, 'egress.jsonl'), { flags: 'a' })
    s.on('error', () => {})
    return s
  } catch { return null }
}

/**
 * The live policy change of §7.12.3: rewrite the file, then `POST /v1/reload` on
 * the management listener. iron-proxy is documented to swap the pipeline
 * atomically and to KEEP THE OLD ONE when the new config does not parse — which
 * is why the file is written before the call and not rolled back after a
 * refusal: the running policy is still the old one either way, and a rollback
 * would only make the file disagree with what is in force.
 */
export async function reloadIronProxy(handle, spec) {
  if (!handle || handle.ok === false) return { ok: false, reason: handle?.reason ?? 'no handle' }
  const next = proxyPolicy(spec, { secretsMode: handle.secretsMode })
  if (handle.configPath) {
    try {
      writeFileSync(handle.configPath, ironProxyConfig(spec, { secretsMode: handle.secretsMode }), { mode: 0o600 })
    } catch (err) {
      return { ok: false, reason: err?.message || String(err) }
    }
  }
  if (!handle.managementUrl) {
    // No management listener reachable: the file is right and the running
    // pipeline is not. Say so — a silent "ok" here would make the UI claim a
    // policy change that never reached the proxy.
    return { ok: false, reason: 'management listener unknown', policy: handle.policy }
  }
  try {
    const res = await fetch(`${handle.managementUrl.replace(/\/$/, '')}/v1/reload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.managementKey}` },
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, policy: handle.policy }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err), policy: handle.policy }
  }
  handle.policy = next
  handle.spec = spec
  return { ok: true, policy: next }
}

export async function stopIronProxy(handle) {
  if (!handle) return { ok: true }
  try { handle.tail?.destroy?.() } catch {}
  try { handle.child?.kill?.('SIGTERM') } catch {}
  if (handle.container) {
    try {
      const runtime = await import('./runtime.mjs')
      await runtime.stopContainer(handle.container, { runtime: handle.runtimeId, timeoutSec: 10 })
      await runtime.removeContainer(handle.container, { runtime: handle.runtimeId, force: true })
    } catch {
      // Teardown is fail-soft everywhere in this hub: a proxy container that
      // cannot be stopped is the reconciliation pass's problem, not a throw on
      // the path that is ending a run.
    }
  }
  try { handle.audit?.end() } catch {}
  handle.audit = null
  return { ok: true }
}

// ------------------------------------------------------------------- the audit

/**
 * Map one of iron-proxy's JSON log lines onto the built-in engine's audit shape,
 * so `egress.jsonl` is ONE format whichever engine wrote it and nothing
 * downstream has to ask. Field names are [documented] in §4.5 (`host, method,
 * path, action, status_code, duration_ms, rejected_by`) and UNVERIFIED here;
 * anything missing becomes null rather than a guess.
 */
export function mapIronLine(line, { runId = null } = {}) {
  let j
  try { j = JSON.parse(line) } catch { return null }
  if (!j || typeof j !== 'object' || !j.host) return null
  const action = j.action === 'warn' || j.warn === true
    ? 'would_deny'
    : (j.action === 'reject' || j.action === 'deny' || j.rejected_by ? 'deny' : 'allow')
  return auditLine({
    at: j.timestamp ?? j.time ?? Date.now(),
    run: runId,
    engine: 'iron-proxy',
    host: j.host,
    port: j.port ?? null,
    method: j.method ?? null,
    path: j.path ?? null,
    action,
    status: j.status_code ?? j.status ?? null,
    durationMs: j.duration_ms ?? 0,
    bytesIn: j.bytes_in ?? 0,
    bytesOut: j.bytes_out ?? 0,
    rejectedBy: j.rejected_by ?? null,
  })
}

/**
 * Tail the proxy container's JSON log into the run's `egress.jsonl` and turn its
 * rejections into the same `onBlocked` callback the built-in engine fires, so
 * §7.12's four channels do not care which engine is running. `readable` is any
 * line source (the container's stdout); nothing here reads a header value.
 */
export function tailLog(handle, readable) {
  if (!handle || !readable) return
  let rest = ''
  readable.setEncoding?.('utf8')
  readable.on('data', (chunk) => {
    rest += chunk
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const raw of lines) {
      if (!raw.trim()) continue
      const mapped = mapIronLine(raw, { runId: handle.runId })
      if (!mapped) continue
      handle.requests++
      try { handle.audit?.write(mapped + '\n') } catch {}
      let parsed
      try { parsed = JSON.parse(mapped) } catch { continue }
      if (parsed.action === 'allow') continue
      const map = parsed.action === 'would_deny' ? handle.wouldBlock : handle.blocked
      const count = (map.get(parsed.host) ?? 0) + 1
      map.set(parsed.host, count)
      if (handle.onBlocked) {
        try {
          handle.onBlocked({
            host: parsed.host, method: parsed.method, path: parsed.path,
            at: Date.parse(parsed.at) || Date.now(), count, action: parsed.action,
          })
        } catch {}
      }
    }
  })
  readable.on('error', () => {})
  handle.tail = readable
}
