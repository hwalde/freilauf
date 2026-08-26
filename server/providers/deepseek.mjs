// cc-hub — provider plugin: DeepSeek (direct API).
export default {
  id: 'deepseek',
  label: 'DeepSeek (direct)',
  envKeys: ['DEEPSEEK_API_KEY'],
  ocPrefix: 'deepseek',
  mdKey: 'deepseek',
  pulse: { url: 'https://api.deepseek.com/models', okStatus: [200, 401] },

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
    const key = ctx.env.DEEPSEEK_API_KEY
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
    const key = ctx.env.DEEPSEEK_API_KEY
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
