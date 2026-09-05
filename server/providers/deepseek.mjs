// Freilauf — provider plugin: DeepSeek (direct API).

/**
 * The credential, resolved the way the operator configured it — a stored value,
 * an environment variable they named, or the declared one. The plain
 * environment read stays as the fallback for the contexts that predate
 * credentials (the unit suite injects one of those).
 */
const apiKey = (ctx) => ctx?.secret?.('api_key') || ctx?.env?.DEEPSEEK_API_KEY || null

const plugin = {
  id: 'deepseek',
  // Short on purpose: the label is a column heading in a 268px sidebar, and
  // "(direct)" pushed the balance onto a second line. That this is the direct
  // API rather than opencode's bundled access is what envKeys already says.
  label: 'DeepSeek',
  envKeys: ['DEEPSEEK_API_KEY'],
  credentials: [{
    key: 'api_key',
    envKeys: ['DEEPSEEK_API_KEY'],
    labelKey: 'plugins.cred_api_key',
    required: true,
  }],
  ocPrefix: 'deepseek',
  mdKey: 'deepseek',
  pulse: { url: 'https://api.deepseek.com/models', okStatus: [200, 401] },

  /**
   * What a sandboxed run on this provider needs (docs/plugins.md, "The sandbox
   * declaration"). One host, one bearer header — the same shape as OpenRouter,
   * and read off the three calls above rather than assumed.
   */
  sandbox: {
    domains: ['api.deepseek.com'],
    credentials: [{
      key: 'api_key',
      envKeys: ['DEEPSEEK_API_KEY'],
      injection: { header: 'Authorization', prefix: 'Bearer ', hosts: ['api.deepseek.com'] },
    }],
  },

  /**
   * The budget gate for a run that draws on the DeepSeek balance.
   *
   * Two things block, and the first is the reason `balance()` carries a verdict
   * at all: the account's own `is_available=false` (promotional credit can
   * expire while the figure still looks healthy), and a USD balance below the
   * threshold. A CNY-only account reports no USD, which is "no signal" — the
   * gate then stays open, exactly like a missing key.
   */
  gate: {
    fields: [
      { key: 'gate_on', settingKey: 'deepseek_gate_on', type: 'switch', default: 1, labelKey: 'settings.gate_deepseek_on' },
      { key: 'min_usd', settingKey: 'deepseek_min_usd', type: 'number', default: 2, min: 0, step: 0.5, labelKey: 'settings.gate_deepseek_min', hintKey: 'settings.gate_deepseek_min_hint' },
    ],
    async check(ctx, values = {}) {
      const { balanceGateBlocked } = await import('../quota.mjs')
      const g = await balanceGateBlocked(plugin.id, { minimum: values.min_usd ?? 2, unavailableBlocks: true })
      return g.blocked ? g : null
    },
  },

  /**
   * DeepSeek can answer the hub's own questions.
   *
   * `json_object` rather than `native`: the API is OpenAI-compatible and
   * documents its "JSON Output" mode as `response_format: {type:'json_object'}`
   * — it constrains the answer to valid JSON but takes no schema, so the shape
   * still has to be asked for in the prompt. That is exactly what the
   * `json_object` strategy in server/llm means, and it is the honest middle
   * between OpenRouter's schema pass-through and a plain prompt.
   */
  llm: {
    schema: 'json_object',
    async models(ctx) { return plugin.fetchModels(ctx) },
    async complete(ctx, req = {}) {
      const key = apiKey(ctx)
      if (!key) throw new Error('DeepSeek: no API key')
      const messages = []
      if (req.system) messages.push({ role: 'system', content: String(req.system) })
      messages.push({ role: 'user', content: String(req.prompt ?? '') })
      const body = {
        model: req.model,
        messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 1000,
      }
      // The caller decides whether the strict JSON mode is wanted: it is asked
      // for by handing over a schema, and the prompt half of the strategy is
      // appended by server/llm — never here (two places coaxing one model is
      // how the answers stop being reproducible).
      if (req.schema) body.response_format = { type: 'json_object' }
      const j = await ctx.json('https://api.deepseek.com/chat/completions', {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
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
   * Account balance in the normalized shape (see docs/plugins.md). DeepSeek
   * differs from OpenRouter in two ways the shape has to carry, and both are
   * why `balance()` normalizes instead of handing the raw answer through:
   *
   *  - the amounts arrive as STRINGS ("110.00"), not numbers;
   *  - there is one entry PER CURRENCY — an account can hold CNY and USD at the
   *    same time, so a single "remaining" number would silently drop one pot.
   *
   * `is_available` is the provider's own verdict on whether calls still go
   * through. No other provider reports that, and it is worth more than the
   * figure beside it: promotional credits can expire while the number still
   * looks healthy.
   */
  async balance(ctx) {
    const key = apiKey(ctx)
    if (!key) return null
    const j = await ctx.json('https://api.deepseek.com/user/balance',
      { Authorization: `Bearer ${key}` })
    const zahl = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null)
    const amounts = (j?.balance_infos ?? [])
      .map(b => ({
        currency: String(b?.currency ?? '?'),
        remaining: zahl(b?.total_balance),
        granted: zahl(b?.granted_balance),
        topped_up: zahl(b?.topped_up_balance),
      }))
      .filter(a => a.remaining !== null)
    const available = typeof j?.is_available === 'boolean' ? j.is_available : null
    // Nothing usable at all is "no answer", not "zero balance" — an empty panel
    // row would claim a fact the endpoint never stated.
    if (!amounts.length && available === null) return null
    return { available, amounts }
  },

  /**
   * The official endpoint requires a key. Without one we fall back to the
   * models.dev registry (the same one opencode uses) — it even carries display
   * names and context lengths.
   */
  async fetchModels(ctx) {
    const key = apiKey(ctx)
    if (key) {
      const j = await ctx.json('https://api.deepseek.com/models', { Authorization: `Bearer ${key}` })
      return (j.data ?? []).map(m => ({ id: m.id, name: m.id, ctx: null, tools: true }))
        .sort((a, b) => a.id.localeCompare(b.id))
    }
    const models = (await ctx.registry())?.deepseek?.models ?? {}
    return Object.entries(models).map(([id, m]) => ({
      id,
      name: m.name ?? id,
      ctx: m.limit?.context ?? null,
      tools: m.tool_call !== false,
    })).sort((a, b) => a.id.localeCompare(b.id))
  },
}

export default plugin
