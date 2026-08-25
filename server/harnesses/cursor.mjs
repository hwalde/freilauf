// cc-hub — coding agent plugin: cursor (cursor-agent CLI).
//
// cursor runs like claude only on its subscription: no provider, no --effort.
// The ~200 flat model IDs are base × effort level × fast, already multiplied
// out — the effort level is PART of the model ID ('claude-opus-5-xhigh'), and
// the ID goes out verbatim, exactly as `cursor-agent models` printed it. An
// assembled ID could simply not exist.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const AUTH_FILE = () => process.env.CCHUB_CURSOR_AUTH ?? `${homedir()}/.config/cursor/auth.json`
const API = () => process.env.CCHUB_CURSOR_API ?? 'https://api2.cursor.sh'

export default {
  id: 'cursor',
  label: 'Cursor CLI',
  bin: 'cursor-agent',
  installHint: 'curl https://cursor.com/install -fsS | bash   (then: cursor-agent login)',
  sessionTag: 'cu-',         // tmux sessions: cc-cu-<name>

  subscription: true,
  providers: [],
  keyFreeProviders: [],

  // cursor talks to api2.cursor.sh — there is no open endpoint one could ping
  // without authentication. Better no pulse than an invented one: null means
  // explicitly "not monitored", not "healthy".
  pulseId: () => null,
  pulseTargets: {},

  // cursor has NO hook for API errors (its hook enum knows beforeShellExecution,
  // afterFileEdit, stop, beforeSubmitPrompt — nothing for a failed call), so the
  // log scan is the only source. 'Cannot use this model' is cursor's loud
  // rejection of an unknown model ID; it comes right at start and is a safe hit.
  logPatterns: [
    { typ: 'rate_limit', re: /rate.?limit|\b429\b|too many requests|usage limit reached|out of (requests|credits)/i },
    { typ: 'auth_error', re: /\b(401|403)\b|not (logged in|authenticated)|unauthori[sz]ed|please run .?cursor-agent login|invalid api key/i },
    { typ: 'billing_error', re: /\b402\b|insufficient (credits|funds)|billing|subscription (expired|required)|hard limit/i },
    { typ: 'model_error', re: /Cannot use this model/i },
    { typ: 'provider_error', re: /\b5\d\d\b|overloaded|unavailable|connection (error|refused|closed)|ECONNRE|ETIMEDOUT|fetch failed|stream (error|disconnected)/i },
  ],

  /**
   * Model list. The single authoritative source is `cursor-agent models`: the
   * list is ACCOUNT-BOUND (it comes from the server, not the binary), and the
   * CLI names exactly this list when rejecting an unknown model.
   *
   * Line format: '<id> - <display name>'. IDs ending in '-fast' are cursor's
   * fast mode (more expensive) — they sort last and are marked, the normal case
   * is the variant without. 'auto - Auto (default)' is part of the list and is
   * therefore a valid --model value like any other; cursor then routes to its
   * own models (composer/vega/grok), which draw on the Cursor-models pool of
   * the included usage instead of the third-party one.
   */
  async fetchModels() {
    const { stdout } = await execFileAsync('cursor-agent', ['models'], { timeout: 30_000 })
    const models = []
    for (const line of stdout.split('\n')) {
      // The header ('Available models') and the tip at the end have no ' - '
      // or no ID shape; both fall out of this pattern by themselves.
      const m = line.trim().match(/^([A-Za-z0-9][\w.\-]*)\s+-\s+(.+)$/)
      if (!m) continue
      const [, id, name] = m
      models.push({
        id, name,
        ctx: /\b1M\b/.test(name) ? 1_000_000 : null,
        tools: true,
        fast: id.endsWith('-fast'),
        auto: id === 'auto',
      })
    }
    if (!models.length) throw new Error('cursor-agent models returned no models')
    // 'auto' first: it is cursor's own default and the only entry that does not
    // name a model — between 200 sorted IDs it would otherwise disappear.
    return models.sort((a, b) => (b.auto - a.auto) || (a.fast - b.fast) || a.id.localeCompare(b.id))
  },

  /**
   * No effort field: cursor-agent has no --effort. The level is part of the
   * model ID, i.e. already decided with the model choice. An extra dropdown
   * could only produce an ID that does not exist.
   */
  async effortOptions() {
    return { stufen: null, hinweisKey: 'effort.cursor_in_id' }
  },

  /** CLI arguments for cc-start: ONLY --model with a verbatim ID from `cursor-agent models`. */
  modelArgs(run) {
    const args = []
    if (!run.model) return { args, fehlt: [] }
    args.push('--model', run.model)
    return { args, fehlt: [] }
  },

  /**
   * Subscription usage via the CLI's own token (~/.config/cursor/auth.json):
   *   - auth/full_stripe_profile                  → plan ("pro", …)
   *   - DashboardService/GetCurrentPeriodUsage    → included amount, spend and
   *     billing cycle of the running period, all in CENTS ('limit': 2000 on
   *     Pro) — this is what makes the bar honest, nothing has to be assumed
   *   - DashboardService/GetAggregatedUsageEvents → total of the period, used
   *     only as the fallback when the period endpoint answers nothing
   *
   * Cursor documents no included amount anywhere (the pricing page says only
   * "a set amount of model usage", Pro+/Ultra are "3x/20x Pro limits"), and the
   * public APIs are admin-only — GetCurrentPeriodUsage is the endpoint the
   * account itself answers, and the one the community's usage extensions read.
   * It is internal and has no contract: when it fails, included_usd stays null
   * and usage.mjs falls back to the configured amount.
   */
  async usage() {
    let token
    try { token = JSON.parse(readFileSync(AUTH_FILE(), 'utf8')).accessToken } catch { return null }
    if (!token) return null
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const get = (path, init) => fetch(`${API()}${path}`, { headers, signal: AbortSignal.timeout(12_000), ...init })
      .then(r => (r.ok ? r.json() : null)).catch(() => null)
    const post = (path) => get(path, { method: 'POST', body: '{}' })
    const [profile, agg, period] = await Promise.all([
      get('/auth/full_stripe_profile'),
      post('/aiserver.v1.DashboardService/GetAggregatedUsageEvents'),
      post('/aiserver.v1.DashboardService/GetCurrentPeriodUsage'),
    ])
    if (!profile && !agg && !period) return null
    const usd = (cents) => (cents == null || !Number.isFinite(Number(cents)) ? null : Math.round(Number(cents)) / 100)
    const plan = period?.planUsage ?? null
    const endMs = Number(period?.billingCycleEnd)
    return {
      kind: 'cursor',
      plan: profile?.membershipType ?? profile?.individualMembershipType ?? null,
      // The period endpoint's own total belongs to its own limit — mixing it
      // with the aggregation would make bar and tooltip disagree by a cent.
      spent_usd: usd(plan?.totalSpend) ?? usd(agg?.totalCostCents),
      included_usd: usd(plan?.limit),
      remaining_usd: usd(plan?.remaining),
      cycle_end: Number.isFinite(endMs) && endMs > 0 ? new Date(endMs).toISOString() : null,
    }
  },
}
