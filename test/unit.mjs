#!/usr/bin/env node
// Freilauf — unit tests for the functions with real logic and edge cases.
//
// Deliberately NOT tested: SQL strings, HTML snippets, CSS classes, column orders,
// exact message texts, private helper functions. Such tests would only cement the
// current implementation instead of securing behavior. What is tested is what
// computes or decides — schedules, cron, form parsing, quota gate, text processing.
//
// Usage:  node test/unit.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, utimesSync, symlinkSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { group, check, equal, isTrue, isFalse, contains, summary, counter } from './mini.mjs'

const start = Date.now()

// Own data directory: importing runner.mjs pulls in db.mjs, which would otherwise
// touch the real hub database.
const sandkasten = mkdtempSync(join(tmpdir(), 'freilauf-unit-'))
process.env.FREILAUF_DATA_DIR = join(sandkasten, 'data')
// The OpenRouter best-provider cache is a file next to the hub's real data —
// the suite points it into its own sandbox or a suite run would read (and
// overwrite) the operator's live selections.
process.env.FREILAUF_OR_ROUTING_JSON = join(sandkasten, 'openrouter-routing.json')
// The hub's own agent skills resolve their target directories against $HOME
// (~/.claude/skills and friends). Without this fence a suite run would install
// into — and later DELETE from — the operator's real skill directories.
process.env.FREILAUF_SKILLS_HOME = join(sandkasten, 'skillhome')
process.env.FREILAUF_SKILLS_STATE = join(sandkasten, 'skills-installed.json')

const d = (s) => new Date(s)

try {
  const { cronMatches, validCron, scheduleDue, scheduleText, weeklySlots, slotsUniform, splitTimes,
    lastMissedSlot, catchupHours,
    stripAnsi, escapeHtml, stripGitProgress,
    fmtDuration, parseDbUtc, toDbUtc, fmtRelativeTime, fmtDateTime, kurzid,
    fmtDbUtc, fmtClock, fmtDatePart, fmtNum, fmtPercent,
    timezoneForLanguage, setTimezone, validTz, tzAbbrev, TIMEZONE_OPTIONS, setPublicHost, publicBase } = await import('../server/util.mjs')
  const { parseForm, cookieRepo, rememberRepo, requestRepo } = await import('../server/web-helpers.mjs')

  // ------------------------------------------------------------------
  group('Cron: matching (cronMatches)')

  await check('fixed time matches exactly that minute', () => {
    isTrue(cronMatches('30 6 * * *', d('2026-08-24T06:30:00')), '06:30')
    isFalse(cronMatches('30 6 * * *', d('2026-08-24T06:31:00')), '06:31')
  })
  await check('steps */15 match every quarter hour', () => {
    for (const m of [0, 15, 30, 45]) isTrue(cronMatches('*/15 * * * *', d(`2026-08-24T10:${String(m).padStart(2, '0')}:00`)), `minute ${m}`)
    isFalse(cronMatches('*/15 * * * *', d('2026-08-24T10:31:00')), 'minute 31')
  })
  await check('range 1-5 means Monday through Friday', () => {
    isTrue(cronMatches('0 6 * * 1-5', d('2026-08-24T06:00:00')), 'Monday')
    isTrue(cronMatches('0 6 * * 1-5', d('2026-08-28T06:00:00')), 'Friday')
    isFalse(cronMatches('0 6 * * 1-5', d('2026-08-23T06:00:00')), 'Sunday')
  })
  await check('list 1,3,5 matches only the named days', () => {
    isTrue(cronMatches('0 6 * * 1,3,5', d('2026-08-26T06:00:00')), 'Wednesday')
    isFalse(cronMatches('0 6 * * 1,3,5', d('2026-08-25T06:00:00')), 'Tuesday')
  })
  await check('weekday 7 means Sunday (same as 0)', () => {
    isTrue(cronMatches('0 6 * * 7', d('2026-08-23T06:00:00')), 'Sunday as 7')
    isTrue(cronMatches('0 6 * * 0', d('2026-08-23T06:00:00')), 'Sunday as 0')
  })
  await check('month and day are checked too', () => {
    isTrue(cronMatches('0 0 1 1 *', d('2027-01-01T00:00:00')), 'New Year')
    isFalse(cronMatches('0 0 1 1 *', d('2026-12-31T00:00:00')), 'New Year\'s Eve')
  })
  await check('wrong field count never matches', () => {
    isFalse(cronMatches('* * * *', d('2026-08-24T06:00:00')), 'four fields')
    isFalse(cronMatches('', d('2026-08-24T06:00:00')), 'empty')
  })

  // ------------------------------------------------------------------
  group('Cron: input validation (validCron)')

  await check('common expressions are considered valid', () => {
    for (const c of ['0 6 * * *', '0 6 * * 1-5', '*/15 * * * *', '0 0 1 1 *', '30 6 * * 1,3,5'])
      isTrue(validCron(c), c)
  })
  await check('garbage and wrong field counts are rejected', () => {
    for (const c of ['jeden tag', '* * * *', '* * * * * *', '', null, undefined, 'abc def ghi jkl mno'])
      isFalse(validCron(c), String(c))
  })
  await check('out-of-range values are rejected', () => {
    isFalse(validCron('99 * * * *'), 'minute 99')
    isFalse(validCron('* 25 * * *'), 'hour 25')
    isFalse(validCron('* * 32 * *'), 'day 32')
    isFalse(validCron('* * * 13 *'), 'month 13')
  })
  await check('nonsensical range (5-1) is rejected', () => {
    isFalse(validCron('0 6 * * 5-1'), 'descending range')
  })

  // ------------------------------------------------------------------
  group('Schedules: due check (scheduleDue)')

  const woe = { schedule_kind: 'woechentlich', schedule_days: '1,3,5', schedule_time: '07:30', schedule_weeks: 1 }

  await check('weekly: only the chosen days at the chosen minute', () => {
    isTrue(scheduleDue(woe, d('2026-08-24T07:30:00')), 'Monday 07:30')
    isTrue(scheduleDue(woe, d('2026-08-26T07:30:00')), 'Wednesday 07:30')
    isFalse(scheduleDue(woe, d('2026-08-25T07:30:00')), 'Tuesday')
    isFalse(scheduleDue(woe, d('2026-08-24T07:31:00')), 'one minute off')
    isFalse(scheduleDue(woe, d('2026-08-23T07:30:00')), 'Sunday')
  })

  group('Schedules: catching up what a downtime swallowed (lastMissedSlot)')

  await check('a cron slot inside the gap is found, the newest one when there are several', () => {
    const nightly = { schedule_kind: 'cron', schedule: '0 3 * * *' }
    const from = d('2026-08-24T22:00:00').getTime()
    const to = d('2026-08-25T06:15:30').getTime()
    equal(lastMissedSlot(nightly, from, to)?.toISOString(), d('2026-08-25T03:00:00').toISOString(), 'the 03:00 slot')
    const hourly = { schedule_kind: 'cron', schedule: '30 * * * *' }
    equal(lastMissedSlot(hourly, from, to)?.toISOString(), d('2026-08-25T05:30:00').toISOString(), 'the NEWEST of eight missed slots, not the first')
  })
  await check('the minute of the last tick and the current minute are both excluded', () => {
    const hourly = { schedule_kind: 'cron', schedule: '30 * * * *' }
    equal(lastMissedSlot(hourly, d('2026-08-25T05:30:10').getTime(), d('2026-08-25T05:45:00').getTime()), null,
      'the last tick ran in the 05:30 minute and handled it')
    equal(lastMissedSlot(hourly, d('2026-08-25T05:00:00').getTime(), d('2026-08-25T05:30:20').getTime()), null,
      'the current minute is the running tick\'s own')
    equal(lastMissedSlot(hourly, d('2026-08-25T05:00:00').getTime(), d('2026-08-25T05:31:00').getTime())?.toISOString(),
      d('2026-08-25T05:30:00').toISOString(), 'one minute later it counts as missed')
  })
  await check('weekly schedules are caught up too; one-off and manual ones never', () => {
    equal(lastMissedSlot(woe, d('2026-08-24T07:00:00').getTime(), d('2026-08-24T08:00:00').getTime())?.toISOString(),
      d('2026-08-24T07:30:00').toISOString(), 'Monday 07:30')
    equal(lastMissedSlot(woe, d('2026-08-25T07:00:00').getTime(), d('2026-08-25T08:00:00').getTime()), null, 'not on a Tuesday')
    equal(lastMissedSlot({ schedule_kind: 'einmalig', run_at: '2026-08-24T07:30:00' }, 0, Date.now()), null,
      'a one-off is due from its moment on anyway')
    equal(lastMissedSlot({ schedule_kind: 'manuell' }, 0, Date.now()), null, 'manual has no moment')
    equal(lastMissedSlot(woe, NaN, Date.now()), null, 'no last tick known → nothing to catch up')
    equal(lastMissedSlot(woe, Date.now(), Date.now() - 1000), null, 'an inverted window is empty')
  })
  await check('the catch-up window: default 6 h, empty string is "not set", 0 switches it off', () => {
    equal(catchupHours({}), 6, 'default')
    equal(catchupHours({ schedule_catchup_hours: '' }), 6, 'the settings page writes "" for an untouched field')
    equal(catchupHours({ schedule_catchup_hours: '0' }), 0, 'an explicit 0 is honoured')
    equal(catchupHours({ schedule_catchup_hours: '24' }), 24, 'a number')
    equal(catchupHours({ schedule_catchup_hours: 'abc' }), 6, 'junk falls back')
  })

  group('Schedules: cadence')

  const zwei = { ...woe, schedule_weeks: 2, schedule_anchor: '2026-08-24' }
  await check('biweekly: anchor week yes, following week no', () => {
    isTrue(scheduleDue(zwei, d('2026-08-24T07:30:00')), 'anchor week Monday')
    isTrue(scheduleDue(zwei, d('2026-08-28T07:30:00')), 'anchor week Friday')
    isFalse(scheduleDue(zwei, d('2026-08-31T07:30:00')), 'following week Monday')
    isFalse(scheduleDue(zwei, d('2026-09-04T07:30:00')), 'following week Friday')
    isTrue(scheduleDue(zwei, d('2026-09-07T07:30:00')), 'week after next')
  })
  await check('cadence counts whole weeks, even across month and year boundaries', () => {
    const ueberJahr = { ...woe, schedule_weeks: 2, schedule_anchor: '2026-12-28' }
    isTrue(scheduleDue(ueberJahr, d('2026-12-28T07:30:00')), 'anchor week (December)')
    isFalse(scheduleDue(ueberJahr, d('2027-01-04T07:30:00')), 'following week (January)')
    isTrue(scheduleDue(ueberJahr, d('2027-01-11T07:30:00')), 'two weeks later (January)')
  })
  await check('three- and four-week cadences only match their own beat', () => {
    const drei = { ...zwei, schedule_weeks: 3 }
    const vier = { ...zwei, schedule_weeks: 4 }
    isTrue(scheduleDue(drei, d('2026-09-14T07:30:00')), '+3 weeks')
    isFalse(scheduleDue(drei, d('2026-09-07T07:30:00')), '+2 weeks')
    isTrue(scheduleDue(vier, d('2026-09-21T07:30:00')), '+4 weeks')
    isFalse(scheduleDue(vier, d('2026-09-14T07:30:00')), '+3 weeks')
  })
  await check('anchor week in the future is never due', () => {
    const kuenftig = { ...woe, schedule_weeks: 2, schedule_anchor: '2027-01-11' }
    isFalse(scheduleDue(kuenftig, d('2026-08-24T07:30:00')), 'before the anchor')
  })
  await check('several times on the same days: every one of them is due', () => {
    const zwei = { ...woe, schedule_time: '08:00,11:00' }
    isTrue(scheduleDue(zwei, d('2026-08-24T08:00:00')), 'Monday 08:00')
    isTrue(scheduleDue(zwei, d('2026-08-24T11:00:00')), 'Monday 11:00')
    isFalse(scheduleDue(zwei, d('2026-08-24T09:00:00')), 'in between')
    isFalse(scheduleDue(zwei, d('2026-08-25T08:00:00')), 'Tuesday is not chosen')
  })
  await check('times per weekday: each day only at its own times', () => {
    const proTag = {
      schedule_kind: 'woechentlich', schedule_weeks: 1,
      schedule_slots: '{"2":["08:00","11:00"],"3":["14:17"]}',
    }
    isTrue(scheduleDue(proTag, d('2026-08-25T08:00:00')), 'Tuesday 08:00')
    isTrue(scheduleDue(proTag, d('2026-08-25T11:00:00')), 'Tuesday 11:00')
    isTrue(scheduleDue(proTag, d('2026-08-26T14:17:00')), 'Wednesday 14:17')
    isFalse(scheduleDue(proTag, d('2026-08-26T08:00:00')), "Wednesday does not inherit Tuesday's times")
    isFalse(scheduleDue(proTag, d('2026-08-25T14:17:00')), "Tuesday does not inherit Wednesday's")
    isFalse(scheduleDue(proTag, d('2026-08-24T08:00:00')), 'Monday has no times at all')
  })
  await check('the per-day list outranks the flat columns, and the cadence still applies', () => {
    const gemischt = { ...woe, schedule_slots: '{"2":["08:00"]}' }
    isTrue(scheduleDue(gemischt, d('2026-08-25T08:00:00')), 'the slots decide')
    isFalse(scheduleDue(gemischt, d('2026-08-24T07:30:00')), 'the old columns do not run alongside')
    const alle14 = { ...gemischt, schedule_weeks: 2, schedule_anchor: '2026-08-24' }
    isTrue(scheduleDue(alle14, d('2026-08-25T08:00:00')), 'anchor week')
    isFalse(scheduleDue(alle14, d('2026-09-01T08:00:00')), 'following week')
  })
  await check('junk in the times is ignored, never guessed at', () => {
    isFalse(scheduleDue({ ...woe, schedule_time: 'irgendwann' }, d('2026-08-24T07:30:00')), 'unreadable time')
    // Unreadable slots are no statement at all, so the flat columns are still
    // the schedule — an agent must not silently stop running over a damaged
    // JSON string, and a form-saved per-day agent has no times in them anyway.
    isTrue(scheduleDue({ ...woe, schedule_slots: 'kein json' }, d('2026-08-24T07:30:00')),
      'unreadable slots leave the columns in charge')
    isFalse(scheduleDue({ schedule_kind: 'woechentlich', schedule_days: '1,3,5', schedule_slots: 'kein json' },
      d('2026-08-24T07:30:00')), 'and with no time in them, nothing runs')
    isFalse(scheduleDue({ schedule_kind: 'woechentlich', schedule_slots: '{"9":["08:00"]}' }, d('2026-08-25T08:00:00')),
      'weekday 9 does not exist')
  })
  await check('incomplete settings are never due', () => {
    isFalse(scheduleDue({ schedule_kind: 'woechentlich', schedule_time: '07:30' }, d('2026-08-24T07:30:00')), 'no days')
    isFalse(scheduleDue({ schedule_kind: 'woechentlich', schedule_days: '1' }, d('2026-08-24T07:30:00')), 'no time')
    isFalse(scheduleDue({ schedule_kind: 'einmalig' }, d('2026-08-24T07:30:00')), 'no date')
    isFalse(scheduleDue({ schedule_kind: 'einmalig', run_at: 'kein datum' }, d('2026-08-24T07:30:00')), 'broken date')
    isFalse(scheduleDue({ schedule_kind: 'cron' }, d('2026-08-24T07:30:00')), 'no expression')
  })
  await check('one-off: due from the date on and caught up later', () => {
    const ein = { schedule_kind: 'einmalig', run_at: '2026-08-24T09:00' }
    isFalse(scheduleDue(ein, d('2026-08-24T08:59:00')), 'before')
    isTrue(scheduleDue(ein, d('2026-08-24T09:00:00')), 'exactly')
    isTrue(scheduleDue(ein, d('2026-08-25T10:00:00')), 'a day later (hub was off)')
  })
  await check('cron kind uses the cron expression', () => {
    const c = { schedule_kind: 'cron', schedule: '0 6 * * 1-5' }
    isTrue(scheduleDue(c, d('2026-08-24T06:00:00')), 'Monday 06:00')
    isFalse(scheduleDue(c, d('2026-08-23T06:00:00')), 'Sunday')
  })
  await check('manual and unknown kinds are never due', () => {
    isFalse(scheduleDue({ schedule_kind: 'manuell' }, d('2026-08-24T07:30:00')), 'manual')
    isFalse(scheduleDue({ schedule_kind: 'quatsch' }, d('2026-08-24T07:30:00')), 'unknown')
    isFalse(scheduleDue({}, d('2026-08-24T07:30:00')), 'nothing set at all')
  })

  // ------------------------------------------------------------------
  group('Schedules: labeling (scheduleText)')

  await check('describes every kind intelligibly', () => {
    contains(scheduleText(zwei), 'every 2 weeks', 'n-weekly')
    contains(scheduleText(zwei), 'Mon, Wed, Fri', 'weekdays')
    contains(scheduleText(zwei), '07:30', 'time')
    contains(scheduleText(woe), 'weekly', 'simply weekly')
    contains(scheduleText({ schedule_kind: 'einmalig', run_at: '2026-08-24T09:00' }), '2026-08-24', 'date')
    equal(scheduleText({ schedule_kind: 'manuell' }), 'manual', 'manual')
    contains(scheduleText({ schedule_kind: 'cron', schedule: '0 6 * * *' }), '0 6 * * *', 'cron')
  })
  await check('all seven weekdays every week read "daily"', () => {
    const alle = { ...woe, schedule_days: '1,2,3,4,5,6,0' }
    equal(scheduleText(alle), 'daily at 07:30', 'all days every week = daily')
    const alleOhneTakt = { ...alle, schedule_weeks: undefined }
    equal(scheduleText(alleOhneTakt), 'daily at 07:30', 'missing interval means every week')
  })
  await check('all days with a multi-week interval keep the day list', () => {
    const alleZwei = { ...woe, schedule_days: '0,1,2,3,4,5,6', schedule_weeks: 2, schedule_anchor: '2026-08-24' }
    contains(scheduleText(alleZwei), 'every 2 weeks', 'cadence kept')
    contains(scheduleText(alleZwei), 'Sun', 'days still listed')
    contains(scheduleText(alleZwei), 'Mon', 'days still listed')
  })
  await check('stays readable with incomplete settings', () => {
    const t = scheduleText({ schedule_kind: 'woechentlich' })
    isTrue(typeof t === 'string' && t.length > 0, 'returns text instead of throwing')
  })
  await check('several times are all named, on one line', () => {
    const zwei = { ...woe, schedule_time: '08:00,11:00' }
    contains(scheduleText(zwei), '08:00, 11:00', 'both times')
    contains(scheduleText(zwei), 'Mon, Wed, Fri', 'days unchanged')
    equal(scheduleText({ ...woe, schedule_days: '0,1,2,3,4,5,6', schedule_time: '06:00,18:00' }),
      'daily at 06:00, 18:00', 'all seven days every week stays "daily"')
  })
  await check('different times per day are listed per day', () => {
    const proTag = { schedule_kind: 'woechentlich', schedule_weeks: 1,
      schedule_slots: '{"3":["14:17"],"2":["08:00","11:00"]}' }
    const txt = scheduleText(proTag)
    contains(txt, 'Tue 08:00, 11:00', 'Tuesday with both its times')
    contains(txt, 'Wed 14:17', 'Wednesday with its own')
    isTrue(txt.indexOf('Tue') < txt.indexOf('Wed'), 'the week is read in its own order, not in the JSON key order')
  })

  // ------------------------------------------------------------------
  group('Schedules: the two storages become one shape (weeklySlots)')

  await check('the flat columns give every chosen day the same times', () => {
    const s = weeklySlots({ schedule_days: '5,1', schedule_time: '11:00,08:00' })
    equal(s.length, 2, 'two days')
    equal(s[0].day, 1, 'Monday first — the order a week is read in')
    equal(s[0].times.join(','), '08:00,11:00', 'times sorted')
    equal(s[1].times.join(','), '08:00,11:00', 'the same on the second day')
    isTrue(slotsUniform(s), 'and that is the uniform case')
  })
  await check('schedule_slots gives every day its own', () => {
    const s = weeklySlots({ schedule_days: '1', schedule_time: '07:30', schedule_slots: '{"2":["08:00"],"3":["14:17"]}' })
    equal(s.map(x => x.day).join(','), '2,3', 'the slots decide which days')
    isFalse(slotsUniform(s), 'different times are not uniform')
  })
  await check('nothing usable is an empty schedule, not a crash', () => {
    equal(weeklySlots({}).length, 0, 'empty agent')
    equal(weeklySlots({ schedule_days: '1' }).length, 0, 'days without a time')
    equal(weeklySlots({ schedule_time: '08:00' }).length, 0, 'time without a day')
    equal(weeklySlots({ schedule_slots: '{}' }).length, 0, 'empty slots')
    isFalse(slotsUniform([]), 'and an empty schedule is not "uniform"')
  })
  await check('splitTimes keeps times, drops the rest, sorts and deduplicates', () => {
    equal(splitTimes('11:00, 08:00 ,11:00').join(','), '08:00,11:00', 'string')
    equal(splitTimes(['08:00', 'bald', '', '25:00', '08:61']).join(','), '08:00', 'list')
    equal(splitTimes(null).length, 0, 'nothing')
  })

  // ------------------------------------------------------------------
  group('Form data (parseForm)')

  await check('repeated fields additionally land in <name>_list', () => {
    const b = parseForm('schedule_days=1&schedule_days=3&schedule_days=5')
    equal(b.schedule_days_list.length, 3, 'number of days')
    equal(b.schedule_days_list.join(','), '1,3,5', 'order preserved')
  })
  await check('single values stay single values', () => {
    const b = parseForm('name=hallo&zahl=42')
    equal(b.name, 'hallo', 'name')
    equal(b.zahl, '42', 'zahl')
  })
  await check('empty body yields an empty object', () => {
    equal(Object.keys(parseForm('')).length, 0, 'field count')
  })
  await check('percent encoding and plus signs are decoded', () => {
    const b = parseForm('text=Hallo+Welt%21&pfad=%2Ftmp%2Fa+b')
    equal(b.text, 'Hallo Welt!', 'text')
    equal(b.pfad, '/tmp/a b', 'path')
  })
  await check('empty field is preserved (not undefined)', () => {
    const b = parseForm('leer=&x=1')
    equal(b.leer, '', 'empty field')
  })

  // ------------------------------------------------------------------
  group('Repo choice cookie (web-helpers)')

  await check('cookieRepo reads the freilauf_repo value out of the Cookie header', () => {
    equal(cookieRepo({ headers: { cookie: 'freilauf_repo=7' } }), 7, 'bare')
    equal(cookieRepo({ headers: { cookie: 'other=1; freilauf_repo=7' } }), 7, 'among other cookies')
    equal(cookieRepo({ headers: { cookie: 'other=1; freilauf_repo=7; x=y' } }), 7, 'with a trailing cookie')
    equal(cookieRepo({ headers: { cookie: 'freilauf_repo=abc' } }), null, 'non-numeric value')
    equal(cookieRepo({ headers: { cookie: 'freilauf_repo=' } }), null, 'empty value')
    equal(cookieRepo({ headers: {} }), null, 'no Cookie header at all')
  })
  await check('rememberRepo writes a long-lived freilauf_repo cookie', () => {
    let gesetzt = null
    rememberRepo({ setHeader: (k, v) => { gesetzt = [k, v] } }, 3)
    equal(gesetzt[0], 'set-cookie', 'header name')
    contains(gesetzt[1], 'freilauf_repo=3', 'value')
    contains(gesetzt[1], 'Max-Age=31536000', 'long-lived — the choice stays until it is changed')
    contains(gesetzt[1], 'Path=/', 'valid on every page')
  })
  await check('requestRepo reads an explicit ?repo= off the request', () => {
    equal(requestRepo({ url: '/?repo=7' }), 7, 'on the overview')
    equal(requestRepo({ url: '/runs/abc-123?repo=7' }), 7, 'on a page that belongs to one repo')
    equal(requestRepo({ url: '/agents/edit?id=4&repo=7' }), 7, 'among other parameters')
    equal(requestRepo({ url: '/settings' }), null, 'no query at all')
    equal(requestRepo({ url: '/?status=running' }), null, 'a query without repo')
    equal(requestRepo({ url: '/?repo=' }), null, 'empty value')
    equal(requestRepo({ url: '/?repo=abc' }), null, 'non-numeric value')
    equal(requestRepo({ url: '/?repo=-1' }), null, 'no id is negative')
    equal(requestRepo({}), null, 'no url at all')
  })

  // ------------------------------------------------------------------
  group('Text processing')

  await check('stripAnsi removes control sequences, keeps payload text', () => {
    equal(stripAnsi('\x1b[31mrot\x1b[0m'), 'rot', 'color codes')
    equal(stripAnsi('\x1b[200~eingefügt\x1b[201~'), 'eingefügt', 'bracketed paste')
    equal(stripAnsi('\x1b[2J\x1b[Hgelöscht'), 'gelöscht', 'clear screen')
  })
  await check('stripAnsi leaves umlauts and newlines untouched', () => {
    equal(stripAnsi('Ärger mit Größe\nzweite Zeile'), 'Ärger mit Größe\nzweite Zeile', 'umlauts')
  })
  await check('stripAnsi discards carriage returns, keeps newlines', () => {
    equal(stripAnsi('a\r\nb'), 'a\nb', 'CRLF')
    equal(stripAnsi('a\rb'), 'ab', 'lone CR')
  })
  await check('stripGitProgress removes git checkout and transfer progress, keeps the diagnosis', () => {
    const err = [
      'Preparing worktree (detached HEAD e4c5cf5f)',
      'Updating files:   5% (908/16971)\rUpdating files:  78% (13238/16971)',
      'Receiving objects:  50% (10/20), 1.20 MiB | 2.00 MiB/s',
      'fatal: cannot create directory "x": No space left on device',
    ].join('\n')
    equal(stripGitProgress(err), 'Preparing worktree (detached HEAD e4c5cf5f)\nfatal: cannot create directory "x": No space left on device', 'progress gone, cause kept')
  })
  await check('stripGitProgress collapses the blank lines progress leaves behind', () => {
    equal(stripGitProgress('fatal: something broke\n\nUpdating files: 100% (2/2), done.\n\n'), 'fatal: something broke', 'no trailing blank lines')
  })
  await check('stripGitProgress keeps non-progress text byte for byte', () => {
    equal(stripGitProgress("fatal: 'main' is already used by worktree at '/x'"), "fatal: 'main' is already used by worktree at '/x'", 'ordinary error')
    equal(stripGitProgress(null), '', 'null is an empty string')
  })
  await check('escapeHtml defuses exactly the five dangerous characters', () => {
    equal(escapeHtml('<b>'), '&lt;b&gt;', 'angle brackets')
    equal(escapeHtml('a & b'), 'a &amp; b', 'ampersand')
    equal(escapeHtml(`"x" 'y'`), '&quot;x&quot; &#39;y&#39;', 'quotes')
  })
  await check('escapeHtml double-escapes nothing extra and tolerates null', () => {
    equal(escapeHtml('&amp;'), '&amp;amp;', 'plain replacement, no special case')
    equal(escapeHtml(null), '', 'null')
    equal(escapeHtml(undefined), '', 'undefined')
    equal(escapeHtml('harmlos'), 'harmlos', 'unchanged text')
  })
  await check('fmtDuration formats minutes and hours', () => {
    equal(fmtDuration(0), '0 min', 'zero seconds')
    equal(fmtDuration(90), '1 min', 'one and a half minutes')
    equal(fmtDuration(3661), '1 h 1 min', 'just over an hour')
  })
  await check('fmtDuration rejects nonsense instead of showing NaN', () => {
    equal(fmtDuration(-5), '–', 'negative')
    equal(fmtDuration(NaN), '–', 'NaN')
    equal(fmtDuration(undefined), '–', 'undefined')
  })
  await check('parseDbUtc treats naive SQLite timestamps as UTC', () => {
    equal(parseDbUtc('2026-08-25 12:00:00'), Date.parse('2026-08-25T12:00:00Z'), 'space form')
    equal(parseDbUtc('2026-08-25T12:00:00Z'), Date.parse('2026-08-25T12:00:00Z'), 'already ISO')
    isTrue(Number.isNaN(parseDbUtc(null)), 'null')
    isTrue(Number.isNaN(parseDbUtc('')), 'empty')
  })
  await check('fmtRelativeTime picks the unit and follows the UI locale', () => {
    const now = Date.parse('2026-08-25T12:00:00Z')
    equal(fmtRelativeTime(now, now, 'en'), 'now', 'zero seconds')
    equal(fmtRelativeTime(now - 4000, now, 'en'), '4 seconds ago', 'seconds, English')
    equal(fmtRelativeTime(now - 4000, now, 'de'), 'vor 4 Sekunden', 'seconds, German')
    equal(fmtRelativeTime(now - 60_000, now, 'en'), '1 minute ago', 'one minute')
    equal(fmtRelativeTime(now - 4 * 60_000, now, 'de'), 'vor 4 Minuten', 'minutes, German')
    equal(fmtRelativeTime(now - 2 * 3600_000, now, 'en'), '2 hours ago', 'hours')
    equal(fmtRelativeTime(now - 86400_000, now, 'en'), 'yesterday', 'one day, auto numeric')
    equal(fmtRelativeTime(NaN, now, 'en'), '–', 'invalid then')
  })
  await check('fmtRelativeTime also looks forward — a planned run starts, it did not start', () => {
    const now = Date.parse('2026-08-25T12:00:00Z')
    equal(fmtRelativeTime(now + 20 * 60_000, now, 'en'), 'in 20 minutes', 'minutes ahead')
    equal(fmtRelativeTime(now + 20 * 60_000, now, 'de'), 'in 20 Minuten', 'minutes ahead, German')
    equal(fmtRelativeTime(now + 3 * 3600_000, now, 'en'), 'in 3 hours', 'hours ahead')
    equal(fmtRelativeTime(now + 86400_000, now, 'en'), 'tomorrow', 'one day ahead, auto numeric')
  })
  await check('fmtDateTime is a locale date-time, not a relative phrase', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    const de = fmtDateTime(ms, 'de')
    isTrue(de.includes('25.08.2026'), 'German date: ' + de)
    isTrue(/\d{2}:\d{2}:\d{2}/.test(de), 'has a clock time: ' + de)
    equal(fmtDateTime(NaN, 'en'), '', 'invalid')
  })
  await check('central format: the timezone resolves by language and by explicit choice', () => {
    equal(timezoneForLanguage('de'), 'Europe/Berlin', 'German → Berlin')
    equal(timezoneForLanguage('zh'), 'Asia/Shanghai', 'Chinese → Shanghai')
    equal(timezoneForLanguage('en'), null, 'English names no zone → server default')
    equal(timezoneForLanguage('xx'), null, 'unknown language names no zone')
    isTrue(validTz('Europe/Berlin'), 'a real IANA name is valid')
    isFalse(validTz('Mars/Olympus'), 'nonsense is not')
    isFalse(validTz(''), 'empty is not')
    isTrue(TIMEZONE_OPTIONS.includes('Europe/Berlin'), 'the settings list carries the common zones')
  })
  await check('central format: fmtClock and fmtDatePart convert to the configured zone', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    setTimezone('Europe/Berlin')
    equal(fmtClock(ms), '14:00', 'Berlin is UTC+2 in August')
    equal(fmtDatePart(ms), '25.08.', 'the date part travels with the zone')
    setTimezone('America/New_York')
    equal(fmtClock(ms), '08:00', 'New York is UTC-4 in August')
    setTimezone('')                            // back to auto
    equal(fmtClock(NaN), '', 'invalid ms is empty')
    equal(fmtDatePart(NaN), '', 'invalid ms is empty')
  })
  await check('central format: fmtDateTime and fmtDbUtc follow the configured zone', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    setTimezone('Europe/Berlin')
    const de = fmtDateTime(ms, 'de')
    isTrue(de.includes('25.08.2026') && de.includes('14:00'), 'Berlin afternoon, German: ' + de)
    equal(fmtDbUtc('2026-08-25 12:00:00'), fmtDateTime(ms), 'DB UTC string == the instant')
    equal(fmtDbUtc(''), '', 'empty DB stamp')
    setTimezone('')
  })
  await check('central format: numbers and percentages follow the UI locale', async () => {
    const { setLanguage } = await import('../server/i18n.mjs')
    setLanguage('de')
    equal(fmtNum(1234.5, { maximumFractionDigits: 1 }), '1.234,5', 'German thousands+decimal')
    equal(fmtPercent(78.5), '78,5 %', 'German percentage')
    equal(fmtPercent(null), '?', 'missing stays a question mark')
    setLanguage('en')
    equal(fmtNum(1234.5, { maximumFractionDigits: 1 }), '1,234.5', 'English thousands+decimal')
    equal(fmtPercent(78.5), '78.5 %', 'English percentage')
    setLanguage('en')
  })
  await check('central format: tzAbbrev names the configured zone', () => {
    const ms = Date.parse('2026-08-25T12:00:00Z')
    setTimezone('Europe/Berlin')
    isTrue(String(tzAbbrev(ms)).length > 0, 'a Berlin summer stamp has an abbreviation')
    setTimezone('')
  })
  await check('kurzid returns the first UUID block', () => {
    equal(kurzid('1d005159-78bd-4cc1-a889-07617871af2e'), '1d005159', 'UUID')
  })

  // ------------------------------------------------------------------
  group('Quota gate')

  // QUOTA_PATH is read when the module loads — import freshly for each fixture
  // (the query suffix bypasses the module cache).
  const quotaMit = async (inhalt, nr) => {
    const pfad = join(sandkasten, `quota${nr}.json`)
    if (inhalt !== null) writeFileSync(pfad, inhalt)
    process.env.FREILAUF_QUOTA_JSON = pfad
    return import(`../server/quota.mjs?fixture=${nr}`)
  }

  await check('reads percentages and reset time', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 91, resets_at: 1800000000 }, seven_day: { used_percentage: 10 },
    }), 1)
    const q = claudeQuota()
    equal(q.five, 91, '5-hour value')
    equal(q.seven, 10, '7-day value')
    isTrue(typeof q.resets_at === 'string' && q.resets_at.includes('T'), 'reset as ISO time')
  })
  await check('float artifacts in used_percentage are rounded to one decimal', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 28.000000000000004 }, seven_day: { used_percentage: 32 }, seven_day_fable: { used_percentage: 35.0 },
    }), 8)
    const q = claudeQuota()
    equal(q.five, 28, '5h float artifact rounded')
    equal(q.seven_general, 32, '7d stays clean')
    equal(q.seven_fable, 35, 'fable week stays clean')
    equal(q.seven, 35, 'gate value is the rounded maximum')
  })
  await check('both 7-day windows are reported; the gate value is the higher one', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 10 }, seven_day_fable: { used_percentage: 42 },
    }), 2)
    const q = claudeQuota()
    equal(q.seven_general, 10, 'general week')
    equal(q.seven_fable, 42, 'fable week')
    equal(q.seven, 42, 'the fuller window is the binding one')
  })
  await check('a week claude does not report at all stays null', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 5 }, seven_day_fable: { used_percentage: 35 },
    }), 7)
    const q = claudeQuota()
    equal(q.seven_general, null, 'no general week in the file')
    equal(q.seven_fable, 35, 'fable week')
    equal(q.seven, 35, 'gate value comes from the only window there is')
  })
  await check('missing file blocks nothing (all null)', async () => {
    const { claudeQuota, claudeGateBlocked } = await quotaMit(null, 3)
    const q = claudeQuota()
    equal(q.five, null, '5h')
    equal(q.seven, null, '7d')
    isFalse(claudeGateBlocked(q).blocked, 'gate stays open')
  })
  await check('broken JSON blocks nothing (all null)', async () => {
    const { claudeQuota } = await quotaMit('{kein json', 4)
    equal(claudeQuota().five, null, '5h')
  })
  await check('thresholds: 5h from 90 %, 7d from 95 %', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 5)
    isFalse(claudeGateBlocked({ five: 89, seven: 0 }).blocked, '89 % passes')
    isTrue(claudeGateBlocked({ five: 90, seven: 0 }).blocked, '90 % blocks')
    isFalse(claudeGateBlocked({ five: 0, seven: 94 }).blocked, '7d 94 % passes')
    isTrue(claudeGateBlocked({ five: 0, seven: 95 }).blocked, '7d 95 % blocks')
  })
  await check('a block states a reason', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 6)
    const g = claudeGateBlocked({ five: 97, seven: 0 })
    isTrue(g.blocked && typeof g.reason === 'string' && g.reason.length > 0, 'reason present')
  })

  // ------------------------------------------------------------------
  group('Which 7-day window binds: the general one always, a per-model one only for that model')

  // The bug: `seven` was the MAXIMUM of every weekly window, so a Fable week at
  // 96 % deferred a run on Sonnet — a window that run does not draw from at all.
  // The general week binds everything; a scoped one binds its own model.
  const quotaWindows = {
    five: 3, resets_at: '2026-08-29T12:00:00.000Z',
    seven: 96, seven_general: 40, seven_resets_at: '2026-08-30T06:00:00.000Z',
    weekly_scoped: [{ label: 'Fable', pct: 96, resets_at: '2026-08-30T05:00:00.000Z' }],
  }

  await check('the model identifier decides, in every spelling it comes in', async () => {
    const { windowAppliesToModel } = await quotaMit('{}', 12)
    isTrue(windowAppliesToModel('Fable', 'fable'), 'the alias')
    isTrue(windowAppliesToModel('Fable', 'claude-fable-5'), 'the full identifier')
    isTrue(windowAppliesToModel('Claude Fable 5', 'fable'), "a label that spells the vendor's name out")
    isFalse(windowAppliesToModel('Fable', 'claude-sonnet-5'), 'a different model')
    isFalse(windowAppliesToModel('Opus', 'claude-fable-5'), 'and the other way round')
    isTrue(windowAppliesToModel('Fable', ''), 'no model at all: conservative, every window binds')
    isTrue(windowAppliesToModel('Fable', null), 'and null is no model either')
    isTrue(windowAppliesToModel('7d', 'claude-sonnet-5'),
      'a label that names no model cannot be ruled out, so it binds')
  })

  await check('a full per-model week defers that model and nothing else', async () => {
    const { claudeGateBlocked, sevenFor } = await quotaMit('{}', 13)
    equal(sevenFor(quotaWindows, 'claude-fable-5'), 96, 'the fable run sees its own week')
    equal(sevenFor(quotaWindows, 'claude-sonnet-5'), 40, 'the sonnet run sees the general one')
    isTrue(claudeGateBlocked(quotaWindows, 'fable').blocked, 'fable is deferred')
    isFalse(claudeGateBlocked(quotaWindows, 'claude-sonnet-5').blocked, 'sonnet starts')
    isTrue(claudeGateBlocked(quotaWindows).blocked,
      'without a model every window binds — the run may be on the CLI default')
  })

  await check('the general week defers every model', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 14)
    const q = { ...quotaWindows, seven: 97, seven_general: 97 }
    isTrue(claudeGateBlocked(q, 'claude-sonnet-5').blocked, 'sonnet')
    isTrue(claudeGateBlocked(q, 'fable').blocked, 'fable')
  })

  await check('the block names the window and hands out ITS reset time', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 15)
    const g = claudeGateBlocked(quotaWindows, 'fable')
    isTrue(/Fable/.test(g.reason), `the reason names the window: ${g.reason}`)
    equal(g.resets_at, '2026-08-30T05:00:00.000Z', "the blocking window's own reset, not the 5-hour one")
    const f = claudeGateBlocked({ ...quotaWindows, five: 99 }, 'claude-sonnet-5')
    equal(f.resets_at, '2026-08-29T12:00:00.000Z', 'a 5-hour block hands out the 5-hour reset')
  })

  await check('only a claude run is measured against claude windows', async () => {
    const { sevenForRun } = await quotaMit('{}', 16)
    equal(sevenForRun({ harness: 'claude', model: 'claude-sonnet-5' }, quotaWindows), 40, 'claude/sonnet')
    equal(sevenForRun({ harness: 'claude', model: 'fable' }, quotaWindows), 96, 'claude/fable')
    equal(sevenForRun({ harness: 'hermes', model: 'deepseek/deepseek-v4' }, quotaWindows), 96,
      'another harness: its model says nothing about these windows, so nothing is filtered out')
  })

  await check('quotaFullWindow names the window that is full and binds the run', async () => {
    const { quotaFullWindow } = await quotaMit('{}', 20)
    // 5-hour window full: it binds every claude run and comes first.
    equal(JSON.stringify(quotaFullWindow({ five: 100, resets_at: 'R5', weekly_scoped: [] }, 'claude-sonnet-5')),
      '{"label":"5h","pct":100,"resets_at":"R5"}', '5 h full')
    // A 7-day window full: the run's own model's window, named like the panel.
    equal(JSON.stringify(quotaFullWindow({
      ...quotaWindows, five: 0,
      weekly_scoped: [{ label: 'Fable', pct: 100, resets_at: 'R-F' }],
    }, 'fable')), '{"label":"7d Fable","pct":100,"resets_at":"R-F"}', 'fable week full, named')
    // The general week full, for a run whose own week is fine.
    const general = { ...quotaWindows, five: 0, seven_general: 100, weekly_scoped: [{ label: 'Fable', pct: 40, resets_at: 'X' }] }
    equal(JSON.stringify(quotaFullWindow(general, 'claude-sonnet-5')),
      '{"label":"7d","pct":100,"resets_at":"2026-08-30T06:00:00.000Z"}', 'general week, labelled 7d')
    // A window full that is NOT this run's — sonnet is not affected by fable.
    const fremd = { ...quotaWindows, five: 0, seven_general: 40, weekly_scoped: [{ label: 'Fable', pct: 100, resets_at: 'R-F' }] }
    equal(quotaFullWindow(fremd, 'claude-sonnet-5'), null, 'somebody else\u2019s window is not the run\u2019s')
    // Nothing binds at 100 % → null (the run is not flagged).
    equal(quotaFullWindow({ ...quotaWindows, five: 0, seven_general: 40 }, 'claude-sonnet-5'), null, 'nothing full')
  })

  await check('an object carrying no window list is taken at its word', async () => {
    const { sevenFor, claudeGateBlocked } = await quotaMit('{}', 17)
    equal(sevenFor({ five: 0, seven: 88 }, 'fable'), 88, 'the number it has is the answer')
    isTrue(claudeGateBlocked({ five: 0, seven: 95 }, 'claude-sonnet-5').blocked, 'and it still gates')
  })

  await check('thresholds are configurable per window; defaults stay 90/95', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 18)
    const q = { five: 80, seven: 88 }
    isFalse(claudeGateBlocked(q).blocked, 'defaults: 80 % and 88 % pass')
    isTrue(claudeGateBlocked(q, null, { five: 75, seven: 90 }).blocked, 'a 5 h threshold of 75 blocks the 80 %')
    isFalse(claudeGateBlocked(q, null, { five: 85, seven: 90 }).blocked, 'a 5 h threshold of 85 lets the 80 % pass')
    isTrue(claudeGateBlocked(q, null, { five: 90, seven: 85 }).blocked, 'a 7 d threshold of 85 blocks the 88 %')
  })

  await check('the fable week has its own threshold', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 19)
    const q = {
      five: 0, seven: 94, seven_general: 90, seven_resets_at: 'Y',
      weekly_scoped: [{ label: 'Fable', pct: 92, resets_at: 'X' }],
    }
    isFalse(claudeGateBlocked(q, 'fable').blocked, 'defaults: fable 92 % passes')
    const g = claudeGateBlocked(q, 'fable', { fable: 90 })
    isTrue(g.blocked, 'fable 92 % blocks against its own threshold of 90')
    contains(g.reason, 'Fable', 'the reason names the fable window')
    equal(g.resets_at, 'X', 'the fable window hands out its own reset time')
    isFalse(claudeGateBlocked(q, 'claude-sonnet-5', { fable: 90 }).blocked,
      'a run on another model is not held back by the fable threshold')
  })

  await check('deepseek gate: the account verdict, low USD, and no signal', async () => {
    const echt = global.fetch
    process.env.DEEPSEEK_API_KEY = 'ds-test'
    const ds = (nr) => import(`../server/quota.mjs?ds=${nr}`)
    try {
      const { deepseekGateBlocked: g1 } = await ds(1)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: false, balance_infos: [{ currency: 'USD', total_balance: '50' }],
      }) })
      const b = await g1(2)
      isTrue(b.blocked, 'available=false blocks even with plenty of money')
      contains(b.reason, 'unavailable', 'the reason names the verdict')

      const { deepseekGateBlocked: g2 } = await ds(2)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1' }],
      }) })
      const low = await g2(2)
      isTrue(low.blocked, 'USD 1 below the minimum of 2 blocks')
      contains(low.reason, 'DeepSeek', 'the reason names the provider')

      const { deepseekGateBlocked: g3 } = await ds(3)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '7000' }],
      }) })
      const cny = await g3(2)
      isFalse(cny.blocked, 'a CNY-only account reports no USD — no signal, no block')

      const { deepseekGateBlocked: g4 } = await ds(4)
      global.fetch = async () => ({ ok: true, json: async () => ({
        is_available: true, balance_infos: [{ currency: 'USD', total_balance: '7' }],
      }) })
      const ok = await g4(2)
      isFalse(ok.blocked, 'USD 7 above the minimum passes')

      const { deepseekGateBlocked: g5 } = await ds(5)
      delete process.env.DEEPSEEK_API_KEY
      isFalse((await g5(2)).blocked, 'without a key the gate stays open')
    } finally {
      global.fetch = echt
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  await check('budgetGate routes by provider and honours the on/off switches', async () => {
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
      isTrue(!!ds && /DeepSeek/.test(ds.reason), 'a deepseek run is gated by the DeepSeek balance')
      const or = await budgetGate('opencode', 'openrouter/x', 'openrouter')
      isTrue(!!or && /OpenRouter/.test(or.reason), 'an openrouter run by the OpenRouter balance')
      const fb = await budgetGate('opencode', 'whatever', null)
      isTrue(!!fb && /OpenRouter/.test(fb.reason), 'no provider falls back to the OpenRouter gate')
      isFalse(await budgetGate('opencode', 'x', 'opencode-zen'),
        'opencode-zen reports no balance — no signal, no block')
      const claude = await budgetGate('claude', 'claude-sonnet-5')
      isTrue(!!claude && /Claude quota/.test(claude.reason), 'a claude run by the claude gate')
      const cursor = await budgetGate('cursor', 'auto')
      isTrue(!!cursor && /Cursor/.test(cursor.reason), 'a cursor run by the cursor gate')

      setSetting('deepseek_gate_on', '0')
      isFalse(await budgetGate('hermes', 'deepseek/deepseek-v4', 'deepseek'),
        'switched off, the DeepSeek gate cannot block')
      setSetting('openrouter_gate_on', '0')
      isFalse(await budgetGate('opencode', 'x', null),
        'switched off, the OpenRouter gate cannot block')
      setSetting('claude_gate_on', '0')
      isFalse(await budgetGate('claude', 'claude-sonnet-5'),
        'switched off, the claude gate cannot block even a full quota')
      setSetting('cursor_gate_on', '0')
      isFalse(await budgetGate('cursor', 'auto'),
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

  await check('budgetGate asks the coding agent first, the provider second, OpenRouter last', async () => {
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
      isTrue(!!claude && /Claude quota/.test(claude.reason),
        `the claude gate answers even with a provider present (${claude?.reason})`)

      // 2. A provider that declares no gate is no signal — opencode-zen
      //    reports no balance, and "unknown" must never mean "blocked".
      isFalse(await budgetGate('opencode', 'x', 'opencode-zen'), 'a gateless provider blocks nothing')

      // 3. LEGACY_DEFAULT_GATE: a provider the hub has never heard of falls
      //    through to OpenRouter, which is where the provider-based harnesses
      //    have always been measured.
      const unbekannt = await budgetGate('opencode', 'x', 'no-such-provider')
      isTrue(!!unbekannt && /OpenRouter/.test(unbekannt.reason),
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
      isFalse(await budgetGate('unit-gate-throws', 'm'), 'a throwing gate is an open gate')

      // …and a gate that answers something useless is not an answer either.
      const stumm = { ...kaputt, id: 'unit-gate-mute', gate: { fields: [], check: async () => ({ }) } }
      if (registerPlugin(stumm, { source: 'external' }).ok) eigene.push(stumm.id)
      isFalse(await budgetGate('unit-gate-mute', 'm'), 'a block with no reason does not block')
    } finally {
      global.fetch = echt
      for (const id of eigene) unregisterPlugin(id)
      if (alt.or === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = alt.or
      if (alt.ds !== undefined) process.env.DEEPSEEK_API_KEY = alt.ds
    }
  })

  await check('cursor gate measures the included usage against its own threshold', async () => {
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
      isTrue(g.blocked, '99.5 % blocks against a threshold of 95')
      contains(g.reason, 'Cursor', 'the reason names the provider')

      const { cursorGateBlocked: g2 } = await cu(2)
      isFalse((await g2(99.9, 20)).blocked, '99.5 % passes against a threshold of 99.9')

      process.env.FREILAUF_CURSOR_AUTH = join(sandkasten, 'missing-cursor-gate-auth.json')
      const { cursorGateBlocked: g3 } = await cu(3)
      isFalse((await g3(95, 20)).blocked, 'no token → no signal → the gate stays open')
    } finally {
      global.fetch = echt
      if (alt === undefined) delete process.env.FREILAUF_CURSOR_AUTH; else process.env.FREILAUF_CURSOR_AUTH = alt
    }
  })

  // ------------------------------------------------------------------
  group('Claude usage: the account answers, the file is the fallback')

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

  await check('limits[] is mapped by group/kind, not by position', () => {
    const p = cu._parseLimits(realResponse)
    equal(p.five, 5, 'the session window is the 5-hour one')
    equal(p.seven_general, 78, 'weekly_all is the general week')
    equal(p.weekly_scoped.length, 1, 'one per-model week')
    equal(p.weekly_scoped[0].label, 'Fable', "the vendor's own display name, not a hardcoded one")
    equal(p.weekly_scoped[0].pct, 88, 'its percentage')
    isTrue(p.weekly_scoped[0].resets_at?.startsWith('2026-08-30'),
      'and its OWN reset time — the file never carried one for this window')
  })

  await check('a second scoped model needs no code change', () => {
    const p = cu._parseLimits({ limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 10, resets_at: null, scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 20, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 30, scope: { model: { display_name: 'Opus' } } },
    ] })
    equal(p.weekly_scoped.map(w => `${w.label}:${w.pct}`).join(','), 'Fable:20,Opus:30', 'both are carried')
  })

  await check('an answer without a single window is not an answer', () => {
    equal(cu._parseLimits({ limits: [] }), null, 'empty list')
    equal(cu._parseLimits({}), null, 'no limits key at all')
    equal(cu._parseLimits({ limits: [{ kind: 'session', percent: null }] }), null,
      'an entry without a percentage does not count as one')
  })

  await check('the live answer wins over the file, per field', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 3, resets_at: 1800000000 },
      seven_day: { used_percentage: 77 },
      seven_day_fable: { used_percentage: 80 },
    }), 9)
    cu._claudeLimitsSet(cu._parseLimits(realResponse))
    const q = claudeQuota()
    equal(q.five, 5, 'the stale 3 % from the file is replaced')
    equal(q.seven_general, 78, 'and the stale 77 %')
    equal(q.seven_fable, 88, 'and the 80 % that was seven hours old')
    equal(q.seven, 88, 'the gate value is the highest weekly window')
    isTrue(q.live === true, 'the answer says it came from the account')
    cu._claudeLimitsReset()
  })

  await check('what the account does not report, the file still supplies', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 42, resets_at: 1800000000 },
      seven_day: { used_percentage: 11 },
    }), 10)
    // A live answer that knows only the weekly windows — the merge is per field,
    // so the 5-hour window a status line wrote minutes ago is not thrown away.
    cu._claudeLimitsSet({ five: null, resets_at: null, seven_general: 60, seven_resets_at: null, weekly_scoped: [] })
    const q = claudeQuota()
    equal(q.five, 42, '5-hour window comes out of the file')
    equal(q.seven_general, 60, 'the week comes from the account')
    cu._claudeLimitsReset()
  })

  // Measured: these two assertions above failed in 6 of 30 suite runs, and the
  // cause was not the test. `statSync().mtimeMs` is a FLOAT with sub-millisecond
  // precision, `Date.now()` is an integer millisecond — so a quota.json written
  // inside the current millisecond carries an `at` LARGER than `now`
  // (1788443185118.0244 against 1788443185118) and won the age comparison
  // against a live answer that had just arrived. In production the status line
  // writes that file continuously while a session renders. The rule the module
  // documents is "the live answer wins outright, the newest of the rest wins
  // where it says nothing", and this pins it without depending on a clock: the
  // file's mtime is unambiguously in the future of the `now` handed in.
  await check('a file dated in the future does not beat a live answer', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 3 }, seven_day: { used_percentage: 77 },
    }), 12)
    cu._claudeLimitsSet({ five: 5, resets_at: null, seven_general: 78, seven_resets_at: null, weekly_scoped: [] })
    // A `now` an hour before the file was written — the file's mtime is then
    // newer than "now" by an hour instead of by a fraction of a millisecond.
    const q = claudeQuota(Date.now() - 3600_000)
    equal(q.five, 5, 'the account still decides the 5-hour window')
    equal(q.seven_general, 78, 'and the week')
    isTrue(q.live, 'and the answer says so')
    equal(q.five_at, null, 'a live window carries no "as of" stamp')
    cu._claudeLimitsReset()
  })

  await check('a live answer that has aged out falls back to the file', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 7 }, seven_day: { used_percentage: 12 },
    }), 11)
    // Older than the TTL: a live number an hour old is worse than the file,
    // which a running claude session at least keeps moving.
    cu._claudeLimitsSet(cu._parseLimits(realResponse), Date.now() - 3600_000)
    const q = claudeQuota()
    equal(q.five, 7, 'the file decides again')
    equal(q.seven_general, 12, 'in both windows')
    isFalse(q.live, 'and the answer no longer claims to be live')
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

  await check('a per-model week the account stops reporting keeps its last live value', async () => {
    const { claudeQuota } = await quotaMit(fileWithFable(80, 45), 12)
    cu._claudeLimitsReset()
    cu._claudeLimitsSet(liveWithFable(88))
    equal(claudeQuota().seven_fable, 88, 'the account answered')
    // No scoped window in the answer at all: a 429, an expired token, or simply
    // a moment at which the account reports none.
    cu._claudeLimitsSet(liveWithoutFable)
    const q = claudeQuota()
    equal(q.seven_fable, 88, 'the bar stands still instead of dropping to the 45-hour-old 80 %')
    equal(q.seven, 88, 'and the gate keeps reading the higher window')
    equal(q.weekly_scoped[0].stale, true, 'it is marked as not-current, so the panel can say when it was read')
    cu._claudeLimitsReset()
  })

  await check('the newer reading wins — the file too, when it is the newer one', async () => {
    const { claudeQuota } = await quotaMit(fileWithFable(92, 0), 13)
    cu._claudeLimitsReset()
    cu._claudeLimitsSet(liveWithFable(88), Date.now() - 3 * 3600_000)   // remembered, three hours old
    equal(claudeQuota().seven_fable, 92, 'a file written just now beats a live reading from this morning')
    cu._claudeLimitsReset()
  })

  await check('a remembered window is forgotten once it has rolled over', async () => {
    const { claudeQuota } = await quotaMit(fileWithFable(80, 45), 14)
    cu._claudeLimitsReset()
    cu._claudeLimitsSet({
      ...liveWithoutFable,
      weekly_scoped: [{ label: 'Fable', pct: 88, resets_at: new Date(Date.now() - 3600_000).toISOString() }],
    }, Date.now() - 2 * 3600_000)
    equal(claudeQuota().seven_fable, 80, 'knowledge from before the reset is worthless, not conservative')
    cu._claudeLimitsReset()
  })

  await check('the remembered windows survive a restart', async () => {
    cu._claudeLimitsReset()
    cu._claudeLimitsSet(liveWithFable(88))
    // A second instance of the module is a restarted hub: nothing in memory, and
    // the file it wrote is all there is.
    const restarted = await import('../server/claude-usage.mjs?restart=1')
    equal(restarted.rememberedScoped().find(w => w.label === 'Fable')?.pct, 88,
      'the account’s last answer outlives the process')
    cu._claudeLimitsReset()
  })

  await check('without a credentials file nothing is fetched and nothing throws', async () => {
    const before = process.env.FREILAUF_CLAUDE_CREDENTIALS
    process.env.FREILAUF_CLAUDE_CREDENTIALS = join(sandkasten, 'no-such-credentials.json')
    // No URL is set either: were a request made anyway, this would hang or throw
    // rather than quietly pass.
    equal(await cu.refreshClaudeLimits({ force: true }), null, 'no token, no answer')
    equal(cu.claudeLimits(), null, 'and nothing cached')
    if (before === undefined) delete process.env.FREILAUF_CLAUDE_CREDENTIALS
    else process.env.FREILAUF_CLAUDE_CREDENTIALS = before
  })

  await check('an expired token is not used and is not refreshed', async () => {
    const credPath = join(sandkasten, 'expired-credentials.json')
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() - 1000 },
    }))
    const before = process.env.FREILAUF_CLAUDE_CREDENTIALS
    process.env.FREILAUF_CLAUDE_CREDENTIALS = credPath
    equal(await cu.refreshClaudeLimits({ force: true }), null, 'expired means silent')
    const after = JSON.parse(readFileSync(credPath, 'utf8'))
    equal(after.claudeAiOauth.accessToken, 'x', 'the credentials file is never written back')
    if (before === undefined) delete process.env.FREILAUF_CLAUDE_CREDENTIALS
    else process.env.FREILAUF_CLAUDE_CREDENTIALS = before
  })

  // Measured 2026-09-01: the account rate-limits this endpoint (429), and the
  // hub's answer to a failure was to keep asking every watcher pass. A failed
  // answer must start a backoff, or a polite poller becomes a hammer exactly
  // when the vendor asks for a pause.
  await check('a 429 backs off — the endpoint is not asked again right away', async () => {
    cu._claudeLimitsReset()
    const credPath = join(sandkasten, 'backoff-credentials.json')
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000 },
    }))
    const before = process.env.FREILAUF_CLAUDE_CREDENTIALS
    process.env.FREILAUF_CLAUDE_CREDENTIALS = credPath
    const echt = global.fetch
    let aufrufe = 0
    global.fetch = async () => {
      aufrufe++
      return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }
    }
    try {
      equal(await cu.refreshClaudeLimits(), null, 'a 429 is no answer')
      equal(await cu.refreshClaudeLimits(), null, 'the stale-but-usable rule keeps the answer null')
      equal(aufrufe, 1, 'one 429, then the backoff keeps the endpoint alone')
      equal(cu.claudeLimits(), null, 'a failure is not cached as one')
    } finally {
      global.fetch = echt
      if (before === undefined) delete process.env.FREILAUF_CLAUDE_CREDENTIALS
      else process.env.FREILAUF_CLAUDE_CREDENTIALS = before
      cu._claudeLimitsReset()
    }
  })

  await check('Retry-After is honoured and a success clears the backoff', async () => {
    cu._claudeLimitsReset()
    const credPath = join(sandkasten, 'backoff-credentials.json')
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000 },
    }))
    const before = process.env.FREILAUF_CLAUDE_CREDENTIALS
    process.env.FREILAUF_CLAUDE_CREDENTIALS = credPath
    const echt = global.fetch
    let aufrufe = 0
    let antwort = () => ({ ok: false, status: 429, headers: { get: (h) => String(h).toLowerCase() === 'retry-after' ? '600' : null }, json: async () => ({}) })
    global.fetch = async () => { aufrufe++; return antwort() }
    try {
      await cu.refreshClaudeLimits()
      await cu.refreshClaudeLimits()
      equal(aufrufe, 1, 'the vendor said wait 600 s, and that outranks the own backoff')
      antwort = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => realResponse })
      const live = await cu.refreshClaudeLimits({ force: true })
      equal(live?.five, 5, 'a forced refresh goes through the backoff and succeeds')
      equal(aufrufe, 2)
      cu._claudeLimitsSet(cu._parseLimits(realResponse), Date.now() - 3600_000)   // cache aged
      await cu.refreshClaudeLimits()
      equal(aufrufe, 3, 'and the success cleared the backoff: the next expired cache asks again')
    } finally {
      global.fetch = echt
      if (before === undefined) delete process.env.FREILAUF_CLAUDE_CREDENTIALS
      else process.env.FREILAUF_CLAUDE_CREDENTIALS = before
      cu._claudeLimitsReset()
    }
  })

  // The jump the merge now prevents, this time for the GENERAL windows: a
  // rate-limited stretch dropped the 5-hour bar to whatever quota.json last
  // held and back, on every gap in the live answer.
  await check('a rate-limited stretch keeps the last live answer standing', async () => {
    const pfad = join(sandkasten, 'quota21.json')
    writeFileSync(pfad, JSON.stringify({ five_hour: { used_percentage: 3 }, seven_day: { used_percentage: 77 } }))
    const alt = new Date(Date.now() - 3600_000)
    utimesSync(pfad, alt, alt)   // a file nobody has rewritten for an hour
    process.env.FREILAUF_QUOTA_JSON = pfad
    const { claudeQuota } = await import('../server/quota.mjs?fixture=21')
    cu._claudeLimitsReset()
    cu._claudeLimitsSet({ five: 5, resets_at: null, seven_general: 78, seven_resets_at: null, weekly_scoped: [] },
      Date.now() - 300_000)   // last live answer, five minutes ago
    const q = claudeQuota()
    equal(q.five, 5, 'the 5-hour bar stands instead of dropping to the hour-old file')
    equal(q.seven_general, 78, 'the week too')
    isTrue(q.five_at > 0, 'and says when the 5-hour value was read')
    isTrue(q.seven_general_at > 0, 'and when the week was read')
    isFalse(q.live, 'while honestly no longer claiming to be live')
    cu._claudeLimitsReset()
  })

  await check('a file rewritten after the last live answer wins — the status line keeps it moving', async () => {
    const pfad = join(sandkasten, 'quota22.json')
    writeFileSync(pfad, JSON.stringify({ five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 11 } }))
    process.env.FREILAUF_QUOTA_JSON = pfad
    const { claudeQuota } = await import('../server/quota.mjs?fixture=22')
    cu._claudeLimitsReset()
    cu._claudeLimitsSet({ five: 5, resets_at: null, seven_general: 78, seven_resets_at: null, weekly_scoped: [] },
      Date.now() - 300_000)
    const q = claudeQuota()
    equal(q.five, 42, 'a status line wrote this window after the account last answered')
    equal(q.seven_general, 11, 'in both windows')
    isTrue(q.five_at > 0, 'a file-sourced value carries its as-of time too')
    cu._claudeLimitsReset()
  })

  // ------------------------------------------------------------------
  group('Platform suffix in the prompt (platformSuffix)')

  const { platformSuffix } = await import('../server/runner.mjs')
  const lauf = { id: 'abc-123', workdir_effective: '/pfad/zum/worktree', expected_minutes: 42 }

  await check('fills all placeholders of the default template', () => {
    const t = platformSuffix(lauf, 'Lege einen neuen Branch an.', {})
    contains(t, 'abc-123', 'run ID')
    contains(t, '/pfad/zum/worktree', 'working directory')
    contains(t, '42 min', 'expectation')
    contains(t, 'Lege einen neuen Branch an.', 'branch rule')
    isFalse(t.includes('{run_id}') || t.includes('{workdir}') || t.includes('{branch_rule}')
      || t.includes('{expected_minutes}'), 'no placeholder is left over')
  })
  await check('names the agent\'s report-back channels', () => {
    const t = platformSuffix(lauf, 'egal', {})
    contains(t, 'fl-report done', 'completion report')
    contains(t, 'fl-report help', 'call for help')
  })
  await check('the operator\'s own rules are an ADDITION and cannot delete the finishing command', () => {
    // This field used to REPLACE the whole block. It is called a suffix, it
    // starts out empty and it looks like a free notepad — so the day somebody
    // wrote their working rules into it, every prompt on this hub silently lost
    // "at the end always fl-report done". The runs kept working and kept not
    // reporting; one of them held up the queue for a day.
    const t = platformSuffix(lauf, 'REGEL', { prompt_suffix: 'Immer Tests schreiben. Lauf {run_id}.' })
    contains(t, 'Immer Tests schreiben.', 'the addition is there')
    contains(t, 'Lauf abc-123.', 'and its placeholders are filled too')
    contains(t, 'Platform rules', 'the platform rules stay')
    contains(t, 'fl-report done --file', 'and so does the finishing command')
    isTrue(t.indexOf('Immer Tests schreiben.') < t.indexOf('HOW THIS RUN ENDS'),
      'how the run ends stands last — that is what runs fail on')
  })
  await check('an empty field adds nothing at all', () => {
    const leer = platformSuffix(lauf, 'REGEL', { prompt_suffix: '   ' })
    equal(leer, platformSuffix(lauf, 'REGEL', {}), 'whitespace is not a rule')
    isFalse(leer.includes('Operator rules'), 'no empty section header')
  })
  await check('the finishing command names a concrete file outside the working directory', () => {
    // A run died of a vague instruction: "fl-report done --file <report.md>" left
    // both the path and the fact that it is mandatory to the model's judgement.
    // Now the command is copy-and-paste ready — and the file lies next to the
    // run's log, not in the worktree, which a report file would leave dirty.
    const t = platformSuffix(lauf, 'egal', {})
    contains(t, 'fl-report done --file /', 'absolute path in the command')
    contains(t, 'abc-123/report.md', 'the run\'s own report file')
    isFalse(t.includes('{report_file}'), 'placeholder is resolved')
    isFalse(t.includes(`${lauf.workdir_effective}/report.md`), 'not inside the worktree')
  })
  await check('the harness adds its own rules — even to a custom template', () => {
    // The settings field REPLACES the platform rules (that is what it is for),
    // but the harness lines describe the machine, not the operator's house
    // rules: cursor has to be told that its turn ending closes the run.
    const cu = { ...lauf, harness: 'cursor' }
    contains(platformSuffix(cu, 'egal', {}), 'cursor-agent', 'harness rules in the default template')
    contains(platformSuffix(cu, 'egal', { prompt_suffix: 'nur das hier' }), 'cursor-agent', '… and in a custom one')
    isFalse(platformSuffix({ ...lauf, harness: 'claude' }, 'egal', {}).includes('cursor-agent'),
      'other harnesses do not get cursor\'s rules')
  })
  // ------------------------------------------------------------------
  group('Repo prompt in the run prompt (repoPromptZusatz)')

  const { repoPromptZusatz } = await import('../server/runner.mjs')

  await check('no prompt adds nothing', () => {
    equal(repoPromptZusatz(null), '', 'null')
    equal(repoPromptZusatz(''), '', 'empty')
    equal(repoPromptZusatz('   \n  '), '', 'whitespace only')
  })
  await check('a prompt becomes a labeled section', () => {
    const t = repoPromptZusatz('Always write tests for this repo.')
    contains(t, 'Always write tests for this repo.', 'content is passed through verbatim')
    contains(t, 'Repository context', 'the section is labeled')
    equal(t.split('\n')[0], 'Repository context (applies to every run of this repo):', 'label line')
  })
  // ------------------------------------------------------------------
  group('Model, provider and effort arguments for the harnesses')

  const { harnessModelArgs } = await import('../server/runner.mjs')
  const cfgAus = (args) => {
    const e = args.find(a => typeof a === 'string' && a.startsWith('OPENCODE_CONFIG_CONTENT='))
    return e ? JSON.parse(e.slice('OPENCODE_CONFIG_CONTENT='.length)) : null
  }
  const paar = (args, flagge) => args[args.indexOf(flagge) + 1]

  await check('claude: model and reasoning effort as separate flags', () => {
    const { args } = harnessModelArgs({ harness: 'claude', model: 'opus', effort: 'max' })
    equal(paar(args, '--model'), 'opus', 'model')
    equal(paar(args, '--effort'), 'max', 'reasoning effort')
  })

  await check('cursor: only --model, no provider and no --effort', () => {
    // With cursor the effort level is baked INTO the ID; cursor-agent has no --effort
    // at all. A passed-through effort must therefore NOT show up as a flag here.
    const { args, fehlt } = harnessModelArgs({ harness: 'cursor', model: 'claude-opus-5-xhigh' })
    equal(paar(args, '--model'), 'claude-opus-5-xhigh', 'model verbatim')
    equal(args.includes('--effort'), false, 'no --effort')
    equal(args.includes('--provider'), false, 'no --provider')
    equal(fehlt.length, 0, 'no missing key — cursor runs on its subscription')
    // Even with an effort set on the run, the flag stays absent (legacy data, harness switch).
    const b = harnessModelArgs({ harness: 'cursor', model: 'gpt-5.4-mini-low', effort: 'high' })
    equal(b.args.includes('--effort'), false, 'effort on the run is not passed through')
  })

  await check('hermes: model bare, provider and effort separate', () => {
    const { args } = harnessModelArgs({ harness: 'hermes', provider: 'openrouter', model: 'a/b', effort: 'high' })
    equal(paar(args, '--model'), 'a/b', 'model without prefix')
    equal(paar(args, '--provider'), 'openrouter', 'provider')
    equal(paar(args, '--effort'), 'high', 'reasoning effort')
  })

  await check('opencode: provider lives in the prefix — Zen is called "opencode" there', () => {
    equal(paar(harnessModelArgs({ harness: 'opencode', provider: 'opencode-zen', model: 'hy3-free' }).args, '--model'),
      'opencode/hy3-free', 'Zen prefix')
    equal(paar(harnessModelArgs({ harness: 'opencode', provider: 'deepseek', model: 'ds' }).args, '--model'),
      'deepseek/ds', 'DeepSeek prefix')
    equal(paar(harnessModelArgs({ harness: 'opencode', provider: 'openrouter', model: 'a/b' }).args, '--model'),
      'openrouter/a/b', 'OpenRouter prefix with three parts')
  })

  await check('opencode: effort NOT as a flag but in the configuration', () => {
    const { args } = harnessModelArgs({ harness: 'opencode', provider: 'deepseek', model: 'ds', effort: 'high' })
    isFalse(args.includes('--effort'), 'no --effort (the TUI does not know it)')
    const cfg = cfgAus(args)
    // The variant only takes effect if the model is set in the same agent block.
    equal(cfg?.agent?.build?.variant, 'high', 'variant')
    equal(cfg?.agent?.build?.model, 'deepseek/ds', 'model in the same block')
  })

  await check('opencode: provider pinning and effort share ONE --env block', () => {
    const { args } = harnessModelArgs({
      harness: 'opencode', provider: 'openrouter', model: 'a/b', or_provider: 'amazon-bedrock', effort: 'low',
    })
    equal(args.filter(a => a === '--env').length, args.filter(a => typeof a === 'string' && a.includes('=')).length,
      'every --env flag has exactly one value')
    const cfg = cfgAus(args)
    equal(cfg?.provider?.openrouter?.models?.['a/b']?.options?.provider?.order?.[0], 'amazon-bedrock', 'provider')
    equal(cfg?.agent?.build?.variant, 'low', 'variant in the same JSON')
  })

  await check('without provider and effort everything stays as before', () => {
    // Regression guard for existing agents: there 'model' is a free-form string.
    const { args } = harnessModelArgs({ harness: 'opencode', model: 'openrouter/a/b' })
    equal(args.join(' '), '--model openrouter/a/b', 'passed through unchanged')
    equal(harnessModelArgs({ harness: 'claude' }).args.length, 0, 'no model, no argument at all')
  })

  // ------------------------------------------------------------------
  group('The directories outside the worktree a run was pointed at')

  const { runExternalDirs } = await import('../server/runner.mjs')

  await check('opencode is told about them as external_directory permissions', () => {
    const { args } = harnessModelArgs({ harness: 'opencode', model: 'a/b', provider: 'openrouter' },
      { externalDirs: ['/runs/xy', '/opt/fl/zusaetze'] })
    const erlaubt = cfgAus(args)?.permission?.external_directory
    equal(erlaubt?.['/runs/xy/*'], 'allow', 'the run directory, as a glob')
    equal(erlaubt?.['/opt/fl/zusaetze/*'], 'allow', 'the extra-skills directory')
    // NOT a blanket allow: what the hub laid out is reachable, the rest still asks.
    equal(erlaubt?.['*'], undefined, 'no blanket permission')
  })

  await check('a run that carries no model still gets the permission block', () => {
    // The one that used to fall off: modelArgs returned early for these two,
    // and a run that cannot write ~/agents/runs/<id>/report.md cannot finish.
    for (const run of [{ harness: 'opencode' }, { harness: 'opencode', model: 'hand/typed' }]) {
      const { args } = harnessModelArgs(run, { externalDirs: ['/runs/xy'] })
      const erlaubt = cfgAus(args)?.permission?.external_directory
      equal(erlaubt?.['/runs/xy/*'], 'allow', `model=${run.model ?? 'none'}`)
    }
    equal(cfgAus(harnessModelArgs({ harness: 'opencode', model: 'a/b', provider: 'openrouter' }).args),
      null, 'without the list nothing is written — an old caller changes nothing')
  })

  await check('runExternalDirs names the run directory, the skills and every LINKED extra', () => {
    const wurzel = mkdtempSync(join(tmpdir(), 'fl-extern-'))
    const repoPfad = join(wurzel, 'repo')
    mkdirSync(join(repoPfad, '.venv'), { recursive: true })
    writeFileSync(join(repoPfad, '.env'), 'X=1')
    const repo = {
      path: repoPfad,
      extras: [
        { path: '.venv/', mode: 'link' },     // a directory — admitted as itself
        { path: '.env', mode: 'link' },       // a file — only its directory
        { path: 'node_modules', mode: 'copy' },  // in the worktree already
        { path: 'weg/', mode: 'link' },       // never applied, cannot be resolved
      ],
    }
    const dirs = runExternalDirs({}, repo, '/runs/xy')
    isTrue(dirs.includes('/runs/xy'), 'the run directory')
    isTrue(dirs.some(d => d.endsWith('/.venv')), 'a linked directory, resolved')
    isTrue(dirs.includes(realpathSync(repoPfad)), 'a linked FILE admits its directory, not the file')
    isTrue(!dirs.some(d => d.includes('node_modules')), 'a copied extra needs nothing — it IS in the worktree')
    isTrue(!dirs.some(d => d.includes('weg')), 'an extra that is not there was not applied either')
    equal(dirs.length, new Set(dirs).size, 'deduplicated')
    isTrue(dirs.every(d => d.startsWith('/')), 'absolute only')
    rmSync(wurzel, { recursive: true, force: true })
  })

  // ------------------------------------------------------------------
  group('A prompt too long to hand over as an argument (offloadPrompt)')

  const { offloadPrompt, TASK_FILE, TASK_DIR, harnessOwnedPaths: eigenePfade } =
    await import('../server/runner.mjs')
  const langeAufgabe = 'AUFGABE '.repeat(700)   // ~5.6 KB, past opencode's 4000

  await check('a short prompt is passed through completely unchanged', () => {
    const r = offloadPrompt('opencode', '/nowhere', 'do X', 'PLATFORM')
    equal(r.taskFile, null, 'nothing written')
    equal(r.prompt, 'do X\n\nPLATFORM', 'task and platform, exactly as before')
  })

  await check('a long one leaves the task in the worktree and points at it', () => {
    const wt = mkdtempSync(join(tmpdir(), 'fl-offload-'))
    const r = offloadPrompt('opencode', wt, langeAufgabe, 'PLATFORM RULES')
    equal(r.taskFile, join(wt, TASK_FILE), 'written inside the WORKTREE — no permission question')
    equal(readFileSync(r.taskFile, 'utf8'), langeAufgabe, 'the task, byte for byte')
    isTrue(r.prompt.includes(TASK_FILE), 'the launch prompt names the file')
    isTrue(r.prompt.trimEnd().endsWith('PLATFORM RULES'), 'the platform framing stays inline')
    isTrue(!r.prompt.includes('AUFGABE AUFGABE'), 'the task itself does NOT travel as an argument')
    isTrue(Buffer.byteLength(r.prompt) < 1500, `the launch prompt is short (${Buffer.byteLength(r.prompt)} B)`)
    // Self-ignoring, so `git add -A` in the agent's own final commit cannot
    // sweep the platform's task file into the operator's repository.
    equal(readFileSync(join(wt, TASK_DIR, '.gitignore'), 'utf8'), '*\n', 'the directory ignores itself')
    rmSync(wt, { recursive: true, force: true })
  })

  await check('offloading never makes the prompt LONGER than leaving it alone', () => {
    // Measured 2026-09-04, run 88a012cf: a 4127 B prompt whose task was a single
    // question sat just past the 4000 threshold, and offloading produced a
    // 4215 B launch prompt — bigger than the original, for a file in somebody's
    // worktree and a tool call the agent did not need. Only the TASK can be
    // offloaded; the platform framing has to stay inline. So what decides is the
    // saving, not the total.
    const wt = mkdtempSync(join(tmpdir(), 'fl-offload2-'))
    const platform = 'P'.repeat(3600)
    for (const task of ['Wieviel Bugs sind offen?', 'T'.repeat(1024), 'T'.repeat(2048), 'T'.repeat(12000)]) {
      const ganz = Buffer.byteLength([task, platform].join('\n\n'))
      const r = offloadPrompt('opencode', wt, task, platform)
      isTrue(Buffer.byteLength(r.prompt) <= ganz,
        `task ${task.length} B: launch prompt is never longer (${Buffer.byteLength(r.prompt)} vs ${ganz})`)
      if (r.taskFile) rmSync(join(wt, TASK_DIR), { recursive: true, force: true })
    }
    // A task worth a file still goes to one — the fence must not switch the
    // feature off, only keep it from firing where it buys nothing.
    const gross = offloadPrompt('opencode', wt, 'T'.repeat(12000), platform)
    isTrue(gross.taskFile, 'a 12 KB task is still offloaded')
    isTrue(Buffer.byteLength(gross.prompt) < 5000, 'and the launch prompt really is short')
    rmSync(wt, { recursive: true, force: true })
  })

  await check('a harness that declares no limit never offloads', () => {
    // claude and cursor take the prompt as an argument without complaint; only
    // a harness that says it cannot gets the indirection.
    for (const h of ['claude', 'cursor', 'hermes']) {
      const r = offloadPrompt(h, '/nowhere', langeAufgabe, 'P')
      equal(r.taskFile, null, `${h}: nothing written`)
      isTrue(r.prompt.includes('AUFGABE'), `${h}: the task travels as before`)
    }
  })

  await check('the finish gate does not read the task file as the agent\'s work', () => {
    // Every harness, unconditionally: the directory is the hub's, and a run
    // that offloaded would otherwise sit at "commit your changes first".
    for (const h of ['opencode', 'claude', 'cursor']) {
      isTrue(eigenePfade(h).includes(TASK_DIR), `${h}: ${TASK_DIR} is hub-owned`)
    }
  })

  // ------------------------------------------------------------------
  group('cursor: when is a run over? (hooks + transcript)')

  const { stateFromJsonl, projectDirs } = await import('../server/cursor-transcript.mjs')
  const { harnessOwnedPaths, writeHarnessHooks } = await import('../server/runner.mjs')
  const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
  const line = (o) => JSON.stringify(o)
  const answer = (text) => line({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
  const TURN_END = line({ type: 'turn_ended', status: 'success' })

  await check('only cursor ends its run with the turn — its TUI stays standing', () => {
    // claude and opencode have a dying process, a hook and a plugin channel;
    // cursor has none of that, which is exactly why this flag exists.
    equal(HP.cursor.turnEndsRun, true, 'cursor')
    for (const id of ['claude', 'opencode', 'hermes']) {
      isFalse(!!HP[id].turnEndsRun, `${id} keeps its turn end a note`)
    }
  })

  await check('the hook file is cursor\'s format, not claude\'s', () => {
    // cursor wants a flat list of { command } per event. claude's
    // { matcher, hooks: [...] } shape would be rejected — and a rejected hook
    // file is exactly the silent failure this whole detection is about.
    const [datei, ...weitere] = HP.cursor.hookFiles({ flReport: '/bin/fl-report' })
    equal(weitere.length, 0, 'one file')
    equal(datei.path, '.cursor/hooks.json', 'in the workspace, where cursor looks')
    const j = JSON.parse(datei.content)
    equal(j.hooks.stop[0].command, '/bin/fl-report _turn_end', 'stop reports the turn end')
    contains(j.hooks.sessionEnd[0].command, '_exit', 'sessionEnd is the second net')
    contains(j.hooks.sessionEnd[0].command, 'setsid', 'a dying process must not take the hook with it')
    isFalse(JSON.stringify(j).includes('"matcher"'), 'no claude shape')
  })

  await check('the hub knows the hook file is its own, not the agent\'s work', () => {
    // Otherwise every cursor worktree counts as dirty forever and is never
    // removed — the same trap the worktree extras once fell into.
    // '.freilauf' stands in front of every harness's own entries: it is where an
    // offloaded task goes (offloadPrompt), and it belongs to the hub the same way.
    equal(harnessOwnedPaths('cursor').join(','), '.freilauf,.cursor', 'cursor: the task dir and its hook file')
    equal(harnessOwnedPaths('claude').join(','), '.freilauf', 'claude brings no hook file of its own')
  })

  await check('an existing hooks.json is never overwritten', () => {
    const wt = join(sandkasten, 'wt-hooks')
    mkdirSync(wt, { recursive: true })
    equal(writeHarnessHooks('cursor', wt).join(','), '.cursor/hooks.json', 'the folder is created along with it')
    writeFileSync(join(wt, '.cursor', 'hooks.json'), '{"mine":true}')
    equal(writeHarnessHooks('cursor', wt).join(','), '', 'a repo\'s own hooks stay untouched')
    equal(readFileSync(join(wt, '.cursor', 'hooks.json'), 'utf8'), '{"mine":true}', 'and unchanged')
  })

  await check('a turn is over when turn_ended is the LAST record', () => {
    const s = stateFromJsonl([answer('Done, pushed as abc1234.'), TURN_END].join('\n'))
    equal(s.turnEnded, 'success', 'ended')
    equal(s.lastAnswer, 'Done, pushed as abc1234.', 'the agent\'s closing words become the report')
  })
  await check('a follow-up makes the earlier turn end history again', () => {
    // The operator types into the terminal, or a flow messages the agent: the
    // run goes on and must not be closed under it.
    const s = stateFromJsonl([answer('first part'), TURN_END,
      line({ role: 'user', message: { content: [{ type: 'text', text: 'and now this too' }] } }),
      answer('second part')].join('\n'))
    equal(s.turnEnded, null, 'not ended')
    equal(s.lastAnswer, 'second part', 'the newer answer')
  })
  await check('a running turn and a broken line are not an end', () => {
    equal(stateFromJsonl(answer('still working')).turnEnded, null, 'still working')
    equal(stateFromJsonl('').turnEnded, null, 'empty')
    equal(stateFromJsonl('{"type":"turn_en').turnEnded, null, 'half a line — the next pass gets it whole')
    equal(stateFromJsonl(`${answer('a')}\n{"type":"turn_e`).lastAnswer, 'a', 'the complete lines still count')
  })
  await check('tool calls without text do not overwrite the closing words', () => {
    const toolCall = line({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: {} }] } })
    equal(stateFromJsonl([answer('my report'), toolCall, TURN_END].join('\n')).lastAnswer, 'my report', 'text wins')
  })

  await check('the transcript directory follows cursor\'s own slug rule', () => {
    process.env.FREILAUF_CURSOR_DIR = '/c'
    try {
      equal(projectDirs('/srv/agents/worktrees/repo/ab12-detached')[0],
        '/c/projects/srv-agents-worktrees-repo-ab12-detached', 'non-alphanumeric becomes -, ends trimmed')
      equal(projectDirs('')[0], undefined, 'no directory, no guess')
      // Over 92 characters cursor shortens to 84 plus 7 hex of its own sha256.
      // Both variants are returned so a rename does not blind the hub silently.
      const long = projectDirs('/srv/' + 'x'.repeat(120))
      equal(long.length, 2, 'plain form and shortened form')
      equal(long[1].length, 92, 'the shortened one is exactly 92 characters')
      isTrue(/-[0-9a-f]{7}$/.test(long[1]), 'with the hash cursor appends')
    } finally { delete process.env.FREILAUF_CURSOR_DIR }
  })

  // ------------------------------------------------------------------
  group('opencode: what a run is really doing (opencode-store.mjs)')

  const { sessionTree, readRun, storeActivity } = await import('../server/opencode-store.mjs')
  const { DatabaseSync: OcDb } = await import('node:sqlite')
  const OC_WT = '/wt/run-a'
  const OC_T0 = Date.parse('2026-09-04T15:11:00Z')      // the run starts here
  const ocMin = (n) => OC_T0 + n * 60_000

  // A store in the shape opencode 1.18 writes: sessions carry parent_id and
  // their own totals, messages and parts carry their own time_updated.
  const ocStore = (rows, { withParent = true } = {}) => {
    const f = join(sandkasten, `oc-${Math.random().toString(36).slice(2)}.db`)
    const d = new OcDb(f)
    d.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, ${withParent ? 'parent_id TEXT,' : ''} directory TEXT,
              cost REAL, tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER);`)
    let n = 0
    for (const s of rows.sessions ?? []) {
      const cols = ['id', ...(withParent ? ['parent_id'] : []), 'directory', 'cost', 'tokens_input', 'tokens_output', 'time_created', 'time_updated']
      d.prepare(`INSERT INTO session(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
        .run(...cols.map(c => s[c] ?? (c === 'directory' ? OC_WT : null)))
    }
    for (const p of rows.parts ?? []) {
      d.prepare(`INSERT INTO part(id, message_id, session_id, time_created, time_updated) VALUES(?,?,?,?,?)`)
        .run(`p${++n}`, `m${n}`, p.session_id, p.time_updated, p.time_updated)
    }
    for (const m of rows.messages ?? []) {
      d.prepare(`INSERT INTO message(id, session_id, time_created, time_updated) VALUES(?,?,?,?)`)
        .run(`m${++n}`, m.session_id, m.time_updated, m.time_updated)
    }
    return { file: f, db: d }
  }

  await check('a finished subagent is not the run — the whole session tree is', () => {
    // The regression this module was written for (run f2d4af1d, 2026-09-04):
    // the task tool opens a CHILD session in the same directory, so "the newest
    // session of this worktree" was a subagent that had already stopped, and
    // the hub read the run's activity and tokens off it. Here the newest
    // CREATED session (sub2) died at minute 3 while the run's own session kept
    // going until minute 25.
    const { db: d } = ocStore({ sessions: [
      { id: 'root', parent_id: null, cost: 0.05, tokens_input: 100, tokens_output: 10, time_created: ocMin(0), time_updated: ocMin(25) },
      { id: 'sub1', parent_id: 'root', cost: 0.01, tokens_input: 40, tokens_output: 4, time_created: ocMin(1), time_updated: ocMin(2) },
      { id: 'sub2', parent_id: 'root', cost: 0.02, tokens_input: 60, tokens_output: 6, time_created: ocMin(2), time_updated: ocMin(3) },
    ] })
    equal(sessionTree(d, OC_WT, OC_T0 - 5000).sort().join(','), 'root,sub1,sub2', 'root plus its children')
    const r = readRun(d, OC_WT, OC_T0 - 5000)
    equal(r.lastActivityMs, ocMin(25), 'the newest timestamp anywhere in the tree')
    equal(r.tokensIn, 200, 'the subagents\' tokens are the operator\'s tokens')
    equal(r.tokensOut, 20, 'output likewise summed')
    equal(Math.round(r.costUsd * 100) / 100, 0.08, 'and the cost')
  })

  await check('a subagent that works somewhere else still belongs to the run', () => {
    // The descendants come off parent_id, not off the directory — an agent that
    // sends a subagent into another checkout must not fall out of its own run.
    const { db: d } = ocStore({ sessions: [
      { id: 'root', parent_id: null, time_created: ocMin(0), time_updated: ocMin(1) },
      { id: 'sub', parent_id: 'root', directory: '/somewhere/else', tokens_input: 7, time_created: ocMin(2), time_updated: ocMin(9) },
      { id: 'deep', parent_id: 'sub', directory: '/somewhere/else', tokens_input: 3, time_created: ocMin(3), time_updated: ocMin(4) },
    ] })
    const r = readRun(d, OC_WT, OC_T0 - 5000)
    equal(r.sessions, 3, 'the tree is walked to its depth')
    equal(r.tokensIn, 10, 'their tokens count')
    equal(r.lastActivityMs, ocMin(9), 'and so does their activity')
  })

  await check('a running turn shows up in the parts, not yet in the session row', () => {
    // session.time_updated moves once per COMPLETED message. Measured in the
    // same run: one message ran 15:32:31 → 15:36:38, four minutes in which the
    // session row said nothing. The parts move while the turn is still going.
    const { db: d } = ocStore({
      sessions: [{ id: 'root', parent_id: null, time_created: ocMin(0), time_updated: ocMin(5) }],
      messages: [{ session_id: 'root', time_updated: ocMin(5) }],
      parts: [{ session_id: 'root', time_updated: ocMin(19) }],
    })
    equal(readRun(d, OC_WT, OC_T0 - 5000).lastActivityMs, ocMin(19), 'the finest signal the store has wins')
  })

  await check('a session older than the run is not the run\'s', () => {
    // A worktree can hold several sessions over time (a retry, an operator
    // attaching by hand). Nothing matching means "no answer" — never "idle".
    const { db: d } = ocStore({ sessions: [
      { id: 'old', parent_id: null, tokens_input: 999, time_created: OC_T0 - 3600_000, time_updated: OC_T0 - 3500_000 },
    ] })
    const r = readRun(d, OC_WT, OC_T0 - 5000)
    equal(r.sessions, 0, 'not picked up')
    equal(r.lastActivityMs, null, 'and no timestamp invented for it')
    equal(r.tokensIn, 0, 'no foreign tokens')
  })

  await check('a store without parent_id falls back to the newest session', () => {
    // An older (or newer) opencode whose schema does not carry the column must
    // degrade to what the hub did before — never throw, never answer nothing.
    const { db: d } = ocStore({ sessions: [
      { id: 'a', tokens_input: 5, time_created: ocMin(0), time_updated: ocMin(1) },
      { id: 'b', tokens_input: 9, time_created: ocMin(2), time_updated: ocMin(3) },
    ] }, { withParent: false })
    equal(sessionTree(d, OC_WT, OC_T0 - 5000).join(','), 'b', 'the newest one, as before')
    equal(readRun(d, OC_WT, OC_T0 - 5000).tokensIn, 9, 'and its numbers')
  })

  await check('no store, no answer — and never a thrown watcher pass', async () => {
    process.env.FREILAUF_OPENCODE_DB = join(sandkasten, 'does-not-exist.db')
    try {
      const run = { harness: 'opencode', workdir_effective: OC_WT, started_at: '2026-09-04 15:11:00' }
      equal(await storeActivity(run), null, 'null, not an exception')
      equal(await storeActivity({ harness: 'opencode' }), null, 'a run without a worktree either')
    } finally { delete process.env.FREILAUF_OPENCODE_DB }
  })

  await check('the store path is overridable — a test never reads the operator\'s', async () => {
    // Same fence as FREILAUF_CURSOR_AUTH and FREILAUF_CLAUDE_CREDENTIALS.
    const { file, db: d } = ocStore({ sessions: [
      { id: 'root', parent_id: null, tokens_input: 42, time_created: ocMin(0), time_updated: ocMin(1) },
    ] })
    d.close()
    process.env.FREILAUF_OPENCODE_DB = file
    try {
      const run = { harness: 'opencode', workdir_effective: OC_WT, started_at: '2026-09-04 15:11:00' }
      const r = await storeActivity(run)
      equal(r.tokensIn, 42, 'read out of the store the variable names')
      equal(r.lastActivityMs, ocMin(1), 'with its activity')
    } finally { delete process.env.FREILAUF_OPENCODE_DB }
  })

  // ------------------------------------------------------------------
  group('Detection: rate limit / provider errors (detect.mjs)')
  const { typVonClaudeFehler, typVonText, terminalText, scanneZeilen, scanneNeueBytes,
    transkriptFehler, bewerteLogTreffer, fremdeClaudeSession, vorfallWeggrund,
    isSessionStopped } = await import('../server/detect.mjs')

  await check('Claude\'s StopFailure enum is mapped completely', () => {
    equal(typVonClaudeFehler('rate_limit'), 'rate_limit', 'rate_limit')
    equal(typVonClaudeFehler('overloaded'), 'provider_error', 'overloaded')
    equal(typVonClaudeFehler('server_error'), 'provider_error', 'server_error')
    equal(typVonClaudeFehler('authentication_failed'), 'auth_error', 'auth')
    equal(typVonClaudeFehler('oauth_org_not_allowed'), 'auth_error', 'oauth')
    equal(typVonClaudeFehler('billing_error'), 'billing_error', 'billing')
    equal(typVonClaudeFehler('account_on_hold'), 'billing_error', 'on hold')
    equal(typVonClaudeFehler('model_not_found'), 'model_error', 'model')
    equal(typVonClaudeFehler('max_output_tokens'), null, 'max_output_tokens is NOT a provider problem')
    equal(typVonClaudeFehler('unknown'), 'unbekannt', 'unknown')
    equal(typVonClaudeFehler('irgendwas_neues'), 'unbekannt', 'unknown enum value maps to unbekannt, no crash')
  })

  await check('free text is classified in the right order', () => {
    equal(typVonText('AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.'), 'rate_limit', 'opencode rate limit (real log text)')
    equal(typVonText("You've hit your session limit · resets 8:36pm"), 'rate_limit', 'Claude subscription limit')
    equal(typVonText('API Error: 429 Too Many Requests'), 'rate_limit', '429')
    equal(typVonText('Overloaded'), 'provider_error', 'overloaded')
    equal(typVonText('API Error: 529 overloaded_error'), 'provider_error', '529')
    equal(typVonText('Please run /login · API Error: 403'), 'auth_error', '403 + login')
    equal(typVonText('402 insufficient credits'), 'billing_error', '402 before the rate-limit check')
    equal(typVonText('model_not_found: no such model'), 'model_error', 'model')
    equal(typVonText('alles gut'), 'unbekannt', 'no match')

    // The two wordings OpenRouter refuses a spent key with. Measured 2026-09-04
    // on this installation: four runs, four red incidents, all of them filed as
    // 'unbekannt' → "API error … the hub carried on by itself". It had not.
    equal(typVonText('This request requires more credits, or fewer max_tokens. You requested up to '
      + "32000 tokens, but can only afford 20932. To increase, visit https://openrouter.ai/… and adjust the key's daily limit"),
      'billing_error', 'OpenRouter: "requires more credits … can only afford"')
    equal(typVonText('Prompt tokens limit exceeded: 365512 > 344659. To increase, visit '
      + "https://openrouter.ai/… and adjust the key's daily limit"),
      'billing_error', "OpenRouter: a spent key's daily limit")
    // …and the neighbours it must not swallow: a plain rate limit stays one,
    // and a bare "limit" with no money next to it is still no verdict.
    equal(typVonText('Rate limit exceeded: free-models-per-day'), 'rate_limit', 'a daily RATE limit is not billing')
    equal(typVonText('context limit exceeded: 200000 > 180000'), 'unbekannt', 'a bare limit is not billing')
  })

  // An error hook fires while the process dies, and the hub is very often the
  // one killing it — retention, the kill route, a flow, archiving. Filing that
  // as a provider incident is the hub alarming about its own cleanup, and on an
  // aborted run such an incident never resolves by itself. Measured on run
  // c532df45: `session.error: "Aborted"` at 02:14:32, the retention pass's own
  // `aborted` event ten seconds later, and a red "needs you" still standing two
  // days on.
  await check('a stopped session is not a provider fault', () => {
    for (const t of ['Aborted', 'aborted', '  Aborted.  ', 'AbortError',
      'The operation was aborted', 'SIGTERM', 'killed', 'cancelled']) {
      isTrue(isSessionStopped(t), `"${t}" is the session ending`)
    }
    // Narrow on purpose: a real error that merely mentions one of those words
    // must still be an incident, or the guard becomes the next false green.
    for (const t of ['API Error: 429 — request aborted after 3 retries',
      'AI_APICallError: stream aborted', 'aborted: 503 upstream unavailable', '', 'alles gut']) {
      isFalse(isSessionStopped(t), `"${t}" is not merely a stopped session`)
    }
    equal(typVonText('AI_APICallError: stream aborted'), 'provider_error',
      'and such a line is still classified as what it is')
  })

  await check('terminalText removes ANSI, OSC titles, and turns \\r into lines', () => {
    const roh = '\x1b]0;✳ Claude Code\x07\x1b[38;5;174m ▐\x1b[39m hallo\r\nzeile2\rzeile3\n'
    equal(terminalText(roh), ' ▐ hallo\nzeile2\nzeile3\n', 'cleaned')
  })

  await check('production false positive: "Upgrade to Max for higher rate limits" does NOT fire', () => {
    const zeilen = ['/upgrade   Upgrade to Max for higher rate limits and more Opus', 'Rate limits', '  rate limit  ']
    equal(scanneZeilen('claude', zeilen).length, 0, 'menu text and bare heading')
  })

  await check('agent working on the topic: grep/source code/tests do not fire', () => {
    const zeilen = [
      'grep -rn "rate limit" server/',
      "if (/rate limit|rate.limited/i.test(tail)) { db.prepare('UPDATE runs SET rate_limit_hits=1')",
      "it('meldet 429 als rate_limit', () => {",
      'const retryAfter = res.headers.get("retry-after") // 429',
    ]
    equal(scanneZeilen('hermes', zeilen).length, 0, 'hermes patterns on source code')
    equal(scanneZeilen('cursor', zeilen).length, 0, 'cursor patterns on source code')
    equal(scanneZeilen('opencode', zeilen).length, 0, 'opencode patterns on source code')
  })

  // All three lines below opened an incident on ONE real cursor run (2026-08-25):
  // a token count read as a 5xx, the hub's own section heading read as a rate
  // limit, and the e2e suite's success line read as a rejected model.
  await check('production false positives: cursor status line, hub UI text and test output do NOT fire', () => {
    const zeilen = [
      '⠠⠛ Globbing  555 tokens',
      '⠀⠞ Running  597 tokens',
      'Incidents: rate limit and provider errors (auto-alarm)',
      '✓ cursor: run passes through the pipeline and "Cannot use this model" is detected',
      '✓ hook report (fl-report _api_error via stdin) → RED; rate limit counter increments',
      // These two — this file's own lines — turned a running claude agent red.
      "    equal(scanneZeilen('cursor', ['API Error: 503', 'upstream connection error (502)']).length, 2, 'real status codes')",
      "    const c = scanneZeilen('claude', [\"You've hit your session limit · resets 8:36pm (Europe/Berlin)\"])",
    ]
    for (const h of ['cursor', 'hermes', 'opencode', 'claude']) {
      equal(scanneZeilen(h, zeilen).length, 0, `${h}: no match`)
    }
  })

  await check('a bare 5xx number is not a status code — an error word has to stand next to it', () => {
    equal(scanneZeilen('cursor', ['reading 512 lines', 'chunk 500 of 900', 'saved 503 bytes']).length, 0, 'plain numbers')
    equal(scanneZeilen('cursor', ['API Error: 503', 'upstream connection error (502)']).length, 2, 'real status codes')
    equal(typVonText('500 Internal Server Error'), 'provider_error', 'status + text')
    equal(typVonText('processed 555 tokens'), 'unbekannt', 'token count is not a 5xx')
  })

  await check('real error texts per harness are recognized', () => {
    const c = scanneZeilen('claude', ["You've hit your session limit · resets 8:36pm (Europe/Berlin)", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'])
    equal(c.map(t => t.typ).join(','), 'rate_limit,provider_error', 'claude')
    const o = scanneZeilen('opencode', ['AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.', 'AI_RetryError: Failed after 3 attempts'])
    equal(o.map(t => t.typ).join(','), 'rate_limit,provider_error', 'opencode')
    const h = scanneZeilen('hermes', [
      '⏳ Retrying in 12.0s (rate limited by upstream provider (429))...',
      '⚠️  API call failed (attempt 2/5): APIConnectionError',
      '   ⏱️  upstream provider overloaded (529)',
    ])
    equal(h.map(t => t.typ).join(','), 'rate_limit,provider_error,provider_error', 'hermes')
    isTrue(h[0].zeile.includes('Retrying'), 'evidence is the line')
    // cursor: 'Cannot use this model' is the VERBATIM rejection of the CLI for an
    // unknown model ID (measured) — the most reliable match cursor provides.
    const u = scanneZeilen('cursor', [
      'Cannot use this model: gibtsnicht-9000. Available models: auto, gpt-5.2',
      'Error: 429 Too Many Requests',
      'You are not logged in. Please run cursor-agent login',
      'upstream connection error (503)',
    ])
    equal(u.map(t => t.typ).join(','), 'model_error,rate_limit,auth_error,provider_error', 'cursor')
  })

  await check('offset scan: incomplete trailing line is deferred, not consumed', () => {
    const teil1 = 'foo\n⚠️  API call failed (attempt 1/5): RateLimit'
    const r1 = scanneNeueBytes('hermes', teil1, 100)
    equal(r1.treffer.length, 0, 'half a line does not count')
    equal(r1.neuerOffset, 100 + Buffer.byteLength('foo\n'), 'offset points at the start of the half line')
    const teil2 = '⚠️  API call failed (attempt 1/5): RateLimitError (HTTP 429)\n'
    const r2 = scanneNeueBytes('hermes', teil2, r1.neuerOffset)
    equal(r2.treffer.length, 1, 'complete → match')
    equal(r2.treffer[0].typ, 'rate_limit', 'type')
    equal(r2.neuerOffset, r1.neuerOffset + Buffer.byteLength(teil2), 'offset at the end')
  })

  await check('offset scan: without a newline nothing moves', () => {
    const r = scanneNeueBytes('claude', 'nur ein Stück', 7)
    equal(r.neuerOffset, 7, 'offset stays')
    equal(r.treffer.length, 0, 'no match')
  })

  await check('Claude transcript: isApiErrorMessage lines with enum and timestamp', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', error: 'rate_limit', timestamp: '2026-08-23T17:36:32.446Z', isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: "You've hit your session limit · resets 8:36pm" }] } }),
      JSON.stringify({ type: 'assistant', error: 'max_output_tokens', isApiErrorMessage: true, message: { content: 'x' } }),
      '{"kaputt": tru',
    ].join('\n')
    const f = transkriptFehler(jsonl)
    equal(f.length, 1, 'exactly one relevant error (max_output_tokens and garbage ignored)')
    equal(f[0].typ, 'rate_limit', 'type')
    equal(f[0].ts, '2026-08-23T17:36:32.446Z', 'timestamp')
    contains(f[0].text, 'session limit', 'text')
  })

  await check('rating: a single match with continued work stays yellow', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    equal(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 6 * 60_000 }), 'gelb', 'activity after the match')
  })
  await check('rating: silence after the match turns red (the limit stands at the end)', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    equal(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 5 * 60_000 }), 'rot', '5 min silent')
    equal(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 2 * 60_000 }), 'gelb', 'only 2 min silent')
  })
  // Regression: cursor and hermes have NO activity source (measureActivity
  // returns nothing for them), so null was permanently true here — every yellow
  // log hit on those two turned red 5 min later while the agent was working.
  await check('rating: unmeasured activity is unknown, not silence — it never escalates', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    equal(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: null, jetztMs: t0 + 5 * 60_000 }), 'gelb', 'no activity source: stays yellow')
    equal(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: null, jetztMs: t0 + 3 * 3600_000 }), 'gelb', 'even after hours')
    equal(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 60_000, letzteAktivitaetMs: null, jetztMs: t0 + 2 * 60_000 }), 'rot', 'repetition still escalates')
  })
  await check('rating: repetition within 10 min turns red (retry loop)', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    equal(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 3 * 60_000, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 4 * 60_000 }), 'rot', '2× in 3 min')
    equal(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 3 * 60_000, letzteAktivitaetMs: null, jetztMs: t0 + 4 * 60_000 }), 'rot', '… also without an activity source (cursor/hermes)')
    equal(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 40 * 60_000, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 41 * 60_000 }), 'gelb', '2× 40 min apart is not a loop')
  })
  // Regression: an agent that scrolls through source code about API errors
  // produced five hits in two minutes — the repetition path made its run red
  // while it was working normally.
  await check('rating: work AFTER the last match vetoes every escalation', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    equal(bewerteLogTreffer({ anzahl: 5, erstGesehenMs: t0, zuletztGesehenMs: t0 + 2 * 60_000, letzteAktivitaetMs: t0 + 3 * 60_000, jetztMs: t0 + 4 * 60_000 }), 'gelb', '5× but the agent kept working')
    equal(bewerteLogTreffer({ anzahl: 5, erstGesehenMs: t0, zuletztGesehenMs: t0 + 2 * 60_000, letzteAktivitaetMs: t0 + 3 * 60_000, jetztMs: t0 + 60 * 60_000 }), 'gelb', 'and an hour later still not')
    equal(bewerteLogTreffer({ anzahl: 5, erstGesehenMs: t0, zuletztGesehenMs: t0 + 2 * 60_000, letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 4 * 60_000 }), 'rot', 'no work after the last match: the loop stands')
  })

  // The false alarm of 2026-08-30: an agent testing a fake model id
  // (`nosuch/model-xyz`) spawned its own claude, which inherited the worktree's
  // hooks and FL_RUN_ID — its StopFailure landed on the healthy parent run as a
  // red "Model unavailable". The session id is the discriminator.
  await check('a claude hook report from a foreign session is recognized', () => {
    const runId = 'a4a392ae-9a66-46db-bd03-4d4636465841'
    isFalse(fremdeClaudeSession(runId, 'claude', runId), 'the run\'s own session (--session-id <run id>)')
    isFalse(fremdeClaudeSession(runId, 'claude', ''), 'no session id (older fl-report): the run\'s own')
    isFalse(fremdeClaudeSession(runId, 'claude', null), 'null: the run\'s own')
    isFalse(fremdeClaudeSession(runId, 'cursor', 'andere-session'), 'the guard is claude-only')
    isTrue(fremdeClaudeSession(runId, 'claude', '0f7c3b1e-0000-4000-8000-000000000000'),
      'a claude with its own session id is a process the agent spawned')
  })

  // Auto-resolve: an incident whose condition is demonstrably gone closes
  // itself — the run came through, or the agent demonstrably kept working
  // after the occurrence. Silence proves nothing for red (a blocked agent is
  // silent too), so red resolves only on positive evidence.
  await check('vorfallWeggrund: gone is gone — done runs, work after the hit, expired yellow', () => {
    const t0 = Date.parse('2026-08-30T08:14:19Z')
    const config = (ueber) => ({ zuletztGesehenMs: t0, jetztMs: t0 + 20 * 60_000, ...ueber })
    // The run came through: the incident during it answered itself.
    equal(vorfallWeggrund(config({ typ: 'model_error', schwere: 'rot', runStatus: 'done', letzteAktivitaetMs: null })),
      'run finished successfully', 'done run: even auth/billing/model close')
    // A red incident on a run that is still going: only measurable work after
    // the occurrence and no recurrence since resolves it.
    equal(vorfallWeggrund(config({ typ: 'model_error', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000 })), 'agent kept working after it', 'work after the hit')
    equal(vorfallWeggrund(config({ typ: 'model_error', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 5 * 60_000 })), null, 'too soon after the hit')
    equal(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 - 60_000 })), null, 'silence proves nothing for red')
    equal(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: null })), null, 'no activity source (hermes): red stays')
    // A red incident on a failed run is WHY it failed — a human decides.
    equal(vorfallWeggrund(config({ typ: 'auth_error', schwere: 'rot', runStatus: 'failed',
      letzteAktivitaetMs: t0 + 60_000 })), null, 'red on a failed run stays')
    // Yellow: the old 30-minute rule, generalized.
    equal(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 31 * 60_000 })), 'expired: agent kept working', 'yellow: agent worked on')
    equal(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 20 * 60_000 })), null, 'yellow: less than half an hour')
    equal(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'running',
      letzteAktivitaetMs: null, jetztMs: t0 + 31 * 60_000 })), 'expired: no recurrence', 'yellow without an activity source')
    equal(vorfallWeggrund(config({ typ: 'rate_limit', schwere: 'gelb', runStatus: 'aborted',
      letzteAktivitaetMs: null, jetztMs: t0 + 31 * 60_000 })), 'expired: run ended', 'yellow on an ended run')
    // Never by time alone:
    equal(vorfallWeggrund(config({ typ: 'merge_blocked', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000 })), null, 'merge_blocked is the integrator\'s decision')
    equal(vorfallWeggrund(config({ typ: 'provider_down:deepseek', schwere: 'rot', runStatus: 'running',
      letzteAktivitaetMs: t0 + 60_000 })), null, 'provider_down has its own recovery loop')
  })

  // ------------------------------------------------------------------
  group('Incidents: needs a human vs. merely noticed (brauchtMensch)')
  const { brauchtMensch } = await import('../server/incidents.mjs')

  await check('login, credits and model always need a human — they never clear themselves', () => {
    for (const typ of ['auth_error', 'billing_error', 'model_error']) {
      isTrue(brauchtMensch({ typ, schwere: 'gelb' }, 'running'), `${typ} while running`)
      isTrue(brauchtMensch({ typ, schwere: 'gelb' }, 'done'), `${typ} on a finished run`)
    }
  })

  await check('rate limit and provider errors are observations while the run lives or came through', () => {
    for (const typ of ['rate_limit', 'provider_error', 'unbekannt']) {
      isFalse(brauchtMensch({ typ, schwere: 'rot' }, 'running'), `${typ} while running`)
      isFalse(brauchtMensch({ typ, schwere: 'rot' }, 'done'), `${typ} on a finished run`)
    }
  })

  await check('a confirmed incident on a run that did NOT come through is a to-do', () => {
    isTrue(brauchtMensch({ typ: 'rate_limit', schwere: 'rot' }, 'failed'), 'red + failed')
    isTrue(brauchtMensch({ typ: 'provider_error', schwere: 'rot' }, 'aborted'), 'red + aborted')
    isFalse(brauchtMensch({ typ: 'rate_limit', schwere: 'gelb' }, 'failed'), 'a mere suspicion is not')
  })

  await check('a global incident (provider pulse, no run) is not a to-do either', () => {
    isFalse(brauchtMensch({ typ: 'provider_down:openrouter', schwere: 'rot' }), 'nobody can fix a provider outage')
    isTrue(brauchtMensch({ typ: 'billing_error', schwere: 'rot' }), 'global billing still needs a human')
  })

  // ------------------------------------------------------------------
  group('Extra skills (zusaetze.mjs)')
  const zdir = join(sandkasten, 'zusaetze')
  process.env.FREILAUF_ZUSAETZE_DIR = zdir
  mkdirSync(join(zdir, 'unlazy'), { recursive: true })
  writeFileSync(join(zdir, 'unlazy', 'SKILL.md'),
    '---\nname: unlazy\ndescription: Enforces completion discipline for lazy models.\n---\n\n# Unlazy\n')
  mkdirSync(join(zdir, 'ohne-skillmd'), { recursive: true })
  const { zusatzSkills, skillsAusFormular, skillPromptZusatz, skillListe } = await import('../server/zusaetze.mjs')

  await check('folders with SKILL.md are found, frontmatter read, the rest ignored', () => {
    const l = zusatzSkills()
    equal(l.length, 1, 'only the real skill')
    equal(l[0].name, 'unlazy', 'folder name')
    equal(l[0].titel, 'unlazy', 'frontmatter name')
    contains(l[0].beschreibung, 'completion discipline', 'description')
    equal(l[0].pfad, join(zdir, 'unlazy', 'SKILL.md'), 'full path')
  })
  await check('form selection: only known names survive, empty becomes null', () => {
    equal(skillsAusFormular({ skills_list: ['unlazy', 'boese-eingabe'] }), '["unlazy"]', 'filtered')
    equal(skillsAusFormular({}), null, 'no selection → null')
    equal(skillsAusFormular({ skills: 'unlazy' }), '["unlazy"]', 'single value without _list')
  })
  await check('prompt addition names the full SKILL.md path and the directory', () => {
    const z = skillPromptZusatz('["unlazy"]')
    contains(z, join(zdir, 'unlazy', 'SKILL.md'), 'full path')
    contains(z, 'ENTIRE task', 'instruction to apply')
    equal(skillPromptZusatz(null), '', 'no selection, no addition')
  })
  await check('a selected but deleted skill is named honestly instead of dead-linked', () => {
    const z = skillPromptZusatz('["weg-damit"]')
    contains(z, "'weg-damit'", 'name')
    contains(z, 'no longer', 'hint')
  })
  await check('broken JSON in the DB column does not crash', () => {
    equal(skillListe('{kaputt').length, 0, 'empty')
  })
  await check('slider: chosen depth goes into the DB as "unlazy:N" and into the prompt as "tree N"', () => {
    equal(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '4' }), '["unlazy:4"]', 'encoded')
    const z = skillPromptZusatz('["unlazy:4"]')
    contains(z, '"tree 4"', 'trigger from the SKILL.md')
    contains(z, 'depth 4', 'plain text')
    contains(z, 'SKILL.md', 'reference remains')
  })
  await check('slider: unknown or tampered values fall back to "skill decides"', () => {
    equal(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '9' }), '["unlazy"]', '9 does not exist')
    equal(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '4; rm -rf' }), '["unlazy"]', 'garbage')
    equal(skillsAusFormular({ skills: 'unlazy' }), '["unlazy"]', 'without slider')
    isFalse(skillPromptZusatz('["unlazy"]').includes('tree'), 'no tree line without a value')
  })


  // ------------------------------------------------------------------
  group('Freilauf skills: where they go, and what may be removed')

  const skillsMod = await import('../server/skills.mjs')
  const { setPluginConfig: skillsPluginConfig } = await import('../server/plugins/store.mjs')
  const { setSetting: setzeEinstellung } = await import('../server/db.mjs')

  await check('a user path is resolved against the skills home, an absolute one is left alone', () => {
    equal(skillsMod.expandHome('~/.claude/skills', '/h'), '/h/.claude/skills', 'tilde')
    equal(skillsMod.expandHome('~', '/h'), '/h', 'bare tilde')
    equal(skillsMod.expandHome('/opt/skills', '/h'), '/opt/skills', 'absolute')
    equal(skillsMod.expandHome('', '/h'), '', 'empty stays empty')
  })

  // The calling card is the ONLY thing a user-level skill has to go on: it is
  // read by sessions Freilauf never started, in projects that know nothing
  // about it. `app_dir` is what lets the plugin skill find `docs/plugins.md`
  // — the whole plugin contract, far too long to restate in a skill — so a
  // value that does not really point at the hub's code is a skill that reads
  // nothing and says nothing.
  await check('the calling card names the hub, its data AND its own code', async () => {
    const { existsSync: ex } = await import('node:fs')
    const { join: j, isAbsolute } = await import('node:path')
    const f = skillsMod.installationFacts()
    for (const k of ['id', 'url', 'data_dir', 'runs_dir', 'worktrees_dir', 'app_dir', 'plugin_dir']) {
      isTrue(f[k], `${k} is set`)
    }
    isTrue(isAbsolute(f.app_dir), 'app_dir is absolute — resolved from the module, not from the cwd')
    isTrue(ex(j(f.app_dir, 'docs', 'plugins.md')), 'and it really holds the plugin contract')
    isTrue(ex(j(f.app_dir, 'server', 'skills.mjs')), 'and the hub it was resolved from')
    isTrue(isAbsolute(f.plugin_dir), 'plugin_dir is absolute')
    equal(f.plugin_dir, (await import('../server/plugins/loader.mjs')).pluginDir(),
      'and it is the same answer the loader gives — one place decides where packages live')
  })

  // The delivery path was written before any skill needed more than SKILL.md,
  // references/ and scripts/, so nothing about it was ever shape-aware — and
  // that is worth pinning rather than assuming. `freilauf-agent-flow-builder`
  // ships a nested tree with Python, JSON and prompt files in it; if somebody
  // ever "tidies" payloadFiles() into an extension list, this is what says no.
  await check('a skill may ship a nested tree of non-markdown files, and all of it is delivered', async () => {
    const { mkdtempSync, cpSync, writeFileSync, rmSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const builder = skillsMod.availableSkills().find(s => s.name === 'freilauf-agent-flow-builder')
    isTrue(!!builder, 'the concept skill is among the shipped ones')
    isTrue(builder.files > 10, `its whole tree is counted, not just the top level (${builder.files} files)`)

    // The hash has to answer to every file, at any depth and of any type —
    // otherwise a changed template ships as "already current" forever.
    const tmp = mkdtempSync(j(tmpdir(), 'fl-skill-'))
    try {
      const kopie = j(tmp, 'freilauf-agent-flow-builder')
      cpSync(builder.dir, kopie, { recursive: true })
      equal(skillsMod.skillHash(kopie), builder.hash, 'a faithful copy hashes identically')
      const tief = j(kopie, 'konzepte', 'aufgaben-schwarm', 'vorlage', 'flows', 'takt-soll.json')
      writeFileSync(tief, '{"changed": true}\n')
      isFalse(skillsMod.skillHash(kopie) === builder.hash,
        'a JSON file four levels down changes the hash — no extension list, no folder whitelist')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  // The one thing a shipping skill must NOT answer to. An agent that runs the
  // shipped Python in place writes __pycache__ into the INSTALLED copy; if that
  // counted, the hub would report a copy nobody touched as edited by hand, at
  // every sync, forever.
  await check('python bytecode is not part of a skill — at either end', async () => {
    const { mkdtempSync, cpSync, mkdirSync: md, writeFileSync, rmSync, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const builder = skillsMod.availableSkills().find(s => s.name === 'freilauf-agent-flow-builder')
    const tmp = mkdtempSync(j(tmpdir(), 'fl-pyc-'))
    try {
      const kopie = j(tmp, 'freilauf-agent-flow-builder')
      cpSync(builder.dir, kopie, { recursive: true })
      const cache = j(kopie, 'konzepte', 'aufgaben-schwarm', 'vorlage', '__pycache__')
      md(cache, { recursive: true })
      writeFileSync(j(cache, 'dispatch.cpython-312.pyc'), 'not source\n')
      equal(skillsMod.skillHash(kopie), builder.hash,
        'a __pycache__ written by running the skill leaves the hash exactly where it was')
      writeFileSync(j(kopie, 'stray.pyc'), 'not source\n')
      equal(skillsMod.skillHash(kopie), builder.hash, 'and so does a loose .pyc beside SKILL.md')
      isTrue(ex(j(kopie, 'stray.pyc')), 'the file really is there — it is ignored, not deleted')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  await check('every shipped skill is a valid Agent Skill: name matches its directory, spec keys only', async () => {
    const { readdirSync: rd, readFileSync: rf, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('../skills', import.meta.url).pathname
    const dirs = rd(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    isTrue(dirs.length >= 1, 'at least one skill is shipped')
    // The open spec (agentskills.io) allows exactly these six; Claude Code's
    // packaging path REFUSES anything else, so a stray key is a hard failure
    // somewhere the test suite would never see it.
    const erlaubt = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
    for (const name of dirs) {
      const datei = j(root, name, 'SKILL.md')
      isTrue(ex(datei), `${name}: SKILL.md exists`)
      const text = rf(datei, 'utf8')
      isTrue(text.startsWith('---\n'), `${name}: frontmatter starts on line 1`)
      const block = text.match(/^---\n([\s\S]*?)\n---/)[1]
      const schluessel = block.split('\n').filter(z => /^\S/.test(z)).map(z => z.split(':')[0])
      for (const k of schluessel) isTrue(erlaubt.has(k), `${name}: '${k}' is a spec key`)
      isTrue(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64, `${name}: legal skill name`)
      equal(block.match(/^name:\s*(.+)$/m)?.[1].trim(), name, `${name}: frontmatter name is the directory name`)
    }
  })

  await check('a shipped skill has a description that could trigger, and stays under the caps', () => {
    for (const s of skillsMod.availableSkills()) {
      isTrue(s.description.length > 40, `${s.name}: description is more than a label`)
      isTrue(s.description.length <= 1024, `${s.name}: description within the spec limit`)
      equal(s.title, s.name, `${s.name}: parsed name`)
    }
  })

  await check('every coding agent that declares skill directories declares lists of strings', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    for (const p of Object.values(HP)) {
      if (!p.skills) continue
      for (const gruppeName of ['user', 'project']) {
        const liste = p.skills[gruppeName] ?? []
        isTrue(Array.isArray(liste), `${p.id}: ${gruppeName} is a list`)
        for (const eintrag of liste) isTrue(typeof eintrag === 'string' && eintrag.trim(), `${p.id}: ${gruppeName} entry is a path`)
      }
      isFalse((p.skills.project ?? []).some(x => x.startsWith('/') || x.startsWith('~')),
        `${p.id}: a project path is relative to a workspace`)
    }
  })

  // The covering set is the whole point of the declaration: three of the four
  // shipped coding agents read ~/.claude/skills, so a machine with all four
  // gets TWO directories and not four. Built from synthetic declarations so the
  // rule is tested, not the current contents of the four plugin files.
  const rolle = (id, user, i = 0) => ({ id, label: id, enabled: true, user, project: [] })
  await check('the covering set is the smallest one, and deterministic', () => {
    const claude = rolle('claude', ['/h/.claude/skills'])
    const cursor = rolle('cursor', ['/h/.cursor/skills', '/h/.claude/skills', '/h/.agents/skills'])
    const oc = rolle('opencode', ['/h/.config/opencode/skill', '/h/.claude/skills', '/h/.agents/skills'])
    const hermes = rolle('hermes', ['/h/.hermes/skills'])
    const dirs = (list) => skillsMod.coveringUserRoots(list).map(x => x.dir)

    equal(dirs([claude]).join(), '/h/.claude/skills', 'claude alone')
    equal(dirs([cursor]).join(), '/h/.cursor/skills', 'cursor alone gets its OWN directory, not the shared one')
    equal(dirs([oc]).join(), '/h/.config/opencode/skill', 'opencode alone the same')
    equal(dirs([claude, cursor, oc, hermes]).join(), '/h/.claude/skills,/h/.hermes/skills',
      'all four: two directories, because only hermes stands apart')
    equal(dirs([cursor, oc]).join(), '/h/.claude/skills',
      'a tie on coverage is broken by the summed preference, not by chance')
    const alle = skillsMod.coveringUserRoots([claude, cursor, oc, hermes])
    equal(alle.find(x => x.dir.endsWith('.claude/skills')).harnesses.join(), 'claude,cursor,opencode',
      'and the directory names who it serves')
  })

  await check('a coding agent without a declaration covers nobody and is reported', () => {
    const stumm = { id: 'stumm', label: 'stumm', enabled: true, user: [], project: [] }
    equal(skillsMod.coveringUserRoots([stumm]).length, 0, 'nothing to cover it with')
  })

  // The install/remove round trip against a home of its own. The state file and
  // the target home are both redirected at the top of this suite, so nothing
  // here can reach the operator's real directories.
  await check('install, refresh, repair, and remove only what the hub wrote', async () => {
    const { readFileSync: rf, writeFileSync: wf, mkdirSync: md, existsSync: ex, readdirSync: rd } = await import('node:fs')
    const { join: j } = await import('node:path')
    const HOME = process.env.FREILAUF_SKILLS_HOME
    for (const id of ['claude', 'opencode', 'hermes']) skillsPluginConfig(id, { kind: 'harness', source: 'builtin', enabled: 1 })
    setzeEinstellung('skills_install', '1')
    setzeEinstellung('skills_auto_update', '1')

    const erst = skillsMod.syncSkills()
    const anzahl = skillsMod.availableSkills().length
    equal(erst.targets.length, 2, 'two target directories for these three coding agents')
    equal(erst.installed.length, anzahl * 2, 'every skill in every target')
    equal(erst.errors.length, 0, 'and nothing failed')
    const ziel = j(HOME, '.claude', 'skills', 'freilauf-models')
    isTrue(ex(j(ziel, 'SKILL.md')), 'the file is really there')
    isTrue(ex(j(ziel, skillsMod.MARKER)), 'and carries the marker that makes it removable')

    const zweit = skillsMod.syncSkills()
    equal(zweit.installed.length + zweit.updated.length, 0, 'a second pass changes nothing')

    // A hand-edited copy is not current, and "keep them up to date" has to mean it.
    wf(j(ziel, 'SKILL.md'), 'tampered')
    equal(skillsMod.syncSkills().updated.length, 1, 'the edited copy is refreshed')
    isTrue(rf(j(ziel, 'SKILL.md'), 'utf8').startsWith('---'), 'and really rewritten')

    // ...unless automatic updating is off, which is the whole meaning of that switch.
    wf(j(ziel, 'SKILL.md'), 'tampered again')
    setzeEinstellung('skills_auto_update', '0')
    equal(skillsMod.syncSkills().updated.length, 0, 'with updates off nothing is touched')
    equal(rf(j(ziel, 'SKILL.md'), 'utf8'), 'tampered again', 'the copy stays as it is')
    setzeEinstellung('skills_auto_update', '1')
    skillsMod.syncSkills()

    // A skill of the operator's own, in the same directory, under a name the hub
    // does not ship: never touched, on the way in or on the way out.
    const eigen = j(HOME, '.claude', 'skills', 'meins')
    md(eigen, { recursive: true })
    wf(j(eigen, 'SKILL.md'), '---\nname: meins\n---\n')
    skillsMod.syncSkills()
    isTrue(ex(j(eigen, 'SKILL.md')), 'a foreign skill survives a sync')

    // Switching a coding agent off takes its directory with it — and only it.
    skillsPluginConfig('hermes', { kind: 'harness', source: 'builtin', enabled: 0 })
    const ohneHermes = skillsMod.syncSkills()
    equal(ohneHermes.removed.length, anzahl, 'the hermes copies go')
    isFalse(ex(j(HOME, '.hermes', 'skills', 'freilauf-models')), 'really gone')
    isTrue(ex(j(ziel, 'SKILL.md')), 'and the shared directory is untouched')

    // Switching the whole thing off removes what the hub wrote, and nothing else.
    setzeEinstellung('skills_install', '0')
    const aus = skillsMod.syncSkills()
    equal(aus.removed.length, anzahl, 'every remaining copy')
    equal(rd(j(HOME, '.claude', 'skills')).join(), 'meins', "the operator's own skill is all that is left")
    equal(skillsMod.readState().entries.length, 0, 'and the hub remembers nothing it no longer owns')
  })

  await check('the selection decides what is installed, and absent means all of them', async () => {
    const { setSetting: setz, default: dbSel } = await import('../server/db.mjs')
    const alle = skillsMod.availableSkills()
    const nichtGeteilt = alle.filter(s => s.role !== 'shared').map(s => s.name)
    const geteilt = alle.filter(s => s.role === 'shared').map(s => s.name)
    isTrue(geteilt.length >= 1, 'there is a shared skill nobody picks')
    const namen = () => skillsMod.selectedSkills().map(s => s.name)
    try {
      // Absent is ALL, and that is the backwards-compatible reading: an
      // installation that said yes before this setting existed must not have
      // its skills uninstalled by the next sync.
      setz('skills_selected', '')
      equal(namen().length, alle.length, 'no selection stored = every shipped skill')
      setz('skills_selected', JSON.stringify([nichtGeteilt[0]]))
      equal(namen().sort().join(), [nichtGeteilt[0], ...geteilt].sort().join(),
        'one picked, and the shared one rides along because the others load it')
      setz('skills_selected', '[]')
      equal(namen().length, 0, 'nothing picked takes the shared one too — it exists for the others')
      setz('skills_selected', 'not json{')
      equal(namen().length, alle.length, 'an unreadable selection falls back to all, never to none')
    } finally {
      // The sandbox database is shared with every group after this one.
      dbSel.prepare("DELETE FROM settings WHERE key='skills_selected'").run()
    }
  })

  await check('a directory the hub did not write is refused instead of overwritten', async () => {
    const { writeFileSync: wf, mkdirSync: md, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const HOME = process.env.FREILAUF_SKILLS_HOME
    const name = skillsMod.availableSkills()[0].name
    const kollision = j(HOME, '.claude', 'skills', name)
    md(kollision, { recursive: true })
    wf(j(kollision, 'SKILL.md'), '---\nname: ' + name + '\n---\nnot ours\n')
    setzeEinstellung('skills_install', '1')
    const r = skillsMod.syncSkills()
    isTrue(r.conflicts.some(c => c.dir === kollision), 'the collision is reported')
    equal((await import('node:fs')).readFileSync(j(kollision, 'SKILL.md'), 'utf8').includes('not ours'), true,
      'and the file is left exactly as it was')
    setzeEinstellung('skills_install', '0')
    skillsMod.syncSkills()
    isTrue(ex(j(kollision, 'SKILL.md')), 'switching off does not delete it either')
  })


  // This group is the only one in the suite that CONFIGURES coding agents, and
  // the sandbox database is shared with every group after it — "not configured
  // = not enabled" and the seeding test both read that table. So it hands the
  // database back the way it found it, and says so out loud rather than leaving
  // a later red test to be blamed on the plugin code.
  await check('the round trip leaves no configuration behind for the groups after it', async () => {
    const { forgetPlugin } = await import('../server/plugins/store.mjs')
    const dbMod = (await import('../server/db.mjs')).default
    for (const id of ['claude', 'opencode', 'hermes', 'cursor']) forgetPlugin(id)
    dbMod.prepare("DELETE FROM settings WHERE key IN ('skills_install','skills_auto_update')").run()
    equal(dbMod.prepare('SELECT count(*) c FROM plugin_config').get().c, 0, 'plugin_config is empty again')
    isFalse(skillsMod.skillsInstallOn(), 'and the switch is back off')
  })

  // ------------------------------------------------------------------
  group('Repos: deactivating, and the fences in front of deleting')

  const repoMod = await import('../server/pages.mjs')
  const schedMod = await import('../server/scheduler.mjs')
  const repoDb = (await import('../server/db.mjs')).default

  await check('repoInactive is only true for a repo that is really switched off', () => {
    const id = repoDb.prepare('INSERT INTO repos(name,path) VALUES(?,?)').run('unit-aktiv', '/tmp/unit-aktiv').lastInsertRowid
    const aus = repoDb.prepare('INSERT INTO repos(name,path,active) VALUES(?,?,0)').run('unit-aus', '/tmp/unit-aus').lastInsertRowid
    isFalse(schedMod.repoInactive(id), 'an active repo')
    isTrue(schedMod.repoInactive(aus), 'a deactivated one')
    // A repo that does not exist is NOT "deactivated" — whatever is wrong
    // there, the ordinary unknown-repo path says it better.
    isFalse(schedMod.repoInactive(999999), 'a repo that does not exist')
    repoDb.prepare("DELETE FROM repos WHERE name LIKE 'unit-a%'").run()
    equal(repoDb.prepare("SELECT count(*) c FROM repos WHERE name LIKE 'unit-a%'").get().c, 0, 'cleaned up again')
  })

  await check('the delete facts count what would really be lost, in flight included', () => {
    const id = repoDb.prepare('INSERT INTO repos(name,path) VALUES(?,?)').run('unit-fakten', '/tmp/unit-fakten').lastInsertRowid
    // try/finally, because this group writes into the sandbox database every
    // later group reads: a throw in the middle must not leave a repo behind.
    try {
      const leer = repoMod.repoDeleteFacts(id)
      equal(leer.runs, 0, 'a fresh repo has nothing to lose')
      equal(leer.inFlight, 0, 'and nothing in flight')

      const agentId = repoDb.prepare(`INSERT INTO agents(repo_id,name,harness,prompt,branch_mode,expected_minutes)
        VALUES(?,?,'claude','x','keiner',45)`).run(id, 'unit-agent').lastInsertRowid
      const lauf = (rid, status, report) => repoDb.prepare(`INSERT INTO runs(id,repo_id,agent_id,harness,prompt,branch_mode,expected_minutes,status,report_md)
        VALUES(?,?,?,'claude','x','keiner',45,?,?)`).run(rid, id, agentId, status, report)
      lauf('unit-r1', 'done', '# report')
      lauf('unit-r2', 'running', null)
      repoDb.prepare(`INSERT INTO events(run_id,kind) VALUES('unit-r1','started')`).run()
      repoDb.prepare(`INSERT INTO incidents(run_id,typ,quelle) VALUES('unit-r1','rate_limit','log')`).run()

      const f = repoMod.repoDeleteFacts(id)
      equal(f.runs, 2, 'both runs')
      equal(f.agents, 1, 'the agent')
      equal(f.reports, 1, 'only the run that really wrote a report')
      equal(f.events, 1, 'its event')
      equal(f.incidents, 1, 'its incident')
      equal(f.inFlight, 1, 'and the running one is what blocks a delete')
    } finally {
      repoDb.prepare("DELETE FROM events WHERE run_id LIKE 'unit-r%'").run()
      repoDb.prepare("DELETE FROM incidents WHERE run_id LIKE 'unit-r%'").run()
      repoDb.prepare('DELETE FROM runs WHERE repo_id=?').run(id)
      repoDb.prepare('DELETE FROM agents WHERE repo_id=?').run(id)
      repoDb.prepare('DELETE FROM repos WHERE id=?').run(id)
    }
  })

  await check('the options script is byte-identical in every skill that ships it', async () => {
    const { readFileSync: rf, readdirSync: rd, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('../skills', import.meta.url).pathname
    // A skill directory is copied standalone, so a shared tool has to exist in
    // each skill that needs it. Three copies is three chances to drift, which is
    // exactly what this pins: they must be the SAME file, byte for byte.
    const kopien = rd(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && ex(j(root, d.name, 'scripts', 'fl-options.py')))
      .map(d => [d.name, rf(j(root, d.name, 'scripts', 'fl-options.py'))])
    isTrue(kopien.length >= 2, `more than one skill ships it (${kopien.length})`)
    for (const [name, inhalt] of kopien.slice(1)) {
      isTrue(inhalt.equals(kopien[0][1]), `${name} matches ${kopien[0][0]} byte for byte`)
    }
  })

  await check('every shipped script is executable and free of a python cache', async () => {
    const { readdirSync: rd, statSync: st, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('../skills', import.meta.url).pathname
    for (const d of rd(root, { withFileTypes: true }).filter(x => x.isDirectory())) {
      const dir = j(root, d.name, 'scripts')
      if (!ex(dir)) continue
      isFalse(ex(j(dir, '__pycache__')), `${d.name}: no __pycache__ was committed`)
      for (const f of rd(dir)) {
        // A script a skill points at has to be runnable where it lands: the
        // installer copies modes through, so the bit has to be right here.
        isTrue((st(j(dir, f)).mode & 0o111) !== 0, `${d.name}/scripts/${f} is executable`)
      }
    }
  })

  await check('the group leaves no repo behind for the groups after it', () => {
    equal(repoDb.prepare("SELECT count(*) c FROM repos WHERE name LIKE 'unit-%'").get().c, 0,
      'every row this group inserted is gone again')
  })

  // ------------------------------------------------------------------
  group('Plugin registries (coding agents + providers)')
  const { HARNESS_PLUGINS, harnessIds } = await import('../server/harnesses/index.mjs')
  const { PROVIDER_PLUGINS, getProvider, providerHasKey } = await import('../server/providers/index.mjs')
  const { validateDescriptor } = await import('../server/plugins/manifest.mjs')

  await check('every coding agent plugin carries the required fields', () => {
    for (const p of Object.values(HARNESS_PLUGINS)) {
      isTrue(!!p.id && !!p.label && !!p.bin, `${p.id}: id/label/bin`)
      isTrue(typeof p.subscription === 'boolean', `${p.id}: subscription flag`)
      isTrue(Array.isArray(p.providers), `${p.id}: providers list`)
      isTrue(Array.isArray(p.logPatterns) && p.logPatterns.length > 0, `${p.id}: log patterns`)
      isTrue(typeof p.modelArgs === 'function', `${p.id}: modelArgs`)
      isTrue(typeof p.effortOptions === 'function', `${p.id}: effortOptions`)
      isTrue(typeof p.usage === 'function', `${p.id}: usage`)
      isTrue(typeof p.pulseId === 'function', `${p.id}: pulseId`)
    }
    // >= and not ==: the registry is mutable now, and an external package in
    // FREILAUF_PLUGIN_DIR is allowed to be in it. What must hold is that the four
    // built-ins are all still there.
    isTrue(harnessIds().length >= 4, `at least the four built-in coding agents (got ${harnessIds().length})`)
    for (const id of ['claude', 'opencode', 'hermes', 'cursor']) isTrue(harnessIds().includes(id), `built-in ${id}`)
  })

  // The optional half of the contract (docs/plugins.md). Every one of these
  // fields may be absent — a plugin without them stays valid, which is the
  // assertion that matters: the checks below run only WHEN a field is there,
  // and a `for` over an empty list is the passing case.
  await check('the optional plugin fields are shaped right where they exist — and optional where they do not', () => {
    const alle = [...Object.values(HARNESS_PLUGINS), ...Object.values(PROVIDER_PLUGINS)]
    isTrue(alle.length >= 7, 'both registries are populated')
    for (const p of alle) {
      if (p.credentials !== undefined) {
        isTrue(Array.isArray(p.credentials), `${p.id}: credentials is a list`)
        for (const c of p.credentials) {
          isTrue(!!c.key && typeof c.key === 'string', `${p.id}: credential has a key`)
          isTrue(Array.isArray(c.envKeys), `${p.id}.${c.key}: envKeys is a list`)
          if (c.required !== undefined) isTrue(typeof c.required === 'boolean', `${p.id}.${c.key}: required is a flag`)
        }
      }
      if (p.gate !== undefined) {
        isTrue(typeof p.gate.check === 'function', `${p.id}: gate.check`)
        isTrue(Array.isArray(p.gate.fields), `${p.id}: gate.fields is a list`)
        for (const f of p.gate.fields) {
          isTrue(!!f.key, `${p.id}: gate field has a key`)
          isTrue(['number', 'text', 'password', 'select', 'switch'].includes(f.type), `${p.id}.${f.key}: known field type`)
        }
      }
      if (p.llm !== undefined) {
        isTrue(typeof p.llm.complete === 'function', `${p.id}: llm.complete`)
        isTrue(['native', 'json_object', 'prompt'].includes(p.llm.schema), `${p.id}: llm.schema is one of the three`)
        if (p.llm.models !== undefined) isTrue(typeof p.llm.models === 'function', `${p.id}: llm.models`)
        if (p.llm.overhead !== undefined) isTrue(typeof p.llm.overhead === 'boolean', `${p.id}: llm.overhead is a flag`)
      }
      if (p.launch !== undefined) {
        isTrue(Array.isArray(p.launch.args) && p.launch.args.length > 0, `${p.id}: launch.args`)
        isTrue(['argv', 'stdin', 'file'].includes(p.launch.promptMode ?? 'argv'), `${p.id}: known promptMode`)
      }
      if (p.settings !== undefined) isTrue(Array.isArray(p.settings), `${p.id}: settings is a list`)
    }
    // And the negative half, so "optional" is not merely an untested word: a
    // descriptor carrying none of the four still passes validateDescriptor.
    const bare = {
      id: 'bare-provider', label: 'Bare', envKeys: ['BARE_KEY'], fetchModels: async () => [],
    }
    isTrue(validateDescriptor(bare, 'provider').ok, 'a provider with no credentials/gate/llm/launch is valid')
    const bareHarness = {
      id: 'bare-agent', label: 'Bare', bin: 'bare', subscription: false, providers: [],
      logPatterns: [{ typ: 'rate_limit', re: /x/ }],
      modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null,
    }
    isTrue(validateDescriptor(bareHarness, 'harness').ok, 'a coding agent with none of them is valid')
  })
  await check('harness provider references resolve to provider plugins', () => {
    for (const p of Object.values(HARNESS_PLUGINS)) {
      for (const id of p.providers) isTrue(!!getProvider(id), `${p.id} -> ${id}`)
      for (const id of p.keyFreeProviders ?? []) isTrue(p.providers.includes(id), `${p.id}: keyFree subset`)
      if (p.subscription) equal(p.providers.length, 0, `${p.id}: subscription = no providers`)
    }
  })
  await check('every provider plugin carries the required fields', () => {
    for (const p of Object.values(PROVIDER_PLUGINS)) {
      isTrue(!!p.id && !!p.label, `${p.id}: id/label`)
      isTrue(Array.isArray(p.envKeys), `${p.id}: envKeys`)
      isTrue(typeof p.fetchModels === 'function', `${p.id}: fetchModels`)
      isTrue(!!p.ocPrefix && !!p.mdKey, `${p.id}: ocPrefix/mdKey`)
      isTrue(!!p.pulse?.url, `${p.id}: pulse target`)
    }
  })

  // ---- balance(): the normalized shape (docs/plugins.md) ----
  // ctx is injected, so these run without a network and without a key file.
  const ctxMit = (antwort, env = {}) => ({ json: async () => antwort, registry: async () => ({}), env })

  await check('a provider balance keeps every currency apart', async () => {
    // DeepSeek reports strings and one entry PER currency — folding them into a
    // single figure would silently drop one of the two pots.
    const d = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '15.50', granted_balance: '0.50', topped_up_balance: '15.00' },
      ],
    }, { DEEPSEEK_API_KEY: 'k' }))
    equal(d.amounts.length, 2, 'both currencies survive')
    equal(d.amounts[0].currency, 'CNY', 'currency carried')
    equal(d.amounts[0].remaining, 110, 'string parsed to a number')
    equal(d.amounts[1].granted, 0.5, 'granted parsed too')
    isTrue(d.available === true, 'the provider\'s own verdict is carried')
  })
  await check('a provider that reports nothing usable answers null, not zero', async () => {
    const leer = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({ balance_infos: [] }, { DEEPSEEK_API_KEY: 'k' }))
    isTrue(leer === null, 'no amounts and no verdict = no answer')
    const ohne = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({}, {}))
    isTrue(ohne === null, 'no key = nothing to report')
    const kaputt = await PROVIDER_PLUGINS.openrouter.balance(
      ctxMit({ data: { total_credits: 'x', total_usage: null } }, { OPENROUTER_API_KEY: 'k' }))
    isTrue(kaputt === null, 'unusable numbers are no balance')
  })
  await check('an exhausted account is stated even when a figure remains', async () => {
    const d = await PROVIDER_PLUGINS.deepseek.balance(ctxMit({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: '2.00', granted_balance: '2.00', topped_up_balance: '0' }],
    }, { DEEPSEEK_API_KEY: 'k' }))
    isTrue(d.available === false, 'expired promotional credit still shows a number')
    equal(d.amounts[0].remaining, 2, 'and the number is reported as it stands')
  })
  await check('OpenRouter reports one pot, in dollars, with no verdict', async () => {
    const d = await PROVIDER_PLUGINS.openrouter.balance(
      ctxMit({ data: { total_credits: 20, total_usage: 7.125 } }, { OPENROUTER_API_KEY: 'k' }))
    equal(d.amounts.length, 1, 'one pot')
    equal(d.amounts[0].currency, 'USD', 'dollars, despite the _eur in the old setting name')
    equal(d.amounts[0].remaining, 12.88, 'credits minus usage, rounded to cents')
    isTrue(d.available === null, 'not reported is not the same as fine')
  })
  await check('remainingIn picks one currency and never guesses', async () => {
    const { remainingIn } = await import('../server/balances.mjs')
    const b = { amounts: [{ currency: 'CNY', remaining: 110 }, { currency: 'USD', remaining: 15.5 }] }
    equal(remainingIn(b, 'USD'), 15.5, 'the asked-for currency')
    isTrue(remainingIn(b, 'EUR') === null, 'an unknown currency is null, not 0')
    isTrue(remainingIn(null) === null, 'no balance is null, not 0')
  })
  await check('providerHasKey looks at the environment', () => {
    const alt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'test-key'
    isTrue(providerHasKey('openrouter'), 'with key')
    delete process.env.OPENROUTER_API_KEY
    isFalse(providerHasKey('openrouter'), 'without key')
    if (alt !== undefined) process.env.OPENROUTER_API_KEY = alt
  })

  // The included amount is the point here: it comes from Cursor's own period
  // endpoint (cents), so no plan has to be guessed. Fetch is stubbed — the test
  // must never talk to api2.cursor.sh.
  await check('cursor usage() takes spend, included amount and cycle from GetCurrentPeriodUsage', async () => {
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
      equal(d.plan, 'pro', 'plan')
      equal(d.included_usd, 20, 'included amount in dollars, from the server')
      equal(d.spent_usd, 0.13, 'spend belongs to the same source as the limit')
      equal(d.remaining_usd, 19.87, 'remaining')
      equal(d.cycle_end, '2026-09-14T16:45:55.000Z', 'cycle end')
    } finally {
      globalThis.fetch = echt
      if (altAuth === undefined) delete process.env.FREILAUF_CURSOR_AUTH
      else process.env.FREILAUF_CURSOR_AUTH = altAuth
    }
  })
  await check('cursor model list puts "auto" first and marks it', async () => {
    const bin = join(sandkasten, 'bin-cursor')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'cursor-agent'),
      '#!/bin/sh\necho "Available models"\necho ""\necho "zeta-1 - Zeta"\necho "auto - Auto (default)"\necho "alpha-1-fast - Alpha Fast"\n')
    chmodSync(join(bin, 'cursor-agent'), 0o755)
    const altPath = process.env.PATH
    process.env.PATH = `${bin}:${altPath}`
    try {
      const liste = await HARNESS_PLUGINS.cursor.fetchModels()
      equal(liste[0].id, 'auto', 'auto first, before every sorted ID')
      isTrue(liste[0].auto === true, 'marked as auto')
      equal(liste.at(-1).id, 'alpha-1-fast', 'fast still sorts last')
      isFalse(liste[1].auto, 'nothing else is auto')
    } finally { process.env.PATH = altPath }
  })

  // ------------------------------------------------------------------
  group('Plugin manifests: what a stranger\'s package must say (plugins/manifest.mjs)')

  // This is the one part of the plugin machinery that needs no sandbox and no
  // database — and it is what decides whether somebody else's directory is
  // allowed anywhere near the hub. Pure functions, so the edge cases are cheap.
  const { validateManifest, PLUGIN_API } = await import('../server/plugins/manifest.mjs')
  const gutesManifest = (over = {}) => ({
    api: 1, id: 'mistral', kind: 'provider', name: 'Mistral', version: '1.0.0',
    description: 'Mistral models', homepage: 'https://example.invalid', author: 'Someone', ...over,
  })

  await check('a good manifest is accepted and normalized', () => {
    const r = validateManifest(gutesManifest())
    isTrue(r.ok, `accepted (${r.problems.join('; ')})`)
    equal(r.value.id, 'mistral', 'id')
    equal(r.value.kind, 'provider', 'kind')
    equal(r.value.version, '1.0.0', 'version')
    // `main` is defaulted rather than demanded: a package that says nothing
    // about it means the file every example ships.
    equal(r.value.main, 'index.mjs', 'main defaults to index.mjs')
    equal(r.value.api, PLUGIN_API, 'the api the hub speaks')
  })
  await check('an explicit main is kept, one pointing outside the package is refused', () => {
    equal(validateManifest(gutesManifest({ main: 'src/plugin.mjs' })).value.main, 'src/plugin.mjs', 'kept')
    // A manifest that could name `../../.ssh/id_rsa` would let a package import
    // anything on the machine — the loader is handed a relative name or nothing.
    isFalse(validateManifest(gutesManifest({ main: '../evil.mjs' })).ok, 'a path escaping the package')
    isFalse(validateManifest(gutesManifest({ main: '/etc/passwd' })).ok, 'an absolute path')
    isFalse(validateManifest(gutesManifest({ main: '' })).ok, 'an empty main')
  })
  await check('a manifest for another api version is refused, and says so', () => {
    const r = validateManifest(gutesManifest({ api: 2 }))
    isFalse(r.ok, 'refused')
    isTrue(r.value === null, 'nothing to register')
    isTrue(r.problems.some(p => /api/i.test(p)), `the problem names the api (${r.problems.join('; ')})`)
    isFalse(validateManifest(gutesManifest({ api: '1' })).ok, 'a string "1" is not the number 1')
    isFalse(validateManifest(gutesManifest({ api: undefined })).ok, 'no api at all')
  })
  await check('a bad id is refused — the id is a directory name and a database key', () => {
    for (const id of ['Mistral', 'x', '', 'mi stral', '-lead', 'mistral!', 'a'.repeat(41)]) {
      isFalse(validateManifest(gutesManifest({ id })).ok, `refused: ${JSON.stringify(id)}`)
    }
    for (const id of ['ab', 'mistral-large', 'x9', 'a'.repeat(40)]) {
      isTrue(validateManifest(gutesManifest({ id })).ok, `accepted: ${JSON.stringify(id)}`)
    }
  })
  await check('a bad kind is refused — there are exactly three', () => {
    for (const kind of ['harness', 'provider', 'notifier']) isTrue(validateManifest(gutesManifest({ kind })).ok, kind)
    for (const kind of ['Harness', 'model', 'notify', '', undefined]) {
      isFalse(validateManifest(gutesManifest({ kind })).ok, `refused: ${JSON.stringify(kind)}`)
    }
  })
  await check('name and version are demanded; anything that is not an object is refused outright', () => {
    isFalse(validateManifest(gutesManifest({ name: '  ' })).ok, 'a blank name')
    isFalse(validateManifest(gutesManifest({ version: undefined })).ok, 'no version')
    for (const junk of [null, 'text', 42, ['a']]) isFalse(validateManifest(junk).ok, `refused: ${JSON.stringify(junk)}`)
  })

  await check('validateDescriptor holds both kinds to their minimum', () => {
    const p = { id: 'p', label: 'P', envKeys: ['P_KEY'], fetchModels: async () => [] }
    isTrue(validateDescriptor(p, 'provider').ok, 'a minimal provider')
    // `credentials` is the richer form of `envKeys`; either one satisfies it.
    isTrue(validateDescriptor({ ...p, envKeys: undefined, credentials: [{ key: 'api_key', envKeys: ['P_KEY'] }] }, 'provider').ok,
      'credentials instead of envKeys')
    isFalse(validateDescriptor({ ...p, envKeys: undefined }, 'provider').ok, 'neither of the two')
    isFalse(validateDescriptor({ ...p, fetchModels: undefined }, 'provider').ok, 'no fetchModels')
    isFalse(validateDescriptor({ ...p, label: '' }, 'provider').ok, 'no label')

    const h = {
      id: 'h', label: 'H', bin: 'hbin', subscription: false, providers: [],
      logPatterns: [{ typ: 'rate_limit', re: /x/ }],
      modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null,
    }
    isTrue(validateDescriptor(h, 'harness').ok, 'a minimal coding agent')
    isFalse(validateDescriptor({ ...h, bin: undefined }, 'harness').ok, 'no bin')
    isFalse(validateDescriptor({ ...h, subscription: 'yes' }, 'harness').ok, 'subscription must be a boolean')
    isFalse(validateDescriptor({ ...h, logPatterns: [] }, 'harness').ok, 'an empty log pattern list')
    isFalse(validateDescriptor({ ...h, pulseId: null }, 'harness').ok, 'a missing function')
    // …and the optional fields really are optional in BOTH directions: adding
    // them must not make a valid descriptor invalid either.
    isTrue(validateDescriptor({ ...h, credentials: [{ key: 'k', envKeys: [] }], gate: { fields: [], check: async () => null }, llm: { schema: 'prompt', complete: async () => ({}) }, launch: { args: ['x'] } }, 'harness').ok,
      'all four optional fields present')
    // A notifier's minimum is one function. Everything that makes it
    // configurable — settings, credentials, a setup wizard, a test — is
    // optional, because the smallest useful channel is a webhook with a URL in
    // a setting and a `send` that posts to it.
    const n = { id: 'n', label: 'N', send: async () => ({ ok: true }) }
    isTrue(validateDescriptor(n, 'notifier').ok, 'a minimal notifier')
    isFalse(validateDescriptor({ ...n, send: undefined }, 'notifier').ok, 'no send')
    isFalse(validateDescriptor({ ...n, send: 'yes' }, 'notifier').ok, 'send is not a function')
    isFalse(validateDescriptor({ ...n, label: '' }, 'notifier').ok, 'no label')
    isTrue(validateDescriptor({ ...n, settings: [{ key: 'url', type: 'text' }], credentials: [{ key: 'k', envKeys: [] }], setup: { render: async () => '' }, test: async () => ({ ok: true }) }, 'notifier').ok,
      'and every optional half present')

    isFalse(validateDescriptor(h, 'model-source').ok, 'an unknown kind')
    isFalse(validateDescriptor(null, 'harness').ok, 'no descriptor at all')
  })

  // ------------------------------------------------------------------
  group('The hub\'s own LLM calls: tolerant JSON (llm/json.mjs)')

  const { extractJson } = await import('../server/llm/json.mjs')

  await check('valid JSON is returned untouched — no repair may "fix" a correct answer', () => {
    const r = extractJson('{"title":"Fix the finish gate"}')
    isTrue(r.ok, 'parsed')
    equal(r.value.title, 'Fix the finish gate', 'value')
    equal(r.repaired.length, 0, 'nothing was repaired')
  })
  await check('a markdown fence with prose around it is cut out', () => {
    const r = extractJson('Sure, here is the JSON:\n```json\n{"title":"x"}\n```\nHope that helps!')
    isTrue(r.ok, 'parsed')
    equal(r.value.title, 'x', 'value')
    contains(r.note, 'fence', 'the note says where it was found')
    // The same without a language tag, and with a fence the model never closed.
    isTrue(extractJson('```\n{"a":1}\n```').ok, 'no language tag')
    isTrue(extractJson('here:\n```json\n{"a":1}').ok, 'an unclosed fence')
  })
  await check('a } inside a string value does not close the object', () => {
    // This is why the scan is a character scanner and not a regular expression:
    // a report sentence with a brace in it is the first thing that breaks one.
    const r = extractJson('{"title":"a } b","note":"and ] too","n":1}')
    isTrue(r.ok, 'parsed')
    equal(r.value.title, 'a } b', 'the brace stayed inside the string')
    equal(r.value.note, 'and ] too', 'so did the bracket')
    equal(r.value.n, 1, 'and the object really did close at the end')
    // Prose after a document that contains a brace must not shorten it either.
    const r2 = extractJson('Result: {"t":"} done"} — that is all.')
    isTrue(r2.ok && r2.value.t === '} done', 'cut out of prose without losing the brace')
  })
  await check('a trailing comma is repaired, and the repair is named', () => {
    const r = extractJson('{"a":1,"b":[1,2,],}')
    isTrue(r.ok, 'parsed')
    equal(r.value.b.length, 2, 'the array kept its two entries')
    isTrue(r.repaired.some(x => /trailing comma/.test(x)), `named (${r.repaired.join(', ')})`)
  })
  await check('single-quoted keys and values are re-quoted', () => {
    const r = extractJson("{'title': 'it\\'s fine', unquoted: 3}")
    isTrue(r.ok, 'parsed')
    equal(r.value.title, "it's fine", 'the escaped quote survived')
    equal(r.value.unquoted, 3, 'a bare key was quoted')
  })
  await check('typographic quotes are replaced with straight ones', () => {
    const r = extractJson('{“title”: “Schön”}')
    isTrue(r.ok, 'parsed')
    equal(r.value.title, 'Schön', 'value')
    isTrue(r.repaired.some(x => /typographic/.test(x)), `named (${r.repaired.join(', ')})`)
  })
  await check('NaN and Infinity become null rather than a parse failure', () => {
    const r = extractJson('{"a": NaN, "b": Infinity, "c": -Infinity, "d": +3}')
    isTrue(r.ok, 'parsed')
    isTrue(r.value.a === null && r.value.b === null && r.value.c === null, 'the three non-numbers are null')
    equal(r.value.d, 3, 'a stray leading + is dropped')
  })
  await check('a truncated document fails cleanly — no fragment is ever returned', () => {
    // The dangerous failure is not "it did not parse", it is "it parsed into
    // half an answer". Both shapes must answer ok:false with nothing in value.
    for (const text of ['{"a": "unterminat', '{"a": 1', '{"list": [1, 2', '{"a": "x\\']) {
      const r = extractJson(text)
      isFalse(r.ok, `refused: ${JSON.stringify(text)}`)
      isTrue(r.value === null, 'and value is null, not a fragment')
    }
    const prosa = extractJson('I am afraid I cannot do that.')
    isFalse(prosa.ok, 'prose with no JSON in it at all')
    contains(prosa.note, 'no candidate parsed', 'and the note says what was tried')
    const leer = extractJson('')
    isFalse(leer.ok, 'an empty answer')
    contains(leer.note, 'no JSON document found', 'and that one says there was nothing to try')
  })

  // ------------------------------------------------------------------
  group('The hub\'s own LLM calls: the schema subset (llm/schema.mjs)')

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

  await check('a required field that is missing is a problem, with its path', () => {
    const r = schemaValidate(SCHEMA, {})
    isFalse(r.ok, 'not valid')
    equal(r.problems.length, 1, 'exactly the one problem')
    equal(r.problems[0].path, 'data.title', 'the path a model can act on')
    contains(r.problems[0].message, 'required', 'and what is wrong')
    // An OPTIONAL field that is missing is not a problem — it becomes null so
    // nothing downstream ever meets undefined.
    isTrue(r.value.n === null, 'a missing optional is null')
  })
  await check('an enum violation names the path and the allowed values', () => {
    const r = schemaValidate(SCHEMA, { title: 't', mode: 'sideways' })
    isFalse(r.ok, 'not valid')
    equal(r.problems[0].path, 'data.mode', 'path')
    contains(r.problems[0].message, '"copy"', 'the allowed values are listed')
    contains(r.problems[0].message, '"link"', 'both of them')
    // A near miss is a coercion, not a failure: models answer "Copy" often
    // enough that rejecting it would cost an otherwise correct answer.
    const near = schemaValidate(SCHEMA, { title: 't', mode: ' Copy ' })
    isTrue(near.ok, 'a near miss is accepted')
    equal(near.value.mode, 'copy', 'and corrected to the declared spelling')
  })
  await check('the coercions: "true" is a boolean, "3" is a number, one value is a one-element array', () => {
    const r = schemaValidate(SCHEMA, { title: 't', n: '3', ok: 'true', list: 'only-one' })
    isTrue(r.ok, `valid (${JSON.stringify(r.problems)})`)
    equal(r.value.n, 3, 'numeric string')
    equal(r.value.ok, true, 'boolean word')
    isTrue(Array.isArray(r.value.list) && r.value.list.length === 1 && r.value.list[0] === 'only-one',
      'a single value became a one-element list')
    equal(schemaValidate(SCHEMA, { title: 't', ok: 'no' }).value.ok, false, '"no" is false')
    equal(schemaValidate(SCHEMA, { title: 't', ok: 1 }).value.ok, true, '1 is true')
    equal(schemaValidate(SCHEMA, { title: 42 }).value.title, '42', 'a number where a string was asked for')
    // What is NOT coerced: something that says nothing about the answer.
    isFalse(schemaValidate(SCHEMA, { title: 't', n: 'many' }).ok, '"many" is not a number')
    isFalse(schemaValidate(SCHEMA, { title: 't', ok: 'perhaps' }).ok, '"perhaps" is not a boolean')
    isFalse(schemaValidate(SCHEMA, { title: { a: 1 } }).ok, 'an object where a string was asked for')
  })
  await check('additionalProperties:false drops what was not asked for, it does not fail', () => {
    // A model that volunteers a "reasoning" field next to a correct answer has
    // still answered correctly.
    const r = schemaValidate(SCHEMA, { title: 't', reasoning: 'because', extra: [1, 2] })
    isTrue(r.ok, 'still valid')
    isFalse('reasoning' in r.value, 'the extra field is gone')
    isFalse('extra' in r.value, 'and so is the other one')
    // Without the keyword the extra field is kept — that is the difference.
    const offen = schemaValidate({ type: 'object', properties: { title: { type: 'string' } } },
      { title: 't', reasoning: 'because' })
    equal(offen.value.reasoning, 'because', 'an open schema keeps it')
  })
  await check('a nested problem carries the full path', () => {
    const r = schemaValidate(SCHEMA, { title: 't', list: ['a', 7, { b: 1 }] })
    isFalse(r.ok, 'not valid')
    equal(r.problems[0].path, 'data.list[2]', 'the offending index is named')
    equal(r.value.list[1], '7', 'the coercible neighbour was still coerced')
  })
  await check('the strict prompt forbids exactly what models do wrong', () => {
    const p = strictPrompt(SCHEMA, { schemaName: 'run_title' })
    contains(p, 'run_title', 'the schema is named')
    contains(p, 'code fences', 'fences are forbidden')
    contains(p, 'Schema:', 'the schema itself is shown')
    contains(p, '"title"', 'including its fields')
    // The example teaches the SHAPE; the enum contributes a real value because
    // that is the one place a real value teaches instead of tempting a copy.
    contains(p, '"copy"', 'the enum names its first value in the example')
  })

  // ------------------------------------------------------------------
  group('The hub\'s own LLM calls: the alarm throttle (llm/alerts.mjs)')

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
    await check('the first failure is sent, a second one inside the window is counted instead', async () => {
      alarmAufbauen()
      equal((await alarm({ nowMs: T0 })).reason, 'sent', 'the first one goes out')
      const zweite = await alarm({ nowMs: T0 + 60_000 })
      equal(zweite.reason, 'throttled', 'the second is held back')
      equal(zweite.suppressed, 1, 'and counted')
      equal((await alarm({ nowMs: T0 + 120_000 })).suppressed, 2, 'the count grows')
      equal(gesendet.length, 1, 'still one message on the wire')
    })
    await check('what was suppressed is named in the next message for that signature', async () => {
      // Silence about 47 swallowed failures would be a worse lie than 47
      // messages — the count is the whole reason the throttle is allowed.
      const nach = await alarm({ nowMs: T0 + 31 * 60_000 })
      equal(nach.reason, 'sent', 'past the window it goes out again')
      equal(gesendet.length, 2, 'the second message')
      contains(gesendet[1], '2 further failures', 'it names what was held back')
      equal(_alertState().signatures[alertSignature({ purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'http_401' })].suppressed, 0,
        'and a DELIVERED message forgets the count')
    })
    await check('a different signature is a different failure and is not throttled by the first', async () => {
      alarmAufbauen()
      equal((await alarm({ nowMs: T0 })).reason, 'sent', 'the first')
      equal((await alarm({ nowMs: T0, errorClass: 'no_json' })).reason, 'sent', 'another error class')
      equal((await alarm({ nowMs: T0, purpose: 'check' })).reason, 'sent', 'another caller')
      equal((await alarm({ nowMs: T0, model: 'other' })).reason, 'sent', 'another model')
      equal(gesendet.length, 4, 'four messages, four signatures')
      equal((await alarm({ nowMs: T0 })).reason, 'throttled', 'but the first signature is still held')
    })
    await check('the hourly ceiling holds across all signatures, and says how many it swallowed', async () => {
      alarmAufbauen()
      setzen('llm_alert_max_per_hour', '2')
      for (const p of ['title', 'check']) equal((await alarm({ nowMs: T0, purpose: p })).reason, 'sent', p)
      equal((await alarm({ nowMs: T0, purpose: 'extract' })).reason, 'ceiling', 'the third is over the ceiling')
      equal((await alarm({ nowMs: T0, purpose: 'extras' })).reason, 'ceiling', 'and so is the fourth')
      equal(gesendet.length, 2, 'two messages an hour means two messages')
      equal(_alertState().ceilingSuppressed, 2, 'and the hub knows how many it kept back')
      // An hour later the window has rolled and the ceiling reports itself.
      equal((await alarm({ nowMs: T0 + 61 * 60_000, purpose: 'extract' })).reason, 'sent', 'an hour on')
      contains(gesendet.at(-1), 'held back', 'the message names the ceiling')
    })
    await check('llm_alert_on=0 silences it completely', async () => {
      alarmAufbauen()
      setzen('llm_alert_on', '0')
      const r = await alarm({ nowMs: T0 })
      equal(r.reason, 'off', 'switched off')
      equal(gesendet.length, 0, 'nothing on the wire')
    })
    await check('an empty window or ceiling setting falls back to the default, not to zero', async () => {
      // Number('') is 0 AND finite — without the guard an unconfigured hub
      // would read every default as "never" (a ceiling of 0 messages).
      alarmAufbauen()
      setzen('llm_alert_window_min', '')
      setzen('llm_alert_max_per_hour', '')
      equal((await alarm({ nowMs: T0 })).reason, 'sent', 'the default ceiling still lets one through')
      equal((await alarm({ nowMs: T0 + 60_000 })).reason, 'throttled', 'the default window still throttles')
    })
    await check('a broken alarm channel is never the caller\'s problem', async () => {
      // A title, a flow step or a log hit must not be able to fail because the
      // alarm channel is having a bad day — in either of its two bad days.
      alarmAufbauen()
      global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
      const abgelehnt = await alarm({ nowMs: T0 })
      isTrue(abgelehnt.sent === false, 'the channel refused it')
      equal(abgelehnt.reason, 'unreachable', 'and that is the answer, not a throw')
      // A failed send KEEPS the count, so the next message still names those
      // failures — only a delivered one may forget them.
      alarmAufbauen()
      const kaputt = await alarm({ nowMs: T0, purpose: { toString() { throw new Error('boom') } } })
      isTrue(kaputt.sent === false, 'something inside threw')
      equal(kaputt.reason, 'error', 'and it came back as a result all the same')
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
  group('llmJson: transport classification and the OpenRouter recovery round')
  const { llmJson, classifyTransportError } = await import('../server/llm/index.mjs')
  const { setLanguage: sprache } = await import('../server/i18n.mjs')
  const { setSetting: setz, getSetting: lese } = await import('../server/db.mjs')
  sprache('en')   // the assertions below read the English catalog

  await check('classifyTransportError names the failure from the status code', () => {
    equal(classifyTransportError(new Error('HTTP 401')).kind, 'http_401', 'auth')
    equal(classifyTransportError(new Error('HTTP 402')).kind, 'http_402', 'credits')
    equal(classifyTransportError(new Error('HTTP 404')).kind, 'http_404', 'model')
    equal(classifyTransportError(new Error('HTTP 429')).kind, 'http_429', 'rate limit')
    equal(classifyTransportError(new Error('HTTP 503')).kind, 'http_5xx', '5xx are one class')
    equal(classifyTransportError(new Error('HTTP 500')).kind, 'http_5xx', '500 too')
    equal(classifyTransportError(new Error('HTTP 503')).code, 503, 'the code is kept for the message')
    const timeout = new Error('This operation was aborted')
    timeout.name = 'TimeoutError'
    equal(classifyTransportError(timeout).kind, 'timeout', 'a timeout is its own class')
    equal(classifyTransportError(new Error('ENOTFOUND api.openrouter.ai')).kind, 'transport', 'anything else stays generic')
  })
  await check('a non-2xx answer fails with a classified, translated detail — and no reprompt', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'unit-key'
    const versucheAlt = lese('llm_retry_attempts')
    setz('llm_retry_attempts', '0')   // this test pins the NO-REPROMPT rule, not the retry policy
    const echt = globalThis.fetch
    let chats = 0
    globalThis.fetch = async () => { chats++; return { ok: false, status: 429, json: async () => ({}) } }
    try {
      const r = await llmJson({
        source: 'provider:openrouter', model: 'a/b', prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      isFalse(r.ok, 'the call failed')
      equal(r.stage, 'transport', 'the bucket stays transport')
      equal(r.kind, 'http_429', 'and the specific class is carried for the caller')
      equal(chats, 1, 'a transport failure is never reprompted — with the retry budget at 0, exactly one call')
      contains(r.error, 'Rate limit reached (HTTP 429)', 'the detail names the problem in English')
      contains(r.error, 'too often', 'and what it means')
    } finally {
      globalThis.fetch = echt
      setz('llm_retry_attempts', versucheAlt ?? '')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await check('a transport failure walks the chain to the fallback before any retry', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'unit-key'
    const versucheAlt = lese('llm_retry_attempts')
    setz('llm_retry_attempts', '0')   // the fallback is tried even at 0 — the whole point of the first walk
    const echt = globalThis.fetch
    const aufrufe = { or: 0, zen: 0 }
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('openrouter.ai')) {
        aufrufe.or++
        return { ok: false, status: 503, json: async () => ({}) }
      }
      if (u.includes('opencode.ai/zen/v1/chat')) {
        aufrufe.zen++
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"title":"Fixed login"}' } }] }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    try {
      const r = await llmJson({
        source: 'provider:openrouter', model: 'a/b',
        fallbacks: [{ source: 'provider:opencode-zen', model: 'zen-model' }],
        prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      isTrue(r.ok, 'the fallback answered')
      equal(r.source, 'provider:opencode-zen', 'the result names the source that actually answered')
      equal(r.model, 'zen-model', 'and the model it answered with')
      equal(aufrufe.or, 1, 'the primary was asked once')
      equal(aufrufe.zen, 1, 'the fallback took over — no backoff, no wait')
      equal(r.data.title, 'Fixed login', 'the answer came from the fallback')
    } finally {
      globalThis.fetch = echt
      setz('llm_retry_attempts', versucheAlt ?? '')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await check('a misconfigured primary does not block a working fallback — and an all-config chain stays a config answer', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY   // the primary now has no credential: a config answer, not an outage
    const echt = globalThis.fetch
    let zen = 0
    globalThis.fetch = async (url) => {
      if (String(url).includes('opencode.ai/zen/v1/chat')) {
        zen++
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"title":"Still named"}' } }] }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    try {
      const r = await llmJson({
        source: 'provider:openrouter', model: 'a/b',
        fallbacks: [{ source: 'provider:opencode-zen', model: 'zen-model' }],
        prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      isTrue(r.ok, 'a skipped config entry is not a verdict about the chain')
      equal(r.source, 'provider:opencode-zen', 'the fallback carried the question')
      const zwei = await llmJson({
        source: 'provider:openrouter', model: 'a/b',
        fallbacks: [{ source: 'provider:nope', model: 'm' }],
        prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      isFalse(zwei.ok, 'nothing usable in the whole chain')
      equal(zwei.stage, 'config', 'all-config is a CONFIG answer, never a transport failure')
      contains(zwei.error, 'OpenRouter', 'the error names the PRIMARY — what the operator chose')
      equal(zen, 1, 'the unusable second chain entry was never fetched')
    } finally {
      globalThis.fetch = echt
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
    }
  })
  await check('when the whole chain is down, the chain retries with backoff — bounded by llm_retry_attempts', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'unit-key'
    const alt = { a: lese('llm_retry_attempts'), b: lese('llm_retry_base_ms'), c: lese('llm_retry_max_ms') }
    setz('llm_retry_attempts', '3')
    setz('llm_retry_base_ms', '1')
    setz('llm_retry_max_ms', '4')
    const echt = globalThis.fetch
    let chats = 0
    globalThis.fetch = async () => { chats++; return { ok: false, status: 503, json: async () => ({}) } }
    try {
      const r = await llmJson({
        source: 'provider:openrouter', model: 'a/b', prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      isFalse(r.ok, 'the provider stayed down')
      equal(r.stage, 'transport', 'and the failure stays a transport failure')
      equal(chats, 3, 'exactly llm_retry_attempts attempts, pauses included')
    } finally {
      globalThis.fetch = echt
      setz('llm_retry_attempts', alt.a ?? '')
      setz('llm_retry_base_ms', alt.b ?? '')
      setz('llm_retry_max_ms', alt.c ?? '')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await check('backoffDelayMs doubles with jitter and never leaves the ceiling', async () => {
    const { backoffDelayMs } = await import('../server/llm/index.mjs')
    const politik = { baseMs: 1000, maxMs: 4000 }
    for (let i = 0; i < 50; i++) {
      const r0 = backoffDelayMs(0, politik)
      isTrue(r0 >= 500 && r0 <= 1500, `round 0 jitters within half the base (${r0})`)
      const r2 = backoffDelayMs(2, politik)
      isTrue(r2 >= 2000 && r2 <= 4000, `round 2 is capped at maxMs (${r2})`)
    }
    equal(backoffDelayMs(10, { baseMs: 1000, maxMs: 0 }), 0, 'a zero ceiling stays zero — an explicit 0 is honoured')
  })
  await check('a parse failure does NOT fall back — the provider is up, the answer is the problem', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'unit-key'
    const echt = globalThis.fetch
    let or = 0
    let zen = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('openrouter.ai')) { or++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'prose, no JSON' } }] }) } }
      if (u.includes('opencode.ai/zen/v1/chat')) { zen++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"title":"Would have worked"}' } }] }) } }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    try {
      const r = await llmJson({
        source: 'provider:openrouter', model: 'a/b',
        fallbacks: [{ source: 'provider:opencode-zen', model: 'zen-model' }],
        prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      isFalse(r.ok, 'prose is prose')
      equal(r.stage, 'parse', 'an answer problem stays an answer problem')
      isTrue(or >= 2, 'the repair rounds ran on the primary')
      equal(zen, 0, 'the fallback was never asked — falling back would hide which source cannot obey the schema')
    } finally {
      globalThis.fetch = echt
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await check('a parse failure on OpenRouter re-asks once through a FRESH best-provider selection', async () => {
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
      equal(chats, 3, 'first + repair + recovery round = three calls')
      equal(endpoints, 1, 'the recovery round re-selects the serving provider')
      isFalse(r.ok, 'prose is prose — the honest failure still arrives')
      equal(r.stage, 'parse', 'and stays a parse problem')
      contains(r.error, 'could not be read as JSON', 'the detail says what happened')
      contains(r.error, 'Re-selecting the best serving provider', 'and that the recovery round was already spent')
      const zweite = await llmJson(frage)
      equal(endpoints, 2, 'the SECOND recovery round still resolves FRESH — the cache is bypassed')
      isFalse(zweite.ok, 'and still fails honestly')
    } finally {
      globalThis.fetch = echt
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await check('a validate failure carries the model\'s raw answer — the diagnosis the error sentence cannot give', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'unit-key'
    const echt = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/endpoints')) {
        return { ok: true, json: async () => ({ data: { endpoints: [
          { tag: 'p/fp8', provider_name: 'P', quantization: 'fp8', status: 0, uptime_last_30m: 100,
            supported_parameters: ['tools'], pricing: { prompt: '0.0000001', completion: '0.0000002' } },
        ] } }) }
      }
      // Valid JSON — but a string where an object was asked for: exactly the
      // shape the alert reported as "expected an object, got a string" while
      // hiding the one thing that would have explained it.
      return { ok: true, json: async () => ({ choices: [{ message: { content: '"only a string, no object"' } }] }) }
    }
    try {
      const r = await llmJson({
        source: 'provider:openrouter', model: 'deepseek/deepseek-v4-flash', prompt: 'Name this task',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title', maxTokens: 200,
      })
      isFalse(r.ok, 'a string is not an object')
      equal(r.stage, 'validate', 'it parsed, so the failure is a validate failure')
      contains(r.answer, 'only a string, no object', 'the raw answer travels with the failure')
      contains(r.error, 'expected an object, got a string', 'and the complaint names the shape')
    } finally {
      globalThis.fetch = echt
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await check('llmAlert names a classified failure in the operator\'s language', async () => {
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
      equal(r.reason, 'sent', 'the alert went out')
      contains(gesendet[0], 'What went wrong: rate limit', 'the kind line is translated')
      contains(gesendet[0], 'Detail: Rate limit reached (HTTP 429)', 'and the detail follows')
      // An unknown class falls back to the code, never to a made-up sentence.
      await llmAlert({ purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'http_408', text: 'x' })
      contains(gesendet.at(-1), 'What went wrong: http_408', 'unknown classes stay honest')
      // A schema failure quotes what the model actually said — a bare "did not
      // match" is a diagnosis half missing.
      await llmAlert({ purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'validate', text: 'The model answered with JSON, but it did not match the required structure.', answer: '{"title": 7}' })
      contains(gesendet.at(-1), 'answer (excerpt)', 'the answer travels in its own translated line')
      contains(gesendet.at(-1), '{"title": 7}', 'with what the model actually said')
    } finally {
      globalThis.fetch = echt
      _alertReset()
      setz('telegram_token', tokenVorher ?? '')
      setz('telegram_chat', chatVorher ?? '')
    }
  })
  // ------------------------------------------------------------------
  group('Notifications: the third plugin kind, and a hub that says nothing (notify.mjs)')

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

  await check('the built-in Telegram notifier is registered as its own kind', () => {
    equal(artVon('telegram'), 'notifier', 'the registry knows what it is')
    const p = holePlugin('telegram')
    isTrue(typeof p?.send === 'function', 'it can send')
    // Its two settings keep the keys they have always had — that is what makes
    // the whole rebuild a no-migration change.
    const keys = (p.settings ?? []).map(f => f.settingKey)
    equal(keys.sort().join(','), 'telegram_chat,telegram_token', 'the historic settings keys')
    isTrue((p.settings ?? []).every(f => f.required), 'both are required, which is what "configured" means here')
    isTrue(notifyMod.notifierPlugins().some(x => x.id === 'telegram'), 'and the facade lists it')
  })

  await check('a duplicate notifier id is refused, never overridden', () => {
    const vorher = registerFehler().length
    const r = registriere({ id: 'telegram', kind: 'notifier', label: 'Not really', send: async () => ({ ok: true }) })
    isFalse(r.ok, 'refused')
    contains(r.error, 'already taken', 'and it says why')
    equal(registerFehler().length, vorher + 1, 'the refusal is recorded for the Plugins page')
    equal(holePlugin('telegram').label, 'Telegram', 'the built-in still stands')
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
      await check('an external notifier joins the registry and is configured like any other plugin', () => {
        isTrue(reg.ok, `registered (${reg.error ?? ''})`)
        equal(artVon('unit-notifier'), 'notifier', 'as a notifier')
        // Registered is not configured: a `required` setting with no value is
        // exactly what keeps the hub quiet.
        isFalse(notifyMod.notifierConfigured('unit-notifier'), 'not configured yet')
        // An unconfigured notifier is nevertheless ENABLED — the provider rule,
        // and for a reason one step stronger: an installation that already had
        // a token has no plugin_config row either, and an off-by-default
        // notifier would silence a channel that worked the minute before.
        isTrue(isPluginEnabled('unit-notifier'), 'but switched on by default')
      })

      await check('with nothing configured notify() is a silent no-op, and says so calmly', async () => {
        isFalse(notifyMod.notifiersConfigured(), 'nothing is configured')
        const r = await notifyMod.notify({ kind: 'system', text: 'nobody hears this' })
        isFalse(r.sent, 'nothing was sent')
        equal(r.delivered, 0, 'nothing was delivered')
        equal(r.results.length, 0, 'and nobody was even asked')
        equal(empfangen.length, 0, 'the stub heard nothing')
        // The one thing it must never do.
        const leer = await notifyMod.notify('')
        isFalse(leer.sent, 'an empty message is not an error either')
      })

      await check('a configured notifier receives the normalized message', async () => {
        setzen('plugin_unit-notifier_target', '/dev/null')
        isTrue(notifyMod.notifierConfigured('unit-notifier'), 'the required setting is filled in')
        isTrue(notifyMod.notifiersConfigured(), 'so the hub has a channel')
        const r = await notifyMod.notify({ kind: 'run', runId: 'r-1', text: 'hello', url: 'https://x.invalid/runs/r-1',
          attachment: { fileName: 'report.md', content: 'the whole report' } })
        isTrue(r.sent, 'delivered')
        equal(r.results.length, 1, 'one channel was asked')
        const m = empfangen.at(-1)
        equal(m.kind, 'run', 'kind')
        equal(m.runId, 'r-1', 'runId')
        equal(m.text, 'hello', 'text')
        equal(m.attachment.fileName, 'report.md', 'the attachment travels as a file name plus content')
        isTrue(String(m.linkLabel).length > 0, 'the link carries a label the channel can render')
        equal(m.html, null, 'html is offered but the hub composes plain text')
      })

      await check('a bare string is accepted, and an empty attachment is no attachment', async () => {
        await notifyMod.notify('just a line')
        equal(empfangen.at(-1).text, 'just a line', 'the string became the text')
        equal(empfangen.at(-1).kind, 'system', 'with the default kind')
        await notifyMod.notify({ text: 'x', attachment: { fileName: 'a.md', content: '' } })
        equal(empfangen.at(-1).attachment, null, 'an empty file is dropped rather than sent as nothing')
      })

      await check('a channel that throws costs its own message and nothing else', async () => {
        notifyMod._notifyLogReset()
        const kaputt = {
          id: 'unit-broken', kind: 'notifier', label: 'Broken',
          async send() { throw new Error('the api is on fire') },
        }
        const r2 = registriere(kaputt, { source: 'external' })
        isTrue(r2.ok, 'the broken one is registered too')
        try {
          const r = await notifyMod.notify({ kind: 'system', text: 'through both' })
          isTrue(r.sent, 'the working channel still took it')
          equal(r.delivered, 1, 'exactly one delivery')
          equal(r.results.length, 2, 'both were asked')
          const bad = r.results.find(x => x.id === 'unit-broken')
          isFalse(bad.ok, 'the broken one failed')
          contains(bad.error, 'on fire', 'with its own message')
          equal(empfangen.at(-1).text, 'through both', 'and the good one got the message')
        } finally { entferne('unit-broken') }
      })

      await check('sendTest calls test() with the SAME arguments as send()', async () => {
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
        isTrue(registriere(zwei, { source: 'external' }).ok, 'registered')
        try {
          const r = await notifyMod.sendTest('unit-two')
          isTrue(r.ok, 'the test message went out')
          const [was, message, ctx] = gesehen.at(-1)
          equal(was, 'test', 'test() wins over send() when it exists')
          equal(message.kind, 'test', 'the FIRST argument is the message')
          isTrue(typeof ctx?.setting === 'function', 'and the SECOND is the plugin context')
          isTrue(String(message.text).length > 0, 'which carries text')
        } finally {
          entferne('unit-two')
          unitDb.prepare('DELETE FROM plugin_config WHERE plugin_id=?').run('unit-two')
        }
      })

      await check('switching it off silences it, and sendTest says which of the two it was', async () => {
        setPluginConfig('unit-notifier', { kind: 'notifier', enabled: 0 })
        isFalse(notifyMod.notifiersConfigured(), 'a disabled channel is no channel')
        const vorher = empfangen.length
        await notifyMod.notify('into the void')
        equal(empfangen.length, vorher, 'nothing was sent')
        // The reason comes back as an i18n KEY, not as an English word: it is
        // rendered to the operator on the Notifications page (and reached from
        // the Telegram wizard's own step 3), so a raw sentence there would be
        // English text on a German UI.
        const t1 = await notifyMod.sendTest('unit-notifier')
        isFalse(t1.ok, 'the test refuses')
        equal(t1.errorKey, 'notify.err_disabled', 'naming the reason, translatably')
        setPluginConfig('unit-notifier', { kind: 'notifier', enabled: 1 })
        setzen('plugin_unit-notifier_target', '')
        equal((await notifyMod.sendTest('unit-notifier')).errorKey, 'notify.err_not_configured', 'the other reason is its own answer')
        equal((await notifyMod.sendTest('nope')).errorKey, 'notify.err_unknown', 'and an id nobody registered is a third')
        const katalog = JSON.parse(readFileSync(new URL('../lang/en.json', import.meta.url), 'utf8'))
        for (const k of ['notify.err_disabled', 'notify.err_not_configured', 'notify.err_unknown']) {
          isTrue(!!katalog[k], `${k} really exists in the catalog`)
        }
      })
    } finally {
      entferne('unit-notifier')
      unitDb.prepare('DELETE FROM plugin_config WHERE plugin_id IN (?,?)').run('unit-notifier', 'unit-broken')
      setzen('plugin_unit-notifier_target', '')
    }
  }

  await check('the notify flow step keeps its old type name as an alias, never as a second block', async () => {
    const { STEP_MAP, STEP_ALIASES, renameSteps, stepsMeta } = await import('../server/flows/steps.mjs')
    equal(STEP_ALIASES.telegram, 'notify', 'the rename is declared once')
    isTrue(STEP_MAP.notify === STEP_MAP.telegram, 'a stored `telegram` step resolves to the notify step')
    isFalse(stepsMeta().some(x => x.type === 'telegram'), 'but the toolbox offers one block, not two')

    // A definition read out of the database comes back in today's names —
    // inside branches and container bodies too, because a rename that stops at
    // the top level renames half a flow.
    const alt = { properties: {}, sequence: [
      { id: 'a', type: 'telegram', properties: { text: 'x' } },
      { id: 'b', type: 'condition', branches: { true: [{ id: 'c', type: 'telegram', properties: {} }], false: [] } },
      { id: 'd', type: 'for_each', sequence: [{ id: 'e', type: 'telegram', properties: {} }] },
    ] }
    const neu = renameSteps(alt)
    equal(neu.sequence[0].type, 'notify', 'at the top level')
    equal(neu.sequence[1].branches.true[0].type, 'notify', 'inside a branch')
    equal(neu.sequence[2].sequence[0].type, 'notify', 'inside a container body')
    equal(alt.sequence[0].type, 'telegram', 'and the input was not mutated')
    // Anything it cannot walk comes back as it came, rather than throwing.
    equal(renameSteps(null), null, 'null')
    equal(renameSteps({ sequence: 'nonsense' }).sequence, 'nonsense', 'a shape it does not know')
  })

  // ------------------------------------------------------------------
  group('Model sources and plugin settings (llm/sources.mjs, plugins/settings.mjs)')

  const { parseSource, sourceId, DEFAULT_SOURCE } = await import('../server/llm/sources.mjs')

  await check('an unprefixed source reads as provider:openrouter — that is the whole backwards compatibility', () => {
    // Every stored `llm_*_source` an existing installation has is empty or a
    // legacy value. Reading those as OpenRouter is what makes a hub that
    // changes nothing behave byte for byte as it did.
    equal(DEFAULT_SOURCE, 'provider:openrouter', 'the documented default')
    for (const value of ['', '   ', null, undefined, 'openrouter', 'deepseek/deepseek-v4-flash', 'weird:thing']) {
      const s = parseSource(value)
      equal(`${s.kind}:${s.pluginId}`, 'provider:openrouter', `${JSON.stringify(value)} reads as the default`)
    }
  })
  await check('provider:x and agent:x are read as themselves', () => {
    equal(parseSource('provider:deepseek').kind, 'provider', 'provider kind')
    equal(parseSource('provider:deepseek').pluginId, 'deepseek', 'provider id')
    equal(parseSource('agent:claude').kind, 'agent', 'agent kind')
    equal(parseSource('agent:claude').pluginId, 'claude', 'agent id')
    equal(parseSource('  provider: deepseek  ').pluginId, 'deepseek', 'whitespace is trimmed')
    // An id with a dash in it is the ordinary case (opencode-zen).
    equal(parseSource('provider:opencode-zen').pluginId, 'opencode-zen', 'a dashed id')
  })
  await check('sourceId is parseSource\'s inverse, and calls a harness an agent', () => {
    equal(sourceId('provider', 'deepseek'), 'provider:deepseek', 'a provider')
    // The registry says `harness`; the source string says `agent`, because that
    // is the word the picker shows.
    equal(sourceId('harness', 'claude'), 'agent:claude', 'a coding agent')
    for (const id of ['provider:deepseek', 'agent:claude']) {
      const s = parseSource(id)
      equal(sourceId(s.kind, s.pluginId), id, `round trip: ${id}`)
    }
  })

  // ------------------------------------------------------------------
  group('The LLM job chain: fallback planning (llm/job.mjs)')
  const job = await import('../server/llm/job.mjs')

  await check('parseFallbackList is STRICT, the opposite of parseSource — junk means no fallback', async () => {
    equal(job.parseFallbackList('').join(','), '', 'empty')
    equal(job.parseFallbackList(null).join(','), '', 'null')
    equal(job.parseFallbackList('agent:claude').join(','), 'agent:claude', 'one source')
    equal(job.parseFallbackList('agent:claude, provider:deepseek').join(','), 'agent:claude,provider:deepseek', 'an ordered chain, whitespace ignored')
    // A half-typed value must never silently re-point a fallback at OpenRouter.
    equal(job.parseFallbackList('deepseek').join(','), '', 'an unprefixed id is NOT the default here')
    equal(job.parseFallbackList('agent:x!y provider:deepseek').join(','), 'provider:deepseek', 'a broken id is dropped, the rest survives')
    equal(job.parseFallbackList('provider:opencode-zen').join(','), 'provider:opencode-zen', 'a dashed id survives')
  })
  await check('jobFallbacks inherits the primary model unless a fallback model is set', async () => {
    const alt = { a: lese('llm_title_fallback'), b: lese('llm_title_fallback_model') }
    setz('llm_title_fallback', 'agent:claude,provider:deepseek')
    try {
      const ohne = job.jobFallbacks('title', 'deepseek/deepseek-v4-flash')
      equal(ohne.length, 2, 'both entries are planned')
      equal(ohne[0].model, 'deepseek/deepseek-v4-flash', 'the primary model is inherited')
      equal(ohne[1].source, 'provider:deepseek', 'in order')
      setz('llm_title_fallback_model', 'anthropic/claude-sonnet-4')
      const mit = job.jobFallbacks('title', 'deepseek/deepseek-v4-flash')
      equal(mit[0].model, 'anthropic/claude-sonnet-4', 'an explicit fallback model wins')
    } finally {
      setz('llm_title_fallback', alt.a ?? '')
      setz('llm_title_fallback_model', alt.b ?? '')
    }
  })
  await check('chainUsable is true when the PRIMARY is broken but a fallback is not', async () => {
    const keyAlt = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY   // OpenRouter unusable: no credential
    const alt = lese('llm_title_fallback')
    // An unconfigured coding agent is OFF — the same rule that keeps a fresh
    // installation free of agents. The fallback picker only ever offers enabled
    // sources, and usability follows the same gate.
    const { setPluginConfig: setzePlugin, pluginConfig: pluginAn } = await import('../server/plugins/store.mjs')
    const { default: jobDb } = await import('../server/db.mjs')
    const claudeVorher = pluginAn('claude')
    setzePlugin('claude', { enabled: 1 })
    try {
      setz('llm_title_fallback', '')
      isFalse(job.chainUsable('title', 'm'), 'no fallback: the broken primary decides')
      setz('llm_title_fallback', 'agent:claude')
      isTrue(job.chainUsable('title', 'm'), 'an agent fallback needs no credential, no model')
      setz('llm_title_fallback', 'provider:nope')
      isFalse(job.chainUsable('title', 'm'), 'an unknown fallback source is not usable')
    } finally {
      setz('llm_title_fallback', alt ?? '')
      if (claudeVorher) setzePlugin('claude', { enabled: claudeVorher.enabled })
      else jobDb.prepare('DELETE FROM plugin_config WHERE plugin_id=?').run('claude')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
    }
  })

  const { pluginSettingKey, allPluginSettingKeys, pluginFields } =
    await import('../server/plugins/settings.mjs')

  await check('a declared settingKey keeps history; without one the key is namespaced', () => {
    // This is what makes the rebuild need NO settings migration: the built-in
    // gates declare the keys they have always used.
    equal(pluginSettingKey('claude', { key: 'g5h', settingKey: 'claude_gate_5h' }), 'claude_gate_5h', 'the historic key')
    equal(pluginSettingKey('mistral', { key: 'threshold' }), 'plugin_mistral_threshold', 'namespaced')
    // Two plugins declaring the same field name is harmless, which is the point.
    isTrue(pluginSettingKey('a', { key: 'threshold' }) !== pluginSettingKey('b', { key: 'threshold' }),
      'two plugins, two keys')
  })
  await check('allPluginSettingKeys carries every historic gate key', () => {
    // A key missing from this list is silently dropped by the settings form's
    // allowlist — the threshold would look configurable and never stick.
    const keys = allPluginSettingKeys()
    for (const k of ['claude_gate_on', 'claude_gate_5h', 'claude_gate_7d', 'claude_gate_fable',
      'cursor_gate_on', 'cursor_gate_pct', 'cursor_included_usd',
      'openrouter_gate_on', 'openrouter_min_eur', 'deepseek_gate_on', 'deepseek_min_usd']) {
      isTrue(keys.includes(k), `${k} is in the allowlist`)
    }
    equal(keys.length, new Set(keys).size, 'no duplicates')
  })
  await check('pluginFields answers with a list for anything, including nothing', () => {
    equal(pluginFields(null).length, 0, 'no plugin')
    equal(pluginFields({}, 'gate').length, 0, 'no gate')
    equal(pluginFields({ settings: 'nonsense' }).length, 0, 'a settings field that is not a list')
    equal(pluginFields({ settings: [{ key: 'a' }, {}, null, { key: '' }] }).length, 1, 'entries without a key are dropped')
  })

  // ------------------------------------------------------------------
  group('The launch declaration: how an external coding agent is started (runner.mjs)')

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
    await check('the four built-ins need no spec — fl-start already knows them', () => {
      // A spec for claude would be a second description of the same launch
      // line, and the two would drift. `launchable` still says yes.
      for (const id of ['claude', 'opencode', 'hermes', 'cursor']) {
        isTrue(launchSpec(id) === null, `${id}: no spec`)
        isTrue(launchable(id), `${id}: startable all the same`)
      }
    })
    await check('an external descriptor\'s launch declaration is resolved into a spec', () => {
      isTrue(eintragen(testHarness({
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
      isTrue(!!spec, 'a spec came out')
      equal(spec.harness, 'unit-launch', 'the harness is named in the spec')
      // Resolved, not passed through: bin/sessionTag/installHint are ordinary
      // descriptor fields, and a launch block that says nothing about them
      // means the ones declared next to the id.
      equal(spec.bin, 'testbin', 'bin comes from the descriptor')
      equal(spec.sessionTag, 'ul', 'session tag')
      equal(spec.installHint, 'npm i -g unit-launch', 'install hint')
      equal(spec.args.join(' '), 'run --model {model} {prompt}', 'the arguments as declared')
      equal(spec.promptMode, 'argv', 'prompt mode')
      equal(spec.interactiveArgs.join(' '), '-i', 'interactive arguments')
      equal(spec.submitNudge.waitFor, 'ctrl+p', 'the submit nudge survives as an object')
      isTrue(launchable('unit-launch'), 'and it is startable')
    })
    await check('a launch block may name its own bin, and defaults promptMode to argv', () => {
      isTrue(eintragen(testHarness({ id: 'unit-ownbin', launch: { bin: 'other-bin', args: ['go'] } })).ok, 'registered')
      const spec = launchSpec('unit-ownbin')
      equal(spec.bin, 'other-bin', 'the launch block wins over the descriptor')
      equal(spec.promptMode, 'argv', 'the default prompt mode')
      isFalse('interactiveArgs' in spec, 'nothing is invented that was not declared')
      isFalse('submitNudge' in spec, 'and a nudge that was not asked for is absent')
    })
    await check('a coding agent with neither a fl-start case nor a launch block cannot be started', () => {
      // Better to refuse before a worktree exists than to read it out of
      // fl-start's stderr afterwards — a tmux session running nothing.
      isTrue(eintragen(testHarness({ id: 'unit-nolaunch' })).ok, 'registered')
      isTrue(launchSpec('unit-nolaunch') === null, 'no spec')
      isFalse(launchable('unit-nolaunch'), 'and not startable')
      // An empty or malformed args list is the same answer, not a broken spec.
      isTrue(eintragen(testHarness({ id: 'unit-emptyargs', launch: { args: [] } })).ok, 'registered')
      isFalse(launchable('unit-emptyargs'), 'an empty args list is no declaration')
      isTrue(eintragen(testHarness({ id: 'unit-badargs', launch: { args: 'run' } })).ok, 'registered')
      isFalse(launchable('unit-badargs'), 'a string is no argument list')
      isFalse(launchable('never-registered'), 'an unknown coding agent')
    })
    await check('an id that is already taken is refused, never silently overridden', () => {
      // A package shadowing `claude` could replace the coding agent every run
      // is started with, without saying so anywhere.
      const r = registerPlugin(testHarness({ id: 'claude' }), { source: 'external' })
      isFalse(r.ok, 'refused')
      contains(r.error, 'already taken', 'and it says why')
      equal(launchSpec('claude'), null, 'the built-in is untouched')
      isFalse(registerPlugin(testHarness({ id: 'Not Valid' }), { source: 'external' }).ok, 'an invalid id')
      isFalse(registerPlugin(testHarness({ id: 'unit-nokind', kind: 'model' }), { source: 'external' }).ok, 'an unknown kind')
      isFalse(registerPlugin({ id: 'unit-broken', kind: 'harness', label: 'B' }, { source: 'external' }).ok,
        'a descriptor that does not meet the contract')
    })
    await check('a built-in is never unregistered; an external one is', () => {
      isFalse(unregisterPlugin('claude').ok, 'a built-in stays — it is part of the running code')
      isTrue(unregisterPlugin('unit-badargs').ok, 'an external one goes')
      eingetragen.splice(eingetragen.indexOf('unit-badargs'), 1)
      isFalse(launchable('unit-badargs'), 'and is gone from the registry')
      isFalse(unregisterPlugin('unit-badargs').ok, 'twice is not a thing')
    })
  } finally {
    // The registry is process-wide: leaving test plugins in it would show up in
    // every group after this one.
    for (const id of eingetragen) unregisterPlugin(id)
  }

  // ------------------------------------------------------------------
  group('i18n: catalogs and translation')
  const { t, setLanguage, _catalogs, LANGUAGES } = await import('../server/i18n.mjs')

  await check('all languages have exactly the same keys as English', () => {
    const cats = _catalogs()
    const en = Object.keys(cats.en).sort()
    isTrue(en.length > 100, 'English catalog is populated')
    for (const code of Object.keys(LANGUAGES)) {
      if (code === 'en') continue
      const keys = Object.keys(cats[code]).sort()
      const fehlen = en.filter(k => !keys.includes(k))
      const zuviel = keys.filter(k => !en.includes(k))
      equal(fehlen.length, 0, `${code}: missing keys: ${fehlen.slice(0, 5).join(', ')}`)
      equal(zuviel.length, 0, `${code}: extra keys: ${zuviel.slice(0, 5).join(', ')}`)
    }
  })
  // Identical keys is not the same as identical meaning: a translation that
  // drops a {placeholder} renders a sentence with a hole in it, and one that
  // invents a name renders the name in braces. Both pass the key check above.
  await check('every translation carries exactly the placeholders English does', () => {
    // A doubled brace is a flow template ({{path}}), not an interpolation slot —
    // t() leaves those alone, and their inner word is translated on purpose.
    const slots = (s) => [...String(s).matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map(m => m[1]).sort().join(',')
    const cats = _catalogs()
    for (const [key, text] of Object.entries(cats.en)) {
      const soll = slots(text)
      for (const code of Object.keys(LANGUAGES)) {
        if (code === 'en') continue
        equal(slots(cats[code][key]), soll, `${code}:${key} placeholders`)
      }
    }
  })
  await check('no catalog entry is empty', () => {
    for (const [code, cat] of Object.entries(_catalogs())) {
      for (const [k, v] of Object.entries(cat)) isTrue(String(v).trim().length > 0, `${code}:${k}`)
    }
  })
  // A follow-up anomaly is the SAME statement about a follow-up: both halves of
  // `anomaly.X` / `anomaly.followup_X` describe one threshold in watcher.mjs
  // (80 % soft, 100 % hard), once for the run and once for the commission after
  // it. So the two must say the same thing, and the follow-up one says it with
  // its prefix — otherwise one threshold ends up with two names and only one of
  // them is true. Measured on this installation: `anomaly.soft_overrun` read
  // "over the expected duration" while firing at 80 %, so a run that finished
  // in 44 of its 45 expected minutes carried a badge saying it had gone over —
  // next to a cell reading "44 min / 45 min". Its follow-up twin had said
  // "nearing" all along.
  await check('a follow-up anomaly says the same as the anomaly it mirrors', () => {
    const PREFIX = { en: 'follow-up ', de: 'Nachfolgeauftrag ', zh: '后续任务' }
    const cats = _catalogs()
    for (const [code, cat] of Object.entries(cats)) {
      const prefix = PREFIX[code]
      isTrue(typeof prefix === 'string', `${code}: the follow-up prefix is known — a new language needs one here`)
      for (const key of Object.keys(cat)) {
        const m = /^anomaly\.followup_(.+)$/.exec(key)
        if (!m) continue
        const zwilling = `anomaly.${m[1]}`
        isTrue(Object.hasOwn(cat, zwilling), `${code}: ${key} has no twin ${zwilling}`)
        equal(cat[key], prefix + cat[zwilling], `${code}: ${key} must be "${zwilling}" with the follow-up prefix`)
      }
    }
  })
  await check('t() translates, interpolates and falls back safely', () => {
    setLanguage('de')
    equal(t('nav.overview'), 'Übersicht', 'German')
    equal(t('usage.resets', { time: '12:00' }), 'Reset 12:00', 'interpolation')
    equal(t('does.not.exist'), 'does.not.exist', 'unknown key returns the key')
    setLanguage('xx')
    equal(t('nav.overview'), 'Overview', 'unknown language falls back to English')
    setLanguage('en')
  })

  // ------------------------------------------------------------------
  group('Flows: templates, operators, triggers, validation')
  const tpl = await import('../server/flows/template.mjs')
  const { validateDefinition, defaultProps } = await import('../server/flows/steps.mjs')
  const { flowsForRun, normalizeTrigger } = await import('../server/flows/triggers.mjs')
  const att = await import('../server/flows/attach.mjs')
  const { schemaFromFields } = await import('../server/flows/llm.mjs')

  const ctx = { trigger: { run: { id: 'r1', outcome: 'done', report: 'all good', agent_name: 'nightly', n: 3 } }, vars: { x: { y: 'deep' }, list: ['a', 'b'] } }
  await check('render substitutes paths, objects as JSON, missing as empty', () => {
    equal(tpl.render('run {{trigger.run.id}} → {{ trigger.run.outcome }}', ctx), 'run r1 → done', 'two placeholders')
    equal(tpl.render('{{vars.x.y}}/{{vars.nope}}/{{vars.x.nope.deeper}}', ctx), 'deep//', 'missing values render empty')
    equal(tpl.render('{{vars.list}}', ctx), '[\n  "a",\n  "b"\n]', 'arrays as JSON')
    equal(tpl.render('{{vars.nope | default: fallback}}', ctx), 'fallback', 'default filter on empty')
    equal(tpl.render('{{trigger.run.n | default: 0}}', ctx), '3', 'default not used when set')
    equal(tpl.render(null, ctx), '', 'null template')
  })
  await check('resolve keeps the type of a whole-value placeholder', () => {
    equal(tpl.resolve('{{trigger.run.n}}', ctx), 3, 'number stays number')
    equal(JSON.stringify(tpl.resolve(' {{vars.x}} ', ctx)), '{"y":"deep"}', 'object stays object')
    equal(tpl.resolve('n={{trigger.run.n}}', ctx), 'n=3', 'mixed text renders')
  })
  await check('compare: operators', () => {
    isTrue(tpl.compare('Done', 'eq', 'done'), 'eq is case-insensitive')
    isTrue(tpl.compare('done', 'neq', 'failed'), 'neq')
    isTrue(tpl.compare('all good here', 'contains', 'GOOD'), 'contains')
    isFalse(tpl.compare('all good', 'not_contains', 'good'), 'not_contains')
    isTrue(tpl.compare('', 'empty', ''), 'empty'); isTrue(tpl.compare(undefined, 'empty', ''), 'undefined is empty')
    isTrue(tpl.compare('x', 'not_empty', ''), 'not_empty')
    isTrue(tpl.compare('yes', 'truthy', ''), 'truthy yes'); isFalse(tpl.compare('false', 'truthy', ''), 'string false is not truthy')
    isTrue(tpl.compare(true, 'truthy', ''), 'boolean true'); isTrue(tpl.compare([], 'falsy', ''), 'empty list is falsy')
    isTrue(tpl.compare('12', 'gt', '9'), 'gt numeric, not lexical'); isTrue(tpl.compare(5, 'lte', '5'), 'lte')
    isFalse(tpl.compare('abc', 'gt', '1'), 'NaN never greater')
    isTrue(tpl.compare('feature/x-12', 'matches', '^feature/'), 'regex'); isFalse(tpl.compare('a', 'matches', '('), 'broken regex is false')
    isFalse(tpl.compare('a', 'bogus', 'a'), 'unknown operator is false')
  })
  await check('setPath / varName', () => {
    const o = {}; tpl.setPath(o, 'a.b.c', 1); equal(o.a.b.c, 1, 'nested create')
    tpl.setPath(o, 'a.b', 'flat'); equal(o.a.b, 'flat', 'overwrite')
    equal(tpl.varName(' my var! ', 'x'), 'my_var_', 'sanitized'); equal(tpl.varName('', 'fallback'), 'fallback', 'fallback')
  })
  await check('toList: arrays, JSON, lines, junk', () => {
    equal(tpl.toList(['a', 'b']).join(','), 'a,b', 'array stays')
    equal(tpl.toList('["a","b"]').join(','), 'a,b', 'JSON list')
    equal(tpl.toList('a\n b \n\nc').join(','), 'a,b,c', 'one item per line, trimmed, blanks dropped')
    equal(tpl.toList('[broken').join(','), '[broken', 'broken JSON counts as text')
    equal(tpl.toList('').length, 0, 'empty text'); equal(tpl.toList(null).length, 0, 'null')
    equal(tpl.toList({ a: 1 }).length, 1, 'a single object is one element')
  })
  await check('attachments: parsing, conditions, and what the old trigger filters became', () => {
    equal(att.parseAttachments(null).length, 0, 'nothing attached')
    equal(att.parseAttachments('[broken').length, 0, 'broken JSON never throws')
    equal(att.parseAttachments('[{"flowId":"3"}]')[0].when, 'always', 'missing condition = always')
    equal(att.parseAttachments([{ flowId: 3 }, { flowId: 3, when: 'failed' }]).length, 1, 'a flow hangs on a run only once')
    equal(att.parseAttachments([{ flowId: 3, when: 'nonsense' }])[0].when, 'always', 'unknown condition = always')
    equal(att.serializeAttachments([]), null, 'empty stays NULL in the column')
    isTrue(att.attachmentFires({ when: 'always' }, 'aborted'), 'always covers every outcome')
    isTrue(att.attachmentFires({ when: 'not_done' }, 'aborted') && att.attachmentFires({ when: 'not_done' }, 'failed'), 'not_done covers both')
    isFalse(att.attachmentFires({ when: 'not_done' }, 'done'), 'but not a success')
    isFalse(att.attachmentFires({ when: 'done' }, 'failed'), 'a single outcome is exact')
    equal(att.whenFromOutcomes(['aborted', 'failed', 'done']), 'always', 'the old full outcome list is "always"')
    equal(att.whenFromOutcomes(['failed']), 'failed', 'and a one-element list its condition')
  })
  await check('flowsForRun: the attachment is the trigger, the flow only has to be ready', () => {
    const flows = [
      { id: 1, name: 'notify', active: 1, trigger: { kind: 'run_finished' } },
      { id: 2, name: 'nightly', active: 1, trigger: { kind: 'cron', expr: '* * * * *' } },
      { id: 3, name: 'off', active: 0, trigger: { kind: 'run_finished' } },
    ]
    const run = { flows: JSON.stringify([{ flowId: 1, when: 'failed' }, { flowId: 2, when: 'always' }, { flowId: 3, when: 'always' }]) }
    equal(flowsForRun(run, 'failed', flows).map(f => f.id).join(','), '1', 'condition, trigger kind and active flag all have to hold')
    equal(flowsForRun(run, 'done', flows).length, 0, 'the condition excludes the outcome')
    equal(flowsForRun({ flows: null }, 'done', flows).length, 0, 'a run without attachments starts nothing')
    equal(flowsForRun({ flows: '[{"flowId":99}]' }, 'done', flows).length, 0, 'a deleted flow is skipped, not crashed on')
  })
  await check('normalizeTrigger: kind only — the filter moved to the attachment', () => {
    equal(normalizeTrigger({ kind: 'run_finished', agentIds: [7], outcomes: ['done'] }).agentIds, undefined, 'old filters are dropped')
    equal(Object.keys(normalizeTrigger({ kind: 'run_finished' })).join(','), 'kind', 'run_finished carries nothing else')
    equal(normalizeTrigger({ kind: 'cron', expr: ' * * * * * ' }).expr, '* * * * *', 'the cron expression is trimmed')
    equal(normalizeTrigger({ kind: 'nonsense' }).kind, 'manual', 'unknown kind → manual')
  })
  await check('validateDefinition: unknown types, required fields (showIf-aware), branches', () => {
    equal(validateDefinition({ sequence: [] }).length, 0, 'empty is valid')
    isTrue(validateDefinition({ sequence: [{ type: 'teleport' }] })[0].includes('unknown step type'), 'unknown type')
    const tg = { id: 'a', type: 'notify', name: 'notify', properties: defaultProps('notify') }
    isTrue(validateDefinition({ sequence: [tg] }).some(p => p.includes("'text' is required")), 'required text')
    tg.properties.text = 'hi'; equal(validateDefinition({ sequence: [tg] }).length, 0, 'filled → valid')
    const sm = { id: 'b', type: 'send_message', properties: { ...defaultProps('send_message'), target: 'all_running', text: 'x' } }
    equal(validateDefinition({ sequence: [sm] }).length, 0, 'agentId not required when target is not agent')
    const cond = { id: 'c', type: 'condition', properties: { left: '1', op: 'eq', right: '1' }, branches: { true: [{ type: 'stop', properties: {} }], false: [{ type: 'nope' }] } }
    isTrue(validateDefinition({ sequence: [cond] }).some(p => p.includes("unknown step type 'nope'")), 'walks into branches')
    const loop = { id: 'd', type: 'for_each', properties: { list: '{{vars.x}}', itemVar: 'i', maxItems: 5 }, sequence: [{ type: 'nirvana' }] }
    isTrue(validateDefinition({ sequence: [loop] }).some(p => p.includes("unknown step type 'nirvana'")), 'walks into a container body')
    equal(validateDefinition({ sequence: [{ id: 'e', type: 'for_each', properties: { itemVar: 'i' }, sequence: [] }] }).length, 1, "'list' is required")
  })
  // ------------------------------------------------------------------
  group('Flows: typed variable catalog and placement rules (varschema.mjs)')
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

  await check('varsInScope: types, enums and the sanitized field name', () => {
    const sc = at('s2')
    equal(find(sc, 'vars.ex.needs_review')?.type, 'boolean', 'a boolean extraction field stays a boolean')
    equal(find(sc, 'vars.ex.sev')?.enum.join('|'), 'low|high', 'enum values come from the field')
    equal(find(sc, 'vars.ex.points')?.type, 'string_list', 'list field')
    isFalse(find(sc, 'vars.ex.needs review'), 'the space became an underscore — as in the JSON schema')
    equal(find(sc, 'trigger.run.outcome')?.enum.join('|'), 'done|failed|aborted', 'run outcome is an enum')
  })
  await check('varsInScope: order — a variable exists only after the step that writes it', () => {
    isFalse(find(at('s1'), 'vars.ex'), 'the extraction cannot read its own output')
    isTrue(find(at('s2'), 'vars.ex'), 'the next step can')
  })
  await check('varsInScope: branch and loop variables are marked conditional', () => {
    isTrue(find(at('s4'), 'vars.inner')?.conditional, 'set inside a branch — may be missing')
    isFalse(find(at('s2'), 'vars.inner'), 'and does not exist before its own branch at all')
    const inner = at('s5')
    equal(find(inner, 'vars.pt')?.type, 'string', 'the loop element takes the item type of the list')
    equal(find(inner, 'vars.pt_index')?.type, 'number', 'position')
    isFalse(find(inner, 'vars.pt')?.conditional, 'inside the body the element is guaranteed')
  })
  await check('varsInScope: a cron flow has no trigger run', () => {
    isFalse(find(at('s2', cronTrig), 'trigger.run.outcome'), 'nothing to offer')
    isTrue(find(at('s2', { kind: 'manual' }), 'trigger.run.outcome')?.conditional, 'manual: only when "run now" gives one')
  })
  await check('varsInScope: a drop position works like a step id', () => {
    const sc = vs.varsInScope(vdef, STEP_MAP, { sequence: vdef.sequence, index: 1 }, runTrig)
    isTrue(find(sc, 'vars.ex'), 'dropping after the extraction sees it')
    isFalse(vs.varsInScope(vdef, STEP_MAP, { sequence: vdef.sequence, index: 0 }, runTrig).find(v => v.path === 'vars.ex'), 'dropping before it does not')
  })
  await check('pathProblem: typo, missing field, and what cannot be judged', () => {
    const sc = at('s2')
    equal(vs.pathProblem('vars.ex.needs_review', sc), 'ok', 'exact hit')
    equal(vs.pathProblem('vars.extracted.x', sc), 'unknown_var', 'no step writes that variable')
    equal(vs.pathProblem('vars.ex.needs_reviev', sc), 'unknown_field', 'typo in the field')
    equal(vs.pathProblem('trigger.run.bogus', sc), 'unknown_field', 'RunInfo has no such field')
    equal(vs.pathProblem('vars.inner.whatever', at('s4')), 'ok', 'below a set_var nothing is knowable')
    equal(vs.pathProblem('something.else', sc), 'foreign', 'not one of our roots — left alone')
  })
  await check('opsForType / valueProblem: the value has to be one the left side can take', () => {
    equal(vs.opsForType('boolean').join(','), 'truthy,falsy,eq,neq', 'a boolean answers four questions')
    isTrue(vs.opsForType('number').includes('gt'), 'numbers compare')
    isFalse(vs.opsForType('boolean').includes('contains'), 'a boolean contains nothing')
    const b = { type: 'boolean' }, e = { type: 'string', enum: ['low', 'high'] }, n = { type: 'number' }
    equal(vs.valueProblem(b, 'eq', 'yes'), 'bool_value', 'compare() stringifies — only true/false can match')
    isFalse(vs.valueProblem(b, 'eq', 'TRUE'), 'case does not matter')
    isFalse(vs.valueProblem(b, 'truthy', ''), 'a unary operator needs no value')
    equal(vs.valueProblem(e, 'eq', 'medium'), 'enum_value', 'not in the enum')
    isFalse(vs.valueProblem(e, 'eq', 'High'), 'in the enum')
    equal(vs.valueProblem(n, 'gt', 'zwei'), 'number_value', 'not a number')
    isFalse(vs.valueProblem(e, 'eq', '{{vars.x}}'), 'a template is only known at run time')
    equal(vs.valuesFor(b).join('|'), 'true|false', 'the designer offers exactly these')
  })
  await check('definitionWarnings: the typo and the impossible comparison, both found', () => {
    const w = vs.definitionWarnings(vdef, STEP_MAP, runTrig)
    isTrue(w.some(x => x.stepId === 's2' && x.code === 'bool_value'), 'boolean against "yes"')
    isTrue(w.some(x => x.stepId === 's5' && x.code === 'unknown_var' && x.path === 'vars.nope'), 'variable nothing writes')
    equal(w.filter(x => x.path === 'vars.pt').length, 0, 'the loop element itself is fine')
  })
  await check('placement: a run outcome needs a run', () => {
    const sw = (id) => ({ id, type: 'switch_outcome', properties: { value: '{{trigger.run.outcome}}' }, branches: { done: [], failed: [], aborted: [] } })
    const pdef = { sequence: [sw('p1')] }
    equal(vs.placementErrors(pdef, STEP_MAP, runTrig).length, 0, 'a run_finished trigger delivers one')
    equal(vs.placementErrors(pdef, STEP_MAP, cronTrig)[0]?.code, 'needs_run', 'a cron flow does not')
    equal(vs.placementOf(sw('p1'), pdef, STEP_MAP, { kind: 'manual' })?.severity, 'warning', 'manual is only a warning')
    const waited = { sequence: [
      { id: 'q1', type: 'start_agent', properties: { agentId: 1, wait: true, outputVar: 'run' } },
      { ...sw('q2'), properties: { value: '{{vars.run.outcome}}' } }] }
    equal(vs.placementErrors(waited, STEP_MAP, cronTrig).length, 0, 'a start step with wait delivers one too')
    const noWait = { sequence: [{ ...waited.sequence[0], properties: { agentId: 1, wait: false, outputVar: 'run' } }, waited.sequence[1]] }
    equal(vs.placementErrors(noWait, STEP_MAP, cronTrig)[0]?.code, 'needs_run', 'without wait there is no outcome')
  })
  await check('placement: nothing follows a stop, also at the drop position', () => {
    const sdef = { sequence: [{ id: 'x1', type: 'stop', properties: {} }, { id: 'x2', type: 'note', properties: { text: 'hi' } }] }
    equal(vs.placementErrors(sdef, STEP_MAP)[0]?.code, 'after_stop', 'the step behind it is unreachable')
    const probe = { type: 'note', properties: { text: 'x' } }
    equal(vs.placementProblem(probe, STEP_MAP, { definition: sdef, sequence: sdef.sequence, index: 1 })?.code, 'after_stop', 'the drop is refused')
    isFalse(vs.placementProblem(probe, STEP_MAP, { definition: sdef, sequence: sdef.sequence, index: 0 }), 'in front of the stop it is fine')
  })
  await check('placement: only the target "the trigger run" needs one — other targets reach anything', () => {
    const mdef = { sequence: [{ id: 'm1', type: 'send_message', properties: { target: 'trigger_run', text: 'hi' } }] }
    equal(vs.placementErrors(mdef, STEP_MAP, cronTrig)[0]?.code, 'needs_run_target', 'no trigger run under cron')
    for (const target of ['agent', 'repo', 'all_running', 'run_id']) {
      mdef.sequence[0].properties.target = target
      equal(vs.placementErrors(mdef, STEP_MAP, cronTrig).length, 0, `target ${target} messages runs outside this flow`)
    }
  })
  await check('placement: a rule bound to a field value is only advertised while it applies', () => {
    const send = (target) => ({ id: 'r1', type: 'send_message', properties: { target, text: 'hi' } })
    equal(vs.activeRuleKey(send('trigger_run'), STEP_MAP.send_message), 'needs_run_target', 'stated for that target')
    isFalse(vs.activeRuleKey(send('agent'), STEP_MAP.send_message), 'and for no other — messaging a foreign agent needs nothing')
    isFalse(vs.activeRuleKey(send('all_running'), STEP_MAP.send_message), 'nor for all running runs')
    equal(vs.activeRuleKey({ type: 'switch_outcome', properties: {} }, STEP_MAP.switch_outcome), 'needs_run', 'an unconditional rule always applies')
    isFalse(vs.activeRuleKey({ type: 'note', properties: {} }, STEP_MAP.note), 'a step without a rule has none')
  })
  await check('validateDefinition rejects a placement error, hints stay non-blocking', () => {
    const pdef = { sequence: [{ id: 'p1', type: 'switch_outcome', properties: { value: '{{trigger.run.outcome}}' }, branches: { done: [], failed: [], aborted: [] } }] }
    equal(validateDefinition(pdef, runTrig).length, 0, 'fine under its own trigger')
    isTrue(validateDefinition(pdef, cronTrig).some(p => p.includes('needs_run')), 'refused under cron')
    equal(validateDefinition(vdef, runTrig).length, 0, 'a wrong comparison is a hint, never a save error')
  })

  await check('schemaFromFields builds a strict JSON schema', () => {
    const s = schemaFromFields([{ name: 'branch name', type: 'string' }, { name: 'ok', type: 'boolean' }, { name: 'tags', type: 'string_list' }, { name: 'sev', type: 'string', enumValues: 'low, high' }, { name: '' }])
    equal(s.required.join(','), 'branch_name,ok,tags,sev', 'names sanitized, empty dropped')
    equal(s.properties.tags.type, 'array', 'list type'); equal(s.properties.sev.enum.join('|'), 'low|high', 'enum')
    isFalse(s.additionalProperties, 'strict')
  })

  // ------------------------------------------------------------------
  group('Flows: engine with a stub api (branching, wait/resume, delay, stop, failure)')
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

  await check('branching on outcome, outputs into vars, note renders templates', async () => {
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
    equal(fr.status, 'done', 'finished')
    equal(fr.context.vars.reason, 'failed: broke', 'set_var rendered')
    equal(fr.context.vars.tg.delivered, true, 'notify output stored')
    equal(calls.find(c => c[0] === 'notify')[1], 'failed: broke', 'the notify step received the rendered text')
    isTrue(fr.log.some(l => l.msg === 'after switch failed: broke'), 'continued after the switch')
    isFalse(fr.log.some(l => l.msg === 'was done'), 'other branch not executed')
  })
  await check('send_message targets running runs of an agent', async () => {
    calls.length = 0
    const def = { sequence: [step('send_message', { target: 'agent', agentId: '5', text: 'pull {{trigger.run.agent_name}}', outputVar: 'sent' })] }
    const id = await engine.startFlowRun({ id: null, name: 'msg', definition: def }, trig, stubApi)
    equal(fdb.getFlowRun(id).context.vars.sent.count, 1, 'one run reached')
    equal(JSON.stringify(calls[0][1]), '{"statuses":["running","waiting_help"],"agentId":5}', 'filter by agent, running only')
    equal(calls[1][2], 'pull nightly', 'text rendered')
  })
  await check('start_agent with wait suspends, resume stores the RunInfo, condition sees it', async () => {
    calls.length = 0
    const def = { sequence: [
      step('start_agent', { agentId: '3', promptExtra: 'fix: {{trigger.run.report}}', wait: true, outputVar: 'fixer' }),
      step('condition', { left: '{{vars.fixer.ended_normally}}', op: 'truthy', right: '' }, { branches: { true: [step('note', { text: 'fixed' })], false: [step('note', { text: 'not fixed' })] } }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'chain', definition: def }, trig, stubApi)
    let fr = fdb.getFlowRun(id)
    equal(fr.status, 'waiting', 'suspended'); equal(fr.wait_run_id, 'new-run', 'on the started run')
    equal(calls[0][2], 'fix: broke', 'prompt extra rendered')
    equal(fr.context.vars.fixer.id, 'new-run', 'run id known before the wait')
    await engine.resumeWaitingOnRun('other-run', stubApi)
    equal(fdb.getFlowRun(id).status, 'waiting', 'a different run ending does not resume')
    await engine.resumeWaitingOnRun('new-run', stubApi)
    fr = fdb.getFlowRun(id)
    equal(fr.status, 'done', 'resumed and finished')
    equal(fr.context.vars.fixer.outcome, 'done', 'RunInfo replaced the placeholder output')
    isTrue(fr.log.some(l => l.msg === 'fixed'), 'condition read the resumed variable')
  })
  await check('delay suspends until resume_at; resumeDelayed continues', async () => {
    const def = { sequence: [step('delay', { minutes: 10 }), step('note', { text: 'later' })] }
    const id = await engine.startFlowRun({ id: null, name: 'sleepy', definition: def }, trig, stubApi)
    equal(fdb.getFlowRun(id).status, 'waiting', 'waiting')
    equal(fdb.getFlowRun(id).resume_at, '2026-08-24T10:10:00.000Z', 'resume time from api.now')
    await engine.resumeDelayed(stubApi)
    equal(fdb.getFlowRun(id).status, 'waiting', 'not yet due')
    await engine.resumeDelayed({ ...stubApi, now: () => Date.parse('2026-08-24T10:11:00Z') })
    const fr = fdb.getFlowRun(id)
    equal(fr.status, 'done', 'done after the delay'); isTrue(fr.log.some(l => l.msg === 'later'), 'continued')
  })
  await check('stop ends the run; a throwing step fails it with the message; unknown type fails', async () => {
    const id1 = await engine.startFlowRun({ id: null, name: 's', definition: { sequence: [step('stop', { reason: 'enough' }), step('note', { text: 'never' })] } }, trig, stubApi)
    const fr1 = fdb.getFlowRun(id1)
    equal(fr1.status, 'done', 'stopped = done'); isFalse(fr1.log.some(l => l.msg === 'never'), 'nothing after stop')
    const id2 = await engine.startFlowRun({ id: null, name: 'f', definition: { sequence: [step('extract', { source: 'report', fields: [] })] } }, trig, stubApi)
    const fr2 = fdb.getFlowRun(id2)
    equal(fr2.status, 'failed', 'failed'); isTrue(fr2.error.includes('no fields'), 'error message kept')
    const id3 = await engine.startFlowRun({ id: null, name: 'u', definition: { sequence: [{ id: 'z', type: 'warp', properties: {} }] } }, trig, stubApi)
    equal(fdb.getFlowRun(id3).status, 'failed', 'unknown step type fails')
    isTrue(engine.stopFlowRun(id3) === false, 'cannot stop a finished flow run')
  })
  await check('extract stores the model output; kill_run and start_single_run go through the api', async () => {
    calls.length = 0
    const def = { sequence: [
      step('extract', { source: 'report', sourceRun: '{{trigger.run.id}}', fields: [{ name: 'branch', type: 'string' }], outputVar: 'ex' }),
      step('kill_run', { target: 'all_running', outputVar: 'k' }),
      step('start_single_run', { repoId: '1', harness: 'claude', prompt: 'branch {{vars.ex.branch}}', wait: false, outputVar: 'single' }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'x', definition: def }, trig, stubApi)
    const fr = fdb.getFlowRun(id)
    equal(fr.status, 'done', 'done')
    equal(fr.context.vars.ex.branch, 'v', 'extract output'); equal(fr.context.vars.k.count, 1, 'kill count')
    equal(calls.find(c => c[0] === 'startSingle')[1], 'branch v', 'single run prompt used the extracted value')
    equal(fr.context.vars.single.id, 'single-run', 'no wait → continues with the id')
  })

  await check('for each: body per element, item + index variables, maxItems cap', async () => {
    const container = (id, properties, sequence) => ({ id, type: 'for_each', name: id, componentType: 'container', properties, sequence })
    const def = { sequence: [
      step('set_var', { outputVar: 'points', value: 'alpha\nbeta\ngamma' }),
      container('loop', { list: '{{vars.points}}', itemVar: 'punkt', maxItems: 2 }, [step('note', { text: '{{vars.punkt_index}}: {{vars.punkt}}' })]),
      step('note', { text: 'after the loop' }),
    ] }
    const id = await engine.startFlowRun({ id: null, name: 'loopy', definition: def }, trig, stubApi)
    const fr = fdb.getFlowRun(id)
    equal(fr.status, 'done', 'finished')
    equal(fr.log.filter(l => l.type === 'note').map(l => l.msg).join(' | '), '1: alpha | 2: beta | after the loop', 'body once per element, capped at maxItems, then on')
    equal(fr.context.vars.punkt, 'beta', 'the last element stays readable')
  })
  await check('for each: JSON list, nested branch, empty list skips the body', async () => {
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
    equal(fr.status, 'done', 'finished')
    equal(fr.log.filter(l => l.type === 'note').map(l => l.msg).join(' | '), 'hit y | end', 'branch inside the loop, empty loop skipped')
  })
  await check('for each: a wait inside the body survives and continues with the next element', async () => {
    calls.length = 0
    const container = (id, properties, sequence) => ({ id, type: 'for_each', name: id, componentType: 'container', properties, sequence })
    const def = { sequence: [container('l', { list: '["one","two"]', itemVar: 'it' }, [
      step('start_agent', { agentId: '3', promptExtra: 'work on {{vars.it}}', wait: true, outputVar: 'r' }),
      step('note', { text: 'done with {{vars.it}}' }),
    ])] }
    const id = await engine.startFlowRun({ id: null, name: 'waity', definition: def }, trig, stubApi)
    equal(fdb.getFlowRun(id).status, 'waiting', 'suspended in the first element')
    equal(calls[0][2], 'work on one', 'first element in the prompt')
    await engine.resumeWaitingOnRun('new-run', stubApi)
    equal(fdb.getFlowRun(id).status, 'waiting', 'suspended again, now in the second element')
    equal(calls.filter(c => c[0] === 'startAgent').at(-1)[2], 'work on two', 'second element in the prompt')
    await engine.resumeWaitingOnRun('new-run', stubApi)
    const fr = fdb.getFlowRun(id)
    equal(fr.status, 'done', 'finished after the last element')
    equal(fr.log.filter(l => l.type === 'note').map(l => l.msg).join(' | '), 'done with one | done with two', 'body completed for both elements')
  })

  // ------------------------------------------------------------------
  // The trigger that fires after a merge and the block that may run a command
  // afterwards. Both were built for one sentence — "after every merge into this
  // repo, restart the hub" — and both have exactly one place where they could
  // silently do the wrong thing: firing twice for one integration, and treating
  // a non-zero exit code as a broken step.
  group('Flows: the run_merged trigger and the shell_command block')
  const { flowsForMerge, flowsTick } = await import('../server/flows/triggers.mjs')
  const { STEPS } = await import('../server/flows/steps.mjs')
  const rawdb = fdb.default

  await check('normalizeTrigger: run_merged carries a repo, or all of them', () => {
    equal(normalizeTrigger({ kind: 'run_merged', repoId: 4 }).repoId, 4, 'a repo id survives')
    equal(normalizeTrigger({ kind: 'run_merged', repoId: '4' }).repoId, 4, 'as a number, whatever the form sent')
    equal(normalizeTrigger({ kind: 'run_merged' }).repoId, null, 'nothing chosen = every repo')
    equal(normalizeTrigger({ kind: 'run_merged', repoId: 'nonsense' }).repoId, null, 'and so is nonsense')
    equal(normalizeTrigger({ kind: 'run_finished', repoId: 4 }).repoId, undefined, 'no other trigger carries one')
  })
  await check('flowsForMerge: the filter is the repo, not an attachment', () => {
    const flows = [
      { id: 1, name: 'this repo', active: 1, trigger: { kind: 'run_merged', repoId: 7 } },
      { id: 2, name: 'every repo', active: 1, trigger: { kind: 'run_merged' } },
      { id: 3, name: 'other repo', active: 1, trigger: { kind: 'run_merged', repoId: 8 } },
      { id: 4, name: 'switched off', active: 0, trigger: { kind: 'run_merged' } },
      { id: 5, name: 'run finished', active: 1, trigger: { kind: 'run_finished' } },
    ]
    equal(flowsForMerge({ repo_id: 7, flows: null }, flows).map(f => f.id).join(','), '1,2',
      'its own repo and "all repos" — and no attachment anywhere in sight')
    equal(flowsForMerge({ repo_id: 8 }, flows).map(f => f.id).join(','), '2,3', 'another repo sees its own')
    equal(flowsForMerge({ repo_id: 9 }, []).length, 0, 'no flows, no starts')
  })
  await check('the merge is a variable only under its own trigger', () => {
    const mdef = { sequence: [{ id: 'n1', type: 'note', properties: { text: 'x' } }] }
    const scope = (kind) => vs.varsInScope(mdef, STEP_MAP, 'n1', { kind })
    equal(find(scope('run_merged'), 'trigger.merge.sha')?.type, 'string', 'the commit that landed')
    equal(find(scope('run_merged'), 'trigger.merge.files')?.type, 'string_list', 'the files it changed')
    isTrue(find(scope('run_merged'), 'trigger.run.merge_status')?.enum.includes('merged'), 'the run says how its merge went')
    isFalse(find(scope('cron'), 'trigger.merge'), 'a schedule has no merge')
    isFalse(find(scope('run_finished'), 'trigger.merge'), 'and neither has a finished run')
    isFalse(find(scope('run_merged'), 'trigger.run')?.conditional, 'a merge always has the run whose work landed')
  })
  await check('shell_command: registry entry, defaults and the shape that depends on "detach"', () => {
    const meta = STEP_MAP.shell_command
    isTrue(!!meta && meta.output && meta.group === 'data', 'in the registry, in the data group, with an output')
    isTrue(STEPS.some(s => s.type === 'shell_command'), 'and in the list the editor is built from')
    const props = defaultProps('shell_command')
    equal(props.outputVar, 'shell', 'default output variable')
    equal(props.timeoutMinutes, 10, 'default timeout')
    equal(props.detach, false, 'not detached by default')
    const step = (detach) => ({ id: 'sh', type: 'shell_command', properties: { ...props, command: 'true', detach } })
    const shapeOf = (detach) => vs.shapePaths('vars.shell', vs.outputShapeOf(step(detach), meta)).map(p => p.path).join(',')
    contains(shapeOf(false), 'vars.shell.exit_code', 'not detached: the exit code is readable')
    contains(shapeOf(false), 'vars.shell.stdout', 'and the output')
    isFalse(shapeOf(true).includes('exit_code'), 'detached: there is no exit code to promise')
    contains(shapeOf(true), 'vars.shell.detached', 'only the fact that it was detached')
    isTrue(validateDefinition({ sequence: [{ id: 'sh', type: 'shell_command', properties: { ...props } }] })
      .some(p => p.includes("'command' is required")), 'without a command it is not a step')
  })
  await check('shell_command: templates, exit code as a result, detach as an immediate answer', async () => {
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
    equal(fr.status, 'done', 'a command that exits 3 does NOT fail the flow run')
    equal(seen[0].command, 'echo r1', 'the command is a template')
    equal(seen[0].cwd, '/tmp/repo', 'and so is the working directory')
    equal(seen[0].timeoutMs, 120_000, 'minutes become milliseconds')
    equal(fr.context.vars.shell.exit_code, 3, 'the exit code is readable')
    isFalse(fr.context.vars.shell.ok, 'and says the command did not succeed')
    isTrue(fr.log.some(l => l.msg === 'exit 3'), 'the step log names it')
    equal(fr.context.vars.bg.detached, true, 'the detached command answers at once')
    isTrue(fr.log.some(l => l.msg === 'detached'), 'and says so')
    isFalse(fr.log.some(l => l.msg === 'never'), 'the branch really hung on the exit code')
  })

  // The dispatch, against the sandbox database: the five columns belong to the
  // merge integrator and are not in this branch yet, so the test adds them the
  // way it will find them later.
  await check('a merge fires its flows exactly once — the conflict run is marked, not fired', async () => {
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
    equal(runs1.length, 1, 'exactly one flow run')
    equal(fdb.listFlowRuns(fremd).length, 0, 'the flow of another repo stayed out of it')
    const trig1 = runs1[0].context.trigger
    equal(trig1.kind, 'run_merged', 'trigger kind')
    equal(trig1.run.id, 'merge-run-1', 'with the run whose work landed')
    equal(trig1.merge.sha, 'sha-1', 'the commit')
    equal(trig1.merge.base, 'main', 'the branch it landed on')
    equal(trig1.merge.resolver_run_id, 'conflict-run-1', 'and the conflict run that made it mergeable')
    equal(trig1.merge.files.join(','), 'server/a.mjs,lang/en.json', 'the files out of the event')
    isTrue(runs1[0].log.some(l => l.msg === 'merged sha-1'), 'the step read the merge')
    equal(rawdb.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get('merge-run-1').merge_dispatched, 1, 'marked')

    await flowsTick(stubApi)
    equal(fdb.listFlowRuns(flowId).length, 1, 'a second pass starts nothing — the mark holds')

    anlegen('conflict-run-1', { merged_sha: 'sha-1', resolves_run_id: 'merge-run-1' })
    await flowsTick(stubApi)
    equal(fdb.listFlowRuns(flowId).length, 1, 'the conflict run merged the same work and starts no second flow run')
    equal(rawdb.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get('conflict-run-1').merge_dispatched, 1,
      'but it is marked, or the next pass would look at it again')

    anlegen('merge-run-old', { merged_sha: 'sha-old' })
    equal(fdb.markExistingMergesDispatched(), 1, 'a merge that was there before this code counts as dispatched')
    await flowsTick(stubApi)
    equal(fdb.listFlowRuns(flowId).length, 1, 'history is never replayed')
  })
  // The repo page's way in: a run_merged flow hangs on the repo, so the repo
  // form has to be able to name it. Unlike the dispatch, this list deliberately
  // includes the switched-off ones — it answers "what happens after a merge
  // here", and "nothing, it is off" is part of that answer.
  await check('flowsForMergeOfRepo: this repo, all repos, and the switched-off ones too', () => {
    const repoId = rawdb.prepare('SELECT id FROM repos WHERE name=?').get('merge-repo').id
    const alle = fdb.saveFlow({ name: 'every repo', active: 0, trigger: { kind: 'run_merged' },
      definition: { sequence: [] } })
    const fremd = rawdb.prepare('SELECT id FROM flows WHERE name=?').get('another repo').id
    const namen = fdb.flowsForMergeOfRepo(repoId).map(f => f.name).sort().join(',')
    equal(namen, 'after the merge,every repo', 'its own flow and the one watching every repo — the inactive one included')
    isTrue(fdb.flowsForMergeOfRepo(repoId).some(f => f.id === alle && !f.active), 'and it says that it is off')
    isFalse(fdb.flowsForMergeOfRepo(repoId).some(f => f.id === fremd), 'another repo\'s flow stays out')
    equal(fdb.flowsForMergeOfRepo(0).map(f => f.name).join(','), 'every repo', 'without a repo only the "all repos" flows')
    equal(fdb.mergeTriggerRepoId({ repoId: '4' }), 4, 'one rule for reading the filter')
    equal(fdb.mergeTriggerRepoId({}), null, 'and null means all of them')
  })
  await check('a flow run the hub restart caught mid-step is closed, not left running', () => {
    const id = fdb.createFlowRun({ flow: { id: null, name: 'interrupted' }, context: { trigger: {}, vars: {} }, state: { frames: [] } })
    const waiting = fdb.createFlowRun({ flow: { id: null, name: 'suspended' }, context: { trigger: {}, vars: {} }, state: { frames: [] } })
    fdb.updateFlowRun(waiting, { status: 'waiting', context: {}, state: {}, log: [], resumeAt: '2099-01-01T00:00:00Z' })
    equal(fdb.failRunningFlowRuns(), 1, 'only the one that was really in a step')
    const fr = fdb.getFlowRun(id)
    equal(fr.status, 'failed', 'ever "running" would be a lie — nothing ever picks it up again')
    contains(fr.log.at(-1).msg, 'hub restarted', 'and its own log says why')
    equal(fdb.getFlowRun(waiting).status, 'waiting', 'a suspended one is a row, not a stack frame — untouched')
  })

  // A cron flow produces flow runs around the clock — the one that deploys pushed
  // commits fires every ten minutes. Nothing ever deleted a flow run before, so
  // /flows/runs would silt up with rows saying "nothing to do".
  await check('retention deletes the finished ones, keeps failed four times as long, never the waiting', async () => {
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
    equal(fdb.flowRunKeepDays(), 7, 'the setting is read')
    equal(fdb.pruneFlowRuns(Date.now()), 1, 'exactly one row went')
    equal(fdb.getFlowRun(finished), null, 'the finished one is gone')
    equal(fdb.getFlowRun(broken).status, 'failed', 'the failed one stays — it is the reason anyone opens the page')
    equal(fdb.getFlowRun(suspended).status, 'waiting', 'a waiting run is not old, it is suspended')

    age(broken, 30)                                            // now over 4 × 7
    equal(fdb.pruneFlowRuns(Date.now()), 1, 'four times as long, then it goes too')

    const later = make('cron, nothing to do either', 'done', 10)
    setSetting('flow_runs_keep_days', '0')
    equal(fdb.flowRunKeepDays(), 0, '0 is a value, not "unset"')
    equal(fdb.pruneFlowRuns(Date.now()), 0, 'and it means: never delete anything')
    isTrue(!!fdb.getFlowRun(later), 'the row is still there')
    setSetting('flow_runs_keep_days', '')
    equal(fdb.flowRunKeepDays(), 7, 'empty falls back to the default')
  })

  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // "How many runs are going right now?" — the one number a flow that hands out
  // work cannot do without, and the one it used to have to fetch through a
  // shell_command calling the hub's own HTTP API. The two places it can quietly
  // lie are the filter (a status nobody knows must not widen it) and the case
  // folding of the title prefix (German titles are not ASCII).
  group('Flows: count_runs')

  const countStub = (rows) => {
    const seen = []
    return { api: { ...stubApi, listRuns: async (f) => { seen.push(f); return rows } }, seen }
  }
  const countRun = async (properties, rows) => {
    const { api, seen } = countStub(rows)
    const id = await engine.startFlowRun(
      { id: null, name: 'counter', definition: { sequence: [step('count_runs', properties)] } },
      { kind: 'cron' }, api)
    return { fr: fdb.getFlowRun(id), seen }
  }
  const COUNT_ROWS = [
    { id: 'r-1', title: 'Nightly docs sweep', status: 'running' },
    { id: 'r-2', title: 'nightly cleanup', status: 'running' },
    { id: 'r-3', title: 'Nächtlicher Umbau', status: 'running' },
    { id: 'r-4', title: null, status: 'running' },
  ]

  await check('count_runs: registry entry, defaults and the shape it promises', () => {
    const meta = STEP_MAP.count_runs
    isTrue(!!meta && meta.output && meta.group === 'data', 'in the registry, in the data group, with an output')
    isTrue(STEPS.some(s => s.type === 'count_runs'), 'and in the list the editor is built from')
    isFalse(!!meta.placement, 'no placement rule — it reads the hub, not the trigger run')
    const props = defaultProps('count_runs')
    equal(props.outputVar, 'runs', 'default output variable')
    equal(props.statuses, 'running', 'by default it counts what is going right now')
    equal(props.repoId, '', 'no repo chosen = every repo')
    equal(props.agentId, '', 'and no agent chosen = every agent')
    const paths = vs.shapePaths('vars.runs', vs.outputShapeOf(
      { id: 'c', type: 'count_runs', properties: props }, meta)).map(p => `${p.path}:${p.type}`).join(',')
    contains(paths, 'vars.runs.count:number', 'the number a condition compares')
    contains(paths, 'vars.runs.ids:string_list', 'the ids a for_each walks')
    contains(paths, 'vars.runs.titles:string_list', 'and the titles a message can name')
    equal(validateDefinition({ sequence: [{ id: 'c', type: 'count_runs', properties: props }] }, { kind: 'cron' }).length, 0,
      'legal under a schedule, where there is no run at all')
  })

  await check('count_runs: repo, agent and status reach the query — the title prefix filters the answer', async () => {
    const { fr, seen } = await countRun(
      { repoId: '7', agentId: '3', statuses: 'running, waiting_help', titlePrefix: '', outputVar: 'runs' }, COUNT_ROWS)
    equal(fr.status, 'done', 'the step finished')
    equal(seen[0].repoId, 7, 'the repo goes to the query as a number')
    equal(seen[0].agentId, 3, 'and so does the agent')
    equal(seen[0].statuses.join(','), 'running,waiting_help', 'the comma-separated list becomes a list, trimmed')
    equal(fr.context.vars.runs.count, 4, 'nothing filtered away')
    equal(fr.context.vars.runs.ids.join(','), 'r-1,r-2,r-3,r-4', 'the ids come back in order')
    equal(fr.context.vars.runs.titles[3], '', 'a run without a title reports an empty one, never undefined')
    isTrue(fr.log.some(l => l.msg === '4 Runs'), 'the log names the number')
  })

  await check('count_runs: an empty repo, agent and status list mean "all of them"', async () => {
    const { seen } = await countRun({ repoId: '', agentId: '', statuses: '', titlePrefix: '', outputVar: 'runs' }, COUNT_ROWS)
    equal(seen[0].repoId, null, 'no repo = every repo')
    equal(seen[0].agentId, null, 'no agent = every agent')
    equal(seen[0].statuses, null, 'no status = every status, the same rule')
  })

  await check('count_runs: the title prefix ignores case, umlauts included', async () => {
    const a = await countRun({ repoId: '', agentId: '', statuses: 'running', titlePrefix: 'nightly', outputVar: 'runs' }, COUNT_ROWS)
    equal(a.fr.context.vars.runs.count, 2, 'both spellings of "Nightly" count')
    equal(a.fr.context.vars.runs.ids.join(','), 'r-1,r-2', 'and only those')
    const b = await countRun({ repoId: '', agentId: '', statuses: 'running', titlePrefix: 'NÄCHTLICH', outputVar: 'runs' }, COUNT_ROWS)
    equal(b.fr.context.vars.runs.count, 1, 'Ä folds to ä — SQLite LIKE would have missed this one')
    const c = await countRun({ repoId: '', agentId: '', statuses: 'running', titlePrefix: 'weekly', outputVar: 'runs' }, COUNT_ROWS)
    equal(c.fr.context.vars.runs.count, 0, 'a prefix nothing starts with counts nothing')
    equal(c.fr.context.vars.runs.ids.length, 0, 'and hands on an empty list, not a missing one')
    isTrue(c.fr.log.some(l => l.msg === '0 Runs'), 'zero is a result the log states as plainly as any other')
  })

  await check('count_runs: the prefix and the status list are templates', async () => {
    const { fr, seen } = await countRun(
      { repoId: '', agentId: '', statuses: '{{vars.wanted}}', titlePrefix: '{{vars.prefix}}', outputVar: 'runs' }, COUNT_ROWS)
    void fr
    equal(seen.length, 1, 'the step ran')
    const { api, seen: seen2 } = countStub(COUNT_ROWS)
    const id = await engine.startFlowRun({ id: null, name: 'templated', definition: { sequence: [
      step('set_var', { outputVar: 'wanted', value: 'waiting_help' }),
      step('set_var', { outputVar: 'prefix', value: 'nightly' }),
      step('count_runs', { repoId: '', agentId: '', statuses: '{{vars.wanted}}', titlePrefix: '{{vars.prefix}}', outputVar: 'runs' }),
    ] } }, { kind: 'cron' }, api)
    const fr2 = fdb.getFlowRun(id)
    equal(seen2[0].statuses.join(','), 'waiting_help', 'the status list came out of a variable')
    equal(fr2.context.vars.runs.count, 2, 'and so did the prefix')
  })

  await check('count_runs: a status nobody knows fails the step instead of counting everything', async () => {
    const { api } = countStub(COUNT_ROWS)
    const id = await engine.startFlowRun({ id: null, name: 'typo', definition: { sequence: [
      step('count_runs', { repoId: '', agentId: '', statuses: 'runnning', titlePrefix: '', outputVar: 'runs' }),
      step('note', { text: 'never' }),
    ] } }, { kind: 'cron' }, api)
    const fr = fdb.getFlowRun(id)
    equal(fr.status, 'failed', 'a typo is not a filter that quietly matches every run')
    contains(fr.error, 'runnning', 'the error names what it did not recognise')
    contains(fr.error, 'waiting_help', 'and lists what it would have accepted')
    isFalse(fr.log.some(l => l.msg === 'never'), 'nothing after it ran on a wrong number')
  })

  // ------------------------------------------------------------------
  // Switching an agent's schedule from inside a flow. The two places it could
  // quietly do the wrong thing: starting a run for an agent it just switched
  // OFF, and starting a second run for an agent that is already busy — which is
  // the one thing "start right away" was given a guard for.
  group('Flows: toggle_agent')

  const agentStub = (agents, busyIds = []) => {
    const calls = []
    const rows = new Map(agents.map(a => [a.id, { ...a }]))
    return { calls, api: {
      ...stubApi,
      agentInfo: async (id) => (rows.has(id) ? { ...rows.get(id) } : null),
      setAgentActive: async (id, on) => {
        calls.push(['setAgentActive', id, on])
        const a = rows.get(id)
        if (!a) return { ok: false, error: `agent ${id} does not exist` }
        const before = a.active
        a.active = !!on
        return { ok: true, id: a.id, name: a.name, active_before: before, active_after: a.active }
      },
      startAgentIfIdle: async (id) => {
        calls.push(['startAgentIfIdle', id])
        if (busyIds.includes(id)) return { ok: true, runId: null, busy: true }
        return { ok: true, runId: `run-of-${id}` }
      },
    } }
  }
  const toggleRun = async (properties, agents, busyIds = []) => {
    const { api, calls } = agentStub(agents, busyIds)
    const id = await engine.startFlowRun(
      { id: null, name: 'switcher', definition: { sequence: [step('toggle_agent', properties)] } },
      { kind: 'cron' }, api)
    return { fr: fdb.getFlowRun(id), calls }
  }
  const NIGHTLY = [{ id: 4, name: 'nightly', active: true }]

  await check('toggle_agent: registry entry, defaults and the shape it promises', () => {
    const meta = STEP_MAP.toggle_agent
    isTrue(!!meta && meta.output && meta.group === 'agents', 'in the registry, in the agents group, with an output')
    isTrue(STEPS.some(s => s.type === 'toggle_agent'), 'and in the list the editor is built from')
    isFalse(!!meta.placement, 'no placement rule — it switches an agent, it does not read the trigger run')
    const props = defaultProps('toggle_agent')
    equal(props.active, 'on', 'switching on is the default')
    equal(props.startNow, false, 'and it does not start anything unasked')
    equal(props.outputVar, 'agent', 'default output variable')
    const paths = vs.shapePaths('vars.agent', vs.outputShapeOf(
      { id: 'tg', type: 'toggle_agent', properties: props }, meta)).map(p => `${p.path}:${p.type}`).join(',')
    for (const p of ['vars.agent.id:number', 'vars.agent.name:string', 'vars.agent.active_before:boolean',
      'vars.agent.active_after:boolean', 'vars.agent.started_run_id:string']) contains(paths, p, p)
    isTrue(validateDefinition({ sequence: [{ id: 'tg', type: 'toggle_agent', properties: { ...props, agentId: '' } }] })
      .some(p => p.includes("'agentId' is required")), 'without an agent it is not a step')
    equal(validateDefinition({ sequence: [{ id: 'tg', type: 'toggle_agent', properties: { ...props, agentId: 4 } }] },
      { kind: 'cron' }).length, 0, 'legal under a schedule, where there is no run at all')
  })

  await check('toggle_agent: on, off and over — and the state it reports is before → after', async () => {
    const an = await toggleRun({ agentId: '4', active: 'on', startNow: false, outputVar: 'agent' },
      [{ id: 4, name: 'nightly', active: false }])
    equal(an.calls[0].join(':'), 'setAgentActive:4:true', 'switching on asks for true')
    equal(an.fr.context.vars.agent.active_before, false, 'it was off')
    equal(an.fr.context.vars.agent.active_after, true, 'and is on now')
    equal(an.fr.context.vars.agent.name, 'nightly', 'the name comes back for the message that follows')
    isTrue(an.fr.log.some(l => l.msg === 'nightly: off → on'), 'the log names both ends of the change')

    const aus = await toggleRun({ agentId: '4', active: 'off', startNow: false, outputVar: 'agent' }, NIGHTLY)
    equal(aus.calls[0].join(':'), 'setAgentActive:4:false', 'switching off asks for false')
    equal(aus.fr.context.vars.agent.active_after, false, 'and it is off')

    const um1 = await toggleRun({ agentId: '4', active: 'toggle', startNow: false, outputVar: 'agent' }, NIGHTLY)
    equal(um1.calls[0].join(':'), 'setAgentActive:4:false', 'toggle on an active agent switches it off')
    const um2 = await toggleRun({ agentId: '4', active: 'toggle', startNow: false, outputVar: 'agent' },
      [{ id: 4, name: 'nightly', active: false }])
    equal(um2.calls[0].join(':'), 'setAgentActive:4:true', 'and on an inactive one switches it on')
  })

  await check('toggle_agent: "start right away" starts one — and never for an agent it just switched off', async () => {
    const an = await toggleRun({ agentId: '4', active: 'on', startNow: true, outputVar: 'agent' },
      [{ id: 4, name: 'nightly', active: false }])
    isTrue(an.calls.some(c => c[0] === 'startAgentIfIdle'), 'switched on, so it starts')
    equal(an.fr.context.vars.agent.started_run_id, 'run-of-4', 'and hands the run id on')
    contains(an.fr.log.map(l => l.msg).join(' '), 'started run run-of-4', 'the log says which run')

    const aus = await toggleRun({ agentId: '4', active: 'off', startNow: true, outputVar: 'agent' }, NIGHTLY)
    isFalse(aus.calls.some(c => c[0] === 'startAgentIfIdle'),
      'switched OFF with the box still ticked starts nothing — the ticked box is not a second command')
    equal(aus.fr.context.vars.agent.started_run_id, null, 'and the output says so')
  })

  await check('toggle_agent: a busy agent is skipped — a result, not a failure', async () => {
    const { fr } = await toggleRun({ agentId: '4', active: 'on', startNow: true, outputVar: 'agent' }, NIGHTLY, [4])
    equal(fr.status, 'done', 'the flow run carries on')
    equal(fr.context.vars.agent.started_run_id, null, 'nothing was started')
    equal(fr.context.vars.agent.active_after, true, 'but the switch itself did happen')
    contains(fr.log.map(l => l.msg).join(' '), 'skipped (agent is busy)', 'and the log says it was skipped')
  })

  await check('toggle_agent: an agent nobody has fails the step', async () => {
    const { api } = agentStub(NIGHTLY)
    const id = await engine.startFlowRun({ id: null, name: 'ghost', definition: { sequence: [
      step('toggle_agent', { agentId: '99', active: 'on', startNow: false, outputVar: 'agent' }),
      step('note', { text: 'never' }),
    ] } }, { kind: 'cron' }, api)
    const fr = fdb.getFlowRun(id)
    equal(fr.status, 'failed', 'a flow that switches nothing must not report success')
    contains(fr.error, '99', 'the error names the id')
    isFalse(fr.log.some(l => l.msg === 'never'), 'and nothing after it ran')
  })

  // ------------------------------------------------------------------
  // A panel is a number a PROJECT pushes into the sidebar, so everything that
  // decides here decides about somebody else's data: what is repaired, what is
  // refused, and above all what an empty field means. `Number('')` is 0 and
  // finite — in a panel that is not merely wrong, it reads as "nothing left to
  // do", which is the most expensive shape a wrong number can take here.
  group('Panels: what a project pushes into the sidebar (panels.mjs)')

  const { normalizePanel, panelState, setPanelValue, panelValue, panelValues, deletePanelValue, PANEL_MAX_ITEMS } =
    await import('../server/panels.mjs')

  await check('a panel needs a total or an item — nothing else counts as one', () => {
    isFalse(normalizePanel(null).ok, 'null')
    isFalse(normalizePanel('not json').ok, 'not JSON')
    isFalse(normalizePanel([1, 2]).ok, 'an array is not an object')
    isFalse(normalizePanel({ title: 'Findings' }).ok, 'a title alone is not a value')
    isTrue(normalizePanel({ total: 0 }).ok, 'a total of zero IS a value')
    isTrue(normalizePanel({ items: [{ label: 'bug', count: 3 }] }).ok, 'items alone are enough')
  })

  await check('an empty count is null, never 0 — the Number("") trap', () => {
    const r = normalizePanel({ total: '', items: [{ label: 'bug', count: '' }, { label: 'task', count: '7' }] })
    isTrue(r.ok, 'accepted')
    equal(r.value.total, null, 'the total says "not measured", not "none left"')
    equal(r.value.items[0].count, null, 'and so does the row')
    equal(r.value.items[1].count, 7, 'a numeric string is still a number')
  })

  await check('what cannot be rendered is dropped, not passed through', () => {
    const r = normalizePanel({
      total: 5, tone: 'chartreuse',
      href: 'javascript:alert(1)',
      items: [{ label: 'a', count: 1, tone: 'RED' }, { count: 2 }, { label: 'b', count: 3, href: '../bugs' }],
    })
    equal(r.value.tone, null, 'an unknown tone')
    equal(r.value.href, null, 'a href that is not a link')
    equal(r.value.items.length, 2, 'a row without a label is not a row')
    equal(r.value.items[0].tone, 'red', 'a tone is read case-insensitively')
    equal(r.value.items[1].href, null, 'a filesystem path is dead in a browser')
    equal(normalizePanel({ total: 1, href: 'https://example.test/x' }).value.href, 'https://example.test/x', 'http(s) travels')
    equal(normalizePanel({ total: 1, href: '/runs/abc' }).value.href, '/runs/abc', 'a path on this hub travels')
    equal(normalizePanel({ total: 1, href: '//evil.test' }).value.href, null, 'a protocol-relative one does not')
  })

  await check('the caps hold: a sidebar column is not a table', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `row ${i}`, count: i }))
    const r = normalizePanel({ total: 1, items: many })
    equal(r.value.items.length, PANEL_MAX_ITEMS, 'cut to the cap')
    isTrue(r.problems.some(p => /more than/.test(p)), 'and it says so instead of silently dropping')
    equal(normalizePanel({ total: 1, items: [{ label: 'x'.repeat(200), count: 1 }] }).value.items[0].label.length, 40, 'a label is cut')
  })

  await check('state: fresh, stale, error — and no ttl means never stale', () => {
    const now = Date.parse('2026-09-04T12:00:00Z')
    const old = { atMs: now - 3 * 60 * 60 * 1000, ttlMin: null, error: null }
    equal(panelState(old, now), 'fresh', 'a value without a ttl promises no interval')
    equal(panelState({ ...old, ttlMin: 60 }, now), 'stale', 'past its own ttl')
    equal(panelState({ ...old, ttlMin: 600 }, now), 'fresh', 'inside it')
    equal(panelState({ ...old, error: 'tool missing' }, now), 'error', 'a failed measurement outranks the clock')
  })

  await check('storing: round trip, refusals, and a failure that keeps the numbers', async () => {
    const { db: udb } = await import('../server/db.mjs')
    udb.prepare(`INSERT INTO repos(name, path) VALUES('panel-test','/tmp/panel-test')`).run()
    const repoId = udb.prepare(`SELECT id FROM repos WHERE name='panel-test'`).get().id

    isFalse(setPanelValue({ repoId, key: 'Not A Key', value: { total: 1 } }).ok, 'an invalid key is refused')
    isFalse(setPanelValue({ repoId: 999999, key: 'x', value: { total: 1 } }).ok === true, 'an unknown repo is refused')

    isTrue(setPanelValue({ repoId, key: 'findings', value: { title: 'Findings', total: 33, items: [{ label: 'bug', count: 17 }] } }).ok, 'stored')
    const p = panelValue(repoId, 'findings')
    equal(p.total, 33, 'the total came back')
    equal(p.items[0].label, 'bug', 'and the row')
    equal(panelState(p), 'fresh', 'a fresh push is fresh')

    // The producer failed. The point of this path: the LAST numbers stay
    // visible — an operator who is told "measurement failed" and shown nothing
    // has lost the information that was already there.
    isTrue(setPanelValue({ repoId, key: 'findings', error: 'the register tool is not on this branch' }).ok, 'a failure is a push too')
    const nachFehler = panelValue(repoId, 'findings')
    equal(nachFehler.total, 33, 'the numbers survived')
    equal(panelState(nachFehler), 'error', 'and the state says they are not confirmed')

    isTrue(setPanelValue({ repoId, key: 'findings', value: { total: 30 } }).ok, 'a new value')
    equal(panelValue(repoId, 'findings').error, null, 'clears the failure')

    equal(panelValues(repoId).length, 1, 'one panel on this repo')
    deletePanelValue(repoId, 'findings')
    equal(panelValues(repoId).length, 0, 'and gone')
    equal(panelValues(null).length, 0, 'no repo, no panels — never a throw')
  })

  await check('bin/fl-panel parses', async () => {
    const { execFileSync: run } = await import('node:child_process')
    const root = new URL('..', import.meta.url).pathname
    run('node', ['--check', join(root, 'bin', 'fl-panel')], { stdio: ['ignore', 'ignore', 'pipe'] })
  })

  // ------------------------------------------------------------------
  group('Docs: AGENTS.md / CLAUDE.md pairing')

  await check('every AGENTS.md has a CLAUDE.md next to it that only includes it', async () => {
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
    isTrue(dirs.length >= 1, 'at least the root AGENTS.md exists')
    for (const dir of dirs) {
      const claudeMd = j(dir, 'CLAUDE.md')
      isTrue(existsSync(claudeMd), `${dir}: CLAUDE.md exists`)
      equal(readFileSync(claudeMd, 'utf8').trim(), '@AGENTS.md', `${dir}: CLAUDE.md contains only the include`)
    }
  })

  // The README exists in three languages and they are maintained TOGETHER — a
  // translation that quietly disappears is worse than none, because the language
  // switcher at the top keeps promising it. Same for SETUP_WITH_AGENT.md: it is
  // the document a stranger's coding agent acts on, and it is only found because
  // every README links it near the top.
  await check('all three READMEs exist, link each other and link SETUP_WITH_AGENT.md', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('..', import.meta.url).pathname
    const readmes = ['README.md', 'README.zh-CN.md', 'README.de.md']
    for (const f of ['SETUP_WITH_AGENT.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'LICENSE', ...readmes]) {
      isTrue(existsSync(j(root, f)), `${f} exists`)
    }
    for (const f of readmes) {
      const text = readFileSync(j(root, f), 'utf8')
      isTrue(text.includes('SETUP_WITH_AGENT.md'), `${f} links SETUP_WITH_AGENT.md`)
      isTrue(text.includes('CONTRIBUTING.md'), `${f} links CONTRIBUTING.md`)
      // The roadmap is English only, so a Chinese or German reader reaches it
      // exactly one way: through their own README.
      isTrue(text.includes('(ROADMAP.md)'), `${f} links ROADMAP.md`)
      for (const other of readmes.filter((o) => o !== f)) {
        isTrue(text.includes(`(${other})`), `${f} links ${other} (language switcher)`)
      }
    }
    isTrue(readFileSync(j(root, 'LICENSE'), 'utf8').includes('Attribution 4.0 International'),
      'LICENSE is the CC BY 4.0 legal code')
  })

  // A roadmap that names a design document which is no longer there sends the
  // one interested reader after a 404, and a roadmap without the issues URL is
  // an invitation with no address on it.
  await check('ROADMAP.md links its design study and the issue tracker', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('..', import.meta.url).pathname
    const text = readFileSync(j(root, 'ROADMAP.md'), 'utf8')
    for (const link of [...text.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1])) {
      isTrue(existsSync(j(root, link)), `ROADMAP.md links ${link}, which exists`)
    }
    isTrue(text.includes('SANDBOX_RESEARCH.md'), 'ROADMAP.md links the sandbox design study')
    isTrue(text.includes('https://github.com/hwalde/freilauf/issues'),
      'ROADMAP.md names the issue tracker')
  })

  // The changelog has no version numbers — its sections are DAYS, so the dates
  // are the whole ordering and a chronology out of order is one that quietly
  // stopped being a chronology. Several agents write into this file, sometimes
  // in parallel, which is exactly how a day ends up in the wrong place.
  await check('CHANGELOG.md is dated per day, newest first, with known categories', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('..', import.meta.url).pathname
    isTrue(existsSync(j(root, 'CHANGELOG.md')), 'CHANGELOG.md exists')
    const lines = readFileSync(j(root, 'CHANGELOG.md'), 'utf8').split('\n')
    const days = []
    const known = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'])
    for (const line of lines) {
      if (line.startsWith('## ')) {
        const d = line.slice(3).trim()
        isTrue(/^\d{4}-\d{2}-\d{2}$/.test(d), `day heading "${d}" is an ISO 8601 date`)
        isTrue(!Number.isNaN(Date.parse(d)), `day heading "${d}" is a real date`)
        days.push(d)
      }
      if (line.startsWith('### ')) {
        const c = line.slice(4).trim()
        isTrue(known.has(c), `category "${c}" is one of Keep a Changelog's`)
      }
    }
    isTrue(days.length >= 1, 'at least one day is written down')
    for (let i = 1; i < days.length; i++) {
      isTrue(days[i] < days[i - 1], `${days[i]} comes after ${days[i - 1]} (newest first, no duplicates)`)
    }
  })

  // ------------------------------------------------------------------
  // Every shell file in this repo is installed and run on a machine — freilauf-deploy
  // even runs setup/02 on every single deploy. A typo in one of them is not a
  // failing test somewhere, it is a hub that does not come back up, and `bash -n`
  // is the cheapest possible fence against exactly that.
  group('Scripts: every shell file parses')

  await check('bash -n on bin/* and setup/*.sh', async () => {
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
    isTrue(files.length >= 8, `found the scripts (${files.length})`)
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
  group('The running version in the sidebar (hubVersion / headerStatus)')

  await check('the version is a short sha or the empty string, never anything else', async () => {
    const { hubVersion } = await import('../server/util.mjs')
    const v = hubVersion()
    isTrue(v === '' || /^[0-9a-f]{7,40}$/.test(v), `got ${JSON.stringify(v)}`)
    equal(hubVersion(), v, 'and it is cached — a page render is not a git client')
  })

  await check('headerStatus carries it, and nothing broken when there is none', async () => {
    const { hubVersion } = await import('../server/util.mjs')
    const { headerStatus } = await import('../server/pages.mjs')
    const html = headerStatus()
    contains(html, 'id="header-status"', 'still the block the live channel swaps')
    if (hubVersion()) contains(html, hubVersion(), 'the running sha is in it')
    isFalse(html.includes('undefined'), 'no stray undefined')
    isFalse(/>\s*null\s*</.test(html), 'no stray null')
  })

  // ------------------------------------------------------------------
  group('Configured coding agents (coding-agents.mjs)')
  const ca = await import('../server/coding-agents.mjs')

  await check('save validates against the plugin registry', () => {
    isFalse(ca.saveCodingAgent({ harness: 'gpt' }).ok, 'unknown harness rejected')
    isTrue(ca.saveCodingAgent({ harness: 'opencode', providers: ['opencode-zen', 'quatsch'] }).ok, 'known harness saved')
    const row = ca.codingAgentFor('opencode')
    equal(JSON.stringify(row.providerIds), '["opencode-zen"]', 'unknown provider dropped')
    isTrue(ca.isHarnessEnabled('opencode'), 'enabled')
    isFalse(ca.isHarnessEnabled('claude'), 'not configured = not enabled')
  })
  await check('seedIfEmpty only fills an empty table and skips invalid entries', async () => {
    const seed = join(sandkasten, 'seed.json')
    writeFileSync(seed, JSON.stringify({ coding_agents: [{ harness: 'claude' }, { harness: 'quatsch' }] }))
    process.env.FREILAUF_AGENTS_SEED = seed
    equal(ca.seedIfEmpty(), 0, 'table not empty: nothing seeded')
    ca.deleteCodingAgent(ca.codingAgentFor('opencode').id)
    equal(ca.seedIfEmpty(), 1, 'empty table: valid entries seeded')
    isTrue(ca.isHarnessEnabled('claude'), 'claude seeded')
    delete process.env.FREILAUF_AGENTS_SEED
  })

  // A balance nobody can act on is noise: the panel asks only providers that an
  // ENABLED coding agent may use and that actually carry a credential.
  await check('balances are only fetched for providers a configured agent may use', async () => {
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
      equal(bal.relevantProviderIds().length, 0, 'subscription-only setup asks nobody')
      equal((await bal.providerBalances()).length, 0, 'and fetches nothing')
      equal(gefragt.length, 0, 'no request left the process')

      ca.saveCodingAgent({ harness: 'opencode', providers: ['opencode-zen', 'deepseek', 'openrouter'] })
      process.env.OPENROUTER_API_KEY = 'k'
      delete process.env.DEEPSEEK_API_KEY
      bal._balanceCacheReset()
      const rows = await bal.providerBalances()
      equal(rows.length, 1, 'a provider without a credential is left out, not reported as broken')
      equal(rows[0].provider, 'openrouter', 'the one with a key')
      isTrue(rows[0].ok, 'and it answered')
      isFalse(gefragt.some(u => u.includes('deepseek')), 'the keyless provider was never called')
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
  await check('a configuration change is visible in usage and balances without a cache reset', async () => {
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
      equal((await usage.subscriptionUsage()).length, 0, 'empty configuration reports nothing')
      equal((await bal.providerBalances()).length, 0, 'and holds no balance')

      // Now configure — without touching the caches, exactly as the web UI does.
      ca.saveCodingAgent({ harness: 'claude', enabled: 1, providers: [] })
      const rows = await usage.subscriptionUsage()
      equal(rows.length, 1, 'the newly configured coding agent is reported at once')
      equal(rows[0].harness, 'claude', 'and it is the one that was added')

      ca.saveCodingAgent({ harness: 'opencode', enabled: 1, providers: ['openrouter'] })
      process.env.OPENROUTER_API_KEY = 'k'
      const b = await bal.providerBalances()
      equal(b.length, 1, 'its provider is asked for a balance at once')
      equal(b[0].provider, 'openrouter', 'the provider that was just allowed')

      // And a finished request really is finished: `force` is the one call that
      // is supposed to ignore the cache, so it must not be handed the promise
      // the cache was made of. That is what a flag left standing does.
      const uEinmal = await usage.subscriptionUsage()
      isFalse(await usage.subscriptionUsage({ force: true }) === uEinmal,
        'a forced usage refresh asks again instead of returning the finished request')
      const bEinmal = await bal.providerBalances()
      isFalse(await bal.providerBalances({ force: true }) === bEinmal,
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
  await check('an expired panel is served stale while it refreshes behind the page', async () => {
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
      equal(erste.length, 1, 'the cold call really does fetch')
      const rufeNachErster = rufe

      // Age the entry past its cache window (now a minute), then make the next
      // fetch hang: the stale answer must come back at once, not after it.
      bal._balanceCacheAge(3 * 60_000)
      haenge = () => {}
      const zweite = await Promise.race([
        bal.providerBalances(),
        new Promise(r => setTimeout(() => r('zu langsam'), 200)),
      ])
      isTrue(zweite === erste, 'the stale answer comes back at once, byte for byte the old one')
      isTrue(rufe > rufeNachErster, 'and the refresh really was started behind it')
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
  group('Run definition: one form → one definition (run-def.mjs)')
  // 'claude' is the configured coding agent here (seeded by the group above).
  const rd = await import('../server/run-def.mjs')

  await check('a complete form becomes the definition the run is created from', async () => {
    const problems = []
    const def = await rd.runDefFromForm({
      harness: 'claude', model: ' claude-opus-5 ', prompt: 'do something',
      branch_mode: 'neu', branch_pattern: 'agent/{date}-{kurz}', expected_minutes: '30',
    }, problems)
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(def.model, 'claude-opus-5', 'model trimmed')
    equal(def.branchMode, 'neu', 'branch mode')
    equal(def.expectedMinutes, 30, 'expected duration')
    equal(def.provider, null, 'subscription harness has no provider')
  })
  await check('missing expectation falls back to the default instead of NaN', async () => {
    const def = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'keiner' }, [])
    equal(def.expectedMinutes, rd.DEFAULT_EXPECTED_MINUTES, 'default')
  })
  await check('the same checks apply to every form: harness, prompt, branch rule', async () => {
    const p1 = []
    await rd.runDefFromForm({ harness: 'gpt', prompt: 'x', branch_mode: 'keiner' }, p1)
    equal(p1.length, 1, `unknown harness (${p1.join(', ')})`)
    const p2 = []
    await rd.runDefFromForm({ harness: 'opencode', prompt: 'x', branch_mode: 'keiner' }, p2)
    contains(p2.join(' '), 'not configured', 'known but not configured coding agent')
    const p3 = []
    await rd.runDefFromForm({ harness: 'claude', prompt: '   ', branch_mode: 'quatsch' }, p3)
    // Empty prompt, unknown branch mode — and that mode is not 'keiner', so the
    // missing pattern counts too. Everything the operator has to fix at once.
    equal(p3.length, 3, `empty prompt and unknown branch mode (${p3.join(', ')})`)
    const p4 = []
    await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'neu' }, p4)
    equal(p4.length, 1, `branch mode without a pattern (${p4.join(', ')})`)
  })
  await check('a provider the harness cannot use is refused, not silently stored', async () => {
    const problems = []
    const def = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'keiner', provider: 'openrouter' }, problems)
    equal(problems.length, 1, `refused (${problems.join(', ')})`)
    equal(def.provider, null, 'nothing taken over')
  })
  // ---- the branch rule: one table, three consumers ----
  await check('the sentence the agent reads comes from BRANCH_MODE_INFO, per merge mode', () => {
    const rule = (mode, opts) => rd.branchRuleText(mode, opts)
    // With the integration switched off these three are BYTE FOR BYTE the
    // sentences that used to be an inline ternary in runner.mjs. If one of them
    // changes, every prompt of every non-integrating repo changes with it.
    equal(rule('keiner', { hubMerges: false }),
      'No branch — the worktree is detached; changes are throwaway changes.', 'no branch, off')
    equal(rule('neu', { branch: 'agent/x', hubMerges: false }),
      'Create a new branch, name following the pattern agent/x.', 'new branch, off')
    equal(rule('fest', { branch: 'long-lived', hubMerges: false }),
      'Work on the existing branch long-lived.', 'existing branch, off')

    // Under 'hub' the same three say what really happens.
    contains(rule('keiner', { base: 'main', hubMerges: true }), 'Freilauf merges your commits into main',
      'no branch under hub does NOT promise throwaway work')
    isFalse(rule('keiner', { base: 'main', hubMerges: true }).includes('throwaway'), 'no leftover promise')
    contains(rule('neu', { branch: 'b', base: 'trunk', hubMerges: true }), 'merges it into trunk', 'the repo\'s own base branch')
    contains(rule('fest', { branch: 'b', base: 'main', hubMerges: true }), 'merges it into main', 'existing branch under hub')
  })

  await check('"keep on branch" only exists where there IS a branch to keep it on', () => {
    const keep = { base: 'main', hubMerges: true, keepOnBranch: true }
    contains(rd.branchRuleText('neu', { ...keep, branch: 'b' }), 'STAYS on that branch', 'new branch')
    contains(rd.branchRuleText('fest', { ...keep, branch: 'b' }), 'will not merge it into main', 'existing branch')
    // 'keiner' has no keep sentence — it falls back to the ordinary hub one
    // rather than promising something it cannot do.
    equal(rd.branchRuleText('keiner', keep), rd.branchRuleText('keiner', { base: 'main', hubMerges: true }),
      'no branch: the hub sentence, never a keep sentence')
    // And keep is ignored where the hub does not integrate at all.
    equal(rd.branchRuleText('neu', { branch: 'b', hubMerges: false, keepOnBranch: true }),
      'Create a new branch, name following the pattern b.', 'off outranks keep')
  })

  await check('every explanation the table names really exists in lang/en.json', async () => {
    const { _catalogs } = await import('../server/i18n.mjs')
    const en = _catalogs().en
    for (const [mode, info] of Object.entries(rd.BRANCH_MODE_INFO)) {
      isTrue(typeof en[info.label] === 'string' && en[info.label], `${mode}: label key ${info.label}`)
      for (const modus of ['off', 'hub']) {
        const key = info.explain[modus]
        isTrue(typeof en[key] === 'string' && en[key], `${mode}/${modus}: explain key ${key}`)
      }
      isTrue(!!info.rule.off && !!info.rule.hub, `${mode}: both agent sentences`)
    }
    // The two that carry {base} in the UI have to keep saying it.
    contains(en['branch.keep'], '{base}', 'the checkbox names the branch it will NOT merge into')
  })

  await check('keeping the work on a branch needs a branch', async () => {
    const p1 = []
    const def1 = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'keiner', keep_on_branch: '1' }, p1)
    equal(p1.length, 1, `refused (${p1.join(', ')})`)
    equal(def1.keepOnBranch, 1, 'the value is still reported back, so the form can show it ticked')
    const p2 = []
    const def2 = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'neu', branch_pattern: 'b', keep_on_branch: '1' }, p2)
    equal(p2.length, 0, `accepted with a branch (${p2.join(', ')})`)
    equal(def2.keepOnBranch, 1, 'and taken over')
    const p3 = []
    const def3 = await rd.runDefFromForm({ harness: 'claude', prompt: 'x', branch_mode: 'neu', branch_pattern: 'b' }, p3)
    equal(def3.keepOnBranch, 0, 'an unticked checkbox is simply absent — and that is the default')
  })

  await check('keep_on_branch goes the whole way a run definition field goes', async () => {
    const agentRow = {
      harness: 'claude', prompt: 'p', branch_mode: 'fest', branch_pattern: 'long-lived',
      keep_on_branch: 1, expected_minutes: 20,
    }
    equal(rd.defFromAgent(agentRow).keepOnBranch, 1, 'agent row → definition')
    equal(rd.defFromAgent({ ...agentRow, keep_on_branch: 0 }).keepOnBranch, 0, 'and back off again')
    // saveAgent writes it, defFromAgent reads it back: the round trip a stored
    // agent takes every time it starts.
    // NOT a hardcoded repo id: this suite shares one database and several groups
    // insert repos, so "1" is whichever row happened to be first. It broke the
    // day a group before this one inserted and removed a repo of its own.
    const { default: dbKeep } = await import('../server/db.mjs')
    const keepRepo = dbKeep.prepare('SELECT id FROM repos ORDER BY id LIMIT 1').get()?.id
      ?? dbKeep.prepare(`INSERT INTO repos(name,path) VALUES('keep-repo','/tmp/keep-repo') RETURNING id`).get().id
    const id = rd.saveAgent({ repoId: keepRepo, name: `keep-${Date.now()}`, def: await rd.runDefFromForm({
      harness: 'claude', prompt: 'p', branch_mode: 'fest', branch_pattern: 'long-lived', keep_on_branch: '1',
    }, []) })
    const { default: db2 } = await import('../server/db.mjs')
    const zurueck = db2.prepare('SELECT * FROM agents WHERE id=?').get(id)
    equal(zurueck.keep_on_branch, 1, 'stored')
    equal(rd.defFromAgent(zurueck).keepOnBranch, 1, 'and read back as the same definition')
    // The flow designer offers it too, or a flow-started run could never keep.
    const feld = rd.RUN_DEF_FLOW_FIELDS.find(f => f.key === 'keepOnBranch')
    isTrue(!!feld, 'the flow step has the field')
    equal(feld.kind, 'checkbox', 'as a checkbox')
    equal(rd.defFromFlowProps({ harness: 'claude', prompt: 'p', branchMode: 'neu', branchPattern: 'b', keepOnBranch: true }).keepOnBranch, 1,
      'a flow can keep the work on its branch')
    equal(rd.defFromFlowProps({ harness: 'claude', prompt: 'p', branchMode: 'keiner', keepOnBranch: true }).keepOnBranch, 0,
      'but not without a branch — the same rule the form enforces')
  })

  await check('agent row and definition describe the same thing', () => {
    const def = rd.defFromAgent({
      harness: 'claude', model: 'm', provider: null, or_provider: null, effort: 'high',
      prompt: 'p', branch_mode: 'fest', branch_pattern: 'b', expected_minutes: 20, skills: '["x"]',
    })
    equal(def.branchMode, 'fest', 'branch mode')
    equal(def.expectedMinutes, 20, 'expected duration')
    equal(def.skills, '["x"]', 'skills copied verbatim')
    equal(rd.defFromAgent({ flows: '[{"flowId":1,"when":"failed"}]' }).flows, '[{"flowId":1,"when":"failed"}]',
      'attached flows copied verbatim')
  })
  // A flow hangs on an agent or a single run — naming each of four attached
  // flows is a hurdle, not information. So the name is optional in the UI and
  // the hub fills in a free one; the column is UNIQUE and flow_runs keeps a copy.
  await check('a flow saved without a name gets a free one', async () => {
    const fdb3 = await import('../server/flows/db.mjs')
    equal(fdb3.autoFlowName(), 'Flow 1', 'the first one')
    fdb3.saveFlow({ name: fdb3.autoFlowName(), trigger: { kind: 'manual' }, definition: { sequence: [] } })
    equal(fdb3.autoFlowName(), 'Flow 2', 'the taken one is skipped')
  })
  await check('attached flows go through the form like every other definition field', async () => {
    const fdb2 = await import('../server/flows/db.mjs')
    const id = fdb2.saveFlow({ name: 'attach-test', trigger: { kind: 'run_finished' }, definition: { sequence: [] } })
    const base = { harness: 'claude', prompt: 'x', branch_mode: 'keiner' }
    equal((await rd.runDefFromForm(base, [])).flows, null, 'nothing ticked = NULL')
    const def = await rd.runDefFromForm({ ...base, flows_list: [String(id), '4242'], [`flow_when_${id}`]: 'failed' }, [])
    equal(def.flows, JSON.stringify([{ flowId: id, when: 'failed' }]),
      'the ticked flow with its condition — a flow that does not exist is dropped')
  })
  await check('the last choice is remembered and offered again', () => {
    equal(JSON.stringify(rd.lastRunChoice()), '{}', 'nothing remembered yet')
    rd.rememberRunChoice({ harness: 'claude', model: 'claude-opus-5', provider: null, orProvider: null, effort: 'high' })
    const l = rd.lastRunChoice()
    equal(l.harness, 'claude', 'coding agent')
    equal(l.model, 'claude-opus-5', 'model')
    equal(l.effort, 'high', 'effort')
  })
  await check('a coding agent that was switched off is not preselected', () => {
    ca.saveCodingAgent({ harness: 'claude', enabled: 0, providers: [] })
    equal(JSON.stringify(rd.lastRunChoice()), '{}', 'nothing offered')
    ca.saveCodingAgent({ harness: 'claude', enabled: 1, providers: [] })
    equal(rd.lastRunChoice().harness, 'claude', 'offered again after switching on')
  })
  // Switching the coding agent in the form must not leave the previous one's
  // setup standing — an opencode slug is nothing claude runs. So every coding
  // agent keeps its OWN last setup, and one it has none for answers empty.
  await check('every coding agent remembers its own setup', () => {
    ca.saveCodingAgent({ harness: 'opencode', enabled: 1, providers: ['openrouter'] })
    rd.rememberRunChoice({ harness: 'opencode', model: 'z-ai/glm-4.6', provider: 'openrouter', orProvider: 'novita', effort: null })
    equal(rd.lastRunChoice().harness, 'opencode', 'the last one opens the form')
    const c = rd.lastRunChoiceFor('claude')
    equal(c.model, 'claude-opus-5', 'claude still has its own model')
    equal(c.effort, 'high', 'and its own effort')
    equal(c.provider, null, 'and no provider of the other one')
    const o = rd.lastRunChoiceFor('opencode')
    equal(o.provider, 'openrouter', 'opencode has its own provider')
    equal(o.or_provider, 'novita', 'including the serving provider')
    equal(JSON.stringify(rd.lastRunChoiceFor('hermes')), '{}', 'an unconfigured coding agent offers nothing')
    ca.saveCodingAgent({ harness: 'cursor', enabled: 1, providers: [] })
    equal(rd.lastRunChoiceFor('cursor').model, null, 'a configured one without history stays empty')
  })

  // ------------------------------------------------------------------
  // The goal is the one definition field that never reaches the agent through
  // the prompt file: it exists only as a slash command inside the session, and
  // only a coding agent whose plugin carries a `goal` spec knows one at all.
  group('Goal: the second prompt (goal.mjs)')
  const gl = await import('../server/goal.mjs')

  await check('who knows a goal is the plugin\'s answer, not the form\'s', () => {
    isTrue(gl.harnessSupportsGoal('claude'), 'claude does')
    isFalse(gl.harnessSupportsGoal('opencode'), 'opencode does not')
    isFalse(gl.harnessSupportsGoal('cursor'), 'cursor does not')
    equal(gl.goalMax('claude'), 4000, 'and claude names its own limit')
    equal(gl.goalMax('hermes'), null, 'a coding agent without a spec has none')
  })
  await check('the condition becomes ONE command line', () => {
    equal(gl.goalCommand('claude', 'all tests pass'), '/goal all tests pass', 'the command in front of it')
    equal(gl.goalCommand('claude', ' all tests\n  pass\n'), '/goal all tests pass',
      'whitespace folded — a pasted newline would submit the fragment before it')
    equal(gl.goalCommand('claude', '   '), null, 'nothing to send')
    equal(gl.goalCommand('opencode', 'all tests pass'), null, 'a coding agent without a spec gets no command')
    equal(gl.goalCommand('claude', 'x'.repeat(5000)).length, '/goal '.length + 4000, 'capped at the limit')
  })
  // A paste is not a keystroke: claude collapses a bracketed paste over 800
  // characters into a `[Pasted text #n]` placeholder, and a placeholder is
  // never read as a slash command — so the command word has to be TYPED and
  // only the condition may be pasted (measured 2.1.261).
  await check('the command word is typed, the condition is pasted', () => {
    const k = gl.goalKeys('claude', 'all tests pass')
    equal(k.typed, '/goal ', 'the part that has to arrive as keystrokes')
    equal(k.argument, 'all tests pass', 'the part that may be a paste')
    equal(k.typed + k.argument, gl.goalCommand('claude', 'all tests pass'),
      'and the two halves are the command line, so nothing can drift apart')
    const lang = gl.goalKeys('claude', 'y'.repeat(3000))
    equal(lang.typed, '/goal ', 'a long condition is exactly the case this exists for')
    equal(lang.argument.length, 3000, 'and all of it is still the argument')
    equal(gl.goalKeys('claude', '   '), null, 'nothing to send')
    equal(gl.goalKeys('opencode', 'all tests pass'), null, 'a coding agent without a spec gets no keys')
  })
  await check('a plugin that declares no typed prefix keeps the single paste', async () => {
    const { registerPlugin, unregisterPlugin } = await import('../server/plugins/registry.mjs')
    const desc = {
      id: 'unit-goal-plugin', kind: 'harness', label: 'Goal agent', bin: 'goalbin',
      subscription: false, providers: [], logPatterns: [{ typ: 'rate_limit', re: /x/ }],
      modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null,
      goal: { max: 100, command: (c) => `!ziel ${c}` },
    }
    isTrue(registerPlugin(desc, { source: 'external' }).ok, 'the plugin registers')
    try {
      const k = gl.goalKeys('unit-goal-plugin', 'fertig')
      equal(k.typed, '', 'everything is pasted, as it always was')
      equal(k.argument, '!ziel fertig', 'and the whole line is the paste')
      // A prefix that does not really start the command would send two halves
      // meaning something else together — the whole line is pasted instead.
      desc.goal.typed = '/anders '
      equal(gl.goalKeys('unit-goal-plugin', 'fertig').typed, '', 'a prefix that does not fit is not used')
      equal(gl.goalKeys('unit-goal-plugin', 'fertig').argument, '!ziel fertig', 'and nothing is lost by that')
    } finally { unregisterPlugin('unit-goal-plugin') }
  })
  await check('the goal goes through the form like every other definition field', async () => {
    const base = { harness: 'claude', prompt: 'x', branch_mode: 'keiner' }
    equal((await rd.runDefFromForm(base, [])).goal, null, 'empty field = no goal')
    equal((await rd.runDefFromForm({ ...base, goal: '  tests are green  ' }, [])).goal, 'tests are green', 'trimmed')
    equal((await rd.runDefFromForm({ ...base, goal: '/goal tests are green' }, [])).goal, 'tests are green',
      'whoever types the command keeps it: the hub is the one that puts it in front')
    const zuLang = []
    equal((await rd.runDefFromForm({ ...base, goal: 'y'.repeat(4001) }, zuLang)).goal, null, 'nothing taken over')
    equal(zuLang.length, 1, `too long is a problem, not a condition cut in half (${zuLang.join(', ')})`)
    // A coding agent that knows no goal simply has none — the form disables the
    // field there, so this only catches a body the form did not write.
    equal(rd.defFromFlowProps({ harness: 'cursor', prompt: 'x', goal: 'tests are green' }).goal, null,
      'and a coding agent without a spec gets none, whatever the request says')
    equal(rd.defFromFlowProps({ harness: 'claude', prompt: 'x', goal: 'tests are green' }).goal, 'tests are green',
      'the flow step takes the same route')
    equal(rd.defFromAgent({ goal: 'tests are green' }).goal, 'tests are green', 'and the agent row carries it')
  })

  await check('the flow step carries the serving-provider routing like every form', () => {
    const base = { harness: 'opencode', provider: 'openrouter', model: 'z-ai/glm-5.2', prompt: 'x', branchMode: 'keiner' }
    equal(rd.defFromFlowProps({ ...base, orMode: 'offen' }).orRouting, null, 'open = no routing')
    const auto = rd.defFromFlowProps({ ...base, orMode: 'auto', orQuant: 'fp8', orRegion: 'eu', orMaxIn: '1.5' })
    equal(JSON.stringify(auto.orRouting), JSON.stringify({ mode: 'auto', quant_min: 'fp8', location: 'eu', max_in: 1.5 }),
      'auto requirements become the config')
    const pin = rd.defFromFlowProps({ ...base, orMode: 'pin', orProvider: 'parasail/fp8' })
    equal(pin.orProvider, 'parasail/fp8', 'the pin survives the flow step')
    equal(pin.orRouting, null, 'pin and auto are one statement, never both')
    // Not passable, or nonsense — both are NO routing, never a broken run.
    equal(rd.defFromFlowProps({ ...base, provider: 'deepseek', orMode: 'pin', orProvider: 'x' }).orProvider, null,
      'a routing on a non-OpenRouter provider is dropped')
    equal(rd.defFromFlowProps({ ...base, orMode: 'auto', orQuant: 'quatsch' }).orRouting, null,
      'a nonsense minimum is dropped, the flow run still starts')
    equal(rd.defFromFlowProps({ ...base, orMode: 'auto', orQuant: 'fp8' }).orRouting.location, 'all',
      'an unset region means everywhere, as in the form')
  })

  // ------------------------------------------------------------------
  group('OpenRouter best-provider selection (openrouter-routing.mjs)')
  const orr = await import('../server/providers/openrouter-routing.mjs')

  await check('the quantization parser reads the wide family onto one scale', () => {
    equal(orr.parseQuantization('fp8').rank, orr.parseQuantization('FP8 ').rank, 'case and spelling do not matter')
    equal(orr.parseQuantization('q4_K_M').bits, 4, 'a GGUF-style q4 quantization parses')
    equal(orr.parseQuantization('q4_K_M').rank, orr.parseQuantization('int4').rank, 'q4 and int4 land on the same rank')
    isTrue(orr.parseQuantization('bf16').rank > orr.parseQuantization('fp8').rank, 'bf16 is more precise than fp8')
    equal(orr.parseQuantization('bf16').rank, orr.parseQuantization('fp16').rank, 'bf16 and fp16 tie — both are 16 bits')
    equal(orr.parseQuantization('int8').rank < orr.parseQuantization('fp8').rank, true, 'int8 sits BELOW fp8: same bits, unsafe direction excluded')
    equal(orr.parseQuantization('unknown'), null, 'unknown means "no information", never a level')
    equal(orr.parseQuantization(''), null, 'empty stays empty')
    equal(orr.parseQuantization('nvfp4'), null, 'a genuinely unknown spelling is reported as unknown')
    equal(orr.unknownQuantizations(['fp8', 'nvfp4', 'q5_k_s']).join(','), 'nvfp4', 'the gap is named, not silently passed')
  })

  await check('“fp8 or better” is a lower bound, not an enumeration the future ages out', () => {
    equal(orr.quantizationsFrom('fp8').join(','), 'fp8,fp16,bf16,fp32', 'fp8 admits bf16 and fp16 — more precision, not less')
    equal(orr.quantizationsFrom('fp8').includes('fp4'), false, 'fp4 is below the floor and stays out')
    equal(orr.quantizationsFrom('q4').includes('fp8'), true, 'q4 parses onto the same scale (int-4 ≈ fp4 or better)')
    isTrue(orr.quantizationsFrom('bf16').includes('fp16'), true, 'the tie holds in the enumeration too')
    isTrue(!!orr.parseRoutingConfig({ quant_min: 'nvfp4' }).error,
      'an unknown minimum is an ERROR, never a silent no-filter')
  })

  await check('the selection filters, ranks and names its reasons', () => {
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
    equal(auto.best, 'morph/bf16', 'bf16 beats fp8 beats fp4 at the top')
    isTrue(!auto.order.includes('cheap/fp4'), 'fp4 does not sneak into the order')
    // With a minimum it is a FLOOR: everything at or above it competes on price.
    const fp8 = orr.selectBestProvider(eps, orr.parseRoutingConfig({ quant_min: 'fp8' }))
    equal(fp8.order.join('|'), 'morph/bf16|sila/fp8', 'fp8-minimum narrows to fp8-or-better, cheapest first')
    // Unknown quantization is NEVER a match — and every drop says why.
    isTrue(auto.dropped.some(d => d.tag === 'who/cares' && d.reason.includes('quantization')),
      'a null quantization is never counted as a match')
    isTrue(fp8.dropped.some(d => d.tag === 'ohne/werkzeug' && d.reason.includes('tool support')),
      'the tool-less endpoint is dropped, named')
    isTrue(fp8.dropped.some(d => d.reason.includes('degraded')), 'the degraded provider is named as degraded')
    // Region + price caps exclude, and unknown regions go with them.
    const cn = orr.selectBestProvider([
      { tag: 'sila/fp8', provider_name: 'SiliconFlow', quantization: 'fp8', status: 0, pricing: { prompt: '0.00000014', completion: '0.00000028' } },
      { tag: 'parasail/fp8', provider_name: 'Parasail', quantization: 'fp8', status: 0, pricing: { prompt: '0.0000001', completion: '0.0000002' } },
    ], orr.parseRoutingConfig({ location: 'cn' }))
    equal(cn.best, 'sila/fp8', 'the region requirement keeps the placed provider, drops the rest')
    isTrue(cn.dropped.some(d => d.tag === 'parasail/fp8' && d.reason.includes('region')), 'the region rule is the named reason')
    const deckel = orr.selectBestProvider(eps, orr.parseRoutingConfig({ quant_min: 'fp8', max_in: '0.1' }))
    isFalse(deckel.ok, 'a cap that fits nobody filters everything — and says so')
  })

  await check('the config parses tolerantly and validates loudly', () => {
    const cfg = orr.parseRoutingConfig({ quant_min: 'fp8', location: 'DE', max_in: ' 1.5 ', max_out: '' })
    equal(cfg.quant_min, 'fp8', 'the minimum survives')
    equal(cfg.location, 'de', 'regions are normalized')
    equal(cfg.max_in, 1.5, 'a number string becomes a number')
    equal(cfg.max_out, undefined, 'an empty cap means "no cap", never 0')
    equal(orr.parseRoutingConfig({ quant_min: 'fp8' }).location, 'all', 'no region means everywhere')
    const murks = orr.parseRoutingConfig({ quant_min: 'nope' })
    equal(murks.error !== undefined, true, 'an unknown minimum is an ERROR, never a silent no-filter')
    equal(orr.routingConfigKey(orr.parseRoutingConfig({ location: 'us' })),
      orr.routingConfigKey(orr.parseRoutingConfig({ location: 'us', quant_min: '' })),
      'the cache key names the requirements, not the form fields')
  })

  await check('the plugin resolves and CACHES per model+config', async () => {
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
    isTrue(erst.ok && erst.best === 'a/fp8', `the cheapest healthy fp8 provider wins (${erst.best})`)
    equal(erst.cached, false, 'a first answer is fresh')
    const zweite = await plugin.routing.resolve(ctx, 'test/modell', cfg)
    equal(fetches, 1, 'the SAME model+config is served from the cache')
    isTrue(zweite.cached, 'and marked as cached')
    const andere = await plugin.routing.resolve(ctx, 'test/modell', orr.parseRoutingConfig({ quant_min: 'bf16' }))
    equal(fetches, 2, 'a DIFFERENT config is a different question — asked again')
    isFalse(andere.ok, 'a stricter requirement than the fixtures serve answers nothing (bf16: none)')
    // A forced refresh against a dead endpoint: the stale cache answer arrives,
    // marked veraltet — never a fresh failure dressed up as a selection.
    const ctxTot = { json: async () => { throw new Error('down') } }
    const veraltet = await plugin.routing.resolve(ctxTot, 'test/modell', cfg, { refresh: true })
    isTrue(veraltet.ok && veraltet.veraltet, `a failed fetch falls back to the stale answer (${veraltet.reason})`)
    const murks = await plugin.routing.resolveForRun(ctx, 'test/modell', { mode: 'auto', quant_min: 'nvfp4' })
    isFalse(murks.ok, 'an unparseable requirement never resolves to an order')
  })

  // ------------------------------------------------------------------
  group('Favorites: the setup of a run under a name (favorites.mjs)')
  const fv = await import('../server/favorites.mjs')

  await check('a favorite is the setup half — nothing about the task', async () => {
    const problems = []
    const fav = await fv.favoriteFromForm({
      name: '  Opus, thorough  ', harness: 'claude', model: ' claude-opus-5 ',
      skills: 'unlazy', skill_regler_unlazy: '4',
      // Fields of the run form that a favorite deliberately does not carry —
      // they must not leak into it through the same body.
      prompt: 'do something', branch_mode: 'neu', branch_pattern: 'x', expected_minutes: '90',
    }, problems)
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(fav.name, 'Opus, thorough', 'name trimmed')
    equal(fav.model, 'claude-opus-5', 'model trimmed')
    equal(fav.skills, '["unlazy:4"]', 'extra skill with its dial')
    isFalse('prompt' in fav, 'no prompt')
    isFalse('branchMode' in fav, 'no branch rule')
    isFalse('expectedMinutes' in fav, 'no expected duration')
  })
  await check('it refuses exactly what the run form refuses, plus a missing name', async () => {
    const p = []
    await fv.favoriteFromForm({ name: '   ', harness: 'claude', provider: 'openrouter' }, p)
    equal(p.length, 2, `name missing and a provider claude cannot use (${p.join(', ')})`)
    const p2 = []
    await fv.favoriteFromForm({ name: 'x', harness: 'gpt' }, p2)
    equal(p2.length, 1, `unknown coding agent (${p2.join(', ')})`)
  })
  // The whole point of storing only the setup: a Quick Run turns the favorite
  // back into a form body and goes through runDefFromForm() like every other
  // start. If this round trip broke, a favorite would quietly mean something
  // else than what was saved — which is exactly the drift run-def.mjs exists
  // to prevent.
  await check('a favorite becomes a form body again and yields the very same definition', async () => {
    const fdb5 = await import('../server/flows/db.mjs')
    const fid = fdb5.saveFlow({ name: 'fav-flow', trigger: { kind: 'run_finished' }, definition: { sequence: [] } })
    const gespeichert = {
      harness: 'claude', model: 'claude-opus-5', provider: null, or_provider: null, effort: null,
      skills: '["unlazy:4"]', flows: JSON.stringify([{ flowId: fid, when: 'failed' }]),
    }
    const body = fv.favoriteToFormBody(gespeichert)
    const def = await rd.runDefFromForm({ ...body, prompt: 'do it', branch_mode: 'keiner' }, [])
    equal(def.harness, 'claude', 'coding agent')
    equal(def.model, 'claude-opus-5', 'model')
    equal(def.skills, '["unlazy:4"]', 'skill including its dial survives the round trip')
    equal(def.flows, JSON.stringify([{ flowId: fid, when: 'failed' }]), 'attachment survives the round trip')
    equal(def.prompt, 'do it', 'the task comes from the dialog, not from the favorite')
    equal(def.expectedMinutes, rd.DEFAULT_EXPECTED_MINUTES, 'duration is not part of a favorite')
  })
  await check('a serving provider only survives where it can be passed through at all', async () => {
    const body = fv.favoriteToFormBody({
      harness: 'opencode', model: 'z-ai/glm-4.6', provider: 'openrouter', or_provider: 'novita',
      effort: null, skills: null, flows: null,
    })
    equal(body.or_mode, 'pin', 'the pin is set again from the stored value')
    const def = await rd.runDefFromForm({ ...body, prompt: 'x', branch_mode: 'keiner' }, [])
    equal(def.orProvider, 'novita', 'opencode + OpenRouter: passed through')
  })
  await check('there is room for exactly the cap, and a name is taken only once', () => {
    const mk = (name) => ({
      name, harness: 'claude', model: null, provider: null, or_provider: null,
      effort: null, skills: null, flows: null,
    })
    equal(fv.listFavorites().length, 0, 'nothing saved yet')
    for (let i = 1; i <= fv.FAVORITES_MAX; i++) isTrue(fv.saveFavorite({ fav: mk(`fav ${i}`) }).ok, `favorite ${i}`)
    isFalse(fv.saveFavorite({ fav: mk('one too many') }).ok, 'the cap holds')
    const erster = fv.listFavorites()[0].id
    isFalse(fv.saveFavorite({ id: erster, fav: mk('fav 2') }).ok, 'a taken name is refused while editing too')
    isTrue(fv.saveFavorite({ id: erster, fav: mk('fav 1') }).ok, 'its own name stays free for itself')
    fv.deleteFavorite(erster)
    isTrue(fv.saveFavorite({ fav: mk('now there is room again') }).ok, 'a removed one frees its slot')
  })

  // ------------------------------------------------------------------
  group('Run title (title.mjs)')
  const ti = await import('../server/title.mjs')

  await check('the fallback is the first line of the prompt that says something', () => {
    equal(ti.fallbackTitle('Rewrite the login form'), 'Rewrite the login form', 'plain line')
    equal(ti.fallbackTitle('\n\n   \n# Rewrite the login form\n\nand more'), 'Rewrite the login form',
      'empty lines and the heading marker skipped')
    equal(ti.fallbackTitle('- **fix** the `parser`'), 'fix the parser', 'list bullet and inline markdown removed')
    equal(ti.fallbackTitle('1. First step'), 'First step', 'numbered list')
    equal(ti.fallbackTitle('   '), '', 'nothing to take')
    equal(ti.fallbackTitle('ok'), '', 'too short to be a title')
  })
  await check('a long line is cut at a whole word', () => {
    const lang = ti.fallbackTitle('Rewrite the complete authentication of the web interface including all of its tests', 40)
    isTrue(lang.length <= 40, `at most 40 characters: ${lang.length}`)
    isTrue(lang.endsWith('…'), `marked as cut: ${lang}`)
    isFalse(/\s…$/.test(lang), `no space before the ellipsis: ${lang}`)
  })
  await check('the title on screen: own title, then agent name, then the generic word', () => {
    equal(ti.runTitle({ title: 'Own title' }, 'nightly', '(single run)'), 'Own title', 'own title wins')
    equal(ti.runTitle({ title: '  ' }, 'nightly', '(single run)'), 'nightly', 'blank counts as none')
    equal(ti.runTitle({ title: null }, null, '(single run)'), '(single run)', 'no title, no agent')
  })
  await check('without a key or switched off nothing is requested — the run keeps the fallback', () => {
    const key = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    isFalse(ti.titleLlmActive(), 'no key = off')
    if (key !== undefined) process.env.OPENROUTER_API_KEY = key
  })

  // ------------------------------------------------------------------
  group('Worktree extras suggestion (extras-suggest.mjs)')
  const ex = await import('../server/extras-suggest.mjs')

  await check('the algorithmic checks come first and need no model', async () => {
    const key = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'k'
    try {
      const leer = await ex.suggestExtras('')
      isFalse(leer.ok, 'empty path is refused')
      const weg = await ex.suggestExtras('/does/not/exist')
      isFalse(weg.ok, 'missing directory is refused')
      contains(weg.error, 'does/not/exist', 'and names the path')
      const keinGit = await ex.suggestExtras(sandkasten)
      isFalse(keinGit.ok, 'a directory without .git is refused')
      contains(keinGit.error, 'git', 'and says so')
    } finally {
      if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key
    }
  })
  await check('the suggestion is normalized: only untracked entries, only known modes, deduped', () => {
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
    equal(JSON.stringify(gut), JSON.stringify([{ path: '.env', mode: 'copy' }, { path: 'referenz/', mode: 'link' }]),
      'the two valid suggestions survive, a directory carries its trailing slash')
  })
  await check('nonsense from the model is an empty list, not a crash', () => {
    const ctx = { entries: [{ name: '.env', dir: false }], tracked: new Set(), ignored: new Set() }
    equal(ex.normalizeExtras(null, ctx).length, 0, 'null')
    equal(ex.normalizeExtras({ extras: 'nicht-liste' }, ctx).length, 0, 'non-list')
    equal(ex.normalizeExtras({}, ctx).length, 0, 'empty object')
  })
  await check('off means off: no model, no key, or the switch — and the default model is preset', () => {
    const key = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    isFalse(ex.extrasLlmActive(), 'no key = off')
    if (key !== undefined) process.env.OPENROUTER_API_KEY = key
    equal(ex.extrasModel(), ex.DEFAULT_EXTRAS_MODEL, 'default model while nothing is configured')
  })
  await check('a real repo is turned into a prompt and the answer normalized', async () => {
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
      isTrue(r.ok, `ok (${r.error ?? ''})`)
      equal(JSON.stringify(r.extras),
        JSON.stringify([{ path: '.env', mode: 'copy' }, { path: 'referenz/', mode: 'link' }]),
        'the two real entries survive, the invented one is dropped')
      equal(koerper.model, ex.DEFAULT_EXTRAS_MODEL, 'the configured model is sent')
      contains(koerper.messages[1].content, 'referenz', 'the prompt carries the listing')
    } finally {
      globalThis.fetch = echt
      if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key
      if (basis === undefined) delete process.env.FREILAUF_OPENROUTER_BASE; else process.env.FREILAUF_OPENROUTER_BASE = basis
      rmSync(repo, { recursive: true, force: true })
    }
  })
  await check('a model that finds nothing is a success with [], not an error', async () => {
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
      isTrue(r.ok, `ok — an empty answer is an answer (${r.error ?? ''})`)
      equal(JSON.stringify(r.extras), '[]', 'and the field gets exactly that')
    } finally {
      globalThis.fetch = echt
      if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key
      if (basis === undefined) delete process.env.FREILAUF_OPENROUTER_BASE; else process.env.FREILAUF_OPENROUTER_BASE = basis
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // ------------------------------------------------------------------
  group('Planned start of a single run (run-def.mjs)')

  await check('without a choice a run starts immediately, as it always did', () => {
    const s = rd.runStartFromForm({})
    equal(s.startMode, 'now', 'mode')
    equal(s.startAt, null, 'no point in time')
    equal(s.title, null, 'no title = generated later')
  })
  await check('a point in time is stored as UTC and keeps its meaning', () => {
    const problems = []
    const s = rd.runStartFromForm({ start_mode: 'at', start_at: '2026-08-25T09:00' }, problems)
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(s.startMode, 'at', 'mode')
    equal(parseDbUtc(s.startAt), Date.parse('2026-08-25T09:00'), 'the local input, read back as UTC')
  })
  await check('"in n minutes" becomes exactly that point in time', () => {
    const now = Date.parse('2026-08-25T12:00:00Z')
    const s = rd.runStartFromForm({ start_mode: 'in', start_in_minutes: '20' }, [], now)
    equal(s.startMode, 'at', 'stored as a point in time — the DB knows two waiting kinds, not three')
    equal(parseDbUtc(s.startAt), now + 20 * 60_000, '20 minutes later')
  })
  await check('"when the repo is free" carries no point in time', () => {
    const s = rd.runStartFromForm({ start_mode: 'idle' })
    equal(s.startMode, 'idle', 'mode')
    equal(s.startAt, null, 'nothing to wait for by the clock')
  })
  await check('a broken entry is a problem, not a run that starts at the wrong time', () => {
    const p1 = []
    equal(rd.runStartFromForm({ start_mode: 'at', start_at: 'nonsense' }, p1).startMode, 'now', 'falls back to now')
    equal(p1.length, 1, `unreadable point in time (${p1.join(', ')})`)
    const p2 = []
    rd.runStartFromForm({ start_mode: 'in', start_in_minutes: '0' }, p2)
    equal(p2.length, 1, `zero minutes (${p2.join(', ')})`)
    const p3 = []
    rd.runStartFromForm({ start_mode: 'someday' }, p3)
    equal(p3.length, 1, `unknown kind (${p3.join(', ')})`)
  })
  await check('the title is trimmed and capped, an empty one stays empty', () => {
    equal(rd.runStartFromForm({ title: '  Rewrite login  ' }).title, 'Rewrite login', 'trimmed')
    equal(rd.runStartFromForm({ title: '   ' }).title, null, 'blank = none')
    equal(rd.runStartFromForm({ title: 'x'.repeat(200) }).title.length, ti.TITLE_MAX, 'capped')
  })

  // ------------------------------------------------------------------
  group('Run editing: what may change before and during a run (run-edit.mjs)')

  const { db: edb } = await import('../server/db.mjs')
  const { runEditAllowed, editRun } = await import('../server/run-edit.mjs')
  const { fallbackTitle: fb } = await import('../server/title.mjs')

  await check('the permission matrix: a scheduled run is fully editable, a deferred one has no start time, a running one only its duration', () => {
    const erlaubt = (s) => JSON.stringify(runEditAllowed({ status: s }))
    equal(erlaubt('scheduled'), '{"duration":true,"prompt":true,"repo":true,"startTime":true,"branch":true}', 'scheduled')
    equal(erlaubt('deferred'), '{"duration":true,"prompt":true,"repo":true,"startTime":false,"branch":true}', 'deferred: no start time — it waits on quota, not on a time')
    equal(erlaubt('running'), '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}', 'running')
    equal(erlaubt('waiting_help'), '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}', 'waiting for a human is still running')
    for (const s of ['done', 'failed', 'aborted']) {
      equal(erlaubt(s), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false}', `${s}: nothing left to edit`)
    }
    // A finished run with an open follow-up commission is working again — its
    // duration is read live by the watcher's overrun thresholds, exactly as for
    // a running run.
    const followup = (extra) => JSON.stringify(runEditAllowed({ status: 'done', ...extra }))
    equal(followup({ followup_since: '2026-01-01 00:00:00' }),
      '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}',
      'a follow-up commission reopens the duration for editing')
    equal(followup({ followup_open: 1 }),
      '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false}',
      'a follow-up in the gate too')
    equal(followup({}), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false}',
      'a plain finished run stays closed')
    equal(JSON.stringify(runEditAllowed(null)), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false}', 'no run')
  })

  await check('editing a scheduled run: prompt, duration, repo, branch and start time are applied and recorded', async () => {
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
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    equal(lauf.prompt, 'E2E neu', 'new prompt')
    equal(lauf.expected_minutes, 120, 'new duration')
    equal(lauf.repo_id, b, 'moved to the other repo')
    equal(lauf.branch_mode, 'neu', 'new branch mode')
    equal(lauf.branch_pattern, 'agent/edit', 'new branch pattern')
    equal(lauf.start_mode, 'at', 'start mode stays at')
    // Same local-time reading the form's own parser makes of the input; the DB
    // stores whatever that is in UTC, so the expected value is derived from the
    // same Date.parse and stays correct in every timezone.
    equal(lauf.start_at, toDbUtc(Date.parse('2030-01-05 09:30')), 'the start time moved')
    equal(lauf.title, fb('E2E neu'), 'a prompt-derived title follows the prompt')
    const ev = edb.prepare(`SELECT payload FROM events WHERE run_id=? AND kind='edited'`).get(id)
    equal(ev.payload, JSON.stringify({ fields: ['duration', 'prompt', 'repo', 'start', 'branch'], repo_id: b }), 'the event names every changed field, and the move names its target')
  })

  await check('a planned run can be told to wait for the repo ("idle")', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-idle'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, start_mode, start_at)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL,'at','2030-01-01 00:00:00')`).run(id, a)
    const problems = []
    const r = await editRun(id, { startMode: 'idle' }, problems)
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    equal(lauf.start_mode, 'idle', 'now waiting for the repo')
    equal(lauf.start_at, null, 'the point in time is gone')
  })

  await check('a planned run can be told "start now" — that is an action, not a column write', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-now'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, start_mode, start_at)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL,'at','2030-01-01 00:00:00')`).run(id, a)
    const problems = []
    // Nothing else changes — "now" alone must not bounce off the nothing-to-save wall.
    const r = await editRun(id, { startMode: 'now' }, problems)
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(r.ok, true, 'accepted')
    equal(r.startNow, true, 'the caller is told to start it')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    equal(lauf.start_mode, 'at', 'no stored mode for "now"')
    equal(lauf.start_at, '2030-01-01 00:00:00', 'the columns stay — the run starts instead')
  })

  await check('"in n minutes" is resolved to a point in time at edit time too', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-in'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, start_mode, start_at)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL,'idle',NULL)`).run(id, a)
    const vorher = Date.now()
    const problems = []
    const r = await editRun(id, { startMode: 'in', startInMinutes: '90' }, problems)
    const nachher = Date.now()
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    equal(lauf.start_mode, 'at', '"in" becomes "at"')
    const ms = parseDbUtc(lauf.start_at)
    // A second of slack below: the stored stamp is truncated to whole seconds.
    isTrue(ms >= vorher + 90 * 60_000 - 1000 && ms <= nachher + 90 * 60_000, '90 minutes from now, resolved here')
  })

  await check('a deferred run cannot be given a new start time', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-def'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'deferred','claude','p','keiner',45,NULL)`).run(id, a)
    const problems = []
    await editRun(id, { startMode: 'at', startAt: '2030-02-02 10:00' }, problems)
    equal(problems.length, 1, `refused (${problems.join(', ')})`)
    contains(problems[0], 'waiting for its start', 'the reason says only a waiting run')
  })

  await check('the branch rule is validated like the run form validates it', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-branch'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL)`).run(id, a)
    const p1 = []
    await editRun(id, { branchMode: 'neu' }, p1)
    equal(p1.length, 1, `a branch needs a pattern (${p1.join(', ')})`)
    const p2 = []
    await editRun(id, { branchMode: 'keiner', keepOnBranch: 1 }, p2)
    equal(p2.length, 1, `keeping work on a branch needs a branch (${p2.join(', ')})`)
    const p3 = []
    await editRun(id, { branchMode: 'kaputt' }, p3)
    // The same double report the run form produces: an unknown mode AND the
    // pattern that a non-'keiner' mode requires.
    isTrue(p3.length >= 1, `an unknown mode is refused (${p3.join(', ')})`)
    const p4 = []
    // A fixed branch named after the base branch is refused when that worktree
    // holds it — but the test repos do not exist, so branchWorktree answers null
    // and the edit goes through; the launch-time check catches it there.
    const r = await editRun(id, { branchMode: 'fest', branchPattern: 'main', keepOnBranch: 1 }, p4)
    equal(p4.length, 0, `no problems (${p4.join(', ')})`)
    equal(r.ok, true, 'applied')
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    equal(lauf.branch_mode, 'fest', 'fixed branch set')
    equal(lauf.branch_pattern, 'main', 'with its pattern')
    equal(lauf.keep_on_branch, 1, 'and the keep flag')
  })

  await check('a renamed run keeps its name when the prompt changes', async () => {
    const id = 'edit-run-0002'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','E2E alt 2','keiner',45,'Renamed by hand')`)
      .run(id, edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id)
    const problems = []
    await editRun(id, { prompt: 'E2E neu 2' }, problems)
    equal(problems.length, 0, `no problems (${problems.join(', ')})`)
    equal(edb.prepare('SELECT title FROM runs WHERE id=?').get(id).title, 'Renamed by hand', 'an operator name wins')
  })

  await check('moving to the repo the run already lives in is a no-op, not an error', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0003'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL)`).run(id, a)
    const problems = []
    await editRun(id, { repoId: a }, problems)
    // The combined form pre-fills the select; a duration-only edit must not
    // fail on its own untouched field. With ONLY the repo submitted nothing
    // changed at all, which is the honest 'nothing to save'.
    equal(problems.length, 1, `nothing changed: ${problems.join(', ')}`)
    equal(problems[0], 'Nothing to save.', 'the message names it')
  })

  await check('a running run accepts only its duration', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0004'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'running','claude','lauf','keiner',45,NULL)`).run(id, a)
    const p1 = []
    await editRun(id, { prompt: 'anders' }, p1)
    equal(p1.length, 1, `prompt refused for a started run (${p1.join(', ')})`)
    const p2 = []
    await editRun(id, { repoId: edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-b'`).get().id }, p2)
    equal(p2.length, 1, `move refused for a started run (${p2.join(', ')})`)
    const p2b = []
    await editRun(id, { branchMode: 'neu', branchPattern: 'x' }, p2b)
    equal(p2b.length, 1, `branch rule refused for a started run (${p2b.join(', ')})`)
    const p2c = []
    await editRun(id, { startMode: 'at', startAt: '2030-03-03 10:00' }, p2c)
    equal(p2c.length, 1, `start time refused for a started run (${p2c.join(', ')})`)
    const p3 = []
    const ok = await editRun(id, { expectedMinutes: '7' }, p3)
    equal(p3.length, 0, `duration accepted (${p3.join(', ')})`)
    equal(ok.ok, true, 'applied')
    equal(edb.prepare('SELECT expected_minutes FROM runs WHERE id=?').get(id).expected_minutes, 7, 'new duration')
    equal(edb.prepare('SELECT prompt FROM runs WHERE id=?').get(id).prompt, 'lauf', 'prompt untouched')
  })

  await check('a finished run is not editable at all', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0005'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'done','claude','fertig','keiner',45,NULL)`).run(id, a)
    const problems = []
    await editRun(id, { expectedMinutes: '1' }, problems)
    equal(problems.length, 1, `refused (${problems.join(', ')})`)
  })

  await check('invalid input is a problem, never a partial write', async () => {
    const a = edb.prepare(`SELECT id FROM repos WHERE name='edit-repo-a'`).get().id
    const id = 'edit-run-0006'
    edb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title)
                 VALUES(?,?,'scheduled','claude','p','keiner',45,NULL)`).run(id, a)
    const p1 = []
    await editRun(id, { prompt: '   ' }, p1)
    equal(p1.length, 1, `empty prompt (${p1.join(', ')})`)
    const p2 = []
    await editRun(id, { expectedMinutes: '0' }, p2)
    equal(p2.length, 1, `zero minutes (${p2.join(', ')})`)
    const p3 = []
    await editRun(id, { expectedMinutes: 'abc' }, p3)
    equal(p3.length, 1, `nonsense (${p3.join(', ')})`)
    const p4 = []
    await editRun(id, { repoId: '99999' }, p4)
    equal(p4.length, 1, `unknown repo (${p4.join(', ')})`)
    const p5 = []
    await editRun(id, { startMode: 'at', startAt: 'nonsense' }, p5)
    equal(p5.length, 1, `unreadable start time (${p5.join(', ')})`)
    const p6 = []
    await editRun(id, { startMode: 'someday' }, p6)
    equal(p6.length, 1, `unknown start mode (${p6.join(', ')})`)
    const p7 = []
    await editRun('does-not-exist', { prompt: 'x' }, p7)
    equal(p7.length, 1, `unknown run (${p7.join(', ')})`)
    const lauf = edb.prepare('SELECT * FROM runs WHERE id=?').get(id)
    equal(lauf.prompt, 'p', 'nothing of the failed edits landed')
    equal(lauf.expected_minutes, 45, 'duration untouched')
  })

  // ------------------------------------------------------------------
  group('tmux sessions: reading, judging, keeping (sessions.mjs)')

  const se = await import('../server/sessions.mjs')
  // Exactly the two format strings sessions.mjs asks tmux for, tab-separated.
  const SESSION_LINES = [
    'fl-einzel-aaaa\t1787600000\t0\t1\t1787600500\t/srv/worktrees/a',
    'fl-einzel-bbbb\t1787500000\t1\t2\t1787500900\t/srv/worktrees/b',
  ].join('\n')

  await check('a session line becomes a session, the path may contain tabs', () => {
    const s = se.parseSessions(SESSION_LINES + '\ncc-tab\t1787400000\t0\t1\t1787400000\t/srv/a\tb')
    equal(s.length, 3, 'three sessions')
    equal(s[0].name, 'fl-einzel-aaaa', 'name')
    equal(s[0].createdMs, 1787600000000, 'created in ms')
    isFalse(s[0].attached, 'not attached')
    isTrue(s[1].attached, 'attached')
    equal(s[1].windows, 2, 'windows')
    equal(s[2].path, '/srv/a\tb', 'the tab stays in the path instead of shifting a field')
  })

  await check('an empty or unreachable listing yields nothing, not a crash', () => {
    equal(se.parseSessions('').length, 0, 'empty')
    equal(se.parseSessions('no server running on /tmp/tmux-1000/default').length, 0, 'tmux error text')
  })

  await check('panes decide whether a session still works', () => {
    const s = se.mergePanes(se.parseSessions(SESSION_LINES), [
      'fl-einzel-aaaa\t0\t111\t\t\tclaude',
      'fl-einzel-bbbb\t1\t222\t0\t1787501000\tbash',
      'fl-einzel-bbbb\t1\t223\t0\t1787502000\tbash',
    ].join('\n'))
    isFalse(s[0].dead, 'a live pane keeps the session alive')
    equal(s[0].command, 'claude', 'command of the live pane')
    isTrue(s[1].dead, 'all panes dead = session dead')
    equal(s[1].paneCount, 2, 'both panes counted')
    equal(s[1].deadMs, 1787501000000, 'the EARLIEST death is when it stopped working')
  })

  await check('resources are counted over the whole process tree, not just the pane', () => {
    // 100 = the pane's shell, 101 = the agent below it, 102 = its child.
    const baum = se.parsePs(['  100 1 2000 1.0', '  101 100 500000 30.0', '  102 101 1000 2.0',
      '  200 1 9999 5.0'].join('\n'))
    const r = se.processTree(baum, 100)
    equal(r.count, 3, 'shell + agent + child')
    equal(r.rssKb, 503000, 'summed RSS')
    equal(Math.round(r.cpu * 10) / 10, 33, 'summed CPU')
    equal(se.processTree(baum, 999).count, 0, 'an unknown pid costs nothing')
  })

  await check('a process tree with a cycle terminates', () => {
    // Not reachable through real ps output, but a parser must not hang on it.
    const baum = se.parsePs(['  10 11 100 0.0', '  11 10 100 0.0'].join('\n'))
    equal(se.processTree(baum, 10).count, 2, 'each process counted once')
  })

  await check('"finished" is the earlier of run end and process end', () => {
    const lebt = { dead: false, deadMs: null, createdMs: 1000 }
    const tot = { dead: true, deadMs: 5000, createdMs: 1000 }
    equal(se.finishedAtMs(lebt, { status: 'running' }), null, 'a working session is never finished')
    equal(se.finishedAtMs(tot, null), 5000, 'dead pane without a run')
    // The claude case: the run reported 'done', the TUI keeps its pane alive.
    // Exactly this is what the old rule (dead pane only) never caught.
    equal(se.finishedAtMs(lebt, { status: 'done', ended_at: '2026-08-25 10:00:00' }),
      Date.parse('2026-08-25T10:00:00Z'), 'the run end alone is enough')
    equal(se.finishedAtMs(tot, { status: 'done', ended_at: '1970-01-01 00:00:03' }), 3000, 'the earlier one wins')
    equal(se.finishedAtMs({ dead: true, deadMs: null, createdMs: 7000 }, null), 7000,
      'a dead pane without a timestamp still counts as finished')
  })

  await check('the keep time comes from the hours, the old days are the fallback', () => {
    equal(se.sessionKeepMs({ session_keep_hours: '2' }), 2 * 3600_000, 'hours')
    equal(se.sessionKeepMs({ session_keep_hours: '0' }), 0, 'zero means right away, not "unset"')
    equal(se.sessionKeepMs({ session_keep_hours: '0.5' }), 1800_000, 'half hours are allowed')
    equal(se.sessionKeepMs({ retention_days: '2' }), 2 * 86_400_000, 'old setting still counts')
    equal(se.sessionKeepMs({ session_keep_hours: '', retention_days: '1' }), 86_400_000, 'empty falls through')
    equal(se.sessionKeepMs({}), 3 * 86_400_000, 'default: three days, as before')
    equal(se.sessionKeepHours({ session_keep_hours: '1.5' }), 1.5, 'the form gets hours back')
  })

  await check('the archive-session rule: on by default with keep 0, switchable off', () => {
    equal(se.archiveSessionKeepMs({}), 0, 'default: close right away')
    equal(se.archiveSessionKeepMs({ archive_session_keep_hours: '2' }), 2 * 3600_000, 'hours')
    equal(se.archiveSessionKeepMs({ archive_session_keep_hours: '0.5' }), 1800_000, 'half hours are allowed')
    equal(se.archiveSessionKeepMs({ archive_session_on: '0' }), null, 'switched off: no archive rule')
    equal(se.archiveSessionKeepMs({ archive_session_on: '0', archive_session_keep_hours: '2' }), null, 'off wins over hours')
    equal(se.archiveSessionKeepMs({ archive_session_on: '', archive_session_keep_hours: '2' }), null, 'empty is not "1" either')
    equal(se.archiveSessionKeepHours({ archive_session_keep_hours: '1.5' }), 1.5, 'the form gets hours back')
    equal(se.archiveSessionKeepHours({ archive_session_on: '0', archive_session_keep_hours: '1.5' }), 1.5,
      'the hours survive a switch-off — an off switch must not clear the field')
  })

  await check('an archived run is closed once its keep time after the archive has passed', () => {
    const jetzt = 1_000_000_000_000   // = 2001-09-09 01:46:40 UTC
    const run = { archived_at: '2001-09-09 01:46:40' }   // exactly `jetzt` in DB form
    isTrue(se.shouldCloseArchived(run, 0, jetzt), 'keep 0 closes right away')
    isFalse(se.shouldCloseArchived(run, 3600_000, jetzt), 'keep 1 h: just archived, stays')
    const alt = { archived_at: '2001-09-09 00:46:40' }   // one hour earlier
    isTrue(se.shouldCloseArchived(alt, 3600_000, jetzt), 'an hour later the same keep closes it')
    equal(se.shouldCloseArchived(run, null, jetzt), false, 'off never closes by archive')
    equal(se.shouldCloseArchived({ ...run, archived_at: null }, 0, jetzt), false, 'not archived: nothing to close')
    equal(se.shouldCloseArchived({ archived_at: 'kaputt' }, 0, jetzt), false, 'an unparsable timestamp closes nothing')
  })

  await check('only a finished session is closed automatically', () => {
    const jetzt = 1_000_000_000
    const lebt = { dead: false, deadMs: null }
    const fertig = { dead: true, deadMs: jetzt - 7200_000 }      // finished two hours ago
    isFalse(se.shouldAutoClose(lebt, { status: 'running' }, 3600_000, jetzt), 'a working agent is never closed')
    isTrue(se.shouldAutoClose(fertig, null, 3600_000, jetzt), 'two hours old, keep one hour')
    isFalse(se.shouldAutoClose(fertig, null, 4 * 3600_000, jetzt), 'keep four hours: stays')
    isTrue(se.shouldAutoClose(lebt, { status: 'done', ended_at: '1970-01-01 00:00:00' }, 0, jetzt),
      'keep 0 closes a finished run right away, even with a live pane')
  })

  // The bug this exists for: 'no answer' used to be indistinguishable from
  // 'nothing there', and the watcher spends 'nothing there' by ABORTING runs.
  // One failed tmux call therefore ended every running run on the machine.
  await check('tmux "I cannot answer" is never read as "there is nothing"', () => {
    equal(se.tmuxVerdict({ ok: true, stdout: 'cc-einzel-1\t1\t0\t1\t1\t/tmp', stderr: '' }), 'ok', 'an answer is an answer')
    // Measured against tmux 3.4, both wordings.
    equal(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)' }),
      'no_server', 'no socket: there really is no session')
    equal(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'no server running on /tmp/tmux-1000/default' }),
      'no_server', 'the older wording says the same')
    // Everything below used to arrive as an empty session list.
    equal(se.tmuxVerdict({ ok: false, stdout: '', stderr: '', code: 'ETIMEDOUT' }), 'unreachable', "sh()'s 30 s timeout")
    equal(se.tmuxVerdict({ ok: false, stdout: '', stderr: '', code: 'ENOENT' }), 'unreachable', 'no tmux binary')
    equal(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'fork failed: Cannot allocate memory' }),
      'unreachable', 'a fork that failed under memory pressure')
    equal(se.tmuxVerdict({ ok: false, stdout: '', stderr: 'server exited unexpectedly' }), 'unreachable', 'a server that died mid-answer')
  })

  await check('one session is gone, is there, or did not say', () => {
    equal(se.sessionGoneFrom({ ok: true, stdout: '', stderr: '' }), false, 'has-session succeeded: it is there')
    equal(se.sessionGoneFrom({ ok: false, stdout: '', stderr: "can't find session: cc-einzel-1" }), true, 'tmux named it: gone')
    equal(se.sessionGoneFrom({ ok: false, stdout: '', stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)' }),
      true, 'no server at all: gone')
    // null is the whole point — the caller must not end a run on it.
    equal(se.sessionGoneFrom({ ok: false, stdout: '', stderr: '', code: 'ETIMEDOUT' }), null, 'a timeout says nothing')
    equal(se.sessionGoneFrom({ ok: false, stdout: '', stderr: 'fork failed: Cannot allocate memory' }), null, 'a failed fork says nothing')
  })

  await check('the state is what the page shows, and it decides what is hidden', () => {
    const lebt = { dead: false }, tot = { dead: true }
    equal(se.sessionState(lebt, { status: 'running' }), 'agent_running', 'running')
    equal(se.sessionState(lebt, { status: 'waiting_help' }), 'agent_running', 'waiting for an answer is still running')
    equal(se.sessionState(lebt, { status: 'done' }), 'run_ended', 'run over, session open')
    // A dead pane beats the record: whatever the row says, nothing works there.
    equal(se.sessionState(tot, { status: 'running' }), 'dead', 'dead pane beats the status')
    equal(se.sessionState(lebt, null), 'unknown', 'foreign session')
    equal(se.sessionState(tot, null), 'dead', 'foreign dead session')
  })

  await check('automatic closing only ever touches sessions with a run of this hub', () => {
    const jetzt = 1_000_000_000
    const alt = { dead: true, deadMs: jetzt - 86_400_000 }
    const liste = [
      { ...alt, name: 'mit-lauf', run: { status: 'done', ended_at: null } },
      { ...alt, name: 'fremd', run: null },
    ]
    const k = se.autoCloseCandidates(liste, 3600_000, jetzt).map(s => s.name)
    equal(k.join(','), 'mit-lauf', 'a foreign session is only ended by hand')
  })

  await check('the memory reading is measured on ONE clock: the cache is the update interval', async () => {
    // The sidebar asks for this on every page and re-fetches itself every 30 s;
    // what keeps `tmux list-sessions` and a `ps` over the whole machine from
    // running that often is this cache alone. So the cache IS the eight-minute
    // interval, and that is what is tested here — not the number, which belongs
    // to whatever tmux happens to hold on the machine running the suite.
    se._sessionMemoryReset()
    const a = await se.sessionMemory()
    isTrue(a && Number.isFinite(a.rssKb) && a.rssKb >= 0, `a measurement (${JSON.stringify(a)})`)
    isTrue(a.sessions >= 0 && a.running >= 0 && a.running <= a.sessions,
      'the running ones are a subset of all of them')
    equal(a.intervalMs, 8 * 60_000, 'eight minutes by default, and it travels with the value')
    equal(await se.sessionMemory(), a, 'a second call inside the window measures nothing anew')
    // Expired: what comes back is still the old object (stale-while-revalidate —
    // no page render may wait on three subprocesses), and the refresh behind it
    // replaces it.
    se._sessionMemoryAge(9 * 60_000)
    equal(await se.sessionMemory(), a, 'an expired entry is handed back as it stands')
    await new Promise(r => setTimeout(r, 300))
    const b = await se.sessionMemory()
    isTrue(b.measuredAtMs >= a.measuredAtMs, 'and behind it a fresh measurement landed')
    se._sessionMemoryReset()
  })

  // ------------------------------------------------------------------
  group('Integration: finish gate, integrator, escalation (integrate.mjs)')

  const ig = await import('../server/integrate.mjs')

  await check('the check interval is dense at first and slows down', () => {
    equal(ig.nextCheckDelayMs(0), 5000, 'right after the report')
    equal(ig.nextCheckDelayMs(59_000), 5000, 'still under a minute')
    equal(ig.nextCheckDelayMs(60_000), 15_000, 'from a minute on')
    equal(ig.nextCheckDelayMs(4 * 60_000), 15_000, 'under five minutes')
    equal(ig.nextCheckDelayMs(5 * 60_000), 30_000, 'from five minutes on')
    equal(ig.nextCheckDelayMs(NaN), 5000, 'no timestamp: as at the start')
  })

  await check('what the hub put into the worktree is not the agent’s dirt', () => {
    const porcelain = [
      '?? referenz',
      '?? .cursor/hooks.json',
      ' M server/hub.mjs',
      '?? neu.txt',
    ].join('\n')
    const fremd = ig.foreignChanges(porcelain, ['referenz', '.cursor'])
    equal(fremd.join(','), 'server/hub.mjs,neu.txt', 'only the agent’s own changes')
  })

  await check('the extras are filtered as a directory AND as a single file', () => {
    // git names the directory when everything below it is untracked, and the
    // single file when it is not — both forms have to be covered.
    equal(ig.foreignChanges('?? .cursor/\n', ['.cursor']).length, 0, 'directory form with a slash')
    equal(ig.foreignChanges('?? .cursor/hooks.json\n', ['.cursor']).length, 0, 'file below it')
    equal(ig.foreignChanges('?? .cursorrules\n', ['.cursor']).length, 1, 'a neighbour with the same prefix is NOT ours')
  })

  await check('an empty status is an empty list, not a crash', () => {
    equal(ig.foreignChanges('', []).length, 0, 'empty')
    equal(ig.foreignChanges(null, null).length, 0, 'nothing at all')
  })

  await check('the finish gate decides in this order: dirty, commits, conflict', () => {
    equal(ig.decideFinish({ dirty: true, commits: true, conflict: true }), 'awaiting_commit', 'dirt outranks everything')
    equal(ig.decideFinish({ dirty: true, commits: false, conflict: false }), 'awaiting_commit', 'dirty without commits')
    equal(ig.decideFinish({ dirty: false, commits: false, conflict: false }), 'nothing', 'nothing committed')
    equal(ig.decideFinish({ dirty: false, commits: true, conflict: true }), 'awaiting_merge', 'conflict')
    equal(ig.decideFinish({ dirty: false, commits: true, conflict: false }), 'merging', 'clean and mergeable')
  })

  await check('an unfinished run is classified by commits and dirt', () => {
    equal(ig.classifyUnmerged({ commits: 2, dirty: 0 }), 'unmerged_commits', 'only commits')
    equal(ig.classifyUnmerged({ commits: 2, dirty: 3 }), 'unmerged_both', 'both')
    equal(ig.classifyUnmerged({ commits: 0, dirty: 3 }), 'unmerged_dirty', 'only dirt')
    equal(ig.classifyUnmerged({ commits: 0, dirty: 0 }), 'nothing', 'neither')
  })

  await check('the operator’s own commits are pushed, never forced', () => {
    equal(ig.decidePush({ ahead: 0, behind: 0 }), 'skip', 'in sync')
    equal(ig.decidePush({ ahead: 0, behind: 4 }), 'skip', 'only origin moved')
    equal(ig.decidePush({ ahead: 3, behind: 0 }), 'push', 'fast-forward')
    equal(ig.decidePush({ ahead: 3, behind: 4 }), 'diverged', 'both moved: a human decides')
  })

  await check('git merge-tree’s output becomes the list of conflicting files', () => {
    const stdout = [
      'e99c659e743683c311fe49f74f1693a866fb1886',
      'f.txt',
      'server/hub.mjs',
      '',
      'Auto-merging f.txt',
      'CONFLICT (content): Merge conflict in f.txt',
    ].join('\n')
    equal(ig.conflictFilesFromMergeTree(stdout).join(','), 'f.txt,server/hub.mjs', 'the paths, not the prose')
    equal(ig.conflictFilesFromMergeTree('abc123\n').length, 0, 'a clean merge names no file')
  })

  await check('a file list is indented and capped', () => {
    equal(ig.formatFiles([]), '  (none)', 'nothing to list')
    equal(ig.formatFiles(['a.txt', 'b/c.txt']), '  a.txt\n  b/c.txt', 'indented')
    const many = ig.formatFiles(Array.from({ length: 35 }, (_, i) => `f${i}.txt`))
    equal(many.split('\n').length, 31, '30 lines plus the note')
    contains(many, '… and 5 more', 'says how many were left out')
  })

  await check('the messages to the agent carry every placeholder filled in', () => {
    const m1 = ig.fill(ig.M1, { files: '  a.txt', report_file: '/runs/x/report.md', timeout: 15 })
    contains(m1, 'NOT finished yet', 'says the run is not over')
    contains(m1, '  a.txt', 'the file')
    contains(m1, 'fl-report done --file /runs/x/report.md', 'the exact command')
    contains(m1, 'after 15 minutes', 'the deadline')
    isFalse(/\{[a-z_]+\}/.test(m1), 'no placeholder left over')

    const m2 = ig.fill(ig.M2, { base: 'main', files: '  a.txt', report_file: '/r.md', landed_runs: '- "x" (abc1234): y' })
    contains(m2, 'git fetch origin && git merge origin/main', 'the command that resolves it')
    contains(m2, 'Do NOT merge into or push to main yourself', 'the ground rule')
    isFalse(/\{[a-z_]+\}/.test(m2), 'no placeholder left over')
  })

  await check('the conflict run’s task names branch, reason, report and what landed', () => {
    const p = ig.fill(ig.P_CONFLICT, {
      branch: 'resolve/abc1234', base: 'main',
      orig_title: 'Add a goal field', orig_id: 'aaaa-bbbb',
      reason: 'merge conflict', files: '  server/db.mjs',
      check_line: 'Run the merge check and make it pass: `node test/unit.mjs`',
      orig_report: 'It did the thing.', landed_runs: '- "other" (def5678): moved things',
      resolver_extra: '',
    })
    contains(p, 'make the branch `resolve/abc1234` mergeable', 'its own branch')
    contains(p, '"Add a goal field" (Freilauf run aaaa-bbbb)', 'the run it works for')
    contains(p, 'BOTH intentions survive', 'the rule that keeps work from being dropped')
    contains(p, 'It did the thing.', 'the original report')
    contains(p, 'never push to main yourself', 'the ground rule')
    isFalse(/\{[a-z_]+\}/.test(p), 'no placeholder left over')
  })

  await check('a long report is cut and says where the whole one is', () => {
    const kurz = ig.truncateReport({ id: 'r1', report_md: 'short' }, 20)
    equal(kurz, 'short', 'a short report is passed through')
    const lang = ig.truncateReport({ id: 'r1', report_md: 'x'.repeat(100) }, 20)
    isTrue(lang.startsWith('x'.repeat(20)), 'cut at the cap')
    contains(lang, 'truncated by Freilauf', 'says it was cut')
    contains(lang, 'report.md', 'names the full report')
    equal(ig.truncateReport({ id: 'r1', report_md: null }), '(no report)', 'no report at all')
    equal(ig.truncateReport({ id: 'r1', report_md: 'short', report_detail_md: 'long detail' }, 20), 'long detail',
      'the DETAILED report is the context a resolver wants')
    contains(ig.truncateReport({ id: 'r1', report_md: 'short', report_detail_md: 'x'.repeat(100) }, 20),
      'report-detail.md', 'and the note names the file the whole report actually lives in')
  })

  await check('publicBase: a configured host wins, the port stays live, the env seam still answers', async () => {
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
      equal(publicBase(), 'https://127.0.0.1:8790', 'no host, no env: the local fallback with the code default port')
      // A deliberately fictional port, like every other value in this repo:
      // the operator's real one is a forbidden pattern (pruefe-vor-push.sh),
      // and a test fixture is a committed file like any other.
      process.env.FREILAUF_VPN_PORT = '9443'
      setPublicHost('hub.example.internal')
      equal(publicBase(), 'https://hub.example.internal:9443', 'the configured hostname with the LIVE port')
      setPublicHost('')
      process.env.FREILAUF_PUBLIC_URL = 'https://alt.internal:9999'
      equal(publicBase(), 'https://alt.internal:9999', 'without a configured host the env seam (a full URL) answers')
      setPublicHost('   ')
      equal(publicBase(), 'https://alt.internal:9999', 'whitespace is not a host')
    } finally {
      if (vorherUrl === undefined) delete process.env.FREILAUF_PUBLIC_URL; else process.env.FREILAUF_PUBLIC_URL = vorherUrl
      if (vorherUrlAlt === undefined) delete process.env.CCHUB_PUBLIC_URL; else process.env.CCHUB_PUBLIC_URL = vorherUrlAlt
      if (vorherVpn === undefined) delete process.env.FREILAUF_VPN_PORT; else process.env.FREILAUF_VPN_PORT = vorherVpn
      if (vorherVpnAlt === undefined) delete process.env.CCHUB_VPN_PORT; else process.env.CCHUB_VPN_PORT = vorherVpnAlt
      setPublicHost('')
    }
  })

  await check('the assessment message names the numbers and the way back in', () => {
    const run = { harness: 'claude', id: 'aaaa-bbbb-cccc-dddd', workdir_effective: '/wt/a' }
    const both = ig.assessText(run, { status: 'unmerged_both', commits: 2, dirty: 3 })
    contains(both, '2 commit(s)', 'commits')
    contains(both, '3 uncommitted file(s)', 'dirty files')
    contains(both, 'Resume the session: cd /wt/a && claude --resume aaaa-bbbb-cccc-dddd', 'the resume command')
    // hermes CAN be resumed since 0.21 (state.db knows the session; 'latest'
    // when it does not) — the command names the worktree as the workspace.
    const hermes = ig.assessText({ harness: 'hermes', workdir_effective: '/wt/b', started_at: '2026-09-05 07:00:00' },
      { status: 'nothing', commits: 0, dirty: 0 })
    contains(hermes, 'Resume the session: cd /wt/b && hermes chat --in /wt/b --resume ', 'hermes has a resume command now')
    const fremd = ig.assessText({ harness: 'nosuchagent', workdir_effective: '/wt/c' },
      { status: 'nothing', commits: 0, dirty: 0 })
    contains(fremd, 'cannot be resumed', 'a harness without a resume says so')
    contains(fremd, '/wt/c', 'and names the worktree instead')
  })

  await check('the setup round trip: setup → form body → the same setup', async () => {
    const { setupToFormBody, runSetupFromForm } = await import('../server/run-def.mjs')
    const { saveCodingAgent } = await import('../server/coding-agents.mjs')
    saveCodingAgent({ harness: 'opencode', enabled: 1, providers: ['openrouter'] })
    const setup = { harness: 'opencode', provider: 'openrouter', model: 'x/y', or_provider: 'fireworks', effort: null }
    const problems = []
    const back = await runSetupFromForm(setupToFormBody(setup), problems)
    equal(problems.length, 0, `no problems (${problems.join(' · ')})`)
    equal(back.harness, 'opencode', 'harness')
    equal(back.provider, 'openrouter', 'provider')
    equal(back.model, 'x/y', 'model')
    equal(back.orProvider, 'fireworks', 'serving provider survives where it can be passed through')
  })

  await check('the merge rule is only in the prompt where the hub really merges', async () => {
    const { platformSuffix } = await import('../server/runner.mjs')
    const run = { id: 'r1', harness: 'claude', workdir_effective: '/wt/a', expected_minutes: 30 }
    const out = platformSuffix(run, 'No branch.', {}, { merge_mode: 'off', base_branch: 'main' })
    isFalse(out.includes('Freilauf merges your work'), 'with merge_mode off the prompt is what it always was')
    isFalse(out.includes('fl-report prints'), 'and the finishing block is unchanged too')
    const an = platformSuffix(run, 'No branch.', {}, { merge_mode: 'hub', base_branch: 'trunk' })
    contains(an, 'Freilauf merges your work into trunk itself', 'the base branch is named')
    contains(an, 'Never merge into or push to trunk yourself', 'and so is the ground rule')
    contains(an, 'fl-report prints Freilauf\'s answer', 'the finishing block says the answer is worth reading')
    contains(an, 'fl-report done --file', 'and step 2 is still there — it is not removable')
    contains(an, '--detail', 'the detail report travels along in the same command')
    contains(an, 'report-detail.md', 'and names its path')
    contains(an, 'the SHORT report', 'the two parts are named')
    contains(an, 'DETAILED report', 'and what each of them is for')
    isFalse(/\{base\}/.test(an), 'no placeholder left over')
  })

  await check('the prompt tells the agent how to report follow-up work — once per batch, same command', async () => {
    const { platformSuffix } = await import('../server/runner.mjs')
    const run = { id: 'r1', harness: 'claude', workdir_effective: '/wt/a', expected_minutes: 30 }
    const off = platformSuffix(run, 'No branch.', {}, { merge_mode: 'off', base_branch: 'main' })
    contains(off, 'AFTER YOU HAVE REPORTED DONE', 'the block is there with the integration off too')
    contains(off, 'FOLLOW-UP REPORT', 'and names what the hub makes of it')
    contains(off, 'report ONCE at the end, not once per', 'one report per batch of follow-up work')
    contains(off, 'It is the same command on purpose', 'the same command, and it says why')
    isFalse(off.includes('origin/main merged into your branch once more'), 'no merge clause where nobody merges')
    isFalse(off.includes('integration into main'), 'and no integration among the processes')
    const on = platformSuffix(run, 'No branch.', {}, { merge_mode: 'hub', base_branch: 'trunk' })
    contains(on, 'origin/trunk merged into your branch once more', 'under hub the follow-up merges the base again')
    contains(on, 'integration into trunk', 'and integration is named as what fires again')
    isFalse(/\{(base|followup_merge|followup_processes)\}/.test(on), 'no placeholder left over')
    const kept = platformSuffix({ ...run, keep_on_branch: 1 }, 'Keep.', {}, { merge_mode: 'hub', base_branch: 'trunk' })
    isFalse(kept.includes('merged into your branch once more'), 'a kept run is not told to merge the base')
    // The block comes LAST: it describes what happens after the finishing steps.
    isTrue(on.indexOf('HOW THIS RUN ENDS') < on.indexOf('AFTER YOU HAVE REPORTED DONE'), 'after the finishing block')
  })

  await check('a turn end on a finished run is a follow-up only for cursor, and only with new commits', async () => {
    const { wantsTurnEndFollowUp, followUpText } = await import('../server/reports.mjs')
    const cursor = { turnEndsRun: true }
    const done = { status: 'done', merged_sha: 'aaa', finish_state: null, followup_open: 0 }
    isTrue(wantsTurnEndFollowUp(done, 'bbb', cursor), 'tip moved past the merge: follow-up')
    isFalse(wantsTurnEndFollowUp(done, 'aaa', cursor), 'tip is what was merged: nothing to report')
    isFalse(wantsTurnEndFollowUp(done, null, cursor), 'no tip (worktree gone): nothing')
    isFalse(wantsTurnEndFollowUp({ ...done, merged_sha: null }, 'bbb', cursor), 'never merged (merge mode off): no comparison, no net')
    isFalse(wantsTurnEndFollowUp({ ...done, finish_state: 'checking' }, 'bbb', cursor), 'already in the gate')
    isFalse(wantsTurnEndFollowUp({ ...done, followup_open: 1 }, 'bbb', cursor), 'a follow-up already open')
    isFalse(wantsTurnEndFollowUp({ ...done, status: 'running' }, 'bbb', cursor), 'a running run is finishByTurnEnd\'s business')
    isFalse(wantsTurnEndFollowUp(done, 'bbb', { turnEndsRun: false }), 'claude: a turn end is a note')
    isFalse(wantsTurnEndFollowUp(done, 'bbb', null), 'unknown harness')
    // The message names what it is, on both lines.
    const text = followUpText({ id: 'r1', harness: 'claude', model: 'sonnet', repo_id: -1 }, 'fixed the tests', 'Merged into main: abc1234', { n: 2, minutes: 7 })
    contains(text, 'FOLLOW-UP REPORT #2:', 'the header says which report this is')
    contains(text, 'fixed the tests', 'the follow-up text')
    contains(text, '✅ Follow-up #2 done · claude/sonnet', 'the status line')
    contains(text, 'Follow-up time: 7 min', 'time since the previous report, not the run\'s duration')
    contains(text, 'Merged into main: abc1234', 'and the merge line')
    isFalse(text.includes('Duration:'), 'no run duration — the run started long ago')
  })

  await check('a replayed report is recognised so a lost HTTP answer cannot send it twice', async () => {
    const { isReplayedReport } = await import('../server/reports.mjs')
    const run = { report_md: 'The task is done.', followup_md: null, help_text: null }
    isTrue(isReplayedReport(run, 'done', 'The task is done.'), 'the identical first report is a replay')
    isFalse(isReplayedReport(run, 'done', 'A genuinely new follow-up report.'), 'a new follow-up is not')
    const mitFu = {
      report_md: 'The task is done.\n\n---\n## Follow-up report #1 (x)\n\nAdded the second file.',
      followup_md: 'Added the second file.', help_text: null,
    }
    isTrue(isReplayedReport(mitFu, 'done', 'Added the second file.'), 'the latest follow-up replayed')
    isTrue(isReplayedReport(mitFu, 'done', 'The task is done.'), 'the first report replayed after follow-ups')
    isFalse(isReplayedReport(mitFu, 'done', 'something else entirely'), 'still no false positive')
    isTrue(isReplayedReport({ report_md: '**Failed:** it broke', followup_md: null, help_text: null }, 'failed', 'it broke'),
      'a failed report replayed')
    isTrue(isReplayedReport({ report_md: 'x', followup_md: null, help_text: 'are you there?' }, 'help', 'are you there?'),
      'a help call replayed')
    isFalse(isReplayedReport({ report_md: 'x', followup_md: null, help_text: null }, 'done', ''), 'empty text is never a replay')
    isFalse(isReplayedReport(null, 'done', 'anything'), 'a missing run answers no')
  })

  await check('rearmDispatch lets the flows of a finished run fire again', async () => {
    const { default: db } = await import('../server/db.mjs')
    const { rearmDispatch } = await import('../server/flows/db.mjs')
    const repoId = db.prepare(`INSERT INTO repos (name, path) VALUES ('rearm', '/tmp/rearm') RETURNING id`).get().id
    const id = 'rearm000-0000-4000-8000-000000000001'
    db.prepare(`INSERT INTO runs (id, repo_id, harness, status, prompt, branch_mode, expected_minutes, started_at, ended_at,
      flow_dispatched, merge_dispatched, merge_status) VALUES (?, ?, 'claude', 'done', 'x', 'keiner', 30, datetime('now'), datetime('now'), 1, 1, 'merged')`)
      .run(id, repoId)
    rearmDispatch(id)
    let r = db.prepare('SELECT flow_dispatched, merge_dispatched FROM runs WHERE id=?').get(id)
    equal(r.flow_dispatched, 0, 'run_finished fires again')
    equal(r.merge_dispatched, 1, 'but not run_merged — nothing was merged')
    db.prepare('UPDATE runs SET flow_dispatched=1 WHERE id=?').run(id)
    rearmDispatch(id, { merged: true })
    r = db.prepare('SELECT flow_dispatched, merge_dispatched FROM runs WHERE id=?').get(id)
    equal(r.flow_dispatched, 0, 'both, when the follow-up merged')
    equal(r.merge_dispatched, 0, 'run_merged too')
    db.prepare(`UPDATE runs SET merge_status='nothing', merge_dispatched=1 WHERE id=?`).run(id)
    rearmDispatch(id, { merged: true })
    equal(db.prepare('SELECT merge_dispatched FROM runs WHERE id=?').get(id).merge_dispatched, 1,
      'a run that is not merged cannot fire a merge, whatever the caller says')
    db.prepare('DELETE FROM runs WHERE id=?').run(id)
    db.prepare('DELETE FROM repos WHERE id=?').run(repoId)
  })

  // ------------------------------------------------------------------
  group('tmux cleanup: the memory-freeing agent')

  const { cleanupSettings, cleanupPrompt, cleanupRunInFlight, keepSessionsForRuns, startCleanupRun, maybeAutoCleanup, CLEANUP_PROMPT_DEFAULT } = await import('../server/cleanup.mjs')
  const db2 = (await import('../server/db.mjs')).default
  const uuid = (await import('node:crypto')).randomUUID

  await check('runSetupFields: the styling option wraps, the default stays untouched', () => {
    const plain = rd.runSetupFields({ harness: 'claude' })
    isFalse(plain.startsWith('<fieldset'), 'without the option there is no wrapper — existing callers are unchanged')
    contains(plain, 'name="harness"', 'and the block is the one every form uses')
    const wrapped = rd.runSetupFields({ harness: 'claude' }, { wrapClass: 'cleanup-setup' })
    contains(wrapped, '<fieldset class="cleanup-setup">', 'the styling option wraps in a fieldset')
    contains(wrapped, 'name="harness"', 'with the same fields inside')
  })

  await check('cleanupSettings reads the table and falls back sanely', () => {
    const s = cleanupSettings({})
    equal(s.on, false, 'off by default')
    equal(s.thresholdGb, 5, 'default threshold 5 GB')
    equal(s.targetGb, 2, 'default target 2 GB')
    equal(s.cooldownMin, 60, 'default cooldown 60 min')
    equal(s.harness, '', 'no agent by default')
    const broken = cleanupSettings({ cleanup_threshold_gb: 'quatsch', cleanup_target_gb: '-3' })
    equal(broken.thresholdGb, 5, 'a broken threshold falls back')
    equal(broken.targetGb, 2, 'a negative target falls back')
  })

  await check('the prompt template is the memory successor of the old cleanup prompt', () => {
    contains(CLEANUP_PROMPT_DEFAULT, '{target_gb}', 'target placeholder')
    contains(CLEANUP_PROMPT_DEFAULT, '{keep_line}', 'keep-line placeholder')
    contains(CLEANUP_PROMPT_DEFAULT, '{sessions_url}', 'sessions url placeholder')
    contains(CLEANUP_PROMPT_DEFAULT, '#{window_activity}', 'activity measured by window_activity, not session_activity')
    isFalse(/\{base\}/.test(CLEANUP_PROMPT_DEFAULT), 'no leftover placeholder')
  })

  await check('cleanupPrompt fills the live values into the template', () => {
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
      equal(out, 'ziel=3 keep=Diese Sessions bleiben auf jeden Fall erhalten (auch wenn inaktiv) und dürfen NICHT beendet werden:\nsess-1 url=https://127.0.0.1:8790/sessions th=5', 'all placeholders filled')
    } finally {
      if (vorher[0] !== undefined) process.env.FREILAUF_PUBLIC_URL = vorher[0]; else delete process.env.FREILAUF_PUBLIC_URL
      if (vorher[1] !== undefined) process.env.CCHUB_PUBLIC_URL = vorher[1]; else delete process.env.CCHUB_PUBLIC_URL
      if (vorher[2] !== undefined) process.env.FREILAUF_VPN_PORT = vorher[2]; else delete process.env.FREILAUF_VPN_PORT
      if (vorher[3] !== undefined) process.env.CCHUB_VPN_PORT = vorher[3]; else delete process.env.CCHUB_VPN_PORT
    }
    const noKeep = cleanupPrompt({ targetGb: 1, settings: { prompt: 'keep={keep_line}' } })
    equal(noKeep, 'keep=Ohne Ausnahmen — was inaktiv ist, darf gehen, älteste zuerst.', 'no keep list = the default sentence')
  })

  await check('keepSessionsForRuns resolves run ids to session names', () => {
    const id = uuid()
    db2.prepare(`INSERT INTO repos(id, name, path, base_branch) VALUES(99,'cleanup-test','/tmp/x','main')`).run()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, tmux_session, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, 'fl-test-sess', datetime('now'))`).run(id)
    equal(JSON.stringify(keepSessionsForRuns(`${id} 00000000-0000-0000-0000-000000000000`)),
      JSON.stringify(['fl-test-sess']), 'the known id becomes its session, the unknown one is dropped')
    equal(JSON.stringify(keepSessionsForRuns('')), '[]', 'empty input stays empty')
  })

  await check('cleanupRunInFlight sees a marked run and clears when it ends', () => {
    const id = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'running', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(id)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(id, JSON.stringify({ source: 'auto', targetGb: 2 }))
    isTrue(cleanupRunInFlight(), 'a running run with the marker is in flight')
    db2.prepare(`UPDATE runs SET status='done', ended_at=datetime('now') WHERE id=?`).run(id)
    isFalse(cleanupRunInFlight(), 'a finished one is not')
  })

  await check('a finished cleanup run drops the memory cache — the sidebar never serves the old number', async () => {
    // The sidebar re-fetches its fragment on the run's end event (~2 s later in
    // hub.js); what that render then shows is decided by this cache alone. A
    // cleanup run frees memory while it works, so its end must invalidate — an
    // ordinary run's end must not, the eight-minute clock exists for it.
    se._sessionMemoryReset()
    const a = await se.sessionMemory()
    const ordinaer = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(ordinaer)
    isFalse(se.refreshSessionMemoryAfterRun(ordinaer), 'no cleanup marker = no invalidation')
    equal(await se.sessionMemory(), a, 'the cached reading survives an ordinary run')

    const raeumer = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(raeumer)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(raeumer, JSON.stringify({ source: 'sidebar' }))
    isTrue(se.refreshSessionMemoryAfterRun(raeumer), 'the cleanup marker invalidates')
    const b = await se.sessionMemory()
    isTrue(b !== a && b.measuredAtMs >= a.measuredAtMs, 'and the next reading is a fresh measurement')
    isFalse(se.refreshSessionMemoryAfterRun(null), 'no run id = no invalidation')
    se._sessionMemoryReset()
  })

  await check('startCleanupRun refuses without a configured agent and with a broken target', async () => {
    const no = await startCleanupRun({ settings: cleanupSettings({}) })
    equal(no.ok, false, 'nothing configured')
    isTrue(String(no.error).length > 0, 'with a reason')
    const bad = await startCleanupRun({ targetGb: -1, settings: cleanupSettings({ cleanup_harness: 'claude' }) })
    equal(bad.ok, false, 'negative target refused')
  })

  await check('maybeAutoCleanup stays quiet while the feature is off or no agent is set', async () => {
    const off = await maybeAutoCleanup()
    equal(off, null, 'off by default = nothing')
    const noAgent = await maybeAutoCleanup(0)
    equal(noAgent, null, 'no agent = nothing')
  })

  await check('maybeAutoCleanup gates on threshold, in-flight and cooldown', async () => {
    for (const [k, v] of [['cleanup_on', '1'], ['cleanup_harness', 'claude'], ['cleanup_threshold_gb', '5'],
      ['cleanup_target_gb', '2'], ['cleanup_cooldown_min', '60']]) {
      db2.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)`).run(k, v)
    }

    const unter = await maybeAutoCleanup(Date.now(), 4)
    equal(unter, null, 'memory below the threshold = nothing')

    // A recent cleanup run is still cooling down.
    const letzter = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, ended_at, started_at)
                 VALUES(?, 99, 'done', 'claude', 'p', 'keiner', 30, datetime('now'), datetime('now'))`).run(letzter)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(letzter, JSON.stringify({ source: 'auto' }))
    const kuehl = await maybeAutoCleanup(Date.now(), 10)
    equal(kuehl, null, 'the cooldown after the last run holds')

    // In flight (running) also blocks, whatever the memory says.
    const laufend = uuid()
    db2.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, started_at)
                 VALUES(?, 99, 'running', 'claude', 'p', 'keiner', 30, datetime('now'))`).run(laufend)
    db2.prepare(`INSERT INTO events(run_id, kind, payload) VALUES(?, 'cleanup_run', ?)`).run(laufend, JSON.stringify({ source: 'auto' }))
    equal(await maybeAutoCleanup(Date.now(), 10), null, 'an in-flight cleanup run blocks the gate')
    // Age every cleanup run of the sandbox — the cooldown must have lapsed for the
    // final assertion, including the run the in-flight test left behind.
    db2.prepare(`UPDATE runs SET ended_at=datetime('now', '-120 minutes') WHERE id IN
      (SELECT r.id FROM runs r JOIN events e ON e.run_id=r.id WHERE e.kind='cleanup_run')`).run()
    db2.prepare(`UPDATE runs SET status='done' WHERE id=?`).run(laufend)

    // Nothing blocks and memory is above the threshold → the gate fires (whatever
    // startCleanupRun then makes of the sandbox repo is not this test's question).
    const ausgeloest = await maybeAutoCleanup(Date.now(), 10)
    isFalse(ausgeloest === null, 'above threshold, cooled down, nothing in flight = the gate fires')
  })

  // ------------------------------------------------------------------
  group('The rename: every seam answers to both names')

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

  await check('env(): the new name wins, the old one still answers, neither is undefined', () => {
    mitUmgebung({ FREILAUF_TESTVAR: 'neu', CCHUB_TESTVAR: 'alt' }, () =>
      equal(env('TESTVAR'), 'neu', 'both set'))
    mitUmgebung({ FREILAUF_TESTVAR: undefined, CCHUB_TESTVAR: 'alt' }, () =>
      equal(env('TESTVAR'), 'alt', 'only the old one — the whole point of the fallback'))
    mitUmgebung({ FREILAUF_TESTVAR: undefined, CCHUB_TESTVAR: undefined }, () =>
      equal(env('TESTVAR'), undefined, 'neither'))
  })

  await check('env() takes the full name too, and passes an empty string through', () => {
    mitUmgebung({ FREILAUF_TESTVAR: 'x' }, () =>
      equal(env('FREILAUF_TESTVAR'), 'x', 'the full name is the same question'))
    // `''` has to stay a VALUE. Every caller writes `Number(env(...) ?? default)`
    // or `env(...) ?? default`, and turning an empty string into "not set" here
    // would silently change what an operator wrote in their env file.
    mitUmgebung({ FREILAUF_TESTVAR: '', CCHUB_TESTVAR: 'alt' }, () =>
      equal(env('TESTVAR'), '', 'an empty new value is not "unset"'))
  })

  await check('the two variables that changed NAME, not just prefix', () => {
    // CCHUB_CC_START/CC_REPORT became FREILAUF_START_SCRIPT/REPORT_SCRIPT: the
    // `CC_` in the middle stopped meaning anything when the scripts became fl-*.
    mitUmgebung({ FREILAUF_START_SCRIPT: undefined, CCHUB_CC_START: '/old/cc-start' }, () =>
      equal(env('START_SCRIPT'), '/old/cc-start', 'START_SCRIPT falls back to CCHUB_CC_START'))
    mitUmgebung({ FREILAUF_REPORT_SCRIPT: undefined, CCHUB_CC_REPORT: '/old/cc-report' }, () =>
      equal(env('REPORT_SCRIPT'), '/old/cc-report', 'REPORT_SCRIPT falls back to CCHUB_CC_REPORT'))
    mitUmgebung({ FREILAUF_START_SCRIPT: '/new/fl-start', CCHUB_CC_START: '/old/cc-start' }, () =>
      equal(env('START_SCRIPT'), '/new/fl-start', 'and the new name still wins'))
    equal(envNames('START_SCRIPT').join(','), 'FREILAUF_START_SCRIPT,CCHUB_CC_START', 'both names are nameable')
    equal(envNames('DATA_DIR').join(','), 'FREILAUF_DATA_DIR,CCHUB_DATA_DIR', 'the ordinary pair')
  })

  await check('envIs() is the same question for the "=== 1" switches', () => {
    mitUmgebung({ FREILAUF_PULS_AUS: undefined, CCHUB_PULS_AUS: '1' }, () =>
      isTrue(envIs('PULS_AUS', '1'), 'the old switch still switches'))
    mitUmgebung({ FREILAUF_PULS_AUS: '0', CCHUB_PULS_AUS: '1' }, () =>
      isFalse(envIs('PULS_AUS', '1'), 'and the new one overrules it'))
  })

  await check('pick(): the new path, unless only the old one is there', () => {
    const neu = join(sandkasten, 'pick-neu'), alt = join(sandkasten, 'pick-alt')
    equal(pick(neu, alt), neu, 'neither exists → the new one (a fresh install never creates the old layout)')
    mkdirSync(alt, { recursive: true })
    equal(pick(neu, alt), alt, 'only the old one exists → keep using it')
    mkdirSync(neu, { recursive: true })
    equal(pick(neu, alt), neu, 'both exist → the new one')
  })

  await check('the directories follow that rule, and an explicit variable overrules it', () => {
    const heim = join(sandkasten, 'heim')
    const cfg = join(heim, '.config'), dat = join(heim, '.local', 'share')
    mkdirSync(join(cfg, 'cc-hub'), { recursive: true })
    mkdirSync(join(dat, 'cc-hub'), { recursive: true })
    writeFileSync(join(dat, 'cc-hub', 'cc-hub.db'), '')
    mitUmgebung({ XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: dat, HOME: heim,
                  FREILAUF_DATA_DIR: undefined, CCHUB_DATA_DIR: undefined,
                  FREILAUF_DEPLOY_DIR: undefined, CCHUB_DEPLOY_DIR: undefined,
                  FREILAUF_CERT_DIR: undefined, CCHUB_CERT_DIR: undefined }, () => {
      equal(configDir(), join(cfg, 'cc-hub'), 'an un-migrated config directory keeps being used')
      equal(dataDir(), join(dat, 'cc-hub'), 'so does the data directory')
      // And inside it the file may still carry the old name. Creating freilauf.db
      // next to a populated cc-hub.db would look like a hub that lost every run.
      equal(dbPath(), join(dat, 'cc-hub', 'cc-hub.db'), 'the old database file is not left behind')
      equal(deployDir(), join(heim, 'agents', 'deploy', 'freilauf'), 'nothing there → the new deploy path')
      equal(certDir(), join(heim, '.local', 'certs', 'freilauf'), 'nothing there → the new cert path')
    })
    mitUmgebung({ XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: dat, HOME: heim,
                  FREILAUF_DATA_DIR: '/somewhere/else' }, () => {
      equal(dataDir(), '/somewhere/else', 'an explicit variable is the answer, existing or not')
      equal(dbPath(), join('/somewhere/else', 'freilauf.db'), 'and the database follows it, under the new name')
    })
    mitUmgebung({ XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: dat, HOME: heim,
                  FREILAUF_DATA_DIR: undefined, CCHUB_DATA_DIR: join(dat, 'cc-hub') }, () => {
      equal(dataDir(), join(dat, 'cc-hub'), 'the OLD variable name still points the hub at its data')
    })
  })

  await check('bin/fl-paths.sh answers the same questions in bash', () => {
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
    equal(frage('fl_config_dir'), join(heim, '.config', 'cc-hub'), 'the old config directory')
    equal(frage('fl_data_dir'), join(heim, '.local', 'share', 'freilauf'), 'the new data directory')
    equal(frage('fl_db_file'), join(heim, '.local', 'share', 'freilauf', 'freilauf.db'), 'the database')
    equal(frage('fl_env_file'), join(heim, '.config', 'cc-hub', 'env'), 'the env file goes with the config dir')
    // The same fallback the server side has — written once per language, and
    // this is the check that the two languages agree.
    equal(execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; fl_env FOO bar`],
      { encoding: 'utf8', env: { ...process.env, CCHUB_FOO: 'alt', FREILAUF_FOO: '' } }).trim().replace(/\n$/, ''),
      '', 'an empty new value wins in bash too')
    equal(execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; fl_env FOO bar`],
      { encoding: 'utf8', env: { ...process.env, CCHUB_FOO: 'alt' } }).trim(),
      'alt', 'the old name answers')
    equal(execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; fl_env FOO bar`],
      { encoding: 'utf8', env: { ...process.env } }).trim(),
      'bar', 'and the default when neither is set')
  })

  await check('the tmux prefix: fl- is what is created, cc- is still recognised', () => {
    const lib = new URL('../bin/fl-harness-tags.sh', import.meta.url).pathname
    const frage = (ausdruck) => execFileSync('bash', ['-c', `. ${JSON.stringify(lib)}; ${ausdruck}`],
      { encoding: 'utf8', env: { ...process.env, FREILAUF_HARNESS_TAGS: join(sandkasten, 'no-tags') } }).trim()
    equal(frage('printf %s "$FL_PREFIX"'), 'fl-', 'new sessions are fl-')
    equal(frage('fl_session_re'), '^(fl-|cc-)', 'both prefixes are listed')
    equal(frage('fl_harness_of fl-oc-nacht'), 'opencode', 'a new opencode session')
    equal(frage('fl_harness_of cc-oc-nacht'), 'opencode', 'and an old one, started before the rename')
    equal(frage('fl_harness_of cc-nacht'), 'claude', 'an untagged old session is claude, as it always was')
    equal(frage('fl_harness_bare fl-cu-nacht'), 'nacht', 'the bare name, new prefix')
    equal(frage('fl_harness_bare cc-cu-nacht'), 'nacht', 'the bare name, old prefix')
  })

  // ------------------------------------------------------------------
  group("The agent's attention: working or waiting for input")

  await check('displayStatus: the record stays, the word follows the agent', async () => {
    const { displayStatus, followUpActive } = await import('../server/run-state.mjs')
    const r = (row) => displayStatus(row)
    equal(r({ status: 'running', agent_state: null }), 'running', 'nothing said yet: running')
    equal(r({ status: 'running', agent_state: 'working' }), 'running', 'working: running')
    equal(r({ status: 'running', agent_state: 'waiting' }), 'waiting_input', 'turn over: waiting for input')
    // waiting_help is a QUESTION, and the question outranks the idle it causes.
    equal(r({ status: 'waiting_help', agent_state: 'waiting' }), 'waiting_help', 'a help call stays a help call')
    equal(r({ status: 'done', agent_state: 'waiting' }), 'done', 'a finished run with no commission is finished')
    equal(r({ status: 'done', agent_state: 'working', followup_since: 'x' }), 'running', 'commission + working: running')
    equal(r({ status: 'done', agent_state: 'waiting', followup_since: 'x' }), 'waiting_input', 'commission + waiting: waiting for input')
    equal(r({ status: 'failed', agent_state: null, followup_open: 1 }), 'running', 'a follow-up in the gate: running')
    equal(r({ status: 'scheduled', agent_state: 'waiting' }), 'scheduled', 'a run without a session is what it is')
    isTrue(followUpActive({ status: 'aborted', followup_since: 'x' }), 'followUpActive on followup_since')
    isFalse(followUpActive({ status: 'running', followup_since: 'x' }), 'never on a running run')
  })

  await check('isOperatorInput: a key is the operator, a mouse report is the terminal', async () => {
    // The browser terminal answers "waiting for input" with the first byte a
    // PERSON sends (terminal.mjs → reports.mjs noteOperatorInput). What
    // xterm.js sends on the application's behalf must not count: a click to
    // focus the tab, the wheel over the pane, the window coming to the front.
    const { isOperatorInput } = await import('../server/run-state.mjs')
    isTrue(isOperatorInput('y'), 'one key')
    isTrue(isOperatorInput('\r'), 'Enter')
    isTrue(isOperatorInput('\x03'), 'Ctrl-C')
    isTrue(isOperatorInput('\x1b'), 'a bare Escape')
    isTrue(isOperatorInput('\x1b[A'), 'an arrow key')
    isTrue(isOperatorInput('\x1b[200~fix the test\x1b[201~'), 'a bracketed paste')
    isFalse(isOperatorInput(''), 'nothing')
    isFalse(isOperatorInput(null), 'not a string')
    isFalse(isOperatorInput('\x1b[<0;12;5M'), 'an SGR mouse press')
    isFalse(isOperatorInput('\x1b[<0;12;5m'), 'an SGR mouse release')
    isFalse(isOperatorInput('\x1b[<64;12;5M\x1b[<65;12;5M'), 'two wheel reports')
    isFalse(isOperatorInput('\x1b[M !!'), 'an X10 mouse report')
    isFalse(isOperatorInput('\x1b[I'), 'focus in')
    isFalse(isOperatorInput('\x1b[O'), 'focus out')
    isTrue(isOperatorInput('\x1b[<0;12;5Mq'), 'a key after a click still counts')
  })

  await check('anomaliesSettled: a run that came through has answered them', async () => {
    // The traffic light in pages.mjs asks this before it lets an in-flight
    // anomaly colour a row. The rule is here, next to displayStatus, because it
    // is the same kind of question: what does this run's state MEAN now.
    const { anomaliesSettled, IN_FLIGHT_ANOMALIES } = await import('../server/run-state.mjs')
    isTrue(anomaliesSettled({ status: 'done' }), 'done: settled')
    isFalse(anomaliesSettled({ status: 'running' }), 'a run in flight is not')
    isFalse(anomaliesSettled({ status: 'waiting_help' }), 'nor one asking a question')
    // failed/aborted keep theirs — there the anomaly is the explanation of why
    // the run did not come through, which is exactly what one wants to read.
    isFalse(anomaliesSettled({ status: 'failed' }), 'failed keeps its explanation')
    isFalse(anomaliesSettled({ status: 'aborted' }), 'aborted too')
    // A finished run with an open follow-up commission is working right now.
    isFalse(anomaliesSettled({ status: 'done', followup_since: 'x' }), 'not while a follow-up is open')
    isFalse(anomaliesSettled({ status: 'done', followup_open: 1 }), 'nor while one is in the gate')
    isFalse(anomaliesSettled(null), 'no run, no verdict')
    // The list is the statements a run's own end answers. `unpushed` is NOT one
    // of them: it is written AFTER the run ended and stays true afterwards —
    // work that lives only on this machine is still work that lives only on
    // this machine. Neither are the follow-up overruns, which describe a
    // commission that is open right now.
    for (const k of ['anomaly:unpushed', 'anomaly:followup_overrun', 'anomaly:followup_soft_overrun']) {
      isFalse(IN_FLIGHT_ANOMALIES.includes(k), `${k} is not settled by the run ending`)
    }
    isTrue(IN_FLIGHT_ANOMALIES.every(k => k.startsWith('anomaly:')), 'and every entry is an anomaly kind')
  })

  await check('displayStatusSql selects exactly the rows displayStatus would', async () => {
    // The sidebar counts and the overview filter are SQL, the row is JavaScript:
    // one rule in two languages, held together here over every combination.
    const { displayStatus, displayStatusSql, WORK_STATUSES } = await import('../server/run-state.mjs')
    const { DatabaseSync } = await import('node:sqlite')
    const d = new DatabaseSync(':memory:')
    d.exec(`CREATE TABLE runs(id INTEGER PRIMARY KEY, status TEXT, agent_state TEXT, followup_since TEXT, followup_open INTEGER DEFAULT 0)`)
    const ins = d.prepare('INSERT INTO runs(status, agent_state, followup_since) VALUES(?,?,?)')
    const rows = []
    for (const status of ['scheduled', 'deferred', 'running', 'waiting_help', 'done', 'failed', 'aborted']) {
      for (const agent_state of [null, 'working', 'waiting']) {
        for (const followup_since of [null, '2026-09-05 10:00:00']) {
          ins.run(status, agent_state, followup_since)
          rows.push({ status, agent_state, followup_since, followup_open: 0 })
        }
      }
    }
    for (const s of WORK_STATUSES) {
      const viaSql = d.prepare(`SELECT id FROM runs WHERE ${displayStatusSql(s)} ORDER BY id`).all().map(r => r.id)
      const viaJs = rows.map((r, i) => displayStatus(r) === s ? i + 1 : null).filter(Boolean)
      equal(viaSql.join(','), viaJs.join(','), `${s}: SQL and JavaScript agree`)
      isTrue(viaJs.length > 0, `${s} selects something at all`)
    }
    d.close()
  })

  await check('after a report, only a human prompt opens a follow-up — a tool call waits out the grace', async () => {
    // `fl-report done` is a tool call INSIDE the turn; the two or three calls
    // an agent makes after it arrive as `_working` on a finished run. Read as
    // a commission they turned every finished run into "waiting for input".
    const { commissionOnWorking, attentionGraceMs } = await import('../server/reports.mjs')
    const grace = 120_000
    isTrue(commissionOnWorking('prompt', 5_000, grace), 'a prompt right after the report is a commission')
    isTrue(commissionOnWorking('prompt', -Infinity, grace), 'a prompt with no known report is one too')
    isFalse(commissionOnWorking('tool', 5_000, grace), 'a tool call 5 s after the report is the turn finishing')
    isFalse(commissionOnWorking('busy', 119_000, grace), "opencode's busy inside the window too")
    isTrue(commissionOnWorking('tool', 121_000, grace), 'past the window a tool call is work somebody asked for')
    isTrue(commissionOnWorking('hook', -Infinity, grace), 'and with no report known at all, nothing is held back')
    isTrue(commissionOnWorking('tool', NaN, grace), 'NaN is not "just now" either')
    equal(attentionGraceMs(), 120_000, 'two minutes by default')
    process.env.FREILAUF_ATTENTION_GRACE_MS = '5000'
    equal(attentionGraceMs(), 5_000, 'configurable')
    process.env.FREILAUF_ATTENTION_GRACE_MS = 'junk'
    equal(attentionGraceMs(), 120_000, 'junk means the default, never zero')
    delete process.env.FREILAUF_ATTENTION_GRACE_MS
  })

  await check('every built-in coding agent declares how its attention reaches the hub', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    for (const id of ['claude', 'opencode', 'hermes', 'cursor']) {
      isTrue(HP[id].attention && typeof HP[id].attention.source === 'string', `${id} declares attention.source`)
    }
  })

  await check("claude: the hooks say working, waiting, and never a subagent's end", async () => {
    const { claudeSettingsJson } = await import('../server/runner.mjs')
    const j = JSON.parse(claudeSettingsJson())
    const cmd = (ev) => j.hooks[ev][0].hooks[0].command
    equal(cmd('UserPromptSubmit'), 'fl-report _working prompt', 'a prompt starts a turn — and says it was a prompt')
    contains(cmd('PreToolUse'), 'fl-report _working tool', 'a tool call is work, and says it was a tool call')
    contains(cmd('PreToolUse'), 'setsid -f', 'and it must not hold the tool call up')
    equal(cmd('Stop'), 'fl-report _turn_end', 'the turn end is the waiting')
    equal(cmd('Notification'), 'fl-report _waiting', 'the idle prompt is the net under it')
    equal(j.hooks.Notification[0].matcher, 'idle_prompt|permission_prompt', 'and only the notifications that mean waiting')
    isFalse('SubagentStop' in j.hooks, 'a subagent finishing is not the run waiting')
    for (const ev of Object.keys(j.hooks)) {
      isTrue(Array.isArray(j.hooks[ev]) && Array.isArray(j.hooks[ev][0].hooks), `${ev} keeps claude's nested shape`)
    }
  })

  await check('cursor: beforeSubmitPrompt reports work, stop reports the wait', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    const j = JSON.parse(HP.cursor.hookFiles({ flReport: '/bin/fl-report' })[0].content)
    equal(j.hooks.beforeSubmitPrompt[0].command, '/bin/fl-report _working prompt', 'a typed follow-up starts a turn, as a prompt')
    equal(j.hooks.stop[0].command, '/bin/fl-report _turn_end', 'and the stop hook stays the turn end')
  })

  await check('hermes: the launch line consents to the hooks, the wrapper maps the events', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    isTrue(HP.hermes.launch.args.includes('--accept-hooks'), 'the spec passes --accept-hooks')
    const start = readFileSync(new URL('../bin/fl-start', import.meta.url), 'utf8')
    contains(start, 'chat -q "$FL_PROMPT" --yolo --accept-hooks', 'and so does the built-in case')
    // The wrapper: silent outside a run, a translation inside one. A fake
    // fl-report on the PATH records what it was called with.
    const dir = join(sandkasten, 'hermes-hook'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fl-report'), '#!/usr/bin/env bash\ncat >/dev/null; echo "$1" >> "$HOOK_LOG"\n')
    chmodSync(join(dir, 'fl-report'), 0o755)
    const wrapper = new URL('../bin/fl-hermes-hook', import.meta.url).pathname
    const log = join(dir, 'log')
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOOK_LOG: log }
    delete env.FL_RUN_ID; delete env.CC_RUN_ID
    const run = (ev, extra = {}) => execFileSync(wrapper, [ev], { input: '{"hook_event_name":"x"}', env: { ...env, ...extra }, encoding: 'utf8' })
    equal(run('pre_llm_call'), '', 'outside a run: nothing is said')
    const { existsSync: ex } = await import('node:fs')
    isTrue(!ex(log), 'and fl-report is not called')
    run('pre_llm_call', { FL_RUN_ID: 'r1' })
    run('on_session_end', { FL_RUN_ID: 'r1' })
    run('post_llm_call', { FL_RUN_ID: 'r1' })
    equal(readFileSync(log, 'utf8').trim().split('\n').join(','), '_working,_turn_end', 'pre_llm_call → _working, on_session_end → _turn_end, the rest ignored')
  })

  await check('opencode: the installed plugin reads the ROOT session, not the subagents', () => {
    const setup = readFileSync(new URL('../setup/02-install-scripts.sh', import.meta.url), 'utf8')
    const plugin = setup.slice(setup.indexOf("cat > \"$HOME/.config/opencode/plugins/freilauf.js\""), setup.indexOf('# ---------------------------------------------------------------- hermes hooks'))
    contains(plugin, "event?.type === 'session.status'", 'session.status is the source')
    contains(plugin, 'client.session.get', 'the parent is asked of opencode')
    contains(plugin, "parentID ?? null", 'and only a session without a parent counts')
    contains(plugin, "'_working' : '_waiting'", 'busy → working, idle → waiting')
    isFalse(plugin.includes("melden('_idle')"), 'the old per-session idle report is gone')
    contains(plugin, "'session.error'", 'the error path stays')
    contains(setup, 'fl-hermes-hook pre_llm_call', 'and hermes gets its hooks block')
  })

  await check('fl-report accepts the two attention kinds', () => {
    const report = readFileSync(new URL('../bin/fl-report', import.meta.url), 'utf8')
    contains(report, '_working|_waiting) ;;', 'in the kind list')
  })

  await check('the status word exists in every language', async () => {
    for (const lang of ['en', 'de', 'zh']) {
      const cat = JSON.parse(readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), 'utf8'))
      isTrue(!!cat['status.waiting_input'], `${lang}: status.waiting_input`)
      isTrue(!!cat['run.agent_waiting'], `${lang}: run.agent_waiting`)
    }
  })

  group('The test sandbox takes back what a killed suite left standing')

  await check('a sandbox whose owner is dead is swept, a live one never is', async () => {
    const { sandkastenVerwaist } = await import('./sandkasten.mjs')
    const jetzt = Date.parse('2026-09-05T12:00:00Z')
    const lebt = (pid) => pid === 4711
    // The one answer that must never be wrong: a running suite keeps its sessions.
    isFalse(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-running', pid: 4711, mtimeMs: jetzt }, { nowMs: jetzt, lebt }),
      'a suite that is still running')
    isTrue(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-dead', pid: 4712, mtimeMs: jetzt }, { nowMs: jetzt, lebt }),
      'its owner is gone, so the sessions are garbage')
    // Freshness does not save a dead owner: SIGKILL is instant, and the directory's
    // mtime is then seconds old while every session in it is already orphaned.
    isTrue(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-dead', pid: 4712, mtimeMs: jetzt - 1000 }, { nowMs: jetzt, lebt }),
      'a freshly killed suite too')
    isFalse(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-self', pid: 4712, mtimeMs: jetzt }, { nowMs: jetzt, eigenerPfad: '/tmp/Freilauf-e2e-self', lebt }),
      'and never our own directory')
  })

  await check('a sandbox kept with --keep is never swept', async () => {
    const { sandkastenVerwaist, VERWAIST_ALTER_MS } = await import('./sandkasten.mjs')
    const jetzt = Date.parse('2026-09-05T12:00:00Z')
    // Its owner IS dead — the suite finished — and it is old on purpose. Without
    // the marker both rules above would delete the state somebody kept to read.
    isFalse(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-keep', pid: 4712, mtimeMs: jetzt, behalten: true },
      { nowMs: jetzt, lebt: () => false }), 'dead owner, but kept on purpose')
    isFalse(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-keep', pid: null, mtimeMs: jetzt - VERWAIST_ALTER_MS * 10, behalten: true },
      { nowMs: jetzt }), 'old, but kept on purpose')
  })

  await check('without an owner marker only age decides', async () => {
    const { sandkastenVerwaist, VERWAIST_ALTER_MS } = await import('./sandkasten.mjs')
    const jetzt = Date.parse('2026-09-05T12:00:00Z')
    // A sandbox from before the marker existed: a live suite touches its directory
    // constantly, so recent mtime is the only thing standing between it and a sweep.
    isFalse(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-nomarker', pid: null, mtimeMs: jetzt - 60_000 }, { nowMs: jetzt }),
      'busy a minute ago — could be running')
    isTrue(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-nomarker', pid: null, mtimeMs: jetzt - VERWAIST_ALTER_MS - 1 }, { nowMs: jetzt }),
      'untouched for hours — over')
    // A directory we could not stat says nothing, and "says nothing" must not
    // become "delete it" — the Number('') family of traps.
    isFalse(sandkastenVerwaist({ pfad: '/tmp/Freilauf-e2e-nomarker', pid: null, mtimeMs: NaN }, { nowMs: jetzt }),
      'no readable age is no evidence')
  })

  await check('both suites answer SIGHUP, which is what a closed tmux session sends', async () => {
    for (const datei of ['e2e.mjs', 'browser.mjs']) {
      const src = readFileSync(new URL(`./${datei}`, import.meta.url), 'utf8')
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        isTrue(src.includes(`process.on('${sig}'`), `${datei}: ${sig}`)
      }
    }
  })

  await check('a session name from before the rename still opens its terminal', async () => {
    // runs.tmux_session stores the NAME, so an old run keeps pointing at cc-…;
    // the terminal route validates that name against a pattern before attaching.
    const { SESSION_RE } = await import('../server/terminal.mjs')
    isTrue(SESSION_RE.test('fl-nacht-a1b2'), 'a new session')
    isTrue(SESSION_RE.test('cc-oc-nacht-a1b2'), 'an old one')
    isFalse(SESSION_RE.test('xx-nacht'), 'and nothing else')
    isFalse(SESSION_RE.test('fl-nacht; rm -rf /'), 'still nothing shell-shaped')
  })

} finally {
  rmSync(sandkasten, { recursive: true, force: true })
}

process.exit(summary('Unit tests', start) || (counter.failures.length ? 1 : 0))
