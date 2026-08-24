// cc-hub — provider plugin: OpenRouter.
export default {
  id: 'openrouter',
  label: 'OpenRouter',

  // Env vars that hold a credential for this provider. The hub passes them into
  // the agent's tmux session via `cc-start --env` (tmux does NOT inherit the
  // environment) and uses them to decide whether the provider can be offered.
  envKeys: ['OPENROUTER_API_KEY'],

  // Model prefix opencode uses to address this provider (`openrouter/author/slug`).
  ocPrefix: 'openrouter',

  // Key of this provider in the models.dev registry (used for effort levels).
  mdKey: 'openrouter',

  // Health pulse target (watcher checks it while runs use this provider).
  pulse: { url: 'https://openrouter.ai/api/v1/models', okStatus: [200] },

  /**
   * Model catalog. `ctx` provides { json } — a fetch helper with timeout.
   * Tool support and reasoning metadata are read from the catalog itself:
   * the `reasoning` field (NOT supported_parameters) carries the allowed effort
   * levels and whether reasoning is mandatory for the model.
   */
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
