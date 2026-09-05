// Freilauf — coding agent plugin: hermes.
//
// hermes is provider-based and DEMANDS a key for every provider ("No usable
// credentials found for provider 'opencode-zen'"). It validates nothing about
// effort levels and silently runs with the default on nonsense — the hub must
// therefore only offer levels that the model actually knows.
import { HTTP_5XX } from './patterns.mjs'
import { runCli, cliFailure } from './cli-llm.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// A model provider's descriptor — never through a static import.
// `../providers/index.mjs` re-exports the plugin registry, and the registry's
// module body builds `{claude, opencode, hermes, …}` out of THIS file:
// importing it up here makes this plugin unimportable on its own (measured:
// `ReferenceError: Cannot access 'hermes' before initialization`), which breaks
// the contract docs/plugins.md and cli-llm.mjs both state. Two ways to ask:
//
//   providerOf(ctx, id)     synchronous, so only the injected context can
//                           answer it; without a context the answer is null.
//   providerLate(ctx, id)   where an await is allowed: the context first, and
//                           otherwise the registry through a LAZY import, which
//                           resolves fine because by call time every module has
//                           finished evaluating.
const providerOf = (ctx, id) => ctx?.provider?.(id) ?? null

async function providerLate(ctx, id) {
  const p = providerOf(ctx, id)
  if (p) return p
  try { return (await import('../providers/index.mjs')).getProvider(id) } catch { return null }
}

const execFileAsync = promisify(execFile)

/** hermes' own session store; `FREILAUF_HERMES_STATE_DB` is the test fence. */
function hermesStateDb() {
  return process.env.FREILAUF_HERMES_STATE_DB || `${process.env.HOME}/.hermes/state.db`
}
/** hermes' own home, the way `setup/02-install-scripts.sh` resolves it. */
function hermesHome() {
  return process.env.HERMES_HOME || join(homedir(), '.hermes')
}

/**
 * Force `terminal.backend: local` in a COPY of the operator's hermes config
 * (SANDBOX_RESEARCH.md §3.3): inside the Freilauf sandbox the container IS the
 * boundary, and hermes' own docker backend would put a second container around
 * every terminal tool call — a nested runtime the agent must not be able to
 * reach in the first place.
 *
 * Line-based on purpose, exactly as `setup/02-install-scripts.sh` appends the
 * hooks block: `config.yaml` is the operator's file, full of comments, and a
 * YAML round-trip would flatten them. Any existing top-level `terminal:` key is
 * dropped and ours appended — this is a copy in the per-run home, so the
 * operator's own file is never touched and the worst case is a lost comment in
 * a file nobody reads.
 */
