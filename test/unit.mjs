#!/usr/bin/env node
// Freilauf — unit tests for the functions with real logic and edge cases.
//
// Deliberately NOT tested: SQL strings, HTML snippets, CSS classes, column orders,
// exact message texts, private helper functions. Such tests would only cement the
// current implementation instead of securing behavior. What is tested is what
// computes or decides — schedules, cron, form parsing, quota gate, text processing.
//
// Usage:  node test/unit.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, utimesSync, symlinkSync, realpathSync, existsSync } from 'node:fs'
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
// The hub's own agent skills resolve their target directories against $HOME
// (~/.claude/skills and friends). Without this fence a suite run would install
// into — and later DELETE from — the operator's real skill directories.
process.env.FREILAUF_SKILLS_HOME = join(sandkasten, 'skillhome')
process.env.FREILAUF_SKILLS_STATE = join(sandkasten, 'skills-installed.json')
// The same fence for the run directories. `prepareSandbox()` creates
// `<RUNS_DIR>/<run id>/` before it can fail, and RUNS_DIR is a module-level
// constant of util.mjs read at import time — so without this line the sandbox
// checks below would write into the operator's real ~/agents/runs. Same family
// as FREILAUF_SKILLS_HOME above: a suite that reaches outside its own directory
// is not merely unreproducible.
process.env.FREILAUF_RUNS_DIR = join(sandkasten, 'runs')
// The sandbox's runtime seam names the binary the hub calls for containers. It
// is deliberately UNSET here: this suite tests the pure argv builders and the
// "no runtime on this machine" answers, and a shell that exported the seam
// while debugging the e2e shim would make those checks probe a real binary —
// `gleich(bin, 'docker')` then fails for a reason that has nothing to do with
// the code under test. The two checks that want a seam set it themselves and
// restore it; a fence at the top is what protects the groups before them.
delete process.env.FREILAUF_SANDBOX_RUNTIME_BIN

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

  gruppe('Schedules: catching up what a downtime swallowed (lastMissedSlot)')

  await pruefe('a cron slot inside the gap is found, the newest one when there are several', () => {
    const nightly = { schedule_kind: 'cron', schedule: '0 3 * * *' }
    const from = d('2026-08-24T22:00:00').getTime()
    const to = d('2026-08-25T06:15:30').getTime()
    gleich(lastMissedSlot(nightly, from, to)?.toISOString(), d('2026-08-25T03:00:00').toISOString(), 'the 03:00 slot')
    const hourly = { schedule_kind: 'cron', schedule: '30 * * * *' }
    gleich(lastMissedSlot(hourly, from, to)?.toISOString(), d('2026-08-25T05:30:00').toISOString(), 'the NEWEST of eight missed slots, not the first')
  })
  await pruefe('the minute of the last tick and the current minute are both excluded', () => {
    const hourly = { schedule_kind: 'cron', schedule: '30 * * * *' }
    gleich(lastMissedSlot(hourly, d('2026-08-25T05:30:10').getTime(), d('2026-08-25T05:45:00').getTime()), null,
      'the last tick ran in the 05:30 minute and handled it')
    gleich(lastMissedSlot(hourly, d('2026-08-25T05:00:00').getTime(), d('2026-08-25T05:30:20').getTime()), null,
      'the current minute is the running tick\'s own')
    gleich(lastMissedSlot(hourly, d('2026-08-25T05:00:00').getTime(), d('2026-08-25T05:31:00').getTime())?.toISOString(),
      d('2026-08-25T05:30:00').toISOString(), 'one minute later it counts as missed')
  })
  await pruefe('weekly schedules are caught up too; one-off and manual ones never', () => {
    gleich(lastMissedSlot(woe, d('2026-08-24T07:00:00').getTime(), d('2026-08-24T08:00:00').getTime())?.toISOString(),
      d('2026-08-24T07:30:00').toISOString(), 'Monday 07:30')
    gleich(lastMissedSlot(woe, d('2026-08-25T07:00:00').getTime(), d('2026-08-25T08:00:00').getTime()), null, 'not on a Tuesday')
    gleich(lastMissedSlot({ schedule_kind: 'einmalig', run_at: '2026-08-24T07:30:00' }, 0, Date.now()), null,
      'a one-off is due from its moment on anyway')
    gleich(lastMissedSlot({ schedule_kind: 'manuell' }, 0, Date.now()), null, 'manual has no moment')
    gleich(lastMissedSlot(woe, NaN, Date.now()), null, 'no last tick known → nothing to catch up')
    gleich(lastMissedSlot(woe, Date.now(), Date.now() - 1000), null, 'an inverted window is empty')
  })
  await pruefe('the catch-up window: default 6 h, empty string is "not set", 0 switches it off', () => {
    gleich(catchupHours({}), 6, 'default')
    gleich(catchupHours({ schedule_catchup_hours: '' }), 6, 'the settings page writes "" for an untouched field')
    gleich(catchupHours({ schedule_catchup_hours: '0' }), 0, 'an explicit 0 is honoured')
    gleich(catchupHours({ schedule_catchup_hours: '24' }), 24, 'a number')
    gleich(catchupHours({ schedule_catchup_hours: 'abc' }), 6, 'junk falls back')
  })

  gruppe('Schedules: cadence')

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
  await pruefe('several times on the same days: every one of them is due', () => {
    const zwei = { ...woe, schedule_time: '08:00,11:00' }
    wahr(scheduleDue(zwei, d('2026-08-24T08:00:00')), 'Monday 08:00')
    wahr(scheduleDue(zwei, d('2026-08-24T11:00:00')), 'Monday 11:00')
    falsch(scheduleDue(zwei, d('2026-08-24T09:00:00')), 'in between')
    falsch(scheduleDue(zwei, d('2026-08-25T08:00:00')), 'Tuesday is not chosen')
  })
  await pruefe('times per weekday: each day only at its own times', () => {
    const proTag = {
      schedule_kind: 'woechentlich', schedule_weeks: 1,
      schedule_slots: '{"2":["08:00","11:00"],"3":["14:17"]}',
    }
    wahr(scheduleDue(proTag, d('2026-08-25T08:00:00')), 'Tuesday 08:00')
    wahr(scheduleDue(proTag, d('2026-08-25T11:00:00')), 'Tuesday 11:00')
    wahr(scheduleDue(proTag, d('2026-08-26T14:17:00')), 'Wednesday 14:17')
    falsch(scheduleDue(proTag, d('2026-08-26T08:00:00')), "Wednesday does not inherit Tuesday's times")
    falsch(scheduleDue(proTag, d('2026-08-25T14:17:00')), "Tuesday does not inherit Wednesday's")
    falsch(scheduleDue(proTag, d('2026-08-24T08:00:00')), 'Monday has no times at all')
  })
  await pruefe('the per-day list outranks the flat columns, and the cadence still applies', () => {
    const gemischt = { ...woe, schedule_slots: '{"2":["08:00"]}' }
    wahr(scheduleDue(gemischt, d('2026-08-25T08:00:00')), 'the slots decide')
    falsch(scheduleDue(gemischt, d('2026-08-24T07:30:00')), 'the old columns do not run alongside')
    const alle14 = { ...gemischt, schedule_weeks: 2, schedule_anchor: '2026-08-24' }
    wahr(scheduleDue(alle14, d('2026-08-25T08:00:00')), 'anchor week')
    falsch(scheduleDue(alle14, d('2026-09-01T08:00:00')), 'following week')
  })
  await pruefe('junk in the times is ignored, never guessed at', () => {
    falsch(scheduleDue({ ...woe, schedule_time: 'irgendwann' }, d('2026-08-24T07:30:00')), 'unreadable time')
    // Unreadable slots are no statement at all, so the flat columns are still
    // the schedule — an agent must not silently stop running over a damaged
    // JSON string, and a form-saved per-day agent has no times in them anyway.
    wahr(scheduleDue({ ...woe, schedule_slots: 'kein json' }, d('2026-08-24T07:30:00')),
      'unreadable slots leave the columns in charge')
    falsch(scheduleDue({ schedule_kind: 'woechentlich', schedule_days: '1,3,5', schedule_slots: 'kein json' },
      d('2026-08-24T07:30:00')), 'and with no time in them, nothing runs')
    falsch(scheduleDue({ schedule_kind: 'woechentlich', schedule_slots: '{"9":["08:00"]}' }, d('2026-08-25T08:00:00')),
      'weekday 9 does not exist')
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
  await pruefe('several times are all named, on one line', () => {
    const zwei = { ...woe, schedule_time: '08:00,11:00' }
    enthaelt(scheduleText(zwei), '08:00, 11:00', 'both times')
    enthaelt(scheduleText(zwei), 'Mon, Wed, Fri', 'days unchanged')
    gleich(scheduleText({ ...woe, schedule_days: '0,1,2,3,4,5,6', schedule_time: '06:00,18:00' }),
      'daily at 06:00, 18:00', 'all seven days every week stays "daily"')
  })
  await pruefe('different times per day are listed per day', () => {
    const proTag = { schedule_kind: 'woechentlich', schedule_weeks: 1,
      schedule_slots: '{"3":["14:17"],"2":["08:00","11:00"]}' }
    const txt = scheduleText(proTag)
    enthaelt(txt, 'Tue 08:00, 11:00', 'Tuesday with both its times')
    enthaelt(txt, 'Wed 14:17', 'Wednesday with its own')
    wahr(txt.indexOf('Tue') < txt.indexOf('Wed'), 'the week is read in its own order, not in the JSON key order')
  })

  // ------------------------------------------------------------------
  gruppe('Schedules: the two storages become one shape (weeklySlots)')

  await pruefe('the flat columns give every chosen day the same times', () => {
    const s = weeklySlots({ schedule_days: '5,1', schedule_time: '11:00,08:00' })
    gleich(s.length, 2, 'two days')
    gleich(s[0].day, 1, 'Monday first — the order a week is read in')
    gleich(s[0].times.join(','), '08:00,11:00', 'times sorted')
    gleich(s[1].times.join(','), '08:00,11:00', 'the same on the second day')
    wahr(slotsUniform(s), 'and that is the uniform case')
  })
  await pruefe('schedule_slots gives every day its own', () => {
    const s = weeklySlots({ schedule_days: '1', schedule_time: '07:30', schedule_slots: '{"2":["08:00"],"3":["14:17"]}' })
    gleich(s.map(x => x.day).join(','), '2,3', 'the slots decide which days')
    falsch(slotsUniform(s), 'different times are not uniform')
  })
  await pruefe('nothing usable is an empty schedule, not a crash', () => {
    gleich(weeklySlots({}).length, 0, 'empty agent')
    gleich(weeklySlots({ schedule_days: '1' }).length, 0, 'days without a time')
    gleich(weeklySlots({ schedule_time: '08:00' }).length, 0, 'time without a day')
    gleich(weeklySlots({ schedule_slots: '{}' }).length, 0, 'empty slots')
    falsch(slotsUniform([]), 'and an empty schedule is not "uniform"')
  })
  await pruefe('splitTimes keeps times, drops the rest, sorts and deduplicates', () => {
    gleich(splitTimes('11:00, 08:00 ,11:00').join(','), '08:00,11:00', 'string')
    gleich(splitTimes(['08:00', 'bald', '', '25:00', '08:61']).join(','), '08:00', 'list')
    gleich(splitTimes(null).length, 0, 'nothing')
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
  await pruefe('stripGitProgress removes git checkout and transfer progress, keeps the diagnosis', () => {
    const err = [
      'Preparing worktree (detached HEAD e4c5cf5f)',
      'Updating files:   5% (908/16971)\rUpdating files:  78% (13238/16971)',
      'Receiving objects:  50% (10/20), 1.20 MiB | 2.00 MiB/s',
      'fatal: cannot create directory "x": No space left on device',
    ].join('\n')
    gleich(stripGitProgress(err), 'Preparing worktree (detached HEAD e4c5cf5f)\nfatal: cannot create directory "x": No space left on device', 'progress gone, cause kept')
  })
  await pruefe('stripGitProgress collapses the blank lines progress leaves behind', () => {
    gleich(stripGitProgress('fatal: something broke\n\nUpdating files: 100% (2/2), done.\n\n'), 'fatal: something broke', 'no trailing blank lines')
  })
  await pruefe('stripGitProgress keeps non-progress text byte for byte', () => {
    gleich(stripGitProgress("fatal: 'main' is already used by worktree at '/x'"), "fatal: 'main' is already used by worktree at '/x'", 'ordinary error')
    gleich(stripGitProgress(null), '', 'null is an empty string')
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
  await pruefe('a file dated in the future does not beat a live answer', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 3 }, seven_day: { used_percentage: 77 },
    }), 12)
    cu._claudeLimitsSet({ five: 5, resets_at: null, seven_general: 78, seven_resets_at: null, weekly_scoped: [] })
    // A `now` an hour before the file was written — the file's mtime is then
    // newer than "now" by an hour instead of by a fraction of a millisecond.
    const q = claudeQuota(Date.now() - 3600_000)
    gleich(q.five, 5, 'the account still decides the 5-hour window')
    gleich(q.seven_general, 78, 'and the week')
    wahr(q.live, 'and the answer says so')
    gleich(q.five_at, null, 'a live window carries no "as of" stamp')
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

  // Measured 2026-09-01: the account rate-limits this endpoint (429), and the
  // hub's answer to a failure was to keep asking every watcher pass. A failed
  // answer must start a backoff, or a polite poller becomes a hammer exactly
  // when the vendor asks for a pause.
  await pruefe('a 429 backs off — the endpoint is not asked again right away', async () => {
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
      gleich(await cu.refreshClaudeLimits(), null, 'a 429 is no answer')
      gleich(await cu.refreshClaudeLimits(), null, 'the stale-but-usable rule keeps the answer null')
      gleich(aufrufe, 1, 'one 429, then the backoff keeps the endpoint alone')
      gleich(cu.claudeLimits(), null, 'a failure is not cached as one')
    } finally {
      global.fetch = echt
      if (before === undefined) delete process.env.FREILAUF_CLAUDE_CREDENTIALS
      else process.env.FREILAUF_CLAUDE_CREDENTIALS = before
      cu._claudeLimitsReset()
    }
  })

  await pruefe('Retry-After is honoured and a success clears the backoff', async () => {
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
      gleich(aufrufe, 1, 'the vendor said wait 600 s, and that outranks the own backoff')
      antwort = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => realResponse })
      const live = await cu.refreshClaudeLimits({ force: true })
      gleich(live?.five, 5, 'a forced refresh goes through the backoff and succeeds')
      gleich(aufrufe, 2)
      cu._claudeLimitsSet(cu._parseLimits(realResponse), Date.now() - 3600_000)   // cache aged
      await cu.refreshClaudeLimits()
      gleich(aufrufe, 3, 'and the success cleared the backoff: the next expired cache asks again')
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
  await pruefe('a rate-limited stretch keeps the last live answer standing', async () => {
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
    gleich(q.five, 5, 'the 5-hour bar stands instead of dropping to the hour-old file')
    gleich(q.seven_general, 78, 'the week too')
    wahr(q.five_at > 0, 'and says when the 5-hour value was read')
    wahr(q.seven_general_at > 0, 'and when the week was read')
    falsch(q.live, 'while honestly no longer claiming to be live')
    cu._claudeLimitsReset()
  })

  await pruefe('a file rewritten after the last live answer wins — the status line keeps it moving', async () => {
    const pfad = join(sandkasten, 'quota22.json')
    writeFileSync(pfad, JSON.stringify({ five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 11 } }))
    process.env.FREILAUF_QUOTA_JSON = pfad
    const { claudeQuota } = await import('../server/quota.mjs?fixture=22')
    cu._claudeLimitsReset()
    cu._claudeLimitsSet({ five: 5, resets_at: null, seven_general: 78, seven_resets_at: null, weekly_scoped: [] },
      Date.now() - 300_000)
    const q = claudeQuota()
    gleich(q.five, 42, 'a status line wrote this window after the account last answered')
    gleich(q.seven_general, 11, 'in both windows')
    wahr(q.five_at > 0, 'a file-sourced value carries its as-of time too')
    cu._claudeLimitsReset()
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
  gruppe('The directories outside the worktree a run was pointed at')

  const { runExternalDirs } = await import('../server/runner.mjs')

  await pruefe('opencode is told about them as external_directory permissions', () => {
    const { args } = harnessModelArgs({ harness: 'opencode', model: 'a/b', provider: 'openrouter' },
      { externalDirs: ['/runs/xy', '/opt/fl/zusaetze'] })
    const erlaubt = cfgAus(args)?.permission?.external_directory
    gleich(erlaubt?.['/runs/xy/*'], 'allow', 'the run directory, as a glob')
    gleich(erlaubt?.['/opt/fl/zusaetze/*'], 'allow', 'the extra-skills directory')
    // NOT a blanket allow: what the hub laid out is reachable, the rest still asks.
    gleich(erlaubt?.['*'], undefined, 'no blanket permission')
  })

  await pruefe('a run that carries no model still gets the permission block', () => {
    // The one that used to fall off: modelArgs returned early for these two,
    // and a run that cannot write ~/agents/runs/<id>/report.md cannot finish.
    for (const run of [{ harness: 'opencode' }, { harness: 'opencode', model: 'hand/typed' }]) {
      const { args } = harnessModelArgs(run, { externalDirs: ['/runs/xy'] })
      const erlaubt = cfgAus(args)?.permission?.external_directory
      gleich(erlaubt?.['/runs/xy/*'], 'allow', `model=${run.model ?? 'none'}`)
    }
    gleich(cfgAus(harnessModelArgs({ harness: 'opencode', model: 'a/b', provider: 'openrouter' }).args),
      null, 'without the list nothing is written — an old caller changes nothing')
  })

  await pruefe('runExternalDirs names the run directory, the skills and every LINKED extra', () => {
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
    wahr(dirs.includes('/runs/xy'), 'the run directory')
    wahr(dirs.some(d => d.endsWith('/.venv')), 'a linked directory, resolved')
    wahr(dirs.includes(realpathSync(repoPfad)), 'a linked FILE admits its directory, not the file')
    wahr(!dirs.some(d => d.includes('node_modules')), 'a copied extra needs nothing — it IS in the worktree')
    wahr(!dirs.some(d => d.includes('weg')), 'an extra that is not there was not applied either')
    gleich(dirs.length, new Set(dirs).size, 'deduplicated')
    wahr(dirs.every(d => d.startsWith('/')), 'absolute only')
    rmSync(wurzel, { recursive: true, force: true })
  })

  // ------------------------------------------------------------------
  gruppe('A prompt too long to hand over as an argument (offloadPrompt)')

  const { offloadPrompt, TASK_FILE, TASK_DIR, harnessOwnedPaths: eigenePfade } =
    await import('../server/runner.mjs')
  const langeAufgabe = 'AUFGABE '.repeat(700)   // ~5.6 KB, past opencode's 4000

  await pruefe('a short prompt is passed through completely unchanged', () => {
    const r = offloadPrompt('opencode', '/nowhere', 'do X', 'PLATFORM')
    gleich(r.taskFile, null, 'nothing written')
    gleich(r.prompt, 'do X\n\nPLATFORM', 'task and platform, exactly as before')
  })

  await pruefe('a long one leaves the task in the worktree and points at it', () => {
    const wt = mkdtempSync(join(tmpdir(), 'fl-offload-'))
    const r = offloadPrompt('opencode', wt, langeAufgabe, 'PLATFORM RULES')
    gleich(r.taskFile, join(wt, TASK_FILE), 'written inside the WORKTREE — no permission question')
    gleich(readFileSync(r.taskFile, 'utf8'), langeAufgabe, 'the task, byte for byte')
    wahr(r.prompt.includes(TASK_FILE), 'the launch prompt names the file')
    wahr(r.prompt.trimEnd().endsWith('PLATFORM RULES'), 'the platform framing stays inline')
    wahr(!r.prompt.includes('AUFGABE AUFGABE'), 'the task itself does NOT travel as an argument')
    wahr(Buffer.byteLength(r.prompt) < 1500, `the launch prompt is short (${Buffer.byteLength(r.prompt)} B)`)
    // Self-ignoring, so `git add -A` in the agent's own final commit cannot
    // sweep the platform's task file into the operator's repository.
    gleich(readFileSync(join(wt, TASK_DIR, '.gitignore'), 'utf8'), '*\n', 'the directory ignores itself')
    rmSync(wt, { recursive: true, force: true })
  })

  await pruefe('offloading never makes the prompt LONGER than leaving it alone', () => {
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
      wahr(Buffer.byteLength(r.prompt) <= ganz,
        `task ${task.length} B: launch prompt is never longer (${Buffer.byteLength(r.prompt)} vs ${ganz})`)
      if (r.taskFile) rmSync(join(wt, TASK_DIR), { recursive: true, force: true })
    }
    // A task worth a file still goes to one — the fence must not switch the
    // feature off, only keep it from firing where it buys nothing.
    const gross = offloadPrompt('opencode', wt, 'T'.repeat(12000), platform)
    wahr(gross.taskFile, 'a 12 KB task is still offloaded')
    wahr(Buffer.byteLength(gross.prompt) < 5000, 'and the launch prompt really is short')
    rmSync(wt, { recursive: true, force: true })
  })

  await pruefe('a harness that declares no limit never offloads', () => {
    // claude and cursor take the prompt as an argument without complaint; only
    // a harness that says it cannot gets the indirection.
    for (const h of ['claude', 'cursor', 'hermes']) {
      const r = offloadPrompt(h, '/nowhere', langeAufgabe, 'P')
      gleich(r.taskFile, null, `${h}: nothing written`)
      wahr(r.prompt.includes('AUFGABE'), `${h}: the task travels as before`)
    }
  })

  await pruefe('the finish gate does not read the task file as the agent\'s work', () => {
    // Every harness, unconditionally: the directory is the hub's, and a run
    // that offloaded would otherwise sit at "commit your changes first".
    for (const h of ['opencode', 'claude', 'cursor']) {
      wahr(eigenePfade(h).includes(TASK_DIR), `${h}: ${TASK_DIR} is hub-owned`)
    }
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
    // '.freilauf' stands in front of every harness's own entries: it is where an
    // offloaded task goes (offloadPrompt), and it belongs to the hub the same way.
    gleich(harnessOwnedPaths('cursor').join(','), '.freilauf,.cursor', 'cursor: the task dir and its hook file')
    gleich(harnessOwnedPaths('claude').join(','), '.freilauf', 'claude brings no hook file of its own')
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
  gruppe('opencode: what a run is really doing (opencode-store.mjs)')

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

  await pruefe('a finished subagent is not the run — the whole session tree is', () => {
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
    gleich(sessionTree(d, OC_WT, OC_T0 - 5000).sort().join(','), 'root,sub1,sub2', 'root plus its children')
    const r = readRun(d, OC_WT, OC_T0 - 5000)
    gleich(r.lastActivityMs, ocMin(25), 'the newest timestamp anywhere in the tree')
    gleich(r.tokensIn, 200, 'the subagents\' tokens are the operator\'s tokens')
    gleich(r.tokensOut, 20, 'output likewise summed')
    gleich(Math.round(r.costUsd * 100) / 100, 0.08, 'and the cost')
  })

  await pruefe('a subagent that works somewhere else still belongs to the run', () => {
    // The descendants come off parent_id, not off the directory — an agent that
    // sends a subagent into another checkout must not fall out of its own run.
    const { db: d } = ocStore({ sessions: [
      { id: 'root', parent_id: null, time_created: ocMin(0), time_updated: ocMin(1) },
      { id: 'sub', parent_id: 'root', directory: '/somewhere/else', tokens_input: 7, time_created: ocMin(2), time_updated: ocMin(9) },
      { id: 'deep', parent_id: 'sub', directory: '/somewhere/else', tokens_input: 3, time_created: ocMin(3), time_updated: ocMin(4) },
    ] })
    const r = readRun(d, OC_WT, OC_T0 - 5000)
    gleich(r.sessions, 3, 'the tree is walked to its depth')
    gleich(r.tokensIn, 10, 'their tokens count')
    gleich(r.lastActivityMs, ocMin(9), 'and so does their activity')
  })

  await pruefe('a running turn shows up in the parts, not yet in the session row', () => {
    // session.time_updated moves once per COMPLETED message. Measured in the
    // same run: one message ran 15:32:31 → 15:36:38, four minutes in which the
    // session row said nothing. The parts move while the turn is still going.
    const { db: d } = ocStore({
      sessions: [{ id: 'root', parent_id: null, time_created: ocMin(0), time_updated: ocMin(5) }],
      messages: [{ session_id: 'root', time_updated: ocMin(5) }],
      parts: [{ session_id: 'root', time_updated: ocMin(19) }],
    })
    gleich(readRun(d, OC_WT, OC_T0 - 5000).lastActivityMs, ocMin(19), 'the finest signal the store has wins')
  })

  await pruefe('a session older than the run is not the run\'s', () => {
    // A worktree can hold several sessions over time (a retry, an operator
    // attaching by hand). Nothing matching means "no answer" — never "idle".
    const { db: d } = ocStore({ sessions: [
      { id: 'old', parent_id: null, tokens_input: 999, time_created: OC_T0 - 3600_000, time_updated: OC_T0 - 3500_000 },
    ] })
    const r = readRun(d, OC_WT, OC_T0 - 5000)
    gleich(r.sessions, 0, 'not picked up')
    gleich(r.lastActivityMs, null, 'and no timestamp invented for it')
    gleich(r.tokensIn, 0, 'no foreign tokens')
  })

  await pruefe('a store without parent_id falls back to the newest session', () => {
    // An older (or newer) opencode whose schema does not carry the column must
    // degrade to what the hub did before — never throw, never answer nothing.
    const { db: d } = ocStore({ sessions: [
      { id: 'a', tokens_input: 5, time_created: ocMin(0), time_updated: ocMin(1) },
      { id: 'b', tokens_input: 9, time_created: ocMin(2), time_updated: ocMin(3) },
    ] }, { withParent: false })
    gleich(sessionTree(d, OC_WT, OC_T0 - 5000).join(','), 'b', 'the newest one, as before')
    gleich(readRun(d, OC_WT, OC_T0 - 5000).tokensIn, 9, 'and its numbers')
  })

  await pruefe('no store, no answer — and never a thrown watcher pass', async () => {
    process.env.FREILAUF_OPENCODE_DB = join(sandkasten, 'does-not-exist.db')
    try {
      const run = { harness: 'opencode', workdir_effective: OC_WT, started_at: '2026-09-04 15:11:00' }
      gleich(await storeActivity(run), null, 'null, not an exception')
      gleich(await storeActivity({ harness: 'opencode' }), null, 'a run without a worktree either')
    } finally { delete process.env.FREILAUF_OPENCODE_DB }
  })

  await pruefe('the store path is overridable — a test never reads the operator\'s', async () => {
    // Same fence as FREILAUF_CURSOR_AUTH and FREILAUF_CLAUDE_CREDENTIALS.
    const { file, db: d } = ocStore({ sessions: [
      { id: 'root', parent_id: null, tokens_input: 42, time_created: ocMin(0), time_updated: ocMin(1) },
    ] })
    d.close()
    process.env.FREILAUF_OPENCODE_DB = file
    try {
      const run = { harness: 'opencode', workdir_effective: OC_WT, started_at: '2026-09-04 15:11:00' }
      const r = await storeActivity(run)
      gleich(r.tokensIn, 42, 'read out of the store the variable names')
      gleich(r.lastActivityMs, ocMin(1), 'with its activity')
    } finally { delete process.env.FREILAUF_OPENCODE_DB }
  })

  // ------------------------------------------------------------------
  gruppe('Detection: rate limit / provider errors (detect.mjs)')
  const { typVonClaudeFehler, typVonText, terminalText, scanneZeilen, scanneNeueBytes,
    transkriptFehler, bewerteLogTreffer, fremdeClaudeSession, vorfallWeggrund,
    isSessionStopped } = await import('../server/detect.mjs')

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

    // The two wordings OpenRouter refuses a spent key with. Measured 2026-09-04
    // on this installation: four runs, four red incidents, all of them filed as
    // 'unbekannt' → "API error … the hub carried on by itself". It had not.
    gleich(typVonText('This request requires more credits, or fewer max_tokens. You requested up to '
      + "32000 tokens, but can only afford 20932. To increase, visit https://openrouter.ai/… and adjust the key's daily limit"),
      'billing_error', 'OpenRouter: "requires more credits … can only afford"')
    gleich(typVonText('Prompt tokens limit exceeded: 365512 > 344659. To increase, visit '
      + "https://openrouter.ai/… and adjust the key's daily limit"),
      'billing_error', "OpenRouter: a spent key's daily limit")
    // …and the neighbours it must not swallow: a plain rate limit stays one,
    // and a bare "limit" with no money next to it is still no verdict.
    gleich(typVonText('Rate limit exceeded: free-models-per-day'), 'rate_limit', 'a daily RATE limit is not billing')
    gleich(typVonText('context limit exceeded: 200000 > 180000'), 'unbekannt', 'a bare limit is not billing')
  })

  // An error hook fires while the process dies, and the hub is very often the
  // one killing it — retention, the kill route, a flow, archiving. Filing that
  // as a provider incident is the hub alarming about its own cleanup, and on an
  // aborted run such an incident never resolves by itself. Measured on run
  // c532df45: `session.error: "Aborted"` at 02:14:32, the retention pass's own
  // `aborted` event ten seconds later, and a red "needs you" still standing two
  // days on.
  await pruefe('a stopped session is not a provider fault', () => {
    for (const t of ['Aborted', 'aborted', '  Aborted.  ', 'AbortError',
      'The operation was aborted', 'SIGTERM', 'killed', 'cancelled']) {
      wahr(isSessionStopped(t), `"${t}" is the session ending`)
    }
    // Narrow on purpose: a real error that merely mentions one of those words
    // must still be an incident, or the guard becomes the next false green.
    for (const t of ['API Error: 429 — request aborted after 3 retries',
      'AI_APICallError: stream aborted', 'aborted: 503 upstream unavailable', '', 'alles gut']) {
      falsch(isSessionStopped(t), `"${t}" is not merely a stopped session`)
    }
    gleich(typVonText('AI_APICallError: stream aborted'), 'provider_error',
      'and such a line is still classified as what it is')
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
  gruppe('Freilauf skills: where they go, and what may be removed')

  const skillsMod = await import('../server/skills.mjs')
  const { setPluginConfig: skillsPluginConfig } = await import('../server/plugins/store.mjs')
  const { setSetting: setzeEinstellung } = await import('../server/db.mjs')

  await pruefe('a user path is resolved against the skills home, an absolute one is left alone', () => {
    gleich(skillsMod.expandHome('~/.claude/skills', '/h'), '/h/.claude/skills', 'tilde')
    gleich(skillsMod.expandHome('~', '/h'), '/h', 'bare tilde')
    gleich(skillsMod.expandHome('/opt/skills', '/h'), '/opt/skills', 'absolute')
    gleich(skillsMod.expandHome('', '/h'), '', 'empty stays empty')
  })

  // The calling card is the ONLY thing a user-level skill has to go on: it is
  // read by sessions Freilauf never started, in projects that know nothing
  // about it. `app_dir` is what lets the plugin skill find `docs/plugins.md`
  // — the whole plugin contract, far too long to restate in a skill — so a
  // value that does not really point at the hub's code is a skill that reads
  // nothing and says nothing.
  await pruefe('the calling card names the hub, its data AND its own code', async () => {
    const { existsSync: ex } = await import('node:fs')
    const { join: j, isAbsolute } = await import('node:path')
    const f = skillsMod.installationFacts()
    for (const k of ['id', 'url', 'data_dir', 'runs_dir', 'worktrees_dir', 'app_dir', 'plugin_dir']) {
      wahr(f[k], `${k} is set`)
    }
    wahr(isAbsolute(f.app_dir), 'app_dir is absolute — resolved from the module, not from the cwd')
    wahr(ex(j(f.app_dir, 'docs', 'plugins.md')), 'and it really holds the plugin contract')
    wahr(ex(j(f.app_dir, 'server', 'skills.mjs')), 'and the hub it was resolved from')
    wahr(isAbsolute(f.plugin_dir), 'plugin_dir is absolute')
    gleich(f.plugin_dir, (await import('../server/plugins/loader.mjs')).pluginDir(),
      'and it is the same answer the loader gives — one place decides where packages live')
  })

  // The delivery path was written before any skill needed more than SKILL.md,
  // references/ and scripts/, so nothing about it was ever shape-aware — and
  // that is worth pinning rather than assuming. `freilauf-agent-flow-builder`
  // ships a nested tree with Python, JSON and prompt files in it; if somebody
  // ever "tidies" payloadFiles() into an extension list, this is what says no.
  await pruefe('a skill may ship a nested tree of non-markdown files, and all of it is delivered', async () => {
    const { mkdtempSync, cpSync, writeFileSync, rmSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const builder = skillsMod.availableSkills().find(s => s.name === 'freilauf-agent-flow-builder')
    wahr(!!builder, 'the concept skill is among the shipped ones')
    wahr(builder.files > 10, `its whole tree is counted, not just the top level (${builder.files} files)`)

    // The hash has to answer to every file, at any depth and of any type —
    // otherwise a changed template ships as "already current" forever.
    const tmp = mkdtempSync(j(tmpdir(), 'fl-skill-'))
    try {
      const kopie = j(tmp, 'freilauf-agent-flow-builder')
      cpSync(builder.dir, kopie, { recursive: true })
      gleich(skillsMod.skillHash(kopie), builder.hash, 'a faithful copy hashes identically')
      const tief = j(kopie, 'konzepte', 'aufgaben-schwarm', 'vorlage', 'flows', 'takt-soll.json')
      writeFileSync(tief, '{"changed": true}\n')
      falsch(skillsMod.skillHash(kopie) === builder.hash,
        'a JSON file four levels down changes the hash — no extension list, no folder whitelist')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  // The one thing a shipping skill must NOT answer to. An agent that runs the
  // shipped Python in place writes __pycache__ into the INSTALLED copy; if that
  // counted, the hub would report a copy nobody touched as edited by hand, at
  // every sync, forever.
  await pruefe('python bytecode is not part of a skill — at either end', async () => {
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
      gleich(skillsMod.skillHash(kopie), builder.hash,
        'a __pycache__ written by running the skill leaves the hash exactly where it was')
      writeFileSync(j(kopie, 'stray.pyc'), 'not source\n')
      gleich(skillsMod.skillHash(kopie), builder.hash, 'and so does a loose .pyc beside SKILL.md')
      wahr(ex(j(kopie, 'stray.pyc')), 'the file really is there — it is ignored, not deleted')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  await pruefe('every shipped skill is a valid Agent Skill: name matches its directory, spec keys only', async () => {
    const { readdirSync: rd, readFileSync: rf, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('../skills', import.meta.url).pathname
    const dirs = rd(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    wahr(dirs.length >= 1, 'at least one skill is shipped')
    // The open spec (agentskills.io) allows exactly these six; Claude Code's
    // packaging path REFUSES anything else, so a stray key is a hard failure
    // somewhere the test suite would never see it.
    const erlaubt = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
    for (const name of dirs) {
      const datei = j(root, name, 'SKILL.md')
      wahr(ex(datei), `${name}: SKILL.md exists`)
      const text = rf(datei, 'utf8')
      wahr(text.startsWith('---\n'), `${name}: frontmatter starts on line 1`)
      const block = text.match(/^---\n([\s\S]*?)\n---/)[1]
      const schluessel = block.split('\n').filter(z => /^\S/.test(z)).map(z => z.split(':')[0])
      for (const k of schluessel) wahr(erlaubt.has(k), `${name}: '${k}' is a spec key`)
      wahr(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64, `${name}: legal skill name`)
      gleich(block.match(/^name:\s*(.+)$/m)?.[1].trim(), name, `${name}: frontmatter name is the directory name`)
    }
  })

  await pruefe('a shipped skill has a description that could trigger, and stays under the caps', () => {
    for (const s of skillsMod.availableSkills()) {
      wahr(s.description.length > 40, `${s.name}: description is more than a label`)
      wahr(s.description.length <= 1024, `${s.name}: description within the spec limit`)
      gleich(s.title, s.name, `${s.name}: parsed name`)
    }
  })

  await pruefe('every coding agent that declares skill directories declares lists of strings', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    for (const p of Object.values(HP)) {
      if (!p.skills) continue
      for (const gruppeName of ['user', 'project']) {
        const liste = p.skills[gruppeName] ?? []
        wahr(Array.isArray(liste), `${p.id}: ${gruppeName} is a list`)
        for (const eintrag of liste) wahr(typeof eintrag === 'string' && eintrag.trim(), `${p.id}: ${gruppeName} entry is a path`)
      }
      falsch((p.skills.project ?? []).some(x => x.startsWith('/') || x.startsWith('~')),
        `${p.id}: a project path is relative to a workspace`)
    }
  })

  // The covering set is the whole point of the declaration: three of the four
  // shipped coding agents read ~/.claude/skills, so a machine with all four
  // gets TWO directories and not four. Built from synthetic declarations so the
  // rule is tested, not the current contents of the four plugin files.
  const rolle = (id, user, i = 0) => ({ id, label: id, enabled: true, user, project: [] })
  await pruefe('the covering set is the smallest one, and deterministic', () => {
    const claude = rolle('claude', ['/h/.claude/skills'])
    const cursor = rolle('cursor', ['/h/.cursor/skills', '/h/.claude/skills', '/h/.agents/skills'])
    const oc = rolle('opencode', ['/h/.config/opencode/skill', '/h/.claude/skills', '/h/.agents/skills'])
    const hermes = rolle('hermes', ['/h/.hermes/skills'])
    const dirs = (list) => skillsMod.coveringUserRoots(list).map(x => x.dir)

    gleich(dirs([claude]).join(), '/h/.claude/skills', 'claude alone')
    gleich(dirs([cursor]).join(), '/h/.cursor/skills', 'cursor alone gets its OWN directory, not the shared one')
    gleich(dirs([oc]).join(), '/h/.config/opencode/skill', 'opencode alone the same')
    gleich(dirs([claude, cursor, oc, hermes]).join(), '/h/.claude/skills,/h/.hermes/skills',
      'all four: two directories, because only hermes stands apart')
    gleich(dirs([cursor, oc]).join(), '/h/.claude/skills',
      'a tie on coverage is broken by the summed preference, not by chance')
    const alle = skillsMod.coveringUserRoots([claude, cursor, oc, hermes])
    gleich(alle.find(x => x.dir.endsWith('.claude/skills')).harnesses.join(), 'claude,cursor,opencode',
      'and the directory names who it serves')
  })

  await pruefe('a coding agent without a declaration covers nobody and is reported', () => {
    const stumm = { id: 'stumm', label: 'stumm', enabled: true, user: [], project: [] }
    gleich(skillsMod.coveringUserRoots([stumm]).length, 0, 'nothing to cover it with')
  })

  // The install/remove round trip against a home of its own. The state file and
  // the target home are both redirected at the top of this suite, so nothing
  // here can reach the operator's real directories.
  await pruefe('install, refresh, repair, and remove only what the hub wrote', async () => {
    const { readFileSync: rf, writeFileSync: wf, mkdirSync: md, existsSync: ex, readdirSync: rd } = await import('node:fs')
    const { join: j } = await import('node:path')
    const HOME = process.env.FREILAUF_SKILLS_HOME
    for (const id of ['claude', 'opencode', 'hermes']) skillsPluginConfig(id, { kind: 'harness', source: 'builtin', enabled: 1 })
    setzeEinstellung('skills_install', '1')
    setzeEinstellung('skills_auto_update', '1')

    const erst = skillsMod.syncSkills()
    const anzahl = skillsMod.availableSkills().length
    gleich(erst.targets.length, 2, 'two target directories for these three coding agents')
    gleich(erst.installed.length, anzahl * 2, 'every skill in every target')
    gleich(erst.errors.length, 0, 'and nothing failed')
    const ziel = j(HOME, '.claude', 'skills', 'freilauf-models')
    wahr(ex(j(ziel, 'SKILL.md')), 'the file is really there')
    wahr(ex(j(ziel, skillsMod.MARKER)), 'and carries the marker that makes it removable')

    const zweit = skillsMod.syncSkills()
    gleich(zweit.installed.length + zweit.updated.length, 0, 'a second pass changes nothing')

    // A hand-edited copy is not current, and "keep them up to date" has to mean it.
    wf(j(ziel, 'SKILL.md'), 'tampered')
    gleich(skillsMod.syncSkills().updated.length, 1, 'the edited copy is refreshed')
    wahr(rf(j(ziel, 'SKILL.md'), 'utf8').startsWith('---'), 'and really rewritten')

    // ...unless automatic updating is off, which is the whole meaning of that switch.
    wf(j(ziel, 'SKILL.md'), 'tampered again')
    setzeEinstellung('skills_auto_update', '0')
    gleich(skillsMod.syncSkills().updated.length, 0, 'with updates off nothing is touched')
    gleich(rf(j(ziel, 'SKILL.md'), 'utf8'), 'tampered again', 'the copy stays as it is')
    setzeEinstellung('skills_auto_update', '1')
    skillsMod.syncSkills()

    // A skill of the operator's own, in the same directory, under a name the hub
    // does not ship: never touched, on the way in or on the way out.
    const eigen = j(HOME, '.claude', 'skills', 'meins')
    md(eigen, { recursive: true })
    wf(j(eigen, 'SKILL.md'), '---\nname: meins\n---\n')
    skillsMod.syncSkills()
    wahr(ex(j(eigen, 'SKILL.md')), 'a foreign skill survives a sync')

    // Switching a coding agent off takes its directory with it — and only it.
    skillsPluginConfig('hermes', { kind: 'harness', source: 'builtin', enabled: 0 })
    const ohneHermes = skillsMod.syncSkills()
    gleich(ohneHermes.removed.length, anzahl, 'the hermes copies go')
    falsch(ex(j(HOME, '.hermes', 'skills', 'freilauf-models')), 'really gone')
    wahr(ex(j(ziel, 'SKILL.md')), 'and the shared directory is untouched')

    // Switching the whole thing off removes what the hub wrote, and nothing else.
    setzeEinstellung('skills_install', '0')
    const aus = skillsMod.syncSkills()
    gleich(aus.removed.length, anzahl, 'every remaining copy')
    gleich(rd(j(HOME, '.claude', 'skills')).join(), 'meins', "the operator's own skill is all that is left")
    gleich(skillsMod.readState().entries.length, 0, 'and the hub remembers nothing it no longer owns')
  })

  await pruefe('the selection decides what is installed, and absent means all of them', async () => {
    const { setSetting: setz, default: dbSel } = await import('../server/db.mjs')
    const alle = skillsMod.availableSkills()
    const nichtGeteilt = alle.filter(s => s.role !== 'shared').map(s => s.name)
    const geteilt = alle.filter(s => s.role === 'shared').map(s => s.name)
    wahr(geteilt.length >= 1, 'there is a shared skill nobody picks')
    const namen = () => skillsMod.selectedSkills().map(s => s.name)
    try {
      // Absent is ALL, and that is the backwards-compatible reading: an
      // installation that said yes before this setting existed must not have
      // its skills uninstalled by the next sync.
      setz('skills_selected', '')
      gleich(namen().length, alle.length, 'no selection stored = every shipped skill')
      setz('skills_selected', JSON.stringify([nichtGeteilt[0]]))
      gleich(namen().sort().join(), [nichtGeteilt[0], ...geteilt].sort().join(),
        'one picked, and the shared one rides along because the others load it')
      setz('skills_selected', '[]')
      gleich(namen().length, 0, 'nothing picked takes the shared one too — it exists for the others')
      setz('skills_selected', 'not json{')
      gleich(namen().length, alle.length, 'an unreadable selection falls back to all, never to none')
    } finally {
      // The sandbox database is shared with every group after this one.
      dbSel.prepare("DELETE FROM settings WHERE key='skills_selected'").run()
    }
  })

  await pruefe('a directory the hub did not write is refused instead of overwritten', async () => {
    const { writeFileSync: wf, mkdirSync: md, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const HOME = process.env.FREILAUF_SKILLS_HOME
    const name = skillsMod.availableSkills()[0].name
    const kollision = j(HOME, '.claude', 'skills', name)
    md(kollision, { recursive: true })
    wf(j(kollision, 'SKILL.md'), '---\nname: ' + name + '\n---\nnot ours\n')
    setzeEinstellung('skills_install', '1')
    const r = skillsMod.syncSkills()
    wahr(r.conflicts.some(c => c.dir === kollision), 'the collision is reported')
    gleich((await import('node:fs')).readFileSync(j(kollision, 'SKILL.md'), 'utf8').includes('not ours'), true,
      'and the file is left exactly as it was')
    setzeEinstellung('skills_install', '0')
    skillsMod.syncSkills()
    wahr(ex(j(kollision, 'SKILL.md')), 'switching off does not delete it either')
  })


  // This group is the only one in the suite that CONFIGURES coding agents, and
  // the sandbox database is shared with every group after it — "not configured
  // = not enabled" and the seeding test both read that table. So it hands the
  // database back the way it found it, and says so out loud rather than leaving
  // a later red test to be blamed on the plugin code.
  await pruefe('the round trip leaves no configuration behind for the groups after it', async () => {
    const { forgetPlugin } = await import('../server/plugins/store.mjs')
    const dbMod = (await import('../server/db.mjs')).default
    for (const id of ['claude', 'opencode', 'hermes', 'cursor']) forgetPlugin(id)
    dbMod.prepare("DELETE FROM settings WHERE key IN ('skills_install','skills_auto_update')").run()
    gleich(dbMod.prepare('SELECT count(*) c FROM plugin_config').get().c, 0, 'plugin_config is empty again')
    falsch(skillsMod.skillsInstallOn(), 'and the switch is back off')
  })

  // ------------------------------------------------------------------
  gruppe('Repos: deactivating, and the fences in front of deleting')

  const repoMod = await import('../server/pages.mjs')
  const schedMod = await import('../server/scheduler.mjs')
  const repoDb = (await import('../server/db.mjs')).default

  await pruefe('repoInactive is only true for a repo that is really switched off', () => {
    const id = repoDb.prepare('INSERT INTO repos(name,path) VALUES(?,?)').run('unit-aktiv', '/tmp/unit-aktiv').lastInsertRowid
    const aus = repoDb.prepare('INSERT INTO repos(name,path,active) VALUES(?,?,0)').run('unit-aus', '/tmp/unit-aus').lastInsertRowid
    falsch(schedMod.repoInactive(id), 'an active repo')
    wahr(schedMod.repoInactive(aus), 'a deactivated one')
    // A repo that does not exist is NOT "deactivated" — whatever is wrong
    // there, the ordinary unknown-repo path says it better.
    falsch(schedMod.repoInactive(999999), 'a repo that does not exist')
    repoDb.prepare("DELETE FROM repos WHERE name LIKE 'unit-a%'").run()
    gleich(repoDb.prepare("SELECT count(*) c FROM repos WHERE name LIKE 'unit-a%'").get().c, 0, 'cleaned up again')
  })

  await pruefe('the delete facts count what would really be lost, in flight included', () => {
    const id = repoDb.prepare('INSERT INTO repos(name,path) VALUES(?,?)').run('unit-fakten', '/tmp/unit-fakten').lastInsertRowid
    // try/finally, because this group writes into the sandbox database every
    // later group reads: a throw in the middle must not leave a repo behind.
    try {
      const leer = repoMod.repoDeleteFacts(id)
      gleich(leer.runs, 0, 'a fresh repo has nothing to lose')
      gleich(leer.inFlight, 0, 'and nothing in flight')

      const agentId = repoDb.prepare(`INSERT INTO agents(repo_id,name,harness,prompt,branch_mode,expected_minutes)
        VALUES(?,?,'claude','x','keiner',45)`).run(id, 'unit-agent').lastInsertRowid
      const lauf = (rid, status, report) => repoDb.prepare(`INSERT INTO runs(id,repo_id,agent_id,harness,prompt,branch_mode,expected_minutes,status,report_md)
        VALUES(?,?,?,'claude','x','keiner',45,?,?)`).run(rid, id, agentId, status, report)
      lauf('unit-r1', 'done', '# report')
      lauf('unit-r2', 'running', null)
      repoDb.prepare(`INSERT INTO events(run_id,kind) VALUES('unit-r1','started')`).run()
      repoDb.prepare(`INSERT INTO incidents(run_id,typ,quelle) VALUES('unit-r1','rate_limit','log')`).run()

      const f = repoMod.repoDeleteFacts(id)
      gleich(f.runs, 2, 'both runs')
      gleich(f.agents, 1, 'the agent')
      gleich(f.reports, 1, 'only the run that really wrote a report')
      gleich(f.events, 1, 'its event')
      gleich(f.incidents, 1, 'its incident')
      gleich(f.inFlight, 1, 'and the running one is what blocks a delete')
    } finally {
      repoDb.prepare("DELETE FROM events WHERE run_id LIKE 'unit-r%'").run()
      repoDb.prepare("DELETE FROM incidents WHERE run_id LIKE 'unit-r%'").run()
      repoDb.prepare('DELETE FROM runs WHERE repo_id=?').run(id)
      repoDb.prepare('DELETE FROM agents WHERE repo_id=?').run(id)
      repoDb.prepare('DELETE FROM repos WHERE id=?').run(id)
    }
  })

  await pruefe('the options script is byte-identical in every skill that ships it', async () => {
    const { readFileSync: rf, readdirSync: rd, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('../skills', import.meta.url).pathname
    // A skill directory is copied standalone, so a shared tool has to exist in
    // each skill that needs it. Three copies is three chances to drift, which is
    // exactly what this pins: they must be the SAME file, byte for byte.
    const kopien = rd(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && ex(j(root, d.name, 'scripts', 'fl-options.py')))
      .map(d => [d.name, rf(j(root, d.name, 'scripts', 'fl-options.py'))])
    wahr(kopien.length >= 2, `more than one skill ships it (${kopien.length})`)
    for (const [name, inhalt] of kopien.slice(1)) {
      wahr(inhalt.equals(kopien[0][1]), `${name} matches ${kopien[0][0]} byte for byte`)
    }
  })

  await pruefe('every shipped script is executable and free of a python cache', async () => {
    const { readdirSync: rd, statSync: st, existsSync: ex } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('../skills', import.meta.url).pathname
    for (const d of rd(root, { withFileTypes: true }).filter(x => x.isDirectory())) {
      const dir = j(root, d.name, 'scripts')
      if (!ex(dir)) continue
      falsch(ex(j(dir, '__pycache__')), `${d.name}: no __pycache__ was committed`)
      for (const f of rd(dir)) {
        // A script a skill points at has to be runnable where it lands: the
        // installer copies modes through, so the bit has to be right here.
        wahr((st(j(dir, f)).mode & 0o111) !== 0, `${d.name}/scripts/${f} is executable`)
      }
    }
  })

  await pruefe('the group leaves no repo behind for the groups after it', () => {
    gleich(repoDb.prepare("SELECT count(*) c FROM repos WHERE name LIKE 'unit-%'").get().c, 0,
      'every row this group inserted is gone again')
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
      falsch(r.ok, 'the call failed')
      gleich(r.stage, 'transport', 'the bucket stays transport')
      gleich(r.kind, 'http_429', 'and the specific class is carried for the caller')
      gleich(chats, 1, 'a transport failure is never reprompted — with the retry budget at 0, exactly one call')
      enthaelt(r.error, 'Rate limit reached (HTTP 429)', 'the detail names the problem in English')
      enthaelt(r.error, 'too often', 'and what it means')
    } finally {
      globalThis.fetch = echt
      setz('llm_retry_attempts', versucheAlt ?? '')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await pruefe('a transport failure walks the chain to the fallback before any retry', async () => {
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
      wahr(r.ok, 'the fallback answered')
      gleich(r.source, 'provider:opencode-zen', 'the result names the source that actually answered')
      gleich(r.model, 'zen-model', 'and the model it answered with')
      gleich(aufrufe.or, 1, 'the primary was asked once')
      gleich(aufrufe.zen, 1, 'the fallback took over — no backoff, no wait')
      gleich(r.data.title, 'Fixed login', 'the answer came from the fallback')
    } finally {
      globalThis.fetch = echt
      setz('llm_retry_attempts', versucheAlt ?? '')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await pruefe('a misconfigured primary does not block a working fallback — and an all-config chain stays a config answer', async () => {
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
      wahr(r.ok, 'a skipped config entry is not a verdict about the chain')
      gleich(r.source, 'provider:opencode-zen', 'the fallback carried the question')
      const zwei = await llmJson({
        source: 'provider:openrouter', model: 'a/b',
        fallbacks: [{ source: 'provider:nope', model: 'm' }],
        prompt: 'x',
        schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        schemaName: 'run_title', purpose: 'title',
      })
      falsch(zwei.ok, 'nothing usable in the whole chain')
      gleich(zwei.stage, 'config', 'all-config is a CONFIG answer, never a transport failure')
      enthaelt(zwei.error, 'OpenRouter', 'the error names the PRIMARY — what the operator chose')
      gleich(zen, 1, 'the unusable second chain entry was never fetched')
    } finally {
      globalThis.fetch = echt
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
    }
  })
  await pruefe('when the whole chain is down, the chain retries with backoff — bounded by llm_retry_attempts', async () => {
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
      falsch(r.ok, 'the provider stayed down')
      gleich(r.stage, 'transport', 'and the failure stays a transport failure')
      gleich(chats, 3, 'exactly llm_retry_attempts attempts, pauses included')
    } finally {
      globalThis.fetch = echt
      setz('llm_retry_attempts', alt.a ?? '')
      setz('llm_retry_base_ms', alt.b ?? '')
      setz('llm_retry_max_ms', alt.c ?? '')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
      else delete process.env.OPENROUTER_API_KEY
    }
  })
  await pruefe('backoffDelayMs doubles with jitter and never leaves the ceiling', async () => {
    const { backoffDelayMs } = await import('../server/llm/index.mjs')
    const politik = { baseMs: 1000, maxMs: 4000 }
    for (let i = 0; i < 50; i++) {
      const r0 = backoffDelayMs(0, politik)
      wahr(r0 >= 500 && r0 <= 1500, `round 0 jitters within half the base (${r0})`)
      const r2 = backoffDelayMs(2, politik)
      wahr(r2 >= 2000 && r2 <= 4000, `round 2 is capped at maxMs (${r2})`)
    }
    gleich(backoffDelayMs(10, { baseMs: 1000, maxMs: 0 }), 0, 'a zero ceiling stays zero — an explicit 0 is honoured')
  })
  await pruefe('a parse failure does NOT fall back — the provider is up, the answer is the problem', async () => {
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
      falsch(r.ok, 'prose is prose')
      gleich(r.stage, 'parse', 'an answer problem stays an answer problem')
      wahr(or >= 2, 'the repair rounds ran on the primary')
      gleich(zen, 0, 'the fallback was never asked — falling back would hide which source cannot obey the schema')
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
  await pruefe('a validate failure carries the model\'s raw answer — the diagnosis the error sentence cannot give', async () => {
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
      falsch(r.ok, 'a string is not an object')
      gleich(r.stage, 'validate', 'it parsed, so the failure is a validate failure')
      enthaelt(r.answer, 'only a string, no object', 'the raw answer travels with the failure')
      enthaelt(r.error, 'expected an object, got a string', 'and the complaint names the shape')
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
      // A schema failure quotes what the model actually said — a bare "did not
      // match" is a diagnosis half missing.
      await llmAlert({ purpose: 'title', source: 'provider:openrouter', model: 'm', errorClass: 'validate', text: 'The model answered with JSON, but it did not match the required structure.', answer: '{"title": 7}' })
      enthaelt(gesendet.at(-1), 'answer (excerpt)', 'the answer travels in its own translated line')
      enthaelt(gesendet.at(-1), '{"title": 7}', 'with what the model actually said')
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

  // ------------------------------------------------------------------
  gruppe('The LLM job chain: fallback planning (llm/job.mjs)')
  const job = await import('../server/llm/job.mjs')

  await pruefe('parseFallbackList is STRICT, the opposite of parseSource — junk means no fallback', async () => {
    gleich(job.parseFallbackList('').join(','), '', 'empty')
    gleich(job.parseFallbackList(null).join(','), '', 'null')
    gleich(job.parseFallbackList('agent:claude').join(','), 'agent:claude', 'one source')
    gleich(job.parseFallbackList('agent:claude, provider:deepseek').join(','), 'agent:claude,provider:deepseek', 'an ordered chain, whitespace ignored')
    // A half-typed value must never silently re-point a fallback at OpenRouter.
    gleich(job.parseFallbackList('deepseek').join(','), '', 'an unprefixed id is NOT the default here')
    gleich(job.parseFallbackList('agent:x!y provider:deepseek').join(','), 'provider:deepseek', 'a broken id is dropped, the rest survives')
    gleich(job.parseFallbackList('provider:opencode-zen').join(','), 'provider:opencode-zen', 'a dashed id survives')
  })
  await pruefe('jobFallbacks inherits the primary model unless a fallback model is set', async () => {
    const alt = { a: lese('llm_title_fallback'), b: lese('llm_title_fallback_model') }
    setz('llm_title_fallback', 'agent:claude,provider:deepseek')
    try {
      const ohne = job.jobFallbacks('title', 'deepseek/deepseek-v4-flash')
      gleich(ohne.length, 2, 'both entries are planned')
      gleich(ohne[0].model, 'deepseek/deepseek-v4-flash', 'the primary model is inherited')
      gleich(ohne[1].source, 'provider:deepseek', 'in order')
      setz('llm_title_fallback_model', 'anthropic/claude-sonnet-4')
      const mit = job.jobFallbacks('title', 'deepseek/deepseek-v4-flash')
      gleich(mit[0].model, 'anthropic/claude-sonnet-4', 'an explicit fallback model wins')
    } finally {
      setz('llm_title_fallback', alt.a ?? '')
      setz('llm_title_fallback_model', alt.b ?? '')
    }
  })
  await pruefe('chainUsable is true when the PRIMARY is broken but a fallback is not', async () => {
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
      falsch(job.chainUsable('title', 'm'), 'no fallback: the broken primary decides')
      setz('llm_title_fallback', 'agent:claude')
      wahr(job.chainUsable('title', 'm'), 'an agent fallback needs no credential, no model')
      setz('llm_title_fallback', 'provider:nope')
      falsch(job.chainUsable('title', 'm'), 'an unknown fallback source is not usable')
    } finally {
      setz('llm_title_fallback', alt ?? '')
      if (claudeVorher) setzePlugin('claude', { enabled: claudeVorher.enabled })
      else jobDb.prepare('DELETE FROM plugin_config WHERE plugin_id=?').run('claude')
      if (keyAlt !== undefined) process.env.OPENROUTER_API_KEY = keyAlt
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
  await pruefe('a follow-up anomaly says the same as the anomaly it mirrors', () => {
    const PREFIX = { en: 'follow-up ', de: 'Nachfolgeauftrag ', zh: '后续任务' }
    const cats = _catalogs()
    for (const [code, cat] of Object.entries(cats)) {
      const prefix = PREFIX[code]
      wahr(typeof prefix === 'string', `${code}: the follow-up prefix is known — a new language needs one here`)
      for (const key of Object.keys(cat)) {
        const m = /^anomaly\.followup_(.+)$/.exec(key)
        if (!m) continue
        const zwilling = `anomaly.${m[1]}`
        wahr(Object.hasOwn(cat, zwilling), `${code}: ${key} has no twin ${zwilling}`)
        gleich(cat[key], prefix + cat[zwilling], `${code}: ${key} must be "${zwilling}" with the follow-up prefix`)
      }
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
  // ------------------------------------------------------------------
  // "How many runs are going right now?" — the one number a flow that hands out
  // work cannot do without, and the one it used to have to fetch through a
  // shell_command calling the hub's own HTTP API. The two places it can quietly
  // lie are the filter (a status nobody knows must not widen it) and the case
  // folding of the title prefix (German titles are not ASCII).
  gruppe('Flows: count_runs')

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

  await pruefe('count_runs: registry entry, defaults and the shape it promises', () => {
    const meta = STEP_MAP.count_runs
    wahr(!!meta && meta.output && meta.group === 'data', 'in the registry, in the data group, with an output')
    wahr(STEPS.some(s => s.type === 'count_runs'), 'and in the list the editor is built from')
    falsch(!!meta.placement, 'no placement rule — it reads the hub, not the trigger run')
    const props = defaultProps('count_runs')
    gleich(props.outputVar, 'runs', 'default output variable')
    gleich(props.statuses, 'running', 'by default it counts what is going right now')
    gleich(props.repoId, '', 'no repo chosen = every repo')
    gleich(props.agentId, '', 'and no agent chosen = every agent')
    const paths = vs.shapePaths('vars.runs', vs.outputShapeOf(
      { id: 'c', type: 'count_runs', properties: props }, meta)).map(p => `${p.path}:${p.type}`).join(',')
    enthaelt(paths, 'vars.runs.count:number', 'the number a condition compares')
    enthaelt(paths, 'vars.runs.ids:string_list', 'the ids a for_each walks')
    enthaelt(paths, 'vars.runs.titles:string_list', 'and the titles a message can name')
    gleich(validateDefinition({ sequence: [{ id: 'c', type: 'count_runs', properties: props }] }, { kind: 'cron' }).length, 0,
      'legal under a schedule, where there is no run at all')
  })

  await pruefe('count_runs: repo, agent and status reach the query — the title prefix filters the answer', async () => {
    const { fr, seen } = await countRun(
      { repoId: '7', agentId: '3', statuses: 'running, waiting_help', titlePrefix: '', outputVar: 'runs' }, COUNT_ROWS)
    gleich(fr.status, 'done', 'the step finished')
    gleich(seen[0].repoId, 7, 'the repo goes to the query as a number')
    gleich(seen[0].agentId, 3, 'and so does the agent')
    gleich(seen[0].statuses.join(','), 'running,waiting_help', 'the comma-separated list becomes a list, trimmed')
    gleich(fr.context.vars.runs.count, 4, 'nothing filtered away')
    gleich(fr.context.vars.runs.ids.join(','), 'r-1,r-2,r-3,r-4', 'the ids come back in order')
    gleich(fr.context.vars.runs.titles[3], '', 'a run without a title reports an empty one, never undefined')
    wahr(fr.log.some(l => l.msg === '4 Runs'), 'the log names the number')
  })

  await pruefe('count_runs: an empty repo, agent and status list mean "all of them"', async () => {
    const { seen } = await countRun({ repoId: '', agentId: '', statuses: '', titlePrefix: '', outputVar: 'runs' }, COUNT_ROWS)
    gleich(seen[0].repoId, null, 'no repo = every repo')
    gleich(seen[0].agentId, null, 'no agent = every agent')
    gleich(seen[0].statuses, null, 'no status = every status, the same rule')
  })

  await pruefe('count_runs: the title prefix ignores case, umlauts included', async () => {
    const a = await countRun({ repoId: '', agentId: '', statuses: 'running', titlePrefix: 'nightly', outputVar: 'runs' }, COUNT_ROWS)
    gleich(a.fr.context.vars.runs.count, 2, 'both spellings of "Nightly" count')
    gleich(a.fr.context.vars.runs.ids.join(','), 'r-1,r-2', 'and only those')
    const b = await countRun({ repoId: '', agentId: '', statuses: 'running', titlePrefix: 'NÄCHTLICH', outputVar: 'runs' }, COUNT_ROWS)
    gleich(b.fr.context.vars.runs.count, 1, 'Ä folds to ä — SQLite LIKE would have missed this one')
    const c = await countRun({ repoId: '', agentId: '', statuses: 'running', titlePrefix: 'weekly', outputVar: 'runs' }, COUNT_ROWS)
    gleich(c.fr.context.vars.runs.count, 0, 'a prefix nothing starts with counts nothing')
    gleich(c.fr.context.vars.runs.ids.length, 0, 'and hands on an empty list, not a missing one')
    wahr(c.fr.log.some(l => l.msg === '0 Runs'), 'zero is a result the log states as plainly as any other')
  })

  await pruefe('count_runs: the prefix and the status list are templates', async () => {
    const { fr, seen } = await countRun(
      { repoId: '', agentId: '', statuses: '{{vars.wanted}}', titlePrefix: '{{vars.prefix}}', outputVar: 'runs' }, COUNT_ROWS)
    void fr
    gleich(seen.length, 1, 'the step ran')
    const { api, seen: seen2 } = countStub(COUNT_ROWS)
    const id = await engine.startFlowRun({ id: null, name: 'templated', definition: { sequence: [
      step('set_var', { outputVar: 'wanted', value: 'waiting_help' }),
      step('set_var', { outputVar: 'prefix', value: 'nightly' }),
      step('count_runs', { repoId: '', agentId: '', statuses: '{{vars.wanted}}', titlePrefix: '{{vars.prefix}}', outputVar: 'runs' }),
    ] } }, { kind: 'cron' }, api)
    const fr2 = fdb.getFlowRun(id)
    gleich(seen2[0].statuses.join(','), 'waiting_help', 'the status list came out of a variable')
    gleich(fr2.context.vars.runs.count, 2, 'and so did the prefix')
  })

  await pruefe('count_runs: a status nobody knows fails the step instead of counting everything', async () => {
    const { api } = countStub(COUNT_ROWS)
    const id = await engine.startFlowRun({ id: null, name: 'typo', definition: { sequence: [
      step('count_runs', { repoId: '', agentId: '', statuses: 'runnning', titlePrefix: '', outputVar: 'runs' }),
      step('note', { text: 'never' }),
    ] } }, { kind: 'cron' }, api)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'failed', 'a typo is not a filter that quietly matches every run')
    enthaelt(fr.error, 'runnning', 'the error names what it did not recognise')
    enthaelt(fr.error, 'waiting_help', 'and lists what it would have accepted')
    falsch(fr.log.some(l => l.msg === 'never'), 'nothing after it ran on a wrong number')
  })

  // ------------------------------------------------------------------
  // Switching an agent's schedule from inside a flow. The two places it could
  // quietly do the wrong thing: starting a run for an agent it just switched
  // OFF, and starting a second run for an agent that is already busy — which is
  // the one thing "start right away" was given a guard for.
  gruppe('Flows: toggle_agent')

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

  await pruefe('toggle_agent: registry entry, defaults and the shape it promises', () => {
    const meta = STEP_MAP.toggle_agent
    wahr(!!meta && meta.output && meta.group === 'agents', 'in the registry, in the agents group, with an output')
    wahr(STEPS.some(s => s.type === 'toggle_agent'), 'and in the list the editor is built from')
    falsch(!!meta.placement, 'no placement rule — it switches an agent, it does not read the trigger run')
    const props = defaultProps('toggle_agent')
    gleich(props.active, 'on', 'switching on is the default')
    gleich(props.startNow, false, 'and it does not start anything unasked')
    gleich(props.outputVar, 'agent', 'default output variable')
    const paths = vs.shapePaths('vars.agent', vs.outputShapeOf(
      { id: 'tg', type: 'toggle_agent', properties: props }, meta)).map(p => `${p.path}:${p.type}`).join(',')
    for (const p of ['vars.agent.id:number', 'vars.agent.name:string', 'vars.agent.active_before:boolean',
      'vars.agent.active_after:boolean', 'vars.agent.started_run_id:string']) enthaelt(paths, p, p)
    wahr(validateDefinition({ sequence: [{ id: 'tg', type: 'toggle_agent', properties: { ...props, agentId: '' } }] })
      .some(p => p.includes("'agentId' is required")), 'without an agent it is not a step')
    gleich(validateDefinition({ sequence: [{ id: 'tg', type: 'toggle_agent', properties: { ...props, agentId: 4 } }] },
      { kind: 'cron' }).length, 0, 'legal under a schedule, where there is no run at all')
  })

  await pruefe('toggle_agent: on, off and over — and the state it reports is before → after', async () => {
    const an = await toggleRun({ agentId: '4', active: 'on', startNow: false, outputVar: 'agent' },
      [{ id: 4, name: 'nightly', active: false }])
    gleich(an.calls[0].join(':'), 'setAgentActive:4:true', 'switching on asks for true')
    gleich(an.fr.context.vars.agent.active_before, false, 'it was off')
    gleich(an.fr.context.vars.agent.active_after, true, 'and is on now')
    gleich(an.fr.context.vars.agent.name, 'nightly', 'the name comes back for the message that follows')
    wahr(an.fr.log.some(l => l.msg === 'nightly: off → on'), 'the log names both ends of the change')

    const aus = await toggleRun({ agentId: '4', active: 'off', startNow: false, outputVar: 'agent' }, NIGHTLY)
    gleich(aus.calls[0].join(':'), 'setAgentActive:4:false', 'switching off asks for false')
    gleich(aus.fr.context.vars.agent.active_after, false, 'and it is off')

    const um1 = await toggleRun({ agentId: '4', active: 'toggle', startNow: false, outputVar: 'agent' }, NIGHTLY)
    gleich(um1.calls[0].join(':'), 'setAgentActive:4:false', 'toggle on an active agent switches it off')
    const um2 = await toggleRun({ agentId: '4', active: 'toggle', startNow: false, outputVar: 'agent' },
      [{ id: 4, name: 'nightly', active: false }])
    gleich(um2.calls[0].join(':'), 'setAgentActive:4:true', 'and on an inactive one switches it on')
  })

  await pruefe('toggle_agent: "start right away" starts one — and never for an agent it just switched off', async () => {
    const an = await toggleRun({ agentId: '4', active: 'on', startNow: true, outputVar: 'agent' },
      [{ id: 4, name: 'nightly', active: false }])
    wahr(an.calls.some(c => c[0] === 'startAgentIfIdle'), 'switched on, so it starts')
    gleich(an.fr.context.vars.agent.started_run_id, 'run-of-4', 'and hands the run id on')
    enthaelt(an.fr.log.map(l => l.msg).join(' '), 'started run run-of-4', 'the log says which run')

    const aus = await toggleRun({ agentId: '4', active: 'off', startNow: true, outputVar: 'agent' }, NIGHTLY)
    falsch(aus.calls.some(c => c[0] === 'startAgentIfIdle'),
      'switched OFF with the box still ticked starts nothing — the ticked box is not a second command')
    gleich(aus.fr.context.vars.agent.started_run_id, null, 'and the output says so')
  })

  await pruefe('toggle_agent: a busy agent is skipped — a result, not a failure', async () => {
    const { fr } = await toggleRun({ agentId: '4', active: 'on', startNow: true, outputVar: 'agent' }, NIGHTLY, [4])
    gleich(fr.status, 'done', 'the flow run carries on')
    gleich(fr.context.vars.agent.started_run_id, null, 'nothing was started')
    gleich(fr.context.vars.agent.active_after, true, 'but the switch itself did happen')
    enthaelt(fr.log.map(l => l.msg).join(' '), 'skipped (agent is busy)', 'and the log says it was skipped')
  })

  await pruefe('toggle_agent: an agent nobody has fails the step', async () => {
    const { api } = agentStub(NIGHTLY)
    const id = await engine.startFlowRun({ id: null, name: 'ghost', definition: { sequence: [
      step('toggle_agent', { agentId: '99', active: 'on', startNow: false, outputVar: 'agent' }),
      step('note', { text: 'never' }),
    ] } }, { kind: 'cron' }, api)
    const fr = fdb.getFlowRun(id)
    gleich(fr.status, 'failed', 'a flow that switches nothing must not report success')
    enthaelt(fr.error, '99', 'the error names the id')
    falsch(fr.log.some(l => l.msg === 'never'), 'and nothing after it ran')
  })

  // ------------------------------------------------------------------
  // A panel is a number a PROJECT pushes into the sidebar, so everything that
  // decides here decides about somebody else's data: what is repaired, what is
  // refused, and above all what an empty field means. `Number('')` is 0 and
  // finite — in a panel that is not merely wrong, it reads as "nothing left to
  // do", which is the most expensive shape a wrong number can take here.
  gruppe('Panels: what a project pushes into the sidebar (panels.mjs)')

  const { normalizePanel, panelState, setPanelValue, panelValue, panelValues, deletePanelValue, PANEL_MAX_ITEMS } =
    await import('../server/panels.mjs')

  await pruefe('a panel needs a total or an item — nothing else counts as one', () => {
    falsch(normalizePanel(null).ok, 'null')
    falsch(normalizePanel('not json').ok, 'not JSON')
    falsch(normalizePanel([1, 2]).ok, 'an array is not an object')
    falsch(normalizePanel({ title: 'Findings' }).ok, 'a title alone is not a value')
    wahr(normalizePanel({ total: 0 }).ok, 'a total of zero IS a value')
    wahr(normalizePanel({ items: [{ label: 'bug', count: 3 }] }).ok, 'items alone are enough')
  })

  await pruefe('an empty count is null, never 0 — the Number("") trap', () => {
    const r = normalizePanel({ total: '', items: [{ label: 'bug', count: '' }, { label: 'task', count: '7' }] })
    wahr(r.ok, 'accepted')
    gleich(r.value.total, null, 'the total says "not measured", not "none left"')
    gleich(r.value.items[0].count, null, 'and so does the row')
    gleich(r.value.items[1].count, 7, 'a numeric string is still a number')
  })

  await pruefe('what cannot be rendered is dropped, not passed through', () => {
    const r = normalizePanel({
      total: 5, tone: 'chartreuse',
      href: 'javascript:alert(1)',
      items: [{ label: 'a', count: 1, tone: 'RED' }, { count: 2 }, { label: 'b', count: 3, href: '../bugs' }],
    })
    gleich(r.value.tone, null, 'an unknown tone')
    gleich(r.value.href, null, 'a href that is not a link')
    gleich(r.value.items.length, 2, 'a row without a label is not a row')
    gleich(r.value.items[0].tone, 'red', 'a tone is read case-insensitively')
    gleich(r.value.items[1].href, null, 'a filesystem path is dead in a browser')
    gleich(normalizePanel({ total: 1, href: 'https://example.test/x' }).value.href, 'https://example.test/x', 'http(s) travels')
    gleich(normalizePanel({ total: 1, href: '/runs/abc' }).value.href, '/runs/abc', 'a path on this hub travels')
    gleich(normalizePanel({ total: 1, href: '//evil.test' }).value.href, null, 'a protocol-relative one does not')
  })

  await pruefe('the caps hold: a sidebar column is not a table', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `row ${i}`, count: i }))
    const r = normalizePanel({ total: 1, items: many })
    gleich(r.value.items.length, PANEL_MAX_ITEMS, 'cut to the cap')
    wahr(r.problems.some(p => /more than/.test(p)), 'and it says so instead of silently dropping')
    gleich(normalizePanel({ total: 1, items: [{ label: 'x'.repeat(200), count: 1 }] }).value.items[0].label.length, 40, 'a label is cut')
  })

  await pruefe('state: fresh, stale, error — and no ttl means never stale', () => {
    const now = Date.parse('2026-09-04T12:00:00Z')
    const old = { atMs: now - 3 * 60 * 60 * 1000, ttlMin: null, error: null }
    gleich(panelState(old, now), 'fresh', 'a value without a ttl promises no interval')
    gleich(panelState({ ...old, ttlMin: 60 }, now), 'stale', 'past its own ttl')
    gleich(panelState({ ...old, ttlMin: 600 }, now), 'fresh', 'inside it')
    gleich(panelState({ ...old, error: 'tool missing' }, now), 'error', 'a failed measurement outranks the clock')
  })

  await pruefe('storing: round trip, refusals, and a failure that keeps the numbers', async () => {
    const { db: udb } = await import('../server/db.mjs')
    udb.prepare(`INSERT INTO repos(name, path) VALUES('panel-test','/tmp/panel-test')`).run()
    const repoId = udb.prepare(`SELECT id FROM repos WHERE name='panel-test'`).get().id

    falsch(setPanelValue({ repoId, key: 'Not A Key', value: { total: 1 } }).ok, 'an invalid key is refused')
    falsch(setPanelValue({ repoId: 999999, key: 'x', value: { total: 1 } }).ok === true, 'an unknown repo is refused')

    wahr(setPanelValue({ repoId, key: 'findings', value: { title: 'Findings', total: 33, items: [{ label: 'bug', count: 17 }] } }).ok, 'stored')
    const p = panelValue(repoId, 'findings')
    gleich(p.total, 33, 'the total came back')
    gleich(p.items[0].label, 'bug', 'and the row')
    gleich(panelState(p), 'fresh', 'a fresh push is fresh')

    // The producer failed. The point of this path: the LAST numbers stay
    // visible — an operator who is told "measurement failed" and shown nothing
    // has lost the information that was already there.
    wahr(setPanelValue({ repoId, key: 'findings', error: 'the register tool is not on this branch' }).ok, 'a failure is a push too')
    const nachFehler = panelValue(repoId, 'findings')
    gleich(nachFehler.total, 33, 'the numbers survived')
    gleich(panelState(nachFehler), 'error', 'and the state says they are not confirmed')

    wahr(setPanelValue({ repoId, key: 'findings', value: { total: 30 } }).ok, 'a new value')
    gleich(panelValue(repoId, 'findings').error, null, 'clears the failure')

    gleich(panelValues(repoId).length, 1, 'one panel on this repo')
    deletePanelValue(repoId, 'findings')
    gleich(panelValues(repoId).length, 0, 'and gone')
    gleich(panelValues(null).length, 0, 'no repo, no panels — never a throw')
  })

  await pruefe('bin/fl-panel parses', async () => {
    const { execFileSync: run } = await import('node:child_process')
    const root = new URL('..', import.meta.url).pathname
    run('node', ['--check', join(root, 'bin', 'fl-panel')], { stdio: ['ignore', 'ignore', 'pipe'] })
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
    for (const f of ['SETUP_WITH_AGENT.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'LICENSE', ...readmes]) {
      wahr(existsSync(j(root, f)), `${f} exists`)
    }
    for (const f of readmes) {
      const text = readFileSync(j(root, f), 'utf8')
      wahr(text.includes('SETUP_WITH_AGENT.md'), `${f} links SETUP_WITH_AGENT.md`)
      wahr(text.includes('CONTRIBUTING.md'), `${f} links CONTRIBUTING.md`)
      // The roadmap is English only, so a Chinese or German reader reaches it
      // exactly one way: through their own README.
      wahr(text.includes('(ROADMAP.md)'), `${f} links ROADMAP.md`)
      for (const other of readmes.filter((o) => o !== f)) {
        wahr(text.includes(`(${other})`), `${f} links ${other} (language switcher)`)
      }
    }
    wahr(readFileSync(j(root, 'LICENSE'), 'utf8').includes('Attribution 4.0 International'),
      'LICENSE is the CC BY 4.0 legal code')
  })

  // A roadmap that names a design document which is no longer there sends the
  // one interested reader after a 404, and a roadmap without the issues URL is
  // an invitation with no address on it.
  await pruefe('ROADMAP.md links its design study and the issue tracker', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('..', import.meta.url).pathname
    const text = readFileSync(j(root, 'ROADMAP.md'), 'utf8')
    for (const link of [...text.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1])) {
      wahr(existsSync(j(root, link)), `ROADMAP.md links ${link}, which exists`)
    }
    wahr(text.includes('SANDBOX_RESEARCH.md'), 'ROADMAP.md links the sandbox design study')
    wahr(text.includes('https://github.com/hwalde/freilauf/issues'),
      'ROADMAP.md names the issue tracker')
  })

  // The changelog has no version numbers — its sections are DAYS, so the dates
  // are the whole ordering and a chronology out of order is one that quietly
  // stopped being a chronology. Several agents write into this file, sometimes
  // in parallel, which is exactly how a day ends up in the wrong place.
  await pruefe('CHANGELOG.md is dated per day, newest first, with known categories', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const root = new URL('..', import.meta.url).pathname
    wahr(existsSync(j(root, 'CHANGELOG.md')), 'CHANGELOG.md exists')
    const lines = readFileSync(j(root, 'CHANGELOG.md'), 'utf8').split('\n')
    const days = []
    const known = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'])
    for (const line of lines) {
      if (line.startsWith('## ')) {
        const d = line.slice(3).trim()
        wahr(/^\d{4}-\d{2}-\d{2}$/.test(d), `day heading "${d}" is an ISO 8601 date`)
        wahr(!Number.isNaN(Date.parse(d)), `day heading "${d}" is a real date`)
        days.push(d)
      }
      if (line.startsWith('### ')) {
        const c = line.slice(4).trim()
        wahr(known.has(c), `category "${c}" is one of Keep a Changelog's`)
      }
    }
    wahr(days.length >= 1, 'at least one day is written down')
    for (let i = 1; i < days.length; i++) {
      wahr(days[i] < days[i - 1], `${days[i]} comes after ${days[i - 1]} (newest first, no duplicates)`)
    }
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
  // A paste is not a keystroke: claude collapses a bracketed paste over 800
  // characters into a `[Pasted text #n]` placeholder, and a placeholder is
  // never read as a slash command — so the command word has to be TYPED and
  // only the condition may be pasted (measured 2.1.261).
  await pruefe('the command word is typed, the condition is pasted', () => {
    const k = gl.goalKeys('claude', 'all tests pass')
    gleich(k.typed, '/goal ', 'the part that has to arrive as keystrokes')
    gleich(k.argument, 'all tests pass', 'the part that may be a paste')
    gleich(k.typed + k.argument, gl.goalCommand('claude', 'all tests pass'),
      'and the two halves are the command line, so nothing can drift apart')
    const lang = gl.goalKeys('claude', 'y'.repeat(3000))
    gleich(lang.typed, '/goal ', 'a long condition is exactly the case this exists for')
    gleich(lang.argument.length, 3000, 'and all of it is still the argument')
    gleich(gl.goalKeys('claude', '   '), null, 'nothing to send')
    gleich(gl.goalKeys('opencode', 'all tests pass'), null, 'a coding agent without a spec gets no keys')
  })
  await pruefe('a plugin that declares no typed prefix keeps the single paste', async () => {
    const { registerPlugin, unregisterPlugin } = await import('../server/plugins/registry.mjs')
    const desc = {
      id: 'unit-goal-plugin', kind: 'harness', label: 'Goal agent', bin: 'goalbin',
      subscription: false, providers: [], logPatterns: [{ typ: 'rate_limit', re: /x/ }],
      modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null,
      goal: { max: 100, command: (c) => `!ziel ${c}` },
    }
    wahr(registerPlugin(desc, { source: 'external' }).ok, 'the plugin registers')
    try {
      const k = gl.goalKeys('unit-goal-plugin', 'fertig')
      gleich(k.typed, '', 'everything is pasted, as it always was')
      gleich(k.argument, '!ziel fertig', 'and the whole line is the paste')
      // A prefix that does not really start the command would send two halves
      // meaning something else together — the whole line is pasted instead.
      desc.goal.typed = '/anders '
      gleich(gl.goalKeys('unit-goal-plugin', 'fertig').typed, '', 'a prefix that does not fit is not used')
      gleich(gl.goalKeys('unit-goal-plugin', 'fertig').argument, '!ziel fertig', 'and nothing is lost by that')
    } finally { unregisterPlugin('unit-goal-plugin') }
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
    gleich(erlaubt('scheduled'), '{"duration":true,"prompt":true,"repo":true,"startTime":true,"branch":true,"sandbox":true}', 'scheduled')
    gleich(erlaubt('deferred'), '{"duration":true,"prompt":true,"repo":true,"startTime":false,"branch":true,"sandbox":true}', 'deferred: no start time — it waits on quota, not on a time')
    gleich(erlaubt('running'), '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false,"sandbox":false}', 'running')
    gleich(erlaubt('waiting_help'), '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false,"sandbox":false}', 'waiting for a human is still running')
    for (const s of ['done', 'failed', 'aborted']) {
      gleich(erlaubt(s), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false,"sandbox":false}', `${s}: nothing left to edit`)
    }
    // A finished run with an open follow-up commission is working again — its
    // duration is read live by the watcher's overrun thresholds, exactly as for
    // a running run.
    const followup = (extra) => JSON.stringify(runEditAllowed({ status: 'done', ...extra }))
    gleich(followup({ followup_since: '2026-01-01 00:00:00' }),
      '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false,"sandbox":false}',
      'a follow-up commission reopens the duration for editing')
    gleich(followup({ followup_open: 1 }),
      '{"duration":true,"prompt":false,"repo":false,"startTime":false,"branch":false,"sandbox":false}',
      'a follow-up in the gate too')
    gleich(followup({}), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false,"sandbox":false}',
      'a plain finished run stays closed')
    gleich(JSON.stringify(runEditAllowed(null)), '{"duration":false,"prompt":false,"repo":false,"startTime":false,"branch":false,"sandbox":false}', 'no run')
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

  // ---- the merge check's own box (§8.7) -----------------------------------
  // `repos.merge_check_sandboxed` existed as a column, a checkbox and a
  // sentence in docs/sandbox.md, and NOTHING read it: the check ran
  // `bash -lc` on the host either way. These pin the shape of the container it
  // runs in now, because that argv is the whole control.

  const CHECK_SPEC = {
    runtime: 'docker',
    image: { ref: 'freilauf/claude:1' },
    network: { mode: 'allowlist' },
    resources: { memory: '8g', cpus: 4, pidsLimit: 512, shmSize: '' },
  }

  await pruefe('the sandboxed merge check runs in the run’s image, on the merged result', () => {
    const args = ig.mergeCheckArgv(CHECK_SPEC, {
      name: 'fl-check-r1', runId: 'r1', dir: '/i/repo', check: 'node test/unit.mjs',
      uid: 1000, gid: 1000, network: 'fl-net-r1', proxyUrl: 'http://fl-proxy-r1:8080',
      mounts: [{ source: '/p/.git', target: '/p/.git', mode: 'ro' }],
    })
    gleich(args[0], 'run', 'a container of its own, not an exec into the agent’s')
    wahr(args.includes('--rm'), 'and it does not outlive the check')
    gleich(args[args.length - 3], 'bash', 'the operator’s command, through a login shell as before')
    gleich(args[args.length - 2], '-lc', 'with the same flags the host call used')
    gleich(args[args.length - 1], 'node test/unit.mjs', 'and the check verbatim')
    gleich(args[args.length - 4], 'freilauf/claude:1', 'the image is the run’s own')
    wahr(args.includes('/i/repo:/i/repo:rw'), 'the integration worktree is mounted at its own path')
    wahr(args.includes('/p/.git:/p/.git:ro'), 'and so is the repository git dir the linked worktree needs')
    gleich(args[args.indexOf('-w') + 1], '/i/repo', 'the check runs in the merged result')
    gleich(args[args.indexOf('--user') + 1], '1000:1000', 'as the hub user, like the run')
    wahr(args.includes('--cap-drop') && args.includes('no-new-privileges'), 'the run’s hardening comes along')
    gleich(args[args.indexOf('--network') + 1], 'fl-net-r1', 'and the run’s own network')
    wahr(args.includes('HTTPS_PROXY=http://fl-proxy-r1:8080'), 'with the run’s proxy, so the policy is the same one')
    gleich(args[args.indexOf('--memory') + 1], '8g', 'the memory ceiling travels')
    falsch(args.includes('--shm-size'), 'an empty resource is not a configured 0')
    falsch(args.includes('freilauf.run=r1'), 'never labelled as a RUN — the orphan reaper filters on that')
  })

  await pruefe('a merge check under a policy the hub cannot rebuild gets no network at all', () => {
    const args = ig.mergeCheckArgv(CHECK_SPEC, { dir: '/i/repo', check: 'true' })
    gleich(args[args.indexOf('--network') + 1], 'none',
      'allowlist without a network to join means deny — never the open bridge')
    falsch(args.some(a => String(a).startsWith('HTTPS_PROXY=')), 'and no proxy is promised that is not there')
    const none = ig.mergeCheckArgv({ ...CHECK_SPEC, network: { mode: 'none' } }, { dir: '/i/repo', check: 'true' })
    gleich(none[none.indexOf('--network') + 1], 'none', 'mode none stays none')
    const open = ig.mergeCheckArgv({ ...CHECK_SPEC, network: { mode: 'open' } }, { dir: '/i/repo', check: 'true' })
    falsch(open.includes('--network'), 'and open writes no flag, which IS the default bridge')
  })

  await pruefe('a check container that cannot be described refuses instead of guessing', () => {
    let fehler = null
    try { ig.mergeCheckArgv({ ...CHECK_SPEC, image: {} }, { dir: '/i/repo', check: 'true' }) } catch (e) { fehler = e }
    wahr(fehler && /image/.test(fehler.message), 'no image, no container — and the caller turns that into a refusal')
    fehler = null
    try { ig.mergeCheckArgv(CHECK_SPEC, { dir: 'relative', check: 'true' }) } catch (e) { fehler = e }
    wahr(fehler && /directory/.test(fehler.message), 'and a relative working directory is not a mount')
    const pinned = ig.mergeCheckArgv({ ...CHECK_SPEC, image: { ref: 'img', digest: 'abc' } },
      { dir: '/i/repo', check: 'true' })
    wahr(pinned.includes('img@sha256:abc'), 'a digest-pinned run checks against the same bytes it ran on')
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
      // A deliberately fictional port, like every other value in this repo:
      // the operator's real one is a forbidden pattern (pruefe-vor-push.sh),
      // and a test fixture is a committed file like any other.
      process.env.FREILAUF_VPN_PORT = '9443'
      setPublicHost('hub.example.internal')
      gleich(publicBase(), 'https://hub.example.internal:9443', 'the configured hostname with the LIVE port')
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
    // hermes CAN be resumed since 0.21 (state.db knows the session; 'latest'
    // when it does not) — the command names the worktree as the workspace.
    const hermes = ig.assessText({ harness: 'hermes', workdir_effective: '/wt/b', started_at: '2026-09-05 07:00:00' },
      { status: 'nothing', commits: 0, dirty: 0 })
    enthaelt(hermes, 'Resume the session: cd /wt/b && hermes chat --in /wt/b --resume ', 'hermes has a resume command now')
    const fremd = ig.assessText({ harness: 'nosuchagent', workdir_effective: '/wt/c' },
      { status: 'nothing', commits: 0, dirty: 0 })
    enthaelt(fremd, 'cannot be resumed', 'a harness without a resume says so')
    enthaelt(fremd, '/wt/c', 'and names the worktree instead')
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

  // ------------------------------------------------------------------
  gruppe("The agent's attention: working or waiting for input")

  await pruefe('displayStatus: the record stays, the word follows the agent', async () => {
    const { displayStatus, followUpActive } = await import('../server/run-state.mjs')
    const r = (row) => displayStatus(row)
    gleich(r({ status: 'running', agent_state: null }), 'running', 'nothing said yet: running')
    gleich(r({ status: 'running', agent_state: 'working' }), 'running', 'working: running')
    gleich(r({ status: 'running', agent_state: 'waiting' }), 'waiting_input', 'turn over: waiting for input')
    // waiting_help is a QUESTION, and the question outranks the idle it causes.
    gleich(r({ status: 'waiting_help', agent_state: 'waiting' }), 'waiting_help', 'a help call stays a help call')
    gleich(r({ status: 'done', agent_state: 'waiting' }), 'done', 'a finished run with no commission is finished')
    gleich(r({ status: 'done', agent_state: 'working', followup_since: 'x' }), 'running', 'commission + working: running')
    gleich(r({ status: 'done', agent_state: 'waiting', followup_since: 'x' }), 'waiting_input', 'commission + waiting: waiting for input')
    gleich(r({ status: 'failed', agent_state: null, followup_open: 1 }), 'running', 'a follow-up in the gate: running')
    gleich(r({ status: 'scheduled', agent_state: 'waiting' }), 'scheduled', 'a run without a session is what it is')
    wahr(followUpActive({ status: 'aborted', followup_since: 'x' }), 'followUpActive on followup_since')
    falsch(followUpActive({ status: 'running', followup_since: 'x' }), 'never on a running run')
  })

  await pruefe('isOperatorInput: a key is the operator, a mouse report is the terminal', async () => {
    // The browser terminal answers "waiting for input" with the first byte a
    // PERSON sends (terminal.mjs → reports.mjs noteOperatorInput). What
    // xterm.js sends on the application's behalf must not count: a click to
    // focus the tab, the wheel over the pane, the window coming to the front.
    const { isOperatorInput } = await import('../server/run-state.mjs')
    wahr(isOperatorInput('y'), 'one key')
    wahr(isOperatorInput('\r'), 'Enter')
    wahr(isOperatorInput('\x03'), 'Ctrl-C')
    wahr(isOperatorInput('\x1b'), 'a bare Escape')
    wahr(isOperatorInput('\x1b[A'), 'an arrow key')
    wahr(isOperatorInput('\x1b[200~fix the test\x1b[201~'), 'a bracketed paste')
    falsch(isOperatorInput(''), 'nothing')
    falsch(isOperatorInput(null), 'not a string')
    falsch(isOperatorInput('\x1b[<0;12;5M'), 'an SGR mouse press')
    falsch(isOperatorInput('\x1b[<0;12;5m'), 'an SGR mouse release')
    falsch(isOperatorInput('\x1b[<64;12;5M\x1b[<65;12;5M'), 'two wheel reports')
    falsch(isOperatorInput('\x1b[M !!'), 'an X10 mouse report')
    falsch(isOperatorInput('\x1b[I'), 'focus in')
    falsch(isOperatorInput('\x1b[O'), 'focus out')
    wahr(isOperatorInput('\x1b[<0;12;5Mq'), 'a key after a click still counts')
  })

  await pruefe('anomaliesSettled: a run that came through has answered them', async () => {
    // The traffic light in pages.mjs asks this before it lets an in-flight
    // anomaly colour a row. The rule is here, next to displayStatus, because it
    // is the same kind of question: what does this run's state MEAN now.
    const { anomaliesSettled, IN_FLIGHT_ANOMALIES } = await import('../server/run-state.mjs')
    wahr(anomaliesSettled({ status: 'done' }), 'done: settled')
    falsch(anomaliesSettled({ status: 'running' }), 'a run in flight is not')
    falsch(anomaliesSettled({ status: 'waiting_help' }), 'nor one asking a question')
    // failed/aborted keep theirs — there the anomaly is the explanation of why
    // the run did not come through, which is exactly what one wants to read.
    falsch(anomaliesSettled({ status: 'failed' }), 'failed keeps its explanation')
    falsch(anomaliesSettled({ status: 'aborted' }), 'aborted too')
    // A finished run with an open follow-up commission is working right now.
    falsch(anomaliesSettled({ status: 'done', followup_since: 'x' }), 'not while a follow-up is open')
    falsch(anomaliesSettled({ status: 'done', followup_open: 1 }), 'nor while one is in the gate')
    falsch(anomaliesSettled(null), 'no run, no verdict')
    // The list is the statements a run's own end answers. `unpushed` is NOT one
    // of them: it is written AFTER the run ended and stays true afterwards —
    // work that lives only on this machine is still work that lives only on
    // this machine. Neither are the follow-up overruns, which describe a
    // commission that is open right now.
    for (const k of ['anomaly:unpushed', 'anomaly:followup_overrun', 'anomaly:followup_soft_overrun']) {
      falsch(IN_FLIGHT_ANOMALIES.includes(k), `${k} is not settled by the run ending`)
    }
    wahr(IN_FLIGHT_ANOMALIES.every(k => k.startsWith('anomaly:')), 'and every entry is an anomaly kind')
  })

  await pruefe('displayStatusSql selects exactly the rows displayStatus would', async () => {
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
      gleich(viaSql.join(','), viaJs.join(','), `${s}: SQL and JavaScript agree`)
      wahr(viaJs.length > 0, `${s} selects something at all`)
    }
    d.close()
  })

  await pruefe('after a report, only a human prompt opens a follow-up — a tool call waits out the grace', async () => {
    // `fl-report done` is a tool call INSIDE the turn; the two or three calls
    // an agent makes after it arrive as `_working` on a finished run. Read as
    // a commission they turned every finished run into "waiting for input".
    const { commissionOnWorking, attentionGraceMs } = await import('../server/reports.mjs')
    const grace = 120_000
    wahr(commissionOnWorking('prompt', 5_000, grace), 'a prompt right after the report is a commission')
    wahr(commissionOnWorking('prompt', -Infinity, grace), 'a prompt with no known report is one too')
    falsch(commissionOnWorking('tool', 5_000, grace), 'a tool call 5 s after the report is the turn finishing')
    falsch(commissionOnWorking('busy', 119_000, grace), "opencode's busy inside the window too")
    wahr(commissionOnWorking('tool', 121_000, grace), 'past the window a tool call is work somebody asked for')
    wahr(commissionOnWorking('hook', -Infinity, grace), 'and with no report known at all, nothing is held back')
    wahr(commissionOnWorking('tool', NaN, grace), 'NaN is not "just now" either')
    gleich(attentionGraceMs(), 120_000, 'two minutes by default')
    process.env.FREILAUF_ATTENTION_GRACE_MS = '5000'
    gleich(attentionGraceMs(), 5_000, 'configurable')
    process.env.FREILAUF_ATTENTION_GRACE_MS = 'junk'
    gleich(attentionGraceMs(), 120_000, 'junk means the default, never zero')
    delete process.env.FREILAUF_ATTENTION_GRACE_MS
  })

  await pruefe('every built-in coding agent declares how its attention reaches the hub', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    for (const id of ['claude', 'opencode', 'hermes', 'cursor']) {
      wahr(HP[id].attention && typeof HP[id].attention.source === 'string', `${id} declares attention.source`)
    }
  })

  await pruefe("claude: the hooks say working, waiting, and never a subagent's end", async () => {
    const { claudeSettingsJson } = await import('../server/runner.mjs')
    const j = JSON.parse(claudeSettingsJson())
    const cmd = (ev) => j.hooks[ev][0].hooks[0].command
    gleich(cmd('UserPromptSubmit'), 'fl-report _working prompt', 'a prompt starts a turn — and says it was a prompt')
    enthaelt(cmd('PreToolUse'), 'fl-report _working tool', 'a tool call is work, and says it was a tool call')
    enthaelt(cmd('PreToolUse'), 'setsid -f', 'and it must not hold the tool call up')
    gleich(cmd('Stop'), 'fl-report _turn_end', 'the turn end is the waiting')
    gleich(cmd('Notification'), 'fl-report _waiting', 'the idle prompt is the net under it')
    gleich(j.hooks.Notification[0].matcher, 'idle_prompt|permission_prompt', 'and only the notifications that mean waiting')
    falsch('SubagentStop' in j.hooks, 'a subagent finishing is not the run waiting')
    for (const ev of Object.keys(j.hooks)) {
      wahr(Array.isArray(j.hooks[ev]) && Array.isArray(j.hooks[ev][0].hooks), `${ev} keeps claude's nested shape`)
    }
  })

  await pruefe('cursor: beforeSubmitPrompt reports work, stop reports the wait', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    const j = JSON.parse(HP.cursor.hookFiles({ flReport: '/bin/fl-report' })[0].content)
    gleich(j.hooks.beforeSubmitPrompt[0].command, '/bin/fl-report _working prompt', 'a typed follow-up starts a turn, as a prompt')
    gleich(j.hooks.stop[0].command, '/bin/fl-report _turn_end', 'and the stop hook stays the turn end')
  })

  await pruefe('hermes: the launch line consents to the hooks, the wrapper maps the events', async () => {
    const { HARNESS_PLUGINS: HP } = await import('../server/harnesses/index.mjs')
    wahr(HP.hermes.launch.args.includes('--accept-hooks'), 'the spec passes --accept-hooks')
    const start = readFileSync(new URL('../bin/fl-start', import.meta.url), 'utf8')
    enthaelt(start, 'chat -q "$FL_PROMPT" --yolo --accept-hooks', 'and so does the built-in case')
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
    gleich(run('pre_llm_call'), '', 'outside a run: nothing is said')
    const { existsSync: ex } = await import('node:fs')
    wahr(!ex(log), 'and fl-report is not called')
    run('pre_llm_call', { FL_RUN_ID: 'r1' })
    run('on_session_end', { FL_RUN_ID: 'r1' })
    run('post_llm_call', { FL_RUN_ID: 'r1' })
    gleich(readFileSync(log, 'utf8').trim().split('\n').join(','), '_working,_turn_end', 'pre_llm_call → _working, on_session_end → _turn_end, the rest ignored')
  })

  await pruefe('opencode: the installed plugin reads the ROOT session, not the subagents', () => {
    const setup = readFileSync(new URL('../setup/02-install-scripts.sh', import.meta.url), 'utf8')
    const plugin = setup.slice(setup.indexOf("cat > \"$HOME/.config/opencode/plugins/freilauf.js\""), setup.indexOf('# ---------------------------------------------------------------- hermes hooks'))
    enthaelt(plugin, "event?.type === 'session.status'", 'session.status is the source')
    enthaelt(plugin, 'client.session.get', 'the parent is asked of opencode')
    enthaelt(plugin, "parentID ?? null", 'and only a session without a parent counts')
    enthaelt(plugin, "'_working' : '_waiting'", 'busy → working, idle → waiting')
    falsch(plugin.includes("melden('_idle')"), 'the old per-session idle report is gone')
    enthaelt(plugin, "'session.error'", 'the error path stays')
    enthaelt(setup, 'fl-hermes-hook pre_llm_call', 'and hermes gets its hooks block')
  })

  await pruefe('fl-report accepts the two attention kinds', () => {
    const report = readFileSync(new URL('../bin/fl-report', import.meta.url), 'utf8')
    enthaelt(report, '_working|_waiting) ;;', 'in the kind list')
  })

  await pruefe('the status word exists in every language', async () => {
    for (const lang of ['en', 'de', 'zh']) {
      const cat = JSON.parse(readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), 'utf8'))
      wahr(!!cat['status.waiting_input'], `${lang}: status.waiting_input`)
      wahr(!!cat['run.agent_waiting'], `${lang}: run.agent_waiting`)
    }
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

  // ------------------------------------------------------------------
  gruppe('Sandbox: egress policy')
  {
    const { proxyPolicy, hostAllowed, hostVerdict, methodAllowed, deniedBody,
      deniedCidr, addressDenied, engineCapabilities, proxyEngine, splitHostPort,
      auditLine, DEFAULT_DENY_CIDRS } = await import('../server/sandbox/proxy.mjs')
    const { ironProxyConfig, proxyPlaceholder, mapIronLine } = await import('../server/sandbox/ironproxy.mjs')

    const pol = (network) => proxyPolicy({ network })

    await pruefe('hostAllowed: exact host, glob, deny beating allow, empty allow', () => {
      const p = pol({ mode: 'allowlist', allow: ['api.anthropic.com', '*.npmjs.org'], deny: ['evil.npmjs.org'] })
      const table = [
        ['api.anthropic.com', true, 'the exact host'],
        ['API.Anthropic.COM', true, 'and case does not decide it'],
        ['api.anthropic.com.evil.test', false, 'a suffix attack is not the host'],
        ['registry.npmjs.org', true, 'a glob covers the subdomain'],
        ['npmjs.org', false, '*.x deliberately does not cover the apex'],
        ['evil.npmjs.org', false, 'deny wins over the allow glob'],
        ['example.com', false, 'anything unnamed is denied — default deny'],
        ['', false, 'and so is nothing at all'],
      ]
      for (const [host, want, was] of table) gleich(hostAllowed(p, host), want, `${host || '<empty>'}: ${was}`)

      // An allowlist with nothing on it denies everything. That is not a fault,
      // it is what default-deny means — but the policy says so, so the 403 can.
      const leer = pol({ mode: 'allowlist', allow: [] })
      falsch(hostAllowed(leer, 'api.anthropic.com'), 'an empty allow list denies every host')
      wahr(leer.emptyAllow, 'and the policy carries the reason')
    })

    await pruefe('the three modes, and audit-only records the denial it lets through', () => {
      const offen = pol({ mode: 'open', allow: [] })
      wahr(hostAllowed(offen, 'anything.example'), 'open lets everything out')
      falsch(hostAllowed(pol({ mode: 'none', allow: ['*'] }), 'anything.example'), 'none lets nothing out')

      const audit = pol({ mode: 'allowlist', allow: ['api.anthropic.com'], auditOnly: true })
      const v = hostVerdict(audit, 'pypi.org')
      wahr(v.allowed, 'audit-only lets the request through')
      gleich(v.action, 'would_deny', 'and records what it WOULD have blocked')
      gleich(hostVerdict(audit, 'api.anthropic.com').action, 'allow', 'an allowed host stays a plain allow')
      // Deny is the operator carving a hole out of a preset; audit-only counts
      // it too, or the adopted allowlist would silently re-open it.
      gleich(hostVerdict(pol({ mode: 'allowlist', allow: ['*.npmjs.org'], deny: ['evil.npmjs.org'], auditOnly: true }),
        'evil.npmjs.org').action, 'would_deny', 'an audit-only deny is a near-miss, not an allow')
    })

    await pruefe('a policy that cannot be built refuses everything', () => {
      const kaputt = proxyPolicy({ network: { mode: 'allowlist', allow: ['*'], denyUpstreamCidrs: ['not-a-cidr'] } })
      wahr(!!kaputt.broken, 'the reason is kept')
      falsch(hostAllowed(kaputt, 'api.anthropic.com'), 'and the gate stays shut')
      enthaelt(deniedBody('api.anthropic.com', hostVerdict(kaputt, 'api.anthropic.com')), 'api.anthropic.com',
        'the refusal still names the host')
    })

    await pruefe('the upstream CIDR fence: an allowlisted name that resolves inward is refused', () => {
      const p = pol({ mode: 'allowlist', allow: ['*'] })
      const table = [
        ['169.254.169.254', true, 'the cloud metadata address (AWS, GCP, Azure)'],
        ['100.100.100.200', true, 'Alibaba metadata, inside the CGNAT block'],
        ['127.0.0.1', true, 'loopback — the hub itself'],
        ['10.1.2.3', true, 'RFC 1918'],
        ['172.16.0.1', true, 'RFC 1918, the middle block'],
        ['172.32.0.1', false, 'and 172.32 is NOT in it'],
        ['192.168.7.7', true, 'RFC 1918'],
        ['0.0.0.0', true, '"this host on this network"'],
        ['8.8.8.8', false, 'a public address goes through'],
        ['::1', true, 'IPv6 loopback'],
        ['fd00::1', true, 'IPv6 unique local'],
        ['fe80::1', true, 'IPv6 link-local'],
        ['2606:4700::1111', false, 'a public IPv6 address goes through'],
        ['::ffff:10.1.2.3', true, 'an IPv4-mapped address is unwrapped, not waved past'],
        ['nonsense', true, 'and what cannot be parsed counts as blocked'],
      ]
      for (const [ip, want, was] of table) gleich(addressDenied(p, ip), want, `${ip}: ${was}`)
      gleich(deniedCidr(p, '169.254.169.254'), '169.254.0.0/16', 'the refusal names the range')
      wahr(DEFAULT_DENY_CIDRS.includes('169.254.0.0/16'), 'the metadata range is in the default list')

      // Switching the fence off is possible and explicit — a test hub whose
      // stub upstream really is on loopback needs it.
      falsch(addressDenied(pol({ mode: 'allowlist', allow: ['*'], denyUpstreamCidrs: [] }), '127.0.0.1'),
        'an empty list is no fence')
    })

    await pruefe('the 403 body names the host AND the way out', () => {
      const p = pol({ mode: 'allowlist', allow: ['api.anthropic.com'] })
      const body = deniedBody('pypi.org', hostVerdict(p, 'pypi.org'))
      enthaelt(body, 'pypi.org', 'the host')
      enthaelt(body, 'fl-report access', 'the escalation path the agent reads in its tool output')
      enthaelt(body, 'Freilauf', 'and who is speaking')
      // The address case has to say WHICH range, or the operator cannot tell an
      // SSRF fence from a missing allowlist entry.
      const addr = deniedBody('internal.example', { action: 'deny', allowed: false, reason: 'address', rule: '10.0.0.0/8' },
        { ip: '10.1.2.3', cidr: '10.0.0.0/8' })
      enthaelt(addr, '10.1.2.3', 'the address it resolved to')
      enthaelt(addr, '10.0.0.0/8', 'and the range that refused it')
    })

    await pruefe('the engine says what it cannot do, so the form can grey it out', () => {
      gleich(proxyEngine('nonsense'), 'builtin', 'an unknown engine is the built-in, which always works')
      const b = engineCapabilities('builtin')
      falsch(b.tlsTerminate, 'the built-in tunnels, it does not terminate TLS')
      falsch(b.inject, 'so no credential can be injected')
      falsch(b.methods, 'and no method can be judged')
      const i = engineCapabilities('iron-proxy')
      wahr(i.tlsTerminate && i.inject && i.methods, 'iron-proxy can do all three')

      // A method list on the built-in is dropped and SAID so — a policy that
      // stored a rule nobody enforces is the "field that looks saved" failure.
      const p = pol({ mode: 'allowlist', allow: ['*'], methods: ['GET', 'HEAD'] })
      gleich(p.methods, null, 'the built-in keeps no method list')
      wahr(p.unsupported.includes('methods'), 'and names what it had to drop')
      wahr(methodAllowed(p, 'POST'), 'so every method passes there')
      const iron = pol({ mode: 'allowlist', engine: 'iron-proxy', allow: ['*'], methods: ['get', 'head'] })
      wahr(methodAllowed(iron, 'GET'), 'iron-proxy honours the list')
      falsch(methodAllowed(iron, 'POST'), 'and refuses what is not on it')

      // Credential injection needs TLS termination, so the built-in cannot do
      // it — and no credential enters that module at all. The combination is
      // named rather than quietly downgraded to the weaker mode.
      const geheim = proxyPolicy({ network: { mode: 'allowlist', allow: ['*'] } }, { secretsMode: 'inject' })
      wahr(geheim.unsupported.includes('secrets.inject'), 'the built-in says it cannot inject')
      falsch(proxyPolicy({ network: { mode: 'allowlist', engine: 'iron-proxy', allow: ['*'] } },
        { secretsMode: 'inject' }).unsupported.includes('secrets.inject'), 'iron-proxy can')
    })

    await pruefe('CONNECT targets and the audit line', () => {
      gleich(splitHostPort('api.anthropic.com:443').port, 443, 'host:port')
      gleich(splitHostPort('api.anthropic.com:443').host, 'api.anthropic.com', 'and the host without it')
      gleich(splitHostPort('[::1]:8443').host, '::1', 'an IPv6 literal keeps its colons')
      gleich(splitHostPort('[::1]:8443').port, 8443, 'and its port')
      gleich(splitHostPort('example.com', 80).port, 80, 'a missing port is the caller\'s default')

      const line = JSON.parse(auditLine({ host: 'api.anthropic.com', port: 443, method: 'CONNECT',
        action: 'allow', status: 200, durationMs: 12.6, run: 'r1' }))
      gleich(line.path, null, 'a CONNECT has no path — null, never an empty string')
      gleich(line.status_code, 200, 'the status')
      gleich(line.duration_ms, 13, 'the duration, rounded')
      gleich(line.run, 'r1', 'and the run it belongs to')
      falsch(JSON.stringify(line).toLowerCase().includes('authorization'),
        'no header ever enters the audit — a proxy log that carries one is a credential store')
    })

    await pruefe('the iron-proxy config, with and without secrets', () => {
      const spec = { network: { mode: 'allowlist', allow: ['api.anthropic.com', '*.npmjs.org'], deny: ['evil.npmjs.org'] } }
      const plain = ironProxyConfig(spec, {})
      enthaelt(plain, 'tunnel_listen', 'the tunnel listener the container points at')
      enthaelt(plain, 'name: "allowlist"', 'the allowlist transform')
      enthaelt(plain, '"api.anthropic.com"', 'and the resolved hosts, quoted')
      enthaelt(plain, '"*.npmjs.org"', 'a glob is quoted — bare `*` is a YAML alias')
      enthaelt(plain, 'deny_domains', 'the deny half')
      enthaelt(plain, 'api_key_env: IRON_MANAGEMENT_API_KEY', 'the management listener for POST /v1/reload')
      falsch(plain.includes('name: "secrets"'), 'and no secrets transform when nothing is injected')
      falsch(plain.includes('warn: true'), 'nor audit-only when it was not asked for')

      const audit = ironProxyConfig({ network: { ...spec.network, auditOnly: true } }, {})
      enthaelt(audit, 'warn: true', 'audit-only is iron-proxy\'s own warn mode')

      const platzhalter = proxyPlaceholder('OPENROUTER_API_KEY')
      wahr(platzhalter.startsWith('fl-token-'), 'a placeholder is recognisable as one')
      wahr(platzhalter.length > 20, 'and unguessable — it is worthless outside the proxy, which is the point')
      const injected = ironProxyConfig(spec, {
        secrets: [{ key: 'OPENROUTER_API_KEY', envVar: 'OPENROUTER_API_KEY', placeholder: platzhalter,
          header: 'Authorization', hosts: ['openrouter.ai'] }],
      })
      enthaelt(injected, 'name: "secrets"', 'the secrets transform')
      enthaelt(injected, 'type: env, var: "OPENROUTER_API_KEY"', 'the source is the variable, never the value')
      enthaelt(injected, platzhalter, 'the container sees the placeholder')
      enthaelt(injected, '{ host: "openrouter.ai" }', 'and the swap happens only for that host')

      const methoden = ironProxyConfig({ network: { ...spec.network, engine: 'iron-proxy', methods: ['GET'] } }, {})
      enthaelt(methoden, 'methods: ["GET"]', 'the engine that CAN judge a method gets the list')
    })

    await pruefe('an iron-proxy log line becomes the same audit line the built-in writes', () => {
      const allowed = JSON.parse(mapIronLine(JSON.stringify({
        host: 'api.anthropic.com', method: 'POST', path: '/v1/messages',
        action: 'allow', status_code: 200, duration_ms: 42,
      }), { runId: 'r1' }))
      gleich(allowed.engine, 'iron-proxy', 'the engine is named')
      gleich(allowed.action, 'allow', 'an allowed request')
      gleich(allowed.path, '/v1/messages', 'a terminated request HAS a path')
      const rejected = JSON.parse(mapIronLine(JSON.stringify({
        host: 'pypi.org', method: 'CONNECT', action: 'reject', status_code: 403, rejected_by: 'allowlist',
      })))
      gleich(rejected.action, 'deny', 'a rejection')
      gleich(rejected.rejected_by, 'allowlist', 'and what rejected it')
      gleich(mapIronLine('not json'), null, 'garbage is dropped, never thrown over')
    })

    await pruefe('every sandbox.proxy string exists in all three languages', () => {
      const keys = ['sandbox.proxy.denied', 'sandbox.proxy.reason_not_allowed', 'sandbox.proxy.reason_denied',
        'sandbox.proxy.reason_method', 'sandbox.proxy.reason_address', 'sandbox.proxy.reason_no_network',
        'sandbox.proxy.reason_policy_broken', 'sandbox.proxy.reason_dns', 'sandbox.proxy.engine_missing']
      for (const lang of ['en', 'de', 'zh']) {
        const cat = JSON.parse(readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), 'utf8'))
        for (const k of keys) wahr(!!cat[k], `${lang}: ${k}`)
      }
      // The escalation instruction is not a nicety of the English text: it is
      // the only way an agent learns what to do about a wall it just hit.
      for (const lang of ['en', 'de', 'zh']) {
        const cat = JSON.parse(readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), 'utf8'))
        enthaelt(cat['sandbox.proxy.denied'], 'fl-report access', `${lang}: the way out survives translation`)
        enthaelt(cat['sandbox.proxy.denied'], '{host}', `${lang}: and the host is named`)
      }
    })
  }

  // ------------------------------------------------------------------
  gruppe('Run report token')
  {
    // The per-run bearer of the report socket (SANDBOX_RESEARCH.md §7.6). Three
    // things are worth pinning: it exists for EVERY run without anybody asking
    // for it, the comparison cannot be tricked, and the socket's route list is a
    // list of two.
    const { default: rdb } = await import('../server/db.mjs')
    const { tokensMatch } = await import('../server/reports.mjs')
    const { socketRoute, bearerToken } = await import('../server/hub-socket.mjs')

    rdb.exec(`INSERT INTO repos(name, path, base_branch) VALUES('token-repo', '/tmp/token-repo', 'main')`)
    const tokenRepo = rdb.prepare('SELECT id FROM repos WHERE name=?').get('token-repo').id
    const neuerLauf = (id) => {
      rdb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes)
                   VALUES(?,?,'running','claude','p','keiner',5)`).run(id, tokenRepo)
      return rdb.prepare('SELECT report_token FROM runs WHERE id=?').get(id).report_token
    }

    await pruefe('every run is issued a token by the INSERT itself', () => {
      const a = neuerLauf('token-run-1')
      const b = neuerLauf('token-run-2')
      wahr(/^[0-9a-f]{64}$/.test(a), `64 hex characters — 32 bytes (${a})`)
      wahr(/^[0-9a-f]{64}$/.test(b), 'and so is the next run')
      falsch(a === b, 'and no two runs share one')
      // Nothing asked for it: the row went in with the columns any caller
      // writes, and the token was there afterwards. That is the whole point of
      // hanging it on the INSERT rather than on `createRun()`.
    })

    await pruefe('a token that was written by hand is left alone', () => {
      rdb.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, report_token)
                   VALUES('token-run-3',?,'running','claude','p','keiner',5,'deadbeef')`).run(tokenRepo)
      gleich(rdb.prepare('SELECT report_token FROM runs WHERE id=?').get('token-run-3').report_token, 'deadbeef',
        'the trigger only fills a NULL')
    })

    await pruefe('the comparison refuses everything that is not the token', () => {
      const good = 'a'.repeat(64)
      wahr(tokensMatch(good, good), 'the token itself')
      falsch(tokensMatch(good, 'b'.repeat(64)), 'a wrong token of the right length')
      // timingSafeEqual THROWS on differing lengths, so the guard in front of it
      // is what keeps a shorter guess from being an exception instead of a "no".
      falsch(tokensMatch(good, 'a'.repeat(63)), 'a token of the wrong length')
      falsch(tokensMatch(good, ''), 'the empty string')
      falsch(tokensMatch('', ''), 'and empty against empty is not a match either')
      falsch(tokensMatch(good, null), 'nor is a missing one')
      falsch(tokensMatch(null, good), 'nor a run that carries none')
    })

    await pruefe('the socket serves two routes and nothing else', () => {
      const id = '11111111-2222-3333-4444-555555555555'
      gleich(socketRoute('POST', `/api/runs/${id}/report`)?.name, 'report', 'the report route')
      gleich(socketRoute('POST', `/api/runs/${id}/report`)?.runId, id, 'and it names the run')
      gleich(socketRoute('GET', `/api/runs/${id}/sandbox`)?.name, 'sandbox', 'the sandbox route')
      // A third path is the failure this allowlist exists for: it would hand the
      // hub's own API back to the agent the socket was built to fence off.
      gleich(socketRoute('POST', `/api/runs/${id}/kill`), null, 'killing a run is not on this socket')
      gleich(socketRoute('POST', `/api/runs/${id}/send`), null, 'nor is typing into a session')
      gleich(socketRoute('POST', '/settings/save'), null, 'nor are the settings')
      gleich(socketRoute('GET', '/api/runs'), null, 'nor the run list')
      gleich(socketRoute('GET', `/api/runs/${id}/report`), null, 'and the method is part of the rule')
      gleich(socketRoute('POST', `/api/runs/${id}/report?x=1`)?.name, 'report', 'a query string is not part of the path')
      gleich(socketRoute('POST', '/api/runs/not-a-uuid/report'), null, 'and the id has to look like one')
    })

    await pruefe('the bearer is read from the Authorization header', () => {
      gleich(bearerToken({ headers: { authorization: 'Bearer abc' } }), 'abc', 'Bearer <token>')
      gleich(bearerToken({ headers: { authorization: 'bearer abc' } }), 'abc', 'and the case of the scheme does not decide it')
      gleich(bearerToken({ headers: { authorization: '  abc  ' } }), 'abc', 'a bare token is accepted too')
      gleich(bearerToken({ headers: {} }), '', 'no header, no token')
      gleich(bearerToken({}), '', 'and a request without headers is not an exception')
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: spec resolution')
  {
    const { DEFAULT_SPEC, SANDBOX_TRISTATE, HUB_MODES, normalizeSpec, narrow, resolveSandboxSpec,
      decideSandbox, validateSandboxOverrides, specPaths, pathLocked, parseSize } = await import('../server/sandbox/spec.mjs')
    const { hostGlobMatch, gitHostDomains, expandPresets, PACKAGE_REGISTRIES } = await import('../server/sandbox/presets.mjs')

    await pruefe('{} normalises to a complete spec, and nothing is mutated', () => {
      const s = normalizeSpec({})
      gleich(s.runtime, 'docker', 'runtime')
      gleich(s.network.mode, 'allowlist', 'network mode')
      gleich(s.network.methods, null, 'methods stay null, which means "every method"')
      gleich(s.resources.cpus, 4, 'cpus')
      gleich(s.secrets.mode, 'env', 'secrets mode')
      gleich(s.filesystem.tmpfsSizes['/tmp'], '2g', 'a tmpfs size')
      // Every consumer may read every field without asking whether it is there.
      for (const path of specPaths(DEFAULT_SPEC)) wahr(path.length > 0, path)
      const input = { network: { allow: ['a.example.com'] } }
      const out = normalizeSpec(input)
      gleich(out.network.allow.join(), 'a.example.com', 'the partial wins')
      gleich(DEFAULT_SPEC.network.allow.length, 0, 'DEFAULT_SPEC is untouched')
      gleich(JSON.stringify(input), '{"network":{"allow":["a.example.com"]}}', 'and so is the input')
      gleich(normalizeSpec({ network: { allow: ['x'] } }).network.deny.length, 0, 'the siblings are filled from the defaults')
    })

    await pruefe('the tri-state and the hub modes are the documented sets', () => {
      gleich(SANDBOX_TRISTATE.join(), 'inherit,on,off', 'tri-state')
      gleich(HUB_MODES.join(), 'off,available,default_on,required', 'hub modes')
    })

    // ---- the narrowing rule, shape by shape --------------------------
    await pruefe('a deny-shaped list may be appended to, never shortened', () => {
      gleich(narrow('network.deny', ['a'], ['a', 'b']).refused, false, 'append')
      gleich(narrow('network.deny', ['a'], ['a', 'b']).value.join(), 'a,b', 'and the appended list stands')
      gleich(narrow('network.deny', ['a', 'b'], ['a']).refused, true, 'dropping an entry is refused')
      gleich(narrow('network.deny', ['a', 'b'], ['a']).value.join(), 'a,b', 'and the higher value is kept')
      gleich(narrow('filesystem.protected', ['.git/config'], ['.git/config', '.git/hooks']).refused, false,
        'the protected paths are deny-shaped too')
    })

    await pruefe('an allow-shaped list may be shortened, never extended', () => {
      gleich(narrow('network.allow', ['a', 'b'], ['a']).refused, false, 'removal')
      gleich(narrow('network.allow', ['a'], ['a', 'b']).refused, true, 'adding a host is refused')
      gleich(narrow('network.allow', ['a'], ['a', 'b']).value.join(), 'a', 'the higher value is kept')
      gleich(narrow('network.presets', ['harness', 'provider'], ['harness']).refused, false, 'presets are allow-shaped')
      gleich(narrow('network.methods', null, ['GET']).refused, false, 'null means every method, so a list narrows it')
      gleich(narrow('network.methods', ['GET', 'HEAD'], null).refused, true, 'and back to null is a loosening')
    })

    await pruefe('a numeric limit may be lowered, never raised', () => {
      gleich(narrow('resources.memory', '8g', '4g').refused, false, 'memory down')
      gleich(narrow('resources.memory', '8g', '16g').refused, true, 'memory up is refused')
      gleich(narrow('resources.memory', '8g', '16g').value, '8g', 'and 8g stands')
      gleich(narrow('resources.cpus', 4, 2).refused, false, 'cpus down')
      gleich(narrow('resources.cpus', 4, 8).refused, true, 'cpus up is refused')
      gleich(narrow('resources.maxRuntimeMinutes', null, 60).refused, false, 'no limit → a limit narrows')
      gleich(narrow('resources.maxRuntimeMinutes', 60, null).refused, true, 'a limit → no limit does not')
      // '' is 0 and finite; a size that cannot be read must never become one.
      gleich(narrow('resources.memory', '8g', '').refused, true, 'an unreadable size is refused, not read as 0')
      gleich(parseSize('512m'), 512 * 1024 * 1024, 'parseSize')
      gleich(parseSize(''), null, 'and the empty string is not a size')
    })

    await pruefe('a mode may be tightened, never loosened', () => {
      gleich(narrow('network.mode', 'allowlist', 'none').refused, false, 'allowlist → none')
      gleich(narrow('network.mode', 'allowlist', 'open').refused, true, 'allowlist → open is refused')
      gleich(narrow('filesystem.extras', 'rw', 'ro').refused, false, 'rw → ro')
      gleich(narrow('filesystem.extras', 'ro', 'rw').refused, true, 'ro → rw is refused')
      gleich(narrow('secrets.mode', 'env', 'inject').refused, false, 'env → inject')
      gleich(narrow('secrets.mode', 'inject', 'env').refused, true, 'and never back')
      // §4.3: the harness's own sandbox needs the container opened up, so `off`
      // is the value that keeps the OUTER wall — the one the hub bets on.
      gleich(narrow('innerSandbox', 'weak', 'off').refused, false, 'weak → off narrows')
      gleich(narrow('innerSandbox', 'off', 'weak').refused, true, 'off → weak is refused')
      gleich(narrow('innerSandbox', 'weak', 'full').refused, true, 'and so is weak → full')
      gleich(narrow('network.mode', 'allowlist', 'nonsense').refused, true, 'an unknown value is not a narrowing')
    })

    await pruefe('auditOnly goes one way, and so do the flags next to it', () => {
      gleich(narrow('network.auditOnly', true, false).refused, false, 'audit-only may be switched off')
      gleich(narrow('network.auditOnly', false, true).refused, true, 'but never on')
      gleich(narrow('filesystem.readOnlyRoot', false, true).refused, false, 'a read-only root may be switched on')
      gleich(narrow('filesystem.readOnlyRoot', true, false).refused, true, 'and never off')
      gleich(narrow('audit.proxyLog', false, true).refused, false, 'more logging is stricter')
    })

    await pruefe('a path whose strictness this module cannot order does not change at all', () => {
      gleich(narrow('runtime', 'docker', 'podman').refused, true, 'the runtime is not a lower layer’s decision')
      gleich(narrow('user', 'hub', 'root').refused, true, 'and neither is the user')
      gleich(narrow('image.ref', 'a:1', 'b:2').refused, true, 'nor the image')
      gleich(narrow('network.mode', 'none', 'none').refused, false, 'the same value is never a refusal')
    })

    // ---- the layering ------------------------------------------------
    await pruefe('a lock reaches into a subtree, and an unlocked path is simply overwritten', () => {
      wahr(pathLocked('network.allow', ['network']), 'one word locks the subtree')
      falsch(pathLocked('networkfoo', ['network']), 'and not a path that merely starts with the letters')
      const r = resolveSandboxSpec({
        hub: { spec: { network: { mode: 'allowlist', deny: ['evil.example'] } }, lock: ['network'] },
        repo: { spec: { network: { deny: ['evil.example', 'worse.example'] }, mode: undefined }, },
        agentOrRun: { spec: { resources: { cpus: 2 } } },
      })
      gleich(r.refused.length, 0, 'nothing was refused')
      gleich(r.spec.network.deny.join(), 'evil.example,worse.example', 'the deny list grew')
      gleich(r.spec.resources.cpus, 2, 'and the unlocked cpus were simply overwritten')
    })

    await pruefe('a refusal names the path, the layer, what it wanted and what stands', () => {
      const r = resolveSandboxSpec({
        hub: { spec: { network: { mode: 'allowlist' }, resources: { memory: '8g' } }, lock: ['network.mode', 'resources.memory'] },
        repo: { spec: { network: { mode: 'open' }, resources: { memory: '4g' } } },
        agentOrRun: { spec: { resources: { memory: '16g' } } },
      })
      gleich(r.refused.length, 2, 'two attempts were refused')
      const mode = r.refused.find(x => x.path === 'network.mode')
      gleich(mode.by, 'repo', 'by')
      gleich(mode.wanted, 'open', 'wanted')
      gleich(mode.kept, 'allowlist', 'kept')
      gleich(r.spec.network.mode, 'allowlist', 'and the hub’s value really stands')
      const mem = r.refused.find(x => x.path === 'resources.memory')
      gleich(mem.by, 'run', 'the run wanted more memory')
      gleich(mem.kept, '4g', 'and what stands is what the repo had narrowed it to')
      gleich(r.spec.resources.memory, '4g', 'the narrowing of the layer above survived the refusal')
    })

    await pruefe('a repo may lock further for its agents', () => {
      const r = resolveSandboxSpec({
        hub: { spec: {}, lock: [] },
        repo: { spec: { resources: { cpus: 4 } }, lock: ['resources.cpus'] },
        agentOrRun: { spec: { resources: { cpus: 8 } } },
      })
      gleich(r.refused.length, 1, 'the agent’s raise was refused')
      gleich(r.refused[0].by, 'run', 'by the lock the repo added')
      gleich(r.spec.resources.cpus, 4, 'and four stand')
    })

    // ---- the tri-state resolution ------------------------------------
    await pruefe('hub mode "off" hides the feature, whatever a layer asks for', () => {
      for (const layer of [{}, { repo: 'on' }, { agent: 'on' }, { run: 'on' }]) {
        const d = decideSandbox({ hubMode: 'off', ...layer })
        gleich(d.sandbox, 0, 'nothing is sandboxed')
        gleich(d.reason, 'sandbox.problem.hub_off', 'and the reason says why')
      }
      gleich(decideSandbox({ hubMode: '' }).sandbox, 0, 'an unset mode is "off", not a surprise')
    })

    await pruefe('"available" sandboxes only what asks for it, and the nearest layer decides', () => {
      gleich(decideSandbox({ hubMode: 'available' }).sandbox, 0, 'nobody asked')
      gleich(decideSandbox({ hubMode: 'available', repo: 'on' }).sandbox, 1, 'the repo asked')
      gleich(decideSandbox({ hubMode: 'available', repo: 'on', agent: 'off' }).sandbox, 0, 'the agent is nearer')
      gleich(decideSandbox({ hubMode: 'available', repo: 'off', agent: 'off', run: 'on' }).sandbox, 1, 'and the run is nearest')
      gleich(decideSandbox({ hubMode: 'available', repo: 'on', agent: 'inherit' }).by, 'repo', 'inherit says nothing')
    })

    await pruefe('"default_on" plus an "off" is a bypass, and it is written down', () => {
      const d = decideSandbox({ hubMode: 'default_on' })
      gleich(d.sandbox, 1, 'by default it is on')
      const b = decideSandbox({ hubMode: 'default_on', agent: 'off' })
      gleich(b.sandbox, 0, 'the agent opted out')
      gleich(b.bypass.by, 'agent', 'and the bypass names it, so the run carries sandbox:bypassed')
      const r = decideSandbox({ hubMode: 'default_on', repo: 'on', run: 'off' })
      gleich(r.bypass.by, 'run', 'opting out of a repo that said "on" is a bypass too')
      const n = decideSandbox({ hubMode: 'available', run: 'off' })
      gleich(n.sandbox, 0, 'under "available" an "off" changes nothing')
      gleich(n.bypass, null, 'so it is not break-glass either')
    })

    await pruefe('"required" refuses an opt-out instead of quietly downgrading', () => {
      const d = decideSandbox({ hubMode: 'required', run: 'off' })
      gleich(d.sandbox, 1, 'the run is sandboxed anyway')
      gleich(d.refused.reason, 'sandbox.problem.required', 'and the form gets a problem')
      gleich(d.refused.layer, 'run', 'naming the layer that tried')
      gleich(decideSandbox({ hubMode: 'required' }).sandbox, 1, 'without an opt-out there is nothing to say')
    })

    await pruefe('an "off" is refused where bypassing is not allowed at all', () => {
      const d = decideSandbox({ hubMode: 'default_on', allowBypass: false, run: 'off' })
      gleich(d.sandbox, 1, 'the run stays sandboxed')
      gleich(d.refused.reason, 'sandbox.problem.bypass_not_allowed', 'and says so')
      const n = decideSandbox({ hubMode: 'available', allowBypass: false, run: 'off' })
      gleich(n.sandbox, 0, 'where nothing would have been sandboxed there is nothing to refuse')
      gleich(n.refused, null, 'and no noise about it')
    })

    await pruefe('a coding agent whose plugin declares no sandbox is a reason, or a refusal', () => {
      const d = decideSandbox({ hubMode: 'default_on', sandboxable: false })
      gleich(d.sandbox, 0, 'it simply runs as it always did')
      gleich(d.reason, 'sandbox.problem.harness_unsupported', 'with a reason a form can print')
      const r = decideSandbox({ hubMode: 'required', sandboxable: false })
      gleich(r.refused.reason, 'sandbox.problem.harness_unsupported', 'under "required" it is a refusal')
      gleich(r.refused.layer, 'harness', 'and the layer is the harness itself')
    })

    // ---- the overrides a human types ---------------------------------
    await pruefe('the overrides editor refuses what it does not understand', () => {
      gleich(validateSandboxOverrides('').problems.length, 0, 'an empty field is not a problem')
      gleich(validateSandboxOverrides('{}').problems.length, 0, 'and neither is an empty document')
      gleich(validateSandboxOverrides('{oops').problems[0].key, 'sandbox.problem.json', 'broken JSON')
      gleich(validateSandboxOverrides('[1,2]').problems[0].key, 'sandbox.problem.not_object', 'a list is not a profile')
      const unknown = validateSandboxOverrides('{"netwrok": {}}').problems
      gleich(unknown[0].key, 'sandbox.problem.unknown_key', 'a typo at the top level is named')
      gleich(unknown[0].params.key, 'netwrok', 'with the word that was typed')
      const nested = validateSandboxOverrides('{"network": {"allowed": ["x"]}}').problems
      gleich(nested[0].key, 'sandbox.problem.unknown_field', 'and one inside it too')
      gleich(nested[0].params.path, 'network.allowed', 'by its path')
      gleich(validateSandboxOverrides('{"network": {"allow": "github.com"}}').problems[0].key,
        'sandbox.problem.bad_type', 'a string where a list belongs')
      gleich(validateSandboxOverrides('{"network": {"mode": "offen"}}').problems[0].key,
        'sandbox.problem.bad_value', 'a mode that does not exist')
      gleich(validateSandboxOverrides('{"resources": {"memory": "lots"}}').problems[0].key,
        'sandbox.problem.bad_size', 'and a size that is not one')
    })

    await pruefe('a mount is judged against the roots the operator allowed', () => {
      const ok = validateSandboxOverrides('{"filesystem":{"extraMounts":[{"source":"/srv/data/fixtures","target":"/data","mode":"ro"}]}}',
        { allowedMountRoots: ['/srv/data'] })
      gleich(ok.problems.length, 0, 'inside a root it passes')
      const outside = validateSandboxOverrides('{"filesystem":{"extraMounts":[{"source":"/etc","target":"/etc-in"}]}}',
        { allowedMountRoots: ['/srv/data'] })
      gleich(outside.problems[0].key, 'sandbox.problem.mount_root', 'outside it does not')
      gleich(outside.problems[0].params.source, '/etc', 'and the source is named')
      const none = validateSandboxOverrides('{"filesystem":{"extraMounts":[{"source":"/srv/data","target":"/d"}]}}', {})
      gleich(none.problems[0].key, 'sandbox.problem.mount_none', 'with no roots configured nothing may be mounted')
      const up = validateSandboxOverrides('{"filesystem":{"extraMounts":[{"source":"/srv/data/../../etc","target":"/d"}]}}',
        { allowedMountRoots: ['/srv/data'] })
      gleich(up.problems[0].key, 'sandbox.problem.mount_traversal', '".." never travels')
      const shape = validateSandboxOverrides('{"filesystem":{"extraMounts":["/srv/data"]}}', { allowedMountRoots: ['/srv/data'] })
      gleich(shape.problems[0].key, 'sandbox.problem.mount_shape', 'and a mount needs both sides')
    })

    await pruefe('a locked path is judged with the same rule the resolver applies', () => {
      const against = normalizeSpec({ network: { mode: 'allowlist', allow: ['a', 'b'] } })
      const loosen = validateSandboxOverrides('{"network":{"mode":"open"}}', { lock: ['network'], against })
      gleich(loosen.problems[0].key, 'sandbox.problem.locked', 'the form warns before the launch refuses')
      gleich(loosen.problems[0].params.path, 'network.mode', 'naming the path')
      const narrower = validateSandboxOverrides('{"network":{"allow":["a"]}}', { lock: ['network'], against })
      gleich(narrower.problems.length, 0, 'a narrowing is not a problem')
      const blind = validateSandboxOverrides('{"network":{"mode":"open"}}', { lock: ['network'] })
      gleich(blind.problems.length, 0, 'and without the layer above there is nothing to narrow from')
    })

    // ---- presets ------------------------------------------------------
    await pruefe('a host pattern matches exactly what it says', () => {
      wahr(hostGlobMatch('*.npmjs.org', 'registry.npmjs.org'), 'a subdomain')
      wahr(hostGlobMatch('*.npmjs.org', 'a.b.npmjs.org'), 'at any depth')
      falsch(hostGlobMatch('*.npmjs.org', 'npmjs.org'), 'but not the bare domain')
      falsch(hostGlobMatch('*.npmjs.org', 'evilnpmjs.org'), 'and not a host that merely ends in it')
      wahr(hostGlobMatch('.npmjs.org', 'npmjs.org'), 'the leading dot includes the domain itself')
      wahr(hostGlobMatch('.npmjs.org', 'registry.npmjs.org'), 'and its subdomains')
      wahr(hostGlobMatch('github.com', 'github.com'), 'a bare domain matches itself')
      falsch(hostGlobMatch('github.com', 'evil.github.com'), 'and nothing under it — an allowlist is not looser than it reads')
      wahr(hostGlobMatch('github.com', 'GitHub.com:443'), 'the port and the case are not part of the name')
      wahr(hostGlobMatch('*', 'anything.example'), 'the one pattern that means open')
      falsch(hostGlobMatch('api.*.com', 'api.x.com'), 'a glob in the middle matches nothing')
      falsch(hostGlobMatch('', 'x.example'), 'and an empty pattern matches nothing at all')
    })

    await pruefe('the git host comes out of the remote, or not at all', () => {
      gleich(gitHostDomains('git@github.com:owner/repo.git')[0], 'github.com', 'the ssh short form')
      enthaelt(gitHostDomains('git@github.com:owner/repo.git').join(), 'codeload.github.com',
        'and the hosts a fetch really uses come with it')
      gleich(gitHostDomains('https://gitlab.com/owner/repo.git').join(), 'gitlab.com', 'the https form')
      gleich(gitHostDomains('ssh://git@git.example.org:2222/o/r.git').join(), 'git.example.org', 'a URL with a port')
      gleich(gitHostDomains('/srv/mirrors/repo.git').length, 0, 'a path is not a host')
      gleich(gitHostDomains('').length, 0, 'and neither is nothing')
      gleich(gitHostDomains('not a url at all').length, 0, 'a URL that cannot be read contributes nothing, never a guess')
    })

    await pruefe('presets expand from the plugins, and silence is an answer', () => {
      const withDomains = expandPresets(['harness', 'provider'], {
        harnessDomains: ['api.anthropic.com'], providerDomains: ['openrouter.ai'],
      })
      gleich(withDomains.join(), 'api.anthropic.com,openrouter.ai', 'both plugins contribute')
      // A plugin that declares no `sandbox.domains` contributes nothing, and
      // must never throw — the four built-ins gain the block one at a time.
      gleich(expandPresets(['harness'], { harness: 'no-such-harness' }).length, 0, 'an unknown harness is silence')
      gleich(expandPresets(['harness'], {}).length, 0, 'and so is no harness at all')
      gleich(expandPresets(['git-host'], { originUrl: 'not a url' }).length, 0, 'an unreadable origin is silence too')
      gleich(expandPresets(['nonsense'], {}).length, 0, 'an unknown preset contributes nothing')
      const reg = expandPresets(['package-registries'], {})
      gleich(reg.length, PACKAGE_REGISTRIES.length, 'the static list is the static list')
      enthaelt(reg.join(), 'registry.npmjs.org', 'npm')
      enthaelt(reg.join(), 'files.pythonhosted.org', 'python')
      enthaelt(reg.join(), 'proxy.golang.org', 'go')
      const twice = expandPresets(['package-registries', 'package-registries'], {})
      gleich(twice.length, reg.length, 'and a host is never listed twice')
    })

    // ---- profiles -----------------------------------------------------
    await pruefe('the four built-in profiles are seeded, and editing one writes a copy', async () => {
      const { listProfiles, getProfile, saveProfile, deleteProfile, seedBuiltinProfiles, BUILTIN_PROFILES } =
        await import('../server/sandbox/profiles.mjs')
      seedBuiltinProfiles()   // idempotent: the import already ran it once
      const names = listProfiles().filter(p => p.builtin).map(p => p.name).sort().join()
      gleich(names, 'Audit,Balanced,Locked down,Open network', 'the four of §7.13')
      gleich(listProfiles().filter(p => p.builtin).length, BUILTIN_PROFILES.length, 'seeding twice adds nothing')

      const balanced = listProfiles().find(p => p.name === 'Balanced')
      const saved = saveProfile({ id: balanced.id, name: 'Balanced', spec: { resources: { cpus: 2 } } })
      wahr(saved.copied, 'editing a built-in writes a copy')
      wahr(saved.id !== balanced.id, 'under an id of its own')
      gleich(getProfile(balanced.id).spec, JSON.stringify(BUILTIN_PROFILES[0].spec), 'the built-in is unchanged')
      gleich(getProfile(saved.id).builtin, 0, 'and the copy belongs to the operator')

      gleich(deleteProfile(balanced.id).ok, false, 'a built-in is not deleted — the next start would put it back')
      gleich(deleteProfile(balanced.id).problems[0].key, 'sandbox.problem.profile_builtin', 'and it says why')
      gleich(deleteProfile(saved.id).ok, true, 'the copy goes')
      gleich(getProfile(saved.id), null, 'and is gone')

      gleich(saveProfile({ name: '' }).problems[0].key, 'sandbox.problem.profile_name_missing', 'a profile needs a name')
      gleich(saveProfile({ name: 'x', spec: '{nope' }).problems[0].key, 'sandbox.problem.json', 'and a readable document')
      gleich(saveProfile({ id: 99999, name: 'x' }).problems[0].key, 'sandbox.problem.profile_unknown', 'an unknown id is an answer')
    })

    await pruefe('every problem and profile string exists in all three languages', async () => {
      const { BUILTIN_PROFILES } = await import('../server/sandbox/profiles.mjs')
      const source = [
        readFileSync(new URL('../server/sandbox/spec.mjs', import.meta.url), 'utf8'),
        readFileSync(new URL('../server/sandbox/profiles.mjs', import.meta.url), 'utf8'),
      ].join('\n')
      const used = [...new Set([...source.matchAll(/'(sandbox\.problem\.[a-z_]+)'/g)].map(m => m[1]))]
      wahr(used.length >= 15, `the module really names its keys (${used.length})`)
      for (const p of BUILTIN_PROFILES) used.push(p.titleKey, p.descKey)
      for (const lang of ['en', 'de', 'zh']) {
        const cat = JSON.parse(readFileSync(new URL(`../lang/${lang}.json`, import.meta.url), 'utf8'))
        for (const key of used) wahr(!!cat[key], `${lang}: ${key}`)
      }
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: clone and exec seams')

  // WHY a child process: `WORKTREES_DIR` and `RUNS_DIR` are module-level
  // constants of util.mjs, read at ITS import — which happened at the top of
  // this file. A test that creates real clones therefore cannot point them into
  // the sandbox from here; a process of its own can, and it is the only way this
  // group is guaranteed not to write into the operator's `~/agents/worktrees`.
  // (test/echt.mjs imports plugin files in their own process for the same kind
  // of reason.)
  const sandboxProbe = (() => {
    const work = join(sandkasten, 'sandbox-probe')
    mkdirSync(work, { recursive: true })
    const script = join(work, 'probe.mjs')
    writeFileSync(script, `
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, symlinkSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const serverDir = process.argv[2]
const work = process.argv[3]
const mod = (rel) => import(pathToFileURL(join(serverDir, rel)).href)
const clone = await mod('sandbox/clone.mjs')
const exec = await mod('sandbox/exec.mjs')
const dbmod = await mod('db.mjs')
const db = dbmod.default
const { WORKTREES_DIR } = await mod('util.mjs')

const out = {}
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const has = (dir, sha) => { try { git(dir, ['cat-file', '-e', sha]); return true } catch { return false } }
const revparse = (dir, ref) => { try { return git(dir, ['rev-parse', ref]) } catch { return null } }

// A real repository with a real bare origin — the clone's whole point is the
// refspecs and the alternate, and a stub would test neither.
const src = join(work, 'src'), origin = join(work, 'origin.git')
mkdirSync(src, { recursive: true })
execFileSync('git', ['init', '-q', '-b', 'main', src], { stdio: 'ignore' })
git(src, ['config', 'user.email', 'u@t']); git(src, ['config', 'user.name', 'U'])
writeFileSync(join(src, 'README.md'), 'hi\\n')
git(src, ['add', '-A']); git(src, ['commit', '-qm', 'init'])
execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' })
git(src, ['remote', 'add', 'origin', origin]); git(src, ['push', '-q', '-u', 'origin', 'main'])
out.srcHead = git(src, ['rev-parse', 'HEAD'])

const repoId = db.prepare('INSERT INTO repos (name, path, base_branch) VALUES (?,?,?)').run('probe', src, 'main').lastInsertRowid
const repo = dbmod.getRepo(repoId)
const mkRun = (id) => {
  db.prepare('INSERT INTO runs (id, repo_id, harness, prompt, branch_mode, expected_minutes) VALUES (?,?,?,?,?,?)')
    .run(id, repoId, 'claude', 'x', 'keiner', 30)
  return dbmod.getRun(id)
}

// ---- the clone itself
const id1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const made = await clone.makeSandboxClone(repo, mkRun(id1), {})
out.dir = made.dir
out.underRoot = made.dir.startsWith(WORKTREES_DIR)
out.baseSha = made.baseSha
out.alternates = readFileSync(join(made.dir, '.git/objects/info/alternates'), 'utf8').trim()
out.altTarget = join(src, '.git/objects')
out.countObjects = git(made.dir, ['count-objects', '-v'])
try { git(made.dir, ['fetch', 'origin']); out.fetchOrigin = true } catch (e) { out.fetchOrigin = String(e.message) }
out.originMain = revparse(made.dir, 'origin/main')
out.localMain = revparse(made.dir, 'refs/remotes/local/main')
out.kind = db.prepare('SELECT worktree_kind FROM runs WHERE id=?').get(id1).worktree_kind
out.isClone = clone.isClone(dbmod.getRun(id1))

// ---- collectRunTip is a no-op for a linked worktree
const wt = join(work, 'wt')
git(src, ['worktree', 'add', '--detach', wt, 'HEAD'])
const id2 = 'bbbbbbbb-0000-0000-0000-000000000002'
mkRun(id2)
db.prepare('UPDATE runs SET workdir_effective=? WHERE id=?').run(wt, id2)
out.worktreeKind = dbmod.getRun(id2).worktree_kind
out.worktreeTip = await clone.collectRunTip(dbmod.getRun(id2))
out.worktreeRevParse = git(wt, ['rev-parse', 'HEAD'])
out.worktreeRefMade = revparse(src, 'refs/freilauf/runs/' + id2)

// ---- collectRunTip on a clone makes a clone-only object reachable from the source
out.cloneIdentity = git(made.dir, ['config', '--get', 'user.email'])
writeFileSync(join(made.dir, 'agent.txt'), 'work\\n')
git(made.dir, ['add', '-A']); git(made.dir, ['commit', '-qm', 'agent commit'])
out.newSha = git(made.dir, ['rev-parse', 'HEAD'])
out.srcHadBefore = has(src, out.newSha)
db.prepare('UPDATE runs SET workdir_effective=? WHERE id=?').run(made.dir, id1)
out.cloneTip = await clone.collectRunTip(dbmod.getRun(id1))
out.srcHasAfter = has(src, out.newSha)
out.tipRef = revparse(src, 'refs/freilauf/runs/' + id1)

// ---- removeClone refuses a path outside the worktrees root
const outside = join(work, 'outside')
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'keep.txt'), 'x')
const refusal = await clone.removeClone({ id: 'cccccccc-0000-0000-0000-000000000003', repo_id: repoId, workdir_effective: outside })
out.refusal = { ok: refusal.ok, removed: refusal.removed, error: String(refusal.error ?? '') }
out.outsideKept = existsSync(join(outside, 'keep.txt'))
out.rootItself = clone.insideWorktreesRoot(WORKTREES_DIR)

// ---- …and removes a real one, twice
const gone = await clone.removeClone(dbmod.getRun(id1))
out.gone = { ok: gone.ok, removed: gone.removed }
out.dirGone = !existsSync(made.dir)
out.refAfter = revparse(src, 'refs/freilauf/runs/' + id1)
const again = await clone.removeClone(dbmod.getRun(id1))
out.twice = { ok: again.ok, removed: again.removed }

// ---- the two exec seams
out.hostHome = homedir()
out.homePlain = exec.agentHome(dbmod.getRun(id2))
out.homeSandboxed = exec.agentHome({ sandbox: 1, sandbox_home: '/x/run-home' })
out.homeSandboxedNoColumn = exec.agentHome({ sandbox: 1, sandbox_home: null })
out.homeNoRun = exec.agentHome(null)
out.sandboxHomeDir = exec.sandboxHomeDir('abc')

const g = await exec.runGit({ workdir_effective: src }, ['rev-parse', 'HEAD'])
out.runGit = { keys: Object.keys(g).sort().join(','), ok: g.ok, code: g.code, stdout: g.stdout.trim(), stderr: g.stderr }
const bad = await exec.runGit({ workdir_effective: src }, ['rev-parse', 'refs/heads/nope'])
out.runGitBad = { ok: bad.ok, code: bad.code, hasStderr: bad.stderr.length > 0 }
const sc = await exec.runShell({ workdir_effective: src }, ['git', 'rev-parse', 'HEAD'])
out.runShell = { ok: sc.ok, stdout: sc.stdout.trim() }

// Branch 3: a run that says it is sandboxed but whose container is not there —
// no runtime installed, no daemon, or simply a container that has ended. All
// three end in the hardened host call, and it answers the same thing.
const dead = { sandbox: 1, sandbox_container: 'fl-does-not-exist', workdir_effective: src }
const gone3 = await exec.runGit(dead, ['rev-parse', 'HEAD'])
out.runGitContainerGone = { ok: gone3.ok, stdout: gone3.stdout.trim() }
const refused3 = await exec.runGit(dead, ['rev-parse', 'HEAD'], { hostFallback: false })
out.runGitRefused = { ok: refused3.ok, hasStderr: refused3.stderr.length > 0, stdout: refused3.stdout }
// …and the hard off switch takes branch 1 whatever the row says.
process.env.FREILAUF_SANDBOX_OFF = '1'
const off = await exec.runGit(dead, ['rev-parse', 'HEAD'])
delete process.env.FREILAUF_SANDBOX_OFF
out.runGitSandboxOff = { ok: off.ok, stdout: off.stdout.trim() }

// ---- 11a.1: a config-key denylist is not a boundary, and the fallback must not pretend it is.
// The driver is named in .git/config but SELECTED by a tracked .gitattributes the
// agent commits, so no list of forbidden config keys can ever see it coming.
const hostile = join(work, 'hostile')
mkdirSync(hostile, { recursive: true })
execFileSync('git', ['init', '-q', '-b', 'main', hostile], { stdio: 'ignore' })
git(hostile, ['config', 'user.email', 'a@t']); git(hostile, ['config', 'user.name', 'A'])
writeFileSync(join(hostile, '.gitattributes'), '* filter=evil\\n')
writeFileSync(join(hostile, 'f.txt'), 'content\\n')
git(hostile, ['add', '-A']); git(hostile, ['commit', '-qm', 'init'])
const marker = join(work, 'PWNED_clean')
git(hostile, ['config', 'filter.evil.clean', 'touch ' + marker + '; cat'])
git(hostile, ['config', 'filter.evil.smudge', 'cat'])
writeFileSync(join(hostile, 'f.txt'), 'more\\n')
const fired = () => { const f = existsSync(marker); rmSync(marker, { force: true }); return f }

// The positive control: without this the rest of the test proves nothing.
try { git(hostile, ['--no-optional-locks', 'status', '--porcelain']) } catch { /* the filter is the subject, not the exit code */ }
out.filterFiresPlain = fired()

const deadClone = { sandbox: 1, sandbox_container: 'fl-does-not-exist', worktree_kind: 'clone', workdir_effective: hostile }
const refusedStatus = await exec.runGit(deadClone, ['--no-optional-locks', 'status', '--porcelain'])
out.statusRefused = { ok: refusedStatus.ok, unknown: refusedStatus.unknown === true, stdout: refusedStatus.stdout }
out.filterAfterRefusal = fired()

const inert = await exec.runGit(deadClone, ['rev-parse', 'HEAD'])
out.inert = { ok: inert.ok, len: inert.stdout.trim().length }
out.filterAfterInert = fired()

const cfgBefore = readFileSync(join(hostile, '.git/config'), 'utf8')
const masked = await exec.runGit(deadClone, ['add', '-A'], { hostFallback: 'masked' })
out.maskedAdd = { ok: masked.ok, stderr: masked.stderr }
out.filterAfterMasked = fired()
out.cfgRestored = readFileSync(join(hostile, '.git/config'), 'utf8') === cfgBefore
out.noBackupLeft = !existsSync(join(hostile, '.git/config.freilauf-unmasked'))
const maskedStatus = await exec.runGit(deadClone, ['--no-optional-locks', 'status', '--porcelain'], { hostFallback: 'masked' })
out.maskedStatus = { ok: maskedStatus.ok }
out.filterAfterMaskedStatus = fired()
// A shell command is refused outright on an agent-owned working copy.
const sh1 = await exec.runShell(deadClone, ['true'])
out.shellRefused = { ok: sh1.ok, unknown: sh1.unknown === true }

// ---- 11a.2: an EMPTY mask silently changes what a repository IS
const s256 = join(work, 's256')
execFileSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', s256], { stdio: 'ignore' })
git(s256, ['config', 'user.email', 'u@t']); git(s256, ['config', 'user.name', 'U'])
git(s256, ['remote', 'add', 'origin', 'https://user:t0ken@example.invalid/x.git'])
writeFileSync(join(s256, 'a.txt'), 'x\\n')
git(s256, ['add', '-A']); git(s256, ['commit', '-qm', 'init'])
out.realSha256 = git(s256, ['rev-parse', 'HEAD'])
const cfg256 = join(s256, '.git/config')
const orig256 = join(work, 's256-config-original')
cpSync(cfg256, orig256)
const lsRemote = (dir) => { try { return execFileSync('git', ['ls-remote', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\\t')[0] } catch { return 'error' } }
const logs = (dir) => { try { git(dir, ['log', '--oneline', '-1']); return 'ok' } catch { return 'broken' } }

writeFileSync(cfg256, '')
out.emptyMaskLog = logs(s256)
out.emptyMaskLsRemote = lsRemote(s256)

out.maskEntries = (await clone.maskedGitConfigEntries(orig256)).map(([k, v]) => k + '=' + v).join(',')
out.maskEntriesIdentity = (await clone.maskedGitConfigEntries(orig256, { keepIdentity: true })).map(([k]) => k).join(',')
await clone.writeMaskedGitConfig(orig256, cfg256)
out.maskedText = readFileSync(cfg256, 'utf8')
out.maskedLog = logs(s256)
out.maskedLsRemote = lsRemote(s256)
const s256clone = join(work, 's256-clone')
try { execFileSync('git', ['clone', '-q', s256, s256clone], { stdio: 'ignore' }); out.maskedFetch = git(s256clone, ['rev-parse', 'HEAD']) } catch (e) { out.maskedFetch = 'error' }
writeFileSync(cfg256, readFileSync(orig256, 'utf8'))

// ---- seedHomeFiles
const seedHome = join(work, 'seedhome')
mkdirSync(join(seedHome, '.cursor'), { recursive: true })
symlinkSync(join(outside, 'stolen.json'), join(seedHome, '.cursor', 'auth.json'))
const seeded = exec.seedHomeFiles({ sandbox: 1, sandbox_home: seedHome }, [
  { path: '.claude/settings.json', content: '{}' },
  { path: '.credentials.json', content: 'secret' },
  { path: '.cursor/auth.json', content: 'secret' },
  { path: '../escape.txt', content: 'no' },
  { path: '/etc/passwd', content: 'no' },
])
out.seedWritten = seeded.written.join(',')
out.seedRefused = seeded.refused.map(r => r.path + ':' + r.reason).join(',')
out.seedModeSettings = statSync(join(seedHome, '.claude/settings.json')).mode & 0o777
out.seedModeCredentials = statSync(join(seedHome, '.credentials.json')).mode & 0o777
out.stolen = existsSync(join(outside, 'stolen.json'))
out.escaped = existsSync(join(work, 'escape.txt'))

process.stdout.write(JSON.stringify(out))
`)
    const sub = join(work, 'sub')
    try {
      const r = execFileSync(process.execPath, [script, new URL('../server/', import.meta.url).pathname, work], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FREILAUF_DATA_DIR: join(sub, 'data'),
          FREILAUF_WORKTREES_DIR: join(sub, 'worktrees'),
          FREILAUF_RUNS_DIR: join(sub, 'runs'),
          FREILAUF_PLUGIN_DIR: join(sub, 'plugins'),
          FREILAUF_SKILLS_HOME: join(sub, 'skillhome'),
          FREILAUF_SKILLS_STATE: join(sub, 'skills-installed.json'),
          // Hermetic git: neither the operator's global config nor a system one
          // may reach these repositories — a `core.hooksPath` in either would
          // make this group depend on the machine it runs on.
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return JSON.parse(r)
    } catch (err) {
      return { __error: String(err.stderr ?? err.message ?? err).trim() || String(err) }
    }
  })()

  await pruefe('the probe process ran', () => {
    gleich(sandboxProbe.__error ?? '', '', 'the child that builds real repositories came back')
  })

  await pruefe('the clone stands where a worktree would, with the operator objects borrowed', () => {
    wahr(sandboxProbe.underRoot, `inside the worktrees root (${sandboxProbe.dir})`)
    gleich(sandboxProbe.baseSha, sandboxProbe.srcHead, 'checked out at origin/main')
    gleich(sandboxProbe.alternates, sandboxProbe.altTarget, 'alternates names the source object store')
    gleich(sandboxProbe.kind, 'clone', 'the run row says which kind of working copy it got')
    wahr(sandboxProbe.isClone, 'isClone() agrees')
    // A linked worktree inherits the committer identity from the shared config;
    // a clone does not, and an agent that cannot commit cannot deliver.
    gleich(sandboxProbe.cloneIdentity, 'u@t', "the committer identity travels, and nothing else of the operator's config")
  })

  await pruefe('the alternate really avoids copying objects, and origin still means origin', () => {
    // count-objects counts the LOCAL store only; the base commit is reachable
    // and yet nothing of it was copied — which is the entire economics of §7.4.2.
    enthaelt(sandboxProbe.countObjects, 'count: 0', 'no loose objects of its own')
    enthaelt(sandboxProbe.countObjects, 'in-pack: 0', 'and no pack of its own')
    enthaelt(sandboxProbe.countObjects, 'alternate: ', 'git itself reports the borrowed store')
    gleich(sandboxProbe.fetchOrigin, true, '`git fetch origin` works in the clone')
    gleich(sandboxProbe.originMain, sandboxProbe.srcHead, 'origin/main is what it is everywhere else')
    gleich(sandboxProbe.localMain, sandboxProbe.srcHead, "and the operator's local branches arrive under local/*")
  })

  await pruefe('collectRunTip is a no-op for a linked worktree', () => {
    gleich(sandboxProbe.worktreeKind, 'worktree', 'an ordinary run is unchanged')
    gleich(sandboxProbe.worktreeTip, sandboxProbe.worktreeRevParse, 'the same sha a plain rev-parse gives')
    gleich(sandboxProbe.worktreeRefMade, null, 'and nothing was fetched or parked anywhere')
  })

  await pruefe('collectRunTip makes a clone-only commit reachable from the source repo', () => {
    falsch(sandboxProbe.srcHadBefore, "the source cannot see the agent's commit while it is only in the clone")
    gleich(sandboxProbe.cloneTip, sandboxProbe.newSha, 'the collected tip is the clone HEAD')
    wahr(sandboxProbe.srcHasAfter, 'and the object is reachable from the source afterwards')
    gleich(sandboxProbe.tipRef, sandboxProbe.newSha, 'parked under refs/freilauf/runs/<id>')
  })

  await pruefe('removeClone refuses a path outside the worktrees root and is idempotent', () => {
    falsch(sandboxProbe.refusal.ok, 'a directory outside the root is refused')
    falsch(sandboxProbe.refusal.removed, 'and nothing was removed')
    wahr(sandboxProbe.refusal.error.length > 0, 'with a sentence saying so')
    wahr(sandboxProbe.outsideKept, 'the foreign directory is untouched')
    falsch(sandboxProbe.rootItself, 'the root itself is never a clone')
    wahr(sandboxProbe.gone.ok && sandboxProbe.gone.removed, 'a real clone goes')
    wahr(sandboxProbe.dirGone, 'the directory is gone')
    gleich(sandboxProbe.refAfter, null, 'and so is the ref in the operator repo')
    wahr(sandboxProbe.twice.ok, 'a second call is not an error')
  })

  await pruefe('agentHome answers the host home unless the run has one of its own', () => {
    gleich(sandboxProbe.homePlain, sandboxProbe.hostHome, 'an unsandboxed run: byte for byte what the hub does today')
    gleich(sandboxProbe.homeNoRun, sandboxProbe.hostHome, 'and so does no run at all')
    gleich(sandboxProbe.homeSandboxed, '/x/run-home', 'a sandboxed run: its own home')
    // runs.sandbox_home is documented as "NULL = the host home" — a sandboxed run
    // whose home was never recorded must read exactly as it did before.
    gleich(sandboxProbe.homeSandboxedNoColumn, sandboxProbe.hostHome, 'NULL means the host home')
    enthaelt(sandboxProbe.sandboxHomeDir, '/abc/home', 'the per-run home is <runs dir>/<id>/home')
  })

  await pruefe('runGit on an unsandboxed run is the plain git call, in sh() shape', () => {
    gleich(sandboxProbe.runGit.keys, 'code,ok,stderr,stdout', "sh()'s shape, so a caller can be rewired mechanically")
    wahr(sandboxProbe.runGit.ok, 'ok')
    gleich(sandboxProbe.runGit.code, 0, 'exit code')
    gleich(sandboxProbe.runGit.stdout, sandboxProbe.srcHead, 'the same answer as git -C')
    falsch(sandboxProbe.runGitBad.ok, 'a failure is a failure')
    wahr(sandboxProbe.runGitBad.hasStderr, 'and git got to say why')
    gleich(sandboxProbe.runShell.stdout, sandboxProbe.srcHead, 'runShell takes the same three branches')
  })

  await pruefe('a sandboxed run whose container is gone falls back to the hardened host call', () => {
    // The dirt of a dead run is a display fact, not a merge decision — so the
    // answer still comes, from the host, with the agent's hooks and fsmonitor
    // switched off. A caller for which host execution would be wrong says so.
    wahr(sandboxProbe.runGitContainerGone.ok, 'the fallback answers')
    gleich(sandboxProbe.runGitContainerGone.stdout, sandboxProbe.srcHead, 'and answers the same thing')
    falsch(sandboxProbe.runGitRefused.ok, 'hostFallback:false refuses instead')
    gleich(sandboxProbe.runGitRefused.stdout, '', 'and runs nothing')
    wahr(sandboxProbe.runGitRefused.hasStderr, 'with a reason')
    gleich(sandboxProbe.runGitSandboxOff.stdout, sandboxProbe.srcHead, 'FREILAUF_SANDBOX_OFF takes the plain path')
  })

  // §11a.1. The driver lives in .git/config and is SELECTED by a tracked
  // .gitattributes the agent commits — so no denylist of config keys can reach
  // it, and the fallback that claimed to be hardened by one was not.
  await pruefe('a tracked .gitattributes filter does not execute through the fallback', () => {
    wahr(sandboxProbe.filterFiresPlain, 'the positive control: a plain host git DOES run the filter')
    falsch(sandboxProbe.statusRefused.ok, 'status on a dead clone is refused, not run')
    wahr(sandboxProbe.statusRefused.unknown, "and says so with `unknown` — a failed status is not a CLEAN worktree")
    gleich(sandboxProbe.statusRefused.stdout, '', 'nothing was produced')
    falsch(sandboxProbe.filterAfterRefusal, 'and the filter never ran')
    wahr(sandboxProbe.inert.ok, 'rev-parse, measured inert, still answers')
    gleich(sandboxProbe.inert.len, 40, 'with a sha')
    falsch(sandboxProbe.filterAfterInert, 'and runs nothing')
    falsch(sandboxProbe.shellRefused.ok, 'an arbitrary command is refused outright')
  })

  await pruefe('the masked fallback runs the rescue path with nothing of the agent in force', () => {
    wahr(sandboxProbe.maskedAdd.ok, `add -A through the mask (${sandboxProbe.maskedAdd.stderr})`)
    falsch(sandboxProbe.filterAfterMasked, 'the filter did not run')
    wahr(sandboxProbe.maskedStatus.ok, 'and neither did status')
    falsch(sandboxProbe.filterAfterMaskedStatus, 'still nothing')
    wahr(sandboxProbe.cfgRestored, "the agent's own config is put back, byte for byte")
    wahr(sandboxProbe.noBackupLeft, 'and no backup is left lying next to it')
  })

  // §11a.2. An empty mask does not hide a repository's config, it changes what
  // the repository IS — and the ls-remote answer is the bad kind of wrong: exit
  // 0 with an all-zero sha, the same family as `--no-optional-locks` returning
  // an empty status.
  await pruefe('masking a config with an EMPTY file breaks a repository that carries extensions', () => {
    gleich(sandboxProbe.emptyMaskLog, 'broken', 'git log cannot read a sha256 repo through an empty mask')
    gleich(sandboxProbe.emptyMaskLsRemote, '0'.repeat(40), 'and ls-remote answers a zero sha, successfully')
  })

  await pruefe('the generated mask keeps the format and drops everything that can name a command', () => {
    enthaelt(sandboxProbe.maskEntries, 'core.repositoryformatversion=1', 'the format version travels')
    enthaelt(sandboxProbe.maskEntries, 'extensions.objectformat=sha256', 'and the whole extensions block')
    falsch(sandboxProbe.maskEntries.includes('remote.'), 'the remote URL, which may carry a token, does not')
    falsch(sandboxProbe.maskEntries.includes('user.'), 'nor the identity, unless it is asked for')
    enthaelt(sandboxProbe.maskEntriesIdentity, 'user.email', '…and it is, for the rescue commit')
    gleich(sandboxProbe.maskedLog, 'ok', 'the repository reads normally through the generated mask')
    gleich(sandboxProbe.maskedLsRemote, sandboxProbe.realSha256, 'and ls-remote answers the real sha')
    gleich(sandboxProbe.maskedFetch, sandboxProbe.realSha256, 'a clone through the mask lands on the same commit')
  })

  await pruefe('seedHomeFiles writes inside the home only, and never through a symlink', () => {
    gleich(sandboxProbe.seedWritten, '.claude/settings.json,.credentials.json', 'the two legitimate files')
    enthaelt(sandboxProbe.seedRefused, '.cursor/auth.json:symlink', 'a symlink where a credential goes is refused, not followed')
    enthaelt(sandboxProbe.seedRefused, '../escape.txt:outside_home', 'and so is a climb out')
    enthaelt(sandboxProbe.seedRefused, '/etc/passwd:absolute', 'and an absolute path')
    falsch(sandboxProbe.stolen, 'the symlink target was never created')
    falsch(sandboxProbe.escaped, 'nothing landed outside the home')
    gleich(sandboxProbe.seedModeCredentials, 0o600, 'anything that looks like a credential is 0600')
    gleich(sandboxProbe.seedModeSettings, 0o644, 'the rest is ordinary')
  })

  // ------------------------------------------------------------------
  // The command line of SANDBOX_RESEARCH.md §7.11 is the one place the whole
  // sandbox feature is verifiable on a machine with no container runtime:
  // buildRunArgv() is pure, so every flag that is there for a reason can be
  // held to that reason here. The verdict classifier is the second half — it
  // is tmuxVerdict()'s rule wearing Docker's error messages, and the tmux one
  // has an AGENTS.md entry about what it cost when "no answer" was read as
  // "gone".
  gruppe('Sandbox: runtime argv')

  const rt = await import('../server/sandbox/runtime.mjs')

  // ---- the two runtime seams: forbid a daemon, or force one ----------------
  //
  // Three checks in this file used to encode "this machine has no container
  // runtime" as a fact about the WORLD, and the day rootless Docker was
  // installed on the development host they went red — correctly, and for a
  // reason that had nothing to do with the code under test. A suite whose result
  // depends on the hardware is a suite nobody can trust.
  //
  // So the same pattern `FREILAUF_CLAUDE_CREDENTIALS` and `FREILAUF_CURSOR_AUTH`
  // already use: `FREILAUF_SANDBOX_DOCKER_HOST` pointed at a socket that does
  // not exist FORBIDS a runtime on a machine that has one, and
  // `FREILAUF_SANDBOX_RUNTIME_FORCE=1` next to a fake binary FORCES one on a
  // machine that has none. Both halves of every question below are therefore
  // asked wherever the suite runs.
  const rtSeamKeys = ['FREILAUF_SANDBOX_DOCKER_HOST', 'FREILAUF_SANDBOX_RUNTIME_FORCE',
    'FREILAUF_SANDBOX_RUNTIME_BIN']

  /**
   * A `docker` that is not one: it answers `info`, `inspect` and `ps` and knows
   * nothing else. The `info` document is this machine's real one, trimmed to the
   * fields the module reads — rootless, and `CPUSet: false` next to `true` for
   * memory/pids/cpu, which is what a delegated-but-not-fully-delegated host
   * really reports [measured 2026-09-05, docker 29.8.0 rootless].
   */
  function fakeDaemonBin() {
    const dir = mkdtempSync(join(tmpdir(), 'freilauf-daemon-'))
    const bin = join(dir, 'docker')
    const info = JSON.stringify({
      ServerVersion: '29.8.0',
      SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'],
      Runtimes: { 'io.containerd.runc.v2': {}, runc: {} },
      CgroupVersion: '2',
      MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsQuota: true, CPUSet: false,
    })
    writeFileSync(bin, [
      '#!/bin/sh',
      'case "$1" in',
      `  info) printf '%s\\n' '${info}' ;;`,
      "  inspect|image) echo 'Error: No such object: fl-nosuch' >&2; exit 1 ;;",
      "  ps) printf 'fl-a\\trunning\\tUp 3 minutes\\nfl-proxy-a\\trunning\\tUp 3 minutes\\n' ;;",
      // What `network inspect` really prints for a network created with
      // `gateway_mode_ipv4=isolated`: Go stringifying a zero netip.Addr.
      "  network) printf 'invalid IP\\n' ;;",
      // A build that FAILS, because the interesting half of buildImage() is how
      // it tells a broken Dockerfile from an absent daemon — and because a unit
      // suite must never run a real `docker build`.
      "  build) echo 'ERROR: failed to solve: process did not complete' >&2; exit 1 ;;",
      '  *) exit 0 ;;',
      'esac',
    ].join('\n') + '\n')
    chmodSync(bin, 0o755)
    return { dir, bin }
  }

  /**
   * Run `fn` with a runtime forbidden (`{ forbid: true }`) or forced
   * (`{ daemon: true }`), and put the environment back afterwards — including
   * the discovery cache, which is keyed on the endpoint as well as on the
   * binary but must not carry an answer between the two halves of one check.
   */
  async function mitRuntime({ forbid = false, daemon = false }, fn) {
    const vorher = Object.fromEntries(rtSeamKeys.map(k => [k, process.env[k]]))
    let fake = null
    try {
      for (const k of rtSeamKeys) delete process.env[k]
      if (forbid) process.env.FREILAUF_SANDBOX_DOCKER_HOST = join(sandkasten, 'no-such-docker.sock')
      if (daemon) {
        fake = fakeDaemonBin()
        process.env.FREILAUF_SANDBOX_RUNTIME_BIN = fake.bin
        process.env.FREILAUF_SANDBOX_RUNTIME_FORCE = '1'
      }
      rt._runtimeInfoCacheReset()
      return await fn()
    } finally {
      for (const k of rtSeamKeys) {
        if (vorher[k] === undefined) delete process.env[k]
        else process.env[k] = vorher[k]
      }
      rt._runtimeInfoCacheReset()
      if (fake) rmSync(fake.dir, { recursive: true, force: true })
    }
  }

  // argv, not a shell line: a flag and its value are two entries, and reading
  // them back that way is what asserts it — a joined string would pass either.
  const rtVal = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1] }
  const rtHas = (args, flag) => args.includes(flag)
  const rtCtx = (extra = {}) => ({
    runId: 'r1', hubId: 'hub1',
    workdir: '/w/run', homeDir: '/runs/r1/home', runDir: '/runs/r1',
    repoGitDir: '/repo/.git', emptyFile: '/runs/r1/empty', hubSocket: '/runs/r1/hub.sock',
    uid: 1000, gid: 1000, env: { FL_RUN_ID: 'r1' },
    image: 'freilauf/agent-claude', digest: 'sha256:abc',
    cmd: ['claude', 'hi'], caPath: '/ca/ca.crt', binPaths: ['/bin/fl-report'],
    term: 'screen-256color', ...extra,
  })

  await pruefe('the default line carries every flag §7.11 states a reason for', () => {
    const { bin, args } = rt.buildRunArgv({}, rtCtx())
    gleich(bin, 'docker', 'the docker CLI is the pane command')
    wahr(rtHas(args, '-it'), '-it: a TTY, so tmux sees the container’s own stream')
    wahr(rtHas(args, '--rm'), '--rm')
    wahr(rtHas(args, '--init'), '--init: a PID 1 that forwards SIGHUP, or the agent survives its pane')
    gleich(rtVal(args, '--name'), 'fl-r1', 'the name fl-kill and the reaper look for')
    wahr(args.includes('freilauf.run=r1'), 'the run label')
    wahr(args.includes('freilauf.hub=hub1'), 'the hub label the orphan reaper filters on')
    gleich(rtVal(args, '--detach-keys'), 'ctrl-^,ctrl-^', 'the one byte the CLI intercepts is moved off Ctrl-P')
    gleich(rtVal(args, '--stop-timeout'), '30', 'SIGTERM, 30 s, SIGKILL')
    gleich(rtVal(args, '--user'), '1000:1000', 'files stay owned by the hub user')
    wahr(args.includes('HOME=/runs/r1/home'), 'HOME is the per-run home')
    gleich(rtVal(args, '--cap-drop'), 'ALL', 'no capability an agent does not need')
    gleich(rtVal(args, '--security-opt'), 'no-new-privileges', 'no way back up through a setuid binary')
    wahr(rtHas(args, '--read-only'), 'a read-only root')
    gleich(rtVal(args, '--pids-limit'), '4096', 'the pid ceiling')
    gleich(rtVal(args, '--memory'), '8g', 'memory')
    gleich(rtVal(args, '--memory-swap'), '8g', 'and swap, or the limit is only a suggestion')
    gleich(rtVal(args, '--cpus'), '4', 'cpus')
    gleich(rtVal(args, '--shm-size'), '1g', 'shm, which is what Chromium runs out of')
    gleich(rtVal(args, '-w'), '/w/run', 'the working directory')
    gleich(args[args.length - 3], 'freilauf/agent-claude@sha256:abc', 'the image by digest')
    gleich(args.slice(-2).join(' '), 'claude hi', 'and the command last')
  })

  await pruefe('a known digest pins the image, an unknown one leaves the tag, no image refuses', () => {
    const bare = rt.buildRunArgv({}, rtCtx({ digest: null }))
    wahr(bare.args.includes('freilauf/agent-claude'), 'without a digest the tag stands alone')
    const short = rt.buildRunArgv({}, rtCtx({ digest: 'abc' }))
    wahr(short.args.includes('freilauf/agent-claude@sha256:abc'), 'a bare digest gets its algorithm')
    let err = null
    try { rt.buildRunArgv({}, rtCtx({ image: null })) } catch (e) { err = e }
    wahr(err, 'no image is a refusal')
    gleich(err.key, 'sandbox.runtime.err_no_image', 'and a readable one')
  })

  await pruefe('readOnlyRoot:false drops --read-only and keeps the tmpfs the profile asked for', () => {
    const { args } = rt.buildRunArgv({ filesystem: { readOnlyRoot: false } }, rtCtx())
    falsch(rtHas(args, '--read-only'), 'no read-only root')
    const tmpfs = args.filter((a, i) => args[i - 1] === '--tmpfs')
    wahr(tmpfs.some(x => x.startsWith('/tmp:')), '/tmp is still a tmpfs — the spec asked for it')
    wahr(tmpfs.some(x => x.startsWith('/runs/r1/home/.cache:')), '$HOME expands to the run’s home')
    falsch(tmpfs.some(x => x.startsWith('/run:')), '/run is what a read-only root needs, and there is none')
  })

  await pruefe('the tmpfs sizes come from the profile, and /tmp keeps exec', () => {
    const { args } = rt.buildRunArgv({ filesystem: { tmpfsSizes: { '/tmp': '512m' } } }, rtCtx())
    // `exec` is NAMED, and this assertion used to pin the opposite. Docker's
    // `--tmpfs` defaults to `noexec,nodev`, so leaving the word out was not the
    // same as allowing it: measured in a container started from this argv,
    // `chmod +x /tmp/x && /tmp/x` exited 126 and `/proc/mounts` said `noexec`.
    // The comment promised npm and pip could build out of /tmp; they could not.
    gleich(args.find(a => a.startsWith('/tmp:')), '/tmp:rw,exec,nosuid,size=512m',
      'nosuid, and exec spelled out — npm and pip build out of /tmp')
    wahr(args.includes('/run:rw,noexec,nosuid,size=64m'), '/run comes with the read-only root')
  })

  await pruefe('network open: the default bridge, and nothing about a proxy', () => {
    const { args } = rt.buildRunArgv({ network: { mode: 'open' } }, rtCtx())
    falsch(rtHas(args, '--network'), 'no --network: the default bridge IS open')
    falsch(args.some(a => a.startsWith('HTTPS_PROXY=')), 'no proxy variable')
    falsch(args.some(a => a.startsWith('SSL_CERT_FILE=')), 'and no CA to trust')
  })

  await pruefe('network none: no route at all, and still no proxy variable', () => {
    const { args } = rt.buildRunArgv({ network: { mode: 'none' } }, rtCtx())
    gleich(rtVal(args, '--network'), 'none', 'loopback only')
    falsch(args.some(a => a.startsWith('HTTP_PROXY=')),
      'a proxy that is not there would turn "no network" into a connection error')
  })

  await pruefe('network allowlist: the internal network, the proxy and the CA', () => {
    const { args } = rt.buildRunArgv({}, rtCtx())
    gleich(rtVal(args, '--network'), 'fl-net-r1', 'the per-run internal network')
    wahr(args.includes('HTTPS_PROXY=http://fl-proxy-r1:8080'), 'the proxy')
    wahr(args.includes('http_proxy=http://fl-proxy-r1:8080'), 'and its lowercase spelling, which half a toolchain reads')
    wahr(args.includes('NO_PROXY='), 'nothing is exempted, written out so an image cannot bake a hole')
    wahr(args.includes('NODE_EXTRA_CA_CERTS=/etc/freilauf/ca.crt'), 'the CA under every name a runtime looks for')
    wahr(args.includes('/ca/ca.crt:/etc/freilauf/ca.crt:ro'), 'and the CA is mounted read-only')
  })

  await pruefe('an empty resource produces no flag at all — Number(\'\') is a finite 0', () => {
    const { args } = rt.buildRunArgv({
      // `undefined` is deliberately NOT in here: that means "the profile did
      // not say", and normalizeSpec fills it with the default. An emptied form
      // field is the case this test is about.
      resources: { memory: '', memorySwap: null, cpus: '', pidsLimit: '', shmSize: '  ' },
    }, rtCtx())
    for (const flag of ['--memory', '--memory-swap', '--cpus', '--pids-limit', '--shm-size']) {
      falsch(rtHas(args, flag), `${flag} is absent, not empty and not zero`)
    }
    const filled = rt.buildRunArgv({ resources: { cpus: undefined } }, rtCtx())
    gleich(rtVal(filled.args, '--cpus'), '4', 'an omitted field is the default, not an absent flag')
  })

  await pruefe('a zero or negative numeric resource is dropped rather than passed on', () => {
    const { args } = rt.buildRunArgv({ resources: { cpus: 0, pidsLimit: -1 } }, rtCtx())
    falsch(rtHas(args, '--cpus'), '--cpus 0 is a container that cannot run')
    falsch(rtHas(args, '--pids-limit'), 'and a negative ceiling is not a ceiling')
  })

  await pruefe('podman swaps the binary, keeps the uid with --userns and drops --user', () => {
    const { bin, args } = rt.buildRunArgv({ runtime: 'podman' }, rtCtx())
    gleich(bin, 'podman', 'the podman CLI')
    wahr(rtHas(args, '--userns=keep-id'), 'podman’s own answer to the uid question')
    falsch(rtHas(args, '--user'), 'keep-id already maps it; both would fight')
  })

  await pruefe('runsc is docker plus one flag, because gVisor is a registered runtime', () => {
    const { bin, args } = rt.buildRunArgv({ runtime: 'runsc' }, rtCtx())
    gleich(bin, 'docker', 'still the docker CLI')
    gleich(args[1], '--runtime=runsc', 'and the runtime named right after run')
  })

  await pruefe('rootless hands no uid, so no --user is written', () => {
    const { args } = rt.buildRunArgv({}, rtCtx({ uid: null, gid: null }))
    falsch(rtHas(args, '--user'), 'container root IS the hub user under rootless Docker')
  })

  await pruefe('an unknown runtime is a readable refusal, never a wrong command line', () => {
    let err = null
    try { rt.buildRunArgv({ runtime: 'nosuch' }, rtCtx()) } catch (e) { err = e }
    wahr(err, 'it refuses')
    gleich(err.key, 'sandbox.runtime.reason_unknown', 'and says which id it did not know')
    let err2 = null
    try { rt.buildRunArgv({ runtime: 'srt' }, rtCtx()) } catch (e) { err2 = e }
    gleich(err2?.key, 'sandbox.runtime.reason_unsupported', 'a deferred runtime is told apart from a typo')
  })

  await pruefe('extra mounts are appended verbatim, with their mode', () => {
    const { args } = rt.buildRunArgv({
      filesystem: { extraMounts: [{ source: '/data/models', target: '/models', mode: 'ro' },
        { source: '/data/cache', target: '/cache', mode: 'rw' }] },
    }, rtCtx())
    wahr(args.includes('/data/models:/models:ro'), 'read-only stays read-only')
    wahr(args.includes('/data/cache:/cache'), 'and rw carries no suffix')
    wahr(args.indexOf('/data/cache:/cache') < args.indexOf('-w'), 'mounts come before the working directory')
  })

  await pruefe('a mount over one of the hub’s own is refused, one inside it is not', () => {
    const collide = (target) => {
      try { rt.buildRunArgv({ filesystem: { extraMounts: [{ source: '/x', target }] } }, rtCtx()); return null }
      catch (e) { return e.key }
    }
    gleich(collide('/runs/r1'), 'sandbox.runtime.err_mount_duplicate', 'the run directory is not up for grabs')
    gleich(collide('/runs'), 'sandbox.runtime.err_mount_collision', 'and neither is a mount sitting above it')
    gleich(collide('/w/run/node_modules'), null, 'a worktree extra INSIDE the workdir is the ordinary case')
  })

  await pruefe('the ctx mounts go through the same collision check', () => {
    let err = null
    try { rt.buildRunArgv({}, rtCtx({ mounts: [{ source: '/x', target: '/runs/r1/home' }] })) } catch (e) { err = e }
    gleich(err?.key, 'sandbox.runtime.err_mount_duplicate', 'losing the per-run home would be silent otherwise')
  })

  await pruefe('a relative path is refused on either side of a mount', () => {
    let err = null
    try { rt.buildRunArgv({ filesystem: { extraMounts: [{ source: 'data', target: '/data' }] } }, rtCtx()) } catch (e) { err = e }
    gleich(err?.key, 'sandbox.runtime.err_mount_path', 'docker would read it as a named volume instead')
  })

  await pruefe('environment values are two argv entries and are never shell-quoted', () => {
    const { args } = rt.buildRunArgv({}, rtCtx({ env: { A: 'one two', B: 'say "hi"', C: null } }))
    const i = args.indexOf('A=one two')
    wahr(i > 0, 'the value keeps its space')
    gleich(args[i - 1], '-e', 'and the flag is its own entry')
    wahr(args.includes('B=say "hi"'), 'quotes are data, not markup — nothing goes through a shell')
    falsch(args.some(a => a.startsWith('C=')), 'a null value is skipped')
    falsch(args.some((a, k) => a === '-e' && args[k + 1] === 'C'),
      'and never passed as a bare -e, which would take the HUB’s value')
  })

  await pruefe('an unusable variable name is refused rather than written', () => {
    let err = null
    try { rt.buildRunArgv({}, rtCtx({ env: { 'A=B': 'x' } })) } catch (e) { err = e }
    gleich(err?.key, 'sandbox.runtime.err_env_key', 'a name with an = in it would silently set something else')
  })

  await pruefe('retention:keep leaves the container standing for a post-mortem', () => {
    const { args } = rt.buildRunArgv({ retention: 'keep' }, rtCtx())
    falsch(rtHas(args, '--rm'), 'nothing to exec into if --rm took it away')
    wahr(rtHas(args, '--init'), 'the rest is unchanged')
  })

  await pruefe('the runtime binary can be swapped for the e2e shim', () => {
    const before = process.env.FREILAUF_SANDBOX_RUNTIME_BIN
    process.env.FREILAUF_SANDBOX_RUNTIME_BIN = '/tmp/fake-docker'
    try {
      gleich(rt.buildRunArgv({}, rtCtx()).bin, '/tmp/fake-docker', 'the pane command uses the shim too')
      gleich(rt.buildRunArgv({ runtime: 'podman' }, rtCtx()).bin, '/tmp/fake-docker', 'whatever the runtime says')
    } finally {
      if (before === undefined) delete process.env.FREILAUF_SANDBOX_RUNTIME_BIN
      else process.env.FREILAUF_SANDBOX_RUNTIME_BIN = before
      rt._runtimeInfoCacheReset()
    }
  })

  await pruefe('the shim replaces the binary and NOT the check on the runtime id', async () => {
    // A test fence may replace what the hub CALLS, never what it ACCEPTS. With
    // the two in the wrong order the shim answered for `nosuch` and an
    // operator's typo in sandbox_runtime came back "available".
    const before = process.env.FREILAUF_SANDBOX_RUNTIME_BIN
    process.env.FREILAUF_SANDBOX_RUNTIME_BIN = '/bin/true'
    try {
      rt._runtimeInfoCacheReset()
      gleich((await rt.runtimeInfo('nosuch')).reason, 'sandbox.reason.unknown_runtime', 'a typo is still a typo')
      gleich((await rt.runtimeInfo('srt')).reason, 'sandbox.reason.unsupported_runtime', 'and a deferred runtime still deferred')
      let err = null
      try { rt.buildRunArgv({ runtime: 'nosuch' }, rtCtx()) } catch (e) { err = e }
      gleich(err?.key, 'sandbox.runtime.reason_unknown', 'the builder refuses under a shim too')
      gleich(rt.buildRunArgv({}, rtCtx()).bin, '/bin/true', 'while a VALID id still goes through the shim')
    } finally {
      if (before === undefined) delete process.env.FREILAUF_SANDBOX_RUNTIME_BIN
      else process.env.FREILAUF_SANDBOX_RUNTIME_BIN = before
      rt._runtimeInfoCacheReset()
    }
  })

  await pruefe('force probes again; an ordinary caller joins the one in flight', async () => {
    // Counted by asking the fake binary how often it RAN, not by comparing
    // promises: runtimeInfo is `async`, so every call hands back a fresh
    // wrapper and identity can never hold — an assertion on it passes whatever
    // the sharing does. How often the daemon was asked is the thing that
    // matters and the thing that was wrong.
    const dir = mkdtempSync(join(tmpdir(), 'freilauf-rt-'))
    const log = join(dir, 'calls')
    const fake = join(dir, 'fake-docker')
    writeFileSync(fake, `#!/bin/sh\necho ran >> ${log}\nsleep 0.2\necho '{}'\n`)
    chmodSync(fake, 0o755)
    const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } }
    const before = process.env.FREILAUF_SANDBOX_RUNTIME_BIN
    process.env.FREILAUF_SANDBOX_RUNTIME_BIN = fake
    try {
      rt._runtimeInfoCacheReset()
      await Promise.all([rt.runtimeInfo('docker'), rt.runtimeInfo('docker')])
      gleich(calls(), 1, 'two ordinary callers ask the daemon once between them')
      await rt.runtimeInfo('docker')
      gleich(calls(), 1, 'and the cache answers the next one')

      // The bug: a caller that explicitly asked for a fresh answer was handed
      // the answer to a question asked before it — under load a probe several
      // seconds old, which is the "fails once in four" shape a suite learns to
      // ignore rather than to fix.
      rt._runtimeInfoCacheReset()
      const ordinary = rt.runtimeInfo('docker')
      const forced = rt.runtimeInfo('docker', { force: true })
      await Promise.all([ordinary, forced])
      gleich(calls(), 3, 'force never joins a probe somebody else started')
      await rt.runtimeInfo('docker', { force: true })
      gleich(calls(), 4, 'and it does not read the cache it just filled either')
    } finally {
      if (before === undefined) delete process.env.FREILAUF_SANDBOX_RUNTIME_BIN
      else process.env.FREILAUF_SANDBOX_RUNTIME_BIN = before
      rt._runtimeInfoCacheReset()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await pruefe('the proxy container exists only where there is a policy to enforce', () => {
    gleich(rt.buildProxyArgv({}, { runId: 'r1' }), null, 'the builtin engine lives in the hub process')
    gleich(rt.buildProxyArgv({ network: { mode: 'open', engine: 'iron-proxy' } }, { runId: 'r1' }), null,
      'and open egress has nothing to proxy')
    const p = rt.buildProxyArgv({ network: { engine: 'iron-proxy' } },
      { runId: 'r1', hubId: 'h', image: 'iron-proxy', digest: 'sha256:1', configPath: '/runs/r1/proxy.yaml' })
    gleich(rtVal(p.args, '--name'), 'fl-proxy-r1', 'the name the agent reaches it under')
    wahr(p.args.includes('--read-only'), 'the proxy is hardened like the agent')
    wahr(p.args.includes('/runs/r1/proxy.yaml:/etc/freilauf/proxy.yaml:ro'), 'and holds only its generated config')
  })

  // -- the verdict: "the daemon did not answer" is not "there are no containers"
  await pruefe('the verdict classifies stderr, never the exit code alone', () => {
    const v = (stderr, ok = false) => rt.runtimeVerdict({ ok, stderr, stdout: '' })
    gleich(v('', true), 'ok', 'a command that answered')
    gleich(v('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'),
      'no_daemon', 'the documented docker CLI sentence')
    gleich(v('Error: unable to connect to Podman socket'), 'no_daemon', 'podman’s wording')
    gleich(v('Error response from daemon: context deadline exceeded'), 'unreachable',
      'a busy daemon is not an absent one')
    gleich(v('request returned 500 Internal Server Error'), 'unreachable', 'nor is a broken one')
    gleich(v(''), 'unreachable', 'and a failure that said nothing says nothing')
    gleich(v('something no vendor has written yet'), 'unreachable',
      'the default is the safe answer: unknown means do nothing and ask again')
  })

  await pruefe('"no such container" is an ANSWER, not a failure to answer', () => {
    wahr(rt.notFound({ ok: false, stderr: 'Error: No such object: fl-r1' }), 'docker inspect')
    wahr(rt.notFound({ ok: false, stderr: 'Error response from daemon: No such container: fl-r1' }), 'docker stop')
    wahr(rt.notFound({ ok: false, stderr: 'Error response from daemon: network fl-net-r1 not found' }), 'network rm')
    falsch(rt.notFound({ ok: false, stderr: 'Cannot connect to the Docker daemon' }), 'a down daemon is not an empty one')
    falsch(rt.notFound({ ok: true, stdout: 'true' }), 'and a success is not a miss')
  })

  await pruefe('a runtime the daemon does not know is not available, however well it answered', async () => {
    // `runsc` is the same binary and the same socket as `docker` plus one flag,
    // so `docker info` succeeding said nothing about whether gVisor is
    // registered — and the list that answers it was in the object already
    // parsed. Without the check the settings page offers gVisor, the profile
    // reads as validated, and every run so configured dies in the pane with
    // `unknown or invalid runtime name: runsc` (exit 125) and no diagnosis.
    await mitRuntime({ daemon: true }, async () => {
      const ok = await rt.runtimeInfo('docker', { force: true })
      gleich(ok.available, true, 'the daemon itself is fine …')
      const gvisor = await rt.runtimeInfo('runsc', { force: true })
      gleich(gvisor.available, false, '… and runsc is still not available on it')
      gleich(gvisor.reason, 'sandbox.reason.runtime_not_registered', 'with the reason that says what to do')
      enthaelt(String(gvisor.message ?? ''), 'runc', 'naming what the daemon DOES know')
    })
  })

  await pruefe('a gateway that is not an address is no gateway', async () => {
    // [measured 2026-09-05, docker 29.8.0] a network created with
    // `gateway_mode_ipv4=isolated` has no Gateway key, and the template prints
    // `invalid IP`. The old `!== '<no value>'` filter handed `"invalid"` back as
    // an address, `builtinBind()`'s refusal never fired, and the built-in proxy
    // called `listen(port, 'invalid')` — the operator saw a DNS error instead of
    // the sentence this function exists to give them.
    await mitRuntime({ daemon: true }, async () => {
      const g = await rt.networkGateway('fl-net-x', { runtime: 'docker' })
      gleich(g.address, null, 'never the literal word "invalid"')
      gleich(g.ok, false, 'so the caller refuses instead of binding to it')
      wahr(String(g.reason ?? '').length > 0, 'and says why')
    })
  })

  await pruefe('a missing image and a taken name are ANSWERS, not "the daemon is having a moment"', () => {
    // Both are exit 125 with a daemon that answered perfectly well, and both
    // used to classify as `unreachable` — which reads as "wait and try again"
    // for two situations that will never get better on their own.
    const run = (stderr) => ({ ok: false, code: 125, stdout: '', stderr })
    wahr(rt.missingImage(run("Unable to find image 'freilauf/agent-claude:2.1.261' locally\n"
      + "docker: Error response from daemon: pull access denied for freilauf/agent-claude, "
      + "repository does not exist or may require 'docker login'")), 'the image was never built')
    falsch(rt.missingImage(run('Conflict. The container name "/fl-abc" is already in use by container "f8da"')),
      'and a name conflict is not a missing image')
    wahr(rt.nameConflict(run('docker: Error response from daemon: Conflict. The container name '
      + '"/fl-abc123" is already in use by container "f8da4c".')), 'the leftover of the last attempt')
    falsch(rt.missingImage({ ok: true, stderr: "Unable to find image 'x' locally" }),
      'the pull notice on a SUCCESSFUL run says nothing — a success is never a refusal')
  })

  await pruefe('docker stats is parsed into bytes and a percentage', () => {
    gleich(rt.parseStats('1.5GiB / 8GiB 12.34%').memBytes, Math.round(1.5 * 1024 ** 3), 'GiB')
    gleich(rt.parseStats('1.5GiB / 8GiB 12.34%').cpuPct, 12.34, 'the percentage')
    gleich(rt.parseStats('512MiB / 8GiB 0.00%').memBytes, 512 * 1024 ** 2, 'MiB')
    gleich(rt.parseStats(''), null, 'nothing said is null, not zero')
  })

  await pruefe('docker ps rows carry the run id in their name, not in a label template', () => {
    const rows = rt.parseOwned('fl-r1\trunning\tUp 3 minutes\nfl-proxy-r1\trunning\tUp 3 minutes\nfl-r2\texited\tExited (0) 1 hour ago\n')
    gleich(rows.length, 3, 'three rows')
    gleich(rows[0].runId, 'r1', 'the agent container')
    gleich(rows[0].kind, 'agent', 'and what it is')
    gleich(rows[1].kind, 'proxy', 'the proxy is told apart')
    gleich(rows[1].runId, 'r1', 'and belongs to the same run')
    falsch(rows[2].running, 'an exited container is not running')
  })

  await pruefe('runtimeInfo asks the SOCKET, and answers whether or not one is there', async () => {
    // A `docker` on the PATH is not a daemon. This installation sat for two
    // hours in exactly that state — the CLI installed, rootful `docker.service`
    // stopped and disabled, `/var/run/docker.sock` still there as a file that
    // answers EACCES, and the real daemon at `$XDG_RUNTIME_DIR/docker.sock`.
    await mitRuntime({ forbid: true }, async () => {
      const info = await rt.runtimeInfo('docker', { force: true })
      gleich(info.available, false, 'a socket that is not there is not a runtime')
      // Deterministic now, where the old check accepted any of three: a socket
      // the kernel refuses is an ANSWER, and `no_daemon` is the one that means
      // "there are no containers" rather than "I could not find out".
      gleich(info.reason, 'sandbox.reason.no_daemon', 'and it says WHICH answer it is')
      // A DOTTED key, never a bare word: the settings page prints an undotted
      // reason verbatim, so `no_binary` reached the operator as those nine
      // characters — on the one line they read while working out what to install.
      wahr(info.reason.startsWith('sandbox.reason.'), `a dotted reason key, got ${info.reason}`)
      gleich(info.id, 'docker', 'it still says what it was asked about')
      wahr(Array.isArray(info.runtimes), 'and answers with the shape a caller expects')
      enthaelt(String(info.message ?? ''), 'no-such-docker.sock', 'the message names the endpoint it tried')
    })
    await mitRuntime({ daemon: true }, async () => {
      const info = await rt.runtimeInfo('docker', { force: true })
      gleich(info.available, true, 'and a daemon that answers IS available')
      gleich(info.version, '29.8.0', 'with the version the settings page prints')
      // §7.7's uid table branches on this, and until rootless Docker was
      // installed here it had never once been `true` on a real answer: rootless
      // means container root IS the hub user, so NO `--user` is written.
      gleich(info.rootless, true, 'rootless, read off SecurityOptions')
      // What the host can really fence. Everything that is not `true` here is a
      // limit the settings page must not offer — `docker run` would refuse it.
      gleich(rt.cgroupSupports(info, 'memory'), true, '--memory is enforceable')
      gleich(rt.cgroupSupports(info, 'pids'), true, '…and --pids-limit')
      gleich(rt.cgroupSupports(info, 'cpus'), true, '…and --cpus')
      gleich(rt.cgroupSupports(info, 'cpuset'), false, 'but cpuset is not delegated on such a host')
    })
    const unknown = await rt.runtimeInfo('nosuch')
    gleich(unknown.available, false, 'an unknown runtime is not available either')
    gleich(unknown.reason, 'sandbox.reason.unknown_runtime', 'and it says why, without throwing')
  })

  await pruefe('a lifecycle call says whether anybody answered — with a daemon and without', async () => {
    // The old assertions accepted every value the two functions can return
    // (`['ok','no_daemon','unreachable']` IS the whole domain of
    // `runtimeVerdict`, and `typeof verdict === 'string'` is true for `''`), so
    // an implementation that invented an answer passed them both. Now the seam
    // decides which world the call is made in, and each world has its own
    // answer.
    await mitRuntime({ forbid: true }, async () => {
      // Two verdicts are legitimate here and the difference is the machine, not
      // the code: where a `docker` CLI exists it says so in words the classifier
      // knows (`no_daemon`), and where none exists at all the failure is ENOENT,
      // which is deliberately `unreachable` — a PATH that lost an entry is not
      // proof that Docker is gone. Neither may be acted on, which is the point.
      const state = await rt.containerState('fl-nosuch', { runtime: 'docker' })
      wahr(['no_daemon', 'unreachable'].includes(state.verdict),
        `nobody answered, so the verdict says so (got ${JSON.stringify(state.verdict)})`)
      gleich(state.exists, null, 'and "no answer" is null, never false')
      gleich(state.running, null, 'and so is "running" — nothing is claimed either way')
      const owned = await rt.listOwned('hub1', { runtime: 'docker' })
      gleich(owned.containers.length, 0, 'an empty list …')
      wahr(['no_daemon', 'unreachable'].includes(owned.verdict),
        `… which only means something together with the verdict, and here it says nobody answered (got ${JSON.stringify(owned.verdict)})`)
    })
    await mitRuntime({ daemon: true }, async () => {
      const state = await rt.containerState('fl-nosuch', { runtime: 'docker' })
      gleich(state.verdict, 'ok', 'a daemon that answered')
      gleich(state.exists, false, 'and "no such container" is FALSE — the empty truth, not a silence')
      const owned = await rt.listOwned('hub1', { runtime: 'docker' })
      gleich(owned.verdict, 'ok', 'the listing answered too')
      gleich(owned.containers.length, 2, 'and an empty list would now mean something')
    })
  })

  // The i18n group above compares the three catalogs to EACH OTHER and never to
  // the code, so a key this module emits and nobody ever added passes a green
  // suite and fails only in front of an operator, as a raw dotted key on the
  // page. That is the one class of bug the suite structurally cannot catch, and
  // it happened twice in this module in one day — so the check is here, against
  // the source, and it also refuses a translation that is the English copied.
  await pruefe('every string this module emits exists in all three catalogs, really translated', () => {
    const source = readFileSync(new URL('../server/sandbox/runtime.mjs', import.meta.url), 'utf8')
    const keys = [...new Set([...source.matchAll(/'(sandbox\.[a-z_]+\.[a-z_]+)'/g)].map(m => m[1]))]
    wahr(keys.length >= 15, `the module names its own sentences (found ${keys.length})`)
    const cats = Object.fromEntries(['en', 'de', 'zh'].map(l =>
      [l, JSON.parse(readFileSync(new URL(`../lang/${l}.json`, import.meta.url), 'utf8'))]))
    for (const k of keys) {
      for (const lang of ['en', 'de', 'zh']) wahr(!!cats[lang][k], `${lang}: ${k} is missing`)
      falsch(cats.de[k] === cats.en[k], `de:${k} is the English copied`)
      falsch(cats.zh[k] === cats.en[k], `zh:${k} is the English copied`)
    }
  })

  // -- images (§7.10). Never built on this machine; what is checked is the argv
  //    and the refusals, and that the argv is the one the README hands a human.
  await pruefe('the build argv is the README\'s command, with absolute paths', () => {
    const recipe = { dockerfile: 'sandbox/images/claude.Dockerfile',
      args: { CLAUDE_VERSION: '2.1.261' }, tag: 'freilauf/agent-claude:2.1.261' }
    const { bin, args } = rt.buildImageArgv(recipe, { root: '/co' })
    gleich(bin, 'docker', 'the runtime binary')
    gleich(args.join(' '),
      'build -f /co/sandbox/images/claude.Dockerfile --build-arg CLAUDE_VERSION=2.1.261 '
      + '-t freilauf/agent-claude:2.1.261 /co/sandbox/images',
      'flag for flag the README\'s line — the hub must not build something else')
  })

  await pruefe('--pull is written for "always" only, and an empty build arg is dropped', () => {
    const recipe = { dockerfile: 'sandbox/images/base.Dockerfile', args: { UID: '1000', GID: '' }, tag: 'x:1' }
    wahr(rt.buildImageArgv(recipe, { root: '/co', pull: 'always' }).args.includes('--pull'), 'always pulls')
    falsch(rt.buildImageArgv(recipe, { root: '/co', pull: 'if-missing' }).args.includes('--pull'),
      'if-missing IS docker\'s default')
    falsch(rt.buildImageArgv(recipe, { root: '/co', pull: 'never' }).args.includes('--pull'),
      'and never cannot be enforced at build time anyway')
    const args = rt.buildImageArgv(recipe, { root: '/co' }).args
    wahr(args.includes('UID=1000'), 'a real build arg travels')
    falsch(args.some(a => a.startsWith('GID=')), 'an empty one would override the Dockerfile\'s own default with \'\'')
  })

  await pruefe('the image tag carries the operator\'s registry when there is one', () => {
    gleich(rt.taggedImage('claude', '2.1.261'), 'freilauf/agent-claude:2.1.261', 'the plain name')
    gleich(rt.taggedImage('claude', '2.1.261', 'reg.example.com/'), 'reg.example.com/freilauf/agent-claude:2.1.261',
      'and a trailing slash is not doubled')
  })

  await pruefe('the versions the images README names are the ones the plugins pin', async () => {
    // Two places state one version, so they are held equal here: an operator
    // building the README's command and a hub building its own must produce the
    // same image, or somebody debugs the wrong one.
    const readme = readFileSync(new URL('../sandbox/images/README.md', import.meta.url), 'utf8')
    const { getHarness } = await import('../server/harnesses/index.mjs')
    for (const id of ['claude', 'opencode', 'cursor', 'hermes']) {
      const decl = getHarness(id)?.sandbox?.image
      wahr(!!decl?.dockerfile, `${id}: the plugin declares a Dockerfile`)
      for (const [k, v] of Object.entries(decl.args ?? {})) {
        enthaelt(readme, `--build-arg ${k}=${v}`, `${id}: the README builds with ${k}=${v}`)
      }
    }
  })

  await pruefe('an image nobody ships is a readable refusal, not a throw', async () => {
    const r = await rt.buildImage('nope')
    gleich(r.ok, false, 'it refuses')
    gleich(r.reason, 'unknown_image', 'with a reason a caller can branch on')
    falsch(r.error.startsWith('sandbox.'), 'and a sentence, not a raw key')
    enthaelt(r.error, 'nope', 'that names the image')
  })

  await pruefe('a build without a runtime says so, and blames no Dockerfile for it', async () => {
    // Behind the seam, and not only for reproducibility: unconditional, this
    // line runs a REAL `docker build` on any machine that has a daemon — with
    // buildImage()'s own 30-minute timeout, from a unit suite.
    await mitRuntime({ forbid: true }, async () => {
      const r = await rt.buildImage('claude')
      gleich(r.ok, false, 'nothing was built')
      wahr(['no_daemon', 'unreachable'].includes(r.reason), `a runtime reason, got ${r.reason}`)
      falsch(r.reason === 'build_failed', 'a missing daemon is not a broken Dockerfile')
      falsch(r.error.startsWith('sandbox.'), 'the operator gets a sentence')
      enthaelt(r.error, 'freilauf/agent-claude', 'naming the image it was about')
    })
    // …and with a daemon that answered, the same failure IS about the build —
    // which is the distinction the check is named after, and it could not be
    // made at all on a machine with no runtime.
    await mitRuntime({ daemon: true }, async () => {
      const r = await rt.buildImage('claude')
      gleich(r.ok, false, 'the build failed')
      gleich(r.reason, 'build_failed', 'and this time the Dockerfile really is the suspect')
      gleich(r.verdict, 'ok', 'the daemon answered, so nothing is retried against it')
      enthaelt(r.error, 'freilauf/agent-claude', 'naming the image it was about')
    })
  })

  await pruefe('the digest answers with both halves, and null where it cannot', async () => {
    // "Where it cannot" is a SEAM here and not the state of the machine any
    // more: this development host now really has `freilauf/agent-claude:2.1.261`
    // built, so the unconditional version of this check was asserting that a
    // digest lookup fails where it in fact succeeds.
    await mitRuntime({ forbid: true }, async () => {
      const d = await rt.imageDigest('freilauf/agent-claude:2.1.261')
      gleich(d.ok, false, 'no runtime, no digest')
      gleich(d.digest, null, 'and null rather than a guess')
      falsch(String(d.error ?? '').startsWith('sandbox.'), 'the refusal is a sentence')
      falsch(String(d.error ?? '').includes('could not be built'), 'reading a digest is not building')
    })
    await mitRuntime({ daemon: true }, async () => {
      const d = await rt.imageDigest('freilauf/agent-nosuch:1')
      gleich(d.ok, false, 'an image the daemon does not hold is a refusal too …')
      gleich(d.reason, 'no_such_image', '… but a different one, because the daemon ANSWERED')
      gleich(d.verdict, 'ok', 'and the verdict says so, which is what a caller branches on')
      gleich(d.digest, null, 'still no guess')
    })
  })


  // ------------------------------------------------------------------
  gruppe('Sandbox: plugin declarations')

  {
    const { validateDescriptor } = await import('../server/plugins/manifest.mjs')
    const {
      registerPlugin: sbRegister, unregisterPlugin: sbUnregister,
      sandboxable, sandboxDecl, harnessesWithSandbox, getHarness, getProvider,
    } = await import('../server/plugins/registry.mjs')

    const BUILTINS = ['claude', 'opencode', 'hermes', 'cursor']
    const sbHarness = (over = {}) => ({
      kind: 'harness', label: 'Sandbox test agent', bin: 'sbbin', subscription: false, providers: [],
      logPatterns: [{ typ: 'rate_limit', re: /x/ }],
      modelArgs: () => [], effortOptions: () => [], usage: async () => null, pulseId: () => null, ...over,
    })
    const sbEingetragen = []
    const sbEintragen = (desc) => {
      const r = sbRegister(desc, { source: 'external' })
      if (r.ok) sbEingetragen.push(desc.id)
      return r
    }

    try {
      await pruefe('every built-in coding agent declares a sandbox block that validates', () => {
        for (const id of BUILTINS) {
          const plugin = getHarness(id)
          const sb = sandboxDecl(id)
          wahr(!!sb, `${id}: a declaration`)
          gleich(sb.supported, true, `${id}: supported`)
          wahr(Array.isArray(sb.domains) && sb.domains.length > 0, `${id}: names its own hosts`)
          // A host and nothing else: the proxy matches on the CONNECT host, so
          // a URL here would never match anything and would fail silently.
          for (const d of sb.domains) falsch(/:\/\/|\/|\s/.test(d), `${id}: ${d} is a bare host`)
          wahr(Array.isArray(sb.stateDirs) && sb.stateDirs.length > 0, `${id}: says what the hub reads back`)
          gleich(validateDescriptor(plugin, 'harness').ok, true, `${id}: the whole descriptor validates`)
        }
      })

      await pruefe('every model provider with an API declares its hosts and how its key is injected', () => {
        for (const id of ['openrouter', 'deepseek', 'opencode-zen']) {
          const plugin = getProvider(id)
          const sb = plugin.sandbox
          wahr(!!sb, `${id}: a declaration`)
          wahr(Array.isArray(sb.domains) && sb.domains.length > 0, `${id}: hosts`)
          const cred = (sb.credentials ?? [])[0]
          wahr(!!cred?.injection?.hosts?.length, `${id}: an injection with hosts`)
          // The hosts a key may be handed to must be hosts the run may reach —
          // otherwise the proxy would substitute a secret on a connection it
          // then refuses, which is a secret spent for nothing.
          for (const h of cred.injection.hosts) wahr(sb.domains.includes(h), `${id}: ${h} is in the allowlist`)
          gleich(validateDescriptor(plugin, 'provider').ok, true, `${id}: the whole descriptor validates`)
        }
      })

      await pruefe('sandboxable() is the declaration and nothing else', () => {
        for (const id of BUILTINS) wahr(sandboxable(id), `${id}: sandboxable`)
        gleich(harnessesWithSandbox().length >= BUILTINS.length, true, 'and they are the list the form asks for')
        wahr(sbEintragen(sbHarness({ id: 'unit-sb-none' })).ok, 'a plugin without the block registers')
        falsch(sandboxable('unit-sb-none'), 'and is simply not offered the sandbox')
        gleich(sandboxDecl('unit-sb-none'), null, 'it declares nothing')
        // Half a declaration is not a capability: `supported` must say so.
        wahr(sbEintragen(sbHarness({ id: 'unit-sb-half', sandbox: { domains: ['example.com'] } })).ok, 'registered')
        falsch(sandboxable('unit-sb-half'), 'a block without supported:true is not offered either')
        falsch(sandboxable('never-registered'), 'an unknown coding agent')
      })

      await pruefe('a malformed sandbox block is REFUSED, with a reason', () => {
        // Refused rather than ignored: a declaration nobody applies produces a
        // run that reaches a network it should not have, and says nothing.
        const refuse = (sandbox, wort) => {
          const r = validateDescriptor(sbHarness({ id: 'unit-sb-bad', sandbox }), 'harness')
          falsch(r.ok, `refused: ${wort}`)
          enthaelt(r.problems.join('; '), wort, `and names it: ${wort}`)
        }
        refuse('yes', 'must be an object')
        refuse({ supported: 'true' }, '"supported" must be a boolean')
        refuse({ supported: true, domains: 'example.com' }, '"domains" must be an array')
        refuse({ supported: true, domains: ['https://example.com/v1'] }, 'must be a bare host')
        refuse({ supported: true, env: { 'not a name': '1' } }, 'is not an environment variable name')
        refuse({ supported: true, env: { OK: 1 } }, 'must be a string')
        refuse({ supported: true, image: {} }, 'needs "ref" or "dockerfile"')
        refuse({ supported: true, stateDirs: ['/etc'] }, 'must be relative to the sandbox home')
        refuse({ supported: true, stateDirs: ['../../.claude'] }, 'must not contain ".."')
        refuse({ supported: true, seedHome: 'files' }, '"seedHome" must be a function')
        refuse({ supported: true, innerSandbox: { none: {} } }, 'innerSandbox level')
        // An injection with no hosts hands the real key to whatever the agent
        // connects to — the opposite of what the mode exists for.
        refuse({ supported: true, credentials: [{ key: 'k', injection: { header: 'Authorization' } }] },
          '"injection.hosts" must be a non-empty array')
        refuse({ supported: true, credentials: [{ key: 'k', injection: { header: '', hosts: ['a.example'] } }] },
          '"injection.header" must be a header name')
        // Whether a run can be picked back up is launch.resume's answer. Two
        // statements about one fact eventually disagree.
        refuse({ supported: true, resume: ['--resume', '{resume_id}'] }, '"resume" is not a sandbox field')
        // And the refusal really reaches the registry, not just the validator.
        falsch(sbRegister(sbHarness({ id: 'unit-sb-refused', sandbox: { supported: true, stateDirs: ['/etc'] } }),
          { source: 'external' }).ok, 'the registry refuses it too')
        gleich(sandboxDecl('unit-sb-refused'), null, 'and it is nowhere in the registry')
      })

      await pruefe('seedHome returns relative paths inside the home, for every built-in', async () => {
        const run = { id: 'aaaabbbb', workdir_effective: '/home/hub/agents/worktrees/demo/aaaabbbb' }
        // `inject` on purpose: it is the mode in which no credential file is
        // copied, so the suite never reads the operator's real tokens.
        const spec = { secrets: { mode: 'inject' }, innerSandbox: 'off' }
        for (const id of BUILTINS) {
          const seed = sandboxDecl(id).seedHome
          gleich(typeof seed, 'function', `${id}: declares one`)
          let files
          try {
            files = await seed({ home: '/home/hub/agents/runs/aaaabbbb/home', run, ctx: null, spec })
          } catch (err) {
            // The one documented throw: opencode refuses to seed a home without
            // the bridge, because such a run reports no API error at all. On a
            // machine that has never run setup/02 that is the right answer.
            gleich(id, 'opencode', `${id}: only opencode may refuse`)
            enthaelt(String(err.message), 'setup/02-install-scripts.sh', 'and it says how to fix it')
            continue
          }
          // An empty list is a legitimate answer: under `inject` no credential
          // file is copied at all, and cursor seeds nothing else.
          wahr(Array.isArray(files), `${id}: a list of files`)
          for (const f of files) {
            wahr(typeof f.path === 'string' && !!f.path, `${id}: every entry has a path`)
            falsch(f.path.startsWith('/'), `${id}: ${f.path} is not absolute`)
            falsch(f.path.startsWith('~'), `${id}: ${f.path} is not a home shorthand`)
            falsch(f.path.split('/').includes('..'), `${id}: ${f.path} does not climb out`)
            gleich(typeof f.content, 'string', `${id}: ${f.path} has string content`)
          }
        }
      })

      await pruefe('claude seeds the trust flag and the inner-sandbox decision', async () => {
        const seed = sandboxDecl('claude').seedHome
        const run = { id: 'x', workdir_effective: '/w/demo/x' }
        const aus = await seed({ run, spec: { innerSandbox: 'off' } })
        const claudeJson = JSON.parse(aus.find(f => f.path === '.claude.json').content)
        gleich(claudeJson.hasCompletedOnboarding, true, 'the onboarding is answered')
        gleich(claudeJson.projects['/w/demo/x'].hasTrustDialogAccepted, true,
          'and the trust dialog, for the directory this run works in')
        const off = JSON.parse(aus.find(f => f.path === '.claude/settings.json').content)
        gleich(off.sandbox.enabled, false, 'the inner sandbox is off by default')
        const weak = JSON.parse((await seed({ run, spec: { innerSandbox: 'weak' } }))
          .find(f => f.path === '.claude/settings.json').content)
        gleich(weak.sandbox.enabled, true, 'weak turns it on')
        gleich(weak.sandbox.enableWeakerNestedSandbox, true, 'with the vendor\'s own name for what it costs')
        falsch('full' in sandboxDecl('claude').innerSandbox,
          'and `full` is not declared — bwrap cannot do it inside an unprivileged container')
      })

      await pruefe('hermes forces terminal.backend: local over whatever the operator configured', async () => {
        // The container IS the boundary; hermes' docker backend would open a
        // second one per tool call. The operator's own file is never touched —
        // this is a copy in the per-run home.
        const seed = sandboxDecl('hermes').seedHome
        const aus = await seed({ spec: { secrets: { mode: 'inject' } } })
        const cfg = aus.find(f => f.path === '.hermes/config.yaml').content
        enthaelt(cfg, 'terminal:\n  backend: local', 'the backend is named')
        gleich((cfg.match(/^terminal\s*:/gm) ?? []).length, 1, 'exactly once — never twice, which would be two answers')
        falsch(/backend:\s*docker/.test(cfg), 'and the docker backend is gone')
      })

      await pruefe('cursor seeds its token under `env` and nothing at all under `inject`', async () => {
        // FREILAUF_CURSOR_AUTH is the same fence the e2e sandbox uses: without
        // it this check would read the operator's real Cursor token.
        const fake = join(sandkasten, 'cursor-auth.json')
        writeFileSync(fake, '{"accessToken":"unit-test-not-a-token"}\n')
        const alt = process.env.FREILAUF_CURSOR_AUTH
        process.env.FREILAUF_CURSOR_AUTH = fake
        try {
          const seed = sandboxDecl('cursor').seedHome
          const mit = await seed({ spec: { secrets: { mode: 'env' } } })
          gleich(mit.length, 1, 'the token file, and nothing else')
          gleich(mit[0].path, '.config/cursor/auth.json', 'where cursor looks for it')
          gleich(mit[0].mode, 0o600, 'and it is a credential')
          gleich((await seed({ spec: { secrets: { mode: 'inject' } } })).length, 0,
            'under injection no credential enters the container at all')
        } finally {
          if (alt === undefined) delete process.env.FREILAUF_CURSOR_AUTH
          else process.env.FREILAUF_CURSOR_AUTH = alt
        }
      })

      await pruefe('claude\'s OAuth token is storable, and the sandbox block only says how it travels', async () => {
        const { credentialSpec, credentialValue } = await import('../server/plugins/store.mjs')
        // The storage keys off the TOP-LEVEL declaration; a credential declared
        // only inside `sandbox` would render a field that looks saved and is
        // not — which is why it is declared in both places by one constant.
        const spec = credentialSpec(getHarness('claude'))
        const oauth = spec.find(c => c.key === 'oauth_token')
        wahr(!!oauth, 'the Plugins page can offer it')
        gleich(oauth.envKeys.join(','), 'CLAUDE_CODE_OAUTH_TOKEN', 'and it names the variable')
        // Optional on purpose: an ordinary run authenticates through the CLI's
        // own login, and a working installation must never read as unconfigured.
        falsch(oauth.required, 'it is optional')
        const inj = sandboxDecl('claude').credentials.find(c => c.key === 'oauth_token')
        gleich(inj.key, oauth.key, 'the sandbox block refers to the same key')
        gleich(inj.envKeys.join(','), oauth.envKeys.join(','), 'from the same single author')
        gleich(inj.injection.hosts.join(','), 'api.anthropic.com', 'and only Anthropic gets the real value')
        // Resolution is the ordinary path: no stored value and no variable set
        // is null, never a throw and never a guess.
        const alt = process.env.CLAUDE_CODE_OAUTH_TOKEN
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        try {
          gleich(credentialValue('claude', 'oauth_token', {}), null, 'nothing configured is null')
          gleich(credentialValue('claude', 'oauth_token', { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }), 'tok',
            'and the declared variable answers when it is set')
        } finally {
          if (alt !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = alt
        }
      })

      await pruefe('cursor switches its own sandbox off, and claude bypasses its permission prompts', () => {
        gleich(sandboxDecl('cursor').launchOverrides({ spec: {} }).sandbox, 'disabled',
          'nested bubblewrap fails; two boundaries are not stronger than one')
        const claude = sandboxDecl('claude').launchOverrides({ spec: {} })
        gleich(claude.mode, 'bypassPermissions',
          'the mode Anthropic itself prescribes for a container — and it refuses to run as root')
        // A repo's own .claude/settings.json can carry disableAllHooks:true and
        // silence every report the hub depends on; the source it lives in is
        // simply not loaded. Measured 2026-09-05 out of the shipped binary.
        gleich(claude.settingSources, 'user', 'and the project settings sources are not loaded')
        // `bypassPermissions` refuses to run as root unless claude recognises a
        // sandbox, and this variable is the whole predicate — single-authored
        // here so nothing sets it a second time in the shell.
        gleich(sandboxDecl('claude').env.IS_SANDBOX, '1', 'claude is told it is in a sandbox')
      })
    } finally {
      for (const id of sbEingetragen) sbUnregister(id)
    }
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: run definition')
  //
  // Whether a run happens in a container is a field of the run definition like
  // every other, so it has to be in every one of the places AGENTS.md's
  // `keep_on_branch` checklist names — and the two it must NOT be in. What this
  // group pins is that list, structurally rather than by example: the drift
  // run-def.mjs exists to prevent is a field that reaches three of the four
  // copies, and a test that only round-tripped one form would never see it.
  {
    const rdef = await import('../server/run-def.mjs')
    const { db: sdb, setSetting } = await import('../server/db.mjs')
    const { runEditAllowed: sbEditAllowed, editRun: sbEditRun } = await import('../server/run-edit.mjs')
    const quelle = readFileSync(new URL('../server/run-def.mjs', import.meta.url), 'utf8')

    const mitModus = async (modus, fn) => {
      setSetting('sandbox_mode', modus)
      try { return await fn() } finally { setSetting('sandbox_mode', '') }
    }
    const formular = (extra = {}) => ({
      harness: 'claude', prompt: 'do something', branch_mode: 'keiner', ...extra,
    })

    await pruefe('the tri-state survives form → definition → agent row → definition', async () => {
      sdb.exec(`DELETE FROM agents WHERE name LIKE 'sb-agent-%'`)
      sdb.exec(`DELETE FROM repos WHERE name='sb-repo'`)
      sdb.prepare(`INSERT INTO repos(name, path, base_branch) VALUES('sb-repo','/tmp/sb-repo','main')`).run()
      const repoId = sdb.prepare(`SELECT id FROM repos WHERE name='sb-repo'`).get().id
      await mitModus('available', async () => {
        for (const wert of ['inherit', 'on', 'off']) {
          const problems = []
          const def = await rdef.runDefFromForm(formular({ sandbox: wert, repo_id: repoId }), problems)
          gleich(problems.length, 0, `${wert}: no problems (${problems.join(', ')})`)
          gleich(def.sandbox, wert, `${wert}: read out of the form`)
          const id = rdef.saveAgent({ repoId, name: `sb-agent-${wert}`, def })
          const row = sdb.prepare('SELECT * FROM agents WHERE id=?').get(id)
          gleich(row.sandbox, wert, `${wert}: written to the agent row`)
          gleich(rdef.defFromAgent(row).sandbox, wert, `${wert}: and read back out of it`)
          // The UPDATE half, which is where a field is most often forgotten:
          // saving the same agent again must not lose what the INSERT stored.
          rdef.saveAgent({ id, repoId, name: `sb-agent-${wert}`, def: { ...def, sandbox: 'on' } })
          gleich(sdb.prepare('SELECT sandbox FROM agents WHERE id=?').get(id).sandbox, 'on', `${wert}: the UPDATE writes it too`)
        }
      })
    })

    await pruefe("'0', 'off' and absence each mean what they say, and none of them flips the value", async () => {
      await mitModus('available', async () => {
        // Absent: the block disables its inputs where the coding agent cannot be
        // sandboxed, and a disabled field sends nothing at all.
        const p1 = []
        gleich((await rdef.runDefFromForm(formular(), p1)).sandbox, 'inherit', 'absent means inherit')
        gleich(p1.length, 0, `and says nothing about it (${p1.join(', ')})`)
        // The word: the only reading that switches a sandbox off.
        const p2 = []
        gleich((await rdef.runDefFromForm(formular({ sandbox: 'off' }), p2)).sandbox, 'off', "'off' is off")
        gleich(p2.length, 0, `no problem (${p2.join(', ')})`)
        // The string '0' is truthy, and `b.x ? 1 : 0` would read it as ON. It is
        // not a tri-state at all, so it is a refusal — never a silent guess in
        // either direction.
        const p3 = []
        const d3 = await rdef.runDefFromForm(formular({ sandbox: '0' }), p3)
        gleich(p3.length, 1, `'0' is refused (${p3.join(', ')})`)
        gleich(d3.sandbox, 'inherit', "'0' becomes neither 'on' nor 'off'")
        const p4 = []
        gleich((await rdef.runDefFromForm(formular({ sandbox: '1' }), p4)).sandbox, 'inherit', "'1' is not 'on' either")
        gleich(p4.length, 1, `and says so (${p4.join(', ')})`)
        // The empty string is what a disabled <select> and an untouched field
        // both look like; it must be silence, not a complaint.
        const p5 = []
        gleich((await rdef.runDefFromForm(formular({ sandbox: '' }), p5)).sandbox, 'inherit', "'' means inherit")
        gleich(p5.length, 0, 'and is not a problem')
      })
    })

    await pruefe('a broken overrides document is a problem, never a 500', async () => {
      await mitModus('available', async () => {
        const p1 = []
        const d1 = await rdef.runDefFromForm(formular({ sandbox_overrides: '{network: none' }), p1)
        wahr(p1.length >= 1, `unparseable JSON is refused (${p1.join(', ')})`)
        gleich(d1.sandboxOverrides, '{}', 'and nothing is stored')
        const p2 = []
        await rdef.runDefFromForm(formular({ sandbox_overrides: '{"netwrok": {"mode": "none"}}' }), p2)
        wahr(p2.length >= 1, `a typo is refused rather than ignored (${p2.join(', ')})`)
        const p3 = []
        await rdef.runDefFromForm(formular({ sandbox_overrides: '{"network": {"mode": "nowhere"}}' }), p3)
        wahr(p3.length >= 1, `a value outside the set is refused (${p3.join(', ')})`)
        // And the ordinary case goes through, normalised to one JSON string.
        const p4 = []
        const d4 = await rdef.runDefFromForm(formular({ sandbox_overrides: '{"network": {"mode": "none"}}' }), p4)
        gleich(p4.length, 0, `a valid document (${p4.join(', ')})`)
        gleich(JSON.parse(d4.sandboxOverrides).network.mode, 'none', 'stored as it was meant')
        // An empty field is "nothing to say", not a document.
        gleich((await rdef.runDefFromForm(formular({ sandbox_overrides: '   ' }), [])).sandboxOverrides, '{}', 'blank is {}')
      })
    })

    await pruefe('the hub mode is the frame: `off` stores nothing, `required` refuses an opt-out', async () => {
      // `off` is what every installation without a container runtime has, and
      // there it must be exactly as if none of this existed.
      await mitModus('off', async () => {
        const p = []
        const def = await rdef.runDefFromForm(formular({ sandbox: 'on', sandbox_overrides: '{"network": {"mode": "none"}}' }), p)
        gleich(p.length, 0, `nothing is refused (${p.join(', ')})`)
        gleich(def.sandbox, 'inherit', 'and nothing is stored')
        gleich(def.sandboxOverrides, '{}', 'not even the overrides')
        gleich(rdef.sandboxFields({ harness: 'claude' }), '', 'the form block is not rendered at all')
      })
      await mitModus('required', async () => {
        const p = []
        await rdef.runDefFromForm(formular({ sandbox: 'off' }), p)
        gleich(p.length, 1, `opting out is refused (${p.join(', ')})`)
        // And the form does not offer what the endpoint would send back.
        const html = rdef.sandboxFields({ harness: 'claude' })
        falsch(html.includes('value="off"'), 'the select offers no `off` under `required`')
      })
    })

    await pruefe('the block names the harnesses that can be sandboxed, and DISABLES what it hides', async () => {
      await mitModus('available', async () => {
        const kann = rdef.sandboxFields({ harness: 'claude' }, { sandboxHarnesses: ['claude'] })
        enthaelt(kann, 'data-sandbox-harnesses="claude"', 'the plugins\' answer travels as an attribute')
        falsch(/<select name="sandbox"[^>]*disabled/.test(kann), 'a supported coding agent gets a live field')
        enthaelt(kann, 'name="sandbox_profile_id"', 'the profile select')
        enthaelt(kann, 'name="sandbox_overrides"', 'and the folded overrides editor')
        const kann_nicht = rdef.sandboxFields({ harness: 'claude' }, { sandboxHarnesses: [] })
        // Hidden is not enough: a field one cannot see must not still submit.
        wahr(/<select name="sandbox"[^>]*disabled/.test(kann_nicht), 'the tri-state is disabled, not merely hidden')
        wahr(/<textarea name="sandbox_overrides"[^>]*disabled/.test(kann_nicht), 'and so is the overrides editor')
        enthaelt(kann_nicht, 'data-sandbox-unsupported', 'and the block SAYS why rather than vanishing')
        falsch(kann_nicht.includes('data-sandbox-unsupported hidden'), 'the sentence is visible there')
      })
    })

    await pruefe('the field is in every list the checklist names — and in neither of the two it must not be', () => {
      // Structural, not by example: a future field added to three of the four
      // places is exactly the drift this module exists to prevent, and the only
      // way to catch it is to ask each place by name.
      const flowKeys = rdef.RUN_DEF_FLOW_FIELDS.map(f => f.key)
      wahr(flowKeys.includes('sandbox'), 'RUN_DEF_FLOW_FIELDS carries the tri-state')
      wahr(flowKeys.includes('sandboxOverrides'), 'and the overrides')
      const tri = rdef.RUN_DEF_FLOW_FIELDS.find(f => f.key === 'sandbox')
      gleich(JSON.stringify(tri.options), '["inherit","on","off"]', 'as the three words, not a checkbox')
      gleich(tri.default, 'inherit', 'defaulting to the value that changes nothing')
      // defFromFlowProps: the same reading, minus the ability to complain.
      const fromFlow = rdef.defFromFlowProps({ harness: 'claude', prompt: 'x', sandbox: 'on' })
      gleich(fromFlow.sandbox, 'on', 'a flow step reaches the definition')
      gleich(rdef.defFromFlowProps({ harness: 'claude', prompt: 'x', sandbox: 'ja' }).sandbox, 'inherit',
        'and junk becomes the value that changes nothing, never a guess')
      // It used to be dropped to '{}' "because a flow has nobody to tell", and
      // that was a silent step toward LESS protection — the one direction §7.3
      // forbids. It refuses instead, and the throw is what fails the step.
      let brachAb = false
      try { rdef.defFromFlowProps({ harness: 'claude', prompt: 'x', sandboxOverrides: '{oops' }) }
      catch { brachAb = true }
      wahr(brachAb, 'a broken document there fails the step rather than quietly running unprotected')
      // defFromAgent and both halves of saveAgent, read off the source: an
      // UPDATE that forgot a column is the classic way a field half-lands.
      const insert = quelle.slice(quelle.indexOf('INSERT INTO agents('), quelle.indexOf('INSERT INTO agents(') + 900)
      const update = quelle.slice(quelle.indexOf('UPDATE agents SET'), quelle.indexOf('UPDATE agents SET') + 900)
      for (const spalte of ['sandbox', 'sandbox_profile_id', 'sandbox_overrides']) {
        wahr(insert.includes(spalte), `saveAgent INSERT names ${spalte}`)
        wahr(update.includes(spalte), `saveAgent UPDATE names ${spalte}`)
      }
      // The setup half, so a favorite carries it — and setupToFormBody, so a
      // Quick Run through that favorite arrives with it.
      gleich(rdef.setupToFormBody({ harness: 'claude', sandbox: 'on' }).sandbox, 'on', 'setupToFormBody carries the tri-state')
      gleich(rdef.setupToFormBody({ harness: 'claude' }).sandbox, 'inherit', 'and an older favorite inherits')
      // The two it is deliberately NOT in. `pickQuickFields` lives in web.mjs
      // (the Quick-Run dialog takes the repo default and the favorite's word),
      // and `rememberRunChoice` remembers a setup, not a safety decision.
      const setup = quelle.slice(quelle.indexOf('function setupOf('), quelle.indexOf('function setupOf(') + 400)
      falsch(setup.includes('sandbox'), 'rememberRunChoice does not remember it')
    })

    await pruefe('runEditAllowed: the sandbox is editable exactly while the run has not started', async () => {
      for (const s of ['scheduled', 'deferred']) {
        wahr(sbEditAllowed({ status: s }).sandbox, `${s}: no session and no worktree yet`)
      }
      for (const s of ['running', 'waiting_help', 'done', 'failed', 'aborted']) {
        falsch(sbEditAllowed({ status: s }).sandbox, `${s}: the container is what it is`)
      }
      falsch(sbEditAllowed({ status: 'done', followup_since: '2026-01-01 00:00:00' }).sandbox,
        'a follow-up commission reopens the duration, never the sandbox')
      falsch(sbEditAllowed(null).sandbox, 'no run')

      // And the endpoint keeps the same rule: a running run refuses, a planned
      // one applies — including the '0' reading, which must mean OFF here.
      sdb.exec(`DELETE FROM runs WHERE id LIKE 'sb-run-%'`)
      const repoId = sdb.prepare(`SELECT id FROM repos WHERE name='sb-repo'`).get().id
      const anlegen = (id, status) => sdb.prepare(
        `INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes, title, sandbox)
         VALUES(?,?,?,'claude','x','keiner',45,'x',1)`).run(id, repoId, status)
      anlegen('sb-run-plan', 'scheduled')
      anlegen('sb-run-live', 'running')
      await mitModus('available', async () => {
        const p1 = []
        const r1 = await sbEditRun('sb-run-plan', { sandbox: '0' }, p1)
        gleich(p1.length, 0, `a planned run may leave the sandbox (${p1.join(', ')})`)
        gleich(r1.ok, true, 'applied')
        gleich(sdb.prepare('SELECT sandbox FROM runs WHERE id=?').get('sb-run-plan').sandbox, 0,
          "'0' means OFF — the one reading `sandbox ? 1 : 0` would get wrong")
        const p2 = []
        await sbEditRun('sb-run-live', { sandbox: '0' }, p2)
        gleich(p2.length, 1, `a running run refuses (${p2.join(', ')})`)
        const p3 = []
        await sbEditRun('sb-run-plan', { sandbox: 'vielleicht' }, p3)
        gleich(p3.length, 1, `and a word that is not a yes/no is refused (${p3.join(', ')})`)
      })
      await mitModus('required', async () => {
        const p = []
        await sbEditRun('sb-run-plan', { sandbox: '0' }, p)
        gleich(p.length, 1, `under "required" even a planned run may not leave (${p.join(', ')})`)
      })
    })

    await pruefe('every i18n key this block renders exists in all three catalogs', async () => {
      const { _catalogs } = await import('../server/i18n.mjs')
      const cats = _catalogs()
      // The literal ones out of the source, plus the two families that are
      // built by concatenation — a key assembled at runtime is exactly the kind
      // a catalog forgets, so it is spelled out here rather than scanned for.
      const keys = [
        ...new Set([...quelle.matchAll(/t\('(sandbox\.[a-z_.]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('_'))),
        ...['inherit', 'on', 'off'].map(s => `sandbox.field.tristate_${s}`),
        ...['on', 'off'].map(s => `sandbox.field.summary_${s}`),
      ]
      wahr(keys.length > 10, `the block really names its strings (${keys.length})`)
      for (const k of keys) {
        for (const code of ['en', 'de', 'zh']) wahr(!!cats[code][k], `${code}: ${k}`)
      }
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: lifecycle and verdicts')
  //
  // What this group pins is the half of the sandbox that decides whether
  // somebody's agent goes on living: the verdict rule, the orphan table, and the
  // two path seams every activity measurement now goes through.
  {
    const { containerVerdict, reconcileContainers, claudeProjectSlug, claudeTranskriptPfad,
      _resetDockerSilence } = await import('../server/watcher.mjs')
    const { agentHome } = await import('../server/sandbox/exec.mjs')
    const { collectRunTip, isClone } = await import('../server/sandbox/clone.mjs')
    const { homedir } = await import('node:os')

    const { setSetting: lcSetSetting } = await import('../server/db.mjs')
    // The pass deliberately asks NOTHING on a hub that neither has the sandbox
    // switched on nor ever ran a sandboxed run — a shell-out per watcher pass on
    // a machine with no runtime would count as silence and eventually alarm
    // about a feature nobody enabled. So a test of the pass has to say the
    // sandbox is available, which is also the state it is about.
    const mitRuntime = async (script, fn) => {
      const shim = join(sandkasten, `runtime-${Math.random().toString(36).slice(2)}.sh`)
      writeFileSync(shim, script)
      chmodSync(shim, 0o755)
      const alt = process.env.FREILAUF_SANDBOX_RUNTIME_BIN
      process.env.FREILAUF_SANDBOX_RUNTIME_BIN = shim
      lcSetSetting('sandbox_mode', 'available')
      _resetDockerSilence()
      try { return await fn() } finally {
        _resetDockerSilence()
        lcSetSetting('sandbox_mode', '')
        if (alt === undefined) delete process.env.FREILAUF_SANDBOX_RUNTIME_BIN
        else process.env.FREILAUF_SANDBOX_RUNTIME_BIN = alt
      }
    }

    // ---- the rule that protects live agents -------------------------------
    //
    // "docker did not answer" is not "there are no containers". This is
    // tmuxVerdict()'s lesson a second time, and the failure it prevents is the
    // expensive one: a daemon restart must not reap a single container or end a
    // single run.
    await pruefe('an unreachable runtime reaps NOTHING and ends NOTHING', async () => {
      await mitRuntime('#!/bin/sh\necho "error during connect: broken pipe" >&2\nexit 1\n', async () => {
        const r = await reconcileContainers()
        gleich(r.verdict, 'unreachable', 'the pass says it learned nothing')
        gleich(r.acted.length, 0, 'and did nothing at all — no stop, no remove, no event')
      })
    })

    await pruefe('a runtime that is demonstrably not there is silent, not an alarm', async () => {
      await mitRuntime('#!/bin/sh\necho "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2\nexit 1\n', async () => {
        const r = await reconcileContainers()
        gleich(r.verdict, 'no_daemon', 'a machine without Docker is the ordinary case')
        gleich(r.acted.length, 0, 'and nothing is reaped on the strength of it either')
      })
    })

    await pruefe('a hub that never sandboxed anything does not ask the daemon at all', async () => {
      const { existsSync: lcExists } = await import('node:fs')
      const { db: lcDb } = await import('../server/db.mjs')
      // The precondition IS the case under test: no mode, no sandboxed run.
      lcDb.exec(`DELETE FROM runs WHERE sandbox=1`)
      lcSetSetting('sandbox_mode', '')
      const shim = join(sandkasten, 'runtime-never.sh')
      writeFileSync(shim, '#!/bin/sh\necho "$@" >> "$0.log"\nexit 1\n')
      chmodSync(shim, 0o755)
      const alt = process.env.FREILAUF_SANDBOX_RUNTIME_BIN
      process.env.FREILAUF_SANDBOX_RUNTIME_BIN = shim
      try {
        const r = await reconcileContainers()
        gleich(r.verdict, 'not_in_use', 'the sandbox is off and no run ever used it')
        falsch(lcExists(`${shim}.log`), 'and the runtime was never invoked — no subprocess per watcher pass')
      } finally {
        if (alt === undefined) delete process.env.FREILAUF_SANDBOX_RUNTIME_BIN
        else process.env.FREILAUF_SANDBOX_RUNTIME_BIN = alt
      }
    })

    // ---- the orphan table -------------------------------------------------
    await pruefe('the orphan classification, over run status × session × container', () => {
      const v = (o) => containerVerdict(o)
      gleich(v({ status: 'running', sessionOpen: true, running: true }), 'leave',
        'a working run in a live container is nobody’s business')
      gleich(v({ status: 'waiting_help', sessionOpen: true, running: true }), 'leave',
        'a run waiting for a human is still in flight')
      // §8.18, first case: the container went, the session stands — the agent died.
      gleich(v({ status: 'running', sessionOpen: true, running: false }), 'container_gone',
        'container gone under a live session = the agent died; pane_dead says so too')
      // §8.18, second case: the session went, the container stands — the client
      // died, or somebody hit the detach chord. The agent must not work on alone.
      gleich(v({ status: 'running', sessionOpen: false, running: true }), 'stop_orphan',
        'a container with no session left is stopped and the fact recorded')
      // A running container is NEVER reaped while its run is in flight — hermes'
      // orphan-reaper rule, and the one that keeps a working agent alive.
      for (const status of ['running', 'waiting_help', 'scheduled', 'deferred']) {
        gleich(v({ status, sessionOpen: true, running: true }), 'leave', `${status}: never reaped`)
      }
      gleich(v({ status: 'done', sessionOpen: true, running: true }), 'leave',
        'a finished run keeps its container while its session stands — a follow-up types into it')
      gleich(v({ status: 'done', sessionOpen: false, running: true }), 'reap',
        'session closed and the run over: stop and remove')
      gleich(v({ status: 'aborted', sessionOpen: false, running: false }), 'reap',
        'an exited container of a finished run is removed too')
      // retention: keep buys the retention clock, and only that.
      gleich(v({ status: 'done', sessionOpen: false, running: true, retention: 'keep' }), 'leave',
        'kept for a post-mortem through docker exec')
      gleich(v({ status: 'done', sessionOpen: false, running: true, retention: 'keep', overKeep: true }), 'reap',
        'a keep that never expired would be a container nothing on this machine ever removes')
      gleich(v({ status: null, sessionOpen: false, running: true }), 'reap',
        'nothing can be waiting on a run that is not in the database')
    })

    // ---- agentHome: today's paths, for all four harnesses ------------------
    await pruefe('agentHome() reproduces today’s paths exactly for an unsandboxed run', async () => {
      const { projectDirs } = await import('../server/cursor-transcript.mjs')
      const { storePath } = await import('../server/opencode-store.mjs')
      const home = homedir()
      const run = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', harness: 'claude',
        workdir_effective: '/srv/agents/worktrees/repo/ab12-detached' }
      gleich(agentHome(run), home, 'no sandbox, no move')
      // Corrected with the break-glass defect: the COLUMN decides, not the flag.
      // `continueWithoutSandbox()` clears `sandbox` and deliberately keeps
      // `sandbox_home` so the resumed CLI finds its conversation, and this
      // assertion used to encode exactly the behaviour that threw it away.
      gleich(agentHome({ ...run, sandbox: 0, sandbox_home: '/somewhere' }), '/somewhere',
        'a home recorded on a run keeps being its home after a break-glass restart')
      gleich(agentHome({ ...run, sandbox: 1, sandbox_home: null }), home,
        'and a run that never had one is the host home, exactly as before')
      gleich(agentHome({ ...run, sandbox: 1, sandbox_home: '/srv/agents/runs/x/home' }),
        '/srv/agents/runs/x/home', 'and a sandboxed run reads its own')

      // Each of the four compared against the literal string the code built
      // before the seam existed.
      gleich(claudeTranskriptPfad(run),
        `${home}/.claude/projects/-srv-agents-worktrees-repo-ab12-detached/${run.id}.jsonl`,
        'claude: <home>/.claude/projects/<slug>/<run id>.jsonl')
      gleich(projectDirs(run.workdir_effective)[0],
        `${home}/.cursor/projects/srv-agents-worktrees-repo-ab12-detached`,
        'cursor: <home>/.cursor/projects/<slug>')
      gleich(projectDirs(run.workdir_effective, '/srv/agents/runs/x/home')[0],
        '/srv/agents/runs/x/home/.cursor/projects/srv-agents-worktrees-repo-ab12-detached',
        'the same slug — it comes from the workdir, which does not move — under a per-run home')
      gleich(storePath(), `${home}/.local/share/opencode/opencode.db`,
        'opencode: <home>/.local/share/opencode/opencode.db')
      gleich(storePath({ sandbox: 1, sandbox_home: '/srv/agents/runs/x/home' }),
        '/srv/agents/runs/x/home/.local/share/opencode/opencode.db', 'and under a per-run home')
      gleich(join(agentHome(run), '.hermes/state.db'), `${home}/.hermes/state.db`,
        'hermes: <home>/.hermes/state.db — the literal measureActivity() opens')
    })

    await pruefe('the test fences still outrank the home', async () => {
      const { storePath } = await import('../server/opencode-store.mjs')
      const alt = process.env.FREILAUF_OPENCODE_DB
      process.env.FREILAUF_OPENCODE_DB = '/tmp/fixture.db'
      try {
        gleich(storePath({ sandbox: 1, sandbox_home: '/srv/agents/runs/x/home' }), '/tmp/fixture.db',
          'a suite that pointed the store at its own fixture must keep reading the fixture')
      } finally {
        if (alt === undefined) delete process.env.FREILAUF_OPENCODE_DB
        else process.env.FREILAUF_OPENCODE_DB = alt
      }
    })

    // ---- the slug bug -----------------------------------------------------
    //
    // claude replaces EVERY non-alphanumeric character, not just '/'. The old
    // rule found nothing for a path holding a dot, an underscore or a space, and
    // the run then read as idle while it worked (SANDBOX_RESEARCH.md §11a.4).
    await pruefe('the claude slug replaces every non-alphanumeric character, not only the slashes', () => {
      gleich(claudeProjectSlug('/home/x/agents/worktrees/my.repo/ab12-feat_x'),
        '-home-x-agents-worktrees-my-repo-ab12-feat-x',
        'dot, underscore and hyphen all become a hyphen — and nothing collapses')
      gleich(claudeProjectSlug('/srv/a b/c'), '-srv-a-b-c', 'a space too')
      gleich(claudeProjectSlug('/plain/path'), '-plain-path', 'the ordinary case is unchanged')
      const dotted = { id: 'ffffffff-1111-2222-3333-444444444444',
        workdir_effective: '/srv/worktrees/my.repo/ab12-detached' }
      wahr(claudeTranskriptPfad(dotted).includes('-srv-worktrees-my-repo-ab12-detached'),
        'and the transcript path is built from it')
    })

    // ---- a refused dirt read must never read as "clean" --------------------
    //
    // This is the assertion that matters. `dirtyFiles()` used to answer `[]` on
    // a failed git call, and `[]` at that call site means "clean", which means
    // "merge it". Through runGit() a sandboxed run on a clone whose container is
    // gone gets a REFUSAL — running `status` there would execute a
    // `filter.<n>.clean` driver a tracked `.gitattributes` selects — and a
    // refusal read as "clean" would merge a run whose uncommitted state nobody
    // looked at. The gate must HOLD instead.
    await pruefe('a dirt read nobody could answer holds the finish gate, it does not open it', async () => {
      const { runFinishCheck } = await import('../server/integrate.mjs')
      const { db: gdb } = await import('../server/db.mjs')
      const work = join(sandkasten, 'gate-clone')
      mkdirSync(work, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', work])
      gdb.exec(`DELETE FROM repos WHERE name='gate-repo'`)
      gdb.prepare(`INSERT INTO repos (name, path, base_branch, merge_mode) VALUES ('gate-repo', ?, 'main', 'hub')`)
        .run(work)
      const repoId = gdb.prepare(`SELECT id FROM repos WHERE name='gate-repo'`).get().id
      // A sandboxed run on a clone, with a container name no daemon will
      // confirm: runGit() then reaches its third branch and refuses `status`.
      const run = { id: '11111111-2222-3333-4444-555555555555', repo_id: repoId,
        harness: 'claude', workdir_effective: work, worktree: work,
        sandbox: 1, sandbox_container: 'fl-does-not-exist', worktree_kind: 'clone',
        finish_state: 'checking', base_sha: null, merged_sha: null }
      await mitRuntime('#!/bin/sh\necho "error during connect: broken pipe" >&2\nexit 1\n', async () => {
        const r = await runFinishCheck(run, { force: true })
        gleich(r.state, 'error', 'the gate says it could not tell — never "nothing" and never "merging"')
        falsch(['nothing', 'merging', 'awaiting_merge'].includes(r.state),
          'and above all it does not let the run through')
      })
      gdb.exec(`DELETE FROM repos WHERE name='gate-repo'`)
    })

    // ---- collectRunTip is a no-op for a linked worktree --------------------
    await pruefe('collectRunTip() is a plain rev-parse for a linked worktree', async () => {
      const repo = join(sandkasten, 'tip-repo')
      mkdirSync(repo, { recursive: true })
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
      execFileSync('git', ['init', '-q', '-b', 'main', repo])
      git('config', 'user.email', 'unit@localhost')
      git('config', 'user.name', 'Unit')
      writeFileSync(join(repo, 'a.txt'), 'one\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'one')
      const head = git('rev-parse', 'HEAD')
      const run = { id: 'cccccccc-dddd-eeee-ffff-000000000000', repo_id: null,
        workdir_effective: repo, worktree_kind: 'worktree' }
      falsch(isClone(run), 'a linked worktree is not a clone')
      gleich(await collectRunTip(run), head,
        'the same sha rev-parse HEAD gave — one function, and for a shared object store no difference')
      gleich(git('for-each-ref', '--format=%(refname)', 'refs/freilauf/'), '',
        'and nothing was fetched or parked: there is nothing to collect')
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: audit export')

  // A child process for the same reason the clone group above needs one:
  // `RUNS_DIR` is a module-level constant of util.mjs, read when THIS file
  // imported it, so the audit files can only be pointed into the sandbox from a
  // process of its own. Without that, a suite run would write into — and read
  // out of — the operator's real ~/agents/runs.
  const auditProbe = (() => {
    const work = join(sandkasten, 'audit-probe')
    mkdirSync(work, { recursive: true })
    const script = join(work, 'probe.mjs')
    writeFileSync(script, `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const serverDir = process.argv[2]
const mod = (rel) => import(pathToFileURL(join(serverDir, rel)).href)
const audit = await mod('sandbox/audit.mjs')
const dbmod = await mod('db.mjs')
const db = dbmod.default

const RID = 'aaaaaaaa-1111-2222-3333-444444444444'
const LEER = 'bbbbbbbb-1111-2222-3333-444444444444'
const out = { RID }

// runs.repo_id is NOT NULL and foreign_keys is really ON, so the run needs a
// repository to hang on — the path never gets touched.
const repoId = db.prepare(\`INSERT INTO repos(name,path,base_branch) VALUES('audit-probe','/nowhere','main') RETURNING id\`).get().id
db.prepare(\`INSERT OR REPLACE INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,sandbox,sandbox_container)
  VALUES(?,?,'claude','x','keiner',10,'done',1,'fl-aaaaaaaa')\`).run(RID, repoId)
dbmod.addEvent(RID, 'started', {})
dbmod.addEvent(RID, 'sandbox:blocked', { host: 'pypi.example', count: 2 })

mkdirSync(audit.auditPaths(RID).dir, { recursive: true })
writeFileSync(audit.auditPaths(RID).spec, JSON.stringify({ image: { ref: 'freilauf/agent-claude' } }))
audit.appendAuditFile(RID, 'egress.jsonl', { at: '2026-09-05T10:00:00.000Z', host: 'api.anthropic.com', action: 'allow' })
audit.appendAuditFile(RID, 'egress.jsonl', { at: '2026-09-05T10:00:01.000Z', host: 'pypi.example', action: 'deny', rejected_by: 'not_allowed' })
audit.appendAuditFile(RID, 'docker-events.jsonl', { at: '2026-09-05T10:00:02.000Z', status: 'start' })
audit.appendAuditFile(RID, 'egress.jsonl', { at: '2026-09-05T10:00:03.000Z', host: 'registry.npmjs.org', action: 'would_deny' })
audit.appendAuditFile(RID, 'egress.jsonl', { at: '2026-09-05T10:00:04.000Z', host: 'registry.npmjs.org', action: 'would_deny' })

out.lines = audit.buildAuditChain(RID)
out.denied = audit.blockedHosts(RID)
out.would = audit.blockedHosts(RID, { action: 'would_deny' })

db.prepare(\`INSERT OR REPLACE INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,sandbox)
  VALUES(?,?,'claude','x','keiner',10,'done',0)\`).run(LEER, repoId)
out.empty = audit.buildAuditChain(LEER)
out.emptyBlocked = audit.blockedHosts(LEER)

process.stdout.write(JSON.stringify(out))
`)
    const sub = join(work, 'sub')
    try {
      const r = execFileSync(process.execPath, [script, new URL('../server/', import.meta.url).pathname], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          FREILAUF_DATA_DIR: join(sub, 'data'),
          FREILAUF_RUNS_DIR: join(sub, 'runs'),
          FREILAUF_WORKTREES_DIR: join(sub, 'worktrees'),
          FREILAUF_PLUGIN_DIR: join(sub, 'plugins'),
          FREILAUF_SKILLS_HOME: join(sub, 'skillhome'),
          FREILAUF_SKILLS_STATE: join(sub, 'skills-installed.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return JSON.parse(r)
    } catch (err) {
      return { __error: String(err.stderr ?? err.message ?? err).trim() || String(err) }
    }
  })()

  {
    const { verifyAuditChain } = await import('../server/sandbox/audit.mjs')

    await pruefe('the probe process ran', () => {
      gleich(auditProbe.__error ?? '', '', 'the child that wrote real audit files came back')
    })

    await pruefe('the chain links, and every line carries the one before it', () => {
      const lines = auditProbe.lines ?? []
      wahr(lines.length >= 6, `header, spec, three file lines, two events and a footer (${lines.length})`)
      const objs = lines.map(l => JSON.parse(l))
      gleich(objs[0].kind, 'audit_header', 'the first line is the header')
      gleich(objs[0].run, auditProbe.RID, 'and it names the run')
      gleich(objs[0].prev_hash, null, 'the first line has nothing before it')
      gleich(objs.at(-1).kind, 'audit_footer', 'the last line is the footer')
      gleich(objs.at(-1).lines, lines.length, 'which names how many lines there are')
      for (let i = 1; i < objs.length; i++) {
        gleich(objs[i].prev_hash, objs[i - 1].hash, `line ${i + 1} carries the hash of the line before it`)
      }
      wahr(verifyAuditChain(lines).ok, `and the whole thing verifies (${JSON.stringify(verifyAuditChain(lines).problems)})`)
      // The spec has no time of its own and stands first; everything that does
      // is in time order, so one sort field is enough for whoever reads it.
      const timed = objs.filter(o => o.at && !['audit_header', 'audit_footer'].includes(o.kind)).map(o => o.at)
      gleich(JSON.stringify(timed), JSON.stringify([...timed].sort()), 'the timed records are in time order')
    })

    await pruefe('an edited, an added and a removed line each break the chain', () => {
      const lines = auditProbe.lines ?? []
      const mid = Math.floor(lines.length / 2)

      const edited = [...lines]
      const obj = JSON.parse(edited[mid])
      obj.data = { ...(obj.data ?? {}), host: 'somewhere-else.example' }
      edited[mid] = JSON.stringify(obj)
      const e1 = verifyAuditChain(edited)
      falsch(e1.ok, 'an edited line does not verify')
      wahr(e1.problems.some(p => p.includes('edited')), `and it says the line was edited (${e1.problems[0]})`)

      const added = [...lines]
      added.splice(mid, 0, lines[mid])
      falsch(verifyAuditChain(added).ok, 'an added line does not verify')

      const removed = lines.filter((_, i) => i !== mid)
      falsch(verifyAuditChain(removed).ok, 'a removed line does not verify')

      // Truncation is the one a bare chain would miss: cut the tail and
      // everything left is internally consistent. The footer's line count is
      // what catches it.
      const tr = verifyAuditChain(lines.slice(0, -1))
      falsch(tr.ok, 'a truncated file does not verify')
      wahr(tr.problems.some(p => p.includes('footer')), `and it says the end is missing (${tr.problems[0]})`)

      const swapped = [...lines]
      const tmp = swapped[1]; swapped[1] = swapped[2]; swapped[2] = tmp
      falsch(verifyAuditChain(swapped).ok, 'two swapped lines do not verify')

      wahr(verifyAuditChain(lines.join('\n')).ok, 'and the verifier reads the file as one string too')
    })

    await pruefe('a run with no sandbox files still exports a valid chain', () => {
      const lines = auditProbe.empty ?? []
      gleich(lines.length, 2, 'header and footer, and nothing in between')
      wahr(verifyAuditChain(lines).ok, 'and it verifies')
      falsch(verifyAuditChain([]).ok, 'while an empty file is not an export at all')
    })

    await pruefe('the proxy log answers both questions: what was blocked, and what would have been', () => {
      // Audit-only writes `would_deny` for exactly the request a policy in force
      // writes `deny` for — one file, two readings, which is what makes
      // "observe, then enforce" a rollout path rather than a transcription.
      gleich((auditProbe.denied ?? []).length, 1, 'one host was really blocked')
      gleich(auditProbe.denied?.[0]?.host, 'pypi.example', 'and it is named')
      gleich((auditProbe.would ?? []).length, 1, 'one host would have been')
      gleich(auditProbe.would?.[0]?.count, 2, 'counted, not listed twice')
      gleich((auditProbe.emptyBlocked ?? []).length, 0, 'a run with no proxy log blocked nothing')
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: launch decisions')
  {
    // Everything here is about the two decisions the LAUNCH path makes — is this
    // run sandboxed, and can a policy change be applied to the container that is
    // already running. Both are pure functions on purpose: the first is §7.3's
    // matrix plus §8.1's availability rule, and a matrix that could only be
    // tested on a machine with a container daemon would not be tested at all.
    const { decideSandbox } = await import('../server/sandbox/spec.mjs')
    const { sandboxOutcome, classifyPolicyPatch, LIVE_POLICY_PATHS, containerEnv } =
      await import('../server/sandbox/index.mjs')
    const { platformSuffix, sandboxPromptSection, splitEnvArgs, createRun } = await import('../server/runner.mjs')

    /** The whole way from four tri-states to what the run row says and the hub writes. */
    const plan = ({ hub, repo = 'inherit', agent = 'inherit', run = 'inherit',
      sandboxable = true, allowBypass = true, available = true }) => {
      const decision = decideSandbox({ hubMode: hub, allowBypass, repo, agent, run, sandboxable })
      const out = sandboxOutcome({ decision, hubMode: hub, available, unavailableReason: 'no docker' })
      return { ...out, kinds: out.events.map(e => e[0]), by: out.events.map(e => e[1]?.by ?? null) }
    }

    await pruefe('hub mode "off": nothing is sandboxed, whatever anybody below asks for', () => {
      for (const said of ['inherit', 'on', 'off']) {
        for (const layer of ['repo', 'agent', 'run']) {
          const p = plan({ hub: 'off', [layer]: said })
          gleich(p.sandbox, 0, `${layer}=${said}`)
          gleich(p.problems.length, 0, 'and it is not a refusal — the feature simply is not here')
          gleich(p.kinds.length, 0, 'and nothing is written down')
        }
      }
    })

    await pruefe('hub mode "available": only an explicit "on" sandboxes', () => {
      gleich(plan({ hub: 'available' }).sandbox, 0, 'nobody asked')
      for (const layer of ['repo', 'agent', 'run']) {
        gleich(plan({ hub: 'available', [layer]: 'on' }).sandbox, 1, `${layer} asked`)
        // Opting out of something that was not going to happen is a no-op, and
        // a no-op must not produce a break-glass event on the run.
        const off = plan({ hub: 'available', [layer]: 'off' })
        gleich(off.sandbox, 0, `${layer} opted out of nothing`)
        gleich(off.kinds.length, 0, 'and said nothing about it')
      }
    })

    await pruefe('hub mode "default_on": everything is, and opting out is a NAMED bypass', () => {
      gleich(plan({ hub: 'default_on' }).sandbox, 1, 'nobody said anything')
      for (const layer of ['repo', 'agent', 'run']) {
        const p = plan({ hub: 'default_on', [layer]: 'off' })
        gleich(p.sandbox, 0, `${layer} opted out`)
        gleich(p.kinds[0], 'sandbox:bypassed', 'and the weakening is written down')
        gleich(p.by[0], layer, 'naming who did it')
        gleich(p.problems.length, 0, 'a bypass is not a refusal')
      }
    })

    await pruefe('the INNERMOST layer with an opinion decides', () => {
      gleich(plan({ hub: 'default_on', repo: 'off', agent: 'on' }).sandbox, 1, 'the agent overrules the repo')
      gleich(plan({ hub: 'default_on', repo: 'off', agent: 'on', run: 'off' }).sandbox, 0, 'and the run overrules the agent')
      // …and a bypass is judged against what would have happened WITHOUT that
      // layer: an agent that had already switched it on is what makes the run's
      // `off` break-glass rather than a no-op.
      gleich(plan({ hub: 'available', agent: 'on', run: 'off' }).kinds[0], 'sandbox:bypassed', 'a real opt-out')
      gleich(plan({ hub: 'available', agent: 'off', run: 'off' }).kinds.length, 0, 'nothing to opt out of')
    })

    await pruefe('bypass not allowed turns an opt-out into a refusal, never into a quiet start', () => {
      const p = plan({ hub: 'default_on', run: 'off', allowBypass: false })
      gleich(p.sandbox, 0, 'nothing is started')
      gleich(p.problems.length, 1, 'and the caller is told why')
      gleich(p.kinds.length, 0, 'a refusal is not a bypass event')
      gleich(plan({ hub: 'default_on', run: 'off', allowBypass: true }).kinds[0], 'sandbox:bypassed', 'the other half')
    })

    await pruefe('hub mode "required": an opt-out is REFUSED at every layer', () => {
      gleich(plan({ hub: 'required' }).sandbox, 1, 'the ordinary case')
      for (const layer of ['repo', 'agent', 'run']) {
        const p = plan({ hub: 'required', [layer]: 'off' })
        gleich(p.sandbox, 0, `${layer}: nothing is started`)
        gleich(p.problems.length, 1, 'and it is a problem the form renders')
        gleich(p.kinds.length, 0, 'never a silent downgrade')
      }
      // `sandbox_allow_bypass` cannot loosen `required`: the two say different
      // things, and the stricter one is the whole point of the mode.
      gleich(plan({ hub: 'required', run: 'off', allowBypass: true }).problems.length, 1, 'bypass does not open it')
    })

    await pruefe('a coding agent that cannot be sandboxed: refused under "required", plain otherwise', () => {
      gleich(plan({ hub: 'required', sandboxable: false }).problems.length, 1, 'required refuses it')
      gleich(plan({ hub: 'required', sandboxable: false }).sandbox, 0, 'and starts nothing')
      for (const hub of ['available', 'default_on']) {
        const p = plan({ hub, sandboxable: false })
        gleich(p.sandbox, 0, `${hub}: it simply runs on the host`)
        gleich(p.problems.length, 0, `${hub}: and that is not an error`)
      }
    })

    await pruefe('no container runtime: §8.1 — bypassed and SAID, or refused, never silent', () => {
      const soft = plan({ hub: 'default_on', available: false })
      gleich(soft.sandbox, 0, 'default_on starts the run')
      gleich(soft.kinds[0], 'sandbox:bypassed', 'and writes the bypass')
      gleich(soft.by[0], 'unavailable', 'naming the runtime, not a layer')
      const asked = plan({ hub: 'available', run: 'on', available: false })
      gleich(asked.kinds[0], 'sandbox:bypassed', 'an explicit "on" with no runtime is a bypass too')
      const hard = plan({ hub: 'required', available: false })
      gleich(hard.sandbox, 0, 'required starts nothing')
      gleich(hard.problems.length, 1, 'and says why')
      gleich(hard.kinds.length, 0, 'a refusal is not a bypass')
      // The one case that must stay quiet: nobody wanted a sandbox anyway.
      gleich(plan({ hub: 'available', available: false }).kinds.length, 0, 'nothing promised, nothing said')
    })

    await pruefe('a refused override becomes an event, and does not stop the run', () => {
      const out = sandboxOutcome({
        decision: decideSandbox({ hubMode: 'required', repo: 'inherit', agent: 'inherit', run: 'inherit' }),
        hubMode: 'required', available: true,
        refused: [{ path: 'network.allow', by: 'repo', wanted: ['evil.example'], kept: [] }],
      })
      gleich(out.sandbox, 1, 'the run starts on the higher layer’s value')
      gleich(out.events[0][0], 'sandbox:override_refused', 'and the refusal is on the record')
      gleich(out.events[0][1].path, 'network.allow', 'naming the field')
    })

    // -------------- an unsandboxed run is byte for byte what it was --------------

    await pruefe('an unsandboxed run’s prompt is unchanged, to the byte', () => {
      const run = { id: 'r1', harness: 'claude', expected_minutes: 30, workdir_effective: '/w' }
      gleich(sandboxPromptSection(null), '', 'no facts, no section')
      const plain = platformSuffix(run, 'No branch.', {})
      falsch(plain.includes('SANDBOX'), 'no sandbox block anywhere in it')
      // `platformSuffix(…, null, null)` against `platformSuffix(…)` asserted
      // NOTHING: those two arguments ARE the defaults, so both sides were the
      // same deterministic call and no implementation could have made it fail.
      // What the check is for is that the two new parameters ADD a block and
      // change nothing else — so it is measured against a run that has facts.
      const facts = { workdir: '/w/clone', mode: 'none', memory: '8g', cpus: 4, readOnlyRoot: true }
      const section = sandboxPromptSection(facts)
      wahr(section.includes('SANDBOX'), 'a run with facts really gets a section')
      const boxed = platformSuffix(run, 'No branch.', {}, null, facts)
      gleich(boxed.replace(`\n\n${section}`, ''), plain,
        'and the unsandboxed prompt is that same prompt with the section taken out — nothing else moved')
    })

    await pruefe('a sandboxed run is told the facts and the one thing it can DO about them', () => {
      const text = sandboxPromptSection({
        workdir: '/w/clone', mode: 'allowlist', allow: ['api.anthropic.com', 'github.com'],
        memory: '8g', cpus: 4, readOnlyRoot: true,
      })
      enthaelt(text, '/w/clone', 'the working copy')
      enthaelt(text, 'api.anthropic.com, github.com', 'the resolved allow list, as the proxy has it')
      enthaelt(text, '8g', 'the memory')
      enthaelt(text, 'fl-report access', 'and the sentence the whole escalation path hangs on')
      enthaelt(text, 'carry on with what you CAN do', 'plus what to do meanwhile')
      // audit-only must not tell the agent hosts are blocked when they are not:
      // it would report access it already has, which is noise on somebody's phone.
      const audit = sandboxPromptSection({ workdir: '/w', mode: 'allowlist', allow: ['a.example'], auditOnly: true })
      enthaelt(audit, 'not enforced', 'audit-only says so')
      const none = sandboxPromptSection({ workdir: '/w', mode: 'none', allow: [] })
      enthaelt(none, 'no network at all', 'and "none" says that instead of listing nothing')
    })

    await pruefe('createRun writes the frozen decision, and defaults to the old world', async () => {
      const { default: sdb } = await import('../server/db.mjs')
      sdb.exec(`INSERT OR IGNORE INTO repos(name, path, base_branch) VALUES('sb-launch-repo', '/tmp/sb-launch-repo', 'main')`)
      const repoId = sdb.prepare('SELECT id FROM repos WHERE name=?').get('sb-launch-repo').id
      const common = { repoId, harness: 'claude', prompt: 'p', branchMode: 'keiner', expectedMinutes: 5 }

      const plain = createRun(common)
      const a = sdb.prepare('SELECT sandbox, sandbox_spec, worktree_kind FROM runs WHERE id=?').get(plain)
      gleich(a.sandbox, 0, 'a run nobody sandboxed')
      gleich(a.worktree_kind, 'worktree', 'gets a linked worktree, exactly as before')
      gleich(a.sandbox_spec, null, 'and no frozen spec at all')

      const boxed = createRun({ ...common, sandbox: 1, sandboxProfileId: 7, sandboxSpec: { runtime: 'docker' } })
      const b = sdb.prepare('SELECT sandbox, sandbox_profile_id, sandbox_spec, worktree_kind FROM runs WHERE id=?').get(boxed)
      gleich(b.sandbox, 1, 'a sandboxed run says so from its first moment')
      gleich(b.sandbox_profile_id, 7, 'with the profile that applied')
      gleich(b.worktree_kind, 'clone', 'and a clone, because a worktree hangs on the operator’s .git')
      gleich(JSON.parse(b.sandbox_spec).runtime, 'docker', 'the spec is FROZEN into the row, like or_routing')
    })

    await pruefe('a runtime that cannot be ASKED is a retry, never an attempt (§11.3)', async () => {
      // The fuse this defuses: `resume_attempts` is raised before fl-start runs
      // and RESUME_MAX is 3, so three watcher passes against a daemon that is
      // merely still starting after a reboot would end the run with
      // `resume_refused` — for an infrastructure hiccup, not for a CLI that
      // cannot start. AGENTS.md: "could not try" is not "tried and died".
      const { prepareSandbox } = await import('../server/sandbox/index.mjs')
      const fehlschlag = async (id, repoPath) => {
        try { await prepareSandbox({ id, sandbox: 1 }, { name: 'x', path: repoPath }); return null }
        catch (e) { return e }
      }
      // Driven by the seam, not by the machine: this used to hold only because
      // the development host had no Docker, and it went red the day it got one.
      const err = await mitRuntime({ forbid: true }, () => fehlschlag('sb-no-daemon', '/tmp/x'))
      wahr(!!err, 'with no container runtime the preparation cannot go ahead')
      wahr(err.sandboxRetry === true, 'and it says so as a RETRY, not as a failure')
      wahr(String(err.message).length > 0, 'with a sentence a human can read')

      // The other half, and it is what makes the first one mean something: with
      // a runtime that DID answer, a failure is an attempt like any other. If
      // everything were a retry, `RESUME_MAX` would never be reached and a CLI
      // that cannot start would be launched for ever.
      const echt = await mitRuntime({ daemon: true },
        () => fehlschlag('sb-has-daemon', join(sandkasten, 'no-such-repo')))
      wahr(!!echt, 'a run whose own preparation fails still fails')
      falsch(echt.sandboxRetry === true, `and that is an ATTEMPT, not a retry (${echt?.message})`)
    })

    await pruefe('the container PATH names the directories fl-report is mounted from', () => {
      // Without this, `fl-report` is not on PATH inside the box and every claude
      // and cursor hook that calls it by bare name fails — silently, on a run
      // whose session stands, whose pane is alive and which says `running`.
      const e = containerEnv({ home: '/runs/x/home', binPaths: ['/home/hub/.local/bin'] })
      enthaelt(e.PATH, '/home/hub/.local/bin', 'the mounted directory comes first')
      enthaelt(e.PATH, '/usr/bin', 'and the image’s own directories are still there')
      gleich(e.HOME, '/runs/x/home', 'HOME is the run’s own (§7.7)')
      // USER is a LOGIN NAME and `spec.user` is a POLICY word — the two must not
      // be confused, or a CLI resolving $USER against /etc/passwd disagrees with
      // itself inside a container nobody can attach to.
      falsch(e.USER === 'hub', 'USER is not the policy word')
    })

    // ---------------- live vs. restart (§7.12.3) ----------------

    await pruefe('a policy patch is classified field by field, and the default is RESTART', () => {
      const table = [
        [{ network: { allow: ['a.example'] } }, true, 'the allow list: the proxy reloads'],
        [{ network: { deny: ['b.example'] } }, true, 'the deny list'],
        [{ network: { auditOnly: false } }, true, 'audit-only → enforce'],
        [{ network: { methods: ['GET'] } }, true, 'the methods'],
        [{ network: { presets: ['harness'] } }, true, 'a preset, which is only an allow list'],
        [{ resources: { memory: '4g' } }, true, 'docker update documents memory'],
        [{ resources: { cpus: 2 } }, true, '…and cpus'],
        [{ resources: { pidsLimit: 512 } }, true, '…and the pids limit'],
        [{ retention: 'keep' }, true, 'retention is bookkeeping, not a container'],
        [{ network: { mode: 'open' } }, false, 'the network is chosen at creation'],
        [{ network: { engine: 'iron-proxy' } }, false, 'and so is which proxy there is'],
        [{ filesystem: { extraMounts: [{ source: '/a', target: '/a' }] } }, false, 'Docker cannot add a mount'],
        [{ filesystem: { tmpfsSizes: { '/tmp': '8g' } } }, false, 'a wider tmpfs is a new container'],
        [{ filesystem: { readOnlyRoot: false } }, false, 'so is a writable root'],
        [{ image: { ref: 'other:1' } }, false, 'a different image'],
        [{ user: 'root' }, false, 'a different user'],
        [{ innerSandbox: 'full' }, false, 'the inner sandbox'],
        [{ secrets: { mode: 'inject' } }, false, 'the environment is set at creation'],
        [{ runtime: 'podman' }, false, 'and so is the runtime'],
        [{ resources: { shmSize: '2g' } }, false, 'shm is a creation-time size'],
        [{ somethingNobodyClassified: true }, false, 'and anything unknown needs a restart, deliberately'],
      ]
      for (const [patch, live, why] of table) {
        gleich(!classifyPolicyPatch(patch).needsRestart, live, `${why}: ${JSON.stringify(patch)}`)
      }
      // A patch that touches both goes the restart way as a whole: half a policy
      // applied live and half of it pending is a state nobody can reason about.
      const both = classifyPolicyPatch({ network: { allow: ['a'], mode: 'open' } })
      wahr(both.needsRestart, 'a mixed patch needs the restart')
      gleich(both.live.length, 1, 'and still knows which half could have been live')
    })

    await pruefe('the live paths say WHO applies them — the proxy or docker update', () => {
      gleich(classifyPolicyPatch({ network: { allow: ['a'] } }).proxy, true, 'the proxy hears the network rules')
      gleich(classifyPolicyPatch({ network: { allow: ['a'] } }).limits, false, '…and docker is not bothered')
      gleich(classifyPolicyPatch({ resources: { memory: '4g' } }).limits, true, 'docker update hears the limits')
      gleich(classifyPolicyPatch({ resources: { memory: '4g' } }).proxy, false, '…and the proxy is not reloaded')
      wahr(LIVE_POLICY_PATHS.includes('network.allow'), 'the table is the source of both answers')
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: the blocked need')

  {
    const { agentCopedAfter, sandboxDenialSummary, sandboxBlockedSchwere, scanSandboxLines,
      scanneNeueBytes, vorfallWeggrund: weggrund, TYPEN: TYPEN_SB, TYP_TEXT: TEXT_SB } =
      await import('../server/detect.mjs')
    const { brauchtMensch, MENSCH_TYPEN } = await import('../server/incidents.mjs')
    const t0 = Date.parse('2026-09-05T10:00:00Z')

    await pruefe('the veto is one function, and it answers in both directions', () => {
      // This is the line the whole package hangs on: work AFTER the denial says
      // the agent coped with it, and nothing may then promote it.
      wahr(agentCopedAfter(t0 + 60_000, t0), 'work one minute after the denial: coped')
      falsch(agentCopedAfter(t0 - 60_000, t0), 'work BEFORE it says nothing')
      falsch(agentCopedAfter(t0, t0), 'the same instant is not "after"')
      // null is UNKNOWN (hermes has no activity source), never "at the epoch" —
      // the Number(null) === 0 trap, which would read as "worked in 1970".
      falsch(agentCopedAfter(null, t0), 'no activity source: unknown, never coped')
    })

    await pruefe('work after the denial keeps a blocked run yellow — in both directions', () => {
      const zwei = sandboxDenialSummary([
        { host: 'pypi.org', atMs: t0 }, { host: 'registry.npmjs.org', atMs: t0 + 30_000 }])
      // Two distinct hosts would be red…
      gleich(sandboxBlockedSchwere(zwei, { letzteAktivitaetMs: t0 - 60_000, jetztMs: t0 + 60_000 }), 'rot',
        'two hosts turned away and no work since: red')
      // …and are not, once the agent demonstrably carried on.
      gleich(sandboxBlockedSchwere(zwei, { letzteAktivitaetMs: t0 + 45_000, jetztMs: t0 + 60_000 }), 'gelb',
        'the same two hosts, but the agent kept working: stays yellow')
      // The silence path is vetoed by the same evidence.
      const eins = sandboxDenialSummary([{ host: 'pypi.org', atMs: t0 }])
      gleich(sandboxBlockedSchwere(eins, { letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 6 * 60_000 }), 'rot',
        'one host and six minutes of silence: red')
      gleich(sandboxBlockedSchwere(eins, { letzteAktivitaetMs: t0 + 1000, jetztMs: t0 + 6 * 60_000 }), 'gelb',
        'one host, and the agent worked on: yellow')
      gleich(sandboxBlockedSchwere(eins, { letzteAktivitaetMs: null, jetztMs: t0 + 6 * 60_000 }), 'gelb',
        'an unmeasured harness is never escalated by silence')
    })

    await pruefe('a single denial is yellow, a second DISTINCT host promotes it', () => {
      const eins = sandboxDenialSummary([{ host: 'pypi.org', atMs: t0 }])
      gleich(eins.hosts.length, 1, 'one host')
      gleich(sandboxBlockedSchwere(eins, { letzteAktivitaetMs: null, jetztMs: t0 + 60_000 }), 'gelb',
        'one denial may be exactly what the policy intended')
      // Twenty denials of ONE host are still one host: an npm install behind a
      // wall must not read as "this run is very blocked".
      const viele = sandboxDenialSummary(
        Array.from({ length: 20 }, (_, i) => ({ host: 'pypi.org', atMs: t0 + i * 1000 })))
      gleich(viele.hosts.length, 1, 'twenty requests, one host')
      gleich(sandboxBlockedSchwere(viele, { letzteAktivitaetMs: null, jetztMs: t0 + 60_000 }), 'gelb',
        'and still yellow')
      const zwei = sandboxDenialSummary([...Array.from({ length: 20 }, (_, i) => ({ host: 'pypi.org', atMs: t0 + i * 1000 })),
        { host: 'files.pythonhosted.org', atMs: t0 + 25_000 }])
      gleich(zwei.hosts.length, 2, 'a second host')
      gleich(sandboxBlockedSchwere(zwei, { letzteAktivitaetMs: null, jetztMs: t0 + 60_000 }), 'rot',
        'and the policy is demonstrably written for another job: red')
    })

    await pruefe('denials are collapsed per host per ten minutes', () => {
      const s = sandboxDenialSummary([
        { host: 'pypi.org', atMs: t0 },
        { host: 'pypi.org', atMs: t0 + 60_000 },          // inside the window: not counted again
        { host: 'pypi.org', atMs: t0 + 11 * 60_000 },     // a fresh window
      ])
      gleich(s.count, 2, 'two occurrences, not three')
      gleich(s.hosts.length, 1, 'one host throughout')
      gleich(s.erstMs, t0, 'the first denial')
      gleich(s.zuletztMs, t0 + 11 * 60_000, 'and the last one')
      // Junk in, nothing out — a proxy that reported no host is not a denial.
      const leer = sandboxDenialSummary([{ host: '', atMs: t0 }, { host: 'x', atMs: NaN }, null])
      gleich(leer.hosts.length, 0, 'no host, no denial')
      gleich(leer.zuletztMs, null, 'and no timeline to judge')
      gleich(sandboxBlockedSchwere(leer, { jetztMs: t0 }), 'gelb', 'nothing to judge is never red')
    })

    await pruefe('the sandbox patterns catch a real wall', () => {
      const echt = [
        "Error: EACCES: permission denied, open '/etc/hosts'",
        'npm ERR! code EACCES',
        "Error: EROFS: read-only file system, mkdir '/usr/lib/node_modules/x'",
        "mkdir: cannot create directory '/opt/tools': Read-only file system",
        'Error: ENOSPC: no space left on device, write',
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        'curl: (6) Could not resolve host: registry.npmjs.org',
        'Error: connect ENETUNREACH 140.82.121.4:443',
        'ssh: connect to host github.com port 22: Network is unreachable',
        'Freilauf sandbox: pypi.org is not reachable from this run (not on this run’s allowlist). '
          + 'If you need it, run: fl-report access "pypi.org: why you need it" and continue with what you can do meanwhile.',
      ]
      for (const zeile of echt) {
        gleich(scanSandboxLines([zeile]).length, 1, `caught: ${zeile.slice(0, 60)}`)
      }
    })

    await pruefe('…and not what an agent working on THIS repository prints', () => {
      // Every one of these is a line that really occurs in this checkout, on the
      // screen of a run that is editing the sandbox feature. The exception list
      // exists because this class of false alarm has already cost this project
      // two production incidents ("Upgrade to Max", `555 tokens`).
      const harmlos = [
        // SANDBOX_RESEARCH.md §7.12.1, the whole family in one prose line.
        '| **The log scanner** | `EACCES`, `EROFS` / `Read-only file system`, `ENOSPC` on a tmpfs, '
          + '`Cannot connect to the Docker daemon`, `Could not resolve host`, `ENETUNREACH` |',
        // The pattern file itself, read out loud.
        "  { typ: 'sandbox_denied', re: /\\bcannot connect to the docker daemon\\b/i },",
        "  { typ: 'sandbox_denied', re: /\\bEROFS\\b\\s*[:,]|:\\s*read-only file system\\b/i },",
        // The translation catalogue — which literally contains the 403 body.
        '"sandbox.proxy.denied": "Freilauf sandbox: {host} is not reachable from this run ({reason}). '
          + 'If you need it, run: fl-report access \\"{host}: why you need it\\" and continue with what you can do meanwhile.",',
        // This very test, and the e2e one next to it.
        "      gleich(scanSandboxLines(['Error: EROFS: read-only file system, open x']).length, 1, 'caught')",
        "        logAnhaengen(id, 'Error: ENOSPC: no space left on device, write\\n')",
        // A grep for the vocabulary.
        "$ rg 'Could not resolve host' server/",
        // A doc sentence about the feature, naming the file it lives in.
        'The new `sandbox` pattern family in server/harnesses/patterns.mjs covers ENETUNREACH and friends.',
        // The suite reporting that the detection works.
        '✓ the sandbox patterns catch a real wall: Cannot connect to the Docker daemon is detected',
      ]
      for (const zeile of harmlos) {
        gleich(scanSandboxLines([zeile]).length, 0, `left alone: ${zeile.slice(0, 60)}`)
      }
    })

    await pruefe('the sandbox family is only asked where there is a sandbox', () => {
      const text = "Error: EROFS: read-only file system, open '/usr/lib/x'\n"
      const ohne = scanneNeueBytes('claude', text, 0)
      gleich(ohne.sandboxTreffer.length, 0, 'an unsandboxed run has an ordinary permission problem')
      const mit = scanneNeueBytes('claude', text, 0, { sandbox: true })
      gleich(mit.sandboxTreffer.length, 1, 'a sandboxed one has a wall')
      gleich(mit.neuerOffset, ohne.neuerOffset, 'and the offset is the same either way — the log is read once')
      gleich(mit.sandboxTreffer[0].typ, 'sandbox_denied', 'under its own name')
    })

    await pruefe('docker_unreachable needs a human, and never clears itself by time', () => {
      wahr(MENSCH_TYPEN.has('docker_unreachable'), 'in the "Needs you" set')
      wahr(brauchtMensch({ typ: 'docker_unreachable', schwere: 'rot' }, 'running'),
        'a daemon that stopped answering does not get better by waiting')
      wahr(TYPEN_SB.includes('docker_unreachable'), 'a known type, not "unbekannt"')
      gleich(TEXT_SB.docker_unreachable, 'Container runtime not answering', 'and it has a name')
      // The watcher owns its recovery (dockerAnswered()); time must not, or the
      // incident would clear while every sandboxed run is still behind it.
      gleich(weggrund({ typ: 'docker_unreachable', schwere: 'rot', runStatus: 'done',
        letzteAktivitaetMs: t0, zuletztGesehenMs: t0, jetztMs: t0 + 24 * 3600_000 }), null,
        'not even a finished run resolves it')
    })

    await pruefe('an access request is a question, and only a decision or the run answers it', () => {
      wahr(MENSCH_TYPEN.has('sandbox_access'), 'in the "Needs you" set')
      wahr(brauchtMensch({ typ: 'sandbox_access', schwere: 'rot' }, 'running'), 'while the run goes on')
      // The agent was told to carry on with what it can — so the ordinary rule's
      // evidence ("the agent kept working after it") is present by construction
      // and must NOT close the request.
      gleich(weggrund({ typ: 'sandbox_access', schwere: 'rot', runStatus: 'running',
        letzteAktivitaetMs: t0 + 60 * 60_000, zuletztGesehenMs: t0, jetztMs: t0 + 61 * 60_000 }), null,
        'an hour of work afterwards is exactly what was asked of it')
      enthaelt(String(weggrund({ typ: 'sandbox_access', schwere: 'rot', runStatus: 'done',
        letzteAktivitaetMs: t0, zuletztGesehenMs: t0, jetztMs: t0 + 60_000 })), 'finished',
        'the run coming through anyway makes it moot')
    })
  }

  gruppe('Sandbox: defect fixes')
  //
  // Five things the design promised and the code did not do. Each test here is
  // the shape of the failure rather than the shape of the fix, so a later
  // rewrite that keeps the promise keeps the test.
  {
    const proxy = await import('../server/sandbox/proxy.mjs')
    const iron = await import('../server/sandbox/ironproxy.mjs')
    const { BUILTIN_PROFILES } = await import('../server/sandbox/profiles.mjs')
    const { normalizeSpec } = await import('../server/sandbox/spec.mjs')
    const rd = await import('../server/run-def.mjs')
    const { setSetting: setS } = await import('../server/db.mjs')
    const enSb = JSON.parse(readFileSync(new URL('../lang/en.json', import.meta.url), 'utf8'))

    // A handle as `startIronProxy()` builds one, minus everything that needs a
    // daemon: these tests are about the decisions, and the decisions are the
    // half that is testable on a machine with no container runtime at all.
    const ironHandle = (extra = {}) => ({
      engine: 'iron-proxy', runId: 'r-defect', spec: { network: { mode: 'allowlist', allow: ['a.example'] } },
      secretsMode: 'inject', policy: null, secrets: [], launchCtx: { env: {} },
      managementKey: 'k', managementPort: 8081, container: 'fl-proxy-r-defect',
      configPath: null, blocked: new Map(), wouldBlock: new Map(), ...extra,
    })

    await pruefe('every engine answers setSecrets — and the one that cannot says so', async () => {
      // The defect: `applySecrets()` called `proxy.setSecrets`, which no engine
      // exported, so `secrets.mode: inject` threw "unsupported" at every launch
      // whatever engine was configured. The capability question has to have an
      // ANSWER, not a missing function.
      gleich(typeof proxy.setSecrets, 'function', 'the interface carries it')
      const nein = await proxy.setSecrets({ engine: 'builtin' }, [{ name: 'K', placeholder: 'p', value: 'v', hosts: ['a.example'] }])
      falsch(nein.ok, 'the built-in CONNECT proxy refuses')
      enthaelt(String(nein.reason), 'builtin', 'and names the engine that cannot')
      gleich((await proxy.setSecrets(null, [])).ok, false, 'no handle is a refusal, never a throw')
    })

    await pruefe('an injection without hosts is refused, never guessed at', async () => {
      const r = await iron.setSecretsIronProxy(ironHandle(), [{ name: 'OPENROUTER_API_KEY', placeholder: 'fl-token-x', value: 'real' }])
      falsch(r.ok, 'no hosts, no injection')
      enthaelt(String(r.reason), 'OPENROUTER_API_KEY', 'and the variable is named')
      gleich((await iron.setSecretsIronProxy(ironHandle(), [])).ok, true, 'an empty table is a no-op, not a failure')
    })

    await pruefe('the secrets transform survives an ordinary policy reload', async () => {
      // The trap: `proxy.yaml` is regenerated from the SPEC, and the secrets are
      // not in the spec. A reload that forgot them would leave the container
      // holding placeholders nobody swaps — every call a 401, on a run that
      // looks healthy.
      const file = join(sandkasten, 'iron-reload.yaml')
      const handle = ironHandle({ configPath: file })
      handle.secrets = [{ key: 'or', envVar: 'OPENROUTER_API_KEY', placeholder: 'fl-token-abc', header: 'Authorization', hosts: ['openrouter.ai'] }]
      const r = await iron.reloadIronProxy(handle, handle.spec)
      falsch(r.ok, 'with no reachable management listener the reload refuses')
      const yaml = readFileSync(file, 'utf8')
      enthaelt(yaml, 'name: "secrets"', 'and the rewritten file still carries the transform')
      enthaelt(yaml, 'fl-token-abc', 'with the placeholder that is in the container')
    })

    await pruefe('a management listener that cannot be reached says what to do about it', async () => {
      // The defect: `managementUrl` was `ctx.managementUrl ?? null` and nothing
      // ever set it, so every live policy change answered "management listener
      // unknown" — a sentence nobody can act on.
      const bare = ironHandle({ container: null })
      const none = await iron.resolveManagementUrl(bare)
      gleich(none.url, null, 'without a container there is nothing to resolve')
      const told = ironHandle({ managementUrl: 'http://proxy.example:8081/' })
      gleich((await iron.resolveManagementUrl(told)).url, 'http://proxy.example:8081/', 'what the caller knows wins')
      const r = await iron.reloadIronProxy(bare, bare.spec)
      falsch(r.ok, 'and the reload does not claim success')
      const text = String(r.reason)
      enthaelt(text, 'FREILAUF_SANDBOX_MANAGEMENT_URL', 'the reason names the seam')
      enthaelt(text, 'restart', 'and the other way out')
      wahr(!!enSb['sandbox.proxy.management_unreachable'], 'the key is really in the catalog')
    })

    await pruefe('a shipped profile can start a run', () => {
      // Three of the four asked for `secrets.mode: inject` on an engine nobody
      // has installed, so Balanced, Locked down and Audit failed at launch as
      // shipped. The rule is the invariant, not the value: whatever a built-in
      // asks for, the engine it names must be able to do.
      for (const p of BUILTIN_PROFILES) {
        const s = normalizeSpec(p.spec)
        const caps = proxy.engineCapabilities(s.network?.engine)
        if ((s.secrets?.mode ?? 'env') === 'inject') {
          wahr(caps.inject, `${p.name}: asks for inject on an engine that can`)
        }
        if (s.network?.tlsTerminate === true) wahr(caps.tlsTerminate, `${p.name}: asks for TLS termination on an engine that can`)
        wahr(!!enSb[p.descKey], `${p.name}: its description is in the catalog`)
      }
    })

    await pruefe('…and a profile that contradicts itself is refused at the form, not at the launch', async () => {
      const { saveProfile } = await import('../server/sandbox/profiles.mjs')
      const bad = saveProfile({ name: 'sb-defect-inject', spec: { network: { engine: 'builtin' }, secrets: { mode: 'inject' } } })
      gleich(bad.id, null, 'nothing is stored')
      gleich(bad.problems[0]?.key, 'sandbox.problem.profile_inject_engine', 'and the reason is the contradiction')
      wahr(!!enSb['sandbox.problem.profile_inject_engine'], 'whose text is in the catalog')
      // Narrow on purpose: a profile that asks for inject and names NO engine
      // may still resolve against a hub configured for one.
      const ok = saveProfile({ name: 'sb-defect-inject-open', spec: { secrets: { mode: 'inject' } } })
      wahr(ok.id > 0, 'a profile that names no engine is left alone')
      const { deleteProfile } = await import('../server/sandbox/profiles.mjs')
      deleteProfile(ok.id)
    })

    await pruefe('one reader for the break glass, and it knows every word for yes', () => {
      // `'1'` to one reader, `'on'` to another, `'true'` to a third: the form
      // offered the escape hatch and the endpoint refused it. Same family as
      // `'0'` being truthy — a stored value is COMPARED, in one place.
      const lies = (v) => { setS('sandbox_allow_bypass', v); return rd.sandboxAllowBypass() }
      try {
        for (const yes of ['1', 'on', 'true', 'yes', 'ON', ' true ']) wahr(lies(yes), `“${yes}” means the bypass is allowed`)
        for (const no of ['0', 'off', 'false', 'no', 'OFF']) falsch(lies(no), `“${no}” means it is not`)
        wahr(lies(''), 'unset means yes — a restriction is added, never inherited')
        wahr(lies('vielleicht'), 'and a value nobody can read lands on the documented default')
      } finally { setS('sandbox_allow_bypass', '') }
      // The sandbox facade must not have a second opinion about any of them —
      // and neither may the watcher, which held the last stray reader of
      // `sandbox_mode` (`sandboxInUse()`). It AGREED with the canon, which is
      // how the other three started; it asks `sandboxHubMode()` now.
      const dateien = {
        'the facade': readFileSync(new URL('../server/sandbox/index.mjs', import.meta.url), 'utf8'),
        'the watcher': readFileSync(new URL('../server/watcher.mjs', import.meta.url), 'utf8'),
      }
      for (const [wo, quelle] of Object.entries(dateien)) {
        for (const key of ['sandbox_mode', 'sandbox_allow_bypass', 'sandbox_lock', 'sandbox_allowed_mount_roots']) {
          falsch(quelle.includes(`getSetting('${key}')`), `${key} is not read a second time in ${wo}`)
        }
      }
      enthaelt(dateien['the watcher'], 'sandboxHubMode()', 'the watcher asks the canonical reader instead')
    })

    await pruefe('the launcher takes --setting-sources from the declaration, not from its own head', () => {
      const flStart = readFileSync(new URL('../bin/fl-start', import.meta.url), 'utf8')
      // The comment above the function still names the flag and its value; what
      // must be gone is the line that PRINTS them.
      falsch(/printf[^\n]*--setting-sources user/.test(flStart), 'the value is not printed from a literal any more')
      enthaelt(flStart, '.ctx.launchOverrides.settingSources', 'it comes out of the sandbox document')
      // …and the document really carries it: the facade writes the plugin's
      // answer into `ctx`, which is the only place fl-start can read it from.
      const facade = readFileSync(new URL('../server/sandbox/index.mjs', import.meta.url), 'utf8')
      enthaelt(facade, 'launchOverrides: await harnessLaunchOverrides(run, spec)', 'the ctx carries the declaration')
      // The measured failure this flag prevents (§11a.3) is a run that never
      // reports, so a document from an older hub keeps the old behaviour.
      enthaelt(flStart, 'SB_SETTING_SOURCES="user"', 'and a document that says nothing at all still gets it')
    })

    await pruefe('the sandbox document names the home the way both its readers do', () => {
      // `fl-start` refuses a document without `.ctx.homeDir` and
      // `buildRunArgv()` mounts `ctx.homeDir`; the facade wrote only `home`, so
      // every sandboxed run died at the launcher.
      const facade = readFileSync(new URL('../server/sandbox/index.mjs', import.meta.url), 'utf8')
      enthaelt(facade, 'homeDir: home', 'the writer uses the readers’ name')
      const flStart = readFileSync(new URL('../bin/fl-start', import.meta.url), 'utf8')
      enthaelt(flStart, '.ctx.homeDir', 'which is what the launcher asks for')
    })

    await pruefe('docker-events.jsonl has a producer, and it is stopped with the run', () => {
      // It was declared in AUDIT_FILES, folded into the export, and written by
      // nobody. Wiring it is only half: a `docker events` tail is a process, and
      // a process that outlives its run is the other half.
      const facade = readFileSync(new URL('../server/sandbox/index.mjs', import.meta.url), 'utf8')
      enthaelt(facade, "'docker-events.jsonl'", 'the file is written')
      enthaelt(facade, "'events', '--filter'", 'from the daemon’s own event stream')
      enthaelt(facade, 'stopDockerEvents(runId)', 'and the tail is torn down')
      wahr(/export async function teardownSandbox[\s\S]{0,600}stopDockerEvents/.test(facade),
        'by the teardown, which runs on every path a run can end')
    })
  }

  gruppe('Sandbox: nothing is left running')
  //
  // Three leaks and one killing, all measured against the running hub rather
  // than argued from the code:
  //
  //   * the orphan reaper removed a run's containers and left its NETWORK — and
  //     Docker's default address pool subnets out after ~31 of them, after which
  //     no sandboxed run starts at all;
  //   * `teardownSandbox()` was on no ordinary end path, so a finished run's
  //     built-in proxy listener and its `docker events` tail outlived it inside
  //     the hub process;
  //   * a fresh start into a daemon that did not answer ended `failed` where
  //     §8.1 prescribes a bypass, so a 03:00 agent lost its night to a hiccup;
  //   * and the two paths that exist to SAVE a run — the reconfigure and the
  //     break-glass — aborted it, because the session they closed in order to
  //     resume it was reconciled as an end.
  //
  // The observables (a network that is gone, a listener that is gone) need a
  // daemon and belong to the e2e group of the same name. What is asserted here
  // is what can be decided without one.
  {
    const dbu = (await import('../server/db.mjs')).default
    const sess = await import('../server/sessions.mjs')
    const uuid = (await import('node:crypto')).randomUUID
    const facadeSrc = readFileSync(new URL('../server/sandbox/index.mjs', import.meta.url), 'utf8')
    const runnerSrc = readFileSync(new URL('../server/runner.mjs', import.meta.url), 'utf8')

    dbu.prepare(`INSERT OR IGNORE INTO repos(id, name, path, base_branch)
                 VALUES(9701,'leak-test','/tmp/leak-test','main')`).run()
    const neuerLauf = (patch = {}) => {
      const id = uuid()
      dbu.prepare(`INSERT INTO runs(id, repo_id, status, harness, prompt, branch_mode, expected_minutes,
                                    tmux_session, started_at, sandbox, resume_pending)
                   VALUES(?, 9701, ?, 'claude', 'p', 'keiner', 30, ?, datetime('now'), ?, ?)`)
        .run(id, patch.status ?? 'running', patch.tmux_session ?? `fl-leak-${id.slice(0, 8)}`,
          patch.sandbox ?? 0, patch.resume_pending ?? 0)
      return id
    }
    const lauf = (id) => dbu.prepare('SELECT * FROM runs WHERE id=?').get(id)

    await pruefe('a session closed IN ORDER TO resume is not an end', () => {
      // The measured failure, twice on two sandboxes: §7.12.4 marks the row,
      // stops the container and closes the session — and killSessions() landed
      // here, wrote 'aborted', after which resumeRun() refused the run it had
      // just been asked to bring back ("status is aborted") and the agent's
      // conversation was gone.
      const id = neuerLauf({ status: 'running', resume_pending: 1 })
      gleich(sess.reconcileClosedSession(id, 'web'), 'resuming',
        'the third case: neither an end nor a session that went away by itself')
      gleich(lauf(id).status, 'running', 'and the run is still the run resumeRun() may pick up')
      wahr(!!lauf(id).tmux_closed_at, 'the session is recorded as closed all the same')
    })

    await pruefe('…and the guard cannot swallow a genuine abort', () => {
      // Keyed on `resume_pending`, not on the source: nothing that ends a run on
      // purpose — the kill route, the sessions page, retention, archiving, a
      // flow's kill_run, enforceMaxRuntime — ever sets that mark.
      for (const quelle of ['web', 'retention', 'watcher', 'archive', 'max_runtime']) {
        const id = neuerLauf({ status: 'running' })
        gleich(sess.reconcileClosedSession(id, quelle), 'aborted', `${quelle} still ends the run`)
        gleich(lauf(id).status, 'aborted', `${quelle}: and the record says so`)
      }
      // A mark on a run that is already over is not a resume either.
      const fertig = neuerLauf({ status: 'done', resume_pending: 1 })
      gleich(sess.reconcileClosedSession(fertig, 'web'), 'closed', 'a finished run is closed, mark or no mark')
    })

    await pruefe('the per-run network has ONE author, and the reaper is one of its readers', () => {
      // `fl-net-${run.id}` was typed out a second time in stopRunContainer(),
      // and the disagreement such a copy heads for would be silent: a
      // `network rm` of a name nobody created answers "not found", which reads
      // exactly like a network that was already gone.
      const sessSrc = readFileSync(new URL('../server/sessions.mjs', import.meta.url), 'utf8')
      const watchSrc = readFileSync(new URL('../server/watcher.mjs', import.meta.url), 'utf8')
      falsch(/`fl-net-\$\{/.test(sessSrc), 'sessions.mjs no longer spells the name out')
      falsch(/`fl-net-\$\{/.test(watchSrc), 'and neither does the watcher')
      enthaelt(sessSrc, 'rt.networkName(run.id)', 'it asks the module that owns the name')
      wahr(/export function networkName/.test(facadeSrc), 'which exports it')
    })

    await pruefe('the teardown is on the ordinary end paths, not only on a failed launch', () => {
      const sessSrc = readFileSync(new URL('../server/sessions.mjs', import.meta.url), 'utf8')
      const watchSrc = readFileSync(new URL('../server/watcher.mjs', import.meta.url), 'utf8')
      // reconcileClosedSession() is where the kill route, the sessions page,
      // retention and the archive pass all meet, so one wiring covers all four.
      wahr(/function releaseSandbox[\s\S]{0,1600}teardownSandbox/.test(sessSrc),
        'a closed session releases what the sandbox was holding')
      wahr(/reconcileClosedSession[\s\S]{0,2600}releaseSandbox\(runId, source\)/.test(sessSrc),
        'and reconcileClosedSession() is what calls it')
      wahr(/async function releaseReaped[\s\S]{0,900}teardownSandbox/.test(watchSrc),
        'and so does the reaper, once the run’s containers are gone')
    })

    await pruefe('containerGone() is wired where §7.11 says, instead of documenting a rule nothing applies', () => {
      // It had no callers at all: §7.11 names it as reconcileClosedSession()'s
      // second question and orphanedContainer() asked a different one. A
      // function that states a rule nobody applies is worse than no function.
      const sessSrc = readFileSync(new URL('../server/sessions.mjs', import.meta.url), 'utf8')
      const aufrufe = sessSrc.match(/[^.\w]containerGone\(/g) ?? []
      wahr(aufrufe.length >= 2, `declared and called (${aufrufe.length} occurrences)`)
      wahr(/function releaseSandbox[\s\S]{0,600}await containerGone\(run\)/.test(sessSrc),
        'by the session-end path, exactly as the section describes')
      wahr(/gone === false/.test(sessSrc),
        'and the tri-state is read as a tri-state — null writes nothing')
    })

    await pruefe('the launch applies §8.1’s availability rule, not just the plan', () => {
      // Between the plan and the launch lie a cached discovery answer and, for a
      // scheduled run, hours. The rule is the same PURE function in both places,
      // so the two cannot come to mean different things about one fact.
      wahr(/async function sandboxUnavailable[\s\S]{0,900}sandboxOutcome/.test(runnerSrc),
        'launchRun() decides through sandboxOutcome()')
      wahr(/async function sandboxUnavailable[\s\S]{0,900}UPDATE runs SET sandbox=0/.test(runnerSrc),
        'a bypass takes the run’s own flag with it')
      wahr(/refreshSandboxAvailability\(\)/.test(runnerSrc),
        'and it asks before it builds anything')
    })

    await pruefe('a bypass is never silent, and `required` refuses instead', async () => {
      // The pure rule itself, over the matrix that matters at launch: the same
      // function the plan uses, so this is the guarantee and not a copy of it.
      const { sandboxOutcome } = await import('../server/sandbox/index.mjs')
      const weg = sandboxOutcome({ decision: { sandbox: true }, hubMode: 'available',
        available: false, unavailableReason: 'sandbox.reason.no_binary' })
      gleich(weg.sandbox, 0, 'available + no runtime = the run still starts')
      gleich(weg.problems.length, 0, 'and nothing refuses it')
      gleich(weg.events.length, 1, 'but it is written down — exactly once')
      gleich(weg.events[0][0], 'sandbox:bypassed', 'as sandbox:bypassed')
      gleich(weg.events[0][1].by, 'unavailable', 'naming the runtime as the reason')
      const nein = sandboxOutcome({ decision: { sandbox: true }, hubMode: 'required',
        available: false, unavailableReason: 'sandbox.reason.no_binary' })
      gleich(nein.sandbox, 0, 'required + no runtime = nothing starts')
      wahr(nein.problems.length === 1 && nein.problems[0].length > 0, 'with a readable sentence')
      gleich(nein.events.length, 0, 'and no bypass event, because nothing was bypassed')
    })

    await pruefe('a run continued on the host keeps the home it wrote its conversation into', () => {
      // continueWithoutSandbox() keeps `runs.sandbox_home` for exactly this, and
      // HOME was emitted only on the sandboxed branch — so the break-glass
      // resumed the CLI into a home it had never written a byte to, which turns
      // a resume back into the fresh start it exists to avoid.
      wahr(/function hostHomeArgs[\s\S]{0,400}sandbox_home/.test(runnerSrc),
        'the unsandboxed branch has an answer for a formerly sandboxed run')
      wahr(/sandbox \? sandboxEnvArgs\(run, sandbox\) : hostHomeArgs\(run\)/.test(runnerSrc),
        'and it is on the launch line')
      wahr(/function hostHomeArgs[\s\S]{0,400}existsSync\(home\)/.test(runnerSrc),
        'a home that is not on disk is not passed on — that is worse than the host’s')
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: the mask holds')

  // The masked host git is the one place the hub deliberately runs git INSIDE a
  // repository the agent owns — the rescue path an operator reaches by clicking
  // "Commit leftovers & merge" on a run whose container is gone. Everything here
  // is measured against a real repository with a real hostile configuration,
  // and every negative assertion is paired with the POSITIVE CONTROL that shows
  // the payload really does fire when nothing masks it. Without that control the
  // whole group could pass over a payload that was simply never armed.
  {
    const { maskedGitConfigEntries, writeMaskedGitConfig, REPO_CONFIG_FILES } =
      await import('../server/sandbox/clone.mjs')
    const { runGit } = await import('../server/sandbox/exec.mjs')
    const { DEFAULT_SPEC, SPEC_VALUES, narrow, validateSandboxOverrides, normalizeSpec } =
      await import('../server/sandbox/spec.mjs')
    const { existsSync } = await import('node:fs')

    const maskWork = join(sandkasten, 'mask-holds')
    const markers = join(maskWork, 'markers')
    mkdirSync(markers, { recursive: true })
    const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const gq = (dir, ...args) => { try { return g(dir, ...args) } catch { return null } }
    // Which markers fired since the last time this was asked, and reset.
    const fired = () => {
      const names = ['FSMONITOR', 'FILTER', 'DIFFEXT'].filter(n => existsSync(join(markers, n)))
      for (const n of names) rmSync(join(markers, n), { force: true })
      return names.sort().join(',')
    }

    // The evaluator's repository, verbatim: the payload lives in
    // `.git/config.worktree`, which git reads ONLY because
    // `extensions.worktreeConfig` says so — and the filter and the diff driver
    // are selected by a `.gitattributes` the agent COMMITS, so no denylist of
    // config keys could ever see them coming.
    const hostile = join(maskWork, 'clone')
    mkdirSync(hostile, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', hostile], { stdio: 'ignore' })
    g(hostile, 'config', 'user.email', 'a@t'); g(hostile, 'config', 'user.name', 'A')
    writeFileSync(join(hostile, '.gitattributes'), '* filter=wt diff=wtd\n')
    writeFileSync(join(hostile, 'f.txt'), 'content\n')
    g(hostile, 'add', '-A'); g(hostile, 'commit', '-qm', 'init')
    g(hostile, 'config', 'core.repositoryformatversion', '1')
    g(hostile, 'config', 'extensions.worktreeConfig', 'true')
    const worktreeCfg = join(hostile, '.git', 'config.worktree')
    writeFileSync(worktreeCfg,
      `[core]\n\tfsmonitor = touch ${join(markers, 'FSMONITOR')}\n`
      + `[filter "wt"]\n\tclean = touch ${join(markers, 'FILTER')}; cat\n\tsmudge = cat\n`
      + `[diff "wtd"]\n\tcommand = touch ${join(markers, 'DIFFEXT')}\n`)
    writeFileSync(join(hostile, 'f.txt'), 'more\n')          // something for `add -A` to do

    const deadClone = { sandbox: 1, sandbox_container: 'fl-no-such-container',
      worktree_kind: 'clone', workdir_effective: hostile }
    const RESCUE = [['--no-optional-locks', 'status', '--porcelain'], ['add', '-A'],
      ['diff', 'HEAD'], ['checkout', '--', '.']]

    // ---- the positive control, first and on its own -----------------------
    const control = {}
    for (const args of RESCUE) { gq(hostile, ...args); control[args.join(' ')] = fired() }
    const cfgBefore = readFileSync(join(hostile, '.git', 'config'), 'utf8')
    const wtCfgBefore = readFileSync(worktreeCfg, 'utf8')

    await pruefe('POSITIVE CONTROL: the payload really fires when nothing masks it', () => {
      wahr(control['--no-optional-locks status --porcelain'].includes('FSMONITOR'),
        `status runs core.fsmonitor out of config.worktree (${control['--no-optional-locks status --porcelain']})`)
      wahr(control['add -A'].includes('FILTER'), `add -A runs the filter driver (${control['add -A']})`)
      wahr(control['diff HEAD'].includes('DIFFEXT'), `diff runs the external diff (${control['diff HEAD']})`)
      // Which is the whole point: none of those three keys is in `.git/config`.
      falsch(cfgBefore.includes('fsmonitor'), 'and none of it is in .git/config — the mask never saw it')
    })

    // ---- the same four commands through the mask --------------------------
    const masked = {}
    for (const args of RESCUE) {
      const r = await runGit(deadClone, args, { hostFallback: 'masked' })
      masked[args.join(' ')] = { ok: r.ok, fired: fired(), stderr: r.stderr }
    }

    await pruefe('extensions.worktreeConfig does not walk past the mask any more', () => {
      for (const args of RESCUE) {
        const key = args.join(' ')
        gleich(masked[key].fired, '', `${key}: nothing of the agent ran (${masked[key].fired})`)
        wahr(masked[key].ok, `${key}: and the command itself still worked (${masked[key].stderr})`)
      }
    })

    await pruefe('and the agent’s own configuration comes back, both files, byte for byte', () => {
      gleich(readFileSync(join(hostile, '.git', 'config'), 'utf8'), cfgBefore, '.git/config')
      gleich(readFileSync(worktreeCfg, 'utf8'), wtCfgBefore, '.git/config.worktree')
      for (const name of REPO_CONFIG_FILES) {
        falsch(existsSync(join(hostile, '.git', `${name}.freilauf-unmasked`)),
          `no backup of ${name} is left lying next to it`)
      }
    })

    await pruefe('the extensions keep list is an allowlist of FORMAT keys, not "everything"', async () => {
      const src = join(maskWork, 'src.config')
      writeFileSync(src, '[core]\n\trepositoryformatversion = 1\n'
        + '[extensions]\n\tobjectFormat = sha256\n\tworktreeConfig = true\n\trefStorage = reftable\n'
        + '\tsomethingGitInventsNextYear = true\n')
      const keys = (await maskedGitConfigEntries(src)).map(([k]) => k)
      wahr(keys.includes('extensions.objectformat'), 'the hash algorithm travels — dropping it changes what the repo IS')
      wahr(keys.includes('extensions.refstorage'), 'and the ref backend, for the same reason')
      falsch(keys.includes('extensions.worktreeconfig'), 'worktreeConfig does NOT — it names a second config file')
      falsch(keys.some(k => k.includes('somethinggit')), 'and neither does an extension nobody has checked yet')
    })

    await pruefe('an include.path in the source config is dropped, not carried into the mask', async () => {
      // Measured, git 2.43.0: `git config --file <f> --list` does NOT expand an
      // include — so the included file's keys never appear here and only the
      // pointer does. Carrying the pointer would point the masked git straight
      // back at a file the agent wrote, which is `worktreeConfig` again in
      // another spelling.
      const inc = join(maskWork, 'included.config')
      writeFileSync(inc, '[filter "wt"]\n\tclean = touch /tmp/never; cat\n')
      const src = join(maskWork, 'including.config')
      writeFileSync(src, `[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = ${inc}\n`
        + `[includeIf "gitdir:/"]\n\tpath = ${inc}\n`)
      const listed = execFileSync('git', ['config', '--file', src, '--list'], { encoding: 'utf8' })
      wahr(listed.includes('include.path'), 'git lists the pointer itself…')
      falsch(listed.includes('filter.wt.clean'), '…and does not expand it under --file')
      const keys = (await maskedGitConfigEntries(src)).map(([k]) => k)
      falsch(keys.some(k => k.startsWith('include')), 'and the mask keeps neither include.path nor includeIf')
      gleich(keys.join(','), 'core.repositoryformatversion', 'nothing but the format survives')
    })

    await pruefe('a symlink where the mask goes is refused, never written through', async () => {
      const linkWork = join(maskWork, 'symlink')
      mkdirSync(join(linkWork, '.git'), { recursive: true })
      const stolen = join(maskWork, 'stolen.txt')
      const src = join(maskWork, 'plain.config')
      writeFileSync(src, '[core]\n\trepositoryformatversion = 0\n')
      symlinkSync(stolen, join(linkWork, '.git', 'config'))
      let threw = ''
      try { await writeMaskedGitConfig(src, join(linkWork, '.git', 'config')) }
      catch (err) { threw = String(err.message ?? err) }
      enthaelt(threw, 'symlink', 'writeMaskedGitConfig says what it refused')
      falsch(existsSync(stolen), 'and the file the link pointed at was never created')
      // …and the caller turns that into a refusal rather than an exception: an
      // unmasked call must not happen, and neither must a throw out of runGit().
      const r = await runGit({ ...deadClone, workdir_effective: linkWork },
        ['status', '--porcelain'], { hostFallback: 'masked' })
      falsch(r.ok, 'the masked call refuses')
      wahr(r.unknown === true, 'and says "nobody looked", never "clean"')
      falsch(existsSync(stolen), 'still nothing written through the link')
    })

    // ---- the spec values that promised something nobody implemented -------
    await pruefe('filesystem modes are rw or ro — "copy" is gone from both lists', () => {
      for (const path of ['filesystem.worktree', 'filesystem.repoGit', 'filesystem.extras']) {
        gleich(SPEC_VALUES[path].join(), 'rw,ro', `${path} offers only what the runtime implements`)
        // The defect in one line: `rw` → `copy` passed the lock check as a
        // tightening, and the runtime then bound the path WRITABLE, because
        // addMount() treats everything that is not 'ro' as read-write.
        wahr(narrow(path, 'rw', 'copy').refused, `${path}: narrowing to copy is refused`)
        gleich(narrow(path, 'rw', 'copy').value, 'rw', 'and the higher layer’s value stands')
        falsch(narrow(path, 'rw', 'ro').refused, `${path}: the real tightening still works`)
      }
      const { problems } = validateSandboxOverrides(JSON.stringify({ filesystem: { repoGit: 'copy' } }))
      wahr(problems.some(p => p.key === 'sandbox.problem.bad_value'), 'and the form refuses it by name')
    })

    await pruefe('the two inert spec fields are gone from the document, and refused at the form', () => {
      falsch('protected' in DEFAULT_SPEC.filesystem, 'filesystem.protected: nothing read it, and the clone makes it moot')
      falsch('gitFetch' in DEFAULT_SPEC.secrets, 'secrets.gitFetch: nothing read it, and "none" needs the mount gone')
      gleich(DEFAULT_SPEC.secrets.mode, 'env', 'the field next to it is untouched')
      for (const doc of [{ filesystem: { protected: ['.git/hooks'] } }, { secrets: { gitFetch: 'none' } }]) {
        const { problems } = validateSandboxOverrides(JSON.stringify(doc))
        wahr(problems.some(p => p.key === 'sandbox.problem.unknown_field'),
          `${JSON.stringify(doc)} is refused rather than stored and ignored`)
      }
      // A profile stored before the removal still layers the way it did: the
      // value survives normalisation and its narrowing shape is unchanged, so
      // an old row does not suddenly freeze or resolve differently.
      gleich(normalizeSpec({ secrets: { gitFetch: 'mirror' } }).secrets.gitFetch, 'mirror', 'an old profile keeps its value')
      falsch(narrow('filesystem.protected', ['.git/config'], ['.git/config', '.git/hooks']).refused,
        'and an old deny-shaped list still appends')
    })

    // ---- the audit: what the chain CANNOT say ------------------------------
    //
    // A child process, for the reason the two sandbox probes above already
    // state: RUNS_DIR is a module constant read when this file imported
    // util.mjs, so audit files can only be pointed into the sandbox from a
    // process of its own.
    const auditHonest = (() => {
      const work = join(sandkasten, 'audit-honest')
      mkdirSync(work, { recursive: true })
      const script = join(work, 'probe.mjs')
      writeFileSync(script, `
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const serverDir = process.argv[2]
const work = process.argv[3]
const mod = (rel) => import(pathToFileURL(join(serverDir, rel)).href)
const audit = await mod('sandbox/audit.mjs')
const dbmod = await mod('db.mjs')
const db = dbmod.default
const out = {}
const RID = 'dddddddd-1111-2222-3333-444444444444'
const repoId = db.prepare(\`INSERT INTO repos(name,path,base_branch) VALUES('mask-holds','/nowhere','main') RETURNING id\`).get().id
db.prepare(\`INSERT OR REPLACE INTO runs(id,repo_id,harness,prompt,branch_mode,expected_minutes,status,sandbox,sandbox_container)
  VALUES(?,?,'claude','x','keiner',10,'done',1,'fl-dddddddd')\`).run(RID, repoId)
dbmod.addEvent(RID, 'sandbox:policy_changed', { what: 'network.allow' })
dbmod.addEvent(RID, 'sandbox:blocked', { host: 'pypi.example' })
mkdirSync(audit.auditPaths(RID).dir, { recursive: true })
audit.appendAuditFile(RID, 'egress.jsonl', { at: '2026-09-05T10:00:00.000Z', host: 'a', action: 'allow' })
out.kinds = audit.auditKinds(RID)
out.header = JSON.parse(audit.buildAuditChain(RID)[0])
out.eventKinds = audit.buildAuditChain(RID).map(l => JSON.parse(l)).filter(o => o.kind === 'event').map(o => o.data.kind)
// A symlink where an audit line goes: refused, and the target never created.
const stolen = join(work, 'stolen.jsonl')
symlinkSync(stolen, join(audit.auditPaths(RID).dir, 'docker-events.jsonl'))
out.appendThroughLink = audit.appendAuditFile(RID, 'docker-events.jsonl', { at: 'x' })
out.stolen = existsSync(stolen)
process.stdout.write(JSON.stringify(out))
`)
      const sub = join(work, 'sub')
      try {
        return JSON.parse(execFileSync(process.execPath,
          [script, new URL('../server/', import.meta.url).pathname, work], {
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
            env: {
              ...process.env,
              FREILAUF_DATA_DIR: join(sub, 'data'),
              FREILAUF_RUNS_DIR: join(sub, 'runs'),
              FREILAUF_WORKTREES_DIR: join(sub, 'worktrees'),
              FREILAUF_PLUGIN_DIR: join(sub, 'plugins'),
              FREILAUF_SKILLS_HOME: join(sub, 'skillhome'),
              FREILAUF_SKILLS_STATE: join(sub, 'skills-installed.json'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }))
      } catch (err) {
        return { __error: String(err.stderr ?? err.message ?? err).trim() || String(err) }
      }
    })()

    await pruefe('the export carries the events table — the chain cannot say that it does', () => {
      gleich(auditHonest.__error ?? '', '', 'the child process came back')
      // The defect: the query named `created_at`, the column is `ts`, the throw
      // was swallowed and every export silently lost every event — while
      // verifying perfectly, because a chain of header + footer is a valid
      // chain. So the assertion is about the KINDS, not about the hash.
      wahr((auditHonest.kinds ?? []).includes('event'), `an export of a run with events contains them (${JSON.stringify(auditHonest.kinds)})`)
      gleich((auditHonest.eventKinds ?? []).join(','), 'sandbox:policy_changed,sandbox:blocked',
        'both of them, in the order the table has them')
      wahr((auditHonest.kinds ?? []).includes('egress'), 'next to the proxy’s own lines')
    })

    await pruefe('the export says, in its own header, what the chain does not cover', () => {
      const inputs = auditHonest.header?.inputs
      wahr(!!inputs, 'the header carries an `inputs` block')
      gleich(inputs.agent_writable, true, 'and admits the audited run could write these files')
      enthaelt(String(inputs.note), 'not the collection', 'in a sentence a reader who only has the file can act on')
    })

    await pruefe('an audit line is never appended through a symlink', () => {
      gleich(auditHonest.appendThroughLink, false, 'the write is refused and says so')
      falsch(auditHonest.stolen, 'and the file the link pointed at was never created')
    })
  }

  // ------------------------------------------------------------------
  gruppe('Sandbox: the floor holds')
  //
  // §7.3's one rule — a lower layer may only NARROW what a higher one locked —
  // is enforced by `validateSandboxOverrides()`, and that function only judges
  // the lock when it is ALSO handed the baseline the patch narrows FROM
  // (`spec.mjs`: `if (against && lock.length)`). So a caller that passes `lock`
  // and no `against` passes a check that never runs, and five callers did.
  // One of them — the run's own "Reconfigure…" card — reached
  // `changePolicy()`, which merges a patch field by field and narrows nothing
  // of its own, and froze the result into `runs.sandbox_spec` for the rest of
  // the run. This group pins the baseline itself and every caller that has to
  // ask for it; the e2e group of the same name drives the real route.
  {
    const rdef = await import('../server/run-def.mjs')
    const { setSetting } = await import('../server/db.mjs')
    const spec = await import('../server/sandbox/spec.mjs')

    const mitLock = async (lock, fn, extra = {}) => {
      const vorher = {}
      const alle = { sandbox_lock: JSON.stringify(lock), ...extra }
      for (const k of Object.keys(alle)) vorher[k] = ''
      for (const [k, v] of Object.entries(alle)) setSetting(k, v)
      try { return await fn() } finally { for (const k of Object.keys(alle)) setSetting(k, vorher[k]) }
    }

    await pruefe('the baseline is the hub layer the LAUNCH resolves, not an empty document', async () => {
      // The drift: `planSandbox()` builds the hub layer with `sandbox_runtime`
      // and `sandbox_proxy_engine` in it, `sandboxAgainst()` built it with
      // `{}`. Against an empty document the baseline reads as DEFAULT_SPEC —
      // whose runtime is 'docker' — so on a podman hub with `runtime` locked
      // the form accepted `runtime: "docker"` (it changes nothing, it said)
      // and the launch refused it. A form that promises what the endpoint
      // refuses is the drift run-def.mjs exists to prevent.
      await mitLock(['runtime'], async () => {
        gleich(rdef.sandboxHubSpec()?.runtime, 'podman', 'the hub layer carries the configured runtime')
        const against = rdef.sandboxAgainst(null, ['runtime'])
        gleich(against?.runtime, 'podman', 'and so does the baseline the form judges against')
        const { problems } = spec.validateSandboxOverrides('{"runtime": "docker"}', {
          lock: ['runtime'], against,
        })
        wahr(problems.length >= 1, `switching the runtime under a lock is refused at the form (${problems.map(p => p.key).join(', ')})`)
        // And the same document against the OLD, empty baseline was accepted —
        // which is the whole point of naming this test after the baseline.
        const alt = spec.validateSandboxOverrides('{"runtime": "docker"}', {
          lock: ['runtime'], against: spec.resolveSandboxSpec({ hub: { spec: {}, lock: ['runtime'] } }).spec,
        })
        gleich(alt.problems.length, 0, 'the empty baseline saw nothing to refuse — that was the defect')
      }, { sandbox_runtime: 'podman' })
    })

    await pruefe('without a lock nothing is computed, and nothing is refused', () => {
      gleich(rdef.sandboxAgainst(null, []), null, 'no lock, no baseline')
      gleich(rdef.sandboxAgainst(null, undefined) === null || typeof rdef.sandboxAgainst(null, undefined) === 'object',
        true, 'and an absent lock never throws')
    })

    await pruefe('every loosening the evaluator drove is refused against the resolved baseline', async () => {
      // The exact patch, path for path, that walked through the live hub.
      const lock = ['network', 'resources', 'filesystem', 'secrets']
      await mitLock(lock, () => {
        const against = rdef.sandboxAgainst(null, lock)
        wahr(!!against, 'there is a baseline to narrow from')
        const patch = JSON.stringify({
          network: { mode: 'open', auditOnly: true, allow: ['evil.example.com'] },
          resources: { memory: '64g', cpus: 64 },
          filesystem: { readOnlyRoot: false },
        })
        const { problems } = spec.validateSandboxOverrides(patch, { lock, against })
        const wege = problems.filter(p => p.key === 'sandbox.problem.locked').map(p => p.params.path).sort()
        gleich(wege.join(','),
          'filesystem.readOnlyRoot,network.allow,network.auditOnly,network.mode,resources.cpus,resources.memory',
          'each of the six is named on its own, with the value that stands')
      })
    })

    await pruefe('a narrowing under the same lock still goes through', async () => {
      const lock = ['network', 'resources']
      await mitLock(lock, () => {
        const against = rdef.sandboxAgainst(null, lock)
        // none < allowlist, less memory, fewer cpus, audit-only OFF: all of
        // them move toward the strict end. A lock that refused these would be
        // a lock nobody could work under.
        const { problems } = spec.validateSandboxOverrides(
          '{"network": {"mode": "none", "auditOnly": false}, "resources": {"memory": "1g", "cpus": 1}}',
          { lock, against })
        gleich(problems.length, 0, `a tightening is not a loosening (${problems.map(p => p.key).join(', ')})`)
      })
    })

    await pruefe('every caller that passes a lock also passes a baseline', () => {
      // Structural, like the run-definition checklist above: the failure mode
      // is a SIXTH caller written next year that passes `lock` alone, and the
      // only way to catch that is to read the calls rather than the results.
      for (const datei of ['../server/run-def.mjs', '../server/run-edit.mjs', '../server/sandbox/pages.mjs']) {
        const quelle = readFileSync(new URL(datei, import.meta.url), 'utf8')
        let von = 0
        let n = 0
        for (;;) {
          const i = quelle.indexOf('validateSandboxOverrides(', von)
          if (i < 0) break
          von = i + 1
          // Comments and the import line are not calls.
          const zeile = quelle.slice(quelle.lastIndexOf('\n', i) + 1, i)
          if (zeile.includes('*') || zeile.includes('//') || zeile.includes('import')) continue
          n += 1
          const aufruf = quelle.slice(i, i + 600)
          const ende = aufruf.indexOf('})')
          wahr(aufruf.slice(0, ende < 0 ? 600 : ende).includes('against'),
            `${datei}: call ${n} hands over the baseline, or its lock is dead code`)
        }
        wahr(n >= 1, `${datei} really contains a call (guard against a moved function)`)
      }
    })

    await pruefe('a flow step never quietly runs with less protection than it asked for', async () => {
      // It used to answer any problem with '{}' — no tightening at all — and a
      // flow that meant `network.mode: "none"` then started an ordinary run.
      // Every other failure in this feature falls toward MORE protection.
      const lock = ['network']
      await mitLock(lock, () => {
        let msg = ''
        try {
          rdef.defFromFlowProps({ harness: 'claude', prompt: 'x', sandboxOverrides: '{"network": {"mode": "open"}}' })
        } catch (err) { msg = String(err.message) }
        wahr(msg !== '', 'a loosening in a step is refused rather than dropped')
        wahr(msg.includes('network.mode'), `and the reason names the path (${msg})`)
      })
      // The ordinary cases are untouched: nothing said, nothing refused.
      gleich(rdef.defFromFlowProps({ harness: 'claude', prompt: 'x' }).sandboxOverrides, '{}',
        'a step that says nothing about the sandbox goes on saying nothing')
      gleich(JSON.parse(rdef.defFromFlowProps({
        harness: 'claude', prompt: 'x', sandboxOverrides: '{"network": {"mode": "none"}}',
      }).sandboxOverrides).network.mode, 'none', 'and a valid tightening arrives as it was meant')
    })
  }

} finally {
  rmSync(sandkasten, { recursive: true, force: true })
}

process.exit(bericht('Unit tests', start) || (zaehler.fehler.length ? 1 : 0))
