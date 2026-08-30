// cc-hub — provider plugin: OpenRouter.

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  parseRoutingConfig, routingConfigKey, selectBestProvider, endpointFits, quantizationsFrom,
} from './openrouter-routing.mjs'

/** The chat-completions endpoint. Overridable so the e2e suite can stub it. */
const CHAT_URL = () => process.env.CCHUB_OPENROUTER_BASE ?? 'https://openrouter.ai/api/v1/chat/completions'

/**
 * The credential, resolved the way the operator configured it.
 *
 * `ctx.secret()` is the answer to "use a different key" and "read it from a
 * different variable"; the plain environment read stays as the fallback for the
 * contexts that predate credentials (the unit suite injects one of those).
 */
const apiKey = (ctx) => ctx?.secret?.('api_key') || ctx?.env?.OPENROUTER_API_KEY || null

// ── Best-provider selection cache ─────────────────────────────────────────────
//
// The selection is CACHED PER MODEL AND CONFIG: the next run that picks the
// same model with the same requirements gets the same provider order, not a
// re-rolled one — a selection that hops between runs is exactly the variance
// the internal-project project built its pins against. The cache lives in a
// JSON file next to the other hub data (claude-windows.json precedent): it
// survives the hub's frequent deploys, and a built-in plugin file must not
// reach the database anyway (docs/plugins.md, import rules).
//
// TTL 24 h — long enough that the same settings really do produce the same
// answer, short enough that price and health drift get picked up. A FRESH
// answer never falls back to a stale one, and a failed fetch serves the stale
// entry marked `veraltet` rather than nothing: a slightly old selection is
// still better than silently routing wherever OpenRouter pleases.

const ROUTING_TTL_MS = 24 * 60 * 60 * 1000
const routingCacheFile = () =>
  process.env.CCHUB_OR_ROUTING_JSON ?? join(homedir(), '.local/share/cc-hub/openrouter-routing.json')

function readRoutingCache() {
  try { return JSON.parse(readFileSync(routingCacheFile(), 'utf8')) } catch { return {} }
}

function writeRoutingCache(cache) {
  const file = routingCacheFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cache, null, 1))
  } catch (e) { console.error('openrouter routing cache:', e.message) }
}

export const ROUTING_KEY = (model, cfg) => `${model}::${routingConfigKey(cfg)}`

