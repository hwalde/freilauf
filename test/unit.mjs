#!/usr/bin/env node
// cc-hub — unit tests for the functions with real logic and edge cases.
//
// Deliberately NOT tested: SQL strings, HTML snippets, CSS classes, column orders,
// exact message texts, private helper functions. Such tests would only cement the
// current implementation instead of securing behavior. What is tested is what
// computes or decides — schedules, cron, form parsing, quota gate, text processing.
//
// Usage:  node test/unit.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gruppe, pruefe, gleich, wahr, falsch, enthaelt, bericht, zaehler } from './mini.mjs'

const start = Date.now()

// Own data directory: importing runner.mjs pulls in db.mjs, which would otherwise
// touch the real hub database.
const sandkasten = mkdtempSync(join(tmpdir(), 'cc-hub-unit-'))
process.env.CCHUB_DATA_DIR = join(sandkasten, 'data')

const d = (s) => new Date(s)

try {
  const { cronMatches, validCron, scheduleDue, scheduleText, stripAnsi, escapeHtml,
    fmtDuration, kurzid } = await import('../server/util.mjs')
  const { parseForm } = await import('../server/web-helpers.mjs')

  // ------------------------------------------------------------------
  gruppe('Cron: matching (cronMatches)')

  await pruefe('fixed time matches exactly that minute', () => {
    wahr(cronMatches('30 6 * * *', d('2026-08-24T06:30:00')), '06:30')
    falsch(cronMatches('30 6 * * *', d('2026-08-24T06:31:00')), '06:31')
  })
  await pruefe('steps */15 match every quarter hour', () => {
    for (const m of [0, 15, 30, 45]) wahr(cronMatches('*/15 * * * *', d(`2026-08-24T10:${String(m).padStart(2, '0')}:00`)), `minute ${m}`)
    falsch(cronMatches('*/15 * * * *', d('2026-08-24T10:31:00')), 'minute 31')
  })
  await pruefe('range 1-5 means Monday through Friday', () => {
    wahr(cronMatches('0 6 * * 1-5', d('2026-08-24T06:00:00')), 'Monday')
    wahr(cronMatches('0 6 * * 1-5', d('2026-08-28T06:00:00')), 'Friday')
    falsch(cronMatches('0 6 * * 1-5', d('2026-08-23T06:00:00')), 'Sunday')
  })
  await pruefe('list 1,3,5 matches only the named days', () => {
    wahr(cronMatches('0 6 * * 1,3,5', d('2026-08-26T06:00:00')), 'Wednesday')
    falsch(cronMatches('0 6 * * 1,3,5', d('2026-08-25T06:00:00')), 'Tuesday')
  })
  await pruefe('weekday 7 means Sunday (same as 0)', () => {
    wahr(cronMatches('0 6 * * 7', d('2026-08-23T06:00:00')), 'Sunday as 7')
    wahr(cronMatches('0 6 * * 0', d('2026-08-23T06:00:00')), 'Sunday as 0')
  })
  await pruefe('month and day are checked too', () => {
    wahr(cronMatches('0 0 1 1 *', d('2027-01-01T00:00:00')), 'New Year')
    falsch(cronMatches('0 0 1 1 *', d('2026-12-31T00:00:00')), 'New Year\'s Eve')
  })
  await pruefe('wrong field count never matches', () => {
    falsch(cronMatches('* * * *', d('2026-08-24T06:00:00')), 'four fields')
    falsch(cronMatches('', d('2026-08-24T06:00:00')), 'empty')
  })

  // ------------------------------------------------------------------
  gruppe('Cron: input validation (validCron)')

  await pruefe('common expressions are considered valid', () => {
    for (const c of ['0 6 * * *', '0 6 * * 1-5', '*/15 * * * *', '0 0 1 1 *', '30 6 * * 1,3,5'])
      wahr(validCron(c), c)
  })
  await pruefe('garbage and wrong field counts are rejected', () => {
    for (const c of ['jeden tag', '* * * *', '* * * * * *', '', null, undefined, 'abc def ghi jkl mno'])
      falsch(validCron(c), String(c))
  })
  await pruefe('out-of-range values are rejected', () => {
    falsch(validCron('99 * * * *'), 'minute 99')
    falsch(validCron('* 25 * * *'), 'hour 25')
    falsch(validCron('* * 32 * *'), 'day 32')
    falsch(validCron('* * * 13 *'), 'month 13')
  })
  await pruefe('nonsensical range (5-1) is rejected', () => {
    falsch(validCron('0 6 * * 5-1'), 'descending range')
  })

  // ------------------------------------------------------------------
  gruppe('Schedules: due check (scheduleDue)')

  const woe = { schedule_kind: 'woechentlich', schedule_days: '1,3,5', schedule_time: '07:30', schedule_weeks: 1 }

  await pruefe('weekly: only the chosen days at the chosen minute', () => {
    wahr(scheduleDue(woe, d('2026-08-24T07:30:00')), 'Monday 07:30')
    wahr(scheduleDue(woe, d('2026-08-26T07:30:00')), 'Wednesday 07:30')
    falsch(scheduleDue(woe, d('2026-08-25T07:30:00')), 'Tuesday')
    falsch(scheduleDue(woe, d('2026-08-24T07:31:00')), 'one minute off')
    falsch(scheduleDue(woe, d('2026-08-23T07:30:00')), 'Sunday')
  })

  const zwei = { ...woe, schedule_weeks: 2, schedule_anchor: '2026-08-24' }
  await pruefe('biweekly: anchor week yes, following week no', () => {
    wahr(scheduleDue(zwei, d('2026-08-24T07:30:00')), 'anchor week Monday')
    wahr(scheduleDue(zwei, d('2026-08-28T07:30:00')), 'anchor week Friday')
    falsch(scheduleDue(zwei, d('2026-08-31T07:30:00')), 'following week Monday')
    falsch(scheduleDue(zwei, d('2026-09-04T07:30:00')), 'following week Friday')
    wahr(scheduleDue(zwei, d('2026-09-07T07:30:00')), 'week after next')
  })
  await pruefe('cadence counts whole weeks, even across month and year boundaries', () => {
    const ueberJahr = { ...woe, schedule_weeks: 2, schedule_anchor: '2026-12-28' }
    wahr(scheduleDue(ueberJahr, d('2026-12-28T07:30:00')), 'anchor week (December)')
    falsch(scheduleDue(ueberJahr, d('2027-01-04T07:30:00')), 'following week (January)')
    wahr(scheduleDue(ueberJahr, d('2027-01-11T07:30:00')), 'two weeks later (January)')
  })
  await pruefe('three- and four-week cadences only match their own beat', () => {
    const drei = { ...zwei, schedule_weeks: 3 }
    const vier = { ...zwei, schedule_weeks: 4 }
    wahr(scheduleDue(drei, d('2026-09-14T07:30:00')), '+3 weeks')
    falsch(scheduleDue(drei, d('2026-09-07T07:30:00')), '+2 weeks')
    wahr(scheduleDue(vier, d('2026-09-21T07:30:00')), '+4 weeks')
    falsch(scheduleDue(vier, d('2026-09-14T07:30:00')), '+3 weeks')
  })
  await pruefe('anchor week in the future is never due', () => {
    const kuenftig = { ...woe, schedule_weeks: 2, schedule_anchor: '2027-01-11' }
    falsch(scheduleDue(kuenftig, d('2026-08-24T07:30:00')), 'before the anchor')
  })
  await pruefe('incomplete settings are never due', () => {
    falsch(scheduleDue({ schedule_kind: 'woechentlich', schedule_time: '07:30' }, d('2026-08-24T07:30:00')), 'no days')
    falsch(scheduleDue({ schedule_kind: 'woechentlich', schedule_days: '1' }, d('2026-08-24T07:30:00')), 'no time')
    falsch(scheduleDue({ schedule_kind: 'einmalig' }, d('2026-08-24T07:30:00')), 'no date')
    falsch(scheduleDue({ schedule_kind: 'einmalig', run_at: 'kein datum' }, d('2026-08-24T07:30:00')), 'broken date')
    falsch(scheduleDue({ schedule_kind: 'cron' }, d('2026-08-24T07:30:00')), 'no expression')
  })
  await pruefe('one-off: due from the date on and caught up later', () => {
    const ein = { schedule_kind: 'einmalig', run_at: '2026-08-24T09:00' }
    falsch(scheduleDue(ein, d('2026-08-24T08:59:00')), 'before')
    wahr(scheduleDue(ein, d('2026-08-24T09:00:00')), 'exactly')
    wahr(scheduleDue(ein, d('2026-08-25T10:00:00')), 'a day later (hub was off)')
  })
  await pruefe('cron kind uses the cron expression', () => {
    const c = { schedule_kind: 'cron', schedule: '0 6 * * 1-5' }
    wahr(scheduleDue(c, d('2026-08-24T06:00:00')), 'Monday 06:00')
    falsch(scheduleDue(c, d('2026-08-23T06:00:00')), 'Sunday')
  })
  await pruefe('manual and unknown kinds are never due', () => {
    falsch(scheduleDue({ schedule_kind: 'manuell' }, d('2026-08-24T07:30:00')), 'manual')
    falsch(scheduleDue({ schedule_kind: 'quatsch' }, d('2026-08-24T07:30:00')), 'unknown')
    falsch(scheduleDue({}, d('2026-08-24T07:30:00')), 'nothing set at all')
  })

  // ------------------------------------------------------------------
  gruppe('Schedules: labeling (scheduleText)')

  await pruefe('describes every kind intelligibly', () => {
    enthaelt(scheduleText(zwei), 'every 2 weeks', 'n-weekly')
    enthaelt(scheduleText(zwei), 'Mon, Wed, Fri', 'weekdays')
    enthaelt(scheduleText(zwei), '07:30', 'time')
    enthaelt(scheduleText(woe), 'weekly', 'simply weekly')
    enthaelt(scheduleText({ schedule_kind: 'einmalig', run_at: '2026-08-24T09:00' }), '2026-08-24', 'date')
    gleich(scheduleText({ schedule_kind: 'manuell' }), 'manual', 'manual')
    enthaelt(scheduleText({ schedule_kind: 'cron', schedule: '0 6 * * *' }), '0 6 * * *', 'cron')
  })
  await pruefe('stays readable with incomplete settings', () => {
    const t = scheduleText({ schedule_kind: 'woechentlich' })
    wahr(typeof t === 'string' && t.length > 0, 'returns text instead of throwing')
  })

  // ------------------------------------------------------------------
  gruppe('Form data (parseForm)')

  await pruefe('repeated fields additionally land in <name>_list', () => {
    const b = parseForm('schedule_days=1&schedule_days=3&schedule_days=5')
    gleich(b.schedule_days_list.length, 3, 'number of days')
    gleich(b.schedule_days_list.join(','), '1,3,5', 'order preserved')
  })
  await pruefe('single values stay single values', () => {
    const b = parseForm('name=hallo&zahl=42')
    gleich(b.name, 'hallo', 'name')
    gleich(b.zahl, '42', 'zahl')
  })
  await pruefe('empty body yields an empty object', () => {
    gleich(Object.keys(parseForm('')).length, 0, 'field count')
  })
  await pruefe('percent encoding and plus signs are decoded', () => {
    const b = parseForm('text=Hallo+Welt%21&pfad=%2Ftmp%2Fa+b')
    gleich(b.text, 'Hallo Welt!', 'text')
    gleich(b.pfad, '/tmp/a b', 'path')
  })
  await pruefe('empty field is preserved (not undefined)', () => {
    const b = parseForm('leer=&x=1')
    gleich(b.leer, '', 'empty field')
  })

  // ------------------------------------------------------------------
  gruppe('Text processing')

  await pruefe('stripAnsi removes control sequences, keeps payload text', () => {
    gleich(stripAnsi('\x1b[31mrot\x1b[0m'), 'rot', 'color codes')
    gleich(stripAnsi('\x1b[200~eingefügt\x1b[201~'), 'eingefügt', 'bracketed paste')
    gleich(stripAnsi('\x1b[2J\x1b[Hgelöscht'), 'gelöscht', 'clear screen')
  })
  await pruefe('stripAnsi leaves umlauts and newlines untouched', () => {
    gleich(stripAnsi('Ärger mit Größe\nzweite Zeile'), 'Ärger mit Größe\nzweite Zeile', 'umlauts')
  })
  await pruefe('stripAnsi discards carriage returns, keeps newlines', () => {
    gleich(stripAnsi('a\r\nb'), 'a\nb', 'CRLF')
    gleich(stripAnsi('a\rb'), 'ab', 'lone CR')
  })
  await pruefe('escapeHtml defuses exactly the five dangerous characters', () => {
    gleich(escapeHtml('<b>'), '&lt;b&gt;', 'angle brackets')
    gleich(escapeHtml('a & b'), 'a &amp; b', 'ampersand')
    gleich(escapeHtml(`"x" 'y'`), '&quot;x&quot; &#39;y&#39;', 'quotes')
  })
  await pruefe('escapeHtml double-escapes nothing extra and tolerates null', () => {
    gleich(escapeHtml('&amp;'), '&amp;amp;', 'plain replacement, no special case')
    gleich(escapeHtml(null), '', 'null')
    gleich(escapeHtml(undefined), '', 'undefined')
    gleich(escapeHtml('harmlos'), 'harmlos', 'unchanged text')
  })
  await pruefe('fmtDuration formats minutes and hours', () => {
    gleich(fmtDuration(0), '0 min', 'zero seconds')
    gleich(fmtDuration(90), '1 min', 'one and a half minutes')
    gleich(fmtDuration(3661), '1 h 1 min', 'just over an hour')
  })
  await pruefe('fmtDuration rejects nonsense instead of showing NaN', () => {
    gleich(fmtDuration(-5), '–', 'negative')
    gleich(fmtDuration(NaN), '–', 'NaN')
    gleich(fmtDuration(undefined), '–', 'undefined')
  })
  await pruefe('kurzid returns the first UUID block', () => {
    gleich(kurzid('1d005159-78bd-4cc1-a889-07617871af2e'), '1d005159', 'UUID')
  })

  // ------------------------------------------------------------------
  gruppe('Quota gate')

  // QUOTA_PATH is read when the module loads — import freshly for each fixture
  // (the query suffix bypasses the module cache).
  const quotaMit = async (inhalt, nr) => {
    const pfad = join(sandkasten, `quota${nr}.json`)
    if (inhalt !== null) writeFileSync(pfad, inhalt)
    process.env.CCHUB_QUOTA_JSON = pfad
    return import(`../server/quota.mjs?fixture=${nr}`)
  }

  await pruefe('reads percentages and reset time', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 91, resets_at: 1800000000 }, seven_day: { used_percentage: 10 },
    }), 1)
    const q = claudeQuota()
    gleich(q.five, 91, '5-hour value')
    gleich(q.seven, 10, '7-day value')
    wahr(typeof q.resets_at === 'string' && q.resets_at.includes('T'), 'reset as ISO time')
  })
  await pruefe('seven_day_fable takes precedence over seven_day', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 10 }, seven_day_fable: { used_percentage: 42 },
    }), 2)
    gleich(claudeQuota().seven, 42, '7-day value')
  })
  await pruefe('missing file blocks nothing (all null)', async () => {
    const { claudeQuota, claudeGateBlocked } = await quotaMit(null, 3)
    const q = claudeQuota()
    gleich(q.five, null, '5h')
    gleich(q.seven, null, '7d')
    falsch(claudeGateBlocked(q).blocked, 'gate stays open')
  })
  await pruefe('broken JSON blocks nothing (all null)', async () => {
    const { claudeQuota } = await quotaMit('{kein json', 4)
    gleich(claudeQuota().five, null, '5h')
  })
  await pruefe('thresholds: 5h from 90 %, 7d from 95 %', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 5)
    falsch(claudeGateBlocked({ five: 89, seven: 0 }).blocked, '89 % passes')
    wahr(claudeGateBlocked({ five: 90, seven: 0 }).blocked, '90 % blocks')
    falsch(claudeGateBlocked({ five: 0, seven: 94 }).blocked, '7d 94 % passes')
    wahr(claudeGateBlocked({ five: 0, seven: 95 }).blocked, '7d 95 % blocks')
  })
  await pruefe('a block states a reason', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 6)
    const g = claudeGateBlocked({ five: 97, seven: 0 })
    wahr(g.blocked && typeof g.reason === 'string' && g.reason.length > 0, 'reason present')
  })

  // ------------------------------------------------------------------
  gruppe('Platform suffix in the prompt (platformSuffix)')

  const { platformSuffix } = await import('../server/runner.mjs')
  const lauf = { id: 'abc-123', workdir_effective: '/pfad/zum/worktree', expected_minutes: 42 }

  await pruefe('fills all placeholders of the default template', () => {
    const t = platformSuffix(lauf, 'Lege einen neuen Branch an.', {})
    enthaelt(t, 'abc-123', 'run ID')
    enthaelt(t, '/pfad/zum/worktree', 'working directory')
    enthaelt(t, '42 min', 'expectation')
    enthaelt(t, 'Lege einen neuen Branch an.', 'branch rule')
    falsch(t.includes('{run_id}') || t.includes('{workdir}') || t.includes('{branch_rule}')
      || t.includes('{expected_minutes}'), 'no placeholder is left over')
  })
  await pruefe('names the agent\'s report-back channels', () => {
    const t = platformSuffix(lauf, 'egal', {})
    enthaelt(t, 'cc-report done', 'completion report')
    enthaelt(t, 'cc-report help', 'call for help')
  })
  await pruefe('custom template from the settings beats the default template', () => {
    const t = platformSuffix(lauf, 'REGEL', { prompt_suffix: 'Lauf {run_id} in {workdir}, max {expected_minutes} min. {branch_rule}' })
    gleich(t, 'Lauf abc-123 in /pfad/zum/worktree, max 42 min. REGEL', 'custom template')
  })
  await pruefe('empty template falls back to the default template', () => {
    enthaelt(platformSuffix(lauf, 'REGEL', { prompt_suffix: '' }), 'Platform rules', 'default template')
  })
  // ------------------------------------------------------------------
  gruppe('Model, provider and effort arguments for the harnesses')

  const { harnessModelArgs } = await import('../server/runner.mjs')
  const cfgAus = (args) => {
    const e = args.find(a => typeof a === 'string' && a.startsWith('OPENCODE_CONFIG_CONTENT='))
    return e ? JSON.parse(e.slice('OPENCODE_CONFIG_CONTENT='.length)) : null
  }
  const paar = (args, flagge) => args[args.indexOf(flagge) + 1]

  await pruefe('claude: model and reasoning effort as separate flags', () => {
    const { args } = harnessModelArgs({ harness: 'claude', model: 'opus', effort: 'max' })
    gleich(paar(args, '--model'), 'opus', 'model')
    gleich(paar(args, '--effort'), 'max', 'reasoning effort')
  })

  await pruefe('cursor: only --model, no provider and no --effort', () => {
    // With cursor the effort level is baked INTO the ID; cursor-agent has no --effort
    // at all. A passed-through effort must therefore NOT show up as a flag here.
    const { args, fehlt } = harnessModelArgs({ harness: 'cursor', model: 'claude-opus-5-xhigh' })
    gleich(paar(args, '--model'), 'claude-opus-5-xhigh', 'model verbatim')
    gleich(args.includes('--effort'), false, 'no --effort')
    gleich(args.includes('--provider'), false, 'no --provider')
    gleich(fehlt.length, 0, 'no missing key — cursor runs on its subscription')
    // Even with an effort set on the run, the flag stays absent (legacy data, harness switch).
    const b = harnessModelArgs({ harness: 'cursor', model: 'gpt-5.4-mini-low', effort: 'high' })
    gleich(b.args.includes('--effort'), false, 'effort on the run is not passed through')
  })

  await pruefe('hermes: model bare, provider and effort separate', () => {
    const { args } = harnessModelArgs({ harness: 'hermes', provider: 'openrouter', model: 'a/b', effort: 'high' })
    gleich(paar(args, '--model'), 'a/b', 'model without prefix')
    gleich(paar(args, '--provider'), 'openrouter', 'provider')
    gleich(paar(args, '--effort'), 'high', 'reasoning effort')
  })

  await pruefe('opencode: provider lives in the prefix — Zen is called "opencode" there', () => {
    gleich(paar(harnessModelArgs({ harness: 'opencode', provider: 'opencode-zen', model: 'hy3-free' }).args, '--model'),
      'opencode/hy3-free', 'Zen prefix')
    gleich(paar(harnessModelArgs({ harness: 'opencode', provider: 'deepseek', model: 'ds' }).args, '--model'),
      'deepseek/ds', 'DeepSeek prefix')
    gleich(paar(harnessModelArgs({ harness: 'opencode', provider: 'openrouter', model: 'a/b' }).args, '--model'),
      'openrouter/a/b', 'OpenRouter prefix with three parts')
  })

  await pruefe('opencode: effort NOT as a flag but in the configuration', () => {
    const { args } = harnessModelArgs({ harness: 'opencode', provider: 'deepseek', model: 'ds', effort: 'high' })
    falsch(args.includes('--effort'), 'no --effort (the TUI does not know it)')
    const cfg = cfgAus(args)
    // The variant only takes effect if the model is set in the same agent block.
    gleich(cfg?.agent?.build?.variant, 'high', 'variant')
    gleich(cfg?.agent?.build?.model, 'deepseek/ds', 'model in the same block')
  })

  await pruefe('opencode: provider pinning and effort share ONE --env block', () => {
    const { args } = harnessModelArgs({
      harness: 'opencode', provider: 'openrouter', model: 'a/b', or_provider: 'amazon-bedrock', effort: 'low',
    })
    gleich(args.filter(a => a === '--env').length, args.filter(a => typeof a === 'string' && a.includes('=')).length,
      'every --env flag has exactly one value')
    const cfg = cfgAus(args)
    gleich(cfg?.provider?.openrouter?.models?.['a/b']?.options?.provider?.order?.[0], 'amazon-bedrock', 'provider')
    gleich(cfg?.agent?.build?.variant, 'low', 'variant in the same JSON')
  })

  await pruefe('without provider and effort everything stays as before', () => {
    // Regression guard for existing agents: there 'model' is a free-form string.
    const { args } = harnessModelArgs({ harness: 'opencode', model: 'openrouter/a/b' })
    gleich(args.join(' '), '--model openrouter/a/b', 'passed through unchanged')
    gleich(harnessModelArgs({ harness: 'claude' }).args.length, 0, 'no model, no argument at all')
  })

  // ------------------------------------------------------------------
  gruppe('Detection: rate limit / provider errors (detect.mjs)')
  const { typVonClaudeFehler, typVonText, terminalText, scanneZeilen, scanneNeueBytes,
    transkriptFehler, bewerteLogTreffer } = await import('../server/detect.mjs')

  await pruefe('Claude\'s StopFailure enum is mapped completely', () => {
    gleich(typVonClaudeFehler('rate_limit'), 'rate_limit', 'rate_limit')
    gleich(typVonClaudeFehler('overloaded'), 'provider_error', 'overloaded')
    gleich(typVonClaudeFehler('server_error'), 'provider_error', 'server_error')
    gleich(typVonClaudeFehler('authentication_failed'), 'auth_error', 'auth')
    gleich(typVonClaudeFehler('oauth_org_not_allowed'), 'auth_error', 'oauth')
    gleich(typVonClaudeFehler('billing_error'), 'billing_error', 'billing')
    gleich(typVonClaudeFehler('account_on_hold'), 'billing_error', 'on hold')
    gleich(typVonClaudeFehler('model_not_found'), 'model_error', 'model')
    gleich(typVonClaudeFehler('max_output_tokens'), null, 'max_output_tokens is NOT a provider problem')
    gleich(typVonClaudeFehler('unknown'), 'unbekannt', 'unknown')
    gleich(typVonClaudeFehler('irgendwas_neues'), 'unbekannt', 'unknown enum value maps to unbekannt, no crash')
  })

  await pruefe('free text is classified in the right order', () => {
    gleich(typVonText('AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.'), 'rate_limit', 'opencode rate limit (real log text)')
    gleich(typVonText("You've hit your session limit · resets 8:36pm"), 'rate_limit', 'Claude subscription limit')
    gleich(typVonText('API Error: 429 Too Many Requests'), 'rate_limit', '429')
    gleich(typVonText('Overloaded'), 'provider_error', 'overloaded')
    gleich(typVonText('API Error: 529 overloaded_error'), 'provider_error', '529')
    gleich(typVonText('Please run /login · API Error: 403'), 'auth_error', '403 + login')
    gleich(typVonText('402 insufficient credits'), 'billing_error', '402 before the rate-limit check')
    gleich(typVonText('model_not_found: no such model'), 'model_error', 'model')
    gleich(typVonText('alles gut'), 'unbekannt', 'no match')
  })

  await pruefe('terminalText removes ANSI, OSC titles, and turns \\r into lines', () => {
    const roh = '\x1b]0;✳ Claude Code\x07\x1b[38;5;174m ▐\x1b[39m hallo\r\nzeile2\rzeile3\n'
    gleich(terminalText(roh), ' ▐ hallo\nzeile2\nzeile3\n', 'cleaned')
  })

  await pruefe('production false positive: "Upgrade to Max for higher rate limits" does NOT fire', () => {
    const zeilen = ['/upgrade   Upgrade to Max for higher rate limits and more Opus', 'Rate limits', '  rate limit  ']
    gleich(scanneZeilen('claude', zeilen).length, 0, 'menu text and bare heading')
  })

  await pruefe('agent working on the topic: grep/source code/tests do not fire', () => {
    const zeilen = [
      'grep -rn "rate limit" server/',
      "if (/rate limit|rate.limited/i.test(tail)) { db.prepare('UPDATE runs SET rate_limit_hits=1')",
      "it('meldet 429 als rate_limit', () => {",
      'const retryAfter = res.headers.get("retry-after") // 429',
    ]
    gleich(scanneZeilen('hermes', zeilen).length, 0, 'hermes patterns on source code')
    gleich(scanneZeilen('cursor', zeilen).length, 0, 'cursor patterns on source code')
    gleich(scanneZeilen('opencode', zeilen).length, 0, 'opencode patterns on source code')
  })

  await pruefe('real error texts per harness are recognized', () => {
    const c = scanneZeilen('claude', ["You've hit your session limit · resets 8:36pm (Europe/Berlin)", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'])
    gleich(c.map(t => t.typ).join(','), 'rate_limit,provider_error', 'claude')
    const o = scanneZeilen('opencode', ['AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.', 'AI_RetryError: Failed after 3 attempts'])
    gleich(o.map(t => t.typ).join(','), 'rate_limit,provider_error', 'opencode')
    const h = scanneZeilen('hermes', [
      '⏳ Retrying in 12.0s (rate limited by upstream provider (429))...',
      '⚠️  API call failed (attempt 2/5): APIConnectionError',
      '   ⏱️  upstream provider overloaded (529)',
    ])
    gleich(h.map(t => t.typ).join(','), 'rate_limit,provider_error,provider_error', 'hermes')
    wahr(h[0].zeile.includes('Retrying'), 'evidence is the line')
    // cursor: 'Cannot use this model' is the VERBATIM rejection of the CLI for an
    // unknown model ID (measured) — the most reliable match cursor provides.
    const u = scanneZeilen('cursor', [
      'Cannot use this model: gibtsnicht-9000. Available models: auto, gpt-5.2',
      'Error: 429 Too Many Requests',
      'You are not logged in. Please run cursor-agent login',
      'upstream connection error (503)',
    ])
    gleich(u.map(t => t.typ).join(','), 'model_error,rate_limit,auth_error,provider_error', 'cursor')
  })

  await pruefe('offset scan: incomplete trailing line is deferred, not consumed', () => {
    const teil1 = 'foo\n⚠️  API call failed (attempt 1/5): RateLimit'
    const r1 = scanneNeueBytes('hermes', teil1, 100)
    gleich(r1.treffer.length, 0, 'half a line does not count')
    gleich(r1.neuerOffset, 100 + Buffer.byteLength('foo\n'), 'offset points at the start of the half line')
    const teil2 = '⚠️  API call failed (attempt 1/5): RateLimitError (HTTP 429)\n'
    const r2 = scanneNeueBytes('hermes', teil2, r1.neuerOffset)
    gleich(r2.treffer.length, 1, 'complete → match')
    gleich(r2.treffer[0].typ, 'rate_limit', 'type')
    gleich(r2.neuerOffset, r1.neuerOffset + Buffer.byteLength(teil2), 'offset at the end')
  })

  await pruefe('offset scan: without a newline nothing moves', () => {
    const r = scanneNeueBytes('claude', 'nur ein Stück', 7)
    gleich(r.neuerOffset, 7, 'offset stays')
    gleich(r.treffer.length, 0, 'no match')
  })

  await pruefe('Claude transcript: isApiErrorMessage lines with enum and timestamp', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', error: 'rate_limit', timestamp: '2026-08-23T17:36:32.446Z', isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: "You've hit your session limit · resets 8:36pm" }] } }),
      JSON.stringify({ type: 'assistant', error: 'max_output_tokens', isApiErrorMessage: true, message: { content: 'x' } }),
      '{"kaputt": tru',
    ].join('\n')
    const f = transkriptFehler(jsonl)
    gleich(f.length, 1, 'exactly one relevant error (max_output_tokens and garbage ignored)')
    gleich(f[0].typ, 'rate_limit', 'type')
    gleich(f[0].ts, '2026-08-23T17:36:32.446Z', 'timestamp')
    enthaelt(f[0].text, 'session limit', 'text')
  })

  await pruefe('rating: a single match with continued work stays yellow', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 6 * 60_000 }), 'gelb', 'activity after the match')
  })
  await pruefe('rating: silence after the match turns red (the limit stands at the end)', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 5 * 60_000 }), 'rot', '5 min silent')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: null, jetztMs: t0 + 5 * 60_000 }), 'rot', 'activity never measured')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 2 * 60_000 }), 'gelb', 'only 2 min silent')
  })
  await pruefe('rating: repetition within 10 min turns red (retry loop)', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 3 * 60_000, letzteAktivitaetMs: t0 + 4 * 60_000, jetztMs: t0 + 4 * 60_000 }), 'rot', '2× in 3 min')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 40 * 60_000, letzteAktivitaetMs: t0 + 41 * 60_000, jetztMs: t0 + 41 * 60_000 }), 'gelb', '2× 40 min apart is not a loop')
  })

  // ------------------------------------------------------------------
  gruppe('Extra skills (zusaetze.mjs)')
  const zdir = join(sandkasten, 'zusaetze')
  process.env.CCHUB_ZUSAETZE_DIR = zdir
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(zdir, 'unlazy'), { recursive: true })
  writeFileSync(join(zdir, 'unlazy', 'SKILL.md'),
    '---\nname: unlazy\ndescription: Enforces completion discipline for lazy models.\n---\n\n# Unlazy\n')
  mkdirSync(join(zdir, 'ohne-skillmd'), { recursive: true })
  const { zusatzSkills, skillsAusFormular, skillPromptZusatz, skillListe } = await import('../server/zusaetze.mjs')

  await pruefe('folders with SKILL.md are found, frontmatter read, the rest ignored', () => {
    const l = zusatzSkills()
    gleich(l.length, 1, 'only the real skill')
    gleich(l[0].name, 'unlazy', 'folder name')
    gleich(l[0].titel, 'unlazy', 'frontmatter name')
    enthaelt(l[0].beschreibung, 'completion discipline', 'description')
    gleich(l[0].pfad, join(zdir, 'unlazy', 'SKILL.md'), 'full path')
  })
  await pruefe('form selection: only known names survive, empty becomes null', () => {
    gleich(skillsAusFormular({ skills_list: ['unlazy', 'boese-eingabe'] }), '["unlazy"]', 'filtered')
    gleich(skillsAusFormular({}), null, 'no selection → null')
    gleich(skillsAusFormular({ skills: 'unlazy' }), '["unlazy"]', 'single value without _list')
  })
  await pruefe('prompt addition names the full SKILL.md path and the directory', () => {
    const z = skillPromptZusatz('["unlazy"]')
    enthaelt(z, join(zdir, 'unlazy', 'SKILL.md'), 'full path')
    enthaelt(z, 'ENTIRE task', 'instruction to apply')
    gleich(skillPromptZusatz(null), '', 'no selection, no addition')
  })
  await pruefe('a selected but deleted skill is named honestly instead of dead-linked', () => {
    const z = skillPromptZusatz('["weg-damit"]')
    enthaelt(z, "'weg-damit'", 'name')
    enthaelt(z, 'no longer', 'hint')
  })
  await pruefe('broken JSON in the DB column does not crash', () => {
    gleich(skillListe('{kaputt').length, 0, 'empty')
  })
  await pruefe('slider: chosen depth goes into the DB as "unlazy:N" and into the prompt as "tree N"', () => {
    gleich(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '4' }), '["unlazy:4"]', 'encoded')
    const z = skillPromptZusatz('["unlazy:4"]')
    enthaelt(z, '"tree 4"', 'trigger from the SKILL.md')
    enthaelt(z, 'depth 4', 'plain text')
    enthaelt(z, 'SKILL.md', 'reference remains')
  })
  await pruefe('slider: unknown or tampered values fall back to "skill decides"', () => {
    gleich(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '9' }), '["unlazy"]', '9 does not exist')
    gleich(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '4; rm -rf' }), '["unlazy"]', 'garbage')
    gleich(skillsAusFormular({ skills: 'unlazy' }), '["unlazy"]', 'without slider')
    falsch(skillPromptZusatz('["unlazy"]').includes('tree'), 'no tree line without a value')
  })


  // ------------------------------------------------------------------
  gruppe('Plugin registries (coding agents + providers)')
  const { HARNESS_PLUGINS, harnessIds } = await import('../server/harnesses/index.mjs')
  const { PROVIDER_PLUGINS, getProvider, providerHasKey } = await import('../server/providers/index.mjs')

  await pruefe('every coding agent plugin carries the required fields', () => {
    for (const p of Object.values(HARNESS_PLUGINS)) {
      wahr(!!p.id && !!p.label && !!p.bin, `${p.id}: id/label/bin`)
      wahr(typeof p.subscription === 'boolean', `${p.id}: subscription flag`)
      wahr(Array.isArray(p.providers), `${p.id}: providers list`)
      wahr(Array.isArray(p.logPatterns) && p.logPatterns.length > 0, `${p.id}: log patterns`)
      wahr(typeof p.modelArgs === 'function', `${p.id}: modelArgs`)
      wahr(typeof p.effortOptions === 'function', `${p.id}: effortOptions`)
      wahr(typeof p.usage === 'function', `${p.id}: usage`)
      wahr(typeof p.pulseId === 'function', `${p.id}: pulseId`)
    }
    gleich(harnessIds().length, 4, 'four built-in coding agents')
  })
  await pruefe('harness provider references resolve to provider plugins', () => {
    for (const p of Object.values(HARNESS_PLUGINS)) {
      for (const id of p.providers) wahr(!!getProvider(id), `${p.id} -> ${id}`)
      for (const id of p.keyFreeProviders ?? []) wahr(p.providers.includes(id), `${p.id}: keyFree subset`)
      if (p.subscription) gleich(p.providers.length, 0, `${p.id}: subscription = no providers`)
    }
  })
  await pruefe('every provider plugin carries the required fields', () => {
    for (const p of Object.values(PROVIDER_PLUGINS)) {
      wahr(!!p.id && !!p.label, `${p.id}: id/label`)
      wahr(Array.isArray(p.envKeys), `${p.id}: envKeys`)
      wahr(typeof p.fetchModels === 'function', `${p.id}: fetchModels`)
      wahr(!!p.ocPrefix && !!p.mdKey, `${p.id}: ocPrefix/mdKey`)
      wahr(!!p.pulse?.url, `${p.id}: pulse target`)
    }
  })
  await pruefe('providerHasKey looks at the environment', () => {
    const alt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'test-key'
    wahr(providerHasKey('openrouter'), 'with key')
    delete process.env.OPENROUTER_API_KEY
    falsch(providerHasKey('openrouter'), 'without key')
    if (alt !== undefined) process.env.OPENROUTER_API_KEY = alt
  })

  // ------------------------------------------------------------------
  gruppe('i18n: catalogs and translation')
  const { t, setLanguage, _catalogs, LANGUAGES } = await import('../server/i18n.mjs')

  await pruefe('all languages have exactly the same keys as English', () => {
    const cats = _catalogs()
    const en = Object.keys(cats.en).sort()
    wahr(en.length > 100, 'English catalog is populated')
    for (const code of Object.keys(LANGUAGES)) {
      if (code === 'en') continue
      const keys = Object.keys(cats[code]).sort()
      const fehlen = en.filter(k => !keys.includes(k))
      const zuviel = keys.filter(k => !en.includes(k))
      gleich(fehlen.length, 0, `${code}: missing keys: ${fehlen.slice(0, 5).join(', ')}`)
      gleich(zuviel.length, 0, `${code}: extra keys: ${zuviel.slice(0, 5).join(', ')}`)
    }
  })
  await pruefe('no catalog entry is empty', () => {
    for (const [code, cat] of Object.entries(_catalogs())) {
      for (const [k, v] of Object.entries(cat)) wahr(String(v).trim().length > 0, `${code}:${k}`)
    }
  })
  await pruefe('t() translates, interpolates and falls back safely', () => {
    setLanguage('de')
    gleich(t('nav.overview'), 'Übersicht', 'German')
    gleich(t('usage.resets', { time: '12:00' }), 'Reset 12:00', 'interpolation')
    gleich(t('does.not.exist'), 'does.not.exist', 'unknown key returns the key')
    setLanguage('xx')
    gleich(t('nav.overview'), 'Overview', 'unknown language falls back to English')
    setLanguage('en')
  })

  // ------------------------------------------------------------------
  gruppe('Docs: AGENTS.md / CLAUDE.md pairing')

  await pruefe('every AGENTS.md has a CLAUDE.md next to it that only includes it', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('..', import.meta.url).pathname
    const skip = new Set(['node_modules', '.git', '.playwright-mcp'])
    const dirs = []
    const walk = (dir) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) { if (!skip.has(d.name)) walk(j(dir, d.name)); continue }
        if (d.name === 'AGENTS.md') dirs.push(dir)
      }
    }
    walk(root)
    wahr(dirs.length >= 1, 'at least the root AGENTS.md exists')
    for (const dir of dirs) {
      const claudeMd = j(dir, 'CLAUDE.md')
      wahr(existsSync(claudeMd), `${dir}: CLAUDE.md exists`)
      gleich(readFileSync(claudeMd, 'utf8').trim(), '@AGENTS.md', `${dir}: CLAUDE.md contains only the include`)
    }
  })

  // ------------------------------------------------------------------
  gruppe('Configured coding agents (coding-agents.mjs)')
  const ca = await import('../server/coding-agents.mjs')

  await pruefe('save validates against the plugin registry', () => {
    falsch(ca.saveCodingAgent({ harness: 'gpt' }).ok, 'unknown harness rejected')
    wahr(ca.saveCodingAgent({ harness: 'opencode', providers: ['opencode-zen', 'quatsch'] }).ok, 'known harness saved')
    const row = ca.codingAgentFor('opencode')
    gleich(JSON.stringify(row.providerIds), '["opencode-zen"]', 'unknown provider dropped')
    wahr(ca.isHarnessEnabled('opencode'), 'enabled')
    falsch(ca.isHarnessEnabled('claude'), 'not configured = not enabled')
  })
  await pruefe('seedIfEmpty only fills an empty table and skips invalid entries', async () => {
    const seed = join(sandkasten, 'seed.json')
    writeFileSync(seed, JSON.stringify({ coding_agents: [{ harness: 'claude' }, { harness: 'quatsch' }] }))
    process.env.CCHUB_AGENTS_SEED = seed
    gleich(ca.seedIfEmpty(), 0, 'table not empty: nothing seeded')
    ca.deleteCodingAgent(ca.codingAgentFor('opencode').id)
    gleich(ca.seedIfEmpty(), 1, 'empty table: valid entries seeded')
    wahr(ca.isHarnessEnabled('claude'), 'claude seeded')
    delete process.env.CCHUB_AGENTS_SEED
  })

} finally {
  rmSync(sandkasten, { recursive: true, force: true })
}

process.exit(bericht('Unit tests', start) || (zaehler.fehler.length ? 1 : 0))
