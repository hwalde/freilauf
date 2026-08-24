// cc-hub — provider plugin: DeepSeek (direct API).
export default {
  id: 'deepseek',
  label: 'DeepSeek (direct)',
  envKeys: ['DEEPSEEK_API_KEY'],
  ocPrefix: 'deepseek',
  mdKey: 'deepseek',
  pulse: { url: 'https://api.deepseek.com/models', okStatus: [200, 401] },

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
