// cc-hub — coding agent plugin: opencode.
//
// opencode is provider-based: it knows Zen (free models even without a key),
// DeepSeek (bundled access, measured: a run on deepseek/deepseek-v4-flash goes
// through without an own key) and OpenRouter (needs a key). Effort is passed
// via OPENCODE_CONFIG_CONTENT with agent.build.{model,variant} — the variant
// only takes effect when the model is set in the SAME block.
import { getProvider } from '../providers/index.mjs'

// The default agent of opencode; the model/variant choice lives under this key.
// 'opencode debug config' has no own entry here, the status line shows "Build".
const OC_AGENT = 'build'

export default {
  id: 'opencode',
  label: 'opencode',
  bin: 'opencode',
  installHint: 'npm install -g opencode-ai   (or: curl -fsSL https://opencode.ai/install | bash)',
  sessionTag: 'oc-',         // tmux sessions: cc-oc-<name>

  subscription: false,
  providers: ['opencode-zen', 'deepseek', 'openrouter'],
  // Providers that work WITHOUT an own key: opencode brings its own access for
  // DeepSeek and the free Zen models (measured — both runs went through).
  // Warning without a key would be a false alarm there.
  keyFreeProviders: ['opencode-zen', 'deepseek'],

  pulseId: (run) => run.provider ?? null,
  pulseTargets: {},

  logPatterns: [
    // opencode: AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.
    { typ: 'rate_limit', re: /rate.?limited|rate limit|\b429\b|too many requests/i },
    { typ: 'auth_error', re: /\b(401|403)\b|unauthori[sz]ed|invalid api key|authentication/i },
    { typ: 'billing_error', re: /\b402\b|insufficient credits|credit balance/i },
    { typ: 'provider_error', re: /AI_APICallError|AI_RetryError|ProviderError|stream error|\b5\d\d\b|overloaded|no endpoints|unavailable/i },
  ],

  /**
   * Effort options: only the catalog counts — a variant opencode does not know
   * is silently discarded, so nothing else may be offered.
   */
  async effortOptions({ provider, model, helpers }) {
    if (!provider || !model) return { stufen: null, hinweisKey: 'effort.select_first' }
    const r = await helpers.registryEffort(provider, model)
    return r
      ? { ...r, quelle: 'registry', hinweisKey: 'effort.registry_only' }
      : { stufen: null, hinweisKey: 'effort.none_in_catalog' }
  },

  /**
   * CLI arguments for cc-start. opencode addresses the provider via a prefix on
   * the model; effort and serving-provider pinning both travel in ONE merged
   * OPENCODE_CONFIG_CONTENT (global plugins and MCP servers survive that).
   */
  modelArgs(run) {
    const args = []
    const fehlt = []
    if (!run.model) return { args, fehlt }
    if (!run.provider) {
      // Legacy rows: 'model' is the complete, hand-typed string.
      args.push('--model', run.model)
      return { args, fehlt }
    }
    const plugin = getProvider(run.provider)
    args.push('--model', `${plugin?.ocPrefix ?? run.provider}/${run.model}`)

    for (const name of plugin?.envKeys ?? []) {
      if (process.env[name]) args.push('--env', `${name}=${process.env[name]}`)
    }
    const needsKey = !this.keyFreeProviders.includes(run.provider)
    if (needsKey && !(plugin?.envKeys ?? []).some(n => process.env[n])) fehlt.push(run.provider)

    const cfg = {}
    // Pin the serving provider (OpenRouter routing).
    if (run.or_provider && run.provider === 'openrouter') {
      cfg.provider = { openrouter: { models: { [run.model]: { options: {
        provider: { order: [run.or_provider], allow_fallbacks: false },
      } } } } }
    }
    // Effort: '--variant' exists only for 'opencode run', cc-start launches the
    // TUI. The way in is agent.<default>.variant — and it only works when the
    // model is set in the same block (measured: --model alone is not enough).
    if (run.effort) {
      cfg.agent = { [OC_AGENT]: { model: `${plugin?.ocPrefix ?? run.provider}/${run.model}`, variant: run.effort } }
    }
    if (Object.keys(cfg).length) args.push('--env', 'OPENCODE_CONFIG_CONTENT=' + JSON.stringify(cfg))
    return { args, fehlt }
  },

  // No subscription — usage is tracked per provider (e.g. OpenRouter credits).
  async usage() { return null },
}
