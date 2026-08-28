#!/usr/bin/env node
// cc-hub — unit tests for the functions with real logic and edge cases.
//
// Deliberately NOT tested: SQL strings, HTML snippets, CSS classes, column orders,
// exact message texts, private helper functions. Such tests would only cement the
// current implementation instead of securing behavior. What is tested is what
// computes or decides — schedules, cron, form parsing, quota gate, text processing.
//
// Usage:  node test/unit.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
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
    fmtDuration, parseDbUtc, fmtRelativeTime, fmtDateTime, kurzid } = await import('../server/util.mjs')
  const { parseForm, cookieRepo, rememberRepo } = await import('../server/web-helpers.mjs')

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
  gruppe('Repo choice cookie (web-helpers)')

  await pruefe('cookieRepo reads the cchub_repo value out of the Cookie header', () => {
    gleich(cookieRepo({ headers: { cookie: 'cchub_repo=7' } }), 7, 'bare')
    gleich(cookieRepo({ headers: { cookie: 'other=1; cchub_repo=7' } }), 7, 'among other cookies')
    gleich(cookieRepo({ headers: { cookie: 'other=1; cchub_repo=7; x=y' } }), 7, 'with a trailing cookie')
    gleich(cookieRepo({ headers: { cookie: 'cchub_repo=abc' } }), null, 'non-numeric value')
    gleich(cookieRepo({ headers: { cookie: 'cchub_repo=' } }), null, 'empty value')
    gleich(cookieRepo({ headers: {} }), null, 'no Cookie header at all')
  })
  await pruefe('rememberRepo writes a long-lived cchub_repo cookie', () => {
    let gesetzt = null
    rememberRepo({ setHeader: (k, v) => { gesetzt = [k, v] } }, 3)
    gleich(gesetzt[0], 'set-cookie', 'header name')
    enthaelt(gesetzt[1], 'cchub_repo=3', 'value')
    enthaelt(gesetzt[1], 'Max-Age=31536000', 'long-lived — the choice stays until it is changed')
    enthaelt(gesetzt[1], 'Path=/', 'valid on every page')
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
  await pruefe('parseDbUtc treats naive SQLite timestamps as UTC', () => {
    gleich(parseDbUtc('2026-08-25 12:00:00'), Date.parse('2026-08-25T12:00:00Z'), 'space form')
    gleich(parseDbUtc('2026-08-25T12:00:00Z'), Date.parse('2026-08-25T12:00:00Z'), 'already ISO')
    wahr(Number.isNaN(parseDbUtc(null)), 'null')
    wahr(Number.isNaN(parseDbUtc('')), 'empty')
  })
  await pruefe('fmtRelativeTime picks the unit and follows the UI locale', () => {
    const now = Date.parse('2026-08-25T12:00:00Z')
    gleich(fmtRelativeTime(now, now, 'en'), 'now', 'zero seconds')
    gleich(fmtRelativeTime(now - 4000, now, 'en'), '4 seconds ago', 'seconds, English')
    gleich(fmtRelativeTime(now - 4000, now, 'de'), 'vor 4 Sekunden', 'seconds, German')
    gleich(fmtRelativeTime(now - 60_000, now, 'en'), '1 minute ago', 'one minute')
    gleich(fmtRelativeTime(now - 4 * 60_000, now, 'de'), 'vor 4 Minuten', 'minutes, German')
    gleich(fmtRelativeTime(now - 2 * 3600_000, now, 'en'), '2 hours ago', 'hours')
    gleich(fmtRelativeTime(now - 86400_000, now, 'en'), 'yesterday', 'one day, auto numeric')
    gleich(fmtRelativeTime(NaN, now, 'en'), '–', 'invalid then')
  })
  await pruefe('fmtRelativeTime also looks forward — a planned run starts, it did not start', () => {
    const now = Date.parse('2026-08-25T12:00:00Z')
    gleich(fmtRelativeTime(now + 20 * 60_000, now, 'en'), 'in 20 minutes', 'minutes ahead')
    gleich(fmtRelativeTime(now + 20 * 60_000, now, 'de'), 'in 20 Minuten', 'minutes ahead, German')
    gleich(fmtRelativeTime(now + 3 * 3600_000, now, 'en'), 'in 3 hours', 'hours ahead')
    gleich(fmtRelativeTime(now + 86400_000, now, 'en'), 'tomorrow', 'one day ahead, auto numeric')
  })
  await pruefe('fmtDateTime is a locale date-time, not a relative phrase', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    const de = fmtDateTime(ms, 'de')
    wahr(de.includes('25.08.2026'), 'German date: ' + de)
    wahr(/\d{2}:\d{2}:\d{2}/.test(de), 'has a clock time: ' + de)
    gleich(fmtDateTime(NaN, 'en'), '', 'invalid')
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
  await pruefe('float artifacts in used_percentage are rounded to one decimal', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 28.000000000000004 }, seven_day: { used_percentage: 32 }, seven_day_fable: { used_percentage: 35.0 },
    }), 8)
    const q = claudeQuota()
    gleich(q.five, 28, '5h float artifact rounded')
    gleich(q.seven_general, 32, '7d stays clean')
    gleich(q.seven_fable, 35, 'fable week stays clean')
    gleich(q.seven, 35, 'gate value is the rounded maximum')
  })
  await pruefe('both 7-day windows are reported; the gate value is the higher one', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 10 }, seven_day_fable: { used_percentage: 42 },
    }), 2)
    const q = claudeQuota()
    gleich(q.seven_general, 10, 'general week')
    gleich(q.seven_fable, 42, 'fable week')
    gleich(q.seven, 42, 'the fuller window is the binding one')
  })
  await pruefe('a week claude does not report at all stays null', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 5 }, seven_day_fable: { used_percentage: 35 },
    }), 7)
    const q = claudeQuota()
    gleich(q.seven_general, null, 'no general week in the file')
    gleich(q.seven_fable, 35, 'fable week')
    gleich(q.seven, 35, 'gate value comes from the only window there is')
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
  await pruefe('the operator\'s own rules are an ADDITION and cannot delete the finishing command', () => {
    // This field used to REPLACE the whole block. It is called a suffix, it
    // starts out empty and it looks like a free notepad — so the day somebody
    // wrote their working rules into it, every prompt on this hub silently lost
    // "at the end always cc-report done". The runs kept working and kept not
    // reporting; one of them held up the queue for a day.
    const t = platformSuffix(lauf, 'REGEL', { prompt_suffix: 'Immer Tests schreiben. Lauf {run_id}.' })
    enthaelt(t, 'Immer Tests schreiben.', 'the addition is there')
    enthaelt(t, 'Lauf abc-123.', 'and its placeholders are filled too')
    enthaelt(t, 'Platform rules', 'the platform rules stay')
    enthaelt(t, 'cc-report done --file', 'and so does the finishing command')
    wahr(t.indexOf('Immer Tests schreiben.') < t.indexOf('HOW THIS RUN ENDS'),
      'how the run ends stands last — that is what runs fail on')
  })
  await pruefe('an empty field adds nothing at all', () => {
    const leer = platformSuffix(lauf, 'REGEL', { prompt_suffix: '   ' })
    gleich(leer, platformSuffix(lauf, 'REGEL', {}), 'whitespace is not a rule')
    falsch(leer.includes('Operator rules'), 'no empty section header')
  })
  await pruefe('the finishing command names a concrete file outside the working directory', () => {
    // A run died of a vague instruction: "cc-report done --file <report.md>" left
    // both the path and the fact that it is mandatory to the model's judgement.
    // Now the command is copy-and-paste ready — and the file lies next to the
    // run's log, not in the worktree, which a report file would leave dirty.
    const t = platformSuffix(lauf, 'egal', {})
    enthaelt(t, 'cc-report done --file /', 'absolute path in the command')
    enthaelt(t, 'abc-123/report.md', 'the run\'s own report file')
    falsch(t.includes('{report_file}'), 'placeholder is resolved')
    falsch(t.includes(`${lauf.workdir_effective}/report.md`), 'not inside the worktree')
  })
  await pruefe('the harness adds its own rules — even to a custom template', () => {
    // The settings field REPLACES the platform rules (that is what it is for),
    // but the harness lines describe the machine, not the operator's house
    // rules: cursor has to be told that its turn ending closes the run.
    const cu = { ...lauf, harness: 'cursor' }
    enthaelt(platformSuffix(cu, 'egal', {}), 'cursor-agent', 'harness rules in the default template')
    enthaelt(platformSuffix(cu, 'egal', { prompt_suffix: 'nur das hier' }), 'cursor-agent', '… and in a custom one')
    falsch(platformSuffix({ ...lauf, harness: 'claude' }, 'egal', {}).includes('cursor-agent'),
      'other harnesses do not get cursor\'s rules')
  })
  // ------------------------------------------------------------------
  gruppe('Repo prompt in the run prompt (repoPromptZusatz)')

  const { repoPromptZusatz } = await import('../server/runner.mjs')

  await pruefe('no prompt adds nothing', () => {
    gleich(repoPromptZusatz(null), '', 'null')
    gleich(repoPromptZusatz(''), '', 'empty')
    gleich(repoPromptZusatz('   \n  '), '', 'whitespace only')
  })
  await pruefe('a prompt becomes a labeled section', () => {
    const t = repoPromptZusatz('Always write tests for this repo.')
    enthaelt(t, 'Always write tests for this repo.', 'content is passed through verbatim')
    enthaelt(t, 'Repository context', 'the section is labeled')
    gleich(t.split('\n')[0], 'Repository context (applies to every run of this repo):', 'label line')
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
  gruppe('cursor: when is a run over? (hooks + transcript)')

  const { stateFromJsonl, projectDirs } = await import('../server/cursor-transcript.mjs')
  const { harnessOwnedPaths, writeHarnessHooks } = await import('../server/runner.mjs')
  const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
  const line = (o) => JSON.stringify(o)
  const answer = (text) => line({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
  const TURN_END = line({ type: 'turn_ended', status: 'success' })

  await pruefe('only cursor ends its run with the turn — its TUI stays standing', () => {
    // claude and opencode have a dying process, a hook and a plugin channel;
    // cursor has none of that, which is exactly why this flag exists.
    gleich(HP.cursor.turnEndsRun, true, 'cursor')
    for (const id of ['claude', 'opencode', 'hermes']) {
      falsch(!!HP[id].turnEndsRun, `${id} keeps its turn end a note`)
    }
  })

  await pruefe('the hook file is cursor\'s format, not claude\'s', () => {
    // cursor wants a flat list of { command } per event. claude's
    // { matcher, hooks: [...] } shape would be rejected — and a rejected hook
    // file is exactly the silent failure this whole detection is about.
    const [datei, ...weitere] = HP.cursor.hookFiles({ ccReport: '/bin/cc-report' })
    gleich(weitere.length, 0, 'one file')
    gleich(datei.path, '.cursor/hooks.json', 'in the workspace, where cursor looks')
    const j = JSON.parse(datei.content)
    gleich(j.hooks.stop[0].command, '/bin/cc-report _turn_end', 'stop reports the turn end')
    enthaelt(j.hooks.sessionEnd[0].command, '_exit', 'sessionEnd is the second net')
    enthaelt(j.hooks.sessionEnd[0].command, 'setsid', 'a dying process must not take the hook with it')
    falsch(JSON.stringify(j).includes('"matcher"'), 'no claude shape')
  })

  await pruefe('the hub knows the hook file is its own, not the agent\'s work', () => {
    // Otherwise every cursor worktree counts as dirty forever and is never
    // removed — the same trap the worktree extras once fell into.
    gleich(harnessOwnedPaths('cursor').join(','), '.cursor', 'cursor')
    gleich(harnessOwnedPaths('claude').length, 0, 'claude brings nothing into the worktree')
  })

  await pruefe('an existing hooks.json is never overwritten', () => {
    const wt = join(sandkasten, 'wt-hooks')
    mkdirSync(wt, { recursive: true })
    gleich(writeHarnessHooks('cursor', wt).join(','), '.cursor/hooks.json', 'the folder is created along with it')
    writeFileSync(join(wt, '.cursor', 'hooks.json'), '{"mine":true}')
    gleich(writeHarnessHooks('cursor', wt).join(','), '', 'a repo\'s own hooks stay untouched')
    gleich(readFileSync(join(wt, '.cursor', 'hooks.json'), 'utf8'), '{"mine":true}', 'and unchanged')
  })

  await pruefe('a turn is over when turn_ended is the LAST record', () => {
    const s = stateFromJsonl([answer('Done, pushed as abc1234.'), TURN_END].join('\n'))
    gleich(s.turnEnded, 'success', 'ended')
    gleich(s.lastAnswer, 'Done, pushed as abc1234.', 'the agent\'s closing words become the report')
  })
  await pruefe('a follow-up makes the earlier turn end history again', () => {
    // The operator types into the terminal, or a flow messages the agent: the
    // run goes on and must not be closed under it.
    const s = stateFromJsonl([answer('first part'), TURN_END,
      line({ role: 'user', message: { content: [{ type: 'text', text: 'and now this too' }] } }),
      answer('second part')].join('\n'))
    gleich(s.turnEnded, null, 'not ended')
    gleich(s.lastAnswer, 'second part', 'the newer answer')
  })
  await pruefe('a running turn and a broken line are not an end', () => {
    gleich(stateFromJsonl(answer('still working')).turnEnded, null, 'still working')
    gleich(stateFromJsonl('').turnEnded, null, 'empty')
    gleich(stateFromJsonl('{"type":"turn_en').turnEnded, null, 'half a line — the next pass gets it whole')
    gleich(stateFromJsonl(`${answer('a')}\n{"type":"turn_e`).lastAnswer, 'a', 'the complete lines still count')
  })
  await pruefe('tool calls without text do not overwrite the closing words', () => {
    const toolCall = line({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: {} }] } })
    gleich(stateFromJsonl([answer('my report'), toolCall, TURN_END].join('\n')).lastAnswer, 'my report', 'text wins')
  })

  await pruefe('the transcript directory follows cursor\'s own slug rule', () => {
    process.env.CCHUB_CURSOR_DIR = '/c'
    try {
      gleich(projectDirs('/srv/agents/worktrees/repo/ab12-detached')[0],
        '/c/projects/srv-agents-worktrees-repo-ab12-detached', 'non-alphanumeric becomes -, ends trimmed')
      gleich(projectDirs('')[0], undefined, 'no directory, no guess')
      // Over 92 characters cursor shortens to 84 plus 7 hex of its own sha256.
      // Both variants are returned so a rename does not blind the hub silently.
      const long = projectDirs('/srv/' + 'x'.repeat(120))
      gleich(long.length, 2, 'plain form and shortened form')
      gleich(long[1].length, 92, 'the shortened one is exactly 92 characters')
      wahr(/-[0-9a-f]{7}$/.test(long[1]), 'with the hash cursor appends')
    } finally { delete process.env.CCHUB_CURSOR_DIR }
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

  // All three lines below opened an incident on ONE real cursor run (2026-08-25):
  // a token count read as a 5xx, the hub's own section heading read as a rate
  // limit, and the e2e suite's success line read as a rejected model.
  await pruefe('production false positives: cursor status line, hub UI text and test output do NOT fire', () => {
    const zeilen = [
      '⠠⠛ Globbing  555 tokens',
      '⠀⠞ Running  597 tokens',
      'Incidents: rate limit and provider errors (auto-alarm)',
      '✓ cursor: run passes through the pipeline and "Cannot use this model" is detected',
      '✓ hook report (cc-report _api_error via stdin) → RED; rate limit counter increments',
      // These two — this file's own lines — turned a running claude agent red.
      "    gleich(scanneZeilen('cursor', ['API Error: 503', 'upstream connection error (502)']).length, 2, 'real status codes')",
      "    const c = scanneZeilen('claude', [\"You've hit your session limit · resets 8:36pm (Europe/Berlin)\"])",
    ]
    for (const h of ['cursor', 'hermes', 'opencode', 'claude']) {
      gleich(scanneZeilen(h, zeilen).length, 0, `${h}: no match`)
    }
  })

  await pruefe('a bare 5xx number is not a status code — an error word has to stand next to it', () => {
    gleich(scanneZeilen('cursor', ['reading 512 lines', 'chunk 500 of 900', 'saved 503 bytes']).length, 0, 'plain numbers')
    gleich(scanneZeilen('cursor', ['API Error: 503', 'upstream connection error (502)']).length, 2, 'real status codes')
    gleich(typVonText('500 Internal Server Error'), 'provider_error', 'status + text')
    gleich(typVonText('processed 555 tokens'), 'unbekannt', 'token count is not a 5xx')
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
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 2 * 60_000 }), 'gelb', 'only 2 min silent')
  })
  // Regression: cursor and hermes have NO activity source (measureActivity
  // returns nothing for them), so null was permanently true here — every yellow
  // log hit on those two turned red 5 min later while the agent was working.
  await pruefe('rating: unmeasured activity is unknown, not silence — it never escalates', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: null, jetztMs: t0 + 5 * 60_000 }), 'gelb', 'no activity source: stays yellow')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: null, jetztMs: t0 + 3 * 3600_000 }), 'gelb', 'even after hours')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 60_000, letzteAktivitaetMs: null, jetztMs: t0 + 2 * 60_000 }), 'rot', 'repetition still escalates')
  })
  await pruefe('rating: repetition within 10 min turns red (retry loop)', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 3 * 60_000, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 4 * 60_000 }), 'rot', '2× in 3 min')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 3 * 60_000, letzteAktivitaetMs: null, jetztMs: t0 + 4 * 60_000 }), 'rot', '… also without an activity source (cursor/hermes)')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 40 * 60_000, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 41 * 60_000 }), 'gelb', '2× 40 min apart is not a loop')
  })
  // Regression: an agent that scrolls through source code about API errors
  // produced five hits in two minutes — the repetition path made its run red
  // while it was working normally.
  await pruefe('rating: work AFTER the last match vetoes every escalation', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 5, erstGesehenMs: t0, zuletztGesehenMs: t0 + 2 * 60_000, letzteAktivitaetMs: t0 + 3 * 60_000, jetztMs: t0 + 4 * 60_000 }), 'gelb', '5× but the agent kept working')
    gleich(bewerteLogTreffer({ anzahl: 5, erstGesehenMs: t0, zuletztGesehenMs: t0 + 2 * 60_000, letzteAktivitaetMs: t0 + 3 * 60_000, jetztMs: t0 + 60 * 60_000 }), 'gelb', 'and an hour later still not')
    gleich(bewerteLogTreffer({ anzahl: 5, erstGesehenMs: t0, zuletztGesehenMs: t0 + 2 * 60_000, letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 4 * 60_000 }), 'rot', 'no work after the last match: the loop stands')
  })

  // ------------------------------------------------------------------
  gruppe('Incidents: needs a human vs. merely noticed (brauchtMensch)')
  const { brauchtMensch } = await import('../server/incidents.mjs')

  await pruefe('login, credits and model always need a human — they never clear themselves', () => {
    for (const typ of ['auth_error', 'billing_error', 'model_error']) {
      wahr(brauchtMensch({ typ, schwere: 'gelb' }, 'running'), `${typ} while running`)
      wahr(brauchtMensch({ typ, schwere: 'gelb' }, 'done'), `${typ} on a finished run`)
    }
  })

  await pruefe('rate limit and provider errors are observations while the run lives or came through', () => {
    for (const typ of ['rate_limit', 'provider_error', 'unbekannt']) {
      falsch(brauchtMensch({ typ, schwere: 'rot' }, 'running'), `${typ} while running`)
      falsch(brauchtMensch({ typ, schwere: 'rot' }, 'done'), `${typ} on a finished run`)
    }
  })

  await pruefe('a confirmed incident on a run that did NOT come through is a to-do', () => {
    wahr(brauchtMensch({ typ: 'rate_limit', schwere: 'rot' }, 'failed'), 'red + failed')
    wahr(brauchtMensch({ typ: 'provider_error', schwere: 'rot' }, 'aborted'), 'red + aborted')
    falsch(brauchtMensch({ typ: 'rate_limit', schwere: 'gelb' }, 'failed'), 'a mere suspicion is not')
  })

  await pruefe('a global incident (provider pulse, no run) is not a to-do either', () => {
    falsch(brauchtMensch({ typ: 'provider_down:openrouter', schwere: 'rot' }), 'nobody can fix a provider outage')
    wahr(brauchtMensch({ typ: 'billing_error', schwere: 'rot' }), 'global billing still needs a human')
  })

  // ------------------------------------------------------------------
  gruppe('Extra skills (zusaetze.mjs)')
  const zdir = join(sandkasten, 'zusaetze')
  process.env.CCHUB_ZUSAETZE_DIR = zdir
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

  // ---- balance(): the normalized shape (docs/plugins.md) ----
  // ctx is injected, so these run without a network and without a key file.
  const ctxMit = (antwort, env = {}) => ({ json: async () => antwort, registry: async () => ({}), env })

  await pruefe('a provider balance keeps every currency apart', async () => {
    // DeepSeek reports strings and one entry PER currency — folding them into a
    // single figure would silently drop one of the two pots.
    const d = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '15.50', granted_balance: '0.50', topped_up_balance: '15.00' },
      ],
    }, { DEEPSEEK_API_KEY: 'k' }))
    gleich(d.amounts.length, 2, 'both currencies survive')
    gleich(d.amounts[0].currency, 'CNY', 'currency carried')
    gleich(d.amounts[0].remaining, 110, 'string parsed to a number')
    gleich(d.amounts[1].granted, 0.5, 'granted parsed too')
    wahr(d.available === true, 'the provider\'s own verdict is carried')
  })
  await pruefe('a provider that reports nothing usable answers null, not zero', async () => {
    const leer = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({ balance_infos: [] }, { DEEPSEEK_API_KEY: 'k' }))
    wahr(leer === null, 'no amounts and no verdict = no answer')
    const ohne = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({}, {}))
    wahr(ohne === null, 'no key = nothing to report')
    const kaputt = await PROVIDER_PLUGINS.openrouter.balance(
      ctxMit({ data: { total_credits: 'x', total_usage: null } }, { OPENROUTER_API_KEY: 'k' }))
    wahr(kaputt === null, 'unusable numbers are no balance')
  })
  await pruefe('an exhausted account is stated even when a figure remains', async () => {
    const d = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: '2.00', granted_balance: '2.00', topped_up_balance: '0' }],
    }, { DEEPSEEK_API_KEY: 'k' }))
    wahr(d.available === false, 'expired promotional credit still shows a number')
    gleich(d.amounts[0].remaining, 2, 'and the number is reported as it stands')
  })
  await pruefe('OpenRouter reports one pot, in dollars, with no verdict', async () => {
    const d = await PROVIDER_PLUGINS.openrouter.balance(
      ctxMit({ data: { total_credits: 20, total_usage: 7.125 } }, { OPENROUTER_API_KEY: 'k' }))
    gleich(d.amounts.length, 1, 'one pot')
    gleich(d.amounts[0].currency, 'USD', 'dollars, despite the _eur in the old setting name')
    gleich(d.amounts[0].remaining, 12.88, 'credits minus usage, rounded to cents')
    wahr(d.available === null, 'not reported is not the same as fine')
  })
  await pruefe('remainingIn picks one currency and never guesses', async () => {
    const { remainingIn } = await import('../server/balances.mjs')
    const b = { amounts: [{ currency: 'CNY', remaining: 110 }, { currency: 'USD', remaining: 15.5 }] }
    gleich(remainingIn(b, 'USD'), 15.5, 'the asked-for currency')
    wahr(remainingIn(b, 'EUR') === null, 'an unknown currency is null, not 0')
    wahr(remainingIn(null) === null, 'no balance is null, not 0')
  })
  await pruefe('providerHasKey looks at the environment', () => {
    const alt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'test-key'
    wahr(providerHasKey('openrouter'), 'with key')
    delete process.env.OPENROUTER_API_KEY
    falsch(providerHasKey('openrouter'), 'without key')
    if (alt !== undefined) process.env.OPENROUTER_API_KEY = alt
  })

  // The included amount is the point here: it comes from Cursor's own period
  // endpoint (cents), so no plan has to be guessed. Fetch is stubbed — the test
  // must never talk to api2.cursor.sh.
  await pruefe('cursor usage() takes spend, included amount and cycle from GetCurrentPeriodUsage', async () => {
    const auth = join(sandkasten, 'cursor-auth.json')
    writeFileSync(auth, JSON.stringify({ accessToken: 'tok' }))
    const altAuth = process.env.CCHUB_CURSOR_AUTH
    process.env.CCHUB_CURSOR_AUTH = auth
    const echt = globalThis.fetch
    globalThis.fetch = async (url) => {
      const antwort = String(url).endsWith('GetCurrentPeriodUsage')
        ? { planUsage: { totalSpend: 13, remaining: 1987, limit: 2000 }, billingCycleEnd: '1789404355000' }
        : String(url).endsWith('GetAggregatedUsageEvents')
          ? { totalCostCents: 14, aggregations: [{ modelIntent: 'auto', totalCents: 13 }] }
          : { membershipType: 'pro' }
      return { ok: true, json: async () => antwort }
    }
    try {
      const d = await HARNESS_PLUGINS.cursor.usage()
      gleich(d.plan, 'pro', 'plan')
      gleich(d.included_usd, 20, 'included amount in dollars, from the server')
      gleich(d.spent_usd, 0.13, 'spend belongs to the same source as the limit')
      gleich(d.remaining_usd, 19.87, 'remaining')
      gleich(d.cycle_end, '2026-09-14T16:45:55.000Z', 'cycle end')
    } finally {
      globalThis.fetch = echt
      if (altAuth === undefined) delete process.env.CCHUB_CURSOR_AUTH
      else process.env.CCHUB_CURSOR_AUTH = altAuth
    }
  })
  await pruefe('cursor model list puts "auto" first and marks it', async () => {
    const bin = join(sandkasten, 'bin-cursor')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'cursor-agent'),
      '#!/bin/sh\necho "Available models"\necho ""\necho "zeta-1 - Zeta"\necho "auto - Auto (default)"\necho "alpha-1-fast - Alpha Fast"\n')
    chmodSync(join(bin, 'cursor-agent'), 0o755)
    const altPath = process.env.PATH
    process.env.PATH = `${bin}:${altPath}`
    try {
      const liste = await HARNESS_PLUGINS.cursor.fetchModels()
      gleich(liste[0].id, 'auto', 'auto first, before every sorted ID')
      wahr(liste[0].auto === true, 'marked as auto')
      gleich(liste.at(-1).id, 'alpha-1-fast', 'fast still sorts last')
      falsch(liste[1].auto, 'nothing else is auto')
    } finally { process.env.PATH = altPath }
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
  // Identical keys is not the same as identical meaning: a translation that
  // drops a {placeholder} renders a sentence with a hole in it, and one that
  // invents a name renders the name in braces. Both pass the key check above.
  await pruefe('every translation carries exactly the placeholders English does', () => {
    // A doubled brace is a flow template ({{path}}), not an interpolation slot —
    // t() leaves those alone, and their inner word is translated on purpose.
    const slots = (s) => [...String(s).matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map(m => m[1]).sort().join(',')
    const cats = _catalogs()
    for (const [key, text] of Object.entries(cats.en)) {
      const soll = slots(text)
      for (const code of Object.keys(LANGUAGES)) {
        if (code === 'en') continue
        gleich(slots(cats[code][key]), soll, `${code}:${key} placeholders`)
      }
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
  gruppe('Flows: templates, operators, triggers, validation')
  const tpl = await import('../server/flows/template.mjs')
  const { validateDefinition, defaultProps } = await import('../server/flows/steps.mjs')
  const { flowsForRun, normalizeTrigger } = await import('../server/flows/triggers.mjs')
  const att = await import('../server/flows/attach.mjs')
  const { schemaFromFields } = await import('../server/flows/llm.mjs')

  const ctx = { trigger: { run: { id: 'r1', outcome: 'done', report: 'all good', agent_name: 'nightly', n: 3 } }, vars: { x: { y: 'deep' }, list: ['a', 'b'] } }
  await pruefe('render substitutes paths, objects as JSON, missing as empty', () => {
    gleich(tpl.render('run {{trigger.run.id}} → {{ trigger.run.outcome }}', ctx), 'run r1 → done', 'two placeholders')
    gleich(tpl.render('{{vars.x.y}}/{{vars.nope}}/{{vars.x.nope.deeper}}', ctx), 'deep//', 'missing values render empty')
    gleich(tpl.render('{{vars.list}}', ctx), '[\n  "a",\n  "b"\n]', 'arrays as JSON')
    gleich(tpl.render('{{vars.nope | default: fallback}}', ctx), 'fallback', 'default filter on empty')
    gleich(tpl.render('{{trigger.run.n | default: 0}}', ctx), '3', 'default not used when set')
    gleich(tpl.render(null, ctx), '', 'null template')
  })
  await pruefe('resolve keeps the type of a whole-value placeholder', () => {
    gleich(tpl.resolve('{{trigger.run.n}}', ctx), 3, 'number stays number')
    gleich(JSON.stringify(tpl.resolve(' {{vars.x}} ', ctx)), '{"y":"deep"}', 'object stays object')
    gleich(tpl.resolve('n={{trigger.run.n}}', ctx), 'n=3', 'mixed text renders')
  })
  await pruefe('compare: operators', () => {
    wahr(tpl.compare('Done', 'eq', 'done'), 'eq is case-insensitive')
    wahr(tpl.compare('done', 'neq', 'failed'), 'neq')
    wahr(tpl.compare('all good here', 'contains', 'GOOD'), 'contains')
    falsch(tpl.compare('all good', 'not_contains', 'good'), 'not_contains')
    wahr(tpl.compare('', 'empty', ''), 'empty'); wahr(tpl.compare(undefined, 'empty', ''), 'undefined is empty')
    wahr(tpl.compare('x', 'not_empty', ''), 'not_empty')
    wahr(tpl.compare('yes', 'truthy', ''), 'truthy yes'); falsch(tpl.compare('false', 'truthy', ''), 'string false is not truthy')
    wahr(tpl.compare(true, 'truthy', ''), 'boolean true'); wahr(tpl.compare([], 'falsy', ''), 'empty list is falsy')
    wahr(tpl.compare('12', 'gt', '9'), 'gt numeric, not lexical'); wahr(tpl.compare(5, 'lte', '5'), 'lte')
    falsch(tpl.compare('abc', 'gt', '1'), 'NaN never greater')
    wahr(tpl.compare('feature/x-12', 'matches', '^feature/'), 'regex'); falsch(tpl.compare('a', 'matches', '('), 'broken regex is false')
    falsch(tpl.compare('a', 'bogus', 'a'), 'unknown operator is false')
  })
  await pruefe('setPath / varName', () => {
    const o = {}; tpl.setPath(o, 'a.b.c', 1); gleich(o.a.b.c, 1, 'nested create')
    tpl.setPath(o, 'a.b', 'flat'); gleich(o.a.b, 'flat', 'overwrite')
    gleich(tpl.varName(' my var! ', 'x'), 'my_var_', 'sanitized'); gleich(tpl.varName('', 'fallback'), 'fallback', 'fallback')
  })
  await pruefe('toList: arrays, JSON, lines, junk', () => {
    gleich(tpl.toList(['a', 'b']).join(','), 'a,b', 'array stays')
    gleich(tpl.toList('["a","b"]').join(','), 'a,b', 'JSON list')
    gleich(tpl.toList('a\n b \n\nc').join(','), 'a,b,c', 'one item per line, trimmed, blanks dropped')
    gleich(tpl.toList('[broken').join(','), '[broken', 'broken JSON counts as text')
    gleich(tpl.toList('').length, 0, 'empty text'); gleich(tpl.toList(null).length, 0, 'null')
    gleich(tpl.toList({ a: 1 }).length, 1, 'a single object is one element')
  })
  await pruefe('attachments: parsing, conditions, and what the old trigger filters became', () => {
    gleich(att.parseAttachments(null).length, 0, 'nothing attached')
    gleich(att.parseAttachments('[broken').length, 0, 'broken JSON never throws')
    gleich(att.parseAttachments('[{"flowId":"3"}]')[0].when, 'always', 'missing condition = always')
    gleich(att.parseAttachments([{ flowId: 3 }, { flowId: 3, when: 'failed' }]).length, 1, 'a flow hangs on a run only once')
    gleich(att.parseAttachments([{ flowId: 3, when: 'nonsense' }])[0].when, 'always', 'unknown condition = always')
    gleich(att.serializeAttachments([]), null, 'empty stays NULL in the column')
    wahr(att.attachmentFires({ when: 'always' }, 'aborted'), 'always covers every outcome')
    wahr(att.attachmentFires({ when: 'not_done' }, 'aborted') && att.attachmentFires({ when: 'not_done' }, 'failed'), 'not_done covers both')
    falsch(att.attachmentFires({ when: 'not_done' }, 'done'), 'but not a success')
    falsch(att.attachmentFires({ when: 'done' }, 'failed'), 'a single outcome is exact')
    gleich(att.whenFromOutcomes(['aborted', 'failed', 'done']), 'always', 'the old full outcome list is "always"')
    gleich(att.whenFromOutcomes(['failed']), 'failed', 'and a one-element list its condition')
  })
  await pruefe('flowsForRun: the attachment is the trigger, the flow only has to be ready', () => {
    const flows = [
      { id: 1, name: 'notify', active: 1, trigger: { kind: 'run_finished' } },
      { id: 2, name: 'nightly', active: 1, trigger: { kind: 'cron', expr: '* * * * *' } },
      { id: 3, name: 'off', active: 0, trigger: { kind: 'run_finished' } },
    ]
    const run = { flows: JSON.stringify([{ flowId: 1, when: 'failed' }, { flowId: 2, when: 'always' }, { flowId: 3, when: 'always' }]) }
    gleich(flowsForRun(run, 'failed', flows).map(f => f.id).join(','), '1', 'condition, trigger kind and active flag all have to hold')
    gleich(flowsForRun(run, 'done', flows).length, 0, 'the condition excludes the outcome')
    gleich(flowsForRun({ flows: null }, 'done', flows).length, 0, 'a run without attachments starts nothing')
    gleich(flowsForRun({ flows: '[{"flowId":99}]' }, 'done', flows).length, 0, 'a deleted flow is skipped, not crashed on')
  })
  await pruefe('normalizeTrigger: kind only — the filter moved to the attachment', () => {
    gleich(normalizeTrigger({ kind: 'run_finished', agentIds: [7], outcomes: ['done'] }).agentIds, undefined, 'old filters are dropped')
    gleich(Object.keys(normalizeTrigger({ kind: 'run_finished' })).join(','), 'kind', 'run_finished carries nothing else')
    gleich(normalizeTrigger({ kind: 'cron', expr: ' * * * * * ' }).expr, '* * * * *', 'the cron expression is trimmed')
    gleich(normalizeTrigger({ kind: 'nonsense' }).kind, 'manual', 'unknown kind → manual')
  })
  await pruefe('validateDefinition: unknown types, required fields (showIf-aware), branches', () => {
    gleich(validateDefinition({ sequence: [] }).length, 0, 'empty is valid')
    wahr(validateDefinition({ sequence: [{ type: 'teleport' }] })[0].includes('unknown step type'), 'unknown type')
    const tg = { id: 'a', type: 'telegram', name: 'tg', properties: defaultProps('telegram') }
    wahr(validateDefinition({ sequence: [tg] }).some(p => p.includes("'text' is required")), 'required text')
    tg.properties.text = 'hi'; gleich(validateDefinition({ sequence: [tg] }).length, 0, 'filled → valid')
    const sm = { id: 'b', type: 'send_message', properties: { ...defaultProps('send_message'), target: 'all_running', text: 'x' } }
    gleich(validateDefinition({ sequence: [sm] }).length, 0, 'agentId not required when target is not agent')
    const cond = { id: 'c', type: 'condition', properties: { left: '1', op: 'eq', right: '1' }, branches: { true: [{ type: 'stop', properties: {} }], false: [{ type: 'nope' }] } }
    wahr(validateDefinition({ sequence: [cond] }).some(p => p.includes("unknown step type 'nope'")), 'walks into branches')
    const loop = { id: 'd', type: 'for_each', properties: { list: '{{vars.x}}', itemVar: 'i', maxItems: 5 }, sequence: [{ type: 'nirvana' }] }
    wahr(validateDefinition({ sequence: [loop] }).some(p => p.includes("unknown step type 'nirvana'")), 'walks into a container body')
    gleich(validateDefinition({ sequence: [{ id: 'e', type: 'for_each', properties: { itemVar: 'i' }, sequence: [] }] }).length, 1, "'list' is required")
  })
  // ------------------------------------------------------------------
  gruppe('Flows: typed variable catalog and placement rules (varschema.mjs)')
  const vs = await import('../server/flows/varschema.mjs')
  const { STEP_MAP } = await import('../server/flows/steps.mjs')
  const runTrig = { kind: 'run_finished' }, cronTrig = { kind: 'cron' }
  // One extraction, one comparison against it, one loop over its list — the
  // shape every "the variable was typed wrong" report has.
  const vdef = { sequence: [
    { id: 's1', type: 'extract', properties: { outputVar: 'ex', fields: [
      { name: 'needs review', type: 'boolean' }, { name: 'sev', type: 'string', enumValues: 'low, high' }, { name: 'points', type: 'string_list' }] } },
    { id: 's2', type: 'condition', properties: { left: '{{vars.ex.needs_review}}', op: 'eq', right: 'yes' },
      branches: { true: [{ id: 's3', type: 'set_var', properties: { outputVar: 'inner', value: 'x' } }], false: [] } },
    { id: 's4', type: 'for_each', properties: { list: '{{vars.ex.points}}', itemVar: 'pt' },
      sequence: [{ id: 's5', type: 'note', properties: { text: '{{vars.pt}} und {{vars.nope}}' } }] },
  ] }
  const at = (id, trig = runTrig) => vs.varsInScope(vdef, STEP_MAP, id, trig)
  const find = (scope, path) => scope.find(v => v.path === path)

  await pruefe('varsInScope: types, enums and the sanitized field name', () => {
    const sc = at('s2')
    gleich(find(sc, 'vars.ex.needs_review')?.type, 'boolean', 'a boolean extraction field stays a boolean')
    gleich(find(sc, 'vars.ex.sev')?.enum.join('|'), 'low|high', 'enum values come from the field')
    gleich(find(sc, 'vars.ex.points')?.type, 'string_list', 'list field')
    falsch(find(sc, 'vars.ex.needs review'), 'the space became an underscore — as in the JSON schema')
    gleich(find(sc, 'trigger.run.outcome')?.enum.join('|'), 'done|failed|aborted', 'run outcome is an enum')
  })
  await pruefe('varsInScope: order — a variable exists only after the step that writes it', () => {
    falsch(find(at('s1'), 'vars.ex'), 'the extraction cannot read its own output')
    wahr(find(at('s2'), 'vars.ex'), 'the next step can')
  })
  await pruefe('varsInScope: branch and loop variables are marked conditional', () => {
    wahr(find(at('s4'), 'vars.inner')?.conditional, 'set inside a branch — may be missing')
    falsch(find(at('s2'), 'vars.inner'), 'and does not exist before its own branch at all')
    const inner = at('s5')
    gleich(find(inner, 'vars.pt')?.type, 'string', 'the loop element takes the item type of the list')
    gleich(find(inner, 'vars.pt_index')?.type, 'number', 'position')
    falsch(find(inner, 'vars.pt')?.conditional, 'inside the body the element is guaranteed')
  })
  await pruefe('varsInScope: a cron flow has no trigger run', () => {
    falsch(find(at('s2', cronTrig), 'trigger.run.outcome'), 'nothing to offer')
    wahr(find(at('s2', { kind: 'manual' }), 'trigger.run.outcome')?.conditional, 'manual: only when "run now" gives one')
  })
  await pruefe('varsInScope: a drop position works like a step id', () => {
    const sc = vs.varsInScope(vdef, STEP_MAP, { sequence: vdef.sequence, index: 1 }, runTrig)
    wahr(find(sc, 'vars.ex'), 'dropping after the extraction sees it')
    falsch(vs.varsInScope(vdef, STEP_MAP, { sequence: vdef.sequence, index: 0 }, runTrig).find(v => v.path === 'vars.ex'), 'dropping before it does not')
  })
  await pruefe('pathProblem: typo, missing field, and what cannot be judged', () => {
    const sc = at('s2')
    gleich(vs.pathProblem('vars.ex.needs_review', sc), 'ok', 'exact hit')
    gleich(vs.pathProblem('vars.extracted.x', sc), 'unknown_var', 'no step writes that variable')
    gleich(vs.pathProblem('vars.ex.needs_reviev', sc), 'unknown_field', 'typo in the field')
    gleich(vs.pathProblem('trigger.run.bogus', sc), 'unknown_field', 'RunInfo has no such field')
    gleich(vs.pathProblem('vars.inner.whatever', at('s4')), 'ok', 'below a set_var nothing is knowable')
    gleich(vs.pathProblem('something.else', sc), 'foreign', 'not one of our roots — left alone')
  })
  await pruefe('opsForType / valueProblem: the value has to be one the left side can take', () => {
    gleich(vs.opsForType('boolean').join(','), 'truthy,falsy,eq,neq', 'a boolean answers four questions')
    wahr(vs.opsForType('number').includes('gt'), 'numbers compare')
    falsch(vs.opsForType('boolean').includes('contains'), 'a boolean contains nothing')
    const b = { type: 'boolean' }, e = { type: 'string', enum: ['low', 'high'] }, n = { type: 'number' }
    gleich(vs.valueProblem(b, 'eq', 'yes'), 'bool_value', 'compare() stringifies — only true/false can match')
    falsch(vs.valueProblem(b, 'eq', 'TRUE'), 'case does not matter')
    falsch(vs.valueProblem(b, 'truthy', ''), 'a unary operator needs no value')
    gleich(vs.valueProblem(e, 'eq', 'medium'), 'enum_value', 'not in the enum')
    falsch(vs.valueProblem(e, 'eq', 'High'), 'in the enum')
    gleich(vs.valueProblem(n, 'gt', 'zwei'), 'number_value', 'not a number')
    falsch(vs.valueProblem(e, 'eq', '{{vars.x}}'), 'a template is only known at run time')
    gleich(vs.valuesFor(b).join('|'), 'true|false', 'the designer offers exactly these')
  })
  await pruefe('definitionWarnings: the typo and the impossible comparison, both found', () => {
    const w = vs.definitionWarnings(vdef, STEP_MAP, runTrig)
    wahr(w.some(x => x.stepId === 's2' && x.code === 'bool_value'), 'boolean against "yes"')
    wahr(w.some(x => x.stepId === 's5' && x.code === 'unknown_var' && x.path === 'vars.nope'), 'variable nothing writes')
    gleich(w.filter(x => x.path === 'vars.pt').length, 0, 'the loop element itself is fine')
  })
  await pruefe('placement: a run outcome needs a run', () => {
    const sw = (id) => ({ id, type: 'switch_outcome', properties: { value: '{{trigger.run.outcome}}' }, branches: { done: [], failed: [], aborted: [] } })
    const pdef = { sequence: [sw('p1')] }
    gleich(vs.placementErrors(pdef, STEP_MAP, runTrig).length, 0, 'a run_finished trigger delivers one')
    gleich(vs.placementErrors(pdef, STEP_MAP, cronTrig)[0]?.code, 'needs_run', 'a cron flow does not')
    gleich(vs.placementOf(sw('p1'), pdef, STEP_MAP, { kind: 'manual' })?.severity, 'warning', 'manual is only a warning')
    const waited = { sequence: [
      { id: 'q1', type: 'start_agent', properties: { agentId: 1, wait: true, outputVar: 'run' } },
      { ...sw('q2'), properties: { value: '{{vars.run.outcome}}' } }] }
    gleich(vs.placementErrors(waited, STEP_MAP, cronTrig).length, 0, 'a start step with wait delivers one too')
    const noWait = { sequence: [{ ...waited.sequence[0], properties: { agentId: 1, wait: false, outputVar: 'run' } }, waited.sequence[1]] }
    gleich(vs.placementErrors(noWait, STEP_MAP, cronTrig)[0]?.code, 'needs_run', 'without wait there is no outcome')
  })
  await pruefe('placement: nothing follows a stop, also at the drop position', () => {
    const sdef = { sequence: [{ id: 'x1', type: 'stop', properties: {} }, { id: 'x2', type: 'note', properties: { text: 'hi' } }] }
    gleich(vs.placementErrors(sdef, STEP_MAP)[0]?.code, 'after_stop', 'the step behind it is unreachable')
    const probe = { type: 'note', properties: { text: 'x' } }
    gleich(vs.placementProblem(probe, STEP_MAP, { definition: sdef, sequence: sdef.sequence, index: 1 })?.code, 'after_stop', 'the drop is refused')
    falsch(vs.placementProblem(probe, STEP_MAP, { definition: sdef, sequence: sdef.sequence, index: 0 }), 'in front of the stop it is fine')
  })
  await pruefe('placement: only the target "the trigger run" needs one — other targets reach anything', () => {
    const mdef = { sequence: [{ id: 'm1', type: 'send_message', properties: { target: 'trigger_run', text: 'hi' } }] }
    gleich(vs.placementErrors(mdef, STEP_MAP, cronTrig)[0]?.code, 'needs_run_target', 'no trigger run under cron')
    for (const target of ['agent', 'repo', 'all_running', 'run_id']) {
      mdef.sequence[0].properties.target = target
      gleich(vs.placementErrors(mdef, STEP_MAP, cronTrig).length, 0, `target ${target} messages runs outside this flow`)
    }
  })
  await pruefe('placement: a rule bound to a field value is only advertised while it applies', () => {
    const send = (target) => ({ id: 'r1', type: 'send_message', properties: { target, text: 'hi' } })
    gleich(vs.activeRuleKey(send('trigger_run'), STEP_MAP.send_message), 'needs_run_target', 'stated for that target')
    falsch(vs.activeRuleKey(send('agent'), STEP_MAP.send_message), 'and for no other — messaging a foreign agent needs nothing')
    falsch(vs.activeRuleKey(send('all_running'), STEP_MAP.send_message), 'nor for all running runs')
    gleich(vs.activeRuleKey({ type: 'switch_outcome', properties: {} }, STEP_MAP.switch_outcome), 'needs_run', 'an unconditional rule always applies')
    falsch(vs.activeRuleKey({ type: 'note', properties: {} }, STEP_MAP.note), 'a step without a rule has none')
  })
  await pruefe('validateDefinition rejects a placement error, hints stay non-blocking', () => {
    const pdef = { sequence: [{ id: 'p1', type: 'switch_outcome', properties: { value: '{{trigger.run.outcome}}' }, branches: { done: [], failed: [], aborted: [] } }] }
    gleich(validateDefinition(pdef, runTrig).length, 0, 'fine under its own trigger')
    wahr(validateDefinition(pdef, cronTrig).some(p => p.includes('needs_run')), 'refused under cron')
    gleich(validateDefinition(vdef, runTrig).length, 0, 'a wrong comparison is a hint, never a save error')
  })

  await pruefe('schemaFromFields builds a strict JSON schema', () => {
    const s = schemaFromFields([{ name: 'branch name', type: 'string' }, { name: 'ok', type: 'boolean' }, { name: 'tags', type: 'string_list' }, { name: 'sev', type: 'string', enumValues: 'low, high' }, { name: '' }])
    gleich(s.required.join(','), 'branch_name,ok,tags,sev', 'names sanitized, empty dropped')
    gleich(s.properties.tags.type, 'array', 'list type'); gleich(s.properties.sev.enum.join('|'), 'low|high', 'enum')
    falsch(s.additionalProperties, 'strict')
  })

  // ------------------------------------------------------------------
  gruppe('Flows: engine with a stub api (branching, wait/resume, delay, stop, failure)')
  const engine = await import('../server/flows/engine.mjs')
  const fdb = await import('../server/flows/db.mjs')
  const calls = []
  const stubApi = {
    now: () => Date.parse('2026-08-24T10:00:00Z'),
    runInfo: async (id) => ({ id, outcome: 'done', ended_normally: true, report: 'fine' }),
    findRuns: async (f) => { calls.push(['findRuns', f]); return [{ id: 'live', status: 'running', tmux_session: 's' }] },
    sendToRun: async (run, text) => { calls.push(['send', run.id, text]); return { ok: true } },
    killRun: async (run) => { calls.push(['kill', run.id]); return true },
    startAgent: async (agentId, extra) => { calls.push(['startAgent', agentId, extra]); return { ok: true, runId: 'new-run' } },
    startSingle: async (opts) => { calls.push(['startSingle', opts.prompt]); return { ok: true, runId: 'single-run' } },
    telegram: async (text) => { calls.push(['telegram', text]); return true },
    runText: async () => 'report text',
    extract: async ({ fields }) => Object.fromEntries(fields.map(f => [f.name, 'v'])),
    http: async () => ({ status: 200, ok: true, body: '{}', json: {} }),
  }
  const step = (type, properties, extra = {}) => ({ id: `${type}-${Math.random().toString(36).slice(2, 7)}`, type, name: type, componentType: extra.branches ? 'switch' : 'task', properties, ...extra })
  const trig = { kind: 'run_finished', run: { id: 'r1', outcome: 'failed', agent_name: 'nightly', report: 'broke' } }

  await pruefe('branching on outcome, outputs into vars, note renders templates', async () => {
    const def = { sequence: [
      step('switch_outcome', { value: '' }, { branches: {
        done: [step('note', { text: 'was done' })],
        failed: [step('set_var', { outputVar: 'reason', value: 'failed: {{trigger.run.report}}' }), step('telegram', { text: '{{vars.reason}}', outputVar: 'tg' })],
        aborted: [],
      } }),
      step('note', { text: 'after switch {{vars.reason}}' }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'branchy', definition: def }, trig, stubApi)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'finished')
    gleich(fr.context.vars.reason, 'failed: broke', 'set_var rendered')
    gleich(fr.context.vars.tg.delivered, true, 'telegram output stored')
    gleich(calls.find(c => c[0] === 'telegram')[1], 'failed: broke', 'telegram received the rendered text')
    wahr(fr.log.some(l => l.msg === 'after switch failed: broke'), 'continued after the switch')
    falsch(fr.log.some(l => l.msg === 'was done'), 'other branch not executed')
  })
  await pruefe('send_message targets running runs of an agent', async () => {
    calls.length = 0
    const def = { sequence: [step('send_message', { target: 'agent', agentId: '5', text: 'pull {{trigger.run.agent_name}}', outputVar: 'sent' })] }
    const id = await engine.startFlowRun({ id: null, name: 'msg', definition: def }, trig, stubApi)
    gleich(fdb.getFlowRun(id).context.vars.sent.count, 1, 'one run reached')
    gleich(JSON.stringify(calls[0][1]), '{"statuses":["running","waiting_help"],"agentId":5}', 'filter by agent, running only')
    gleich(calls[1][2], 'pull nightly', 'text rendered')
  })
  await pruefe('start_agent with wait suspends, resume stores the RunInfo, condition sees it', async () => {
    calls.length = 0
    const def = { sequence: [
      step('start_agent', { agentId: '3', promptExtra: 'fix: {{trigger.run.report}}', wait: true, outputVar: 'fixer' }),
      step('condition', { left: '{{vars.fixer.ended_normally}}', op: 'truthy', right: '' }, { branches: { true: [step('note', { text: 'fixed' })], false: [step('note', { text: 'not fixed' })] } }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'chain', definition: def }, trig, stubApi)
    let fr = fdb.getFlowRun(id)
    gleich(fr.status, 'waiting', 'suspended'); gleich(fr.wait_run_id, 'new-run', 'on the started run')
    gleich(calls[0][2], 'fix: broke', 'prompt extra rendered')
    gleich(fr.context.vars.fixer.id, 'new-run', 'run id known before the wait')
    await engine.resumeWaitingOnRun('other-run', stubApi)
    gleich(fdb.getFlowRun(id).status, 'waiting', 'a different run ending does not resume')
    await engine.resumeWaitingOnRun('new-run', stubApi)
    fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'resumed and finished')
    gleich(fr.context.vars.fixer.outcome, 'done', 'RunInfo replaced the placeholder output')
    wahr(fr.log.some(l => l.msg === 'fixed'), 'condition read the resumed variable')
  })
  await pruefe('delay suspends until resume_at; resumeDelayed continues', async () => {
    const def = { sequence: [step('delay', { minutes: 10 }), step('note', { text: 'later' })] }
    const id = await engine.startFlowRun({ id: null, name: 'sleepy', definition: def }, trig, stubApi)
    gleich(fdb.getFlowRun(id).status, 'waiting', 'waiting')
    gleich(fdb.getFlowRun(id).resume_at, '2026-08-24T10:10:00.000Z', 'resume time from api.now')
    await engine.resumeDelayed(stubApi)
    gleich(fdb.getFlowRun(id).status, 'waiting', 'not yet due')
    await engine.resumeDelayed({ ...stubApi, now: () => Date.parse('2026-08-24T10:11:00Z') })
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'done after the delay'); wahr(fr.log.some(l => l.msg === 'later'), 'continued')
  })
  await pruefe('stop ends the run; a throwing step fails it with the message; unknown type fails', async () => {
    const id1 = await engine.startFlowRun({ id: null, name: 's', definition: { sequence: [step('stop', { reason: 'enough' }), step('note', { text: 'never' })] } }, trig, stubApi)
    const fr1 = fdb.getFlowRun(id1)
    gleich(fr1.status, 'done', 'stopped = done'); falsch(fr1.log.some(l => l.msg === 'never'), 'nothing after stop')
    const id2 = await engine.startFlowRun({ id: null, name: 'f', definition: { sequence: [step('extract', { source: 'report', fields: [] })] } }, trig, stubApi)
    const fr2 = fdb.getFlowRun(id2)
    gleich(fr2.status, 'failed', 'failed'); wahr(fr2.error.includes('no fields'), 'error message kept')
    const id3 = await engine.startFlowRun({ id: null, name: 'u', definition: { sequence: [{ id: 'z', type: 'warp', properties: {} }] } }, trig, stubApi)
    gleich(fdb.getFlowRun(id3).status, 'failed', 'unknown step type fails')
    wahr(engine.stopFlowRun(id3) === false, 'cannot stop a finished flow run')
  })
  await pruefe('extract stores the model output; kill_run and start_single_run go through the api', async () => {
    calls.length = 0
    const def = { sequence: [
      step('extract', { source: 'report', sourceRun: '{{trigger.run.id}}', fields: [{ name: 'branch', type: 'string' }], outputVar: 'ex' }),
      step('kill_run', { target: 'all_running', outputVar: 'k' }),
      step('start_single_run', { repoId: '1', harness: 'claude', prompt: 'branch {{vars.ex.branch}}', wait: false, outputVar: 'single' }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'x', definition: def }, trig, stubApi)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'done')
    gleich(fr.context.vars.ex.branch, 'v', 'extract output'); gleich(fr.context.vars.k.count, 1, 'kill count')
    gleich(calls.find(c => c[0] === 'startSingle')[1], 'branch v', 'single run prompt used the extracted value')
    gleich(fr.context.vars.single.id, 'single-run', 'no wait → continues with the id')
  })

  await pruefe('for each: body per element, item + index variables, maxItems cap', async () => {
    const container = (id, properties, sequence) => ({ id, type: 'for_each', name: id, componentType: 'container', properties, sequence })
    const def = { sequence: [
      step('set_var', { outputVar: 'points', value: 'alpha\nbeta\ngamma' }),
      container('loop', { list: '{{vars.points}}', itemVar: 'punkt', maxItems: 2 }, [step('note', { text: '{{vars.punkt_index}}: {{vars.punkt}}' })]),
      step('note', { text: 'after the loop' }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'loopy', definition: def }, trig, stubApi)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'finished')
    gleich(fr.log.filter(l => l.type === 'note').map(l => l.msg).join(' | '), '1: alpha | 2: beta | after the loop', 'body once per element, capped at maxItems, then on')
    gleich(fr.context.vars.punkt, 'beta', 'the last element stays readable')
  })
  await pruefe('for each: JSON list, nested branch, empty list skips the body', async () => {
    const container = (id, properties, sequence) => ({ id, type: 'for_each', name: id, componentType: 'container', properties, sequence })
    const def = { sequence: [
      container('l1', { list: '["x","y"]', itemVar: 'it' }, [
        step('condition', { left: '{{vars.it}}', op: 'eq', right: 'y' }, { branches: { true: [step('note', { text: 'hit {{vars.it}}' })], false: [] } }),
      ]),
      container('l2', { list: '{{vars.does_not_exist}}', itemVar: 'n' }, [step('note', { text: 'never' })]),
      step('note', { text: 'end' }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'nested', definition: def }, trig, stubApi)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'finished')
    gleich(fr.log.filter(l => l.type === 'note').map(l => l.msg).join(' | '), 'hit y | end', 'branch inside the loop, empty loop skipped')
  })
  await pruefe('for each: a wait inside the body survives and continues with the next element', async () => {
    calls.length = 0
    const container = (id, properties, sequence) => ({ id, type: 'for_each', name: id, componentType: 'container', properties, sequence })
    const def = { sequence: [container('l', { list: '["one","two"]', itemVar: 'it' }, [
      step('start_agent', { agentId: '3', promptExtra: 'work on {{vars.it}}', wait: true, outputVar: 'r' }),
      step('note', { text: 'done with {{vars.it}}' }),
    ])] }
    const id = await engine.startFlowRun({ id: null, name: 'waity', definition: def }, trig, stubApi)
    gleich(fdb.getFlowRun(id).status, 'waiting', 'suspended in the first element')
    gleich(calls[0][2], 'work on one', 'first element in the prompt')
    await engine.resumeWaitingOnRun('new-run', stubApi)
    gleich(fdb.getFlowRun(id).status, 'waiting', 'suspended again, now in the second element')
    gleich(calls.filter(c => c[0] === 'startAgent').at(-1)[2], 'work on two', 'second element in the prompt')
    await engine.resumeWaitingOnRun('new-run', stubApi)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'finished after the last element')
    gleich(fr.log.filter(l => l.type === 'note').map(l => l.msg).join(' | '), 'done with one | done with two', 'body completed for both elements')
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

  // A balance nobody can act on is noise: the panel asks only providers that an
  // ENABLED coding agent may use and that actually carry a credential.
  await pruefe('balances are only fetched for providers a configured agent may use', async () => {
    const bal = await import('../server/balances.mjs')
    const echt = globalThis.fetch
    const gefragt = []
    const keys = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }
    globalThis.fetch = async (url) => {
      gefragt.push(String(url))
      return { ok: true, json: async () => ({ data: { total_credits: 5, total_usage: 1 }, is_available: true }) }
    }
    try {
      // Only claude is configured here, and a subscription harness has no providers.
      bal._balanceCacheReset()
      gleich(bal.relevantProviderIds().length, 0, 'subscription-only setup asks nobody')
      gleich((await bal.providerBalances()).length, 0, 'and fetches nothing')
      gleich(gefragt.length, 0, 'no request left the process')

      ca.saveCodingAgent({ harness: 'opencode', providers: ['opencode-zen', 'deepseek', 'openrouter'] })
      process.env.OPENROUTER_API_KEY = 'k'
      delete process.env.DEEPSEEK_API_KEY
      bal._balanceCacheReset()
      const rows = await bal.providerBalances()
      gleich(rows.length, 1, 'a provider without a credential is left out, not reported as broken')
      gleich(rows[0].provider, 'openrouter', 'the one with a key')
      wahr(rows[0].ok, 'and it answered')
      falsch(gefragt.some(u => u.includes('deepseek')), 'the keyless provider was never called')
    } finally {
      globalThis.fetch = echt
      const oc = ca.codingAgentFor('opencode')
      if (oc) ca.deleteCodingAgent(oc.id)   // restore the world the next group expects
      for (const [k, v] of Object.entries(keys)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
      bal._balanceCacheReset()
    }
  })

  // The status sidebar asks for usage and balances on EVERY page, so the very
  // first request of a fresh hub happens while nothing is configured yet. Two
  // ways that answer used to get stuck for the life of the process, both found
  // by exactly that: [] cached for two minutes although the configuration had
  // changed in the meantime, and — worse — a body without a single `await`
  // (the empty loop) clearing the in-flight flag BEFORE the assignment that
  // set it, so every later call returned that one stale promise forever.
  await pruefe('a configuration change is visible in usage and balances without a cache reset', async () => {
    const usage = await import('../server/usage.mjs')
    const bal = await import('../server/balances.mjs')
    const echt = globalThis.fetch
    const key = process.env.OPENROUTER_API_KEY
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { total_credits: 5, total_usage: 1 }, is_available: true }) })
    const vorher = ca.listCodingAgents().map(a => ({ harness: a.harness, providers: a.providerIds, enabled: a.enabled }))
    try {
      for (const a of ca.listCodingAgents()) ca.deleteCodingAgent(a.id)
      usage._usageCacheReset(); bal._balanceCacheReset()
      delete process.env.OPENROUTER_API_KEY
      // Nothing configured: nothing to report — and NO await happens in here.
      gleich((await usage.subscriptionUsage()).length, 0, 'empty configuration reports nothing')
      gleich((await bal.providerBalances()).length, 0, 'and holds no balance')

      // Now configure — without touching the caches, exactly as the web UI does.
      ca.saveCodingAgent({ harness: 'claude', enabled: 1, providers: [] })
      const rows = await usage.subscriptionUsage()
      gleich(rows.length, 1, 'the newly configured coding agent is reported at once')
      gleich(rows[0].harness, 'claude', 'and it is the one that was added')

      ca.saveCodingAgent({ harness: 'opencode', enabled: 1, providers: ['openrouter'] })
      process.env.OPENROUTER_API_KEY = 'k'
      const b = await bal.providerBalances()
      gleich(b.length, 1, 'its provider is asked for a balance at once')
      gleich(b[0].provider, 'openrouter', 'the provider that was just allowed')

      // And a finished request really is finished: `force` is the one call that
      // is supposed to ignore the cache, so it must not be handed the promise
      // the cache was made of. That is what a flag left standing does.
      const uEinmal = await usage.subscriptionUsage()
      falsch(await usage.subscriptionUsage({ force: true }) === uEinmal,
        'a forced usage refresh asks again instead of returning the finished request')
      const bEinmal = await bal.providerBalances()
      falsch(await bal.providerBalances({ force: true }) === bEinmal,
        'a forced balance refresh asks again instead of returning the finished request')
    } finally {
      globalThis.fetch = echt
      if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key
      for (const a of ca.listCodingAgents()) ca.deleteCodingAgent(a.id)
      for (const a of vorher) ca.saveCodingAgent({ harness: a.harness, enabled: a.enabled, providers: a.providers })
      usage._usageCacheReset(); bal._balanceCacheReset()
    }
  })

  // ------------------------------------------------------------------
  gruppe('Run definition: one form → one definition (run-def.mjs)')
  // 'claude' is the configured coding agent here (seeded by the group above).
  const rd = await import('../server/run-def.mjs')

  await pruefe('a complete form becomes the definition the run is created from', async () => {
    const problems = []
    const def = await rd.runDefFromForm({
      harness: 'claude', model: ' claude-opus-5 ', prompt: 'do something',
      branch_mode: 'neu', branch_pattern: 'agent/{date}-{kurz}', expected_minutes: '30',
    }, problems)
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(def.model, 'claude-opus-5', 'model trimmed')
    gleich(def.branchMode, 'neu', 'branch mode')
    gleich(def.expectedMinutes, 30, 'expected duration')
    gleich(def.provider, null, 'subscription harness has no provider')
  })
  await pruefe('missing expectation falls back to the default instead of NaN', async () => {
    const def = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'keiner' }, [])
    gleich(def.expectedMinutes, rd.DEFAULT_EXPECTED_MINUTES, 'default')
  })
  await pruefe('the same checks apply to every form: harness, prompt, branch rule', async () => {
    const p1 = []
    await rd.runDefFromForm({ harness: 'gpt', prompt: 'x', branch_mode: 'keiner' }, p1)
    gleich(p1.length, 1, `unknown harness (${p1.join(', ')})`)
    const p2 = []
    await rd.runDefFromForm({ harness: 'opencode', prompt: 'x', branch_mode: 'keiner' }, p2)
    enthaelt(p2.join(' '), 'not configured', 'known but not configured coding agent')
    const p3 = []
    await rd.runDefFromForm({ harness: 'claude', prompt: '   ', branch_mode: 'quatsch' }, p3)
    // Empty prompt, unknown branch mode — and that mode is not 'keiner', so the
    // missing pattern counts too. Everything the operator has to fix at once.
    gleich(p3.length, 3, `empty prompt and unknown branch mode (${p3.join(', ')})`)
    const p4 = []
    await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'neu' }, p4)
    gleich(p4.length, 1, `branch mode without a pattern (${p4.join(', ')})`)
  })
  await pruefe('a provider the harness cannot use is refused, not silently stored', async () => {
    const problems = []
    const def = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'keiner', provider: 'openrouter' }, problems)
    gleich(problems.length, 1, `refused (${problems.join(', ')})`)
    gleich(def.provider, null, 'nothing taken over')
  })
  await pruefe('agent row and definition describe the same thing', () => {
    const def = rd.defFromAgent({
      harness: 'claude', model: 'm', provider: null, or_provider: null, effort: 'high',
      prompt: 'p', branch_mode: 'fest', branch_pattern: 'b', expected_minutes: 20, skills: '["x"]',
    })
    gleich(def.branchMode, 'fest', 'branch mode')
    gleich(def.expectedMinutes, 20, 'expected duration')
    gleich(def.skills, '["x"]', 'skills copied verbatim')
    gleich(rd.defFromAgent({ flows: '[{"flowId":1,"when":"failed"}]' }).flows, '[{"flowId":1,"when":"failed"}]',
      'attached flows copied verbatim')
  })
  // A flow hangs on an agent or a single run — naming each of four attached
  // flows is a hurdle, not information. So the name is optional in the UI and
  // the hub fills in a free one; the column is UNIQUE and flow_runs keeps a copy.
  await pruefe('a flow saved without a name gets a free one', async () => {
    const fdb3 = await import('../server/flows/db.mjs')
    gleich(fdb3.autoFlowName(), 'Flow 1', 'the first one')
    fdb3.saveFlow({ name: fdb3.autoFlowName(), trigger: { kind: 'manual' }, definition: { sequence: [] } })
    gleich(fdb3.autoFlowName(), 'Flow 2', 'the taken one is skipped')
  })
  await pruefe('attached flows go through the form like every other definition field', async () => {
    const fdb2 = await import('../server/flows/db.mjs')
    const id = fdb2.saveFlow({ name: 'attach-test', trigger: { kind: 'run_finished' }, definition: { sequence: [] } })
    const base = { harness: 'claude', prompt: 'x', branch_mode: 'keiner' }
    gleich((await rd.runDefFromForm(base, [])).flows, null, 'nothing ticked = NULL')
    const def = await rd.runDefFromForm({ ...base, flows_list: [String(id), '4242'], [`flow_when_${id}`]: 'failed' }, [])
    gleich(def.flows, JSON.stringify([{ flowId: id, when: 'failed' }]),
      'the ticked flow with its condition — a flow that does not exist is dropped')
  })
  await pruefe('the last choice is remembered and offered again', () => {
    gleich(JSON.stringify(rd.lastRunChoice()), '{}', 'nothing remembered yet')
    rd.rememberRunChoice({ harness: 'claude', model: 'claude-opus-5', provider: null, orProvider: null, effort: 'high' })
    const l = rd.lastRunChoice()
    gleich(l.harness, 'claude', 'coding agent')
    gleich(l.model, 'claude-opus-5', 'model')
    gleich(l.effort, 'high', 'effort')
  })
  await pruefe('a coding agent that was switched off is not preselected', () => {
    ca.saveCodingAgent({ harness: 'claude', enabled: 0, providers: [] })
    gleich(JSON.stringify(rd.lastRunChoice()), '{}', 'nothing offered')
    ca.saveCodingAgent({ harness: 'claude', enabled: 1, providers: [] })
    gleich(rd.lastRunChoice().harness, 'claude', 'offered again after switching on')
  })
  // Switching the coding agent in the form must not leave the previous one's
  // setup standing — an opencode slug is nothing claude runs. So every coding
  // agent keeps its OWN last setup, and one it has none for answers empty.
  await pruefe('every coding agent remembers its own setup', () => {
    ca.saveCodingAgent({ harness: 'opencode', enabled: 1, providers: ['openrouter'] })
    rd.rememberRunChoice({ harness: 'opencode', model: 'z-ai/glm-4.6', provider: 'openrouter', orProvider: 'novita', effort: null })
    gleich(rd.lastRunChoice().harness, 'opencode', 'the last one opens the form')
    const c = rd.lastRunChoiceFor('claude')
    gleich(c.model, 'claude-opus-5', 'claude still has its own model')
    gleich(c.effort, 'high', 'and its own effort')
    gleich(c.provider, null, 'and no provider of the other one')
    const o = rd.lastRunChoiceFor('opencode')
    gleich(o.provider, 'openrouter', 'opencode has its own provider')
    gleich(o.or_provider, 'novita', 'including the serving provider')
    gleich(JSON.stringify(rd.lastRunChoiceFor('hermes')), '{}', 'an unconfigured coding agent offers nothing')
    ca.saveCodingAgent({ harness: 'cursor', enabled: 1, providers: [] })
    gleich(rd.lastRunChoiceFor('cursor').model, null, 'a configured one without history stays empty')
  })

  // ------------------------------------------------------------------
  gruppe('Favorites: the setup of a run under a name (favorites.mjs)')
  const fv = await import('../server/favorites.mjs')

  await pruefe('a favorite is the setup half — nothing about the task', async () => {
    const problems = []
    const fav = await fv.favoriteFromForm({
      name: '  Opus, thorough  ', harness: 'claude', model: ' claude-opus-5 ',
      skills: 'unlazy', skill_regler_unlazy: '4',
      // Fields of the run form that a favorite deliberately does not carry —
      // they must not leak into it through the same body.
      prompt: 'do something', branch_mode: 'neu', branch_pattern: 'x', expected_minutes: '90',
    }, problems)
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(fav.name, 'Opus, thorough', 'name trimmed')
    gleich(fav.model, 'claude-opus-5', 'model trimmed')
    gleich(fav.skills, '["unlazy:4"]', 'extra skill with its dial')
    falsch('prompt' in fav, 'no prompt')
    falsch('branchMode' in fav, 'no branch rule')
    falsch('expectedMinutes' in fav, 'no expected duration')
  })
  await pruefe('it refuses exactly what the run form refuses, plus a missing name', async () => {
    const p = []
    await fv.favoriteFromForm({ name: '   ', harness: 'claude', provider: 'openrouter' }, p)
    gleich(p.length, 2, `name missing and a provider claude cannot use (${p.join(', ')})`)
    const p2 = []
    await fv.favoriteFromForm({ name: 'x', harness: 'gpt' }, p2)
    gleich(p2.length, 1, `unknown coding agent (${p2.join(', ')})`)
  })
  // The whole point of storing only the setup: a Quick Run turns the favorite
  // back into a form body and goes through runDefFromForm() like every other
  // start. If this round trip broke, a favorite would quietly mean something
  // else than what was saved — which is exactly the drift run-def.mjs exists
  // to prevent.
  await pruefe('a favorite becomes a form body again and yields the very same definition', async () => {
    const fdb5 = await import('../server/flows/db.mjs')
    const fid = fdb5.saveFlow({ name: 'fav-flow', trigger: { kind: 'run_finished' }, definition: { sequence: [] } })
    const gespeichert = {
      harness: 'claude', model: 'claude-opus-5', provider: null, or_provider: null, effort: null,
      skills: '["unlazy:4"]', flows: JSON.stringify([{ flowId: fid, when: 'failed' }]),
    }
    const body = fv.favoriteToFormBody(gespeichert)
    const def = await rd.runDefFromForm({ ...body, prompt: 'do it', branch_mode: 'keiner' }, [])
    gleich(def.harness, 'claude', 'coding agent')
    gleich(def.model, 'claude-opus-5', 'model')
    gleich(def.skills, '["unlazy:4"]', 'skill including its dial survives the round trip')
    gleich(def.flows, JSON.stringify([{ flowId: fid, when: 'failed' }]), 'attachment survives the round trip')
    gleich(def.prompt, 'do it', 'the task comes from the dialog, not from the favorite')
    gleich(def.expectedMinutes, rd.DEFAULT_EXPECTED_MINUTES, 'duration is not part of a favorite')
  })
  await pruefe('a serving provider only survives where it can be passed through at all', async () => {
    const body = fv.favoriteToFormBody({
      harness: 'opencode', model: 'z-ai/glm-4.6', provider: 'openrouter', or_provider: 'novita',
      effort: null, skills: null, flows: null,
    })
    gleich(body.or_pin, '1', 'the pin is set again from the stored value')
    const def = await rd.runDefFromForm({ ...body, prompt: 'x', branch_mode: 'keiner' }, [])
    gleich(def.orProvider, 'novita', 'opencode + OpenRouter: passed through')
  })
  await pruefe('there is room for exactly the cap, and a name is taken only once', () => {
    const mk = (name) => ({
      name, harness: 'claude', model: null, provider: null, or_provider: null,
      effort: null, skills: null, flows: null,
    })
    gleich(fv.listFavorites().length, 0, 'nothing saved yet')
    for (let i = 1; i <= fv.FAVORITES_MAX; i++) wahr(fv.saveFavorite({ fav: mk(`fav ${i}`) }).ok, `favorite ${i}`)
    falsch(fv.saveFavorite({ fav: mk('one too many') }).ok, 'the cap holds')
    const erster = fv.listFavorites()[0].id
    falsch(fv.saveFavorite({ id: erster, fav: mk('fav 2') }).ok, 'a taken name is refused while editing too')
    wahr(fv.saveFavorite({ id: erster, fav: mk('fav 1') }).ok, 'its own name stays free for itself')
    fv.deleteFavorite(erster)
    wahr(fv.saveFavorite({ fav: mk('now there is room again') }).ok, 'a removed one frees its slot')
  })

  // ------------------------------------------------------------------
  gruppe('Run title (title.mjs)')
  const ti = await import('../server/title.mjs')

  await pruefe('the fallback is the first line of the prompt that says something', () => {
    gleich(ti.fallbackTitle('Rewrite the login form'), 'Rewrite the login form', 'plain line')
    gleich(ti.fallbackTitle('\n\n   \n# Rewrite the login form\n\nand more'), 'Rewrite the login form',
      'empty lines and the heading marker skipped')
    gleich(ti.fallbackTitle('- **fix** the `parser`'), 'fix the parser', 'list bullet and inline markdown removed')
    gleich(ti.fallbackTitle('1. First step'), 'First step', 'numbered list')
    gleich(ti.fallbackTitle('   '), '', 'nothing to take')
    gleich(ti.fallbackTitle('ok'), '', 'too short to be a title')
  })
  await pruefe('a long line is cut at a whole word', () => {
    const lang = ti.fallbackTitle('Rewrite the complete authentication of the web interface including all of its tests', 40)
    wahr(lang.length <= 40, `at most 40 characters: ${lang.length}`)
    wahr(lang.endsWith('…'), `marked as cut: ${lang}`)
    falsch(/\s…$/.test(lang), `no space before the ellipsis: ${lang}`)
  })
  await pruefe('the title on screen: own title, then agent name, then the generic word', () => {
    gleich(ti.runTitle({ title: 'Own title' }, 'nightly', '(single run)'), 'Own title', 'own title wins')
    gleich(ti.runTitle({ title: '  ' }, 'nightly', '(single run)'), 'nightly', 'blank counts as none')
    gleich(ti.runTitle({ title: null }, null, '(single run)'), '(single run)', 'no title, no agent')
  })
  await pruefe('without a key or switched off nothing is requested — the run keeps the fallback', () => {
    const key = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    falsch(ti.titleLlmActive(), 'no key = off')
    if (key !== undefined) process.env.OPENROUTER_API_KEY = key
  })

  // ------------------------------------------------------------------
  gruppe('Planned start of a single run (run-def.mjs)')

  await pruefe('without a choice a run starts immediately, as it always did', () => {
    const s = rd.runStartFromForm({})
    gleich(s.startMode, 'now', 'mode')
    gleich(s.startAt, null, 'no point in time')
    gleich(s.title, null, 'no title = generated later')
  })
  await pruefe('a point in time is stored as UTC and keeps its meaning', () => {
    const problems = []
    const s = rd.runStartFromForm({ start_mode: 'at', start_at: '2026-08-25T09:00' }, problems)
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(s.startMode, 'at', 'mode')
    gleich(parseDbUtc(s.startAt), Date.parse('2026-08-25T09:00'), 'the local input, read back as UTC')
  })
  await pruefe('"in n minutes" becomes exactly that point in time', () => {
    const now = Date.parse('2026-08-25T12:00:00Z')
    const s = rd.runStartFromForm({ start_mode: 'in', start_in_minutes: '20' }, [], now)
    gleich(s.startMode, 'at', 'stored as a point in time — the DB knows two waiting kinds, not three')
    gleich(parseDbUtc(s.startAt), now + 20 * 60_000, '20 minutes later')
  })
  await pruefe('"when the repo is free" carries no point in time', () => {
    const s = rd.runStartFromForm({ start_mode: 'idle' })
    gleich(s.startMode, 'idle', 'mode')
    gleich(s.startAt, null, 'nothing to wait for by the clock')
  })
  await pruefe('a broken entry is a problem, not a run that starts at the wrong time', () => {
    const p1 = []
    gleich(rd.runStartFromForm({ start_mode: 'at', start_at: 'nonsense' }, p1).startMode, 'now', 'falls back to now')
    gleich(p1.length, 1, `unreadable point in time (${p1.join(', ')})`)
    const p2 = []
    rd.runStartFromForm({ start_mode: 'in', start_in_minutes: '0' }, p2)
    gleich(p2.length, 1, `zero minutes (${p2.join(', ')})`)
    const p3 = []
    rd.runStartFromForm({ start_mode: 'someday' }, p3)
    gleich(p3.length, 1, `unknown kind (${p3.join(', ')})`)
  })
  await pruefe('the title is trimmed and capped, an empty one stays empty', () => {
    gleich(rd.runStartFromForm({ title: '  Rewrite login  ' }).title, 'Rewrite login', 'trimmed')
    gleich(rd.runStartFromForm({ title: '   ' }).title, null, 'blank = none')
    gleich(rd.runStartFromForm({ title: 'x'.repeat(200) }).title.length, ti.TITLE_MAX, 'capped')
  })

  // ------------------------------------------------------------------
  gruppe('tmux sessions: reading, judging, keeping (sessions.mjs)')

  const se = await import('../server/sessions.mjs')
  // Exactly the two format strings sessions.mjs asks tmux for, tab-separated.
  const SESSION_LINES = [
    'cc-einzel-aaaa\t1787600000\t0\t1\t1787600500\t/srv/worktrees/a',
    'cc-einzel-bbbb\t1787500000\t1\t2\t1787500900\t/srv/worktrees/b',
  ].join('\n')

  await pruefe('a session line becomes a session, the path may contain tabs', () => {
    const s = se.parseSessions(SESSION_LINES + '\ncc-tab\t1787400000\t0\t1\t1787400000\t/srv/a\tb')
    gleich(s.length, 3, 'three sessions')
    gleich(s[0].name, 'cc-einzel-aaaa', 'name')
    gleich(s[0].createdMs, 1787600000000, 'created in ms')
    falsch(s[0].attached, 'not attached')
    wahr(s[1].attached, 'attached')
    gleich(s[1].windows, 2, 'windows')
    gleich(s[2].path, '/srv/a\tb', 'the tab stays in the path instead of shifting a field')
  })

  await pruefe('an empty or unreachable listing yields nothing, not a crash', () => {
    gleich(se.parseSessions('').length, 0, 'empty')
    gleich(se.parseSessions('no server running on /tmp/tmux-1000/default').length, 0, 'tmux error text')
  })

  await pruefe('panes decide whether a session still works', () => {
    const s = se.mergePanes(se.parseSessions(SESSION_LINES), [
      'cc-einzel-aaaa\t0\t111\t\t\tclaude',
      'cc-einzel-bbbb\t1\t222\t0\t1787501000\tbash',
      'cc-einzel-bbbb\t1\t223\t0\t1787502000\tbash',
    ].join('\n'))
    falsch(s[0].dead, 'a live pane keeps the session alive')
    gleich(s[0].command, 'claude', 'command of the live pane')
    wahr(s[1].dead, 'all panes dead = session dead')
    gleich(s[1].paneCount, 2, 'both panes counted')
    gleich(s[1].deadMs, 1787501000000, 'the EARLIEST death is when it stopped working')
  })

  await pruefe('resources are counted over the whole process tree, not just the pane', () => {
    // 100 = the pane's shell, 101 = the agent below it, 102 = its child.
    const baum = se.parsePs(['  100 1 2000 1.0', '  101 100 500000 30.0', '  102 101 1000 2.0',
      '  200 1 9999 5.0'].join('\n'))
    const r = se.processTree(baum, 100)
    gleich(r.count, 3, 'shell + agent + child')
    gleich(r.rssKb, 503000, 'summed RSS')
    gleich(Math.round(r.cpu * 10) / 10, 33, 'summed CPU')
    gleich(se.processTree(baum, 999).count, 0, 'an unknown pid costs nothing')
  })

  await pruefe('a process tree with a cycle terminates', () => {
    // Not reachable through real ps output, but a parser must not hang on it.
    const baum = se.parsePs(['  10 11 100 0.0', '  11 10 100 0.0'].join('\n'))
    gleich(se.processTree(baum, 10).count, 2, 'each process counted once')
  })

  await pruefe('"finished" is the earlier of run end and process end', () => {
    const lebt = { dead: false, deadMs: null, createdMs: 1000 }
    const tot = { dead: true, deadMs: 5000, createdMs: 1000 }
    gleich(se.finishedAtMs(lebt, { status: 'running' }), null, 'a working session is never finished')
    gleich(se.finishedAtMs(tot, null), 5000, 'dead pane without a run')
    // The claude case: the run reported 'done', the TUI keeps its pane alive.
    // Exactly this is what the old rule (dead pane only) never caught.
    gleich(se.finishedAtMs(lebt, { status: 'done', ended_at: '2026-08-25 10:00:00' }),
      Date.parse('2026-08-25T10:00:00Z'), 'the run end alone is enough')
    gleich(se.finishedAtMs(tot, { status: 'done', ended_at: '1970-01-01 00:00:03' }), 3000, 'the earlier one wins')
    gleich(se.finishedAtMs({ dead: true, deadMs: null, createdMs: 7000 }, null), 7000,
      'a dead pane without a timestamp still counts as finished')
  })

  await pruefe('the keep time comes from the hours, the old days are the fallback', () => {
    gleich(se.sessionKeepMs({ session_keep_hours: '2' }), 2 * 3600_000, 'hours')
    gleich(se.sessionKeepMs({ session_keep_hours: '0' }), 0, 'zero means right away, not "unset"')
    gleich(se.sessionKeepMs({ session_keep_hours: '0.5' }), 1800_000, 'half hours are allowed')
    gleich(se.sessionKeepMs({ retention_days: '2' }), 2 * 86_400_000, 'old setting still counts')
    gleich(se.sessionKeepMs({ session_keep_hours: '', retention_days: '1' }), 86_400_000, 'empty falls through')
    gleich(se.sessionKeepMs({}), 3 * 86_400_000, 'default: three days, as before')
    gleich(se.sessionKeepHours({ session_keep_hours: '1.5' }), 1.5, 'the form gets hours back')
  })

  await pruefe('only a finished session is closed automatically', () => {
    const jetzt = 1_000_000_000
    const lebt = { dead: false, deadMs: null }
    const fertig = { dead: true, deadMs: jetzt - 7200_000 }      // finished two hours ago
    falsch(se.shouldAutoClose(lebt, { status: 'running' }, 3600_000, jetzt), 'a working agent is never closed')
    wahr(se.shouldAutoClose(fertig, null, 3600_000, jetzt), 'two hours old, keep one hour')
    falsch(se.shouldAutoClose(fertig, null, 4 * 3600_000, jetzt), 'keep four hours: stays')
    wahr(se.shouldAutoClose(lebt, { status: 'done', ended_at: '1970-01-01 00:00:00' }, 0, jetzt),
      'keep 0 closes a finished run right away, even with a live pane')
  })

  await pruefe('the state is what the page shows, and it decides what is hidden', () => {
    const lebt = { dead: false }, tot = { dead: true }
    gleich(se.sessionState(lebt, { status: 'running' }), 'agent_running', 'running')
    gleich(se.sessionState(lebt, { status: 'waiting_help' }), 'agent_running', 'waiting for an answer is still running')
    gleich(se.sessionState(lebt, { status: 'done' }), 'run_ended', 'run over, session open')
    // A dead pane beats the record: whatever the row says, nothing works there.
    gleich(se.sessionState(tot, { status: 'running' }), 'dead', 'dead pane beats the status')
    gleich(se.sessionState(lebt, null), 'unknown', 'foreign session')
    gleich(se.sessionState(tot, null), 'dead', 'foreign dead session')
  })

  await pruefe('automatic closing only ever touches sessions with a run of this hub', () => {
    const jetzt = 1_000_000_000
    const alt = { dead: true, deadMs: jetzt - 86_400_000 }
    const liste = [
      { ...alt, name: 'mit-lauf', run: { status: 'done', ended_at: null } },
      { ...alt, name: 'fremd', run: null },
    ]
    const k = se.autoCloseCandidates(liste, 3600_000, jetzt).map(s => s.name)
    gleich(k.join(','), 'mit-lauf', 'a foreign session is only ended by hand')
  })

} finally {
  rmSync(sandkasten, { recursive: true, force: true })
}

process.exit(bericht('Unit tests', start) || (zaehler.fehler.length ? 1 : 0))
