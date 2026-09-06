// Freilauf — the iron-proxy engine (SANDBOX.md).
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
// The binary is HERE now. `ironsh/iron-proxy:0.49.0` is public on Docker Hub
// (Apache-2.0, source at github.com/paradigmxyz/iron-proxy), it is pulled and
// pinned by digest in `sandbox/images/ironproxy.ref`, and the config this module
// writes has been parsed, started and driven end to end against it on
// 2026-09-05 — including the `secrets` transform swapping a per-run placeholder
// for a real credential on the way upstream. `SANDBOX.md` carries the four
// measurements; the e2e group "iron-proxy: the config the hub writes" re-runs
// the config half wherever the image is present.
//
// What that measurement CORRECTED, because every one of these was a guess that
// was wrong in a way the binary does not complain about:
//
//   - `log: { level, format }` — `format` does not exist and is the ONE field
//     that failed loudly (`field format not found in type config.Log`). The log
//     is JSON on stderr regardless.
//   - `dns.enabled: false` is REQUIRED. Without it the binary refuses to start
//     with `dns.proxy_ip is required` — it wants to be the sandbox's resolver,
//     and Freilauf reaches it through `HTTPS_PROXY` instead (§7.5.2).
//   - `tls.ca_cert` and `tls.ca_key` are REQUIRED in the default `mitm` mode.
//     No CA, no start. `tls.mode: "sni-only"` needs none — and then the
//     pipeline sees the hostname and nothing else, so the `secrets` transform
//     has nothing to act on. That is why `secrets.mode: inject` and
//     `tlsTerminate` are one capability and not two. The certificate also has
//     to carry the right extension: a CA generated without
//     `keyUsage=critical,keyCertSign,cRLSign` starts the process and then dies
//     with `initializing cert cache: CA certificate missing KeyUsageCertSign`,
//     which is why SANDBOX.md prints the four commands rather than saying
//     "generate a CA".
//   - `management.api_key_env` names a variable that MUST BE SET, or the binary
//     refuses to start (`… is not set in the environment`). `startIronProxy()`
//     always mints one into the proxy's environment, so the hub's own path
//     cannot hit it — an operator hand-running this config can.
//   - `deny_domains` DOES NOT EXIST, and — the expensive half — an unknown key
//     inside a transform's `config` is **silently ignored**. Measured: a config
//     carrying `deny_domains` and a config-level `methods` both started
//     cleanly and enforced neither. So a deny host is subtracted from the
//     allowlist here, in the hub, and what cannot be subtracted is named by
//     `configWarnings()`. Nothing this module cannot express is ever written
//     into a file that would swallow it.
//   - a per-method rule is `rules: [{ host, methods, paths }]`, never a
//     `methods` next to `domains`.
//   - the `secrets` entry nests under `replace:` (`proxy_value`,
//     `match_headers`, `require`). The flat form this module used to write is
//     documented as the legacy shape and does still parse — it is written the
//     documented way now anyway, because "still supported" is a promise with a
//     removal date on it.
//
// And the one that was NOT a config field at all, because it is the thing the
// whole feature is for: `require: true` — the flag that rejects a request to a
// declared host which does not carry the placeholder — makes injection reject
// EVERYTHING on the path Freilauf uses. See the comment where it is not
// written.
//
// Also measured: `POST /v1/reload` is an empty POST with the bearer token and
// answers 200, and 401 without it — so the assumption in `postReload()` holds.
// And the audit line's field NAMES were right (`host`, `method`, `path`,
// `action`, `status_code`, `duration_ms`, `rejected_by`) while their PLACE was
// not: they sit inside an `audit` object on a line whose `msg` is `request`,
// not at the top level. `mapIronLine()` read the top level, so it would have
// returned null for every real line and `egress.jsonl` would have stayed empty
// under this engine — a silence that looks exactly like a quiet run.
//
// The rule the whole module keeps: where the binary is absent, `startIronProxy`
// fails with a READABLE reason and the caller falls back to the built-in engine.
// It never throws something the operator would have to read a stack trace to
// understand, and it never half-starts.
import { createWriteStream, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { t } from '../i18n.mjs'
import { env } from '../env.mjs'
import { sh } from '../util.mjs'
import { normalizeSpec } from './spec.mjs'
import { proxyPolicy, auditLine } from './proxy.mjs'
import { writeFileNoSymlink } from './exec.mjs'

/** The listener the agent container's HTTPS_PROXY points at, inside the proxy container. */
export const TUNNEL_PORT = 8080
/** The management listener that answers POST /v1/reload. */
export const MANAGEMENT_PORT = 8081
/** The environment variable iron-proxy reads its management key from (§4.5). */
export const MANAGEMENT_KEY_ENV = 'IRON_MANAGEMENT_API_KEY'
/**
 * Where the MITM CA appears inside the PROXY container. The cert is the same
 * file the agent container trusts (`CA_TARGET` in runtime.mjs); the KEY is the
 * proxy's alone and must never be mounted anywhere else — whoever holds it can
 * mint a leaf for any host the agent talks to.
 */
export const PROXY_CA_CERT = '/etc/freilauf/ca.crt'
export const PROXY_CA_KEY = '/etc/freilauf/ca.key'

/**
 * The image, and it is a REAL one now.
 *
 * `ironsh/iron-proxy` is public on Docker Hub (Apache-2.0, source at
 * github.com/paradigmxyz/iron-proxy); `0.49.0` is the newest non-prerelease tag
 * and is what every measurement in this file was made against. The digest is
 * carried next to the tag for the same reason `image.digest` exists for the
 * agent images: a tag is a mutable name, and a proxy holding the run's real
 * credentials is the last container that should silently change underneath the
 * hub. `sandbox/images/ironproxy.ref` is the same pair in a file, for the
 * operator who mirrors it.
 *
 * `FREILAUF_SANDBOX_PROXY_IMAGE` still overrides both — a mirror, a private
 * registry, or a newer version somebody has actually tested.
 */
export const DEFAULT_PROXY_IMAGE = 'ironsh/iron-proxy:0.49.0'
export const DEFAULT_PROXY_DIGEST = 'sha256:c4628019c24f4cc8d77564a26b7c9cedb00accee6f93d06270e85fb8f9c6a7da'

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
  const auditOnly = policy.auditOnly === true
  const { allow } = resolveHosts(policy)
  // Methods are read from the spec rather than from the policy: `proxyPolicy()`
  // drops them on an engine that cannot see a method, and this engine can — a
  // config generated for iron-proxy must carry what iron-proxy can enforce even
  // when the profile was last resolved against the built-in.
  const methods = Array.isArray(net_.methods) && net_.methods.length
    ? net_.methods.map((m) => String(m).toUpperCase())
    : null

  const secrets = Array.isArray(ctx.secrets) ? ctx.secrets.filter((s) => s && s.envVar && s.placeholder) : []
  // MITM or nothing: the `secrets` transform reads and rewrites a header, which
  // needs terminated TLS. Measured — `tls.ca_cert`/`ca_key` are required in
  // `mitm` mode and the binary refuses to start without them, so a run that
  // asked for injection and has no CA must not reach this file at all
  // (`ensureProxy()` refuses the launch; §7.8).
  const caCert = ctx.caCert ?? (ctx.caPath ? PROXY_CA_CERT : null)
  const caKey = ctx.caKey ?? (ctx.caKeyPath ? PROXY_CA_KEY : null)
  const mitm = Boolean(caCert && caKey)

  const lines = []
  lines.push('# Generated by Freilauf — do not edit; the hub rewrites it on every policy change.')
  // Freilauf reaches the proxy through HTTPS_PROXY, never through DNS
  // interception — and the binary REFUSES TO START without this line
  // (`dns.proxy_ip is required`), because the DNS server is on by default.
  lines.push('dns:')
  lines.push('  enabled: false')
  lines.push('proxy:')
  lines.push(`  tunnel_listen: ${yamlString(`:${ctx.tunnelPort ?? TUNNEL_PORT}`)}`)
  // The upstream deny list of §7.5.3, enforced at connect time against the
  // RESOLVED address — which is what a host allowlist alone cannot do, because
  // an allowed name may resolve to the metadata service. An explicit empty list
  // is a decision (`denyUpstreamCidrs: []` in the spec) and is written as one:
  // omitting the key would restore the vendor's own defaults instead.
  const cidrs = (policy.denyCidrs ?? []).map(c => c?.text).filter(Boolean)
  lines.push(`  upstream_deny_cidrs: ${yamlList(cidrs)}`)
  lines.push('tls:')
  lines.push(`  mode: ${yamlString(mitm ? 'mitm' : 'sni-only')}`)
  if (mitm) {
    lines.push(`  ca_cert: ${yamlString(caCert)}`)
    lines.push(`  ca_key: ${yamlString(caKey)}`)
  }
  lines.push('transforms:')
  lines.push('  - name: "allowlist"')
  lines.push('    config:')
  // `warn: true` is iron-proxy's own audit-only mode: everything passes, every
  // would-be denial is logged. It is the rollout mode of §7.12.5 and the reason
  // the allowlist can be grown from a repo's own traffic instead of guessed.
  if (auditOnly) lines.push('      warn: true')
  if (methods) {
    // A method restriction is per rule, never a `methods` beside `domains` — and
    // the wrong shape does not fail, it is silently dropped. Measured.
    lines.push('      rules:')
    for (const host of allow) {
      lines.push(`        - host: ${yamlString(host)}`)
      lines.push(`          methods: ${yamlList(methods)}`)
    }
    if (!allow.length) lines.push('        []')
  } else {
    lines.push(`      domains: ${yamlList(allow)}`)
  }

  if (secrets.length) {
    lines.push('  - name: "secrets"')
    lines.push('    config:')
    lines.push('      secrets:')
    for (const s of secrets) {
      lines.push(`        - source: { type: env, var: ${yamlString(s.envVar)} }`)
      // `replace`, not `inject`: the two words mean the opposite things in the
      // two projects. iron-proxy's `inject` sets a header on a client that sent
      // none; Freilauf's `secrets.mode: inject` means the CONTAINER holds a
      // placeholder its CLI sends like a real key — which is iron-proxy's
      // `replace`. `require: true` is what makes the placeholder the only way
      // through: a request to that host carrying some other credential is
      // rejected rather than forwarded.
      lines.push('          replace:')
      lines.push(`            proxy_value: ${yamlString(s.placeholder)}`)
      lines.push(`            match_headers: ${yamlList([s.header || 'Authorization'])}`)
      // AND NO `require: true`, WHICH IS THE ONE THING THIS WHOLE FEATURE
      // BROKE ON. `require` rejects a request to a declared host that does not
      // carry the placeholder — which sounds exactly right and, on the path
      // Freilauf uses, rejects everything. The hub reaches the proxy through
      // `HTTPS_PROXY`, so the first thing that arrives is a CONNECT, and
      // iron-proxy evaluates a SYNTHETIC CONNECT — no headers at all — against
      // the secrets transform. Measured 2026-09-05, iron-proxy 0.49.0: every
      // call to the credential's own host died as `curl: (56) CONNECT tunnel
      // failed, response 403`, with `rejected_by: "secrets"` and
      // `annotations: { rejected: "STUB_API_KEY" }` in the audit line — while
      // the same call to a host the credential is NOT declared for went
      // through. The one host that must work was the only one that could not.
      //
      // Dropping it costs the bypass fence and nothing else: the swap still
      // happens, and it still happens only on the declared hosts. What is given
      // up is "a workload cannot reach this host with a credential of its own"
      // — and the allowlist already decides which hosts exist at all. It comes
      // back the day the sandbox routes through iron-proxy's DNS interception
      // instead of HTTPS_PROXY (§7.5.2), because then a real request with real
      // headers is what the transform sees.
      const hosts = Array.isArray(s.hosts) ? s.hosts : []
      lines.push('          rules:')
      for (const h of hosts) lines.push(`            - host: ${yamlString(h)}`)
      if (!hosts.length) lines.push('            []')
    }
  }

  // `format` is NOT a field of this block — it is the one guess the binary
  // rejected outright. The audit line is JSON on stderr either way.
  lines.push('log:')
  lines.push('  level: "info"')
  lines.push('management:')
  lines.push(`  listen: ${yamlString(`0.0.0.0:${ctx.managementPort ?? MANAGEMENT_PORT}`)}`)
  lines.push(`  api_key_env: ${MANAGEMENT_KEY_ENV}`)
  return lines.join('\n') + '\n'
}

