// cc-hub — coding agent plugin: hermes.
//
// hermes is provider-based and DEMANDS a key for every provider ("No usable
// credentials found for provider 'opencode-zen'"). It validates nothing about
// effort levels and silently runs with the default on nonsense — the hub must
// therefore only offer levels that the model actually knows.
import { getProvider } from '../providers/index.mjs'
import { HTTP_5XX } from './patterns.mjs'
import { runCli, cliFailure } from './cli-llm.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const flat = (t) => String(t ?? '').replace(/\s+/g, ' ')
const levelsFrom = (t) => t.split(/,|\bor\b/).map(x => x.trim().toLowerCase())
  .filter(x => /^[a-z]+$/.test(x))

const plugin = {
  id: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  installHint: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash   (then: hermes setup)',
  sessionTag: 'he-',         // tmux sessions: cc-he-<name>

  /**
   * How bin/cc-start calls this CLI (see claude.mjs for why the built-in `case`
   * in that script, not this block, is what a hermes run is launched from).
   * Note the effort flag: hermes calls the same thing `--reasoning`, which is
   * exactly the kind of per-CLI naming a declaration exists to carry.
   */
  launch: {
    promptMode: 'argv',
    args: [
      'chat', '-q', '{prompt}', '--yolo',
      { when: 'model', args: ['--model', '{model}'] },
      { when: 'provider', args: ['--provider', '{provider}'] },
      { when: 'effort', args: ['--reasoning', '{effort}'] },
    ],
    interactiveArgs: ['--yolo'],
  },

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

  /**
   * hermes can answer the hub's own small questions, on the providers it is
   * configured for. Its model reference is `provider/model`, so — like
   * opencode's — the id already carries the provider and there is no second
   * field to fill in.
   *
   * `schema: 'prompt'`: hermes takes no schema. The three muzzle flags below
   * are all load-bearing, and that was measured rather than assumed — without
   * them stdout came back as 4420 bytes of a boxed reasoning block, because
   * hermes' own system prompt mandates tool use even for arithmetic.
   */
  llm: {
    schema: 'prompt',
    overhead: true,

    /**
     * hermes has no model list of its own, so the catalog every other consumer
     * of it uses answers instead — models.dev, narrowed to the providers this
     * coding agent can address at all, in hermes' own `provider/model` shape.
     */
    async models(ctx) {
      const reg = (await ctx.registry()) ?? {}
      const out = []
      for (const id of plugin.providers) {
        const prov = getProvider(id)
        const models = reg?.[prov?.mdKey ?? id]?.models ?? {}
        for (const [model, m] of Object.entries(models)) {
          out.push({ id: `${id}/${model}`, name: `${prov?.label ?? id}: ${m?.name ?? model}` })
        }
      }
      return out.sort((a, b) => a.id.localeCompare(b.id))
    },

    async complete(ctx, req = {}) {
      const prompt = req.system ? `${req.system}\n\n${req.prompt ?? ''}` : String(req.prompt ?? '')
      // The prompt goes on stdin (`--query-file -`); -Q is the quiet one-shot,
      // and --safe-mode / --reasoning none / -t '' are what stop it reasoning
      // and reaching for tools it does not need here.
      const args = ['chat', '--query-file', '-', '-Q', '--safe-mode', '--reasoning', 'none', '-t', '']
      if (req.model) args.push('-m', String(req.model))
      args.push('--run-budget', '120')
      const r = await runCli('hermes', args, { stdin: prompt, timeoutMs: req.timeoutMs ?? 180_000 })
      // hermes reports its failures on STDOUT as plain text, so there is no
      // envelope to inspect: the exit code is the only signal, and the raw
      // stdout is the answer.
      if (r.code !== 0) throw cliFailure('hermes', r)
      return { text: r.stdout.trim(), usage: null, raw: r.stdout }
    },
  },

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

  modelArgs(run, ctx = null) {
    const args = []
    const fehlt = []
    if (!run.model) return { args, fehlt }
    if (!run.provider) {
      args.push('--model', run.model)
      return { args, fehlt }
    }
    args.push('--model', run.model, '--provider', run.provider)
    if (run.effort) args.push('--effort', run.effort)
    // The credential, resolved the way the operator configured it — a stored
    // value, a variable they named, or the provider's own declared one
    // (`ctx.secret()`, server/plugins/store.mjs). Without a context this is the
    // plain environment read it always was. It travels as `--env` because a
    // tmux session inherits nothing; the NAME stays whichever declared variable
    // the environment already holds, so hermes keeps reading the one it knows.
    const prov = getProvider(run.provider)
    const key = ctx?.secret?.('api_key') || (prov?.envKeys ?? []).map(n => process.env[n]).find(Boolean) || null
    if (key) {
      const names = prov?.envKeys ?? []
      const set = names.filter(n => process.env[n])
      for (const name of (set.length ? set : names)) args.push('--env', `${name}=${key}`)
    }
    // hermes demands credentials for every provider — there is no key-free one.
    if (!key) fehlt.push(run.provider)
    return { args, fehlt }
  },

  async usage() { return null },
}

export default plugin
