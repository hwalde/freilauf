// cc-hub — coding agent plugin: cursor (cursor-agent CLI).
//
// cursor runs like claude only on its subscription: no provider, no --effort.
// The 204 flat model IDs are base × effort level × fast, already multiplied
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
   * is the variant without.
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
      })
    }
    if (!models.length) throw new Error('cursor-agent models returned no models')
    return models.sort((a, b) => (a.fast - b.fast) || a.id.localeCompare(b.id))
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
   *   - auth/full_stripe_profile          → plan ("pro", …)
   *   - DashboardService/GetAggregatedUsageEvents → spent cents this cycle,
   *     per-model breakdown.
   * There is no public endpoint for the included quota — the percentage is
   * computed against a configurable amount (settings), which usage.mjs adds.
   */
  async usage() {
    let token
    try { token = JSON.parse(readFileSync(AUTH_FILE(), 'utf8')).accessToken } catch { return null }
    if (!token) return null
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const get = (path, init) => fetch(`${API()}${path}`, { headers, signal: AbortSignal.timeout(12_000), ...init })
      .then(r => (r.ok ? r.json() : null)).catch(() => null)
    const [profile, agg] = await Promise.all([
      get('/auth/full_stripe_profile'),
      get('/aiserver.v1.DashboardService/GetAggregatedUsageEvents', { method: 'POST', body: '{}' }),
    ])
    if (!profile && !agg) return null
    const byModel = (agg?.aggregations ?? []).map(a => ({
      model: a.modelIntent ?? '?',
      usd: Math.round((a.totalCents ?? 0)) / 100,
    })).sort((a, b) => b.usd - a.usd)
    return {
      kind: 'cursor',
      plan: profile?.membershipType ?? profile?.individualMembershipType ?? null,
      spent_usd: agg?.totalCostCents != null ? Math.round(agg.totalCostCents) / 100 : null,
      by_model: byModel.slice(0, 5),
    }
  },
}