/**
 * The allowlist iron-proxy is really given, and the deny entries that could not
 * be folded into it.
 *
 * iron-proxy has no deny list. It has an allowlist, and an unknown key inside a
 * transform's `config` is swallowed without a word — so writing `deny_domains`
 * would produce a config that starts, looks right and enforces nothing. The
 * subtraction therefore happens HERE, where it can be checked, and it is exact:
 * a deny entry is removed only when it is literally an allow entry. A deny that
 * narrows a wildcard (`deny: evil.example.com` under `allow: *.example.com`) has
 * no expression on this engine at all, so it is handed to `configWarnings()`
 * rather than dropped.
 */
export function resolveHosts(policy) {
  const deny = new Set((policy?.deny ?? []).map(String))
  const allow = [...(policy?.allow ?? [])].map(String).filter(h => !deny.has(h))
  const unexpressed = [...deny].filter(d => !(policy?.allow ?? []).map(String).includes(d))
  return { allow, unexpressed }
}

/**
 * What this config could not express. Never a throw: a warning the operator can
 * read beats a start that fails on a field they did not know about.
 *
 * It was computed and dropped on the floor for a while — nothing read
 * `handle.warnings` — which made it the very failure this module is a lesson
 * about: a policy that does nothing starts as cleanly as one that binds. The
 * caller writes it as a `warn` event on the run, so it stands in the run's own
 * history and travels into the audit export, where an auditor reading the
 * spec's deny list would otherwise believe it bound.
 */
