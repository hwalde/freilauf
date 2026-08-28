// cc-hub — coding agent plugin: hermes.
//
// hermes is provider-based and DEMANDS a key for every provider ("No usable
// credentials found for provider 'opencode-zen'"). It validates nothing about
// effort levels and silently runs with the default on nonsense — the hub must
// therefore only offer levels that the model actually knows.
import { getProvider } from '../providers/index.mjs'
import { HTTP_5XX } from './patterns.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const flat = (t) => String(t ?? '').replace(/\s+/g, ' ')
const levelsFrom = (t) => t.split(/,|\bor\b/).map(x => x.trim().toLowerCase())
  .filter(x => /^[a-z]+$/.test(x))

export default {
  id: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  installHint: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash   (then: hermes setup)',
  sessionTag: 'he-',         // tmux sessions: cc-he-<name>

  subscription: false,
  providers: ['openrouter', 'opencode-zen', 'deepseek'],
  keyFreeProviders: [],      // hermes needs credentials for every provider

  pulseId: (run) => run.provider ?? null,
  pulseTargets: {},

  logPatterns: [
    // hermes (conversation_loop.py): "⏳ Retrying in 12.0s (rate limited by upstream provider (429))..."
    //                                "⚠️  API call failed (attempt 2/5): RateLimitError (HTTP 429)"
    { typ: 'rate_limit', re: /rate.?limited|rate limit|\b429\b|RateLimitError/i },
    { typ: 'auth_error', re: /AuthenticationError|\b(401|403)\b|invalid api key/i },
    { typ: 'billing_error', re: /\b402\b|insufficient|billing/i },
    { typ: 'provider_error', re: new RegExp(`API call failed|Retrying in .*\\(|overloaded|${HTTP_5XX.source}|APIConnectionError|InternalServerError|ServiceUnavailable`, 'i') },
  ],

  /** hermes names its levels only in the help text for --reasoning; there is no other source. */
  async effortLevels() {
    const { stdout } = await execFileAsync('hermes', ['chat', '--help'], { timeout: 20_000 })
    const m = flat(stdout).match(/--reasoning LEVEL Reasoning effort for this session:\s*([^.]+)\./)
    return m ? levelsFrom(m[1]) : null
  },

  /**
   * hermes checks nothing, so its levels are intersected with what the model
   * can do. 'none' only when the provider does not make reasoning mandatory —
   * otherwise OpenRouter answers "Reasoning is mandatory for this endpoint".
   */
  async effortOptions({ provider, model, helpers }) {
    if (!provider || !model) return { stufen: null, hinweisKey: 'effort.select_first' }
    const own = await helpers.ownLevels()
    if (!own) return { stufen: null, hinweisKey: 'effort.no_levels_cli' }
    const modelInfo = provider === 'openrouter'
      ? await helpers.openrouterEffort(model)
      : await helpers.registryEffort(provider, model)
    if (!modelInfo) return { stufen: null, hinweisKey: 'effort.model_unknown' }
    const cut = own.filter(x => modelInfo.stufen.includes(x))
    if (!modelInfo.pflicht && own.includes('none')) cut.unshift('none')
    return cut.length
      ? { stufen: cut, standard: modelInfo.standard ?? null, pflicht: modelInfo.pflicht,
          quelle: 'openrouter', hinweisKey: 'effort.intersection' }
      : { stufen: null, hinweisKey: 'effort.no_common' }
  },

  /**
   * CLI arguments for cc-start. hermes separates both: model bare (or
   * author/slug), provider as an own argument. cc-start translates --effort
   * into hermes' --reasoning.
   */
  /**
   * No resume command. `hermes --resume SESSION` wants a session name the hub
   * never learns (nothing hands one out at start), and `--continue` without a
   * name is not documented as "the session of this directory" — offering a
   * command that opens somebody else's conversation is worse than offering none.
   * The escalation messages then name the worktree instead.
   */
  resumeCommand() { return null },

  modelArgs(run) {
    const args = []
    const fehlt = []
    if (!run.model) return { args, fehlt }
    if (!run.provider) {
      args.push('--model', run.model)
      return { args, fehlt }
    }
    args.push('--model', run.model, '--provider', run.provider)
    if (run.effort) args.push('--effort', run.effort)
    const plugin = getProvider(run.provider)
    for (const name of plugin?.envKeys ?? []) {
      if (process.env[name]) args.push('--env', `${name}=${process.env[name]}`)
    }
    if (!(plugin?.envKeys ?? []).some(n => process.env[n])) fehlt.push(run.provider)
    return { args, fehlt }
  },

  async usage() { return null },
}
