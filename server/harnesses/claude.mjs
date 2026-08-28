// cc-hub — coding agent plugin: claude (Claude Code CLI).
//
// claude runs exclusively on the Claude subscription: there is no provider
// selection, only the model choice. Usage data comes from the account's own
// usage endpoint (../claude-usage.mjs), with ~/.claude/quota.json as fallback
// (written by the statusline after every response).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { claudeQuota } from '../quota.mjs'
import { refreshClaudeLimits } from '../claude-usage.mjs'

const execFileAsync = promisify(execFile)

const flat = (t) => String(t ?? '').replace(/\s+/g, ' ')
const levelsFrom = (t) => t.split(/,|\bor\b/).map(x => x.trim().toLowerCase())
  .filter(x => /^[a-z]+$/.test(x))

export default {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  installHint: 'Native Claude Code installation (https://claude.com/claude-code), `claude` on the PATH.',
  sessionTag: '',            // tmux sessions: cc-<name>

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
   * handing it to cc-start (server/goal.mjs). 4000 characters is the limit the
   * command itself documents.
   */
  goal: {
    max: 4000,
    command: (condition) => `/goal ${condition}`,
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

  /** CLI arguments for cc-start. claude takes model and effort as separate flags. */
  modelArgs(run) {
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
    const q = claudeQuota()
    let plan = null
    try {
      const cred = JSON.parse(readFileSync(
        process.env.CCHUB_CLAUDE_CREDENTIALS ?? `${homedir()}/.claude/.credentials.json`, 'utf8'))
      const o = cred?.claudeAiOauth
      if (o?.subscriptionType) plan = o.subscriptionType + (o.rateLimitTier ? ` (${o.rateLimitTier})` : '')
    } catch { /* no credentials file — plan stays unknown */ }
    if (q.five === null && q.seven === null && !plan) return null
    return {
      kind: 'claude', plan, five: q.five, seven: q.seven,
      seven_general: q.seven_general, seven_fable: q.seven_fable,
      resets_at: q.resets_at, seven_resets_at: q.seven_resets_at,
      seven_fable_resets_at: q.seven_fable_resets_at,
      // Every per-model week under its own name, and whether the account itself
      // answered. The panel renders the list; the two `fable` fields above stay
      // because the gate, the cost estimate and /api/usage's consumers name them.
      weekly_scoped: q.weekly_scoped, live: q.live,
    }
  },
}
