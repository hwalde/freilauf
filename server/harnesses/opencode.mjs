// Freilauf — coding agent plugin: opencode.
//
// opencode is provider-based: it knows Zen (free models even without a key),
// DeepSeek (bundled access, measured: a run on deepseek/deepseek-v4-flash goes
// through without an own key) and OpenRouter (needs a key). Effort is passed
// via OPENCODE_CONFIG_CONTENT with agent.build.{model,variant} — the variant
// only takes effect when the model is set in the SAME block.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HTTP_5XX } from './patterns.mjs'
import { runCli, cliFailure, cliLines, ndjson } from './cli-llm.mjs'
import { quantizationsFrom } from '../providers/openrouter-routing.mjs'

// A model provider's descriptor — never through a static import.
// `../providers/index.mjs` re-exports the plugin registry, and the registry's
// module body builds `{claude, opencode, …}` out of THIS file: importing it up
// here makes this plugin unimportable on its own (measured: `ReferenceError:
// Cannot access 'opencode' before initialization`), which breaks the contract
// docs/plugins.md and cli-llm.mjs both state. Two ways to ask instead:
//
//   providerOf(ctx, id)       synchronous, so only the injected context can
//                             answer it. Without a context the answer is null
//                             and the caller falls back to the provider id.
//   providerLate(ctx, id)     where an await is allowed: the context first, and
//                             otherwise the registry through a LAZY import,
//                             which resolves fine because by call time every
//                             module has evaluated.
const providerOf = (ctx, id) => ctx?.provider?.(id) ?? null