export function configWarnings(spec, ctx = {}) {
  const policy = proxyPolicy(spec, { secretsMode: ctx.secretsMode })
  const out = []
  const { unexpressed } = resolveHosts(policy)
  if (unexpressed.length) out.push(t('sandbox.warn.deny_unenforced', { hosts: unexpressed.join(', ') }))
  if (policy.broken) out.push(t('sandbox.warn.policy_broken', { reason: policy.broken }))
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
      // NOT `writeFileSync`: `~/agents/runs/<id>/` is mounted read-write into
      // the container at the agent's own uid, and `'w'` follows a symlink — a
      // link left at this name makes the hub write the run's proxy policy
      // through it, as the hub user, on the next launch or reload.
      if (!writeFileNoSymlink(configPath, ironProxyConfig(spec, ctx), { mode: 0o600 })) {
        return failed(runId, t('sandbox.proxy.engine_missing', {
          reason: t('sandbox.proxy.config_symlink', { path: configPath }),
        }))
      }
    } catch (err) {
      return failed(runId, t('sandbox.proxy.engine_missing', { reason: err?.message || String(err) }))
    }
  }

  // The proxy's own image. There IS a default now — see DEFAULT_PROXY_IMAGE:
  // the upstream image is public, pinned by digest and is what every
  // measurement in this file was made against. It used to be `null` on purpose,
  // because a hardcoded tag nobody had pulled would have failed at `docker run`
  // with a registry error that reads as a network fault; that argument ends the
  // moment the tag is one somebody has actually run.
  const image = ctx.image ?? env('SANDBOX_PROXY_IMAGE') ?? DEFAULT_PROXY_IMAGE
  if (!image) return failed(runId, t('sandbox.proxy.no_image'))
  // Only pin the digest for the image the digest describes. An operator who
  // pointed the variable at their own mirror gets their tag, unpinned — the
  // alternative is a `docker run` that refuses their image for not being ours.
  const digest = ctx.digest ?? (image === DEFAULT_PROXY_IMAGE ? DEFAULT_PROXY_DIGEST : null)

  // MITM needs the CA's PRIVATE KEY, and the binary will not start without it
  // (measured: `tls.ca_cert is required`, then `tls.ca_key`). Without a key the
  // config falls back to `tls.mode: sni-only`, where the pipeline sees the
  // hostname alone — so a run that asked for injection and has no key would
  // start a proxy that quietly swaps nothing. Said here rather than found out
  // there.
  if (ctx.secretsMode === 'inject' && !ctx.caKeyPath) {
    return failed(runId, t('sandbox.proxy.inject_no_ca_key'))
  }

  const managementKey = ctx.managementKey ?? randomBytes(24).toString('hex')
  // Kept on the handle, because the proxy is re-launched from it when the
  // secrets table arrives (setSecretsIronProxy below): a container's
  // environment is fixed at creation, and iron-proxy reads the real credentials
  // out of its own environment (§4.5).
  const launchCtx = {
    ...ctx,
    runId,
    image,
    digest,
    configPath,
    tunnelPort: ctx.tunnelPort ?? TUNNEL_PORT,
    managementPort: ctx.managementPort ?? MANAGEMENT_PORT,
    env: { ...(ctx.env ?? {}), [MANAGEMENT_KEY_ENV]: managementKey },
  }

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
    launchCtx,
    managementKey,
    managementPort: launchCtx.managementPort,
    // Resolved lazily, never here: right after the spawn the container has no
    // address yet, and the one thing worse than an unknown management listener
    // is a remembered wrong one. See resolveManagementUrl().
    managementUrl: ctx.managementUrl ?? null,
    // The `secrets` transform, once `setSecrets()` has been handed one. Kept so
    // an ordinary policy reload rewrites the file WITH it — regenerating the
    // config from the spec alone would silently drop every injection rule and
    // turn every API call in the container into a 401.
    secrets: [],
    container: ctx.containerName ?? (runId ? `fl-proxy-${runId}` : null),
    runtimeId: info.id,
    audit: ctx.runDir ? openAudit(ctx.runDir) : null,
    warnings: configWarnings(spec, ctx),
    tail: null,
  }

  const started = await spawnProxy(handle)
  if (!started.ok) return failed(runId, t('sandbox.proxy.engine_missing', { reason: started.reason }))
  return handle
}

