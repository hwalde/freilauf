# PLAN — central timezone + number/percentage formatting (tree 3)

## Goal

The hub renders times in the server's local timezone and appends raw UTC stamps
in a few places (`… UTC`), while the browser's own relative-time tooltips use the
*client* machine's timezone — so the exact time in a tooltip depends on who asks.
Numbers and percentages are formatted with hardcoded `toFixed()` and ASCII dots,
regardless of UI language. This change makes all of it centrally controllable:
a timezone setting under Settings (default: per UI language) that every time
display follows — sidebar included — and number/percentage formatting that
follows the UI language automatically.

## Depth tree

```
Root: central timezone + number/percentage formatting
├── 1  Format core (server/util.mjs)
│    └── 1.1  timezone state (setTimezone/uiTimezone/validTz), timezoneForLanguage,
│    │        TIMEZONE_OPTIONS
│    │    └── 1.1.1  fmtDateTime uses uiTimezone()
│    └── 1.2  fmtDbUtc (DB UTC string → configured tz), tzAbbrev,
│              fmtNum / fmtPercent / fmtMoney (Intl.NumberFormat per UI locale)
├── 2  Settings + client config
│    └── 2.1  ui_timezone in SETTINGS_KEYS + settingsSave → setTimezone();
│    │        hub.mjs startup applies it (like setLanguage)
│    └── 2.2  settings form block (select + hints), i18n keys settings.format_*
│    │        in en/de/zh
│    │    └── 2.2.1  layout() injects window.FREILAUF_TZ = uiTimezone()
├── 3  Server-side time displays in the configured timezone
│    └── 3.1  usage panel reset/stamp text (pages.mjs) — tz abbreviation instead
│    │        of " UTC"
│    │    └── 3.1.1  lastAnomaly, vorfallZelle, globalesBanner, run chips,
│    │              runMetrics, runEvents, vorfallAbschnitt via fmtDbUtc
│    └── 3.2  flows pages (started/ended/resume, log clock) via fmtDbUtc
├── 4  Numbers & percentages via fmtNum/fmtPercent
│    └── 4.1  quotaBar pct, rail-dot titles, sessions CPU %, run costs,
│             usage panel money, provider balances
└── 5  Client side (public/hub.js)
     └── 5.1  reltime title + zeitText use window.FREILAUF_TZ
     └── 5.2  relative text unchanged (timezone-free by construction)
```

## Decisions

- **Timezone is an explicit setting; the default follows the language.**
  `ui_timezone` (empty = auto). Auto maps German → `Europe/Berlin`, Chinese →
  `Asia/Shanghai`, English → the server's own timezone (current behaviour). An
  explicitly chosen timezone always wins over the language — the language is the
  default, never the override. This is the "an die Sprache koppeln" the request
  asked about, with an escape hatch.
- **Numbers and percentages follow the UI language, no extra setting.** A decimal
  separator is a property of a locale, not of a machine; coupling it to the
  language is the whole point ("das gleiche für Zahlen und Prozentzahlen").
  Implemented through `Intl.NumberFormat(currentLanguage(), …)` in one helper —
  `toFixed` and string `%` concatenation go away, so the same figure reads
  `78.5 %` in English and `78,5 %` in German.
- **`fmtRelativeTime` and the live relative text stay untouched.** A relative
  distance ("4 minutes ago") is timezone-free by construction; only the exact
  timestamps (tooltips, chips, incidents, resets) carry a timezone.
- **Raw " UTC" suffixes become the configured zone's abbreviation.** The reset
  times in the usage panel and the incident stamps appended `UTC` by hand; they
  now render in the configured zone and carry its abbreviation (e.g. `CEST`,
  `GMT+8`), so a converted time cannot be mistaken for a UTC one.
- **Timezone lives in the display layer, not in the data.** DB stays UTC
  (`datetime('now')`); only rendering converts. Schedules (`run_at`,
  `schedule_time`) are entered in the operator's local wall clock and are not
  converted — they describe a local appointment, not an instant.

## Status log

- [x] 2026-08-29: plan written
- [x] 2026-08-29: implemented — format core in util.mjs (setTimezone,
      timezoneForLanguage, uiTimezone, validTz, tzAbbrev, fmtDbUtc, fmtClock,
      fmtDatePart, fmtNum, fmtPercent, fmtMoney, TIMEZONE_OPTIONS);
      settings (ui_timezone key + form block + i18n en/de/zh, hub.mjs startup,
      layout injects window.FREILAUF_TZ); server displays converted (usage panel
      reset/stamp with tz abbreviation, incidents, anomalies, run chips/metrics/
      events, flows pages, incident Telegram); numbers/percentages through
      fmtNum/fmtPercent (quotaBar, rail, cpu, run costs, usage money, balances,
      byteText); hub.js reltime title + zeitText follow FREILAUF_TZ.
      Tests: unit 280, e2e 253, browser 57, proxy 4, deploy 9 all green.
      GATES.md all four met via the checker, evidence rewritten machine-free.
