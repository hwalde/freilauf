// cc-hub — provider plugin: OpenCode Zen.
//
// Pitfall: opencode addresses Zen with the model prefix 'opencode' — NOT
// 'opencode-zen' (the docs say otherwise, but `opencode models --pure` is the
// authority).

/** The credential, resolved the way the operator configured it. */
const apiKey = (ctx) => ctx?.secret?.('api_key')
  || ctx?.env?.OPENCODE_API_KEY || ctx?.env?.OPENCODE_ZEN_API_KEY || null

const plugin = {
  id: 'opencode-zen',
  label: 'OpenCode Zen',
  envKeys: ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
  credentials: [{
    key: 'api_key',
    envKeys: ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
    labelKey: 'plugins.cred_api_key',
    // `required: false` is a STATEMENT here, not an omission, and the Plugins
    // page reads it as one: an explicit false is what turns "no key found yet"
    // — which reads like a fault on a provider that is working perfectly well —
    // into "no key, and none is needed". Zen serves its free models to anyone,
    // which is also why opencode lists it under `keyFreeProviders`.
    required: false,
    // What the key actually buys, said next to the field that asks for it. The
    // generic "this is optional" line comes from the page; this is the half
    // only the plugin knows.
    helpKey: 'plugins.cred_zen_optional',
  }],
  ocPrefix: 'opencode',
  mdKey: 'opencode',
  // No public unauthenticated pulse endpoint that is distinct from the catalog;
  // the catalog URL answers 200 without a key, which is good enough as a pulse.
  pulse: { url: 'https://opencode.ai/zen/v1/models', okStatus: [200] },

  // NO `gate`, deliberately: Zen reports no balance (there is no `balance()`
  // below), so there is no number a gate could measure. A gate that can only
  // ever answer "no signal" would be a form field that does nothing — and the
  // budget gate already treats a provider without a gate as "draws on nothing
  // the hub can meter", which is the truth here.

  /**
   * Zen can answer the hub's own questions: it is an OpenAI-compatible endpoint
   * and the free models make it the cheapest source there is.
   *
   * `prompt` and not `json_object`: Zen is a proxy in front of many upstream
   * models and documents nothing about `response_format` — a mode that is
   * silently ignored is worse than one that was never claimed, because the
   * caller would then skip the strict prompt as well. Declaring `prompt` costs
   * a paragraph of instructions and works on every model behind it.
   */
  llm: {
    schema: 'prompt',
    async models(ctx) { return plugin.fetchModels(ctx) },
    async complete(ctx, req = {}) {
      const messages = []
      if (req.system) messages.push({ role: 'system', content: String(req.system) })
      messages.push({ role: 'user', content: String(req.prompt ?? '') })
      const key = apiKey(ctx)
      const headers = { 'content-type': 'application/json' }
      // A key is optional here — the free models answer without one.
      if (key) headers.Authorization = `Bearer ${key}`
      const j = await ctx.json('https://opencode.ai/zen/v1/chat/completions', headers, {
        method: 'POST',
        body: JSON.stringify({
          model: req.model,
          messages,
          temperature: req.temperature ?? 0,
          max_tokens: req.maxTokens ?? 1000,
        }),
        timeoutMs: req.timeoutMs ?? 60_000,
      })
      const raw = j?.choices?.[0]?.message?.content
      return {
        text: typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''),
        usage: j?.usage ?? null,
        raw: j,
      }
    },
  },

  /**
   * Vendor catalog: also contains models that will not run without a Zen key.
   * Filtering against what the local opencode accepts happens in models.mjs.
   */
  async fetchModels(ctx) {
    const meta = (await ctx.registry())?.opencode?.models ?? {}
    const j = await ctx.json('https://opencode.ai/zen/v1/models')
    return (j.data ?? []).map(m => ({
      id: m.id,
      name: meta[m.id]?.name ?? m.id,
      ctx: meta[m.id]?.limit?.context ?? null,
      tools: meta[m.id]?.tool_call !== false,
      frei: meta[m.id]?.cost?.input === 0 || m.id.endsWith('-free'),
    })).sort((a, b) => a.id.localeCompare(b.id))
  },
}

export default plugin