function forceLocalTerminal(yaml) {
  const kept = []
  let inTerminalBlock = false
  for (const line of String(yaml ?? '').split('\n')) {
    if (inTerminalBlock) {
      // A line starting at column 0 ends the block; an indented one is part of it.
      if (/^\S/.test(line)) inTerminalBlock = false
      else continue
    }
    const m = /^terminal\s*:(.*)$/.exec(line)
    if (m) {
      // `terminal:` with nothing but a comment after it opens a block.
      inTerminalBlock = /^\s*(#.*)?$/.test(m[1])
      continue
    }
    kept.push(line)
  }
  const body = kept.join('\n').replace(/\n*$/, '\n')
  return body
    + '\n# Freilauf sandbox: the container is the security boundary, so hermes runs its\n'
    + '# terminal tool calls in it rather than opening one of its own.\n'
    + 'terminal:\n  backend: local\n'
}

const flat = (t) => String(t ?? '').replace(/\s+/g, ' ')
const levelsFrom = (t) => t.split(/,|\bor\b/).map(x => x.trim().toLowerCase())
  .filter(x => /^[a-z]+$/.test(x))

const plugin = {
  id: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  installHint: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash   (then: hermes setup)',
  sessionTag: 'he-',         // tmux sessions: fl-he-<name>

  /**
   * How bin/fl-start calls this CLI (see claude.mjs for why the built-in `case`
   * in that script, not this block, is what a hermes run is launched from).
   * Note the effort flag: hermes calls the same thing `--reasoning`, which is
   * exactly the kind of per-CLI naming a declaration exists to carry.
   */
  launch: {
    promptMode: 'argv',
    // `--accept-hooks`: hermes runs the shell hooks in ~/.hermes/config.yaml
    // only after a one-time consent per (event, command), which it asks for at
    // the TTY — and a run in a tmux session has nobody at that TTY. The flag
    // records the consent for the hooks the operator configured (Freilauf's
    // own are installed by setup/02-install-scripts.sh, see `attention`).
    args: [
      'chat', '-q', '{prompt}', '--yolo', '--accept-hooks',
      { when: 'model', args: ['--model', '{model}'] },
      { when: 'provider', args: ['--provider', '{provider}'] },
      { when: 'effort', args: ['--reasoning', '{effort}'] },
    ],
    interactiveArgs: ['--yolo'],
    // The resume form (fl-start --resume, measured with hermes 0.21): `--resume
    // <id>` continues that session, `--in <workdir>` scopes 'latest' to the
    // worktree, `-q` is the next turn — and on a TTY it stays interactive
    // afterwards, like a fresh `-q` does since 0.21. Model and provider travel
    // along: a resumed session announces "model restored" and still called the
    // configured default without them (measured).
    resume: [
      'chat', '--in', '{workdir}', '--resume', '{resume_id}', '-q', '{prompt}', '--yolo', '--accept-hooks',
      { when: 'model', args: ['--model', '{model}'] },
      { when: 'provider', args: ['--provider', '{provider}'] },
      { when: 'effort', args: ['--reasoning', '{effort}'] },
    ],
  },

  /**
   * How the hub learns whether this agent works or waits (docs/plugins.md,
   * "Attention"). hermes has shell hooks in `~/.hermes/config.yaml` (`hooks:`,
   * a command per event, the event's JSON on stdin); setup/02 installs
   * `bin/fl-hermes-hook` under `pre_llm_call` and `on_session_end`. Measured
   * with hermes 0.21.0: `chat -q` on a TTY seeds an INTERACTIVE session and
   * stays at its prompt after the answer — which is where the operator types
   * the next instruction — and the two hooks fire once per turn, the first
   * turn and every typed one alike. The command must be a plain executable
   * with arguments: hermes splits it itself and runs no shell, so an
   * environment assignment in front of it is "command not found".
   */
  attention: { source: 'config', note: 'pre_llm_call → _working prompt, on_session_end → _turn_end (bin/fl-hermes-hook)' },

  subscription: false,
  providers: ['openrouter', 'opencode-zen', 'deepseek'],
  // hermes needs credentials for EVERY provider — measured, it refuses even the
  // free Zen models ("No usable credentials found for provider 'opencode-zen'").
  // An empty list here is therefore a statement and not an omission, and the
  // provider block on the Plugins page prints it as one: next to a coding agent
  // that brings none of its own, silence used to leave the reader guessing why
  // opencode said something about its keys and hermes did not.
  //
  // Deliberately NO `ownCredentials()`: hermes stores what `hermes setup` was
  // given, but nothing about that location has been measured here, and a
  // capability that guesses is worse than one that is absent — absent means
  // "ask the declaration", guessed means "the page states it as fact".
  keyFreeProviders: [],

  /**
   * Where hermes looks for agent skills. Measured on the installed CLI rather
   * than guessed: `hermes skills trust --help` names the repo-local tiers
   * (`./.hermes/skills`, `./.agents/skills`, and only for a trusted checkout),
   * and its configuration defaults document `~/.hermes/skills/` as the one
   * user-level root — `skills.external_dirs` is empty out of the box.
   *
   * hermes is deliberately the coding agent that does NOT read
   * `~/.claude/skills`, which is why a machine running all four ends up with
   * two target directories instead of one. Nothing here is a fallback: an
   * undeclared directory would be a guess, and this plugin already refuses to
   * guess elsewhere (`ownCredentials`).
   */
  skills: {
    user: ['~/.hermes/skills'],
    project: ['.hermes/skills', '.agents/skills'],
  },

  /**
   * Running hermes inside the Freilauf sandbox (docs/plugins.md, "The sandbox
   * declaration"; SANDBOX_RESEARCH.md §3.3 and §7.9).
   *
   * hermes brings the most prior art of the four — a docker backend with a
   * measured hardening flag set and an iron-proxy egress firewall — but all of
   * it is for its TOOL CALLS, not for itself: the hermes process stays on the
   * host and holds the credentials. So for the generic layer hermes is a
   * process like any other, and the one thing that has to change is that it
   * stops opening containers of its own (see `seedHome` below).
   */
  sandbox: {
    supported: true,

    // Version pin: measured on this machine (AGENTS.md, hermes 0.21.0).
    image: { dockerfile: 'sandbox/images/hermes.Dockerfile', args: { HERMES_VERSION: '0.21.0' } },

    // hermes has no API of its own the way claude and cursor do — its model
    // traffic goes to whichever provider the run picked, which is the
    // `provider` preset's job. What is left is its own inference host.
    domains: ['inference.nousresearch.com'],

    env: { DO_NOT_TRACK: '1' },

    // What the hub reads back: `state.db` is where the watcher reads this run's
    // tokens and where `resumeId()` finds the session `--resume` continues.
    stateDirs: ['.hermes'],

    /**
     * The per-run home: hermes' config and its `.env`, both copied from the
     * operator's `~/.hermes`.
     *
     * The config is copied rather than written, because it is what carries the
     * `hooks:` block `setup/02-install-scripts.sh` appended — without it a
     * sandboxed hermes run never says whether it is working or waiting for a
     * human. `terminal.backend` is the one statement in it the sandbox
     * overrules.
     *
     * `SOUL.md` / `AGENTS.md` are named in §7.7 as things an operator may want
     * along; there is no setting that says so today, and copying a personality
     * file into every run because it happens to lie in the home is exactly the
     * opt-in the `~/agents/zusaetze/` idea exists to avoid.
     */
    seedHome({ spec = {} } = {}) {
      const files = []
      const home = hermesHome()
      try {
        files.push({ path: '.hermes/config.yaml', content: forceLocalTerminal(readFileSync(join(home, 'config.yaml'), 'utf8')) })
      } catch {
        // No config on the host: still say which backend this run uses, because
        // that is a statement about the sandbox and not about the operator.
        files.push({ path: '.hermes/config.yaml', content: forceLocalTerminal('') })
      }
      if (spec.secrets?.mode !== 'inject') {
        try {
          files.push({ path: '.hermes/.env', content: readFileSync(join(home, '.env'), 'utf8'), mode: 0o600 })
        } catch { /* no .env — the provider key reaches the run as a variable */ }
      }
      return files
    },
  },

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
        const prov = await providerLate(ctx, id)
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
   * CLI arguments for fl-start. hermes separates both: model bare (or
   * author/slug), provider as an own argument. fl-start translates --effort
   * into hermes' --reasoning.
   */
  /**
   * The session hermes continues with. It used to be "none": nothing handed
   * an id out at start. But hermes writes every session into
   * `~/.hermes/state.db` (`sessions`: `id`, `cwd`, `started_at` as unix
   * seconds, `parent_session_id`) — the same table the watcher already reads
   * for tokens — and a run works in a worktree of its own, so the newest
   * parentless session in that directory, started with this run, IS the run's.
   * Measured with 0.21: `hermes chat --resume <that id> -q "…"` answered the
   * code word from the first turn. Without a row: `'latest'`, which hermes
   * scopes to the workspace `--in` names — the same answer, looked up by
   * hermes instead of by us. `null` never: hermes always has a workspace.
   */
  resumeId(run) {
    if (!run?.workdir_effective) return null
    try {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
      const d = new DatabaseSync(hermesStateDb(), { readOnly: true })
      try {
        const since = run.started_at ? Date.parse(String(run.started_at).replace(' ', 'T') + 'Z') / 1000 - 5 : 0
        const row = d.prepare(`SELECT id FROM sessions WHERE cwd = ? AND started_at >= ? AND parent_session_id IS NULL
                               ORDER BY started_at DESC LIMIT 1`).get(run.workdir_effective, Number.isFinite(since) ? since : 0)
        if (row?.id) return String(row.id)
      } finally { d.close() }
    } catch { /* no store, no answer — 'latest' is still right */ }
    return 'latest'
  },

  /** What a human types to continue this run's session — the same lookup, as a command. */
  resumeCommand(run) {
    if (!run?.workdir_effective) return null
    const id = this.resumeId(run) ?? 'latest'
    return `cd ${run.workdir_effective} && hermes chat --in ${run.workdir_effective} --resume ${id}`
  },

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
    // (`ctx.secret()`, server/plugins/store.mjs). It travels as `--env` because
    // a tmux session inherits nothing; the NAME stays whichever declared
    // variable the environment already holds, so hermes keeps reading the one
    // it knows.
    //
    // This function is SYNCHRONOUS, so the lazy import the async paths use is
    // not available here: without a context there is no descriptor and hence no
    // declared variable names, and no key travels. `runner.mjs` — the only
    // caller that launches a run — always passes one; a one-argument call is a
    // plugin author probing the descriptor, and it must answer rather than throw.
    const prov = providerOf(ctx, run.provider)
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
