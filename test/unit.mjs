#!/usr/bin/env node
// Freilauf — unit tests for the functions with real logic and edge cases.
//
// Deliberately NOT tested: SQL strings, HTML snippets, CSS classes, column orders,
// exact message texts, private helper functions. Such tests would only cement the
// current implementation instead of securing behavior. What is tested is what
// computes or decides — schedules, cron, form parsing, quota gate, text processing.
//
// Usage:  node test/unit.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gruppe, pruefe, gleich, wahr, falsch, enthaelt, bericht, zaehler } from './mini.mjs'

const start = Date.now()

// Own data directory: importing runner.mjs pulls in db.mjs, which would otherwise
// touch the real hub database.
const sandkasten = mkdtempSync(join(tmpdir(), 'freilauf-unit-'))
process.env.FREILAUF_DATA_DIR = join(sandkasten, 'data')
// The OpenRouter best-provider cache is a file next to the hub's real data —
// the suite points it into its own sandbox or a suite run would read (and
// overwrite) the operator's live selections.
process.env.FREILAUF_OR_ROUTING_JSON = join(sandkasten, 'openrouter-routing.json')

const d = (s) => new Date(s)

try {
  const { cronMatches, validCron, scheduleDue, scheduleText, stripAnsi, escapeHtml,
    fmtDuration, parseDbUtc, toDbUtc, fmtRelativeTime, fmtDateTime, kurzid,
    fmtDbUtc, fmtClock, fmtDatePart, fmtNum, fmtPercent,
    timezoneForLanguage, setTimezone, validTz, tzAbbrev, TIMEZONE_OPTIONS, setPublicHost, publicBase } = await import('../server/util.mjs')
  const { parseForm, cookieRepo, rememberRepo, requestRepo } = await import('../server/web-helpers.mjs')

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
  await pruefe('all seven weekdays every week read "daily"', () => {
    const alle = { ...woe, schedule_days: '1,2,3,4,5,6,0' }
    gleich(scheduleText(alle), 'daily at 07:30', 'all days every week = daily')
    const alleOhneTakt = { ...alle, schedule_weeks: undefined }
    gleich(scheduleText(alleOhneTakt), 'daily at 07:30', 'missing interval means every week')
  })
  await pruefe('all days with a multi-week interval keep the day list', () => {
    const alleZwei = { ...woe, schedule_days: '0,1,2,3,4,5,6', schedule_weeks: 2, schedule_anchor: '2026-08-24' }
    enthaelt(scheduleText(alleZwei), 'every 2 weeks', 'cadence kept')
    enthaelt(scheduleText(alleZwei), 'Sun', 'days still listed')
    enthaelt(scheduleText(alleZwei), 'Mon', 'days still listed')
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

  await pruefe('cookieRepo reads the freilauf_repo value out of the Cookie header', () => {
    gleich(cookieRepo({ headers: { cookie: 'freilauf_repo=7' } }), 7, 'bare')
    gleich(cookieRepo({ headers: { cookie: 'other=1; freilauf_repo=7' } }), 7, 'among other cookies')
    gleich(cookieRepo({ headers: { cookie: 'other=1; freilauf_repo=7; x=y' } }), 7, 'with a trailing cookie')
    gleich(cookieRepo({ headers: { cookie: 'freilauf_repo=abc' } }), null, 'non-numeric value')
    gleich(cookieRepo({ headers: { cookie: 'freilauf_repo=' } }), null, 'empty value')
    gleich(cookieRepo({ headers: {} }), null, 'no Cookie header at all')
  })
  await pruefe('rememberRepo writes a long-lived freilauf_repo cookie', () => {
    let gesetzt = null
    rememberRepo({ setHeader: (k, v) => { gesetzt = [k, v] } }, 3)
    gleich(gesetzt[0], 'set-cookie', 'header name')
    enthaelt(gesetzt[1], 'freilauf_repo=3', 'value')
    enthaelt(gesetzt[1], 'Max-Age=31536000', 'long-lived — the choice stays until it is changed')
    enthaelt(gesetzt[1], 'Path=/', 'valid on every page')
  })
  await pruefe('requestRepo reads an explicit ?repo= off the request', () => {
    gleich(requestRepo({ url: '/?repo=7' }), 7, 'on the overview')
    gleich(requestRepo({ url: '/runs/abc-123?repo=7' }), 7, 'on a page that belongs to one repo')
    gleich(requestRepo({ url: '/agents/edit?id=4&repo=7' }), 7, 'among other parameters')
    gleich(requestRepo({ url: '/settings' }), null, 'no query at all')
    gleich(requestRepo({ url: '/?status=running' }), null, 'a query without repo')
    gleich(requestRepo({ url: '/?repo=' }), null, 'empty value')
    gleich(requestRepo({ url: '/?repo=abc' }), null, 'non-numeric value')
    gleich(requestRepo({ url: '/?repo=-1' }), null, 'no id is negative')
    gleich(requestRepo({}), null, 'no url at all')
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
  await pruefe('central format: the timezone resolves by language and by explicit choice', () => {
    gleich(timezoneForLanguage('de'), 'Europe/Berlin', 'German → Berlin')
    gleich(timezoneForLanguage('zh'), 'Asia/Shanghai', 'Chinese → Shanghai')
    gleich(timezoneForLanguage('en'), null, 'English names no zone → server default')
    gleich(timezoneForLanguage('xx'), null, 'unknown language names no zone')
    wahr(validTz('Europe/Berlin'), 'a real IANA name is valid')
    falsch(validTz('Mars/Olympus'), 'nonsense is not')
    falsch(validTz(''), 'empty is not')
    wahr(TIMEZONE_OPTIONS.includes('Europe/Berlin'), 'the settings list carries the common zones')
  })
  await pruefe('central format: fmtClock and fmtDatePart convert to the configured zone', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    setTimezone('Europe/Berlin')
    gleich(fmtClock(ms), '14:00', 'Berlin is UTC+2 in August')
    gleich(fmtDatePart(ms), '25.08.', 'the date part travels with the zone')
    setTimezone('America/New_York')
    gleich(fmtClock(ms), '08:00', 'New York is UTC-4 in August')
    setTimezone('')                            // back to auto
    gleich(fmtClock(NaN), '', 'invalid ms is empty')
    gleich(fmtDatePart(NaN), '', 'invalid ms is empty')
  })
  await pruefe('central format: fmtDateTime and fmtDbUtc follow the configured zone', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    setTimezone('Europe/Berlin')
    const de = fmtDateTime(ms, 'de')
    wahr(de.includes('25.08.2026') && de.includes('14:00'), 'Berlin afternoon, German: ' + de)
    gleich(fmtDbUtc('2026-08-25 12:00:00'), fmtDateTime(ms), 'DB UTC string == the instant')
    gleich(fmtDbUtc(''), '', 'empty DB stamp')
    setTimezone('')
  })
  await pruefe('central format: numbers and percentages follow the UI locale', async () => {
    const { setLanguage } = await import('../server/i18n.mjs')
    setLanguage('de')
    gleich(fmtNum(1234.5, { maximumFractionDigits: 1 }), '1.234,5', 'German thousands+decimal')
    gleich(fmtPercent(78.5), '78,5 %', 'German percentage')
    gleich(fmtPercent(null), '?', 'missing stays a question mark')
    setLanguage('en')
    gleich(fmtNum(1234.5, { maximumFractionDigits: 1 }), '1,234.5', 'English thousands+decimal')
    gleich(fmtPercent(78.5), '78.5 %', 'English percentage')
    setLanguage('en')
  })
  await pruefe('central format: tzAbbrev names the configured zone', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    setTimezone('Europe/Berlin')
    wahr(String(tzAbbrev(ms)).length > 0, 'a Berlin summer stamp has an abbreviation')
    setTimezone('')
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
    process.env.FREILAUF_QUOTA_JSON = pfad
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
  gruppe('Which 7-day window binds: the general one always, a per-model one only for that model')

  // The bug: `seven` was the MAXIMUM of every weekly window, so a Fable week at
  // 96 % deferred a run on Sonnet — a window that run does not draw from at all.
  // The general week binds everything; a scoped one binds its own model.
  const quotaWindows = {
    five: 3, resets_at: '2026-08-29T12:00:00.000Z',
    seven: 96, seven_general: 40, seven_resets_at: '2026-08-30T06:00:00.000Z',
    weekly_scoped: [{ label: 'Fable', pct: 96, resets_at: '2026-08-30T05:00:00.000Z' }],
  }

  await pruefe('the model identifier decides, in every spelling it comes in', async () => {
    const { windowAppliesToModel } = await quotaMit('{}', 12)
    wahr(windowAppliesToModel('Fable', 'fable'), 'the alias')
    wahr(windowAppliesToModel('Fable', 'claude-fable-5'), 'the full identifier')
    wahr(windowAppliesToModel('Claude Fable 5', 'fable'), "a label that spells the vendor's name out")
    falsch(windowAppliesToModel('Fable', 'claude-sonnet-5'), 'a different model')
    falsch(windowAppliesToModel('Opus', 'claude-fable-5'), 'and the other way round')
    wahr(windowAppliesToModel('Fable', ''), 'no model at all: conservative, every window binds')
    wahr(windowAppliesToModel('Fable', null), 'and null is no model either')
    wahr(windowAppliesToModel('7d', 'claude-sonnet-5'),
      'a label that names no model cannot be ruled out, so it binds')
  })

  await pruefe('a full per-model week defers that model and nothing else', async () => {
    const { claudeGateBlocked, sevenFor } = await quotaMit('{}', 13)
    gleich(sevenFor(quotaWindows, 'claude-fable-5'), 96, 'the fable run sees its own week')
    gleich(sevenFor(quotaWindows, 'claude-sonnet-5'), 40, 'the sonnet run sees the general one')
    wahr(claudeGateBlocked(quotaWindows, 'fable').blocked, 'fable is deferred')
    falsch(claudeGateBlocked(quotaWindows, 'claude-sonnet-5').blocked, 'sonnet starts')
    wahr(claudeGateBlocked(quotaWindows).blocked,
      'without a model every window binds — the run may be on the CLI default')
  })

  await pruefe('the general week defers every model', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 14)
    const q = { ...quotaWindows, seven: 97, seven_general: 97 }
    wahr(claudeGateBlocked(q, 'claude-sonnet-5').blocked, 'sonnet')
    wahr(claudeGateBlocked(q, 'fable').blocked, 'fable')
  })

  await pruefe('the block names the window and hands out ITS reset time', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 15)
    const g = claudeGateBlocked(quotaWindows, 'fable')
    wahr(/Fable/.test(g.reason), `the reason names the window: ${g.reason}`)
    gleich(g.resets_at, '2026-08-30T05:00:00.000Z', "the blocking window's own reset, not the 5-hour one")
    const f = claudeGateBlocked({ ...quotaWindows, five: 99 }, 'claude-sonnet-5')
    gleich(f.resets_at, '2026-08-29T12:00:00.000Z', 'a 5-hour block hands out the 5-hour reset')
  })

  await pruefe('only a claude run is measured against claude windows', async () => {
    const { sevenForRun } = await quotaMit('{}', 16)
    gleich(sevenForRun({ harness: 'claude', model: 'claude-sonnet-5' }, quotaWindows), 40, 'claude/sonnet')
    gleich(sevenForRun({ harness: 'claude', model: 'fable' }, quotaWindows), 96, 'claude/fable')
    gleich(sevenForRun({ harness: 'hermes', model: 'deepseek/deepseek-v4' }, quotaWindows), 96,
      'another harness: its model says nothing about these windows, so nothing is filtered out')
  })

  await pruefe('quotaFullWindow names the window that is full and binds the run', async () => {
    const { quotaFullWindow } = await quotaMit('{}', 20)
    // 5-hour window full: it binds every claude run and comes first.
    gleich(JSON.stringify(quotaFullWindow({ five: 100, resets_at: 'R5', weekly_scoped: [] }, 'claude-sonnet-5')),
      '{"label":"5h","pct":100,"resets_at":"R5"}', '5 h full')
    // A 7-day window full: the run's own model's window, named like the panel.
    gleich(JSON.stringify(quotaFullWindow({
      ...quotaWindows, five: 0,
      weekly_scoped: [{ label: 'Fable', pct: 100, resets_at: 'R-F' }],
    }, 'fable')), '{"label":"7d Fable","pct":100,"resets_at":"R-F"}', 'fable week full, named')
    // The general week full, for a run whose own week is fine.
    const general = { ...quotaWindows, five: 0, seven_general: 100, weekly_scoped: [{ label: 'Fable', pct: 40, resets_at: 'X' }] }
    gleich(JSON.stringify(quotaFullWindow(general, 'claude-sonnet-5')),
      '{"label":"7d","pct":100,"resets_at":"2026-08-30T06:00:00.000Z"}', 'general week, labelled 7d')
    // A window full that is NOT this run's — sonnet is not affected by fable.
    const fremd = { ...quotaWindows, five: 0, seven_general: 40, weekly_scoped: [{ label: 'Fable', pct: 100, resets_at: 'R-F' }] }
    gleich(quotaFullWindow(fremd, 'claude-sonnet-5'), null, 'somebody else\u2019s window is not the run\u2019s')
    // Nothing binds at 100 % → null (the run is not flagged).
    gleich(quotaFullWindow({ ...quotaWindows, five: 0, seven_general: 40 }, 'claude-sonnet-5'), null, 'nothing full')
  })

  await pruefe('an object carrying no window list is taken at its word', async () => {
    const { sevenFor, claudeGateBlocked } = await quotaMit('{}', 17)
    gleich(sevenFor({ five: 0, seven: 88 }, 'fable'), 88, 'the number it has is the answer')
    wahr(claudeGateBlocked({ five: 0, seven: 95 }, 'claude-sonnet-5').blocked, 'and it still gates')
  })

  await pruefe('thresholds are configurable per window; defaults stay 90/95', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 18)
    const q = { five: 80, seven: 88 }
    falsch(claudeGateBlocked(q).blocked, 'defaults: 80 % and 88 % pass')
    wahr(claudeGateBlocked(q, null, { five: 75, seven: 90 }).blocked, 'a 5 h threshold of 75 blocks the 80 %')
    falsch(claudeGateBlocked(q, null, { five: 85, seven: 90 }).blocked, 'a 5 h threshold of 85 lets the 80 % pass')
    wahr(claudeGateBlocked(q, null, { five: 90, seven: 85 }).blocked, 'a 7 d threshold of 85 blocks the 88 %')
  })

  await pruefe('the fable week has its own threshold', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 19)
    const q = {
      five: 0, seven: 94, seven_general: 90, seven_resets_at: 'Y',
      weekly_scoped: [{ label: 'Fable', pct: 92, resets_at: 'X' }],
    }
    falsch(claudeGateBlocked(q, 'fable').blocked, 'defaults: fable 92 % passes')
    const g = claudeGateBlocked(q, 'fable', { fable: 90 })
    wahr(g.blocked, 'fable 92 % blocks against its own threshold of 90')
    enthaelt(g.reason, 'Fable', 'the reason names the fable window')
    gleich(g.resets_at, 'X', 'the fable window hands out its own reset time')
    falsch(claudeGateBlocked(q, 'claude-sonnet-5', { fable: 90 }).blocked,
      'a run on another model is not held back by the fable threshold')
  })

  await pruefe('deepseek gate: the account verdict, low USD, and no signal', async () => {
    const echt = global.fetch
    process.env.DEEPSEEK_API_KEY = 'ds-test'
    const ds = (nr) => import(`../server/quota.mjs?ds=${nr}`)
    try {
      const { deepseekGateBlocked: g1 } = await ds(1)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: false, balance_infos: [{ currency: 'USD', total_balance: '50' }],
      }) })
      const b = await g1(2)
      wahr(b.blocked, 'available=false blocks even with plenty of money')
      enthaelt(b.reason, 'unavailable', 'the reason names the verdict')

      const { deepseekGateBlocked: g2 } = await ds(2)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1' }],
      }) })
      const low = await g2(2)
      wahr(low.blocked, 'USD 1 below the minimum of 2 blocks')
      enthaelt(low.reason, 'DeepSeek', 'the reason names the provider')

      const { deepseekGateBlocked: g3 } = await ds(3)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '7000' }],
      }) })
      const cny = await g3(2)
      falsch(cny.blocked, 'a CNY-only account reports no USD — no signal, no block')

      const { deepseekGateBlocked: g4 } = await ds(4)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: true, balance_infos: [{ currency: 'USD', total_balance: '7' }],
      }) })
      const ok = await g4(2)
      falsch(ok.blocked, 'USD 7 above the minimum passes')

      const { deepseekGateBlocked: g5 } = await ds(5)
      delete process.env.DEEPSEEK_API_KEY
      falsch((await g5(2)).blocked, 'without a key the gate stays open')
    } finally {
      global.fetch = echt
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  await pruefe('budgetGate routes by provider and honours the on/off switches', async () => {
    // The scheduler loads quota.mjs on ITS import, so the fixture path and the
    // settings must stand before that import happens.
    const quotaPfad = join(sandkasten, 'quota-budgetgate.json')
    writeFileSync(quotaPfad, JSON.stringify({
      five_hour: { used_percentage: 97, resets_at: 1800000000 },
      seven_day: { used_percentage: 98 },
    }))
    process.env.FREILAUF_QUOTA_JSON = quotaPfad
    const { setSetting } = await import('../server/db.mjs')
    const { budgetGate } = await import('../server/scheduler.mjs')
    setSetting('claude_gate_on', '1')
    setSetting('deepseek_gate_on', '1')
    setSetting('openrouter_gate_on', '1')
    setSetting('deepseek_min_usd', '2')
    setSetting('openrouter_min_eur', '5')
    const echt = global.fetch
    const alt = {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      FREILAUF_CURSOR_AUTH: process.env.FREILAUF_CURSOR_AUTH,
    }
    const cursorAuth = join(sandkasten, 'cursor-auth.json')
    writeFileSync(cursorAuth, JSON.stringify({ accessToken: 't' }))
    process.env.DEEPSEEK_API_KEY = 'ds-test'
    process.env.OPENROUTER_API_KEY = 'or-test'
    process.env.FREILAUF_CURSOR_AUTH = cursorAuth
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('deepseek')) return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1' }] }) }
      if (u.includes('GetCurrentPeriodUsage')) return { ok: true, json: async () => ({ planUsage: { limit: 2000, totalSpend: 1990 } }) }
      if (u.includes('GetAggregatedUsageEvents')) return { ok: true, json: async () => ({ totalCostCents: 1990 }) }
      if (u.includes('full_stripe_profile')) return { ok: true, json: async () => ({ membershipType: 'pro' }) }
      return { ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 99.5 } }) }
    }
    try {
      const ds = await budgetGate('hermes', 'deepseek/deepseek-v4', 'deepseek')
      wahr(!!ds && /DeepSeek/.test(ds.reason), 'a deepseek run is gated by the DeepSeek balance')
      const or = await budgetGate('opencode', 'openrouter/x', 'openrouter')
      wahr(!!or && /OpenRouter/.test(or.reason), 'an openrouter run by the OpenRouter balance')
      const fb = await budgetGate('opencode', 'whatever', null)
      wahr(!!fb && /OpenRouter/.test(fb.reason), 'no provider falls back to the OpenRouter gate')
      falsch(await budgetGate('opencode', 'x', 'opencode-zen'),
        'opencode-zen reports no balance — no signal, no block')
      const claude = await budgetGate('claude', 'claude-sonnet-5')
      wahr(!!claude && /Claude quota/.test(claude.reason), 'a claude run by the claude gate')
      const cursor = await budgetGate('cursor', 'auto')
      wahr(!!cursor && /Cursor/.test(cursor.reason), 'a cursor run by the cursor gate')

      setSetting('deepseek_gate_on', '0')
      falsch(await budgetGate('hermes', 'deepseek/deepseek-v4', 'deepseek'),
        'switched off, the DeepSeek gate cannot block')
      setSetting('openrouter_gate_on', '0')
      falsch(await budgetGate('opencode', 'x', null),
        'switched off, the OpenRouter gate cannot block')
      setSetting('claude_gate_on', '0')
      falsch(await budgetGate('claude', 'claude-sonnet-5'),
        'switched off, the claude gate cannot block even a full quota')
      setSetting('cursor_gate_on', '0')
      falsch(await budgetGate('cursor', 'auto'),
        'switched off, the cursor gate cannot block')
    } finally {
      global.fetch = echt
      for (const [k, v] of Object.entries(alt)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
      setSetting('claude_gate_on', '1')
      setSetting('deepseek_gate_on', '1')
      setSetting('openrouter_gate_on', '1')
      setSetting('cursor_gate_on', '1')
    }
  })

  await pruefe('budgetGate asks the coding agent first, the provider second, OpenRouter last', async () => {
    // The three steps of the routing, and the two that the test above does not
    // reach: a claude run carries a provider too (from a favorite, from a
    // stored definition), and an id the hub does not know at all must still
    // land somewhere rather than starting ungated.
    const { setSetting } = await import('../server/db.mjs')
    const { budgetGate } = await import('../server/scheduler.mjs')
    const { registerPlugin, unregisterPlugin } = await import('../server/plugins/registry.mjs')
    const echt = global.fetch
    const alt = { or: process.env.OPENROUTER_API_KEY, ds: process.env.DEEPSEEK_API_KEY }
    process.env.OPENROUTER_API_KEY = 'or-test'
    delete process.env.DEEPSEEK_API_KEY
    setSetting('claude_gate_on', '1')
    setSetting('openrouter_gate_on', '1')
    setSetting('openrouter_min_eur', '5')
    global.fetch = async () => ({ ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 99.5 } }) })
    const eigene = []
    try {
      // 1. The coding agent's own gate wins. claude runs on its subscription;
      //    a provider travelling along says nothing about that account, and
      //    asking the OpenRouter balance about a claude run would be a block
      //    for somebody else's money.
      const claude = await budgetGate('claude', 'claude-sonnet-5', 'openrouter')
      wahr(!!claude && /Claude quota/.test(claude.reason),
        `the claude gate answers even with a provider present (${claude?.reason})`)

      // 2. A provider that declares no gate is no signal — opencode-zen
      //    reports no balance, and "unknown" must never mean "blocked".
      falsch(await budgetGate('opencode', 'x', 'opencode-zen'), 'a gateless provider blocks nothing')

      // 3. LEGACY_DEFAULT_GATE: a provider the hub has never heard of falls
      //    through to OpenRouter, which is where the provider-based harnesses
      //    have always been measured.
      const unbekannt = await budgetGate('opencode', 'x', 'no-such-provider')
      wahr(!!unbekannt && /OpenRouter/.test(unbekannt.reason),
        `an unknown provider falls back to the legacy gate (${unbekannt?.reason})`)

      // A gate that throws must not stop the hub from starting runs: a broken
      // plugin is a reason to say so in the log, never to block the pipeline.
      const kaputt = {
        id: 'unit-gate-throws', kind: 'harness', label: 'G', bin: 'g', subscription: true, providers: [],
        logPatterns: [{ typ: 'rate_limit', re: /x/ }],
        modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null,
        gate: { fields: [], check: async () => { throw new Error('plugin is broken') } },
      }
      if (registerPlugin(kaputt, { source: 'external' }).ok) eigene.push(kaputt.id)
      falsch(await budgetGate('unit-gate-throws', 'm'), 'a throwing gate is an open gate')

      // …and a gate that answers something useless is not an answer either.
      const stumm = { ...kaputt, id: 'unit-gate-mute', gate: { fields: [], check: async () => ({ }) } }
      if (registerPlugin(stumm, { source: 'external' }).ok) eigene.push(stumm.id)
      falsch(await budgetGate('unit-gate-mute', 'm'), 'a block with no reason does not block')
    } finally {
      global.fetch = echt
      for (const id of eigene) unregisterPlugin(id)
      if (alt.or === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = alt.or
      if (alt.ds !== undefined) process.env.DEEPSEEK_API_KEY = alt.ds
    }
  })

  await pruefe('cursor gate measures the included usage against its own threshold', async () => {
    const echt = global.fetch
    const auth = join(sandkasten, 'cursor-gate-auth.json')
    writeFileSync(auth, JSON.stringify({ accessToken: 't' }))
    const alt = process.env.FREILAUF_CURSOR_AUTH
    process.env.FREILAUF_CURSOR_AUTH = auth
    const cu = (nr) => import(`../server/quota.mjs?cu=${nr}`)
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('GetCurrentPeriodUsage')) return { ok: true, json: async () => ({ planUsage: { limit: 2000, totalSpend: 1990 } }) }
      if (u.includes('GetAggregatedUsageEvents')) return { ok: true, json: async () => ({ totalCostCents: 1990 }) }
      return { ok: true, json: async () => ({ membershipType: 'pro' }) }
    }
    try {
      const { cursorGateBlocked } = await cu(1)
      const g = await cursorGateBlocked(95, 20)
      wahr(g.blocked, '99.5 % blocks against a threshold of 95')
      enthaelt(g.reason, 'Cursor', 'the reason names the provider')

      const { cursorGateBlocked: g2 } = await cu(2)
      falsch((await g2(99.9, 20)).blocked, '99.5 % passes against a threshold of 99.9')

      process.env.FREILAUF_CURSOR_AUTH = join(sandkasten, 'missing-cursor-gate-auth.json')
      const { cursorGateBlocked: g3 } = await cu(3)
      falsch((await g3(95, 20)).blocked, 'no token → no signal → the gate stays open')
    } finally {
      global.fetch = echt
      if (alt === undefined) delete process.env.FREILAUF_CURSOR_AUTH; else process.env.FREILAUF_CURSOR_AUTH = alt
    }
  })

  // ------------------------------------------------------------------
  gruppe('Claude usage: the account answers, the file is the fallback')

  // The bug this group was written for: quota.json is maintained by a status
  // line and by a script from another project, so it went stale whenever nobody
  // was running a claude session — silently, because the numbers looked current.
  // Measured 2026-08-28: the panel showed a per-model week of 80 % while the
  // account said 88 %, off a file written seven hours earlier.
  const cu = await import('../server/claude-usage.mjs')

  // A real response of GET /api/oauth/usage, recorded on 2026-08-28.
  const realResponse = {
    limits: [
      { kind: 'session', group: 'session', percent: 5, resets_at: '2026-08-28T13:49:59.830958+00:00', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 78, resets_at: '2026-08-30T05:59:59.830975+00:00', scope: null },
      {
        kind: 'weekly_scoped', group: 'weekly', percent: 88,
        resets_at: '2026-08-30T05:59:59.831186+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      },
    ],
  }

  await pruefe('limits[] is mapped by group/kind, not by position', () => {
    const p = cu._parseLimits(realResponse)
    gleich(p.five, 5, 'the session window is the 5-hour one')
    gleich(p.seven_general, 78, 'weekly_all is the general week')
    gleich(p.weekly_scoped.length, 1, 'one per-model week')
    gleich(p.weekly_scoped[0].label, 'Fable', "the vendor's own display name, not a hardcoded one")
    gleich(p.weekly_scoped[0].pct, 88, 'its percentage')
    wahr(p.weekly_scoped[0].resets_at?.startsWith('2026-08-30'),
      'and its OWN reset time — the file never carried one for this window')
  })

  await pruefe('a second scoped model needs no code change', () => {
    const p = cu._parseLimits({ limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 10, resets_at: null, scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 20, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 30, scope: { model: { display_name: 'Opus' } } },
    ] })
    gleich(p.weekly_scoped.map(w => `${w.label}:${w.pct}`).join(','), 'Fable:20,Opus:30', 'both are carried')
  })

  await pruefe('an answer without a single window is not an answer', () => {
    gleich(cu._parseLimits({ limits: [] }), null, 'empty list')
    gleich(cu._parseLimits({}), null, 'no limits key at all')
    gleich(cu._parseLimits({ limits: [{ kind: 'session', percent: null }] }), null,
      'an entry without a percentage does not count as one')
  })

  await pruefe('the live answer wins over the file, per field', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 3, resets_at: 1800000000 },
      seven_day: { used_percentage: 77 },
      seven_day_fable: { used_percentage: 80 },
    }), 9)
    cu._claudeLimitsSet(cu._parseLimits(realResponse))
    const q = claudeQuota()
    gleich(q.five, 5, 'the stale 3 % from the file is replaced')
    gleich(q.seven_general, 78, 'and the stale 77 %')
    gleich(q.seven_fable, 88, 'and the 80 % that was seven hours old')
    gleich(q.seven, 88, 'the gate value is the highest weekly window')
    wahr(q.live === true, 'the answer says it came from the account')
    cu._claudeLimitsReset()
  })

  await pruefe('what the account does not report, the file still supplies', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 42, resets_at: 1800000000 },
      seven_day: { used_percentage: 11 },
    }), 10)
    // A live answer that knows only the weekly windows — the merge is per field,
    // so the 5-hour window a status line wrote minutes ago is not thrown away.
    cu._claudeLimitsSet({ five: null, resets_at: null, seven_general: 60, seven_resets_at: null, weekly_scoped: [] })
    const q = claudeQuota()
    gleich(q.five, 42, '5-hour window comes out of the file')
    gleich(q.seven_general, 60, 'the week comes from the account')
    cu._claudeLimitsReset()
  })

  await pruefe('a live answer that has aged out falls back to the file', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 7 }, seven_day: { used_percentage: 12 },
    }), 11)
    // Older than the TTL: a live number an hour old is worse than the file,
    // which a running claude session at least keeps moving.
    cu._claudeLimitsSet(cu._parseLimits(realResponse), Date.now() - 3600_000)
    const q = claudeQuota()
    gleich(q.five, 7, 'the file decides again')
    gleich(q.seven_general, 12, 'in both windows')
    falsch(q.live, 'and the answer no longer claims to be live')
    cu._claudeLimitsReset()
  })

  // The bar jumped: 88 from the account, 80 out of the file, 88, 80 — because
  // the file's per-model window is written by another project's script on its
  // own occasions (measured 2026-08-29: `fetched_at` 45 hours behind the
  // five_hour block right next to it) and it won every gap in the live answer.
  const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000).toISOString()
  const liveWithFable = (pct) => ({
    five: 18, resets_at: null, seven_general: 60, seven_resets_at: null,
    weekly_scoped: [{ label: 'Fable', pct, resets_at: inTwoDays() }],
  })
  const liveWithoutFable = { five: 18, resets_at: null, seven_general: 60, seven_resets_at: null, weekly_scoped: [] }
  const fileWithFable = (pct, ageHours) => JSON.stringify({
    five_hour: { used_percentage: 18 }, seven_day: { used_percentage: 10 },
    seven_day_fable: { used_percentage: pct, fetched_at: Math.floor(Date.now() / 1000) - ageHours * 3600 },
  })

  await pruefe('a per-model week the account stops reporting keeps its last live value', async () => {
    const { claudeQuota } = await quotaMit(fileWithFable(80, 45), 12)
    cu._claudeLimitsReset()
    cu._claudeLimitsSet(liveWithFable(88))
    gleich(claudeQuota().seven_fable, 88, 'the account answered')
    // No scoped window in the answer at all: a 429, an expired token, or simply
    // a moment at which the account reports none.
    cu._claudeLimitsSet(liveWithoutFable)
    const q = claudeQuota()
    gleich(q.seven_fable, 88, 'the bar stands still instead of dropping to the 45-hour-old 80 %')
    gleich(q.seven, 88, 'and the gate keeps reading the higher window')
    gleich(q.weekly_scoped[0].stale, true, 'it is marked as not-current, so the panel can say when it was read')
    cu._claudeLimitsReset()
  })

  await pruefe('the newer reading wins — the file too, when it is the newer one', async () => {
    const { claudeQuota } = await quotaMit(fileWithFable(92, 0), 13)
    cu._claudeLimitsReset()
    cu._claudeLimitsSet(liveWithFable(88), Date.now() - 3 * 3600_000)   // remembered, three hours old
    gleich(claudeQuota().seven_fable, 92, 'a file written just now beats a live reading from this morning')
    cu._claudeLimitsReset()
  })

  await pruefe('a remembered window is forgotten once it has rolled over', async () => {
    const { claudeQuota } = await quotaMit(fileWithFable(80, 45), 14)
    cu._claudeLimitsReset()
    cu._claudeLimitsSet({
      ...liveWithoutFable,
      weekly_scoped: [{ label: 'Fable', pct: 88, resets_at: new Date(Date.now() - 3600_000).toISOString() }],
    }, Date.now() - 2 * 3600_000)
    gleich(claudeQuota().seven_fable, 80, 'knowledge from before the reset is worthless, not conservative')
    cu._claudeLimitsReset()
  })

  await pruefe('the remembered windows survive a restart', async () => {
    cu._claudeLimitsReset()
    cu._claudeLimitsSet(liveWithFable(88))
    // A second instance of the module is a restarted hub: nothing in memory, and
    // the file it wrote is all there is.
    const restarted = await import('../server/claude-usage.mjs?restart=1')
    gleich(restarted.rememberedScoped().find(w => w.label === 'Fable')?.pct, 88,
      'the account’s last answer outlives the process')
    cu._claudeLimitsReset()
  })

  await pruefe('without a credentials file nothing is fetched and nothing throws', async () => {
    const before = process.env.FREILAUF_CLAUDE_CREDENTIALS
    process.env.FREILAUF_CLAUDE_CREDENTIALS = join(sandkasten, 'no-such-credentials.json')
    // No URL is set either: were a request made anyway, this would hang or throw
    // rather than quietly pass.
    gleich(await cu.refreshClaudeLimits({ force: true }), null, 'no token, no answer')
    gleich(cu.claudeLimits(), null, 'and nothing cached')
    if (before === undefined) delete process.env.FREILAUF_CLAUDE_CREDENTIALS
    else process.env.FREILAUF_CLAUDE_CREDENTIALS = before
  })

  await pruefe('an expired token is not used and is not refreshed', async () => {
    const credPath = join(sandkasten, 'expired-credentials.json')
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() - 1000 },
    }))
    const before = process.env.FREILAUF_CLAUDE_CREDENTIALS
    process.env.FREILAUF_CLAUDE_CREDENTIALS = credPath
    gleich(await cu.refreshClaudeLimits({ force: true }), null, 'expired means silent')
    const after = JSON.parse(readFileSync(credPath, 'utf8'))
    gleich(after.claudeAiOauth.accessToken, 'x', 'the credentials file is never written back')
    if (before === undefined) delete process.env.FREILAUF_CLAUDE_CREDENTIALS
    else process.env.FREILAUF_CLAUDE_CREDENTIALS = before
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
    enthaelt(t, 'fl-report done', 'completion report')
    enthaelt(t, 'fl-report help', 'call for help')
  })
  await pruefe('the operator\'s own rules are an ADDITION and cannot delete the finishing command', () => {
    // This field used to REPLACE the whole block. It is called a suffix, it
    // starts out empty and it looks like a free notepad — so the day somebody
    // wrote their working rules into it, every prompt on this hub silently lost
    // "at the end always fl-report done". The runs kept working and kept not
    // reporting; one of them held up the queue for a day.
    const t = platformSuffix(lauf, 'REGEL', { prompt_suffix: 'Immer Tests schreiben. Lauf {run_id}.' })
    enthaelt(t, 'Immer Tests schreiben.', 'the addition is there')
    enthaelt(t, 'Lauf abc-123.', 'and its placeholders are filled too')
    enthaelt(t, 'Platform rules', 'the platform rules stay')
    enthaelt(t, 'fl-report done --file', 'and so does the finishing command')
    wahr(t.indexOf('Immer Tests schreiben.') < t.indexOf('HOW THIS RUN ENDS'),
      'how the run ends stands last — that is what runs fail on')
  })
  await pruefe('an empty field adds nothing at all', () => {
    const leer = platformSuffix(lauf, 'REGEL', { prompt_suffix: '   ' })
    gleich(leer, platformSuffix(lauf, 'REGEL', {}), 'whitespace is not a rule')
    falsch(leer.includes('Operator rules'), 'no empty section header')
  })
  await pruefe('the finishing command names a concrete file outside the working directory', () => {
    // A run died of a vague instruction: "fl-report done --file <report.md>" left
    // both the path and the fact that it is mandatory to the model's judgement.
    // Now the command is copy-and-paste ready — and the file lies next to the
    // run's log, not in the worktree, which a report file would leave dirty.
    const t = platformSuffix(lauf, 'egal', {})
    enthaelt(t, 'fl-report done --file /', 'absolute path in the command')
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
    const [datei, ...weitere] = HP.cursor.hookFiles({ flReport: '/bin/fl-report' })
    gleich(weitere.length, 0, 'one file')
    gleich(datei.path, '.cursor/hooks.json', 'in the workspace, where cursor looks')
    const j = JSON.parse(datei.content)
    gleich(j.hooks.stop[0].command, '/bin/fl-report _turn_end', 'stop reports the turn end')
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
    process.env.FREILAUF_CURSOR_DIR = '/c'
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
    } finally { delete process.env.FREILAUF_CURSOR_DIR }
  })

  // ------------------------------------------------------------------
  gruppe('Detection: rate limit / provider errors (detect.mjs)')
  const { typVonClaudeFehler, typVonText, terminalText, scanneZeilen, scanneNeueBytes,
    transkriptFehler, bewerteLogTreffer, fremdeClaudeSession, vorfallWeggrund } = await import('../server/detect.mjs')

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
      '✓ hook report (fl-report _api_error via stdin) → RED; rate limit counter increments',
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

  // The false alarm of 2026-08-30: an agent testing a fake model id
  // (`nosuch/model-xyz`) spawned its own claude, which inherited the worktree's
  // hooks and FL_RUN_ID — its StopFailure landed on the healthy parent run as a
  // red "Model unavailable". The session id is the discriminator.
  await pruefe('a claude hook report from a foreign session is recognized', () => {
    const runId = 'a4a392ae-9a66-46db-bd03-4d4636465841'
    falsch(fremdeClaudeSession(runId, 'claude', runId), 'the run\'s own session (--session-id <run id>)')
    falsch(fremdeClaudeSession(runId, 'claude', ''), 'no session id (older fl-report): the run\'s own')
    falsch(fremdeClaudeSession(runId, 'claude', null), 'null: the run\'s own')
    falsch(fremdeClaudeSession(runId, 'cursor', 'andere-session'), 'the guard is claude-only')
    wahr(fremdeClaudeSession(runId, 'claude', '0f7c3b1e-0000-4000-8000-000000000000'),
      'a claude with its own session id is a process the agent spawned')
  })

  // Auto-resolve: an incident whose condition is demonstrably gone closes
  // itself — the run came through, or the agent demonstrably kept working
  // after the occurrence. Silence proves nothing for red (a blocked agent is
  // silent too), so red resolves only on positive evidence.
  await pruefe('vorfallWeggrund: gone is gone — done runs, work after the hit, expired yellow', () => {
    const t0 = Date.parse('2026-08-30T08:14:19Z')
    const config = (ueber) => ({ zuletztGesehenMs: t0, jetztMs: t0 + 20 * 60_000, ...ueber })
    // The run came through: the incident during it answered itself.
    gleich(vorfallWeggrund(config({ typ: 'model_error', schwere: 'rot', runStatus: 'done', letzteAktivitaetMs: null })),
      'run finished successfully', 'done run: even auth/billing/model close')
    // A red incident on a run that is still going: only measurable work after
    // the occurrence and no recurrence since resolves it.
    gleich(vorfallWeggrund(config({ typ: 'model_error', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000 })), 'agent kept working after it', 'work after the hit')
    gleich(vorfallWeggrund(config({ typ: 'model_error', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 5 * 60_000 })), null, 'too soon after the hit')
    gleich(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 - 60_000 })), null, 'silence proves nothing for red')
    gleich(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: null })), null, 'no activity source (hermes): red stays')
    // A red incident on a failed run is WHY it failed — a human decides.
    gleich(vorfallWeggrund(config({ typ: 'auth_error', schwere: 'rot', runStatus: 'failed',
      letzteAktivitaetMs: t0 + 60_000 })), null, 'red on a failed run stays')
    // Yellow: the old 30-minute rule, generalized.
    gleich(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 31 * 60_000 })), 'expired: agent kept working', 'yellow: agent worked on')
    gleich(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 20 * 60_000 })), null, 'yellow: less than half an hour')
    gleich(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'running',
      letzteAktivitaetMs: null, jetztMs: t0 + 31 * 60_000 })), 'expired: no recurrence', 'yellow without an activity source')
    gleich(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'aborted',
      letzteAktivitaetMs: null, jetztMs: t0 + 31 * 60_000 })), 'expired: run ended', 'yellow on an ended run')
    // Never by time alone:
    gleich(vorfallWeggrund(config({ typ: 'merge_blocked', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000 })), null, 'merge_blocked is the integrator\'s decision')
    gleich(vorfallWeggrund(config({ typ: 'provider_down:deepseek', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000 })), null, 'provider_down has its own recovery loop')
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
  process.env.FREILAUF_ZUSAETZE_DIR = zdir
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
  const { validateDescriptor } = await import('../server/plugins/manifest.mjs')

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
    // >= and not ==: the registry is mutable now, and an external package in
    // FREILAUF_PLUGIN_DIR is allowed to be in it. What must hold is that the four
    // built-ins are all still there.
    wahr(harnessIds().length >= 4, `at least the four built-in coding agents (got ${harnessIds().length})`)
    for (const id of ['claude', 'opencode', 'hermes', 'cursor']) wahr(harnessIds().includes(id), `built-in ${id}`)
  })

  // The optional half of the contract (docs/plugins.md). Every one of these
  // fields may be absent — a plugin without them stays valid, which is the
  // assertion that matters: the checks below run only WHEN a field is there,
  // and a `for` over an empty list is the passing case.
  await pruefe('the optional plugin fields are shaped right where they exist — and optional where they do not', () => {
    const alle = [...Object.values(HARNESS_PLUGINS), ...Object.values(PROVIDER_PLUGINS)]
    wahr(alle.length >= 7, 'both registries are populated')
    for (const p of alle) {
      if (p.credentials !== undefined) {
        wahr(Array.isArray(p.credentials), `${p.id}: credentials is a list`)
        for (const c of p.credentials) {
          wahr(!!c.key && typeof c.key === 'string', `${p.id}: credential has a key`)
          wahr(Array.isArray(c.envKeys), `${p.id}.${c.key}: envKeys is a list`)
          if (c.required !== undefined) wahr(typeof c.required === 'boolean', `${p.id}.${c.key}: required is a flag`)
        }
      }
      if (p.gate !== undefined) {
        wahr(typeof p.gate.check === 'function', `${p.id}: gate.check`)
        wahr(Array.isArray(p.gate.fields), `${p.id}: gate.fields is a list`)
        for (const f of p.gate.fields) {
          wahr(!!f.key, `${p.id}: gate field has a key`)
          wahr(['number', 'text', 'password', 'select', 'switch'].includes(f.type), `${p.id}.${f.key}: known field type`)
        }
      }
      if (p.llm !== undefined) {
        wahr(typeof p.llm.complete === 'function', `${p.id}: llm.complete`)
        wahr(['native', 'json_object', 'prompt'].includes(p.llm.schema), `${p.id}: llm.schema is one of the three`)
        if (p.llm.models !== undefined) wahr(typeof p.llm.models === 'function', `${p.id}: llm.models`)
        if (p.llm.overhead !== undefined) wahr(typeof p.llm.overhead === 'boolean', `${p.id}: llm.overhead is a flag`)
      }
      if (p.launch !== undefined) {
        wahr(Array.isArray(p.launch.args) && p.launch.args.length > 0, `${p.id}: launch.args`)
        wahr(['argv', 'stdin', 'file'].includes(p.launch.promptMode ?? 'argv'), `${p.id}: known promptMode`)
      }
      if (p.settings !== undefined) wahr(Array.isArray(p.settings), `${p.id}: settings is a list`)
    }
    // And the negative half, so "optional" is not merely an untested word: a
    // descriptor carrying none of the four still passes validateDescriptor.
    const bare = {
      id: 'bare-provider', label: 'Bare', envKeys: ['BARE_KEY'], fetchModels: async () => [],
    }
    wahr(validateDescriptor(bare, 'provider').ok, 'a provider with no credentials/gate/llm/launch is valid')
    const bareHarness = {
      id: 'bare-agent', label: 'Bare', bin: 'bare', subscription: false, providers: [],
      logPatterns: [{ typ: 'rate_limit', re: /x/ }],
      modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null,
    }
    wahr(validateDescriptor(bareHarness, 'harness').ok, 'a coding agent with none of them is valid')
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
    const altAuth = process.env.FREILAUF_CURSOR_AUTH
    process.env.FREILAUF_CURSOR_AUTH = auth
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
      if (altAuth === undefined) delete process.env.FREILAUF_CURSOR_AUTH
      else process.env.FREILAUF_CURSOR_AUTH = altAuth
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
  gruppe('Plugin manifests: what a stranger\'s package must say (plugins/manifest.mjs)')

  // This is the one part of the plugin machinery that needs no sandbox and no
  // database — and it is what decides whether somebody else's directory is
  // allowed anywhere near the hub. Pure functions, so the edge cases are cheap.
  const { validateManifest, PLUGIN_API } = await import('../server/plugins/manifest.mjs')
  const gutesManifest = (over = {}) => ({
    api: 1, id: 'mistral', kind: 'provider', name: 'Mistral', version: '1.0.0',
    description: 'Mistral models', homepage: 'https://example.invalid', author: 'Someone', ...over,
  })

  await pruefe('a good manifest is accepted and normalized', () => {
    const r = validateManifest(gutesManifest())
    wahr(r.ok, `accepted (${r.problems.join('; ')})`)
    gleich(r.value.id, 'mistral', 'id')
    gleich(r.value.kind, 'provider', 'kind')
    gleich(r.value.version, '1.0.0', 'version')
    // `main` is defaulted rather than demanded: a package that says nothing
    // about it means the file every example ships.
    gleich(r.value.main, 'index.mjs', 'main defaults to index.mjs')
    gleich(r.value.api, PLUGIN_API, 'the api the hub speaks')
  })
  await pruefe('an explicit main is kept, one pointing outside the package is refused', () => {
    gleich(validateManifest(gutesManifest({ main: 'src/plugin.mjs' })).value.main, 'src/plugin.mjs', 'kept')
    // A manifest that could name `../../.ssh/id_rsa` would let a package import
    // anything on the machine — the loader is handed a relative name or nothing.
    falsch(validateManifest(gutesManifest({ main: '../evil.mjs' })).ok, 'a path escaping the package')
    falsch(validateManifest(gutesManifest({ main: '/etc/passwd' })).ok, 'an absolute path')
    falsch(validateManifest(gutesManifest({ main: '' })).ok, 'an empty main')
  })
  await pruefe('a manifest for another api version is refused, and says so', () => {
    const r = validateManifest(gutesManifest({ api: 2 }))
    falsch(r.ok, 'refused')
    wahr(r.value === null, 'nothing to register')
    wahr(r.problems.some(p => /api/i.test(p)), `the problem names the api (${r.problems.join('; ')})`)
    falsch(validateManifest(gutesManifest({ api: '1' })).ok, 'a string "1" is not the number 1')
    falsch(validateManifest(gutesManifest({ api: undefined })).ok, 'no api at all')
  })
  await pruefe('a bad id is refused — the id is a directory name and a database key', () => {
    for (const id of ['Mistral', 'x', '', 'mi stral', '-lead', 'mistral!', 'a'.repeat(41)]) {
      falsch(validateManifest(gutesManifest({ id })).ok, `refused: ${JSON.stringify(id)}`)
    }
    for (const id of ['ab', 'mistral-large', 'x9', 'a'.repeat(40)]) {
      wahr(validateManifest(gutesManifest({ id })).ok, `accepted: ${JSON.stringify(id)}`)
    }
  })
  await pruefe('a bad kind is refused — there are exactly three', () => {
    for (const kind of ['harness', 'provider', 'notifier']) wahr(validateManifest(gutesManifest({ kind })).ok, kind)
    for (const kind of ['Harness', 'model', 'notify', '', undefined]) {
      falsch(validateManifest(gutesManifest({ kind })).ok, `refused: ${JSON.stringify(kind)}`)
    }
  })
  await pruefe('name and version are demanded; anything that is not an object is refused outright', () => {
    falsch(validateManifest(gutesManifest({ name: '  ' })).ok, 'a blank name')
    falsch(validateManifest(gutesManifest({ version: undefined })).ok, 'no version')
    for (const junk of [null, 'text', 42, ['a']]) falsch(validateManifest(junk).ok, `refused: ${JSON.stringify(junk)}`)
  })

  await pruefe('validateDescriptor holds both kinds to their minimum', () => {
    const p = { id: 'p', label: 'P', envKeys: ['P_KEY'], fetchModels: async () => [] }
    wahr(validateDescriptor(p, 'provider').ok, 'a minimal provider')
    // `credentials` is the richer form of `envKeys`; either one satisfies it.
    wahr(validateDescriptor({ ...p, envKeys: undefined, credentials: [{ key: 'api_key', envKeys: ['P_KEY'] }] }, 'provider').ok,
      'credentials instead of envKeys')
    falsch(validateDescriptor({ ...p, envKeys: undefined }, 'provider').ok, 'neither of the two')
    falsch(validateDescriptor({ ...p, fetchModels: undefined }, 'provider').ok, 'no fetchModels')
    falsch(validateDescriptor({ ...p, label: '' }, 'provider').ok, 'no label')

    const h = {
      id: 'h', label: 'H', bin: 'hbin', subscription: false, providers: [],
      logPatterns: [{ typ: 'rate_limit', re: /x/ }],
      modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null,
    }
    wahr(validateDescriptor(h, 'harness').ok, 'a minimal coding agent')
    falsch(validateDescriptor({ ...h, bin: undefined }, 'harness').ok, 'no bin')
    falsch(validateDescriptor({ ...h, subscription: 'yes' }, 'harness').ok, 'subscription must be a boolean')
    falsch(validateDescriptor({ ...h, logPatterns: [] }, 'harness').ok, 'an empty log pattern list')
    falsch(validateDescriptor({ ...h, pulseId: null }, 'harness').ok, 'a missing function')
    // …and the optional fields really are optional in BOTH directions: adding
    // them must not make a valid descriptor invalid either.
    wahr(validateDescriptor({ ...h, credentials: [{ key: 'k', envKeys: [] }], gate: { fields: [], check: async () => null }, llm: { schema: 'prompt', complete: async () => ({}) }, launch: { args: ['x'] } }, 'harness').ok,
      'all four optional fields present')
    // A notifier's minimum is one function. Everything that makes it
    // configurable — settings, credentials, a setup wizard, a test — is
    // optional, because the smallest useful channel is a webhook with a URL in
    // a setting and a `send` that posts to it.
    const n = { id: 'n', label: 'N', send: async () => ({ ok: true }) }
    wahr(validateDescriptor(n, 'notifier').ok, 'a minimal notifier')
    falsch(validateDescriptor({ ...n, send: undefined }, 'notifier').ok, 'no send')
    falsch(validateDescriptor({ ...n, send: 'yes' }, 'notifier').ok, 'send is not a function')
    falsch(validateDescriptor({ ...n, label: '' }, 'notifier').ok, 'no label')
    wahr(validateDescriptor({ ...n, settings: [{ key: 'url', type: 'text' }], credentials: [{ key: 'k', envKeys: [] }], setup: { render: async () => '' }, test: async () => ({ ok: true }) }, 'notifier').ok,
      'and every optional half present')

    falsch(validateDescriptor(h, 'model-source').ok, 'an unknown kind')
    falsch(validateDescriptor(null, 'harness').ok, 'no descriptor at all')
  })

  // ------------------------------------------------------------------
  gruppe('The hub\'s own LLM calls: tolerant JSON (llm/json.mjs)')

  const { extractJson } = await import('../server/llm/json.mjs')

  await pruefe('valid JSON is returned untouched — no repair may "fix" a correct answer', () => {
    const r = extractJson('{"title":"Fix the finish gate"}')
    wahr(r.ok, 'parsed')
    gleich(r.value.title, 'Fix the finish gate', 'value')
    gleich(r.repaired.length, 0, 'nothing was repaired')
  })
  await pruefe('a markdown fence with prose around it is cut out', () => {
    const r = extractJson('Sure, here is the JSON:\n```json\n{"title":"x"}\n```\nHope that helps!')
    wahr(r.ok, 'parsed')
    gleich(r.value.title, 'x', 'value')
    enthaelt(r.note, 'fence', 'the note says where it was found')
    // The same without a language tag, and with a fence the model never closed.
    wahr(extractJson('```\n{"a":1}\n```').ok, 'no language tag')
    wahr(extractJson('here:\n```json\n{"a":1}').ok, 'an unclosed fence')
  })
  await pruefe('a } inside a string value does not close the object', () => {
    // This is why the scan is a character scanner and not a regular expression:
    // a report sentence with a brace in it is the first thing that breaks one.
    const r = extractJson('{"title":"a } b","note":"and ] too","n":1}')
    wahr(r.ok, 'parsed')
    gleich(r.value.title, 'a } b', 'the brace stayed inside the string')
    gleich(r.value.note, 'and ] too', 'so did the bracket')
    gleich(r.value.n, 1, 'and the object really did close at the end')
    // Prose after a document that contains a brace must not shorten it either.
    const r2 = extractJson('Result: {"t":"} done"} — that is all.')
    wahr(r2.ok && r2.value.t === '} done', 'cut out of prose without losing the brace')
  })
  await pruefe('a trailing comma is repaired, and the repair is named', () => {
    const r = extractJson('{"a":1,"b":[1,2,],}')
    wahr(r.ok, 'parsed')
    gleich(r.value.b.length, 2, 'the array kept its two entries')
    wahr(r.repaired.some(x => /trailing comma/.test(x)), `named (${r.repaired.join(', ')})`)
  })
  await pruefe('single-quoted keys and values are re-quoted', () => {
    const r = extractJson("{'title': 'it\\'s fine', unquoted: 3}")
    wahr(r.ok, 'parsed')
    gleich(r.value.title, "it's fine", 'the escaped quote survived')
    gleich(r.value.unquoted, 3, 'a bare key was quoted')
  })
  await pruefe('typographic quotes are replaced with straight ones', () => {
    const r = extractJson('{“title”: “Schön”}')
    wahr(r.ok, 'parsed')
    gleich(r.value.title, 'Schön', 'value')
    wahr(r.repaired.some(x => /typographic/.test(x)), `named (${r.repaired.join(', ')})`)
  })
  await pruefe('NaN and Infinity become null rather than a parse failure', () => {
    const r = extractJson('{"a": NaN, "b": Infinity, "c": -Infinity, "d": +3}')
    wahr(r.ok, 'parsed')
    wahr(r.value.a === null && r.value.b === null && r.value.c === null, 'the three non-numbers are null')
    gleich(r.value.d, 3, 'a stray leading + is dropped')
  })
  await pruefe('a truncated document fails cleanly — no fragment is ever returned', () => {
    // The dangerous failure is not "it did not parse", it is "it parsed into
    // half an answer". Both shapes must answer ok:false with nothing in value.
    for (const text of ['{"a": "unterminat', '{"a": 1', '{"list": [1, 2', '{"a": "x\\']) {
      const r = extractJson(text)
      falsch(r.ok, `refused: ${JSON.stringify(text)}`)
      wahr(r.value === null, 'and value is null, not a fragment')
    }
    const prosa = extractJson('I am afraid I cannot do that.')
    falsch(prosa.ok, 'prose with no JSON in it at all')
    enthaelt(prosa.note, 'no candidate parsed', 'and the note says what was tried')
    const leer = extractJson('')
    falsch(leer.ok, 'an empty answer')
    enthaelt(leer.note, 'no JSON document found', 'and that one says there was nothing to try')
  })

  // ------------------------------------------------------------------
  gruppe('The hub\'s own LLM calls: the schema subset (llm/schema.mjs)')

  const { validate: schemaValidate, strictPrompt } = await import('../server/llm/schema.mjs')
  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string' },
      n: { type: 'integer' },
      ok: { type: 'boolean' },
      mode: { type: 'string', enum: ['copy', 'link'] },
      list: { type: 'array', items: { type: 'string' } },
    },
  }

  await pruefe('a required field that is missing is a problem, with its path', () => {
    const r = schemaValidate(SCHEMA, {})
    falsch(r.ok, 'not valid')
    gleich(r.problems.length, 1, 'exactly the one problem')
    gleich(r.problems[0].path, 'data.title', 'the path a model can act on')
    enthaelt(r.problems[0].message, 'required', 'and what is wrong')
    // An OPTIONAL field that is missing is not a problem — it becomes null so
    // nothing downstream ever meets undefined.
    wahr(r.value.n === null, 'a missing optional is null')
  })
  await pruefe('an enum violation names the path and the allowed values', () => {
    const r = schemaValidate(SCHEMA, { title: 't', mode: 'sideways' })
    falsch(r.ok, 'not valid')
    gleich(r.problems[0].path, 'data.mode', 'path')
    enthaelt(r.problems[0].message, '"copy"', 'the allowed values are listed')
    enthaelt(r.problems[0].message, '"link"', 'both of them')
    // A near miss is a coercion, not a failure: models answer "Copy" often
    // enough that rejecting it would cost an otherwise correct answer.
    const near = schemaValidate(SCHEMA, { title: 't', mode: ' Copy ' })
    wahr(near.ok, 'a near miss is accepted')
    gleich(near.value.mode, 'copy', 'and corrected to the declared spelling')
  })
  await pruefe('the coercions: "true" is a boolean, "3" is a number, one value is a one-element array', () => {
    const r = schemaValidate(SCHEMA, { title: 't', n: '3', ok: 'true', list: 'only-one' })
    wahr(r.ok, `valid (${JSON.stringify(r.problems)})`)
    gleich(r.value.n, 3, 'numeric string')
    gleich(r.value.ok, true, 'boolean word')
    wahr(Array.isArray(r.value.list) && r.value.list.length === 1 && r.value.list[0] === 'only-one',
      'a single value became a one-element list')
    gleich(schemaValidate(SCHEMA, { title: 't', ok: 'no' }).value.ok, false, '"no" is false')
    gleich(schemaValidate(SCHEMA, { title: 't', ok: 1 }).value.ok, true, '1 is true')
    gleich(schemaValidate(SCHEMA, { title: 42 }).value.title, '42', 'a number where a string was asked for')
    // What is NOT coerced: something that says nothing about the answer.
    falsch(schemaValidate(SCHEMA, { title: 't', n: 'many' }).ok, '"many" is not a number')
    falsch(schemaValidate(SCHEMA, { title: 't', ok: 'perhaps' }).ok, '"perhaps" is not a boolean')
    falsch(schemaValidate(SCHEMA, { title: { a: 1 } }).ok, 'an object where a string was asked for')
  })
  await pruefe('additionalProperties:false drops what was not asked for, it does not fail', () => {
    // A model that volunteers a "reasoning" field next to a correct answer has
    // still answered correctly.
    const r = schemaValidate(SCHEMA, { title: 't', reasoning: 'because', extra: [1, 2] })
    wahr(r.ok, 'still valid')
    falsch('reasoning' in r.value, 'the extra field is gone')
    falsch('extra' in r.value, 'and so is the other one')
    // Without the keyword the extra field is kept — that is the difference.
    const offen = schemaValidate({ type: 'object', properties: { title: { type: 'string' } } },
      { title: 't', reasoning: 'because' })
    gleich(offen.value.reasoning, 'because', 'an open schema keeps it')
  })
  await pruefe('a nested problem carries the full path', () => {
    const r = schemaValidate(SCHEMA, { title: 't', list: ['a', 7, { b: 1 }] })
    falsch(r.ok, 'not valid')
    gleich(r.problems[0].path, 'data.list[2]', 'the offending index is named')
    gleich(r.value.list[1], '7', 'the coercible neighbour was still coerced')
  })
  await pruefe('the strict prompt forbids exactly what models do wrong', () => {
    const p = strictPrompt(SCHEMA, { schemaName: 'run_title' })
    enthaelt(p, 'run_title', 'the schema is named')
    enthaelt(p, 'code fences', 'fences are forbidden')
    enthaelt(p, 'Schema:', 'the schema itself is shown')
    enthaelt(p, '"title"', 'including its fields')
    // The example teaches the SHAPE; the enum contributes a real value because
    // that is the one place a real value teaches instead of tempting a copy.
    enthaelt(p, '"copy"', 'the enum names its first value in the example')
  })

  // ------------------------------------------------------------------
  gruppe('The hub\'s own LLM calls: the alarm throttle (llm/alerts.mjs)')

  // The problem this exists for: a wrong key fails on EVERY call, and the hub
  // makes one per run title, one per log hit, one per flow step. The clock is
  // injected (`nowMs`, like integrateTick) so none of this waits.
  const { llmAlert, _alertReset, _alertState, alertSignature } = await import('../server/llm/alerts.mjs')
  const { setSetting: setzen, getSetting: lesen } = await import('../server/db.mjs')
  const T0 = 1_700_000_000_000
  const gesendet = []
  const echtesFetch = global.fetch
  const alarmVorher = {
    token: lesen('telegram_token'), chat: lesen('telegram_chat'),
    on: lesen('llm_alert_on'), fenster: lesen('llm_alert_window_min'), max: lesen('llm_alert_max_per_hour'),
  }
  const alarmAufbauen = () => {
    setzen('telegram_token', 'unit-token')
    setzen('telegram_chat', '42')
    setzen('llm_alert_on', '1')
    setzen('llm_alert_window_min', '30')
    setzen('llm_alert_max_per_hour', '6')
    gesendet.length = 0
    _alertReset()
    global.fetch = async (url, init) => {
      gesendet.push(JSON.parse(init.body).text)
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
  }
  const alarm = (over = {}) => llmAlert({
    purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'http_401', ...over,
  })

  try {
    await pruefe('the first failure is sent, a second one inside the window is counted instead', async () => {
      alarmAufbauen()
      gleich((await alarm({ nowMs: T0 })).reason, 'sent', 'the first one goes out')
      const zweite = await alarm({ nowMs: T0 + 60_000 })
      gleich(zweite.reason, 'throttled', 'the second is held back')
      gleich(zweite.suppressed, 1, 'and counted')
      gleich((await alarm({ nowMs: T0 + 120_000 })).suppressed, 2, 'the count grows')
      gleich(gesendet.length, 1, 'still one message on the wire')
    })
    await pruefe('what was suppressed is named in the next message for that signature', async () => {
      // Silence about 47 swallowed failures would be a worse lie than 47
      // messages — the count is the whole reason the throttle is allowed.
      const nach = await alarm({ nowMs: T0 + 31 * 60_000 })
      gleich(nach.reason, 'sent', 'past the window it goes out again')
      gleich(gesendet.length, 2, 'the second message')
      enthaelt(gesendet[1], '2 further failures', 'it names what was held back')
      gleich(_alertState().signatures[alertSignature({ purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'http_401' })].suppressed, 0,
        'and a DELIVERED message forgets the count')
    })
    await pruefe('a different signature is a different failure and is not throttled by the first', async () => {
      alarmAufbauen()
      gleich((await alarm({ nowMs: T0 })).reason, 'sent', 'the first')
      gleich((await alarm({ nowMs: T0, errorClass: 'no_json' })).reason, 'sent', 'another error class')
      gleich((await alarm({ nowMs: T0, purpose: 'check' })).reason, 'sent', 'another caller')
      gleich((await alarm({ nowMs: T0, model: 'other' })).reason, 'sent', 'another model')
      gleich(gesendet.length, 4, 'four messages, four signatures')
      gleich((await alarm({ nowMs: T0 })).reason, 'throttled', 'but the first signature is still held')
    })
    await pruefe('the hourly ceiling holds across all signatures, and says how many it swallowed', async () => {
      alarmAufbauen()
      setzen('llm_alert_max_per_hour', '2')
      for (const p of ['title', 'check']) gleich((await alarm({ nowMs: T0, purpose: p })).reason, 'sent', p)
      gleich((await alarm({ nowMs: T0, purpose: 'extract' })).reason, 'ceiling', 'the third is over the ceiling')
      gleich((await alarm({ nowMs: T0, purpose: 'extras' })).reason, 'ceiling', 'and so is the fourth')
      gleich(gesendet.length, 2, 'two messages an hour means two messages')
      gleich(_alertState().ceilingSuppressed, 2, 'and the hub knows how many it kept back')
      // An hour later the window has rolled and the ceiling reports itself.
      gleich((await alarm({ nowMs: T0 + 61 * 60_000, purpose: 'extract' })).reason, 'sent', 'an hour on')
      enthaelt(gesendet.at(-1), 'held back', 'the message names the ceiling')
    })
    await pruefe('llm_alert_on=0 silences it completely', async () => {
      alarmAufbauen()
      setzen('llm_alert_on', '0')
      const r = await alarm({ nowMs: T0 })
      gleich(r.reason, 'off', 'switched off')
      gleich(gesendet.length, 0, 'nothing on the wire')
    })
    await pruefe('an empty window or ceiling setting falls back to the default, not to zero', async () => {
      // Number('') is 0 AND finite — without the guard an unconfigured hub
      // would read every default as "never" (a ceiling of 0 messages).
      alarmAufbauen()
      setzen('llm_alert_window_min', '')
      setzen('llm_alert_max_per_hour', '')
      gleich((await alarm({ nowMs: T0 })).reason, 'sent', 'the default ceiling still lets one through')
      gleich((await alarm({ nowMs: T0 + 60_000 })).reason, 'throttled', 'the default window still throttles')
    })
    await pruefe('a broken alarm channel is never the caller\'s problem', async () => {
      // A title, a flow step or a log hit must not be able to fail because the
      // alarm channel is having a bad day — in either of its two bad days.
      alarmAufbauen()
      global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
      const abgelehnt = await alarm({ nowMs: T0 })
      wahr(abgelehnt.sent === false, 'the channel refused it')
      gleich(abgelehnt.reason, 'unreachable', 'and that is the answer, not a throw')
      // A failed send KEEPS the count, so the next message still names those
      // failures — only a delivered one may forget them.
      alarmAufbauen()
      const kaputt = await alarm({ nowMs: T0, purpose: { toString() { throw new Error('boom') } } })
      wahr(kaputt.sent === false, 'something inside threw')
      gleich(kaputt.reason, 'error', 'and it came back as a result all the same')
    })
  } finally {
    global.fetch = echtesFetch
    _alertReset()
    // The token must not survive into the groups below: they would start
    // talking to api.telegram.org for real.
    setzen('telegram_token', alarmVorher.token ?? '')
    setzen('telegram_chat', alarmVorher.chat ?? '')
    setzen('llm_alert_on', alarmVorher.on ?? '1')
    setzen('llm_alert_window_min', alarmVorher.fenster ?? '')
    setzen('llm_alert_max_per_hour', alarmVorher.max ?? '')
  }

  // ------------------------------------------------------------------
  gruppe('llmJson: transport classification and the OpenRouter recovery round')
  const { llmJson, classifyTransportError } = await import('../server/llm/index.mjs')
  const { setLanguage: sprache } = await import('../server/i18n.mjs')
  const { setSetting: setz, getSetting: lese } = await import('../server/db.mjs')
  sprache('en')   // the assertions below read the English catalog

  await pruefe('classifyTransportError names the failure from the status code', () => {
    gleich(classifyTransportError(new Error('HTTP 401')).kind, 'http_401', 'auth')
    gleich(classifyTransportError(new Error('HTTP 402')).kind, 'http_402', 'credits')
    gleich(classifyTransportError(new Error('HTTP 404')).kind, 'http_404', 'model')
    gleich(classifyTransportError(new Error('HTTP 429')).kind, 'http_429', 'rate limit')
    gleich(classifyTransportError(new Error('HTTP 503')).kind, 'http_5xx', '5xx are one class')
    gleich(classifyTransportError(new Error('HTTP 500')).kind, 'http_5xx', '500 too')
    gleich(classifyTransportError(new Error('HTTP 503')).code, 503, 'the code is kept for the message')
    const timeout = new Error('This operation was aborted')
    timeout.name = 'TimeoutError'
    gleich(classifyTransportError(timeout).kind, 'timeout', 'a timeout is its own class')
    gleich(classifyTransportError(new Error('ENOTFOUND api.openrouter.ai')).kind, 'transport', 'anything else stays generic')
  })
  await pruefe('a non-2xx answer fails with a classified, translated detail — and no reprompt', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'unit-key'
    const echt = globalThis.fetch
    let chats = 0
    globalThis.fetch = async () => { chats++; return { ok: false, status: 429, json: async () => ({}) } }
    try {
      const r = await llmJson({
        source: 'provider:openrouter', model: 'a/b', prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      falsch(r.ok, 'the call failed')
      gleich(r.stage, 'transport', 'the bucket stays transport')
      gleich(r.kind, 'http_429', 'and the specific class is carried for the caller')
      gleich(chats, 1, 'a transport failure is never reprompted')
      enthaelt(r.error, 'Rate limit reached (HTTP 429)', 'the detail names the problem in English')
      enthaelt(r.error, 'too often', 'and what it means')
    } finally {
      globalThis.fetch = echt
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await pruefe('a parse failure on OpenRouter re-asks once through a FRESH best-provider selection', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'unit-key'
    const echt = globalThis.fetch
    let chats = 0
    let endpoints = 0
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/endpoints')) {
        endpoints++
        return { ok: true, json: async () => ({ data: { endpoints: [
          { tag: 'p/fp8', provider_name: 'P', quantization: 'fp8', status: 0, uptime_last_30m: 100,
            supported_parameters: ['tools'], pricing: { prompt: '0.0000001', completion: '0.0000002' } },
        ] } }) }
      }
      chats++
      // The model answers prose every time — the exact failure from the alert.
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Here is my title: best provider wins.' } }] }) }
    }
    const frage = {
      source: 'provider:openrouter', model: 'deepseek/deepseek-v4-flash', prompt: 'Rewrite the login form',
      schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
      schemaName: 'run_title', purpose: 'title', maxTokens: 200,
    }
    try {
      const r = await llmJson(frage)
      gleich(chats, 3, 'first + repair + recovery round = three calls')
      gleich(endpoints, 1, 'the recovery round re-selects the serving provider')
      falsch(r.ok, 'prose is prose — the honest failure still arrives')
      gleich(r.stage, 'parse', 'and stays a parse problem')
      enthaelt(r.error, 'could not be read as JSON', 'the detail says what happened')
      enthaelt(r.error, 'Re-selecting the best serving provider', 'and that the recovery round was already spent')
      const zweite = await llmJson(frage)
      gleich(endpoints, 2, 'the SECOND recovery round still resolves FRESH — the cache is bypassed')
      falsch(zweite.ok, 'and still fails honestly')
    } finally {
      globalThis.fetch = echt
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await pruefe('llmAlert names a classified failure in the operator\'s language', async () => {
    const { llmAlert, _alertReset } = await import('../server/llm/alerts.mjs')
    const tokenVorher = lese('telegram_token')
    const chatVorher = lese('telegram_chat')
    const echt = globalThis.fetch
    const gesendet = []
    setz('telegram_token', 'unit-token')
    setz('telegram_chat', '42')
    _alertReset()
    globalThis.fetch = async (url, init) => { gesendet.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({ ok: true }) } }
    try {
      const r = await llmAlert({ purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'http_429', text: 'Rate limit reached (HTTP 429) — the provider is being asked too often.' })
      gleich(r.reason, 'sent', 'the alert went out')
      enthaelt(gesendet[0], 'What went wrong: rate limit', 'the kind line is translated')
      enthaelt(gesendet[0], 'Detail: Rate limit reached (HTTP 429)', 'and the detail follows')
      // An unknown class falls back to the code, never to a made-up sentence.
      await llmAlert({ purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'http_408', text: 'x' })
      enthaelt(gesendet.at(-1), 'What went wrong: http_408', 'unknown classes stay honest')
    } finally {
      globalThis.fetch = echt
      _alertReset()
      setz('telegram_token', tokenVorher ?? '')
      setz('telegram_chat', chatVorher ?? '')
    }
  })
  // ------------------------------------------------------------------
  gruppe('Notifications: the third plugin kind, and a hub that says nothing (notify.mjs)')

  // The rule this whole group exists for: NOTHING configured is a complete
  // installation. `notify()` is then a silent no-op — no throw, no rejection,
  // no half-sent message — and every caller in the hub gets a value back it can
  // ignore.
  const notifyMod = await import('../server/notify.mjs')
  const {
    registerPlugin: registriere, unregisterPlugin: entferne,
    getPlugin: holePlugin, pluginKind: artVon, registryErrors: registerFehler,
  } = await import('../server/plugins/registry.mjs')
  const { setPluginConfig, isPluginEnabled } = await import('../server/plugins/store.mjs')
  const { default: unitDb } = await import('../server/db.mjs')

  await pruefe('the built-in Telegram notifier is registered as its own kind', () => {
    gleich(artVon('telegram'), 'notifier', 'the registry knows what it is')
    const p = holePlugin('telegram')
    wahr(typeof p?.send === 'function', 'it can send')
    // Its two settings keep the keys they have always had — that is what makes
    // the whole rebuild a no-migration change.
    const keys = (p.settings ?? []).map(f => f.settingKey)
    gleich(keys.sort().join(','), 'telegram_chat,telegram_token', 'the historic settings keys')
    wahr((p.settings ?? []).every(f => f.required), 'both are required, which is what "configured" means here')
    wahr(notifyMod.notifierPlugins().some(x => x.id === 'telegram'), 'and the facade lists it')
  })

  await pruefe('a duplicate notifier id is refused, never overridden', () => {
    const vorher = registerFehler().length
    const r = registriere({ id: 'telegram', kind: 'notifier', label: 'Not really', send: async () => ({ ok: true }) })
    falsch(r.ok, 'refused')
    enthaelt(r.error, 'already taken', 'and it says why')
    gleich(registerFehler().length, vorher + 1, 'the refusal is recorded for the Plugins page')
    gleich(holePlugin('telegram').label, 'Telegram', 'the built-in still stands')
  })

  {
    // A notifier of the suite's own, registered for the length of this block:
    // the only way to assert on the MESSAGE the hub composes.
    const empfangen = []
    const stub = {
      id: 'unit-notifier', kind: 'notifier', label: 'Unit Notifier',
      settings: [{ key: 'target', type: 'text', required: true, labelKey: 'unit.target' }],
      async send(message) { empfangen.push(message); return { ok: true } },
    }
    const reg = registriere(stub, { source: 'external' })
    try {
      await pruefe('an external notifier joins the registry and is configured like any other plugin', () => {
        wahr(reg.ok, `registered (${reg.error ?? ''})`)
        gleich(artVon('unit-notifier'), 'notifier', 'as a notifier')
        // Registered is not configured: a `required` setting with no value is
        // exactly what keeps the hub quiet.
        falsch(notifyMod.notifierConfigured('unit-notifier'), 'not configured yet')
        // An unconfigured notifier is nevertheless ENABLED — the provider rule,
        // and for a reason one step stronger: an installation that already had
        // a token has no plugin_config row either, and an off-by-default
        // notifier would silence a channel that worked the minute before.
        wahr(isPluginEnabled('unit-notifier'), 'but switched on by default')
      })

      await pruefe('with nothing configured notify() is a silent no-op, and says so calmly', async () => {
        falsch(notifyMod.notifiersConfigured(), 'nothing is configured')
        const r = await notifyMod.notify({ kind: 'system', text: 'nobody hears this' })
        falsch(r.sent, 'nothing was sent')
        gleich(r.delivered, 0, 'nothing was delivered')
        gleich(r.results.length, 0, 'and nobody was even asked')
        gleich(empfangen.length, 0, 'the stub heard nothing')
        // The one thing it must never do.
        const leer = await notifyMod.notify('')
        falsch(leer.sent, 'an empty message is not an error either')
      })

      await pruefe('a configured notifier receives the normalized message', async () => {
        setzen('plugin_unit-notifier_target', '/dev/null')
        wahr(notifyMod.notifierConfigured('unit-notifier'), 'the required setting is filled in')
        wahr(notifyMod.notifiersConfigured(), 'so the hub has a channel')
        const r = await notifyMod.notify({ kind: 'run', runId: 'r-1', text: 'hello', url: 'https://x.invalid/runs/r-1',
          attachment: { fileName: 'report.md', content: 'the whole report' } })
        wahr(r.sent, 'delivered')
        gleich(r.results.length, 1, 'one channel was asked')
        const m = empfangen.at(-1)
        gleich(m.kind, 'run', 'kind')
        gleich(m.runId, 'r-1', 'runId')
        gleich(m.text, 'hello', 'text')
        gleich(m.attachment.fileName, 'report.md', 'the attachment travels as a file name plus content')
        wahr(String(m.linkLabel).length > 0, 'the link carries a label the channel can render')
        gleich(m.html, null, 'html is offered but the hub composes plain text')
      })

      await pruefe('a bare string is accepted, and an empty attachment is no attachment', async () => {
        await notifyMod.notify('just a line')
        gleich(empfangen.at(-1).text, 'just a line', 'the string became the text')
        gleich(empfangen.at(-1).kind, 'system', 'with the default kind')
        await notifyMod.notify({ text: 'x', attachment: { fileName: 'a.md', content: '' } })
        gleich(empfangen.at(-1).attachment, null, 'an empty file is dropped rather than sent as nothing')
      })

      await pruefe('a channel that throws costs its own message and nothing else', async () => {
        notifyMod._notifyLogReset()
        const kaputt = {
          id: 'unit-broken', kind: 'notifier', label: 'Broken',
          async send() { throw new Error('the api is on fire') },
        }
        const r2 = registriere(kaputt, { source: 'external' })
        wahr(r2.ok, 'the broken one is registered too')
        try {
          const r = await notifyMod.notify({ kind: 'system', text: 'through both' })
          wahr(r.sent, 'the working channel still took it')
          gleich(r.delivered, 1, 'exactly one delivery')
          gleich(r.results.length, 2, 'both were asked')
          const bad = r.results.find(x => x.id === 'unit-broken')
          falsch(bad.ok, 'the broken one failed')
          enthaelt(bad.error, 'on fire', 'with its own message')
          gleich(empfangen.at(-1).text, 'through both', 'and the good one got the message')
        } finally { entferne('unit-broken') }
      })

      await pruefe('sendTest calls test() with the SAME arguments as send()', async () => {
        // The facade calls whichever of the two exists with `(message, ctx)`. A
        // plugin declaring `test(ctx, message)` would hand the message to the
        // context parameter and nothing would notice — the built-in Telegram
        // notifier did exactly that until this test existed.
        const gesehen = []
        const zwei = {
          id: 'unit-two', kind: 'notifier', label: 'Two',
          async send(message, ctx) { gesehen.push(['send', message, ctx]); return { ok: true } },
          async test(message, ctx) { gesehen.push(['test', message, ctx]); return { ok: true } },
        }
        wahr(registriere(zwei, { source: 'external' }).ok, 'registered')
        try {
          const r = await notifyMod.sendTest('unit-two')
          wahr(r.ok, 'the test message went out')
          const [was, message, ctx] = gesehen.at(-1)
          gleich(was, 'test', 'test() wins over send() when it exists')
          gleich(message.kind, 'test', 'the FIRST argument is the message')
          wahr(typeof ctx?.setting === 'function', 'and the SECOND is the plugin context')
          wahr(String(message.text).length > 0, 'which carries text')
        } finally {
          entferne('unit-two')
          unitDb.prepare('DELETE FROM plugin_config WHERE plugin_id=?').run('unit-two')
        }
      })

      await pruefe('switching it off silences it, and sendTest says which of the two it was', async () => {
        setPluginConfig('unit-notifier', { kind: 'notifier', enabled: 0 })
        falsch(notifyMod.notifiersConfigured(), 'a disabled channel is no channel')
        const vorher = empfangen.length
        await notifyMod.notify('into the void')
        gleich(empfangen.length, vorher, 'nothing was sent')
        // The reason comes back as an i18n KEY, not as an English word: it is
        // rendered to the operator on the Notifications page (and reached from
        // the Telegram wizard's own step 3), so a raw sentence there would be
        // English text on a German UI.
        const t1 = await notifyMod.sendTest('unit-notifier')
        falsch(t1.ok, 'the test refuses')
        gleich(t1.errorKey, 'notify.err_disabled', 'naming the reason, translatably')
        setPluginConfig('unit-notifier', { kind: 'notifier', enabled: 1 })
        setzen('plugin_unit-notifier_target', '')
        gleich((await notifyMod.sendTest('unit-notifier')).errorKey, 'notify.err_not_configured', 'the other reason is its own answer')
        gleich((await notifyMod.sendTest('nope')).errorKey, 'notify.err_unknown', 'and an id nobody registered is a third')
        const katalog = JSON.parse(readFileSync(new URL('../lang/en.json', import.meta.url), 'utf8'))
        for (const k of ['notify.err_disabled', 'notify.err_not_configured', 'notify.err_unknown']) {
          wahr(!!katalog[k], `${k} really exists in the catalog`)
        }
      })
    } finally {
      entferne('unit-notifier')
      unitDb.prepare('DELETE FROM plugin_config WHERE plugin_id IN (?,?)').run('unit-notifier', 'unit-broken')
      setzen('plugin_unit-notifier_target', '')
    }
  }

  await pruefe('the notify flow step keeps its old type name as an alias, never as a second block', async () => {
    const { STEP_MAP, STEP_ALIASES, renameSteps, stepsMeta } = await import('../server/flows/steps.mjs')
    gleich(STEP_ALIASES.telegram, 'notify', 'the rename is declared once')
    wahr(STEP_MAP.notify === STEP_MAP.telegram, 'a stored `telegram` step resolves to the notify step')
    falsch(stepsMeta().some(x => x.type === 'telegram'), 'but the toolbox offers one block, not two')

    // A definition read out of the database comes back in today's names —
    // inside branches and container bodies too, because a rename that stops at
    // the top level renames half a flow.
    const alt = { properties: {}, sequence: [
      { id: 'a', type: 'telegram', properties: { text: 'x' } },
      { id: 'b', type: 'condition', branches: { true: [{ id: 'c', type: 'telegram', properties: {} }], false: [] } },
      { id: 'd', type: 'for_each', sequence: [{ id: 'e', type: 'telegram', properties: {} }] },
    ] }
    const neu = renameSteps(alt)
    gleich(neu.sequence[0].type, 'notify', 'at the top level')
    gleich(neu.sequence[1].branches.true[0].type, 'notify', 'inside a branch')
    gleich(neu.sequence[2].sequence[0].type, 'notify', 'inside a container body')
    gleich(alt.sequence[0].type, 'telegram', 'and the input was not mutated')
    // Anything it cannot walk comes back as it came, rather than throwing.
    gleich(renameSteps(null), null, 'null')
    gleich(renameSteps({ sequence: 'nonsense' }).sequence, 'nonsense', 'a shape it does not know')
  })

  // ------------------------------------------------------------------
  gruppe('Model sources and plugin settings (llm/sources.mjs, plugins/settings.mjs)')

  const { parseSource, sourceId, DEFAULT_SOURCE } = await import('../server/llm/sources.mjs')

  await pruefe('an unprefixed source reads as provider:openrouter — that is the whole backwards compatibility', () => {
    // Every stored `llm_*_source` an existing installation has is empty or a
    // legacy value. Reading those as OpenRouter is what makes a hub that
    // changes nothing behave byte for byte as it did.
    gleich(DEFAULT_SOURCE, 'provider:openrouter', 'the documented default')
    for (const value of ['', '   ', null, undefined, 'openrouter', 'deepseek/deepseek-v4-flash', 'weird:thing']) {
      const s = parseSource(value)
      gleich(`${s.kind}:${s.pluginId}`, 'provider:openrouter', `${JSON.stringify(value)} reads as the default`)
    }
  })
  await pruefe('provider:x and agent:x are read as themselves', () => {
    gleich(parseSource('provider:deepseek').kind, 'provider', 'provider kind')
    gleich(parseSource('provider:deepseek').pluginId, 'deepseek', 'provider id')
    gleich(parseSource('agent:claude').kind, 'agent', 'agent kind')
    gleich(parseSource('agent:claude').pluginId, 'claude', 'agent id')
    gleich(parseSource('  provider: deepseek  ').pluginId, 'deepseek', 'whitespace is trimmed')
    // An id with a dash in it is the ordinary case (opencode-zen).
    gleich(parseSource('provider:opencode-zen').pluginId, 'opencode-zen', 'a dashed id')
  })
  await pruefe('sourceId is parseSource\'s inverse, and calls a harness an agent', () => {
    gleich(sourceId('provider', 'deepseek'), 'provider:deepseek', 'a provider')
    // The registry says `harness`; the source string says `agent`, because that
    // is the word the picker shows.
    gleich(sourceId('harness', 'claude'), 'agent:claude', 'a coding agent')
    for (const id of ['provider:deepseek', 'agent:claude']) {
      const s = parseSource(id)
      gleich(sourceId(s.kind, s.pluginId), id, `round trip: ${id}`)
    }
  })

  const { pluginSettingKey, allPluginSettingKeys, pluginFields } =
    await import('../server/plugins/settings.mjs')

  await pruefe('a declared settingKey keeps history; without one the key is namespaced', () => {
    // This is what makes the rebuild need NO settings migration: the built-in
    // gates declare the keys they have always used.
    gleich(pluginSettingKey('claude', { key: 'g5h', settingKey: 'claude_gate_5h' }), 'claude_gate_5h', 'the historic key')
    gleich(pluginSettingKey('mistral', { key: 'threshold' }), 'plugin_mistral_threshold', 'namespaced')
    // Two plugins declaring the same field name is harmless, which is the point.
    wahr(pluginSettingKey('a', { key: 'threshold' }) !== pluginSettingKey('b', { key: 'threshold' }),
      'two plugins, two keys')
  })
  await pruefe('allPluginSettingKeys carries every historic gate key', () => {
    // A key missing from this list is silently dropped by the settings form's
    // allowlist — the threshold would look configurable and never stick.
    const keys = allPluginSettingKeys()
    for (const k of ['claude_gate_on', 'claude_gate_5h', 'claude_gate_7d', 'claude_gate_fable',
      'cursor_gate_on', 'cursor_gate_pct', 'cursor_included_usd',
      'openrouter_gate_on', 'openrouter_min_eur', 'deepseek_gate_on', 'deepseek_min_usd']) {
      wahr(keys.includes(k), `${k} is in the allowlist`)
    }
    gleich(keys.length, new Set(keys).size, 'no duplicates')
  })
  await pruefe('pluginFields answers with a list for anything, including nothing', () => {
    gleich(pluginFields(null).length, 0, 'no plugin')
    gleich(pluginFields({}, 'gate').length, 0, 'no gate')
    gleich(pluginFields({ settings: 'nonsense' }).length, 0, 'a settings field that is not a list')
    gleich(pluginFields({ settings: [{ key: 'a' }, {}, null, { key: '' }] }).length, 1, 'entries without a key are dropped')
  })

  // ------------------------------------------------------------------
  gruppe('The launch declaration: how an external coding agent is started (runner.mjs)')

  const { registerPlugin, unregisterPlugin } = await import('../server/plugins/registry.mjs')
  const { launchSpec, launchable } = await import('../server/runner.mjs')
  const testHarness = (over = {}) => ({
    kind: 'harness', label: 'Test agent', bin: 'testbin', subscription: false, providers: [],
    logPatterns: [{ typ: 'rate_limit', re: /x/ }],
    modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null, ...over,
  })
  const eingetragen = []
  const eintragen = (desc) => {
    const r = registerPlugin(desc, { source: 'external' })
    if (r.ok) eingetragen.push(desc.id)
    return r
  }

  try {
    await pruefe('the four built-ins need no spec — fl-start already knows them', () => {
      // A spec for claude would be a second description of the same launch
      // line, and the two would drift. `launchable` still says yes.
      for (const id of ['claude', 'opencode', 'hermes', 'cursor']) {
        wahr(launchSpec(id) === null, `${id}: no spec`)
        wahr(launchable(id), `${id}: startable all the same`)
      }
    })
    await pruefe('an external descriptor\'s launch declaration is resolved into a spec', () => {
      wahr(eintragen(testHarness({
        id: 'unit-launch', sessionTag: 'ul', installHint: 'npm i -g unit-launch',
        launch: {
          args: ['run', '--model', '{model}', '{prompt}'],
          promptMode: 'argv',
          interactiveArgs: ['-i'],
          stderrLog: '{home}/unit-launch.log',
          submitNudge: { waitFor: 'ctrl+p', timeoutSec: 90 },
        },
      })).ok, 'registered')
      const spec = launchSpec('unit-launch')
      wahr(!!spec, 'a spec came out')
      gleich(spec.harness, 'unit-launch', 'the harness is named in the spec')
      // Resolved, not passed through: bin/sessionTag/installHint are ordinary
      // descriptor fields, and a launch block that says nothing about them
      // means the ones declared next to the id.
      gleich(spec.bin, 'testbin', 'bin comes from the descriptor')
      gleich(spec.sessionTag, 'ul', 'session tag')
      gleich(spec.installHint, 'npm i -g unit-launch', 'install hint')
      gleich(spec.args.join(' '), 'run --model {model} {prompt}', 'the arguments as declared')
      gleich(spec.promptMode, 'argv', 'prompt mode')
      gleich(spec.interactiveArgs.join(' '), '-i', 'interactive arguments')
      gleich(spec.submitNudge.waitFor, 'ctrl+p', 'the submit nudge survives as an object')
      wahr(launchable('unit-launch'), 'and it is startable')
    })
    await pruefe('a launch block may name its own bin, and defaults promptMode to argv', () => {
      wahr(eintragen(testHarness({ id: 'unit-ownbin', launch: { bin: 'other-bin', args: ['go'] } })).ok, 'registered')
      const spec = launchSpec('unit-ownbin')
      gleich(spec.bin, 'other-bin', 'the launch block wins over the descriptor')
      gleich(spec.promptMode, 'argv', 'the default prompt mode')
      falsch('interactiveArgs' in spec, 'nothing is invented that was not declared')
      falsch('submitNudge' in spec, 'and a nudge that was not asked for is absent')
    })
    await pruefe('a coding agent with neither a fl-start case nor a launch block cannot be started', () => {
      // Better to refuse before a worktree exists than to read it out of
      // fl-start's stderr afterwards — a tmux session running nothing.
      wahr(eintragen(testHarness({ id: 'unit-nolaunch' })).ok, 'registered')
      wahr(launchSpec('unit-nolaunch') === null, 'no spec')
      falsch(launchable('unit-nolaunch'), 'and not startable')
      // An empty or malformed args list is the same answer, not a broken spec.
      wahr(eintragen(testHarness({ id: 'unit-emptyargs', launch: { args: [] } })).ok, 'registered')
      falsch(launchable('unit-emptyargs'), 'an empty args list is no declaration')
      wahr(eintragen(testHarness({ id: 'unit-badargs', launch: { args: 'run' } })).ok, 'registered')
      falsch(launchable('unit-badargs'), 'a string is no argument list')
      falsch(launchable('never-registered'), 'an unknown coding agent')
    })
    await pruefe('an id that is already taken is refused, never silently overridden', () => {
      // A package shadowing `claude` could replace the coding agent every run
      // is started with, without saying so anywhere.
      const r = registerPlugin(testHarness({ id: 'claude' }), { source: 'external' })
      falsch(r.ok, 'refused')
      enthaelt(r.error, 'already taken', 'and it says why')
      gleich(launchSpec('claude'), null, 'the built-in is untouched')
      falsch(registerPlugin(testHarness({ id: 'Not Valid' }), { source: 'external' }).ok, 'an invalid id')
      falsch(registerPlugin(testHarness({ id: 'unit-nokind', kind: 'model' }), { source: 'external' }).ok, 'an unknown kind')
      falsch(registerPlugin({ id: 'unit-broken', kind: 'harness', label: 'B' }, { source: 'external' }).ok,
        'a descriptor that does not meet the contract')
    })
    await pruefe('a built-in is never unregistered; an external one is', () => {
      falsch(unregisterPlugin('claude').ok, 'a built-in stays — it is part of the running code')
      wahr(unregisterPlugin('unit-badargs').ok, 'an external one goes')
      eingetragen.splice(eingetragen.indexOf('unit-badargs'), 1)
      falsch(launchable('unit-badargs'), 'and is gone from the registry')
      falsch(unregisterPlugin('unit-badargs').ok, 'twice is not a thing')
    })
  } finally {
    // The registry is process-wide: leaving test plugins in it would show up in
    // every group after this one.
    for (const id of eingetragen) unregisterPlugin(id)
  }

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
    const tg = { id: 'a', type: 'notify', name: 'notify', properties: defaultProps('notify') }
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
    notify: async (text) => { calls.push(['notify', text]); return true },
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
        failed: [step('set_var', { outputVar: 'reason', value: 'failed: {{trigger.run.report}}' }), step('notify', { text: '{{vars.reason}}', outputVar: 'tg' })],
        aborted: [],
      } }),
      step('note', { text: 'after switch {{vars.reason}}' }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'branchy', definition: def }, trig, stubApi)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'finished')
    gleich(fr.context.vars.reason, 'failed: broke', 'set_var rendered')
    gleich(fr.context.vars.tg.delivered, true, 'notify output stored')
    gleich(calls.find(c => c[0] === 'notify')[1], 'failed: broke', 'the notify step received the rendered text')
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
  // The trigger that fires after a merge and the block that may run a command
  // afterwards. Both were built for one sentence — "after every merge into this
  // repo, restart the hub" — and both have exactly one place where they could
  // silently do the wrong thing: firing twice for one integration, and treating
  // a non-zero exit code as a broken step.
  gruppe('Flows: the run_merged trigger and the shell_command block')
  const { flowsForMerge, flowsTick } = await import('../server/flows/triggers.mjs')
  const { STEPS } = await import('../server/flows/steps.mjs')
  const rawdb = fdb.default

  await pruefe('normalizeTrigger: run_merged carries a repo, or all of them', () => {
    gleich(normalizeTrigger({ kind: 'run_merged', repoId: 4 }).repoId, 4, 'a repo id survives')
    gleich(normalizeTrigger({ kind: 'run_merged', repoId: '4' }).repoId, 4, 'as a number, whatever the form sent')
    gleich(normalizeTrigger({ kind: 'run_merged' }).repoId, null, 'nothing chosen = every repo')
    gleich(normalizeTrigger({ kind: 'run_merged', repoId: 'nonsense' }).repoId, null, 'and so is nonsense')
    gleich(normalizeTrigger({ kind: 'run_finished', repoId: 4 }).repoId, undefined, 'no other trigger carries one')
  })
  await pruefe('flowsForMerge: the filter is the repo, not an attachment', () => {
    const flows = [
      { id: 1, name: 'this repo', active: 1, trigger: { kind: 'run_merged', repoId: 7 } },
      { id: 2, name: 'every repo', active: 1, trigger: { kind: 'run_merged' } },
      { id: 3, name: 'other repo', active: 1, trigger: { kind: 'run_merged', repoId: 8 } },
      { id: 4, name: 'switched off', active: 0, trigger: { kind: 'run_merged' } },
      { id: 5, name: 'run finished', active: 1, trigger: { kind: 'run_finished' } },
    ]
    gleich(flowsForMerge({ repo_id: 7, flows: null }, flows).map(f => f.id).join(','), '1,2',
      'its own repo and "all repos" — and no attachment anywhere in sight')
    gleich(flowsForMerge({ repo_id: 8 }, flows).map(f => f.id).join(','), '2,3', 'another repo sees its own')
    gleich(flowsForMerge({ repo_id: 9 }, []).length, 0, 'no flows, no starts')
  })
  await pruefe('the merge is a variable only under its own trigger', () => {
    const mdef = { sequence: [{ id: 'n1', type: 'note', properties: { text: 'x' } }] }
    const scope = (kind) => vs.varsInScope(mdef, STEP_MAP, 'n1', { kind })
    gleich(find(scope('run_merged'), 'trigger.merge.sha')?.type, 'string', 'the commit that landed')
    gleich(find(scope('run_merged'), 'trigger.merge.files')?.type, 'string_list', 'the files it changed')
    wahr(find(scope('run_merged'), 'trigger.run.merge_status')?.enum.includes('merged'), 'the run says how its merge went')
    falsch(find(scope('cron'), 'trigger.merge'), 'a schedule has no merge')
    falsch(find(scope('run_finished'), 'trigger.merge'), 'and neither has a finished run')
    falsch(find(scope('run_merged'), 'trigger.run')?.conditional, 'a merge always has the run whose work landed')
  })
  await pruefe('shell_command: registry entry, defaults and the shape that depends on "detach"', () => {
    const meta = STEP_MAP.shell_command
    wahr(!!meta && meta.output && meta.group === 'data', 'in the registry, in the data group, with an output')
    wahr(STEPS.some(s => s.type === 'shell_command'), 'and in the list the editor is built from')
    const props = defaultProps('shell_command')
    gleich(props.outputVar, 'shell', 'default output variable')
    gleich(props.timeoutMinutes, 10, 'default timeout')
    gleich(props.detach, false, 'not detached by default')
    const step = (detach) => ({ id: 'sh', type: 'shell_command', properties: { ...props, command: 'true', detach } })
    const shapeOf = (detach) => vs.shapePaths('vars.shell', vs.outputShapeOf(step(detach), meta)).map(p => p.path).join(',')
    enthaelt(shapeOf(false), 'vars.shell.exit_code', 'not detached: the exit code is readable')
    enthaelt(shapeOf(false), 'vars.shell.stdout', 'and the output')
    falsch(shapeOf(true).includes('exit_code'), 'detached: there is no exit code to promise')
    enthaelt(shapeOf(true), 'vars.shell.detached', 'only the fact that it was detached')
    wahr(validateDefinition({ sequence: [{ id: 'sh', type: 'shell_command', properties: { ...props } }] })
      .some(p => p.includes("'command' is required")), 'without a command it is not a step')
  })
  await pruefe('shell_command: templates, exit code as a result, detach as an immediate answer', async () => {
    const seen = []
    const shellApi = {
      ...stubApi,
      shell: async (args) => {
        seen.push(args)
        if (args.detach) return { ok: true, detached: true }
        return { ok: false, exit_code: 3, stdout: 'out', stderr: 'err' }
      },
    }
    const def = { sequence: [
      step('shell_command', { command: 'echo {{trigger.run.id}}', cwd: '{{trigger.run.repo_path}}', timeoutMinutes: 2, detach: false, outputVar: 'shell' }),
      step('condition', { left: '{{vars.shell.ok}}', op: 'falsy', right: '' }, { branches: {
        true: [step('shell_command', { command: 'sleep 1; touch x', cwd: '', timeoutMinutes: 10, detach: true, outputVar: 'bg' })],
        false: [step('note', { text: 'never' })],
      } }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'shelly', definition: def },
      { kind: 'run_merged', run: { id: 'r1', repo_path: '/tmp/repo' }, merge: { sha: 'abc', files: ['a.txt'] } }, shellApi)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'done', 'a command that exits 3 does NOT fail the flow run')
    gleich(seen[0].command, 'echo r1', 'the command is a template')
    gleich(seen[0].cwd, '/tmp/repo', 'and so is the working directory')
    gleich(seen[0].timeoutMs, 120_000, 'minutes become milliseconds')
    gleich(fr.context.vars.shell.exit_code, 3, 'the exit code is readable')
    falsch(fr.context.vars.shell.ok, 'and says the command did not succeed')
    wahr(fr.log.some(l => l.msg === 'exit 3'), 'the step log names it')
    gleich(fr.context.vars.bg.detached, true, 'the detached command answers at once')
    wahr(fr.log.some(l => l.msg === 'detached'), 'and says so')
    falsch(fr.log.some(l => l.msg === 'never'), 'the branch really hung on the exit code')
  })

  // The dispatch, against the sandbox database: the five columns belong to the
  // merge integrator and are not in this branch yet, so the test adds them the
  // way it will find them later.
  await pruefe('a merge fires its flows exactly once — the conflict run is marked, not fired', async () => {
    for (const [name, typ] of [['merge_status', 'TEXT'], ['merged_sha', 'TEXT'], ['merged_at', 'TEXT'],
      ['resolves_run_id', 'TEXT'], ['resolver_run_id', 'TEXT']]) {
      if (!fdb.hasColumn('runs', name)) rawdb.exec(`ALTER TABLE runs ADD COLUMN ${name} ${typ}`)
    }
    rawdb.exec(`INSERT INTO repos(name, path, base_branch) VALUES('merge-repo', '/tmp/merge-repo', 'main')`)
    const repoId = rawdb.prepare('SELECT id FROM repos WHERE name=?').get('merge-repo').id
    const anlegen = (id, extra = {}) => {
      rawdb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes,
                     ended_at, flow_dispatched, merge_status, merged_sha, merged_at, resolves_run_id, resolver_run_id)
                     VALUES(?,?,'done','claude','p','keiner',5,datetime('now'),1,?,?,datetime('now'),?,?)`)
        .run(id, repoId, extra.merge_status ?? 'merged', extra.merged_sha ?? 'sha-1',
          extra.resolves_run_id ?? null, extra.resolver_run_id ?? null)
    }
    const flowId = fdb.saveFlow({ name: 'after the merge', active: 1, trigger: { kind: 'run_merged', repoId },
      definition: { sequence: [{ id: 'n', type: 'note', name: 'n', properties: { text: 'merged {{trigger.merge.sha}}' } }] } })
    const fremd = fdb.saveFlow({ name: 'another repo', active: 1, trigger: { kind: 'run_merged', repoId: repoId + 999 },
      definition: { sequence: [{ id: 'n', type: 'note', name: 'n', properties: { text: 'no' } }] } })

    anlegen('merge-run-1', { resolver_run_id: 'conflict-run-1' })
    rawdb.prepare(`INSERT INTO events(run_id, kind, payload) VALUES('merge-run-1','merged',?)`)
      .run(JSON.stringify({ sha: 'sha-1', files: ['server/a.mjs', 'lang/en.json'] }))
    await flowsTick(stubApi)
    const runs1 = fdb.listFlowRuns(flowId)
    gleich(runs1.length, 1, 'exactly one flow run')
    gleich(fdb.listFlowRuns(fremd).length, 0, 'the flow of another repo stayed out of it')
    const trig1 = runs1[0].context.trigger
    gleich(trig1.kind, 'run_merged', 'trigger kind')
    gleich(trig1.run.id, 'merge-run-1', 'with the run whose work landed')
    gleich(trig1.merge.sha, 'sha-1', 'the commit')
    gleich(trig1.merge.base, 'main', 'the branch it landed on')
    gleich(trig1.merge.resolver_run_id, 'conflict-run-1', 'and the conflict run that made it mergeable')
    gleich(trig1.merge.files.join(','), 'server/a.mjs,lang/en.json', 'the files out of the event')
    wahr(runs1[0].log.some(l => l.msg === 'merged sha-1'), 'the step read the merge')
    gleich(rawdb.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get('merge-run-1').merge_dispatched, 1, 'marked')

    await flowsTick(stubApi)
    gleich(fdb.listFlowRuns(flowId).length, 1, 'a second pass starts nothing — the mark holds')

    anlegen('conflict-run-1', { merged_sha: 'sha-1', resolves_run_id: 'merge-run-1' })
    await flowsTick(stubApi)
    gleich(fdb.listFlowRuns(flowId).length, 1, 'the conflict run merged the same work and starts no second flow run')
    gleich(rawdb.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get('conflict-run-1').merge_dispatched, 1,
      'but it is marked, or the next pass would look at it again')

    anlegen('merge-run-old', { merged_sha: 'sha-old' })
    gleich(fdb.markExistingMergesDispatched(), 1, 'a merge that was there before this code counts as dispatched')
    await flowsTick(stubApi)
    gleich(fdb.listFlowRuns(flowId).length, 1, 'history is never replayed')
  })
  // The repo page's way in: a run_merged flow hangs on the repo, so the repo
  // form has to be able to name it. Unlike the dispatch, this list deliberately
  // includes the switched-off ones — it answers "what happens after a merge
  // here", and "nothing, it is off" is part of that answer.
  await pruefe('flowsForMergeOfRepo: this repo, all repos, and the switched-off ones too', () => {
    const repoId = rawdb.prepare('SELECT id FROM repos WHERE name=?').get('merge-repo').id
    const alle = fdb.saveFlow({ name: 'every repo', active: 0, trigger: { kind: 'run_merged' },
      definition: { sequence: [] } })
    const fremd = rawdb.prepare('SELECT id FROM flows WHERE name=?').get('another repo').id
    const namen = fdb.flowsForMergeOfRepo(repoId).map(f => f.name).sort().join(',')
    gleich(namen, 'after the merge,every repo', 'its own flow and the one watching every repo — the inactive one included')
    wahr(fdb.flowsForMergeOfRepo(repoId).some(f => f.id === alle && !f.active), 'and it says that it is off')
    falsch(fdb.flowsForMergeOfRepo(repoId).some(f => f.id === fremd), 'another repo\'s flow stays out')
    gleich(fdb.flowsForMergeOfRepo(0).map(f => f.name).join(','), 'every repo', 'without a repo only the "all repos" flows')
    gleich(fdb.mergeTriggerRepoId({ repoId: '4' }), 4, 'one rule for reading the filter')
    gleich(fdb.mergeTriggerRepoId({}), null, 'and null means all of them')
  })
  await pruefe('a flow run the hub restart caught mid-step is closed, not left running', () => {
    const id = fdb.createFlowRun({ flow: { id: null, name: 'interrupted' }, context: { trigger: {}, vars: {} }, state: { frames: [] } })
    const waiting = fdb.createFlowRun({ flow: { id: null, name: 'suspended' }, context: { trigger: {}, vars: {} }, state: { frames: [] } })
    fdb.updateFlowRun(waiting, { status: 'waiting', context: {}, state: {}, log: [], resumeAt: '2099-01-01T00:00:00Z' })
    gleich(fdb.failRunningFlowRuns(), 1, 'only the one that was really in a step')
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'failed', 'ever "running" would be a lie — nothing ever picks it up again')
    enthaelt(fr.log.at(-1).msg, 'hub restarted', 'and its own log says why')
    gleich(fdb.getFlowRun(waiting).status, 'waiting', 'a suspended one is a row, not a stack frame — untouched')
  })

  // A cron flow produces flow runs around the clock — the one that deploys pushed
  // commits fires every ten minutes. Nothing ever deleted a flow run before, so
  // /flows/runs would silt up with rows saying "nothing to do".
  await pruefe('retention deletes the finished ones, keeps failed four times as long, never the waiting', async () => {
    const { default: raw, setSetting } = await import('../server/db.mjs')
    const age = (id, days) => raw.prepare(`UPDATE flow_runs SET ended_at = datetime('now', ?) WHERE id=?`)
      .run(`-${days} days`, id)
    const make = (name, status, days) => {
      const id = fdb.createFlowRun({ flow: { id: null, name }, context: { trigger: {}, vars: {} }, state: { frames: [] } })
      raw.prepare('UPDATE flow_runs SET status=? WHERE id=?').run(status, id)
      age(id, days)
      return id
    }
    const finished = make('cron, nothing to do', 'done', 10)      // over 7 days
    const broken = make('cron, it broke', 'failed', 10)         // over 7, under 28
    const suspended = make('still suspended', 'waiting', 30)       // older than everything

    setSetting('flow_runs_keep_days', '7')
    gleich(fdb.flowRunKeepDays(), 7, 'the setting is read')
    gleich(fdb.pruneFlowRuns(Date.now()), 1, 'exactly one row went')
    gleich(fdb.getFlowRun(finished), null, 'the finished one is gone')
    gleich(fdb.getFlowRun(broken).status, 'failed', 'the failed one stays — it is the reason anyone opens the page')
    gleich(fdb.getFlowRun(suspended).status, 'waiting', 'a waiting run is not old, it is suspended')

    age(broken, 30)                                            // now over 4 × 7
    gleich(fdb.pruneFlowRuns(Date.now()), 1, 'four times as long, then it goes too')

    const later = make('cron, nothing to do either', 'done', 10)
    setSetting('flow_runs_keep_days', '0')
    gleich(fdb.flowRunKeepDays(), 0, '0 is a value, not "unset"')
    gleich(fdb.pruneFlowRuns(Date.now()), 0, 'and it means: never delete anything')
    wahr(!!fdb.getFlowRun(later), 'the row is still there')
    setSetting('flow_runs_keep_days', '')
    gleich(fdb.flowRunKeepDays(), 7, 'empty falls back to the default')
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

  // The README exists in three languages and they are maintained TOGETHER — a
  // translation that quietly disappears is worse than none, because the language
  // switcher at the top keeps promising it. Same for SETUP_WITH_AGENT.md: it is
  // the document a stranger's coding agent acts on, and it is only found because
  // every README links it near the top.
  await pruefe('all three READMEs exist, link each other and link SETUP_WITH_AGENT.md', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('..', import.meta.url).pathname
    const readmes = ['README.md', 'README.zh-CN.md', 'README.de.md']
    for (const f of ['SETUP_WITH_AGENT.md', 'CONTRIBUTING.md', 'LICENSE', ...readmes]) {
      wahr(existsSync(j(root, f)), `${f} exists`)
    }
    for (const f of readmes) {
      const text = readFileSync(j(root, f), 'utf8')
      wahr(text.includes('SETUP_WITH_AGENT.md'), `${f} links SETUP_WITH_AGENT.md`)
      wahr(text.includes('CONTRIBUTING.md'), `${f} links CONTRIBUTING.md`)
      for (const other of readmes.filter((o) => o !== f)) {
        wahr(text.includes(`(${other})`), `${f} links ${other} (language switcher)`)
      }
    }
    wahr(readFileSync(j(root, 'LICENSE'), 'utf8').includes('Attribution 4.0 International'),
      'LICENSE is the CC BY 4.0 legal code')
  })

  // ------------------------------------------------------------------
  // Every shell file in this repo is installed and run on a machine — freilauf-deploy
  // even runs setup/02 on every single deploy. A typo in one of them is not a
  // failing test somewhere, it is a hub that does not come back up, and `bash -n`
  // is the cheapest possible fence against exactly that.
  gruppe('Scripts: every shell file parses')

  await pruefe('bash -n on bin/* and setup/*.sh', async () => {
    const { readdirSync, readFileSync: rf } = await import('node:fs')
    const { join: j } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    const root = new URL('..', import.meta.url).pathname
    const files = []
    for (const dir of ['bin', 'setup']) {
      for (const f of readdirSync(j(root, dir), { withFileTypes: true })) {
        if (!f.isFile()) continue
        const p = j(root, dir, f.name)
        if (rf(p, 'utf8').slice(0, 40).includes('bash')) files.push(p)
      }
    }
    wahr(files.length >= 8, `found the scripts (${files.length})`)
    for (const p of files) {
      try { execFileSync('bash', ['-n', p], { stdio: ['ignore', 'ignore', 'pipe'] }) }
      catch (err) { throw new Error(`${p}: ${String(err.stderr ?? err.message)}`) }
    }
  })

  // ------------------------------------------------------------------
  // Since the service runs from its own deploy checkout, no directory tells you
  // any more which commit is live. The sidebar does — or says nothing at all, and
  // that second case is the one worth a test: a hub unpacked from a tarball has
  // no git, and a sidebar printing "undefined" would be worse than one printing
  // nothing.
  gruppe('The running version in the sidebar (hubVersion / headerStatus)')

  await pruefe('the version is a short sha or the empty string, never anything else', async () => {
    const { hubVersion } = await import('../server/util.mjs')
    const v = hubVersion()
    wahr(v === '' || /^[0-9a-f]{7,40}$/.test(v), `got ${JSON.stringify(v)}`)
    gleich(hubVersion(), v, 'and it is cached — a page render is not a git client')
  })

  await pruefe('headerStatus carries it, and nothing broken when there is none', async () => {
    const { hubVersion } = await import('../server/util.mjs')
    const { headerStatus } = await import('../server/pages.mjs')
    const html = headerStatus()
    enthaelt(html, 'id="header-status"', 'still the block the live channel swaps')
    if (hubVersion()) enthaelt(html, hubVersion(), 'the running sha is in it')
    falsch(html.includes('undefined'), 'no stray undefined')
    falsch(/>\s*null\s*</.test(html), 'no stray null')
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
    process.env.FREILAUF_AGENTS_SEED = seed
    gleich(ca.seedIfEmpty(), 0, 'table not empty: nothing seeded')
    ca.deleteCodingAgent(ca.codingAgentFor('opencode').id)
    gleich(ca.seedIfEmpty(), 1, 'empty table: valid entries seeded')
    wahr(ca.isHarnessEnabled('claude'), 'claude seeded')
    delete process.env.FREILAUF_AGENTS_SEED
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

  // layout() awaits usage AND balances on every single page, and both of them
  // talk to a vendor's API — cursor's own dashboard endpoint carries a 12 s
  // timeout. So for two minutes the hub was fast and then ONE page view paid
  // for everybody, with a white screen for as long as the slowest provider took.
  // A stale number in the sidebar is worth incomparably more than a page that
  // does not come.
  await pruefe('an expired panel is served stale while it refreshes behind the page', async () => {
    const usage = await import('../server/usage.mjs')
    const bal = await import('../server/balances.mjs')
    const echt = globalThis.fetch
    const key = process.env.OPENROUTER_API_KEY
    const vorher = ca.listCodingAgents().map(a => ({ harness: a.harness, providers: a.providerIds, enabled: a.enabled }))
    let haenge = null                       // resolves the pending fetch by hand
    let rufe = 0
    globalThis.fetch = async () => {
      rufe++
      if (haenge) await new Promise(r => { haenge = r })
      return { ok: true, json: async () => ({ data: { total_credits: 5, total_usage: 1 }, is_available: true }) }
    }
    try {
      for (const a of ca.listCodingAgents()) ca.deleteCodingAgent(a.id)
      ca.saveCodingAgent({ harness: 'opencode', enabled: 1, providers: ['openrouter'] })
      process.env.OPENROUTER_API_KEY = 'k'
      usage._usageCacheReset(); bal._balanceCacheReset()

      const erste = await bal.providerBalances()
      gleich(erste.length, 1, 'the cold call really does fetch')
      const rufeNachErster = rufe

      // Age the entry past its cache window (now a minute), then make the next
      // fetch hang: the stale answer must come back at once, not after it.
      bal._balanceCacheAge(3 * 60_000)
      haenge = () => {}
      const zweite = await Promise.race([
        bal.providerBalances(),
        new Promise(r => setTimeout(() => r('zu langsam'), 200)),
      ])
      wahr(zweite === erste, 'the stale answer comes back at once, byte for byte the old one')
      wahr(rufe > rufeNachErster, 'and the refresh really was started behind it')
      haenge?.()
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
  // ---- the branch rule: one table, three consumers ----
  await pruefe('the sentence the agent reads comes from BRANCH_MODE_INFO, per merge mode', () => {
    const rule = (mode, opts) => rd.branchRuleText(mode, opts)
    // With the integration switched off these three are BYTE FOR BYTE the
    // sentences that used to be an inline ternary in runner.mjs. If one of them
    // changes, every prompt of every non-integrating repo changes with it.
    gleich(rule('keiner', { hubMerges: false }),
      'No branch — the worktree is detached; changes are throwaway changes.', 'no branch, off')
    gleich(rule('neu', { branch: 'agent/x', hubMerges: false }),
      'Create a new branch, name following the pattern agent/x.', 'new branch, off')
    gleich(rule('fest', { branch: 'long-lived', hubMerges: false }),
      'Work on the existing branch long-lived.', 'existing branch, off')

    // Under 'hub' the same three say what really happens.
    enthaelt(rule('keiner', { base: 'main', hubMerges: true }), 'Freilauf merges your commits into main',
      'no branch under hub does NOT promise throwaway work')
    falsch(rule('keiner', { base: 'main', hubMerges: true }).includes('throwaway'), 'no leftover promise')
    enthaelt(rule('neu', { branch: 'b', base: 'trunk', hubMerges: true }), 'merges it into trunk', 'the repo\'s own base branch')
    enthaelt(rule('fest', { branch: 'b', base: 'main', hubMerges: true }), 'merges it into main', 'existing branch under hub')
  })

  await pruefe('"keep on branch" only exists where there IS a branch to keep it on', () => {
    const keep = { base: 'main', hubMerges: true, keepOnBranch: true }
    enthaelt(rd.branchRuleText('neu', { ...keep, branch: 'b' }), 'STAYS on that branch', 'new branch')
    enthaelt(rd.branchRuleText('fest', { ...keep, branch: 'b' }), 'will not merge it into main', 'existing branch')
    // 'keiner' has no keep sentence — it falls back to the ordinary hub one
    // rather than promising something it cannot do.
    gleich(rd.branchRuleText('keiner', keep), rd.branchRuleText('keiner', { base: 'main', hubMerges: true }),
      'no branch: the hub sentence, never a keep sentence')
    // And keep is ignored where the hub does not integrate at all.
    gleich(rd.branchRuleText('neu', { branch: 'b', hubMerges: false, keepOnBranch: true }),
      'Create a new branch, name following the pattern b.', 'off outranks keep')
  })

  await pruefe('every explanation the table names really exists in lang/en.json', async () => {
    const { _catalogs } = await import('../server/i18n.mjs')
    const en = _catalogs().en
    for (const [mode, info] of Object.entries(rd.BRANCH_MODE_INFO)) {
      wahr(typeof en[info.label] === 'string' && en[info.label], `${mode}: label key ${info.label}`)
      for (const modus of ['off', 'hub']) {
        const key = info.explain[modus]
        wahr(typeof en[key] === 'string' && en[key], `${mode}/${modus}: explain key ${key}`)
      }
      wahr(!!info.rule.off && !!info.rule.hub, `${mode}: both agent sentences`)
    }
    // The two that carry {base} in the UI have to keep saying it.
    enthaelt(en['branch.keep'], '{base}', 'the checkbox names the branch it will NOT merge into')
  })

  await pruefe('keeping the work on a branch needs a branch', async () => {
    const p1 = []
    const def1 = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'keiner', keep_on_branch: '1' }, p1)
    gleich(p1.length, 1, `refused (${p1.join(', ')})`)
    gleich(def1.keepOnBranch, 1, 'the value is still reported back, so the form can show it ticked')
    const p2 = []
    const def2 = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'neu', branch_pattern: 'b', keep_on_branch: '1' }, p2)
    gleich(p2.length, 0, `accepted with a branch (${p2.join(', ')})`)
    gleich(def2.keepOnBranch, 1, 'and taken over')
    const p3 = []
    const def3 = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'neu', branch_pattern: 'b' }, p3)
    gleich(def3.keepOnBranch, 0, 'an unticked checkbox is simply absent — and that is the default')
  })

  await pruefe('keep_on_branch goes the whole way a run definition field goes', async () => {
    const agentRow = {
      harness: 'claude', prompt: 'p', branch_mode: 'fest', branch_pattern: 'long-lived',
      keep_on_branch: 1, expected_minutes: 20,
    }
    gleich(rd.defFromAgent(agentRow).keepOnBranch, 1, 'agent row → definition')
    gleich(rd.defFromAgent({ ...agentRow, keep_on_branch: 0 }).keepOnBranch, 0, 'and back off again')
    // saveAgent writes it, defFromAgent reads it back: the round trip a stored
    // agent takes every time it starts.
    const id = rd.saveAgent({ repoId: 1, name: `keep-${Date.now()}`, def: await rd.runDefFromForm({
      harness: 'claude', prompt: 'p', branch_mode: 'fest', branch_pattern: 'long-lived', keep_on_branch: '1',
    }, []) })
    const { default: db2 } = await import('../server/db.mjs')
    const zurueck = db2.prepare('SELECT * FROM agents WHERE id=?').get(id)
    gleich(zurueck.keep_on_branch, 1, 'stored')
    gleich(rd.defFromAgent(zurueck).keepOnBranch, 1, 'and read back as the same definition')
    // The flow designer offers it too, or a flow-started run could never keep.
    const feld = rd.RUN_DEF_FLOW_FIELDS.find(f => f.key === 'keepOnBranch')
    wahr(!!feld, 'the flow step has the field')
    gleich(feld.kind, 'checkbox', 'as a checkbox')
    gleich(rd.defFromFlowProps({ harness: 'claude', prompt: 'p', branchMode: 'neu', branchPattern: 'b', keepOnBranch: true }).keepOnBranch, 1,
      'a flow can keep the work on its branch')
    gleich(rd.defFromFlowProps({ harness: 'claude', prompt: 'p', branchMode: 'keiner', keepOnBranch: true }).keepOnBranch, 0,
      'but not without a branch — the same rule the form enforces')
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
  // The goal is the one definition field that never reaches the agent through
  // the prompt file: it exists only as a slash command inside the session, and
  // only a coding agent whose plugin carries a `goal` spec knows one at all.
  gruppe('Goal: the second prompt (goal.mjs)')
  const gl = await import('../server/goal.mjs')

  await pruefe('who knows a goal is the plugin\'s answer, not the form\'s', () => {
    wahr(gl.harnessSupportsGoal('claude'), 'claude does')
    falsch(gl.harnessSupportsGoal('opencode'), 'opencode does not')
    falsch(gl.harnessSupportsGoal('cursor'), 'cursor does not')
    gleich(gl.goalMax('claude'), 4000, 'and claude names its own limit')
    gleich(gl.goalMax('hermes'), null, 'a coding agent without a spec has none')
  })
  await pruefe('the condition becomes ONE command line', () => {
    gleich(gl.goalCommand('claude', 'all tests pass'), '/goal all tests pass', 'the command in front of it')
    gleich(gl.goalCommand('claude', ' all tests\n  pass\n'), '/goal all tests pass',
      'whitespace folded — a pasted newline would submit the fragment before it')
    gleich(gl.goalCommand('claude', '   '), null, 'nothing to send')
    gleich(gl.goalCommand('opencode', 'all tests pass'), null, 'a coding agent without a spec gets no command')
    gleich(gl.goalCommand('claude', 'x'.repeat(5000)).length, '/goal '.length + 4000, 'capped at the limit')
  })
  await pruefe('the goal goes through the form like every other definition field', async () => {
    const base = { harness: 'claude', prompt: 'x', branch_mode: 'keiner' }
    gleich((await rd.runDefFromForm(base, [])).goal, null, 'empty field = no goal')
    gleich((await rd.runDefFromForm({ ...base, goal: '  tests are green  ' }, [])).goal, 'tests are green', 'trimmed')
    gleich((await rd.runDefFromForm({ ...base, goal: '/goal tests are green' }, [])).goal, 'tests are green',
      'whoever types the command keeps it: the hub is the one that puts it in front')
    const zuLang = []
    gleich((await rd.runDefFromForm({ ...base, goal: 'y'.repeat(4001) }, zuLang)).goal, null, 'nothing taken over')
    gleich(zuLang.length, 1, `too long is a problem, not a condition cut in half (${zuLang.join(', ')})`)
    // A coding agent that knows no goal simply has none — the form disables the
    // field there, so this only catches a body the form did not write.
    gleich(rd.defFromFlowProps({ harness: 'cursor', prompt: 'x', goal: 'tests are green' }).goal, null,
      'and a coding agent without a spec gets none, whatever the request says')
    gleich(rd.defFromFlowProps({ harness: 'claude', prompt: 'x', goal: 'tests are green' }).goal, 'tests are green',
      'the flow step takes the same route')
    gleich(rd.defFromAgent({ goal: 'tests are green' }).goal, 'tests are green', 'and the agent row carries it')
  })

  await pruefe('the flow step carries the serving-provider routing like every form', () => {
    const base = { harness: 'opencode', provider: 'openrouter', model: 'z-ai/glm-5.2', prompt: 'x', branchMode: 'keiner' }
    gleich(rd.defFromFlowProps({ ...base, orMode: 'offen' }).orRouting, null, 'open = no routing')
    const auto = rd.defFromFlowProps({ ...base, orMode: 'auto', orQuant: 'fp8', orRegion: 'eu', orMaxIn: '1.5' })
    gleich(JSON.stringify(auto.orRouting), JSON.stringify({ mode: 'auto', quant_min: 'fp8', location: 'eu', max_in: 1.5 }),
      'auto requirements become the config')
    const pin = rd.defFromFlowProps({ ...base, orMode: 'pin', orProvider: 'parasail/fp8' })
    gleich(pin.orProvider, 'parasail/fp8', 'the pin survives the flow step')
    gleich(pin.orRouting, null, 'pin and auto are one statement, never both')
    // Not passable, or nonsense — both are NO routing, never a broken run.
    gleich(rd.defFromFlowProps({ ...base, provider: 'deepseek', orMode: 'pin', orProvider: 'x' }).orProvider, null,
      'a routing on a non-OpenRouter provider is dropped')
    gleich(rd.defFromFlowProps({ ...base, orMode: 'auto', orQuant: 'quatsch' }).orRouting, null,
      'a nonsense minimum is dropped, the flow run still starts')
    gleich(rd.defFromFlowProps({ ...base, orMode: 'auto', orQuant: 'fp8' }).orRouting.location, 'all',
      'an unset region means everywhere, as in the form')
  })

  // ------------------------------------------------------------------
  gruppe('OpenRouter best-provider selection (openrouter-routing.mjs)')
  const orr = await import('../server/providers/openrouter-routing.mjs')

  await pruefe('the quantization parser reads the wide family onto one scale', () => {
    gleich(orr.parseQuantization('fp8').rank, orr.parseQuantization('FP8 ').rank, 'case and spelling do not matter')
    gleich(orr.parseQuantization('q4_K_M').bits, 4, 'a GGUF-style q4 quantization parses')
    gleich(orr.parseQuantization('q4_K_M').rank, orr.parseQuantization('int4').rank, 'q4 and int4 land on the same rank')
    wahr(orr.parseQuantization('bf16').rank > orr.parseQuantization('fp8').rank, 'bf16 is more precise than fp8')
    gleich(orr.parseQuantization('bf16').rank, orr.parseQuantization('fp16').rank, 'bf16 and fp16 tie — both are 16 bits')
    gleich(orr.parseQuantization('int8').rank < orr.parseQuantization('fp8').rank, true, 'int8 sits BELOW fp8: same bits, unsafe direction excluded')
    gleich(orr.parseQuantization('unknown'), null, 'unknown means "no information", never a level')
    gleich(orr.parseQuantization(''), null, 'empty stays empty')
    gleich(orr.parseQuantization('nvfp4'), null, 'a genuinely unknown spelling is reported as unknown')
    gleich(orr.unknownQuantizations(['fp8', 'nvfp4', 'q5_k_s']).join(','), 'nvfp4', 'the gap is named, not silently passed')
  })

  await pruefe('“fp8 or better” is a lower bound, not an enumeration the future ages out', () => {
    gleich(orr.quantizationsFrom('fp8').join(','), 'fp8,fp16,bf16,fp32', 'fp8 admits bf16 and fp16 — more precision, not less')
    gleich(orr.quantizationsFrom('fp8').includes('fp4'), false, 'fp4 is below the floor and stays out')
    gleich(orr.quantizationsFrom('q4').includes('fp8'), true, 'q4 parses onto the same scale (int-4 ≈ fp4 or better)')
    wahr(orr.quantizationsFrom('bf16').includes('fp16'), true, 'the tie holds in the enumeration too')
    wahr(!!orr.parseRoutingConfig({ quant_min: 'nvfp4' }).error,
      'an unknown minimum is an ERROR, never a silent no-filter')
  })

  await pruefe('the selection filters, ranks and names its reasons', () => {
    const eps = [
      { tag: 'cheap/fp4', provider_name: 'Cheap', quantization: 'fp4', status: 0,
        uptime_last_30m: 100, supported_parameters: ['tools'], pricing: { prompt: '0.00000005', completion: '0.0000001' } },
      { tag: 'sila/fp8', provider_name: 'SiliconFlow', quantization: 'fp8', status: 0,
        uptime_last_30m: 100, supported_parameters: ['tools'], pricing: { prompt: '0.00000014', completion: '0.00000028' } },
      { tag: 'morph/bf16', provider_name: 'Morph', quantization: 'bf16', status: 0,
        uptime_last_30m: 99, supported_parameters: ['tools'], pricing: { prompt: '0.000000139', completion: '0.000000278' } },
      { tag: 'who/cares', provider_name: 'WhoKnows', quantization: 'unknown', status: 0, pricing: {} },
      { tag: 'krank/fp8', provider_name: 'Sick', quantization: 'fp8', status: -2,
        uptime_last_30m: 60, pricing: { prompt: '0.00000001', completion: '0.0000001' } },
      { tag: 'ohne/werkzeug', provider_name: 'NoTools', quantization: 'fp8', status: 0,
        supported_parameters: ['temperature'], pricing: { prompt: '0.00000001', completion: '0.0000001' } },
    ]
    // No minimum: the BEST quantization a healthy provider serves — fp4 loses
    // to bf16 even though it is cheaper. That is the whole point of the rule.
    const auto = orr.selectBestProvider(eps, orr.parseRoutingConfig({}))
    gleich(auto.best, 'morph/bf16', 'bf16 beats fp8 beats fp4 at the top')
    wahr(!auto.order.includes('cheap/fp4'), 'fp4 does not sneak into the order')
    // With a minimum it is a FLOOR: everything at or above it competes on price.
    const fp8 = orr.selectBestProvider(eps, orr.parseRoutingConfig({ quant_min: 'fp8' }))
    gleich(fp8.order.join('|'), 'morph/bf16|sila/fp8', 'fp8-minimum narrows to fp8-or-better, cheapest first')
    // Unknown quantization is NEVER a match — and every drop says why.
    wahr(auto.dropped.some(d => d.tag === 'who/cares' && d.reason.includes('quantization')),
      'a null quantization is never counted as a match')
    wahr(fp8.dropped.some(d => d.tag === 'ohne/werkzeug' && d.reason.includes('tool support')),
      'the tool-less endpoint is dropped, named')
    wahr(fp8.dropped.some(d => d.reason.includes('degraded')), 'the degraded provider is named as degraded')
    // Region + price caps exclude, and unknown regions go with them.
    const cn = orr.selectBestProvider([
      { tag: 'sila/fp8', provider_name: 'SiliconFlow', quantization: 'fp8', status: 0, pricing: { prompt: '0.00000014', completion: '0.00000028' } },
      { tag: 'parasail/fp8', provider_name: 'Parasail', quantization: 'fp8', status: 0, pricing: { prompt: '0.0000001', completion: '0.0000002' } },
    ], orr.parseRoutingConfig({ location: 'cn' }))
    gleich(cn.best, 'sila/fp8', 'the region requirement keeps the placed provider, drops the rest')
    wahr(cn.dropped.some(d => d.tag === 'parasail/fp8' && d.reason.includes('region')), 'the region rule is the named reason')
    const deckel = orr.selectBestProvider(eps, orr.parseRoutingConfig({ quant_min: 'fp8', max_in: '0.1' }))
    falsch(deckel.ok, 'a cap that fits nobody filters everything — and says so')
  })

  await pruefe('the config parses tolerantly and validates loudly', () => {
    const cfg = orr.parseRoutingConfig({ quant_min: 'fp8', location: 'DE', max_in: ' 1.5 ', max_out: '' })
    gleich(cfg.quant_min, 'fp8', 'the minimum survives')
    gleich(cfg.location, 'de', 'regions are normalized')
    gleich(cfg.max_in, 1.5, 'a number string becomes a number')
    gleich(cfg.max_out, undefined, 'an empty cap means "no cap", never 0')
    gleich(orr.parseRoutingConfig({ quant_min: 'fp8' }).location, 'all', 'no region means everywhere')
    const murks = orr.parseRoutingConfig({ quant_min: 'nope' })
    gleich(murks.error !== undefined, true, 'an unknown minimum is an ERROR, never a silent no-filter')
    gleich(orr.routingConfigKey(orr.parseRoutingConfig({ location: 'us' })),
      orr.routingConfigKey(orr.parseRoutingConfig({ location: 'us', quant_min: '' })),
      'the cache key names the requirements, not the form fields')
  })

  await pruefe('the plugin resolves and CACHES per model+config', async () => {
    const { default: plugin } = await import('../server/providers/openrouter.mjs')
    let fetches = 0
    const ctx = { json: async () => { fetches++; return { data: { endpoints: [
      { tag: 'a/fp8', provider_name: 'A', quantization: 'fp8', status: 0, uptime_last_30m: 100,
        supported_parameters: ['tools'], pricing: { prompt: '0.0000001', completion: '0.0000002' } },
      { tag: 'b/fp8', provider_name: 'B', quantization: 'fp8', status: 0, uptime_last_30m: 100,
        pricing: { prompt: '0.0000002', completion: '0.0000004' } },
    ] } } } }
    const cfg = orr.parseRoutingConfig({ quant_min: 'fp8' })
    const erst = await plugin.routing.resolve(ctx, 'test/modell', cfg)
    wahr(erst.ok && erst.best === 'a/fp8', `the cheapest healthy fp8 provider wins (${erst.best})`)
    gleich(erst.cached, false, 'a first answer is fresh')
    const zweite = await plugin.routing.resolve(ctx, 'test/modell', cfg)
    gleich(fetches, 1, 'the SAME model+config is served from the cache')
    wahr(zweite.cached, 'and marked as cached')
    const andere = await plugin.routing.resolve(ctx, 'test/modell', orr.parseRoutingConfig({ quant_min: 'bf16' }))
    gleich(fetches, 2, 'a DIFFERENT config is a different question — asked again')
    falsch(andere.ok, 'a stricter requirement than the fixtures serve answers nothing (bf16: none)')
    // A forced refresh against a dead endpoint: the stale cache answer arrives,
    // marked veraltet — never a fresh failure dressed up as a selection.
    const ctxTot = { json: async () => { throw new Error('down') } }
    const veraltet = await plugin.routing.resolve(ctxTot, 'test/modell', cfg, { refresh: true })
    wahr(veraltet.ok && veraltet.veraltet, `a failed fetch falls back to the stale answer (${veraltet.reason})`)
    const murks = await plugin.routing.resolveForRun(ctx, 'test/modell', { mode: 'auto', quant_min: 'nvfp4' })
    falsch(murks.ok, 'an unparseable requirement never resolves to an order')
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
    gleich(body.or_mode, 'pin', 'the pin is set again from the stored value')
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
  gruppe('Worktree extras suggestion (extras-suggest.mjs)')
  const ex = await import('../server/extras-suggest.mjs')

  await pruefe('the algorithmic checks come first and need no model', async () => {
    const key = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'k'
    try {
      const leer = await ex.suggestExtras('')
      falsch(leer.ok, 'empty path is refused')
      const weg = await ex.suggestExtras('/does/not/exist')
      falsch(weg.ok, 'missing directory is refused')
      enthaelt(weg.error, 'does/not/exist', 'and names the path')
      const keinGit = await ex.suggestExtras(sandkasten)
      falsch(keinGit.ok, 'a directory without .git is refused')
      enthaelt(keinGit.error, 'git', 'and says so')
    } finally {
      if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key
    }
  })
  await pruefe('the suggestion is normalized: only untracked entries, only known modes, deduped', () => {
    const ctx = {
      entries: [{ name: '.env', dir: false }, { name: 'referenz', dir: true }, { name: 'src', dir: true }],
      tracked: new Set(['src']),
      ignored: new Set(['.env']),
    }
    const gut = ex.normalizeExtras([
      { path: '.env', mode: 'copy' },
      { path: 'referenz', mode: 'link' },
      { path: 'referenz', mode: 'copy' },          // duplicate
      { path: 'src', mode: 'link' },               // tracked → out
      { path: 'erfunden', mode: 'copy' },          // not in the listing → out
      { path: '.env', mode: 'kaputt' },            // unknown mode → out
      { path: '', mode: 'copy' },                  // empty path → out
    ], ctx)
    gleich(JSON.stringify(gut), JSON.stringify([{ path: '.env', mode: 'copy' }, { path: 'referenz/', mode: 'link' }]),
      'the two valid suggestions survive, a directory carries its trailing slash')
  })
  await pruefe('nonsense from the model is an empty list, not a crash', () => {
    const ctx = { entries: [{ name: '.env', dir: false }], tracked: new Set(), ignored: new Set() }
    gleich(ex.normalizeExtras(null, ctx).length, 0, 'null')
    gleich(ex.normalizeExtras({ extras: 'nicht-liste' }, ctx).length, 0, 'non-list')
    gleich(ex.normalizeExtras({}, ctx).length, 0, 'empty object')
  })
  await pruefe('off means off: no model, no key, or the switch — and the default model is preset', () => {
    const key = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    falsch(ex.extrasLlmActive(), 'no key = off')
    if (key !== undefined) process.env.OPENROUTER_API_KEY = key
    gleich(ex.extrasModel(), ex.DEFAULT_EXTRAS_MODEL, 'default model while nothing is configured')
  })
  await pruefe('a real repo is turned into a prompt and the answer normalized', async () => {
    // A tiny real git repo: README tracked, .env and referenz/ untracked+ignored.
    const repo = join(sandkasten, 'extras-repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'README.md'), '# x\n')
    writeFileSync(join(repo, '.gitignore'), '.env\nreferenz/\n')
    writeFileSync(join(repo, '.env'), 'GEHEIM=1\n')
    mkdirSync(join(repo, 'referenz'))
    writeFileSync(join(repo, 'referenz', 'a.txt'), 'ref\n')
    const git = (a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'] })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'u@t'])
    git(['config', 'user.name', 'U'])
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])

    const echt = globalThis.fetch
    const key = process.env.OPENROUTER_API_KEY
    const basis = process.env.FREILAUF_OPENROUTER_BASE
    let koerper = null
    globalThis.fetch = async (url, opts) => {
      koerper = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ extras: [
            { path: '.env', mode: 'copy' }, { path: 'referenz', mode: 'link' }, { path: 'erfunden', mode: 'copy' },
          ] }) } }],
        }),
      }
    }
    try {
      process.env.OPENROUTER_API_KEY = 'k'
      process.env.FREILAUF_OPENROUTER_BASE = 'http://stub'
      const r = await ex.suggestExtras(repo)
      wahr(r.ok, `ok (${r.error ?? ''})`)
      gleich(JSON.stringify(r.extras),
        JSON.stringify([{ path: '.env', mode: 'copy' }, { path: 'referenz/', mode: 'link' }]),
        'the two real entries survive, the invented one is dropped')
      gleich(koerper.model, ex.DEFAULT_EXTRAS_MODEL, 'the configured model is sent')
      enthaelt(koerper.messages[1].content, 'referenz', 'the prompt carries the listing')
    } finally {
      globalThis.fetch = echt
      if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key
      if (basis === undefined) delete process.env.FREILAUF_OPENROUTER_BASE; else process.env.FREILAUF_OPENROUTER_BASE = basis
      rmSync(repo, { recursive: true, force: true })
    }
  })
  await pruefe('a model that finds nothing is a success with [], not an error', async () => {
    // The repo above is gone; a fresh one. The model answers with an empty list —
    // which is a valid result: the form gets `[]` like any other answer, and the
    // dialog closes. "The model suggested nothing usable" is not an error state.
    const repo = join(sandkasten, 'extras-leer-repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'README.md'), '# x\n')
    const git = (a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'] })
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'u@t'])
    git(['config', 'user.name', 'U'])
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])

    const echt = globalThis.fetch
    const key = process.env.OPENROUTER_API_KEY
    const basis = process.env.FREILAUF_OPENROUTER_BASE
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ extras: [] }) } }] }),
    })
    try {
      process.env.OPENROUTER_API_KEY = 'k'
      process.env.FREILAUF_OPENROUTER_BASE = 'http://stub'
      const r = await ex.suggestExtras(repo)
      wahr(r.ok, `ok — an empty answer is an answer (${r.error ?? ''})`)
      gleich(JSON.stringify(r.extras), '[]', 'and the field gets exactly that')
    } finally {
      globalThis.fetch = echt
      if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key
      if (basis === undefined) delete process.env.FREILAUF_OPENROUTER_BASE; else process.env.FREILAUF_OPENROUTER_BASE = basis
      rmSync(repo, { recursive: true, force: true })
    }
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
  gruppe('Run editing: what may change before and during a run (run-edit.mjs)')

  const { db: edb } = await import('../server/db.mjs')
  const { runEditAllowed, editRun } = await import('../server/run-edit.mjs')
  const { fallbackTitle: fb } = await import('../server/title.mjs')

  await pruefe('the permission matrix: a scheduled run is fully editable, a deferred one has no start time, a running one only its duration', () => {
    const erlaubt = (s) => JSON.stringify(runEditAllowed({ status: s }))
    gleich(erlaubt('scheduled'), '{"duration":true,"prompt":true,"repo":true,"startTime":true,"branch":true}', 'scheduled')
    gleich(erlaubt('deferred'), '{"duration":true,"prompt":true,"repo":true,"startTime":false,"branch":true}', 'deferred: no start time — it waits on quota, not on a time')
    gleich(erlaubt('running'), '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}', 'running')
    gleich(erlaubt('waiting_help'), '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}', 'waiting for a human is still running')
    for (const s of ['done', 'failed', 'aborted']) {
      gleich(erlaubt(s), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false}', `${s}: nothing left to edit`)
    }
    // A finished run with an open follow-up commission is working again — its
    // duration is read live by the watcher's overrun thresholds, exactly as for
    // a running run.
    const followup = (extra) => JSON.stringify(runEditAllowed({ status: 'done', ...extra }))
    gleich(followup({ followup_since: '2026-01-01 00:00:00' }),
      '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}',
      'a follow-up commission reopens the duration for editing')
    gleich(followup({ followup_open: 1 }),
      '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}',
      'a follow-up in the gate too')
    gleich(followup({}), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false}',
      'a plain finished run stays closed')
    gleich(JSON.stringify(runEditAllowed(null)), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false}', 'no run')
  })

  await pruefe('editing a scheduled run: prompt, duration, repo, branch and start time are applied and recorded', async () => {
    edb.exec(`DELETE FROM repos WHERE name IN ('edit-repo-a','edit-repo-b')`)
    edb.prepare(`INSERT INTO repos(name, path, base_branch) VALUES('edit-repo-a','/tmp/edit-a','main')`).run()
    edb.prepare(`INSERT INTO repos(name, path, base_branch) VALUES('edit-repo-b','/tmp/edit-b','main')`).run()
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const b = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-b'`).get().id
    const id = 'edit-run-0001'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, start_mode, start_at)
                 VALUES(?,?,'scheduled','claude','E2E alt', 'keiner', 45, ?, 'at', '2030-01-01 00:00:00')`)
      .run(id, a, fb('E2E alt'))
    const problems = []
    const r = await editRun(id, {
      prompt: 'E2E neu', expectedMinutes: '120', repoId: b,
      branchMode: 'neu', branchPattern: 'agent/edit',
      startMode: 'at', startAt: '2030-01-05 09:30',
    }, problems)
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    gleich(lauf.prompt, 'E2E neu', 'new prompt')
    gleich(lauf.expected_minutes, 120, 'new duration')
    gleich(lauf.repo_id, b, 'moved to the other repo')
    gleich(lauf.branch_mode, 'neu', 'new branch mode')
    gleich(lauf.branch_pattern, 'agent/edit', 'new branch pattern')
    gleich(lauf.start_mode, 'at', 'start mode stays at')
    // Same local-time reading the form's own parser makes of the input; the DB
    // stores whatever that is in UTC, so the expected value is derived from the
    // same Date.parse and stays correct in every timezone.
    gleich(lauf.start_at, toDbUtc(Date.parse('2030-01-05 09:30')), 'the start time moved')
    gleich(lauf.title, fb('E2E neu'), 'a prompt-derived title follows the prompt')
    const ev = edb.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='edited'`).get(id)
    gleich(ev.payload, JSON.stringify({ fields: ['duration', 'prompt', 'repo', 'start', 'branch'], repo_id: b }), 'the event names every changed field, and the move names its target')
  })

  await pruefe('a planned run can be told to wait for the repo ("idle")', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-idle'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, start_mode, start_at)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL,'at','2030-01-01 00:00:00')`).run(id, a)
    const problems = []
    const r = await editRun(id, { startMode: 'idle' }, problems)
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    gleich(lauf.start_mode, 'idle', 'now waiting for the repo')
    gleich(lauf.start_at, null, 'the point in time is gone')
  })

  await pruefe('a planned run can be told "start now" — that is an action, not a column write', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-now'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, start_mode, start_at)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL,'at','2030-01-01 00:00:00')`).run(id, a)
    const problems = []
    // Nothing else changes — "now" alone must not bounce off the nothing-to-save wall.
    const r = await editRun(id, { startMode: 'now' }, problems)
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(r.ok, true, 'accepted')
    gleich(r.startNow, true, 'the caller is told to start it')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    gleich(lauf.start_mode, 'at', 'no stored mode for "now"')
    gleich(lauf.start_at, '2030-01-01 00:00:00', 'the columns stay — the run starts instead')
  })

  await pruefe('"in n minutes" is resolved to a point in time at edit time too', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-in'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, start_mode, start_at)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL,'idle',NULL)`).run(id, a)
    const vorher = Date.now()
    const problems = []
    const r = await editRun(id, { startMode: 'in', startInMinutes: '90' }, problems)
    const nachher = Date.now()
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    gleich(lauf.start_mode, 'at', '"in" becomes "at"')
    const ms = parseDbUtc(lauf.start_at)
    // A second of slack below: the stored stamp is truncated to whole seconds.
    wahr(ms >= vorher + 90 * 60_000 - 1000 && ms <= nachher + 90 * 60_000, '90 minutes from now, resolved here')
  })

  await pruefe('a deferred run cannot be given a new start time', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-def'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'deferred','claude','p','keiner',45,NULL)`).run(id, a)
    const problems = []
    await editRun(id, { startMode: 'at', startAt: '2030-02-02 10:00' }, problems)
    gleich(problems.length, 1, `refused (${problems.join(', ')})`)
    enthaelt(problems[0], 'waiting for its start', 'the reason says only a waiting run')
  })

  await pruefe('the branch rule is validated like the run form validates it', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-branch'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL)`).run(id, a)
    const p1 = []
    await editRun(id, { branchMode: 'neu' }, p1)
    gleich(p1.length, 1, `a branch needs a pattern (${p1.join(', ')})`)
    const p2 = []
    await editRun(id, { branchMode: 'keiner', keepOnBranch: 1 }, p2)
    gleich(p2.length, 1, `keeping work on a branch needs a branch (${p2.join(', ')})`)
    const p3 = []
    await editRun(id, { branchMode: 'kaputt' }, p3)
    // The same double report the run form produces: an unknown mode AND the
    // pattern that a non-'keiner' mode requires.
    wahr(p3.length >= 1, `an unknown mode is refused (${p3.join(', ')})`)
    const p4 = []
    // A fixed branch named after the base branch is refused when that worktree
    // holds it — but the test repos do not exist, so branchWorktree answers null
    // and the edit goes through; the launch-time check catches it there.
    const r = await editRun(id, { branchMode: 'fest', branchPattern: 'main', keepOnBranch: 1 }, p4)
    gleich(p4.length, 0, `no problems (${p4.join(', ')})`)
    gleich(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    gleich(lauf.branch_mode, 'fest', 'fixed branch set')
    gleich(lauf.branch_pattern, 'main', 'with its pattern')
    gleich(lauf.keep_on_branch, 1, 'and the keep flag')
  })

  await pruefe('a renamed run keeps its name when the prompt changes', async () => {
    const id = 'edit-run-0002'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','E2E alt 2','keiner',45,'Renamed by hand')`)
      .run(id, edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id)
    const problems = []
    await editRun(id, { prompt: 'E2E neu 2' }, problems)
    gleich(problems.length, 0, `no problems (${problems.join(', ')})`)
    gleich(edb.prepare('SELECT title FROM runs WHERE id=?').get(id).title, 'Renamed by hand', 'an operator name wins')
  })

  await pruefe('moving to the repo the run already lives in is a no-op, not an error', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0003'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL)`).run(id, a)
    const problems = []
    await editRun(id, { repoId: a }, problems)
    // The combined form pre-fills the select; a duration-only edit must not
    // fail on its own untouched field. With ONLY the repo submitted nothing
    // changed at all, which is the honest 'nothing to save'.
    gleich(problems.length, 1, `nothing changed: ${problems.join(', ')}`)
    gleich(problems[0], 'Nothing to save.', 'the message names it')
  })

  await pruefe('a running run accepts only its duration', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0004'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'running','claude','lauf','keiner',45,NULL)`).run(id, a)
    const p1 = []
    await editRun(id, { prompt: 'anders' }, p1)
    gleich(p1.length, 1, `prompt refused for a started run (${p1.join(', ')})`)
    const p2 = []
    await editRun(id, { repoId: edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-b'`).get().id }, p2)
    gleich(p2.length, 1, `move refused for a started run (${p2.join(', ')})`)
    const p2b = []
    await editRun(id, { branchMode: 'neu', branchPattern: 'x' }, p2b)
    gleich(p2b.length, 1, `branch rule refused for a started run (${p2b.join(', ')})`)
    const p2c = []
    await editRun(id, { startMode: 'at', startAt: '2030-03-03 10:00' }, p2c)
    gleich(p2c.length, 1, `start time refused for a started run (${p2c.join(', ')})`)
    const p3 = []
    const ok = await editRun(id, { expectedMinutes: '7' }, p3)
    gleich(p3.length, 0, `duration accepted (${p3.join(', ')})`)
    gleich(ok.ok, true, 'applied')
    gleich(edb.prepare('SELECT expected_minutes FROM runs WHERE id=?').get(id).expected_minutes, 7, 'new duration')
    gleich(edb.prepare('SELECT prompt FROM runs WHERE id=?').get(id).prompt, 'lauf', 'prompt untouched')
  })

  await pruefe('a finished run is not editable at all', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0005'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'done','claude','fertig','keiner',45,NULL)`).run(id, a)
    const problems = []
    await editRun(id, { expectedMinutes: '1' }, problems)
    gleich(problems.length, 1, `refused (${problems.join(', ')})`)
  })

  await pruefe('invalid input is a problem, never a partial write', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0006'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL)`).run(id, a)
    const p1 = []
    await editRun(id, { prompt: '   ' }, p1)
    gleich(p1.length, 1, `empty prompt (${p1.join(', ')})`)
    const p2 = []
    await editRun(id, { expectedMinutes: '0' }, p2)
    gleich(p2.length, 1, `zero minutes (${p2.join(', ')})`)
    const p3 = []
    await editRun(id, { expectedMinutes: 'abc' }, p3)
    gleich(p3.length, 1, `nonsense (${p3.join(', ')})`)
    const p4 = []
    await editRun(id, { repoId: '99999' }, p4)
    gleich(p4.length, 1, `unknown repo (${p4.join(', ')})`)
    const p5 = []
    await editRun(id, { startMode: 'at', startAt: 'nonsense' }, p5)
    gleich(p5.length, 1, `unreadable start time (${p5.join(', ')})`)
    const p6 = []
    await editRun(id, { startMode: 'someday' }, p6)
    gleich(p6.length, 1, `unknown start mode (${p6.join(', ')})`)
    const p7 = []
    await editRun('does-not-exist', { prompt: 'x' }, p7)
    gleich(p7.length, 1, `unknown run (${p7.join(', ')})`)
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    gleich(lauf.prompt, 'p', 'nothing of the failed edits landed')
    gleich(lauf.expected_minutes, 45, 'duration untouched')
  })

  // ------------------------------------------------------------------
  gruppe('tmux sessions: reading, judging, keeping (sessions.mjs)')

  const se = await import('../server/sessions.mjs')
  // Exactly the two format strings sessions.mjs asks tmux for, tab-separated.
  const SESSION_LINES = [
    'fl-einzel-aaaa\t1787600000\t0\t1\t1787600500\t/srv/worktrees/a',
    'fl-einzel-bbbb\t1787500000\t1\t2\t1787500900\t/srv/worktrees/b',
  ].join('\n')

  await pruefe('a session line becomes a session, the path may contain tabs', () => {
    const s = se.parseSessions(SESSION_LINES + '\ncc-tab\t1787400000\t0\t1\t1787400000\t/srv/a\tb')
    gleich(s.length, 3, 'three sessions')
    gleich(s[0].name, 'fl-einzel-aaaa', 'name')
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
      'fl-einzel-aaaa\t0\t111\t\t\tclaude',
      'fl-einzel-bbbb\t1\t222\t0\t1787501000\tbash',
      'fl-einzel-bbbb\t1\t223\t0\t1787502000\tbash',
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

  await pruefe('the archive-session rule: on by default with keep 0, switchable off', () => {
    gleich(se.archiveSessionKeepMs({}), 0, 'default: close right away')
    gleich(se.archiveSessionKeepMs({ archive_session_keep_hours: '2' }), 2 * 3600_000, 'hours')
    gleich(se.archiveSessionKeepMs({ archive_session_keep_hours: '0.5' }), 1800_000, 'half hours are allowed')
    gleich(se.archiveSessionKeepMs({ archive_session_on: '0' }), null, 'switched off: no archive rule')
    gleich(se.archiveSessionKeepMs({ archive_session_on: '0', archive_session_keep_hours: '2' }), null, 'off wins over hours')
    gleich(se.archiveSessionKeepMs({ archive_session_on: '', archive_session_keep_hours: '2' }), null, 'empty is not "1" either')
    gleich(se.archiveSessionKeepHours({ archive_session_keep_hours: '1.5' }), 1.5, 'the form gets hours back')
    gleich(se.archiveSessionKeepHours({ archive_session_on: '0', archive_session_keep_hours: '1.5' }), 1.5,
      'the hours survive a switch-off — an off switch must not clear the field')
  })

  await pruefe('an archived run is closed once its keep time after the archive has passed', () => {
    const jetzt = 1_000_000_000_000   // = 2001-09-09 01:46:40 UTC
    const run = { archived_at: '2001-09-09 01:46:40' }   // exactly `jetzt` in DB form
    wahr(se.shouldCloseArchived(run, 0, jetzt), 'keep 0 closes right away')
    falsch(se.shouldCloseArchived(run, 3600_000, jetzt), 'keep 1 h: just archived, stays')
    const alt = { archived_at: '2001-09-09 00:46:40' }   // one hour earlier
    wahr(se.shouldCloseArchived(alt, 3600_000, jetzt), 'an hour later the same keep closes it')
    gleich(se.shouldCloseArchived(run, null, jetzt), false, 'off never closes by archive')
    gleich(se.shouldCloseArchived({ ...run, archived_at: null }, 0, jetzt), false, 'not archived: nothing to close')
    gleich(se.shouldCloseArchived({ archived_at: 'kaputt' }, 0, jetzt), false, 'an unparsable timestamp closes nothing')
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

  // The bug this exists for: 'no answer' used to be indistinguishable from
  // 'nothing there', and the watcher spends 'nothing there' by ABORTING runs.
  // One failed tmux call therefore ended every running run on the machine.
  await pruefe('tmux "I cannot answer" is never read as "there is nothing"', () => {
    gleich(se.tmuxVerdict({ ok: true, stdout: 'cc-einzel-1\t1\t0\t1\t1\t/tmp', stderr: '' }), 'ok', 'an answer is an answer')
    // Measured against tmux 3.4, both wordings.
    gleich(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)' }),
      'no_server', 'no socket: there really is no session')
    gleich(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'no server running on /tmp/tmux-1000/default' }),
      'no_server', 'the older wording says the same')
    // Everything below used to arrive as an empty session list.
    gleich(se.tmuxVerdict({ ok: false, stdout: '', stderr: '', code: 'ETIMEDOUT' }), 'unreachable', "sh()'s 30 s timeout")
    gleich(se.tmuxVerdict({ ok: false, stdout: '', stderr: '', code: 'ENOENT' }), 'unreachable', 'no tmux binary')
    gleich(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'fork failed: Cannot allocate memory' }),
      'unreachable', 'a fork that failed under memory pressure')
    gleich(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'server exited unexpectedly' }), 'unreachable', 'a server that died mid-answer')
  })

  await pruefe('one session is gone, is there, or did not say', () => {
    gleich(se.sessionGoneFrom({ ok: true, stdout: '', stderr: '' }), false, 'has-session succeeded: it is there')
    gleich(se.sessionGoneFrom({ ok: false, stdout: '', stderr: "can't find session: cc-einzel-1" }), true, 'tmux named it: gone')
    gleich(se.sessionGoneFrom({ ok: false, stdout: '', stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)' }),
      true, 'no server at all: gone')
    // null is the whole point — the caller must not end a run on it.
    gleich(se.sessionGoneFrom({ ok: false, stdout: '', stderr: '', code: 'ETIMEDOUT' }), null, 'a timeout says nothing')
    gleich(se.sessionGoneFrom({ ok: false, stdout: '', stderr: 'fork failed: Cannot allocate memory' }), null, 'a failed fork says nothing')
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

  await pruefe('the memory reading is measured on ONE clock: the cache is the update interval', async () => {
    // The sidebar asks for this on every page and re-fetches itself every 30 s;
    // what keeps `tmux list-sessions` and a `ps` over the whole machine from
    // running that often is this cache alone. So the cache IS the eight-minute
    // interval, and that is what is tested here — not the number, which belongs
    // to whatever tmux happens to hold on the machine running the suite.
    se._sessionMemoryReset()
    const a = await se.sessionMemory()
    wahr(a && Number.isFinite(a.rssKb) && a.rssKb >= 0, `a measurement (${JSON.stringify(a)})`)
    wahr(a.sessions >= 0 && a.running >= 0 && a.running <= a.sessions,
      'the running ones are a subset of all of them')
    gleich(a.intervalMs, 8 * 60_000, 'eight minutes by default, and it travels with the value')
    gleich(await se.sessionMemory(), a, 'a second call inside the window measures nothing anew')
    // Expired: what comes back is still the old object (stale-while-revalidate —
    // no page render may wait on three subprocesses), and the refresh behind it
    // replaces it.
    se._sessionMemoryAge(9 * 60_000)
    gleich(await se.sessionMemory(), a, 'an expired entry is handed back as it stands')
    await new Promise(r => setTimeout(r, 300))
    const b = await se.sessionMemory()
    wahr(b.measuredAtMs >= a.measuredAtMs, 'and behind it a fresh measurement landed')
    se._sessionMemoryReset()
  })

  // ------------------------------------------------------------------
  gruppe('Integration: finish gate, integrator, escalation (integrate.mjs)')

  const ig = await import('../server/integrate.mjs')

  await pruefe('the check interval is dense at first and slows down', () => {
    gleich(ig.nextCheckDelayMs(0), 5000, 'right after the report')
    gleich(ig.nextCheckDelayMs(59_000), 5000, 'still under a minute')
    gleich(ig.nextCheckDelayMs(60_000), 15_000, 'from a minute on')
    gleich(ig.nextCheckDelayMs(4 * 60_000), 15_000, 'under five minutes')
    gleich(ig.nextCheckDelayMs(5 * 60_000), 30_000, 'from five minutes on')
    gleich(ig.nextCheckDelayMs(NaN), 5000, 'no timestamp: as at the start')
  })

  await pruefe('what the hub put into the worktree is not the agent’s dirt', () => {
    const porcelain = [
      '?? referenz',
      '?? .cursor/hooks.json',
      ' M server/hub.mjs',
      '?? neu.txt',
    ].join('\n')
    const fremd = ig.foreignChanges(porcelain, ['referenz', '.cursor'])
    gleich(fremd.join(','), 'server/hub.mjs,neu.txt', 'only the agent’s own changes')
  })

  await pruefe('the extras are filtered as a directory AND as a single file', () => {
    // git names the directory when everything below it is untracked, and the
    // single file when it is not — both forms have to be covered.
    gleich(ig.foreignChanges('?? .cursor/\n', ['.cursor']).length, 0, 'directory form with a slash')
    gleich(ig.foreignChanges('?? .cursor/hooks.json\n', ['.cursor']).length, 0, 'file below it')
    gleich(ig.foreignChanges('?? .cursorrules\n', ['.cursor']).length, 1, 'a neighbour with the same prefix is NOT ours')
  })

  await pruefe('an empty status is an empty list, not a crash', () => {
    gleich(ig.foreignChanges('', []).length, 0, 'empty')
    gleich(ig.foreignChanges(null, null).length, 0, 'nothing at all')
  })

  await pruefe('the finish gate decides in this order: dirty, commits, conflict', () => {
    gleich(ig.decideFinish({ dirty: true, commits: true, conflict: true }), 'awaiting_commit', 'dirt outranks everything')
    gleich(ig.decideFinish({ dirty: true, commits: false, conflict: false }), 'awaiting_commit', 'dirty without commits')
    gleich(ig.decideFinish({ dirty: false, commits: false, conflict: false }), 'nothing', 'nothing committed')
    gleich(ig.decideFinish({ dirty: false, commits: true, conflict: true }), 'awaiting_merge', 'conflict')
    gleich(ig.decideFinish({ dirty: false, commits: true, conflict: false }), 'merging', 'clean and mergeable')
  })

  await pruefe('an unfinished run is classified by commits and dirt', () => {
    gleich(ig.classifyUnmerged({ commits: 2, dirty: 0 }), 'unmerged_commits', 'only commits')
    gleich(ig.classifyUnmerged({ commits: 2, dirty: 3 }), 'unmerged_both', 'both')
    gleich(ig.classifyUnmerged({ commits: 0, dirty: 3 }), 'unmerged_dirty', 'only dirt')
    gleich(ig.classifyUnmerged({ commits: 0, dirty: 0 }), 'nothing', 'neither')
  })

  await pruefe('the operator’s own commits are pushed, never forced', () => {
    gleich(ig.decidePush({ ahead: 0, behind: 0 }), 'skip', 'in sync')
    gleich(ig.decidePush({ ahead: 0, behind: 4 }), 'skip', 'only origin moved')
    gleich(ig.decidePush({ ahead: 3, behind: 0 }), 'push', 'fast-forward')
    gleich(ig.decidePush({ ahead: 3, behind: 4 }), 'diverged', 'both moved: a human decides')
  })

  await pruefe('git merge-tree’s output becomes the list of conflicting files', () => {
    const stdout = [
      'e99c659e743683c311fe49f74f1693a866fb1886',
      'f.txt',
      'server/hub.mjs',
      '',
      'Auto-merging f.txt',
      'CONFLICT (content): Merge conflict in f.txt',
    ].join('\n')
    gleich(ig.conflictFilesFromMergeTree(stdout).join(','), 'f.txt,server/hub.mjs', 'the paths, not the prose')
    gleich(ig.conflictFilesFromMergeTree('abc123\n').length, 0, 'a clean merge names no file')
  })

  await pruefe('a file list is indented and capped', () => {
    gleich(ig.formatFiles([]), '  (none)', 'nothing to list')
    gleich(ig.formatFiles(['a.txt', 'b/c.txt']), '  a.txt\n  b/c.txt', 'indented')
    const many = ig.formatFiles(Array.from({ length: 35 }, (_, i) => `f${i}.txt`))
    gleich(many.split('\n').length, 31, '30 lines plus the note')
    enthaelt(many, '… and 5 more', 'says how many were left out')
  })

  await pruefe('the messages to the agent carry every placeholder filled in', () => {
    const m1 = ig.fill(ig.M1, { files: '  a.txt', report_file: '/runs/x/report.md', timeout: 15 })
    enthaelt(m1, 'NOT finished yet', 'says the run is not over')
    enthaelt(m1, '  a.txt', 'the file')
    enthaelt(m1, 'fl-report done --file /runs/x/report.md', 'the exact command')
    enthaelt(m1, 'after 15 minutes', 'the deadline')
    falsch(/\{[a-z_]+\}/.test(m1), 'no placeholder left over')

    const m2 = ig.fill(ig.M2, { base: 'main', files: '  a.txt', report_file: '/r.md', landed_runs: '- "x" (abc1234): y' })
    enthaelt(m2, 'git fetch origin && git merge origin/main', 'the command that resolves it')
    enthaelt(m2, 'Do NOT merge into or push to main yourself', 'the ground rule')
    falsch(/\{[a-z_]+\}/.test(m2), 'no placeholder left over')
  })

  await pruefe('the conflict run’s task names branch, reason, report and what landed', () => {
    const p = ig.fill(ig.P_CONFLICT, {
      branch: 'resolve/abc1234', base: 'main',
      orig_title: 'Add a goal field', orig_id: 'aaaa-bbbb',
      reason: 'merge conflict', files: '  server/db.mjs',
      check_line: 'Run the merge check and make it pass: `node test/unit.mjs`',
      orig_report: 'It did the thing.', landed_runs: '- "other" (def5678): moved things',
      resolver_extra: '',
    })
    enthaelt(p, 'make the branch `resolve/abc1234` mergeable', 'its own branch')
    enthaelt(p, '"Add a goal field" (Freilauf run aaaa-bbbb)', 'the run it works for')
    enthaelt(p, 'BOTH intentions survive', 'the rule that keeps work from being dropped')
    enthaelt(p, 'It did the thing.', 'the original report')
    enthaelt(p, 'never push to main yourself', 'the ground rule')
    falsch(/\{[a-z_]+\}/.test(p), 'no placeholder left over')
  })

  await pruefe('a long report is cut and says where the whole one is', () => {
    const kurz = ig.truncateReport({ id: 'r1', report_md: 'short' }, 20)
    gleich(kurz, 'short', 'a short report is passed through')
    const lang = ig.truncateReport({ id: 'r1', report_md: 'x'.repeat(100) }, 20)
    wahr(lang.startsWith('x'.repeat(20)), 'cut at the cap')
    enthaelt(lang, 'truncated by Freilauf', 'says it was cut')
    enthaelt(lang, 'report.md', 'names the full report')
    gleich(ig.truncateReport({ id: 'r1', report_md: null }), '(no report)', 'no report at all')
    gleich(ig.truncateReport({ id: 'r1', report_md: 'short', report_detail_md: 'long detail' }, 20), 'long detail',
      'the DETAILED report is the context a resolver wants')
    enthaelt(ig.truncateReport({ id: 'r1', report_md: 'short', report_detail_md: 'x'.repeat(100) }, 20),
      'report-detail.md', 'and the note names the file the whole report actually lives in')
  })

  await pruefe('publicBase: a configured host wins, the port stays live, the env seam still answers', async () => {
    const vorherUrl = process.env.FREILAUF_PUBLIC_URL
    const vorherUrlAlt = process.env.CCHUB_PUBLIC_URL
    const vorherVpn = process.env.FREILAUF_VPN_PORT
    const vorherVpnAlt = process.env.CCHUB_VPN_PORT
    delete process.env.FREILAUF_PUBLIC_URL
    // The rename left BOTH names of every seam alive (env.mjs), and this machine's
    // shell exports the old ones — the suite must fence both or the operator's
    // values leak into the "no host, no env" fallback assertion.
    delete process.env.CCHUB_PUBLIC_URL
    delete process.env.FREILAUF_VPN_PORT
    delete process.env.CCHUB_VPN_PORT
    setPublicHost('')
    try {
      gleich(publicBase(), 'https://127.0.0.1:8790', 'no host, no env: the local fallback with the code default port')
      process.env.FREILAUF_VPN_PORT = '47830'
      setPublicHost('hub.example.internal')
      gleich(publicBase(), 'https://hub.example.internal:47830', 'the configured hostname with the LIVE port')
      setPublicHost('')
      process.env.FREILAUF_PUBLIC_URL = 'https://alt.internal:9999'
      gleich(publicBase(), 'https://alt.internal:9999', 'without a configured host the env seam (a full URL) answers')
      setPublicHost('   ')
      gleich(publicBase(), 'https://alt.internal:9999', 'whitespace is not a host')
    } finally {
      if (vorherUrl === undefined) delete process.env.FREILAUF_PUBLIC_URL; else process.env.FREILAUF_PUBLIC_URL = vorherUrl
      if (vorherUrlAlt === undefined) delete process.env.CCHUB_PUBLIC_URL; else process.env.CCHUB_PUBLIC_URL = vorherUrlAlt
      if (vorherVpn === undefined) delete process.env.FREILAUF_VPN_PORT; else process.env.FREILAUF_VPN_PORT = vorherVpn
      if (vorherVpnAlt === undefined) delete process.env.CCHUB_VPN_PORT; else process.env.CCHUB_VPN_PORT = vorherVpnAlt
      setPublicHost('')
    }
  })

  await pruefe('the assessment message names the numbers and the way back in', () => {
    const run = { harness: 'claude', id: 'aaaa-bbbb-cccc-dddd', workdir_effective: '/wt/a' }
    const both = ig.assessText(run, { status: 'unmerged_both', commits: 2, dirty: 3 })
    enthaelt(both, '2 commit(s)', 'commits')
    enthaelt(both, '3 uncommitted file(s)', 'dirty files')
    enthaelt(both, 'Resume the session: cd /wt/a && claude --resume aaaa-bbbb-cccc-dddd', 'the resume command')
    const hermes = ig.assessText({ harness: 'hermes', workdir_effective: '/wt/b' },
      { status: 'nothing', commits: 0, dirty: 0 })
    enthaelt(hermes, 'cannot be resumed', 'a harness without a resume says so')
    enthaelt(hermes, '/wt/b', 'and names the worktree instead')
  })

  await pruefe('the setup round trip: setup → form body → the same setup', async () => {
    const { setupToFormBody, runSetupFromForm } = await import('../server/run-def.mjs')
    const { saveCodingAgent } = await import('../server/coding-agents.mjs')
    saveCodingAgent({ harness: 'opencode', enabled: 1, providers: ['openrouter'] })
    const setup = { harness: 'opencode', provider: 'openrouter', model: 'x/y', or_provider: 'fireworks', effort: null }
    const problems = []
    const back = await runSetupFromForm(setupToFormBody(setup), problems)
    gleich(problems.length, 0, `no problems (${problems.join(' · ')})`)
    gleich(back.harness, 'opencode', 'harness')
    gleich(back.provider, 'openrouter', 'provider')
    gleich(back.model, 'x/y', 'model')
    gleich(back.orProvider, 'fireworks', 'serving provider survives where it can be passed through')
  })

  await pruefe('the merge rule is only in the prompt where the hub really merges', async () => {
    const { platformSuffix } = await import('../server/runner.mjs')
    const run = { id: 'r1', harness: 'claude', workdir_effective: '/wt/a', expected_minutes: 30 }
    const out = platformSuffix(run, 'No branch.', {}, { merge_mode: 'off', base_branch: 'main' })
    falsch(out.includes('Freilauf merges your work'), 'with merge_mode off the prompt is what it always was')
    falsch(out.includes('fl-report prints'), 'and the finishing block is unchanged too')
    const an = platformSuffix(run, 'No branch.', {}, { merge_mode: 'hub', base_branch: 'trunk' })
    enthaelt(an, 'Freilauf merges your work into trunk itself', 'the base branch is named')
    enthaelt(an, 'Never merge into or push to trunk yourself', 'and so is the ground rule')
    enthaelt(an, 'fl-report prints Freilauf\'s answer', 'the finishing block says the answer is worth reading')
    enthaelt(an, 'fl-report done --file', 'and step 2 is still there — it is not removable')
    enthaelt(an, '--detail', 'the detail report travels along in the same command')
    enthaelt(an, 'report-detail.md', 'and names its path')
    enthaelt(an, 'the SHORT report', 'the two parts are named')
    enthaelt(an, 'DETAILED report', 'and what each of them is for')
    falsch(/\{base\}/.test(an), 'no placeholder left over')
  })

  await pruefe('the prompt tells the agent how to report follow-up work — once per batch, same command', async () => {
    const { platformSuffix } = await import('../server/runner.mjs')
    const run = { id: 'r1', harness: 'claude', workdir_effective: '/wt/a', expected_minutes: 30 }
    const off = platformSuffix(run, 'No branch.', {}, { merge_mode: 'off', base_branch: 'main' })
    enthaelt(off, 'AFTER YOU HAVE REPORTED DONE', 'the block is there with the integration off too')
    enthaelt(off, 'FOLLOW-UP REPORT', 'and names what the hub makes of it')
    enthaelt(off, 'report ONCE at the end, not once per', 'one report per batch of follow-up work')
    enthaelt(off, 'It is the same command on purpose', 'the same command, and it says why')
    falsch(off.includes('origin/main merged into your branch once more'), 'no merge clause where nobody merges')
    falsch(off.includes('integration into main'), 'and no integration among the processes')
    const on = platformSuffix(run, 'No branch.', {}, { merge_mode: 'hub', base_branch: 'trunk' })
    enthaelt(on, 'origin/trunk merged into your branch once more', 'under hub the follow-up merges the base again')
    enthaelt(on, 'integration into trunk', 'and integration is named as what fires again')
    falsch(/\{(base|followup_merge|followup_processes)\}/.test(on), 'no placeholder left over')
    const kept = platformSuffix({ ...run, keep_on_branch: 1 }, 'Keep.', {}, { merge_mode: 'hub', base_branch: 'trunk' })
    falsch(kept.includes('merged into your branch once more'), 'a kept run is not told to merge the base')
    // The block comes LAST: it describes what happens after the finishing steps.
    wahr(on.indexOf('HOW THIS RUN ENDS') < on.indexOf('AFTER YOU HAVE REPORTED DONE'), 'after the finishing block')
  })

  await pruefe('a turn end on a finished run is a follow-up only for cursor, and only with new commits', async () => {
    const { wantsTurnEndFollowUp, followUpText } = await import('../server/reports.mjs')
    const cursor = { turnEndsRun: true }
    const done = { status: 'done', merged_sha: 'aaa', finish_state: null, followup_open: 0 }
    wahr(wantsTurnEndFollowUp(done, 'bbb', cursor), 'tip moved past the merge: follow-up')
    falsch(wantsTurnEndFollowUp(done, 'aaa', cursor), 'tip is what was merged: nothing to report')
    falsch(wantsTurnEndFollowUp(done, null, cursor), 'no tip (worktree gone): nothing')
    falsch(wantsTurnEndFollowUp({ ...done, merged_sha: null }, 'bbb', cursor), 'never merged (merge mode off): no comparison, no net')
    falsch(wantsTurnEndFollowUp({ ...done, finish_state: 'checking' }, 'bbb', cursor), 'already in the gate')
    falsch(wantsTurnEndFollowUp({ ...done, followup_open: 1 }, 'bbb', cursor), 'a follow-up already open')
    falsch(wantsTurnEndFollowUp({ ...done, status: 'running' }, 'bbb', cursor), 'a running run is finishByTurnEnd\'s business')
    falsch(wantsTurnEndFollowUp(done, 'bbb', { turnEndsRun: false }), 'claude: a turn end is a note')
    falsch(wantsTurnEndFollowUp(done, 'bbb', null), 'unknown harness')
    // The message names what it is, on both lines.
    const text = followUpText({ id: 'r1', harness: 'claude', model: 'sonnet', repo_id: -1 }, 'fixed the tests', 'Merged into main: abc1234', { n: 2, minutes: 7 })
    enthaelt(text, 'FOLLOW-UP REPORT #2:', 'the header says which report this is')
    enthaelt(text, 'fixed the tests', 'the follow-up text')
    enthaelt(text, '✅ Follow-up #2 done · claude/sonnet', 'the status line')
    enthaelt(text, 'Follow-up time: 7 min', 'time since the previous report, not the run\'s duration')
    enthaelt(text, 'Merged into main: abc1234', 'and the merge line')
    falsch(text.includes('Duration:'), 'no run duration — the run started long ago')
  })

  await pruefe('a replayed report is recognised so a lost HTTP answer cannot send it twice', async () => {
    const { isReplayedReport } = await import('../server/reports.mjs')
    const run = { report_md: 'The task is done.', followup_md: null, help_text: null }
    wahr(isReplayedReport(run, 'done', 'The task is done.'), 'the identical first report is a replay')
    falsch(isReplayedReport(run, 'done', 'A genuinely new follow-up report.'), 'a new follow-up is not')
    const mitFu = {
      report_md: 'The task is done.\n\n---\n## Follow-up report #1 (x)\n\nAdded the second file.',
      followup_md: 'Added the second file.', help_text: null,
    }
    wahr(isReplayedReport(mitFu, 'done', 'Added the second file.'), 'the latest follow-up replayed')
    wahr(isReplayedReport(mitFu, 'done', 'The task is done.'), 'the first report replayed after follow-ups')
    falsch(isReplayedReport(mitFu, 'done', 'something else entirely'), 'still no false positive')
    wahr(isReplayedReport({ report_md: '**Failed:** it broke', followup_md: null, help_text: null }, 'failed', 'it broke'),
      'a failed report replayed')
    wahr(isReplayedReport({ report_md: 'x', followup_md: null, help_text: 'are you there?' }, 'help', 'are you there?'),
      'a help call replayed')
    falsch(isReplayedReport({ report_md: 'x', followup_md: null, help_text: null }, 'done', ''), 'empty text is never a replay')
    falsch(isReplayedReport(null, 'done', 'anything'), 'a missing run answers no')
  })

  await pruefe('rearmDispatch lets the flows of a finished run fire again', async () => {
    const { default: db } = await import('../server/db.mjs')
    const { rearmDispatch } = await import('../server/flows/db.mjs')
    const repoId = db.prepare(`INSERT INTO repos (name, path) VALUES ('rearm', '/tmp/rearm') RETURNING id`).get().id
    const id = 'rearm000-0000-4000-8000-000000000001'
    db.prepare(`INSERT INTO runs (id, repo_id, harness, status, prompt, branch_mode, expected_minutes, started_at, ended_at,
      flow_dispatched, merge_dispatched, merge_status) VALUES (?, ?, 'claude', 'done', 'x', 'keiner', 30, datetime('now'), datetime('now'), 1, 1, 'merged')`)
      .run(id, repoId)
    rearmDispatch(id)
    let r = db.prepare('SELECT flow_dispatched, merge_dispatched FROM runs WHERE id=?').get(id)
    gleich(r.flow_dispatched, 0, 'run_finished fires again')
    gleich(r.merge_dispatched, 1, 'but not run_merged — nothing was merged')
    db.prepare('UPDATE runs SET flow_dispatched=1 WHERE id=?').run(id)
    rearmDispatch(id, { merged: true })
    r = db.prepare('SELECT flow_dispatched, merge_dispatched FROM runs WHERE id=?').get(id)
    gleich(r.flow_dispatched, 0, 'both, when the follow-up merged')
    gleich(r.merge_dispatched, 0, 'run_merged too')
    db.prepare(`UPDATE runs SET merge_status='nothing', merge_dispatched=1 WHERE id=?`).run(id)
    rearmDispatch(id, { merged: true })
    gleich(db.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get(id).merge_dispatched, 1,
      'a run that is not merged cannot fire a merge, whatever the caller says')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
    db.prepare('DELETE FROM repos WHERE id=?').run(repoId)
  })

  // ------------------------------------------------------------------
  gruppe('tmux cleanup: the memory-freeing agent')

  const { cleanupSettings, cleanupPrompt, cleanupRunInFlight, keepSessionsForRuns, startCleanupRun, maybeAutoCleanup, CLEANUP_PROMPT_DEFAULT } = await import('../server/cleanup.mjs')
  const db2 = (await import('../server/db.mjs')).default
  const uuid = (await import('node:crypto')).randomUUID

  await pruefe('runSetupFields: the styling option wraps, the default stays untouched', () => {
    const plain = rd.runSetupFields({ harness: 'claude' })
    falsch(plain.startsWith('<fieldset'), 'without the option there is no wrapper — existing callers are unchanged')
    enthaelt(plain, 'name="harness"', 'and the block is the one every form uses')
    const wrapped = rd.runSetupFields({ harness: 'claude' }, { wrapClass: 'cleanup-setup' })
    enthaelt(wrapped, '<fieldset class="cleanup-setup">', 'the styling option wraps in a fieldset')
    enthaelt(wrapped, 'name="harness"', 'with the same fields inside')
  })

  await pruefe('cleanupSettings reads the table and falls back sanely', () => {
    const s = cleanupSettings({})
    gleich(s.on, false, 'off by default')
    gleich(s.thresholdGb, 5, 'default threshold 5 GB')
    gleich(s.targetGb, 2, 'default target 2 GB')
    gleich(s.cooldownMin, 60, 'default cooldown 60 min')
    gleich(s.harness, '', 'no agent by default')
    const broken = cleanupSettings({ cleanup_threshold_gb: 'quatsch', cleanup_target_gb: '-3' })
    gleich(broken.thresholdGb, 5, 'a broken threshold falls back')
    gleich(broken.targetGb, 2, 'a negative target falls back')
  })

  await pruefe('the prompt template is the memory successor of the old cleanup prompt', () => {
    enthaelt(CLEANUP_PROMPT_DEFAULT, '{target_gb}', 'target placeholder')
    enthaelt(CLEANUP_PROMPT_DEFAULT, '{keep_line}', 'keep-line placeholder')
    enthaelt(CLEANUP_PROMPT_DEFAULT, '{sessions_url}', 'sessions url placeholder')
    enthaelt(CLEANUP_PROMPT_DEFAULT, '#{window_activity}', 'activity measured by window_activity, not session_activity')
    falsch(/\{base\}/.test(CLEANUP_PROMPT_DEFAULT), 'no leftover placeholder')
  })

  await pruefe('cleanupPrompt fills the live values into the template', () => {
    // The public URL and the VPN port are env seams with BOTH names (env.mjs) —
    // this machine's shell exports the old ones, and the assertion wants the
    // code defaults.
    const vorher = [process.env.FREILAUF_PUBLIC_URL, process.env.CCHUB_PUBLIC_URL,
      process.env.FREILAUF_VPN_PORT, process.env.CCHUB_VPN_PORT]
    delete process.env.FREILAUF_PUBLIC_URL
    delete process.env.CCHUB_PUBLIC_URL
    delete process.env.FREILAUF_VPN_PORT
    delete process.env.CCHUB_VPN_PORT
    try {
      const out = cleanupPrompt({ targetGb: 3, keepSessions: ['sess-1'], settings: { prompt: 'ziel={target_gb} keep={keep_line} url={sessions_url} th={threshold_gb}', thresholdGb: 5 } })
      gleich(out, 'ziel=3 keep=Diese Sessions bleiben auf jeden Fall erhalten (auch wenn inaktiv) und dürfen NICHT beendet werden:\nsess-1 url=https://127.0.0.1:8790/sessions th=5', 'all placeholders filled')
    } finally {
      if (vorher[0] !== undefined) process.env.FREILAUF_PUBLIC_URL = vorher[0]; else delete process.env.FREILAUF_PUBLIC_URL
      if (vorher[1] !== undefined) process.env.CCHUB_PUBLIC_URL = vorher[1]; else delete process.env.CCHUB_PUBLIC_URL
      if (vorher[2] !== undefined) process.env.FREILAUF_VPN_PORT = vorher[2]; else delete process.env.FREILAUF_VPN_PORT
      if (vorher[3] !== undefined) process.env.CCHUB_VPN_PORT = vorher[3]; else delete process.env.CCHUB_VPN_PORT
    }
    const noKeep = cleanupPrompt({ targetGb: 1, settings: { prompt: 'keep={keep_line}' } })
    gleich(noKeep, 'keep=Ohne Ausnahmen — was inaktiv ist, darf gehen, älteste zuerst.', 'no keep list = the default sentence')
  })

  await pruefe('keepSessionsForRuns resolves run ids to session names', () => {
    const id = uuid()
    db2.prepare(`INSERT INTO repos(id, name, path, base_branch) VALUES(99,'cleanup-test','/tmp/x','main')`).run()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, tmux_session, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, 'fl-test-sess', datetime('now'))`).run(id)
    gleich(JSON.stringify(keepSessionsForRuns(`${id} 00000000-0000-0000-0000-000000000000`)),
      JSON.stringify(['fl-test-sess']), 'the known id becomes its session, the unknown one is dropped')
    gleich(JSON.stringify(keepSessionsForRuns('')), '[]', 'empty input stays empty')
  })

  await pruefe('cleanupRunInFlight sees a marked run and clears when it ends', () => {
    const id = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'running', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(id)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(id, JSON.stringify({ source: 'auto', targetGb: 2 }))
    wahr(cleanupRunInFlight(), 'a running run with the marker is in flight')
    db2.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(id)
    falsch(cleanupRunInFlight(), 'a finished one is not')
  })

  await pruefe('a finished cleanup run drops the memory cache — the sidebar never serves the old number', async () => {
    // The sidebar re-fetches its fragment on the run's end event (~2 s later in
    // hub.js); what that render then shows is decided by this cache alone. A
    // cleanup run frees memory while it works, so its end must invalidate — an
    // ordinary run's end must not, the eight-minute clock exists for it.
    se._sessionMemoryReset()
    const a = await se.sessionMemory()
    const ordinaer = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(ordinaer)
    falsch(se.refreshSessionMemoryAfterRun(ordinaer), 'no cleanup marker = no invalidation')
    gleich(await se.sessionMemory(), a, 'the cached reading survives an ordinary run')

    const raeumer = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(raeumer)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(raeumer, JSON.stringify({ source: 'sidebar' }))
    wahr(se.refreshSessionMemoryAfterRun(raeumer), 'the cleanup marker invalidates')
    const b = await se.sessionMemory()
    wahr(b !== a && b.measuredAtMs >= a.measuredAtMs, 'and the next reading is a fresh measurement')
    falsch(se.refreshSessionMemoryAfterRun(null), 'no run id = no invalidation')
    se._sessionMemoryReset()
  })

  await pruefe('startCleanupRun refuses without a configured agent and with a broken target', async () => {
    const no = await startCleanupRun({ settings: cleanupSettings({}) })
    gleich(no.ok, false, 'nothing configured')
    wahr(String(no.error).length > 0, 'with a reason')
    const bad = await startCleanupRun({ targetGb: -1, settings: cleanupSettings({ cleanup_harness: 'claude' }) })
    gleich(bad.ok, false, 'negative target refused')
  })

  await pruefe('maybeAutoCleanup stays quiet while the feature is off or no agent is set', async () => {
    const off = await maybeAutoCleanup()
    gleich(off, null, 'off by default = nothing')
    const noAgent = await maybeAutoCleanup(0)
    gleich(noAgent, null, 'no agent = nothing')
  })

  await pruefe('maybeAutoCleanup gates on threshold, in-flight and cooldown', async () => {
    for (const [k, v] of [['cleanup_on', '1'], ['cleanup_harness', 'claude'], ['cleanup_threshold_gb', '5'],
      ['cleanup_target_gb', '2'], ['cleanup_cooldown_min', '60']]) {
      db2.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)`).run(k, v)
    }

    const unter = await maybeAutoCleanup(Date.now(), 4)
    gleich(unter, null, 'memory below the threshold = nothing')

    // A recent cleanup run is still cooling down.
    const letzter = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, ended_at, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, datetime('now'), datetime('now'))`).run(letzter)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(letzter, JSON.stringify({ source: 'auto' }))
    const kuehl = await maybeAutoCleanup(Date.now(), 10)
    gleich(kuehl, null, 'the cooldown after the last run holds')

    // In flight (running) also blocks, whatever the memory says.
    const laufend = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'running', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(laufend)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(laufend, JSON.stringify({ source: 'auto' }))
    gleich(await maybeAutoCleanup(Date.now(), 10), null, 'an in-flight cleanup run blocks the gate')
    // Age every cleanup run of the sandbox — the cooldown must have lapsed for the
    // final assertion, including the run the in-flight test left behind.
    db2.prepare(`UPDATE runs SET ended_at=datetime('now', '-120 minutes') WHERE id IN
      (SELECT r.id FROM runs r JOIN events e ON e.run_id=r.id WHERE e.kind='cleanup_run')`).run()
    db2.prepare(`UPDATE runs SET status='done' WHERE id=?`).run(laufend)

    // Nothing blocks and memory is above the threshold → the gate fires (whatever
    // startCleanupRun then makes of the sandbox repo is not this test's question).
    const ausgeloest = await maybeAutoCleanup(Date.now(), 10)
    falsch(ausgeloest === null, 'above threshold, cooled down, nothing in flight = the gate fires')
  })

  // ------------------------------------------------------------------
  gruppe('The rename: every seam answers to both names')

  const { env, envIs, envNames } = await import('../server/env.mjs')
  const { pick, configDir, dataDir, deployDir, dbPath, certDir } = await import('../server/paths.mjs')

  /** Run fn with these variables set, and put the environment back afterwards. */
  const mitUmgebung = (vars, fn) => {
    const vorher = {}
    for (const [k, v] of Object.entries(vars)) {
      vorher[k] = process.env[k]
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    try { return fn() } finally {
      for (const [k, v] of Object.entries(vorher)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    }
  }

  await pruefe('env(): the new name wins, the old one still answers, neither is undefined', () => {
    mitUmgebung({ FREILAUF_TESTVAR: 'neu', CCHUB_TESTVAR: 'alt' }, () =>
      gleich(env('TESTVAR'), 'neu', 'both set'))
    mitUmgebung({ FREILAUF_TESTVAR: undefined, CCHUB_TESTVAR: 'alt' }, () =>
      gleich(env('TESTVAR'), 'alt', 'only the old one — the whole point of the fallback'))
    mitUmgebung({ FREILAUF_TESTVAR: undefined, CCHUB_TESTVAR: undefined }, () =>
      gleich(env('TESTVAR'), undefined, 'neither'))
  })

  await pruefe('env() takes the full name too, and passes an empty string through', () => {
    mitUmgebung({ FREILAUF_TESTVAR: 'x' }, () =>
      gleich(env('FREILAUF_TESTVAR'), 'x', 'the full name is the same question'))
    // `''` has to stay a VALUE. Every caller writes `Number(env(...) ?? default)`
    // or `env(...) ?? default`, and turning an empty string into "not set" here
    // would silently change what an operator wrote in their env file.
    mitUmgebung({ FREILAUF_TESTVAR: '', CCHUB_TESTVAR: 'alt' }, () =>
      gleich(env('TESTVAR'), '', 'an empty new value is not "unset"'))
  })

  await pruefe('the two variables that changed NAME, not just prefix', () => {
    // CCHUB_CC_START/CC_REPORT became FREILAUF_START_SCRIPT/REPORT_SCRIPT: the
    // `CC_` in the middle stopped meaning anything when the scripts became fl-*.
    mitUmgebung({ FREILAUF_START_SCRIPT: undefined, CCHUB_CC_START: '/old/cc-start' }, () =>
      gleich(env('START_SCRIPT'), '/old/cc-start', 'START_SCRIPT falls back to CCHUB_CC_START'))
    mitUmgebung({ FREILAUF_REPORT_SCRIPT: undefined, CCHUB_CC_REPORT: '/old/cc-report' }, () =>
      gleich(env('REPORT_SCRIPT'), '/old/cc-report', 'REPORT_SCRIPT falls back to CCHUB_CC_REPORT'))
    mitUmgebung({ FREILAUF_START_SCRIPT: '/new/fl-start', CCHUB_CC_START: '/old/cc-start' }, () =>
      gleich(env('START_SCRIPT'), '/new/fl-start', 'and the new name still wins'))
    gleich(envNames('START_SCRIPT').join(','), 'FREILAUF_START_SCRIPT,CCHUB_CC_START', 'both names are nameable')
    gleich(envNames('DATA_DIR').join(','), 'FREILAUF_DATA_DIR,CCHUB_DATA_DIR', 'the ordinary pair')
  })

  await pruefe('envIs() is the same question for the "=== 1" switches', () => {
    mitUmgebung({ FREILAUF_PULS_AUS: undefined, CCHUB_PULS_AUS: '1' }, () =>
      wahr(envIs('PULS_AUS', '1'), 'the old switch still switches'))
    mitUmgebung({ FREILAUF_PULS_AUS: '0', CCHUB_PULS_AUS: '1' }, () =>
      falsch(envIs('PULS_AUS', '1'), 'and the new one overrules it'))
  })

  await pruefe('pick(): the new path, unless only the old one is there', () => {
    const neu = join(sandkasten, 'pick-neu'), alt = join(sandkasten, 'pick-alt')
    gleich(pick(neu, alt), neu, 'neither exists → the new one (a fresh install never creates the old layout)')
    mkdirSync(alt, { recursive: true })
    gleich(pick(neu, alt), alt, 'only the old one exists → keep using it')
    mkdirSync(neu, { recursive: true })
    gleich(pick(neu, alt), neu, 'both exist → the new one')
  })

  await pruefe('the directories follow that rule, and an explicit variable overrules it', () => {
    const heim = join(sandkasten, 'heim')
    const cfg = join(heim, '.config'), dat = join(heim, '.local', 'share')
    mkdirSync(join(cfg, 'cc-hub'), { recursive: true })
    mkdirSync(join(dat, 'cc-hub'), { recursive: true })
    writeFileSync(join(dat, 'cc-hub', 'cc-hub.db'), '')
    mitUmgebung({ XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: dat, HOME: heim,
                  FREILAUF_DATA_DIR: undefined, CCHUB_DATA_DIR: undefined,
                  FREILAUF_DEPLOY_DIR: undefined, CCHUB_DEPLOY_DIR: undefined,
                  FREILAUF_CERT_DIR: undefined, CCHUB_CERT_DIR: undefined }, () => {
      gleich(configDir(), join(cfg, 'cc-hub'), 'an un-migrated config directory keeps being used')
      gleich(dataDir(), join(dat, 'cc-hub'), 'so does the data directory')
      // And inside it the file may still carry the old name. Creating freilauf.db
      // next to a populated cc-hub.db would look like a hub that lost every run.
      gleich(dbPath(), join(dat, 'cc-hub', 'cc-hub.db'), 'the old database file is not left behind')
      gleich(deployDir(), join(heim, 'agents', 'deploy', 'freilauf'), 'nothing there → the new deploy path')
      gleich(certDir(), join(heim, '.local', 'certs', 'freilauf'), 'nothing there → the new cert path')
    })
    mitUmgebung({ XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: dat, HOME: heim,
                  FREILAUF_DATA_DIR: '/somewhere/else' }, () => {
      gleich(dataDir(), '/somewhere/else', 'an explicit variable is the answer, existing or not')
      gleich(dbPath(), join('/somewhere/else', 'freilauf.db'), 'and the database follows it, under the new name')
    })
    mitUmgebung({ XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: dat, HOME: heim,
                  FREILAUF_DATA_DIR: undefined, CCHUB_DATA_DIR: join(dat, 'cc-hub') }, () => {
      gleich(dataDir(), join(dat, 'cc-hub'), 'the OLD variable name still points the hub at its data')
    })
  })

  await pruefe('bin/fl-paths.sh answers the same questions in bash', () => {
    const heim = join(sandkasten, 'bash-heim')
    mkdirSync(join(heim, '.config', 'cc-hub'), { recursive: true })
    mkdirSync(join(heim, '.local', 'share', 'freilauf'), { recursive: true })
    writeFileSync(join(heim, '.local', 'share', 'freilauf', 'freilauf.db'), '')
    const lib = new URL('../bin/fl-paths.sh', import.meta.url).pathname
    const frage = (ausdruck) => execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; ${ausdruck}`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: heim, XDG_CONFIG_HOME: join(heim, '.config'),
             XDG_DATA_HOME: join(heim, '.local', 'share'),
             FREILAUF_DATA_DIR: '', CCHUB_DATA_DIR: '', PATH: '/usr/bin:/bin' },
    }).trim()
    gleich(frage('fl_config_dir'), join(heim, '.config', 'cc-hub'), 'the old config directory')
    gleich(frage('fl_data_dir'), join(heim, '.local', 'share', 'freilauf'), 'the new data directory')
    gleich(frage('fl_db_file'), join(heim, '.local', 'share', 'freilauf', 'freilauf.db'), 'the database')
    gleich(frage('fl_env_file'), join(heim, '.config', 'cc-hub', 'env'), 'the env file goes with the config dir')
    // The same fallback the server side has — written once per language, and
    // this is the check that the two languages agree.
    gleich(execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; fl_env FOO bar`],
      { encoding: 'utf8', env: { ...process.env, CCHUB_FOO: 'alt', FREILAUF_FOO: '' } }).trim().replace(/\n$/, ''),
      '', 'an empty new value wins in bash too')
    gleich(execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; fl_env FOO bar`],
      { encoding: 'utf8', env: { ...process.env, CCHUB_FOO: 'alt' } }).trim(),
      'alt', 'the old name answers')
    gleich(execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; fl_env FOO bar`],
      { encoding: 'utf8', env: { ...process.env } }).trim(),
      'bar', 'and the default when neither is set')
  })

  await pruefe('the tmux prefix: fl- is what is created, cc- is still recognised', () => {
    const lib = new URL('../bin/fl-harness-tags.sh', import.meta.url).pathname
    const frage = (ausdruck) => execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; ${ausdruck}`],
      { encoding: 'utf8', env: { ...process.env, FREILAUF_HARNESS_TAGS: join(sandkasten, 'no-tags') } }).trim()
    gleich(frage('printf %s "$FL_PREFIX"'), 'fl-', 'new sessions are fl-')
    gleich(frage('fl_session_re'), '^(fl-|cc-)', 'both prefixes are listed')
    gleich(frage('fl_harness_of fl-oc-nacht'), 'opencode', 'a new opencode session')
    gleich(frage('fl_harness_of cc-oc-nacht'), 'opencode', 'and an old one, started before the rename')
    gleich(frage('fl_harness_of cc-nacht'), 'claude', 'an untagged old session is claude, as it always was')
    gleich(frage('fl_harness_bare fl-cu-nacht'), 'nacht', 'the bare name, new prefix')
    gleich(frage('fl_harness_bare cc-cu-nacht'), 'nacht', 'the bare name, old prefix')
  })

  await pruefe('a session name from before the rename still opens its terminal', async () => {
    // runs.tmux_session stores the NAME, so an old run keeps pointing at cc-…;
    // the terminal route validates that name against a pattern before attaching.
    const { SESSION_RE } = await import('../server/terminal.mjs')
    wahr(SESSION_RE.test('fl-nacht-a1b2'), 'a new session')
    wahr(SESSION_RE.test('cc-oc-nacht-a1b2'), 'an old one')
    falsch(SESSION_RE.test('xx-nacht'), 'and nothing else')
    falsch(SESSION_RE.test('fl-nacht; rm -rf /'), 'still nothing shell-shaped')
  })

} finally {
  rmSync(sandkasten, { recursive: true, force: true })
}

process.exit(bericht('Unit tests', start) || (zaehler.fehler.length ? 1 : 0))
