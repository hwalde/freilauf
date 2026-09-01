// Freilauf — coding agent plugin: claude (Claude Code CLI).
//
// claude runs exclusively on the Claude subscription: there is no provider
// selection, only the model choice. Usage data comes from the account's own
// usage endpoint (../claude-usage.mjs), with ~/.claude/quota.json as fallback
// (written by the statusline after every response).
//
// quota.mjs is imported LAZILY, and that is load-bearing rather than a matter
// of taste: the plugin registry imports this file, quota.mjs reaches the plugin
// context and through it the database, and the database module in turn is
// reached while the registry is still evaluating. A static import here closes
// that ring and the first thing to touch it dies in a temporal dead zone. Both
// places that need the claude windows are async anyway.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { refreshClaudeLimits } from '../claude-usage.mjs'
import { runCli, cliFailure } from './cli-llm.mjs'
import { env } from '../env.mjs'

const execFileAsync = promisify(execFile)

const flat = (t) => String(t ?? '').replace(/\s+/g, ' ')
const levelsFrom = (t) => t.split(/,|\bor\b/).map(x => x.trim().toLowerCase())
  .filter(x => /^[a-z]+$/.test(x))

const plugin = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  installHint: 'Native Claude Code installation (https://claude.com/claude-code), `claude` on the PATH.',
  sessionTag: '',            // tmux sessions: fl-<name>

  /**
   * How bin/fl-start calls this CLI. See docs/plugins.md, "The launch
   * declaration"; the placeholders are the values of fl-start's own options.
   *
   * claude is one of the four coding agents fl-start ships a `case` of its own
   * for, and that case — not this block — is what a claude run is launched
   * from: the script has to work standalone, with no hub to hand it a spec.
   * The declaration is here because it is the same launch line written down
   * where the rest of this plugin lives, and because it is the shape a THIRD
   * PARTY's coding agent is read from. Both produce the same argv; keep them in
   * step if the command line ever changes.
   */
  launch: {
    promptMode: 'argv',
    args: [
      '--permission-mode', '{mode}',
      { when: 'model', args: ['--model', '{model}'] },
      { when: 'effort', args: ['--effort', '{effort}'] },
      { when: 'session_id', args: ['--session-id', '{session_id}'] },
      { when: 'settings', args: ['--settings', '{settings}'] },
      '{prompt}',
    ],
    interactiveArgs: [
      '--permission-mode', '{mode}',
      { when: 'model', args: ['--model', '{model}'] },
      { when: 'effort', args: ['--effort', '{effort}'] },
    ],
  },

  // Subscription-based: model list belongs to the account, no provider dropdown.
  subscription: true,
  providers: [],
  keyFreeProviders: [],

  // Health pulse: watcher pings this while claude runs are active. The status
  // codes 401/403 still prove the API answers — only network-level failure or
  // 5xx counts as "down".
  pulseId: () => 'anthropic',
  pulseTargets: {
    anthropic: { url: 'https://api.anthropic.com/v1/models', okStatus: [200, 401, 403] },
  },

  // Log patterns (pipe-pane scan). Deliberately NARROW: better to miss a case
  // than to fire on a menu line ("Upgrade to Max for higher rate limits" once
  // ended up in the DB as a rate limit on a production run).
  logPatterns: [
    // Subscription limit output: "You've hit your session limit · resets 8:36pm"
    { typ: 'rate_limit', re: /you'?ve hit your (session|usage|weekly|daily|5.?hour|7.?day)? ?limit/i },
    { typ: 'rate_limit', re: /API Error: 429/i },
    { typ: 'rate_limit', re: /rate_limit_error/i },
    { typ: 'provider_error', re: /API Error: 5\d\d/i },
    { typ: 'provider_error', re: /overloaded_error|\bOverloaded\b/ },
    { typ: 'auth_error', re: /API Error: (401|403)|Please run \/login|OAuth token (has )?expired/i },
    { typ: 'billing_error', re: /API Error: 402|credit balance is too low/i },
    { typ: 'provider_error', re: /API Error:.*(fetch failed|socket|ECONN|ETIMEDOUT)/i },
  ],

  /**
   * The second prompt. `/goal <condition>` (Claude Code 2.1.232 and newer) sets
   * a completion condition: after every turn a small model checks whether the
   * condition holds, and while it does not, claude takes another turn by itself
   * — until it holds, until claude judges it impossible, or until `/goal clear`.
   *
   * There is NO command-line flag for it. The command exists only inside the
   * session, which is why the hub types it in after the start instead of
   * handing it to fl-start (server/goal.mjs). 4000 characters is the limit the
   * command itself documents.
   */
  goal: {
    max: 4000,
    command: (condition) => `/goal ${condition}`,
  },

  /**
   * The budget gate for a claude run.
   *
   * Three windows, three thresholds, and each window is measured against ITS
   * OWN: the 5-hour one, the general week, and a per-model week called "Fable".
   * A cleared fable field means "follow the general 7-day threshold" — which is
   * why that field declares no default of its own; a hardcoded 95 there would
   * silently stop following a general threshold the operator moved.
   *
   * WHICH week binds is a question about the RUN, not about the account, so the
   * check is handed the run's model: a Fable week at 96 % says nothing about a
   * run on Sonnet. The mathematics stays in quota.mjs — the anomaly, the cost
   * delta and the usage panel read the same windows, and one of the three
   * disagreeing with this gate is exactly the bug that split them apart.
   */
  gate: {
    fields: [
      { key: 'gate_on', settingKey: 'claude_gate_on', type: 'switch', default: 1, labelKey: 'settings.gate_claude_on' },
      { key: 'five', settingKey: 'claude_gate_5h', type: 'number', default: 90, min: 0, max: 100, step: 0.5, labelKey: 'settings.gate_claude_5h' },
      { key: 'seven', settingKey: 'claude_gate_7d', type: 'number', default: 95, min: 0, max: 100, step: 0.5, labelKey: 'settings.gate_claude_7d', hintKey: 'settings.gate_claude_7d_hint' },
      { key: 'fable', settingKey: 'claude_gate_fable', type: 'number', default: null, min: 0, max: 100, step: 0.5, labelKey: 'settings.gate_claude_fable', hintKey: 'settings.gate_claude_fable_hint' },
    ],
    async check(ctx, values = {}, run = {}) {
      const { claudeGateBlocked, claudeQuota } = await import('../quota.mjs')
      const seven = values.seven ?? 95
      const g = claudeGateBlocked(claudeQuota(), run?.model ?? null, {
        five: values.five ?? 90,
        seven,
        // Cleared fable field = the fable week follows the general threshold.
        fable: values.fable ?? seven,
      })
      return g.blocked ? g : null
    },
  },

  /**
   * claude can answer the hub's own small questions — on the subscription the
   * operator already pays for, which is what makes a hub with no API key
   * anywhere still able to name its runs.
   *
   * `overhead: true` is not modesty: a coding agent starts a whole session for
   * one question. It is slower and dearer than a model provider, and the UI
   * says so wherever this source can be picked.
   */
  llm: {
    schema: 'native',
    overhead: true,
    async models() { return plugin.fetchModels() },

    /**
     * One question, one session, no tools.
     *
     * The LEAN FLAG SET IS NOT OPTIONAL — measured: the default flags cost
     * $0.112 for the same question the lean ones answer for $0.0026, 42 times
     * as much, because claude otherwise loads settings, MCP servers, slash
     * commands and the whole tool surface before it says a word. And the prompt
     * goes on STDIN, never positionally: `--tools ""` is variadic and would eat
     * it.
     *
     * Failure is `exit != 0` or `is_error: true`. Deliberately NOT `subtype` —
     * that field still says "success" on a failed call.
     */
    async complete(ctx, req = {}) {
      const args = ['-p', '--output-format', 'json']
      if (req.model) args.push('--model', String(req.model))
      args.push('--safe-mode', '--setting-sources', '', '--strict-mcp-config',
        '--disable-slash-commands', '--no-session-persistence')
      if (req.system) args.push('--system-prompt', String(req.system))
      args.push('--tools', '')
      // The one CLI of the four that takes a JSON schema. That is what makes
      // this source `schema: 'native'`: no coaxing paragraph in the prompt.
      if (req.schema) args.push('--json-schema', JSON.stringify(req.schema))

      const r = await runCli('claude', args, {
        stdin: String(req.prompt ?? ''),
        timeoutMs: req.timeoutMs ?? 180_000,
      })
      let j = null
      try { j = JSON.parse(r.stdout) } catch { /* not an envelope — handled below */ }
      if (r.code !== 0 || !j || j.is_error === true) throw cliFailure('claude', r, j?.result)
      const structured = j.structured_output
      return {
        text: structured === undefined || structured === null
          ? String(j.result ?? '')
          : JSON.stringify(structured),
        usage: j.usage ?? null,
        raw: j,
      }
    },
  },

  /**
   * Model list. There is no catalog endpoint without an API key (the
   * subscription has none), hence a maintained list: the aliases that always
   * point to the newest release, plus the fixed identifiers. Free-text input
   * stays possible in the form at all times.
   */
  async fetchModels() {
    return [
      { id: 'opus', name: 'Opus (alias, always the newest release)' },
      { id: 'fable', name: 'Fable (alias)' },
      { id: 'sonnet', name: 'Sonnet (alias)' },
      { id: 'haiku', name: 'Haiku (alias)' },
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
      { id: 'claude-fable-5', name: 'Claude Fable 5' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ].map(m => ({ ...m, ctx: null, tools: true }))
  },

  /**
   * Which effort levels does the claude CLI accept? Not guessed — the CLI is
   * asked directly: given a nonsense value it prints its list on stderr, in
   * under a second and without starting a run (--version aborts right after).
   * If that fails, the same list is in --help. If that fails too, null is
   * returned and the form hides the field instead of offering an invented list.
   */
  async effortLevels() {
    const probe = await execFileAsync('claude', ['--effort', '__probe__', '--version'], { timeout: 15_000 })
      .catch(err => err)
    const m1 = flat(probe?.stderr).match(/Valid values:\s*([^.]+)\./)
    if (m1) return levelsFrom(m1[1])
    const { stdout } = await execFileAsync('claude', ['--help'], { timeout: 15_000 })
    const m2 = flat(stdout).match(/--effort <level>\s*Effort level for the current session\s*\(([^)]+)\)/)
    return m2 ? levelsFrom(m2[1]) : null
  },

  /** Effort options for a concrete run. claude accepts each of its levels for EVERY model. */
  async effortOptions({ helpers }) {
    const levels = await helpers.ownLevels()
    return levels
      ? { stufen: levels, standard: null, pflicht: false, quelle: 'cli', hinweisKey: 'effort.claude_cli' }
      : { stufen: null, hinweisKey: 'effort.no_levels_cli' }
  },

  /**
   * How a human picks this run's session back up. The hub starts claude with
   * `--session-id <run id>` (runner.mjs), so the id is known in advance — no
   * lookup needed.
   */
  resumeCommand(run) {
    if (!run?.id || !run?.workdir_effective) return null
    return `cd ${run.workdir_effective} && claude --resume ${run.id}`
  },

  /**
   * CLI arguments for fl-start. claude takes model and effort as separate flags.
   *
   * The second parameter is the plugin context every other harness uses to
   * resolve its provider credentials; claude runs on the subscription and has
   * none, so it is accepted and ignored — the signature stays the same across
   * the four plugins.
   */
  modelArgs(run, _ctx = null) {
    const args = []
    if (!run.model) return { args, fehlt: [] }
    args.push('--model', run.model)
    if (run.effort) args.push('--effort', run.effort)
    return { args, fehlt: [] }
  },

  /**
   * Subscription usage: percentages of the 5-hour window and of every 7-day
   * window (general plus the per-model ones), plus the plan from the local
   * credentials file (only the two non-secret fields are read — never the
   * tokens).
   *
   * The refresh is awaited HERE and nowhere on a page render: this is the one
   * caller that exists to produce these numbers, and usage.mjs already wraps it
   * in a cache with stale-while-revalidate, so a slow endpoint delays the
   * numbers rather than the page. It returns null on every failure, at which
   * point claudeQuota() reads the file exactly as it always did.
   */
  async usage() {
    await refreshClaudeLimits()
    const { claudeQuota } = await import('../quota.mjs')
    const q = claudeQuota()
    let plan = null
    try {
      const cred = JSON.parse(readFileSync(
        env('CLAUDE_CREDENTIALS') ?? `${homedir()}/.claude/.credentials.json`, 'utf8'))
      const o = cred?.claudeAiOauth
      if (o?.subscriptionType) plan = o.subscriptionType + (o.rateLimitTier ? ` (${o.rateLimitTier})` : '')
    } catch { /* no credentials file — plan stays unknown */ }
    if (q.five === null && q.seven === null && !plan) return null
    return {
      kind: 'claude', plan, five: q.five, seven: q.seven,
      seven_general: q.seven_general, seven_fable: q.seven_fable,
      resets_at: q.resets_at, seven_resets_at: q.seven_resets_at,
      seven_fable_resets_at: q.seven_fable_resets_at,
      // When a value is NOT from the current live answer, when it was read —
      // the panel prints "as of …" instead of passing an old number off as
      // current. null = the account itself answered.
      five_at: q.five_at, seven_general_at: q.seven_general_at,
      // Every per-model week under its own name, and whether the account itself
      // answered. The panel renders the list; the two `fable` fields above stay
      // because the gate, the cost estimate and /api/usage's consumers name them.
      weekly_scoped: q.weekly_scoped, live: q.live,
    }
  },
}

export default plugin
