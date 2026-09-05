// Freilauf — coding agent plugin: cursor (cursor-agent CLI).
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
import { HTTP_5XX } from './patterns.mjs'
import { transcriptPath } from '../cursor-transcript.mjs'
import { runCli, cliFailure } from './cli-llm.mjs'
import { env } from '../env.mjs'

const execFileAsync = promisify(execFile)

const AUTH_FILE = () => env('CURSOR_AUTH') ?? `${homedir()}/.config/cursor/auth.json`
const API = () => env('CURSOR_API') ?? 'https://api2.cursor.sh'

const plugin = {
  id: 'cursor',
  label: 'Cursor CLI',
  bin: 'cursor-agent',
  installHint: 'curl https://cursor.com/install -fsS | bash   (then: cursor-agent login)',
  sessionTag: 'cu-',         // tmux sessions: fl-cu-<name>

  /**
   * How bin/fl-start calls this CLI (see claude.mjs for why the built-in `case`
   * in that script, not this block, is what a cursor run is launched from).
   *
   * The prompt is a POSITIONAL argument after `--`, never `-p`: `-p/--print`
   * prints and exits, so the tmux session would be gone immediately. `--trust`
   * is mandatory — without it the TUI hangs on "Do you trust the contents of
   * this directory?". Both measured, both load-bearing.
   */
  launch: {
    promptMode: 'argv',
    args: ['--force', '--trust', { when: 'model', args: ['--model', '{model}'] }, '--', '{prompt}'],
    interactiveArgs: ['--force', '--trust', { when: 'model', args: ['--model', '{model}'] }],
    // The resume form (fl-start --resume): `--resume <chat id>` with the
    // prompt as the next turn; the chat id is read out of the transcript
    // (resumeId below). Measured end to end through fl-start (2026.09.02):
    // the code word from the first turn came back, and the SAME transcript
    // file grew — so the watcher's activity and end-of-turn sources keep
    // reading the file they already read.
    resume: ['--force', '--trust', { when: 'model', args: ['--model', '{model}'] }, '--resume', '{resume_id}', '--', '{prompt}'],
  },

  subscription: true,
  providers: [],
  keyFreeProviders: [],

  // cursor talks to api2.cursor.sh — there is no open endpoint one could ping
  // without authentication. Better no pulse than an invented one: null means
  // explicitly "not monitored", not "healthy".
  pulseId: () => null,
  pulseTargets: {},

  /**
   * The turn end IS the end of the run. cursor's TUI stays standing after the
   * work is done ('→ Add a follow-up'), so the pane never dies and the last
   * safety net every other harness has does not exist here. Without this flag a
   * cursor run whose agent forgot `fl-report done` stood on 'running' FOREVER —
   * and since a single run with the start mode "when no other run of this repo
   * is going" waits for exactly that, one forgotten report blocked the whole
   * queue behind it (observed 2026-08-25: four runs, among them the one meant to
   * fix this).
   *
   * reports.mjs closes the run on `_turn_end` when this is set — but only from
   * status 'running': a `fl-report help` puts the run on 'waiting_help' and the
   * agent ends its turn exactly as it should while waiting for the answer.
   */
  turnEndsRun: true,

  /**
   * Hook files the hub writes into the worktree before the start (runner.mjs).
   * cursor reads <workspace>/.cursor/hooks.json; the format is one flat list of
   * { command } objects per event — NOT claude's { matcher, hooks: [...] } shape.
   *
   * 'stop' fires when the agent finishes its turn while the session stays alive
   * (measured with 2026.08.11-e8db854: payload status "completed", and the
   * session's environment — FL_RUN_ID included — is inherited, which is what
   * makes fl-report work from here at all). 'sessionEnd' is the second net for
   * the case where the process really exits; it detaches with setsid because a
   * hook a dying process takes down with it reports nothing (the lesson from
   * claude's StopFailure).
   *
   * 'beforeSubmitPrompt' is the agent's attention (docs/plugins.md,
   * "Attention"): measured with 2026.08.25, it fires for the launch prompt and
   * for every follow-up typed into the TUI at "→ Add a follow-up", with the
   * prompt in its payload, and the stop hook then fires again at the end of
   * that turn. A hook that prints nothing lets the prompt through.
   */
  hookFiles({ flReport }) {
    const cmd = (...args) => `${flReport} ${args.join(' ')}`
    return [{
      path: '.cursor/hooks.json',
      content: JSON.stringify({
        version: 1,
        hooks: {
          beforeSubmitPrompt: [{ command: cmd('_working') }],
          stop: [{ command: cmd('_turn_end') }],
          sessionEnd: [{ command: `setsid -f ${cmd('_exit')} >/dev/null 2>&1` }],
        },
      }, null, 2) + '\n',
    }]
  },

  /** How the hub learns whether this agent works or waits — see `hookFiles`. */
  attention: { source: 'hookFiles', note: 'beforeSubmitPrompt → _working, stop → _turn_end' },

  /**
   * Extra prompt lines for this harness (runner.mjs appends them to the platform
   * rules). cursor is the harness that lost the most runs to a missing report,
   * so it gets told twice and concretely: the summary it prints into the TUI is
   * not a report, and the call has to happen inside the turn — after the turn
   * there is nothing left to call from.
   */
  promptRules: [
    'You are running as `cursor-agent` under Freilauf, and your turn ending is what ends this run.',
    'The platform closes the run the moment you stop, so the `fl-report done --file {report_file}`',
    'call below has to be your LAST tool call, inside this same turn — afterwards there is nothing',
    'left to call it from. A summary printed into the chat is not a report: nobody reads the TUI.',
    '`fl-report` is an ordinary program on PATH; run it with your shell tool like any other command.',
  ].join('\n'),

  /**
   * Where cursor looks for agent skills. Read out of the CLI itself
   * (`src/utils/skill-path-utils.ts` in the bundle), which carries the search
   * list verbatim: `.cursor/skills`, `.claude/skills`, `.codex/skills`,
   * `.grok/skills`, `.agents/skills` — each of them both under `$HOME` and
   * inside the workspace, plus the bundled `.cursor/skills-cursor` that
   * belongs to cursor and is deliberately NOT listed here.
   *
   * `.claude/skills` is marked `thirdParty` in that list and is gated on
   * `thirdPartyExtensibilityEnabled`, which defaults to on and has no local
   * switch — the same mechanism AGENTS.md already records for `CLAUDE.md` and
   * `.claude/agents`. Its own directory comes first so a machine with only
   * cursor on it gets the native one.
   */
  skills: {
    user: ['~/.cursor/skills', '~/.claude/skills', '~/.agents/skills'],
    project: ['.cursor/skills', '.claude/skills', '.agents/skills'],
  },

  // cursor has NO hook for API errors (its hook enum knows beforeShellExecution,
  // afterFileEdit, stop, sessionEnd, beforeSubmitPrompt — nothing for a failed
  // call), so the log scan is the only source. 'Cannot use this model' is
  // cursor's loud rejection of an unknown model ID; it comes right at start and
  // is a safe hit.
  logPatterns: [
    { typ: 'rate_limit', re: /rate.?limit|\b429\b|too many requests|usage limit reached|out of (requests|credits)/i },
    { typ: 'auth_error', re: /\b(401|403)\b|not (logged in|authenticated)|unauthori[sz]ed|please run .?cursor-agent login|invalid api key/i },
    { typ: 'billing_error', re: /\b402\b|insufficient (credits|funds)|billing|subscription (expired|required)|hard limit/i },
    { typ: 'model_error', re: /Cannot use this model/i },
    { typ: 'provider_error', re: new RegExp(`${HTTP_5XX.source}|overloaded|unavailable|connection (error|refused|closed)|ECONNRE|ETIMEDOUT|fetch failed|stream (error|disconnected)`, 'i') },
  ],

  /**
   * The included amount of the running period.
   *
   * Cursor documents it NOWHERE (the pricing page says only "a set amount of
   * model usage") and its public APIs are admin-only, so the account's own
   * dashboard endpoint is the one source — and it has no contract. This field
   * is the fallback for when it stays silent, and it is a plain setting rather
   * than a gate field because the usage PANEL reads it too: a number the bar
   * measures against does not belong behind a budget-gate switch.
   */
  settings: [
    { key: 'included_usd', settingKey: 'cursor_included_usd', type: 'number', default: 20, min: 0, step: 1, labelKey: 'settings.cursor_included', hintKey: 'settings.cursor_included_hint' },
  ],

  /**
   * The budget gate for a cursor run: the included usage of the running period
   * against its own threshold. `label` is what the reason line says — the
   * plugin's own label is "Cursor CLI", and a gate reason is about the account,
   * not about the binary.
   */
  gate: {
    label: 'Cursor',
    fields: [
      { key: 'gate_on', settingKey: 'cursor_gate_on', type: 'switch', default: 1, labelKey: 'settings.gate_cursor_on' },
      { key: 'pct', settingKey: 'cursor_gate_pct', type: 'number', default: 95, min: 0, max: 100, step: 0.5, labelKey: 'settings.gate_cursor_pct', hintKey: 'settings.gate_cursor_pct_hint' },
    ],
    async check(ctx, values = {}) {
      const { usageGateBlocked } = await import('../quota.mjs')
      const g = await usageGateBlocked(plugin.id, {
        threshold: values.pct ?? 95,
        includedFallback: Number(ctx?.setting?.('included_usd', 20)) || 20,
      })
      return g.blocked ? g : null
    },
  },

  /**
   * cursor can answer the hub's own small questions on its subscription.
   *
   * `--mode ask` is the only way to make cursor-agent read-only, and `--trust`
   * is mandatory: without it the CLI sits at "Do you trust the contents of this
   * directory?" and nothing happens at all. There is no schema flag and no
   * system-prompt flag, hence `schema: 'prompt'` and the system text folded
   * into the prompt.
   */
  llm: {
    schema: 'prompt',
    overhead: true,
    async models() { return plugin.fetchModels() },
    async complete(ctx, req = {}) {
      const prompt = req.system ? `${req.system}\n\n${req.prompt ?? ''}` : String(req.prompt ?? '')
      const args = ['-p', '--output-format', 'json']
      if (req.model) args.push('--model', String(req.model))
      args.push('--trust', '--mode', 'ask', prompt)
      const r = await runCli('cursor-agent', args, { timeoutMs: req.timeoutMs ?? 180_000 })
      let j = null
      try { j = JSON.parse(r.stdout.trim()) } catch { /* handled below */ }
      // cursor is the one of the four that reports on STDERR — the others all
      // keep their complaint in the stream the answer comes on.
      if (r.code !== 0 || !j) throw cliFailure('cursor-agent', r, String(r.stderr || '').trim() || null)
      const text = typeof j.result === 'string' ? j.result : JSON.stringify(j.result ?? '')
      return { text, usage: j.usage ?? null, raw: j }
    },
  },

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

  /** CLI arguments for fl-start: ONLY --model with a verbatim ID from `cursor-agent models`. */
  /**
   * `cursor-agent --resume [chatId]` (measured against the CLI's own --help).
   * The chat id is the transcript's directory name — the same file the hub reads
   * for activity and for the end of a turn, so no second source is needed.
   * Without a transcript there is no id, and then there is no command either.
   */
  resumeCommand(run) {
    const id = this.resumeId(run)
    if (!id || !run?.workdir_effective) return null
    return `cd ${run.workdir_effective} && cursor-agent --resume ${id}`
  },

  /**
   * The chat id the hub resumes with (runner.mjs, resumeRun): the transcript
   * file's basename. `null` when there is no transcript — then there is
   * nothing to continue, and the run is started afresh with its task.
   */
  resumeId(run) {
    const path = transcriptPath(run)
    return path ? path.split('/').pop().replace(/\.jsonl$/, '') : null
  },

  modelArgs(run, _ctx = null) {
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
  async usage(ctx = null) {
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
    const spent = usd(plan?.totalSpend) ?? usd(agg?.totalCostCents)
    // The included amount comes from Cursor itself. Only when that endpoint
    // stays silent does the configured fallback step in — and then the answer
    // SAYS so, so the UI can mark the bar as an estimate instead of presenting
    // a guess as a fact. This used to live in usage.mjs, where the aggregator
    // knew a vendor's field names and the budget gate had to compute the same
    // percentage a second time.
    let included = usd(plan?.limit)
    let estimated = false
    if (included == null) {
      included = Number(ctx?.setting?.('included_usd', 20)) || 20
      estimated = true
    }
    return {
      kind: 'cursor',
      plan: profile?.membershipType ?? profile?.individualMembershipType ?? null,
      // The period endpoint's own total belongs to its own limit — mixing it
      // with the aggregation would make bar and tooltip disagree by a cent.
      spent_usd: spent,
      included_usd: included,
      ...(estimated ? { included_estimated: true } : {}),
      remaining_usd: usd(plan?.remaining),
      pct: spent != null && included ? Math.round((spent / included) * 1000) / 10 : null,
      cycle_end: Number.isFinite(endMs) && endMs > 0 ? new Date(endMs).toISOString() : null,
    }
  },
}

export default plugin