/**
 * Launch (or re-launch) the proxy container from the handle's own `launchCtx`.
 *
 * The command line comes from runtime.mjs — the container runtime's argv is that
 * module's subject, and a second place that knows how to say `docker run` is a
 * second place that would drift. Spawning it is this module's, because the
 * proxy's stdout IS its audit stream (tailLog below).
 */
async function spawnProxy(handle) {
  let runtime
  try { runtime = await import('./runtime.mjs') }
  catch (err) { return { ok: false, reason: err?.message || String(err) } }
  // INSIDE the try, and that is not tidiness. `buildProxyArgv()` throws a
  // `SandboxArgvError` for a spec it cannot turn into a command line — and the
  // one it could not turn into a command line was every spec, because
  // `ensureProxy()` names no image for the proxy: `No sandbox image for this
  // run` came out of this line and straight through the caller, so the
  // "fails with a readable reason and the caller falls back to the built-in
  // engine" promise at the top of this file had never once executed.
  let argv
  try {
    argv = runtime.buildProxyArgv(handle.spec, handle.launchCtx)
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
  if (!argv) return { ok: false, reason: 'no proxy command line' }
  addCaKeyMount(argv, handle.launchCtx)
  try {
    const { spawn } = await import('node:child_process')
    const child = spawn(argv.bin, argv.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', () => {})
    child.stderr?.resume()
    handle.child = child
    // A fresh container is a fresh address, so whatever was remembered about
    // the management listener describes a container that no longer exists.
    handle.managementUrl = handle.launchCtx.managementUrl ?? null
    tailLog(handle, child.stdout)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
}

/**
 * Mount the MITM CA's private key into the proxy container, read-only.
 *
 * THIS BELONGS IN `buildProxyArgv()` AND IS HERE ON PURPOSE, WITH A DATE ON IT.
 * That function is runtime.mjs's, it already mounts the config and the CA
 * *certificate*, and one more `addMount()` line beside them is the right home
 * for this. It is spliced here because the key is the one thing about the proxy
 * container that is iron-proxy's alone — the built-in engine terminates nothing
 * and needs no key — and because the file was another agent's while this was
 * measured. Move it: delete this function and add
 * `if (ctx.caKeyPath) addMount(args, own, { source: ctx.caKeyPath, target: PROXY_CA_KEY, mode: 'ro' })`
 * next to the caPath line.
 *
 * The image reference is the last argument `buildProxyArgv()` pushes before
 * `ctx.cmd`, so the insertion point is counted from the end rather than
 * searched for — a search for something that looks like an image would match a
 * `--label` value one day.
 */
export function addCaKeyMount(argv, ctx = {}) {
  if (!argv?.args || !ctx.caKeyPath) return argv
  const at = argv.args.length - (ctx.cmd?.length ?? 0) - 1
  if (at < 0) return argv
  argv.args.splice(at, 0, '-v', `${ctx.caKeyPath}:${PROXY_CA_KEY}:ro`)
  return argv
}

/**
 * Where the hub can reach this proxy's management listener, or `null` with a
 * reason it can print.
 *
 * The listener is inside the proxy container on `0.0.0.0:<managementPort>`, and
 * the hub is on the host — so the address is the container's own, asked of the
 * daemon once and remembered. Two seams come first: `ctx.managementUrl` (what a
 * caller already knows, and what the tests hand over) and
 * `FREILAUF_SANDBOX_MANAGEMENT_URL` (an operator who published the port, or who
 * runs the proxy somewhere this hub can name).
 *
 * A failure is NOT remembered: right after the spawn the container may be a beat
 * behind the question, and "could not ask" is not "there is no listener" — the
 * same distinction `tmuxVerdict()` exists for.
 */
export async function resolveManagementUrl(handle) {
  if (!handle) return { url: null, reason: 'no handle' }
  if (handle.managementUrl) return { url: handle.managementUrl, reason: null }
  const fromEnv = env('SANDBOX_MANAGEMENT_URL')
  if (fromEnv) { handle.managementUrl = String(fromEnv).replace(/\/$/, ''); return { url: handle.managementUrl, reason: null } }
  if (!handle.container) return { url: null, reason: 'no proxy container' }

  let bin = 'docker'
  try { bin = (await import('./runtime.mjs')).runtimeBin(handle.runtimeId) } catch { /* the default is right for docker and podman alike */ }
  // Every network the container is on, by NAME, because a proxy has two legs
  // (§7.5.2) and one of them is the run's own `internal` network — which is
  // precisely the one the host cannot route to. So that name is asked for and
  // dropped rather than hoped to sort last. Anything left is a best effort; an
  // installation where none of it is reachable sets
  // FREILAUF_SANDBOX_MANAGEMENT_URL, and the refusal below names it.
  const r = await sh(bin, ['inspect', '--format',
    '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}', handle.container], { timeout: 15_000 })
  if (!r.ok) return { url: null, reason: (r.stderr || '').trim() || `${bin} inspect failed` }
  const legs = String(r.stdout ?? '').trim().split(/\s+/)
    .map(pair => { const i = pair.indexOf('='); return i < 0 ? null : { net: pair.slice(0, i), ip: pair.slice(i + 1) } })
    .filter(l => l && l.ip && l.ip !== '<no value>')
  const internal = handle.launchCtx?.network ?? null
  const address = (legs.find(l => l.net !== internal) ?? legs[0])?.ip
  if (!address) return { url: null, reason: 'the proxy container has no address yet' }
  handle.managementUrl = `http://${address}:${handle.managementPort ?? MANAGEMENT_PORT}`
  return { url: handle.managementUrl, reason: null }
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
  const written = writeConfig(handle, spec)
  if (!written.ok) return { ok: false, reason: written.reason, policy: handle.policy }
  const posted = await postReload(handle)
  if (!posted.ok) return { ok: false, reason: posted.reason, policy: handle.policy }
  handle.policy = next
  handle.spec = spec
  return { ok: true, policy: next }
}

/**
 * Rewrite `proxy.yaml` from the spec AND the handle's own secrets table.
 *
 * Both, always: the secrets are not in the spec (they are minted per launch and
 * carry values that must never be written into a run's stored definition), so a
 * config regenerated from the spec alone drops every injection rule — and the
 * container would go on holding placeholders nobody swaps, which is a run whose
 * every API call 401s while it looks perfectly healthy.
 */
function writeConfig(handle, spec) {
  if (!handle.configPath) return { ok: true }
  try {
    // Symlink-refusing, like the writer at launch and for the same reason: this
    // path is rewritten on EVERY policy reload, which is the moment an agent
    // that has replaced the file with a link is waiting for.
    const ok = writeFileNoSymlink(handle.configPath,
      ironProxyConfig(spec, { ...(handle.launchCtx ?? {}), secretsMode: handle.secretsMode, secrets: handle.secrets ?? [] }),
      { mode: 0o600 })
    if (!ok) return { ok: false, reason: t('sandbox.proxy.config_symlink', { path: handle.configPath }) }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
}

/**
 * `POST /v1/reload` on the management listener.
 *
 * The reason of a failure is written for somebody who has to DO something about
 * it: the file on disk is already the new policy and the running proxy is still
 * the old one, so it names the container, the port, what went wrong and the two
 * ways out (restart the run, or point `FREILAUF_SANDBOX_MANAGEMENT_URL` at an
 * address the hub can reach). A silent "ok" here would make the page claim a
 * policy change that never left the hub.
 */
async function postReload(handle) {
  const { url, reason } = await resolveManagementUrl(handle)
  if (!url) {
    return { ok: false, reason: t('sandbox.proxy.management_unreachable', {
      container: handle.container ?? '?', port: String(handle.managementPort ?? MANAGEMENT_PORT), reason: reason ?? '',
    }) }
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/reload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.managementKey}` },
    })
    if (!res.ok) {
      return { ok: false, reason: t('sandbox.proxy.management_unreachable', {
        container: handle.container ?? '?', port: String(handle.managementPort ?? MANAGEMENT_PORT), reason: `HTTP ${res.status}`,
      }) }
    }
  } catch (err) {
    // The address was resolved and did not answer — the container may have been
    // replaced since. Forget it, so the next attempt asks the daemon again.
    handle.managementUrl = handle.launchCtx?.managementUrl ?? null
    return { ok: false, reason: t('sandbox.proxy.management_unreachable', {
      container: handle.container ?? '?', port: String(handle.managementPort ?? MANAGEMENT_PORT),
      reason: err?.message || String(err),
    }) }
  }
  return { ok: true }
}

/**
 * §7.8's `inject`, on the engine that can actually do it: the container holds a
 * placeholder, and this table tells the proxy what to swap it for, on that
 * credential's own hosts and nowhere else.
 *
 * `table` is `[{ name, placeholder, value, header, prefix, hosts }]` — `name` is
 * the environment variable the agent's CLI reads, `value` the real credential.
 *
 * TWO THINGS HAPPEN HERE, AND THE SECOND ONE IS WHY THIS IS NOT A RELOAD.
 *
 *  1. The `secrets` transform is written into `proxy.yaml` — the rule half:
 *     which placeholder, in which header, to which hosts.
 *  2. The real values are put into the PROXY CONTAINER'S ENVIRONMENT, because
 *     that is the only source §4.5 documents (`source: { type: env, var }`) and
 *     the hub must not invent a config field that ships a secret inline. A
 *     running container's environment cannot be changed, so the proxy is
 *     stopped and started again from the same `launchCtx` with those variables
 *     added. That is affordable exactly here and nowhere else: this runs while
 *     the sandbox is being prepared, BEFORE the agent's container exists, so
 *     there is no traffic to drop — which is also why a live `secrets.mode`
 *     change is classified as needing a restart (§7.12.3) rather than as a
 *     live policy change.
 *
 * A refusal is `{ ok: false, reason }` and never a silent success: the caller
 * fails the launch on it, because a placeholder nobody swaps and a real key in
 * the container are both worse than a run that does not start.
 */
export async function setSecretsIronProxy(handle, table) {
  if (!handle || handle.ok === false) return { ok: false, reason: handle?.reason ?? 'no handle' }
  const entries = Array.isArray(table) ? table : []
  if (!entries.length) return { ok: true, injected: [] }

  // An injection without hosts would hand the real credential to whatever the
  // agent happened to call — the one shape docs/plugins.md refuses outright.
  const homeless = entries.filter(s => !s?.name || !s?.placeholder || !Array.isArray(s.hosts) || !s.hosts.length)
  if (homeless.length) {
    return { ok: false, reason: t('sandbox.proxy.inject_no_hosts', { vars: homeless.map(s => s?.name ?? '?').join(', ') }) }
  }

  handle.secrets = entries.map(s => ({
    key: s.key ?? s.name,
    envVar: s.name,
    placeholder: s.placeholder,
    header: s.header || 'Authorization',
    hosts: s.hosts,
  }))
  const written = writeConfig(handle, handle.spec)
  if (!written.ok) return { ok: false, reason: written.reason }

  // The prefix belongs to the VALUE, not to the rule: iron-proxy substitutes
  // what the variable holds, so `Bearer ` has to be part of it wherever the
  // plugin declared one — otherwise the swapped header carries a bare token.
  const secretEnv = {}
  for (const s of entries) secretEnv[s.name] = `${s.prefix ?? ''}${s.value ?? ''}`

  await stopProxyContainer(handle)
  handle.launchCtx = { ...(handle.launchCtx ?? {}), env: { ...(handle.launchCtx?.env ?? {}), ...secretEnv } }
  const started = await spawnProxy(handle)
  if (!started.ok) return { ok: false, reason: t('sandbox.proxy.inject_restart_failed', { reason: started.reason }) }
  return { ok: true, injected: entries.map(s => s.name) }
}

/** Stop and remove the proxy container, so the name is free for the next `run`. */
async function stopProxyContainer(handle) {
  try { handle.tail?.destroy?.() } catch {}
  handle.tail = null
  try { handle.child?.kill?.('SIGTERM') } catch {}
  handle.child = null
  if (!handle.container) return
  try {
    const runtime = await import('./runtime.mjs')
    await runtime.stopContainer(handle.container, { runtime: handle.runtimeId, timeoutSec: 10 })
    await runtime.removeContainer(handle.container, { runtime: handle.runtimeId, force: true })
  } catch {
    // Fail-soft like every teardown here: a container that will not go is
    // `docker run --name`'s problem a moment from now, and it reports it
    // readably.
  }
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
  if (!j || typeof j !== 'object') return null
  // MEASURED: a real per-request line is `{ time, level, msg: "request",
  // audit: { host, method, path, action, status_code, duration_ms, ... },
  // rejected_by, request_transforms: [...] }`. The fields were named right and
  // placed wrong, and reading only the top level meant returning null for every
  // line the proxy ever writes — an empty `egress.jsonl` that reads as a quiet
  // run rather than as a mapper that never matched. The flat form is still
  // accepted because it is what the unit tests were written against and what a
  // future release could go back to; `?? j` is the whole difference.
  const a = (j.audit && typeof j.audit === 'object') ? j.audit : j
  if (!a.host) return null
  // A host arrives as `api.example.com:8443` on the tunnel path — the audit
  // shape has a port field of its own, and a host carrying its port would not
  // match anything the blocked-host counters or the four channels group on.
  let host = String(a.host)
  let port = a.port ?? null
  const colon = host.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
    port = port ?? Number(host.slice(colon + 1))
    host = host.slice(0, colon)
  }
  const rejectedBy = a.rejected_by ?? j.rejected_by ?? null
  const action = a.action === 'warn' || a.warn === true
    ? 'would_deny'
    : (a.action === 'reject' || a.action === 'deny' || rejectedBy ? 'deny' : 'allow')
  return auditLine({
    at: a.timestamp ?? j.timestamp ?? j.time ?? Date.now(),
    run: runId,
    engine: 'iron-proxy',
    host,
    port,
    method: a.method ?? null,
    path: a.path || null,
    action,
    status: a.status_code ?? a.status ?? null,
    durationMs: a.duration_ms ?? 0,
    bytesIn: a.bytes_in ?? 0,
    bytesOut: a.bytes_out ?? 0,
    rejectedBy,
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
