// Freilauf — provider plugin: OpenRouter.
//
// The one import is `env.mjs`, and it is safe as a STATIC one where the rest of
// the hub's modules are not: that file imports nothing at all, so it cannot be
// part of the registry cycle the lazy-import rule in AGENTS.md exists for.
import { env } from '../env.mjs'

/** The chat-completions endpoint. Overridable so the e2e suite can stub it. */
const CHAT_URL = () => env('OPENROUTER_BASE') ?? 'https://openrouter.ai/api/v1/chat/completions'

/**
 * The credential, resolved the way the operator configured it.
 *
 * `ctx.secret()` is the answer to "use a different key" and "read it from a
 * different variable"; the plain environment read stays as the fallback for the
 * contexts that predate credentials (the unit suite injects one of those).
 */
const apiKey = (ctx) => ctx?.secret?.('api_key') || ctx?.env?.OPENROUTER_API_KEY || null

const plugin = {
  id: 'openrouter',
  label: 'OpenRouter',

  // Env vars that hold a credential for this provider. The hub passes them into
  // the agent's tmux session via `fl-start --env` (tmux does NOT inherit the
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
     * its own error style and only one of them honouring FREILAUF_OPENROUTER_BASE.
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
      if (req.servingProvider) body.provider = { order: [req.servingProvider], allow_fallbacks: false }
      const j = await ctx.json(CHAT_URL(), {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/hwalde/freilauf',
        'X-Title': `Freilauf ${req.purpose || 'request'}`,
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
}

export default plugin
