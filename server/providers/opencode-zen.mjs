// cc-hub — provider plugin: OpenCode Zen.
//
// Pitfall: opencode addresses Zen with the model prefix 'opencode' — NOT
// 'opencode-zen' (the docs say otherwise, but `opencode models --pure` is the
// authority).
export default {
  id: 'opencode-zen',
  label: 'OpenCode Zen',
  envKeys: ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
  ocPrefix: 'opencode',
  mdKey: 'opencode',
  // No public unauthenticated pulse endpoint that is distinct from the catalog;
  // the catalog URL answers 200 without a key, which is good enough as a pulse.
  pulse: { url: 'https://opencode.ai/zen/v1/models', okStatus: [200] },

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
