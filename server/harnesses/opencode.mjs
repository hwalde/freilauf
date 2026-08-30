// Freilauf — coding agent plugin: opencode.
//
// opencode is provider-based: it knows Zen (free models even without a key),
// DeepSeek (bundled access, measured: a run on deepseek/deepseek-v4-flash goes
// through without an own key) and OpenRouter (needs a key). Effort is passed
// via OPENCODE_CONFIG_CONTENT with agent.build.{model,variant} — the variant
// only takes effect when the model is set in the SAME block.
import { getProvider } from '../providers/index.mjs'
import { HTTP_5XX } from './patterns.mjs'
import { runCli, cliFailure, cliLines, ndjson } from './cli-llm.mjs'

// The default agent of opencode; the model/variant choice lives under this key.
// 'opencode debug config' has no own entry here, the status line shows "Build".
const OC_AGENT = 'build'

const plugin = {
  id: 'opencode',
  label: 'opencode',
  bin: 'opencode',
  installHint: 'npm install -g opencode-ai   (or: curl -fsSL https://opencode.ai/install | bash)',
  sessionTag: 'oc-',         // tmux sessions: fl-oc-<name>

  /**
   * How bin/fl-start calls this CLI (see claude.mjs for why the built-in `case`
   * in that script, not this block, is what an opencode run is launched from).
   *
   * Two things here are not decoration. `stderrLog`: opencode writes the MCP
   * servers' schema warnings ("unknown format … ignored") to stderr, right into
   * the TUI, which wrecks the display — so stderr goes to a file and real
   * errors are still findable. `submitNudge`: `opencode --prompt` puts the text
   * into the editor and only sends it off by itself up to a certain length
   * (measured with 1.18.23: ~2 KB goes, ~20 KB stays put), and a real hub
   * prompt is past that. Enter on an empty editor is a no-op there, so the
   * nudge cannot harm the case that sent itself.
   */
  launch: {
    promptMode: 'argv',
    args: ['--auto', { when: 'model', args: ['--model', '{model}'] }, '--prompt', '{prompt}'],
    interactiveArgs: ['--auto'],
    stderrLog: '{home}/.local/share/opencode/log/{session}-stderr.log',
    submitNudge: { waitFor: 'ctrl+p', timeoutSec: 90 },
  },

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
    { typ: 'provider_error', re: new RegExp(`AI_APICallError|AI_RetryError|ProviderError|stream error|${HTTP_5XX.source}|overloaded|no endpoints|unavailable`, 'i') },
  ],

  /**
   * opencode can answer the hub's own small questions — on the providers the
   * operator has already configured for it, which is what makes its model ids
   * self-describing: `anthropic/claude-…`, `openrouter/…`. There is therefore
   * no second "which provider" field anywhere; the id carries it.
   *
   * `schema: 'prompt'` — opencode takes no schema and no system-prompt flag, so
   * the strict instructions come from server/llm and the system text is folded
   * into the prompt. One measured limit worth knowing: opencode has a hard
   * input floor of about 30 k tokens per call, so only free or cheap models
   * make sense here.
   */
  llm: {
    schema: 'prompt',
    overhead: true,

    /** `opencode models --pure` — the same source the run form uses, and the same
     * detour through a file, because a pipe loses lines at process exit. */
    async models() {
      return (await cliLines('opencode models --pure')).map(id => ({ id, name: id }))
    },

    async complete(ctx, req = {}) {
      const prompt = req.system ? `${req.system}\n\n${req.prompt ?? ''}` : String(req.prompt ?? '')
      const args = ['run', '--pure', '--format', 'json']
      if (req.model) args.push('-m', String(req.model))
      args.push(prompt)
      const r = await runCli('opencode', args, { timeoutMs: req.timeoutMs ?? 180_000 })
      // stderr is IGNORED here on purpose: opencode writes dozens of "unknown
      // format uint64" lines on every single run, and treating that as failure
      // would mean this source never works at all.
      const events = ndjson(r.stdout)
      const failure = events.find(e => e?.type === 'error')
      if (r.code !== 0 || failure) {
        throw cliFailure('opencode', r, failure ? JSON.stringify(failure).slice(0, 400) : null)
      }
      // The answer is every text part of the streamed message, in order.
      let text = ''
      for (const e of events) {
        if (e?.part?.type === 'text' && typeof e.part.text === 'string') text += e.part.text
        else if (e?.type === 'text' && typeof e.text === 'string') text += e.text
        else if (Array.isArray(e?.parts)) {
          for (const p of e.parts) if (p?.type === 'text' && typeof p.text === 'string') text += p.text
        }
      }
      return { text, usage: null, raw: events }
    },
  },

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
   * CLI arguments for fl-start. opencode addresses the provider via a prefix on
   * the model; effort and serving-provider pinning both travel in ONE merged
   * OPENCODE_CONFIG_CONTENT (global plugins and MCP servers survive that).
   */
  /**
   * `opencode --continue` continues the LAST session of the directory it is
   * started in (`-c, --continue  continue the last session`, opencode 1.18.23).
   * Every run works in a worktree of its own, so that last session is this run's
   * — no id to look up.
   */
  resumeCommand(run) {
    return run?.workdir_effective ? `cd ${run.workdir_effective} && opencode --continue` : null
  },

  modelArgs(run, ctx = null) {
    const args = []
    const fehlt = []
    if (!run.model) return { args, fehlt }
    if (!run.provider) {
      // Legacy rows: 'model' is the complete, hand-typed string.
      args.push('--model', run.model)
      return { args, fehlt }
    }
    const prov = getProvider(run.provider)
    args.push('--model', `${prov?.ocPrefix ?? run.provider}/${run.model}`)

    // The credential, resolved the way the OPERATOR configured it: a value
    // stored for the provider, an environment variable they named for it, or
    // the provider's own declared variable — `ctx.secret()` answers all three
    // in that order (server/plugins/store.mjs). Without a context this falls
    // back to the plain environment read, which is what the unit suite passes.
    //
    // It has to travel as `--env` because a tmux session inherits nothing: a
    // name that is not passed here does not exist over there. Under WHICH name
    // is decided by what the environment already holds, so the agent inside the
    // session keeps reading the variable it knows; only a credential that comes
    // from nowhere else goes out under every name the provider declares.
    const key = ctx?.secret?.('api_key') || (prov?.envKeys ?? []).map(n => process.env[n]).find(Boolean) || null
    if (key) {
      const names = prov?.envKeys ?? []
      const set = names.filter(n => process.env[n])
      for (const name of (set.length ? set : names)) args.push('--env', `${name}=${key}`)
    }
    const needsKey = !plugin.keyFreeProviders.includes(run.provider)
    if (needsKey && !key) fehlt.push(run.provider)

    const cfg = {}
    // Pin the serving provider (OpenRouter routing).
    if (run.or_provider && run.provider === 'openrouter') {
      cfg.provider = { openrouter: { models: { [run.model]: { options: {
        provider: { order: [run.or_provider], allow_fallbacks: false },
      } } } } }
    }
    // Effort: '--variant' exists only for 'opencode run', fl-start launches the
    // TUI. The way in is agent.<default>.variant — and it only works when the
    // model is set in the same block (measured: --model alone is not enough).
    if (run.effort) {
      cfg.agent = { [OC_AGENT]: { model: `${prov?.ocPrefix ?? run.provider}/${run.model}`, variant: run.effort } }
    }
    if (Object.keys(cfg).length) args.push('--env', 'OPENCODE_CONFIG_CONTENT=' + JSON.stringify(cfg))
    return { args, fehlt }
  },

  // No subscription — usage is tracked per provider (e.g. OpenRouter credits).
  async usage() { return null },
}

export default plugin