async function providerLate(ctx, id) {
  const p = providerOf(ctx, id)
  if (p) return p
  try { return (await import('../providers/index.mjs')).getProvider(id) } catch { return null }
}

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
    // Above this the TASK is written into the worktree and the CLI is launched
    // with the platform's framing plus a pointer at that file
    // (`offloadPrompt()` in runner.mjs). The nudge above is the same problem's
    // first answer and it is not enough on its own: measured 2026-09-04, a
    // 13.5 KB prompt left opencode without a session at all — initialised,
    // never asked anything, tmux session standing, hub saying `running`.
    //
    // 4000 bytes, and the number is a measurement rather than a taste. The
    // platform framing alone is ~3 KB, so this offloads exactly the runs whose
    // TASK is big enough to be worth a file, and leaves the small ones — the
    // ones opencode submits by itself (~2 KB measured) — untouched. Across the
    // 297 prompts on this machine the median is 4.2 KB and the 90th percentile
    // 13.6 KB: the long tail is the real population here, not an outlier.
    promptFile: { maxBytes: 4000 },
    // The resume form (fl-start --resume): `--session <id>` continues the
    // run's ROOT session (resumeId below reads it out of the store), and the
    // prompt goes in as the next turn exactly as at a fresh start. fl-start
    // maps the id 'last' to `--continue` — the last session of the worktree.
    resume: ['--auto', { when: 'model', args: ['--model', '{model}'] }, '--session', '{resume_id}', '--prompt', '{prompt}'],
  },

  subscription: false,
  providers: ['opencode-zen', 'deepseek', 'openrouter'],
  // Providers that work WITHOUT an own key: opencode brings its own access for
  // DeepSeek and the free Zen models (measured — both runs went through).
  // Warning without a key would be a false alarm there.
  //
  // This list is a DECLARATION, and it is only the fallback: what opencode
  // really holds is asked of opencode itself in `ownCredentials()` below. The
  // list stays because it is what `modelArgs()` decides "this run is missing a
  // key" on, on the launch path, where nothing may be probed.
  keyFreeProviders: ['opencode-zen', 'deepseek'],

  /**
   * Which model providers has opencode ITSELF been given credentials for?
   *
   * The hub used to answer this out of `keyFreeProviders` alone and print
   * "works without an own key" next to a provider — a guess, and one that reads
   * like a fault report rather than an answer. opencode knows the truth, so it
   * is asked.
   *
   * **The credential store is read, not `opencode auth list`.** Both were
   * measured. The command prints a boxed TUI listing with the vendors' DISPLAY
   * names ("DeepSeek") and ANSI colour codes around them, so using it would mean
   * matching prose back onto provider ids and re-doing that on every wording
   * change; it also costs a process. The file is keyed by opencode's own
   * provider id — exactly what `ocPrefix` already maps onto — so the mapping is
   * the one the rest of this plugin uses anyway. The price is that the path is
   * opencode's internal one, which is why every failure here is `null`:
   *
   *   null      the question could not be answered (no file, no permission, a
   *             shape this code does not recognise). The caller falls back to
   *             `keyFreeProviders` and NEVER renders "unknown" as a claim.
   *   []        opencode was asked and holds no credentials at all.
   *   [ids…]    the providers of THIS plugin opencode has its own access data
   *             for.
   *
   * Only ids and nothing else leave this function. The file holds the keys
   * themselves; a value must never travel towards a page.
   */
  async ownCredentials(ctx = null) {
    const env = ctx?.env ?? process.env
    const base = env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share')
    let raw
    try {
      raw = JSON.parse(readFileSync(join(base, 'opencode', 'auth.json'), 'utf8'))
    } catch {
      return null      // not installed, never logged in, unreadable — unknown
    }
    // A shape that is not "provider id → entry" is a version this code does not
    // know. Answering "nothing configured" for it would be a confident lie.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const out = []
    for (const id of plugin.providers) {
      const entry = raw[(await providerLate(ctx, id))?.ocPrefix ?? id]
      if (entry && typeof entry === 'object') out.push(id)
    }
    return out
  },

  /**
   * Where opencode looks for agent skills. Its own configuration table (in the
   * binary, and on opencode.ai/docs/skills) names three tiers: global skills
   * under `~/.config/opencode/skill(s)/`, project skills under
   * `.opencode/skill(s)/`, and — the row that matters here — "External skills
   * (auto-loaded)" from `~/.claude/skills/` and `~/.agents/skills/`.
   *
   * So a copy in `~/.claude/skills` serves claude, cursor AND opencode, which
   * is what makes the covering set two directories rather than four. Its own
   * directory still comes first: preference is the tie-break when coverage
   * does not decide.
   */
  skills: {
    user: ['~/.config/opencode/skill', '~/.claude/skills', '~/.agents/skills'],
    project: ['.opencode/skill', '.claude/skills', '.agents/skills'],
  },

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

  /**
   * The session id the hub resumes with (runner.mjs, resumeRun): the run's
   * ROOT session out of opencode's store — a run is a session tree, and "the
   * last session of the directory" is usually a finished subagent (see
   * server/opencode-store.mjs). 'last' when the store cannot say: fl-start
   * turns that into `--continue`, which is what resumeCommand() offers a human.
   * Lazy import — the plugin rule (docs/plugins.md): hub modules are reached
   * inside the function that needs them.
   */
  async resumeId(run) {
    const { rootSessionId } = await import('../opencode-store.mjs')
    return (await rootSessionId(run)) ?? 'last'
  },

  modelArgs(run, ctx = null, opts = null) {
    const args = []
    const fehlt = []
    const cfg = {}

    // The directories outside the worktree that Freilauf pointed this agent at
    // (runner.mjs, runExternalDirs). opencode 1.18.27 asks `external_directory`
    // for every path it has to leave the working directory for — and `--auto`
    // REFUSES that question rather than approving it, which is the one place
    // where "approves everything not explicitly denied" stops being true. The
    // run directory is where the platform prompt sends every agent to write its
    // report, so without this block an opencode run cannot finish at all: it
    // stands in its TUI at `0 tokens` until a human closes it.
    //
    // Written as `<dir>/*` because that is the shape opencode itself asks with,
    // and merged by opencode into its own defaults rather than replacing them.
    // It is deliberately NOT `"*": "allow"`: what this hub laid out for the run
    // is exactly what the run may reach, and everything else still asks.
    const extern = {}
    for (const dir of opts?.externalDirs ?? []) extern[join(dir, '*')] = 'allow'
    if (Object.keys(extern).length) cfg.permission = { external_directory: extern }

    // One exit, because the permission block belongs to EVERY opencode run —
    // also the two that leave early below. A run without a model, or a legacy
    // row carrying a hand-typed one, needs to write its report just as much.
    const fertig = () => {
      if (Object.keys(cfg).length) args.push('--env', 'OPENCODE_CONFIG_CONTENT=' + JSON.stringify(cfg))
      return { args, fehlt }
    }

    if (!run.model) return fertig()
    if (!run.provider) {
      // Legacy rows: 'model' is the complete, hand-typed string.
      args.push('--model', run.model)
      return fertig()
    }
    // This one is SYNCHRONOUS, so the lazy import the async paths use is not
    // available: without a context there is no provider descriptor at all, and
    // the two fallbacks below (the provider id as the opencode prefix, no
    // declared variable names) are what a context-less call gets. That is a
    // degradation and not a lie — `runner.mjs`, the only caller that launches a
    // run, always passes one; a one-argument call is a plugin author probing
    // the descriptor, and it must answer rather than throw.
    const prov = providerOf(ctx, run.provider)
    args.push('--model', `${prov?.ocPrefix ?? run.provider}/${run.model}`)

    // The credential, resolved the way the OPERATOR configured it: a value
    // stored for the provider, an environment variable they named for it, or
    // the provider's own declared variable — `ctx.secret()` answers all three
    // in that order (server/plugins/store.mjs). Without a context there is
    // neither a secret nor a list of declared names, so no key travels.
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

    // Pin the serving provider (OpenRouter routing). Two shapes:
    //   or_routing.mode 'auto' — the hub resolved the best-provider order at
    //     start (scheduler.mjs); the run carries the order and, when a minimum
    //     quantization was required, the API-level enumeration as a SECOND
    //     fence: names drift (measured, see openrouter-routing.mjs), the filter
    //     greps against the state.
    //   or_provider — the old single-tag pin, byte for byte as before.
    if (run.provider === 'openrouter' && (run.or_routing?.order?.length || run.or_provider)) {
      const order = run.or_routing?.order?.length ? run.or_routing.order : [run.or_provider]
      const provider = { order, allow_fallbacks: false }
      const minQuant = run.or_routing?.quant_min
      if (minQuant) {
        // Imported at the top of this file — a module that imports nothing of
        // the hub's, so it cannot close a cycle (same licence as patterns.mjs).
        try { provider.quantizations = quantizationsFrom(minQuant) } catch { /* an unknown level stays out rather than lying in the request */ }
      }
      cfg.provider = { openrouter: { models: { [run.model]: { options: { provider } } } } }
    }
    // Effort: '--variant' exists only for 'opencode run', fl-start launches the
    // TUI. The way in is agent.<default>.variant — and it only works when the
    // model is set in the same block (measured: --model alone is not enough).
    if (run.effort) {
      cfg.agent = { [OC_AGENT]: { model: `${prov?.ocPrefix ?? run.provider}/${run.model}`, variant: run.effort } }
    }
    return fertig()
  },

  // No subscription — usage is tracked per provider (e.g. OpenRouter credits).
  async usage() { return null },
}

export default plugin