/** The endpoints of one model, narrowed to what the selection reads. */
async function fetchRoutingEndpoints(ctx, modelId) {
  if (!/^[\w.~\-]+\/[\w.~\-:]+$/.test(modelId)) throw new Error(`not a model id: ${modelId}`)
  // The id is validated against its shape, so it goes into the path verbatim —
  // percent-encoding the separator is exactly how the API answers "no model".
  const j = await ctx.json(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`)
  return (j?.data?.endpoints ?? []).map(ep => ({
    tag: ep.tag,
    provider_name: ep.provider_name ?? null,
    quantization: ep.quantization ?? null,
    status: ep.status,
    uptime_last_30m: ep.uptime_last_30m ?? null,
    supported_parameters: ep.supported_parameters ?? [],
    pricing: ep.pricing ?? {},
  })).filter(ep => ep.tag)
}

const plugin = {
  id: 'openrouter',
  label: 'OpenRouter',

  // Env vars that hold a credential for this provider. The hub passes them into
  // the agent's tmux session via `cc-start --env` (tmux does NOT inherit the
  // environment) and uses them to decide whether the provider can be offered.
  envKeys: ['OPENROUTER_API_KEY'],

  // The same thing, declared: `envKeys` is what a run's `--env` needs, this is
  // what the Plugins page renders and what `ctx.secret()` resolves through.
  credentials: [{
    key: 'api_key',
    envKeys: ['OPENROUTER_API_KEY'],
    labelKey: 'plugins.cred_api_key',
    required: true,
  }],

  // Model prefix opencode uses to address this provider (`openrouter/author/slug`).
  ocPrefix: 'openrouter',

  // Key of this provider in the models.dev registry (used for effort levels).
  mdKey: 'openrouter',

  // Health pulse target (watcher checks it while runs use this provider).
  pulse: { url: 'https://openrouter.ai/api/v1/models', okStatus: [200] },

  /**
   * The budget gate for a run that draws on OpenRouter credits.
   *
   * The threshold key is still `openrouter_min_eur` although the figure is
   * DOLLARS: OpenRouter denominates its credits in USD, and renaming a stored
   * settings key would need a migration for nothing. (The old reason line
   * printed a euro sign next to a dollar figure; that is what was fixed, not
   * the key.) `settingKey` is the escape hatch that lets the historic name
   * stand while the field is declared here.
   */
  gate: {
    fields: [
      { key: 'gate_on', settingKey: 'openrouter_gate_on', type: 'switch', default: 1, labelKey: 'settings.gate_openrouter_on' },
      { key: 'min_usd', settingKey: 'openrouter_min_eur', type: 'number', default: 5, min: 0, step: 0.5, labelKey: 'settings.openrouter_min' },
    ],
    async check(ctx, values = {}) {
      const { balanceGateBlocked } = await import('../quota.mjs')
      const g = await balanceGateBlocked(plugin.id, { minimum: values.min_usd ?? 5 })
      return g.blocked ? g : null
    },
  },

  /**
   * OpenRouter can answer the hub's own questions, and it is the source every
   * one of them used before this contract existed. `native` means the JSON
   * schema goes over the wire as a schema (`response_format: json_schema`,
   * `strict: true`) rather than as a paragraph of pleading in the prompt.
   */
  llm: {
    schema: 'native',
    async models(ctx) { return plugin.fetchModels(ctx) },
    /**
     * One chat completion. This call used to be copy-pasted into four callers
     * (run title, incident check, flow `extract`, worktree extras), each with
     * its own error style and only one of them honouring CCHUB_OPENROUTER_BASE.
     *
     * `provider: { order, allow_fallbacks: false }` is OpenRouter's serving-
     * provider pin — the same field the run form calls "serving provider".
     */
    async complete(ctx, req = {}) {
      const key = apiKey(ctx)
      if (!key) throw new Error('OpenRouter: no API key')
      const messages = []
      if (req.system) messages.push({ role: 'system', content: String(req.system) })
      messages.push({ role: 'user', content: String(req.prompt ?? '') })
      const body = {
        model: req.model,
        messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 1000,
      }
      if (req.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: req.schemaName || 'answer', strict: true, schema: req.schema },
        }
      }
      if (req.servingProvider && req.servingProvider !== 'auto') {
        body.provider = { order: [req.servingProvider], allow_fallbacks: false }
      } else if (req.servingProvider === 'auto') {
        // "auto" = the hub's best-provider selection for THIS model, with the
        // default requirements. Cached per model; a failure here is fail-soft —
        // the call goes out unpinned rather than failing, the same degradation
        // a routing config nobody could resolve means at launch.
        try {
          const r = await plugin.routing.resolve(ctx, req.model, {})
          if (r.ok) body.provider = { order: r.order, allow_fallbacks: false }
        } catch { /* free routing is the old behaviour and stays reachable */ }
      }
      const j = await ctx.json(CHAT_URL(), {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/hwalde/cc-hub',
        'X-Title': `cc-hub ${req.purpose || 'request'}`,
      }, { method: 'POST', body: JSON.stringify(body), timeoutMs: req.timeoutMs ?? 60_000 })
      const raw = j?.choices?.[0]?.message?.content
      return {
        text: typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''),
        usage: j?.usage ?? null,
        raw: j,
      }
    },
  },

  /**
   * Model catalog. `ctx` provides { json } — a fetch helper with timeout.
   * Tool support and reasoning metadata are read from the catalog itself:
   * the `reasoning` field (NOT supported_parameters) carries the allowed effort
   * levels and whether reasoning is mandatory for the model.
   */
  /**
   * Account balance in the normalized shape (see docs/plugins.md). OpenRouter
   * keeps ONE pot and denominates it in US dollars — despite the `_eur` in the
   * old setting name, which is why the panel used to print a dollar figure with
   * a euro sign next to it.
   *
   * It says nothing about whether calls still go through, so `available` stays
   * null: the gate decides from the number, and null means "not reported"
   * rather than "fine" — the same rule the provider pulse follows.
   */
  async balance(ctx) {
    const key = apiKey(ctx)
    if (!key) return null
    const j = await ctx.json('https://openrouter.ai/api/v1/credits',
      { Authorization: `Bearer ${key}` })
    const d = j?.data ?? {}
    const total = Number(d.total_credits)
    const used = Number(d.total_usage)
    if (!Number.isFinite(total) || !Number.isFinite(used)) return null
    return {
      available: null,
      amounts: [{ currency: 'USD', remaining: Math.round((total - used) * 100) / 100 }],
    }
  },

  async fetchModels(ctx) {
    const j = await ctx.json('https://openrouter.ai/api/v1/models')
    return (j.data ?? []).map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      ctx: m.context_length ?? null,
      // A coding agent without tool support is useless — surface that.
      tools: (m.supported_parameters ?? []).includes('tools'),
      reasoning: m.reasoning?.supported_efforts?.length
        ? { stufen: m.reasoning.supported_efforts,
            standard: m.reasoning.default_effort ?? null,
            pflicht: m.reasoning.mandatory === true }
        : null,
    })).sort((a, b) => a.id.localeCompare(b.id))
  },

  /**
   * Best-provider selection ("serving provider: auto").
   *
   * `resolve(ctx, modelId, cfg)` answers with the provider order for THIS
   * model under THIS requirements config, cached per model+config (24 h, see
   * the block above). Pure filtering lives in openrouter-routing.mjs; this is
   * the I/O half: fetch the endpoint list, consult the cache, persist the new
   * answer, and on any failure fall back to a stale cached answer rather than
   * to nothing.
   *
   * `parseRoutingConfig` / `endpointFits` / `quantizationsFrom` are re-exported
   * so the harness plugins (opencode's OPENCODE_CONFIG_CONTENT) and the API
   * route build the SAME order from the SAME stored config — a second copy of
   * the decision rule would drift exactly the way the run definition once did.
   */
  routing: {
    parseConfig: parseRoutingConfig,
    endpointFits,
    quantizationsFrom,
    async resolve(ctx, modelId, cfg, { refresh = false } = {}) {
      const key = ROUTING_KEY(modelId, cfg)
      const cache = readRoutingCache()
      const entry = cache[key]
      const fresh = entry && !refresh && (Date.now() - new Date(entry.at).getTime()) < ROUTING_TTL_MS
      if (fresh) return { ...entry.result, cached: true, at: entry.at }

      let result = null
      let fetchError = null
      try {
        const endpoints = await fetchRoutingEndpoints(ctx, modelId)
        result = selectBestProvider(endpoints, cfg ?? {})
      } catch (e) { fetchError = e }

      if (!result?.ok) {
        // Nothing usable NOW: a stale answer beats an unpinned call — but only
        // a stale answer, never a fresh failure dressed up as one.
        if (entry?.result?.ok) {
          return { ...entry.result, veraltet: true, at: entry.at,
                   reason: result?.reason ?? fetchError?.message ?? null }
        }
        return { ok: false, order: [], best: null,
                 reason: result?.reason ?? fetchError?.message ?? 'endpoints unreachable' }
      }

      const at = new Date().toISOString()
      cache[key] = { model: modelId, cfg: cfg ?? {}, result, at }
      writeRoutingCache(cache)
      return { ...result, cached: false, at }
    },

    /**
     * The order for a RUN's stored routing config, the shape opencode.mjs
     * reads into OPENCODE_CONFIG_CONTENT. Used by startRun() at launch and by
     * the /api/or-routing preview.
     */
    async resolveForRun(ctx, modelId, storedRouting) {
      const cfg = parseRoutingConfig(storedRouting ?? {})
      if (!cfg || cfg.error) {
        return { ok: false, reason: cfg?.error ?? 'no auto routing configured' }
      }
      return plugin.routing.resolve(ctx, modelId, cfg)
    },
  },
}

export default plugin
