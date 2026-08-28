# PLAN — the status sidebar's statistics refresh on their own (tree 3)

## Goal

The status sidebar shows subscription usage (Claude 5h/7d windows, cursor spend)
and provider balances. Those numbers are outdated in practice: the live channel
re-fetches the sidebar only on `run` events, and a long-running agent produces
no events — so the percentages sit frozen at page-load values while quota keeps
burning. Make the sidebar refresh by itself, on a timer, with a server panel
cache that is short enough for the numbers to actually move.

## Depth tree

```
Root: sidebar statistics stale — make the panel refresh on its own clock
├── 1  Server: the panel caches age faster (2 min → 60 s)
│    └── 1.1  usage.mjs + balances.mjs: CACHE_MS = env-overridable 60_000
├── 2  Client: the sidebar re-fetches on its own timer, no run event needed
│    └── 2.1  hub.js live(): setInterval → statusAktualisieren(), interval
│              overridable via window.CCHUB_SIDEBAR_POLL_MS
├── 3  Sandbox: a suite can shorten the server caches
│    └── 3.1  sandkasten.mjs: hubStarten({ env }) merges extra environment
└── 4  Verify
     ├── 4.1  unit suite green (cache window still honored)
     ├── 4.2  browser test: the sidebar shows a changed Claude 5h % by itself,
     │          without a run event
     └── 4.3  e2e suite green
```

## Decisions

- **Client timer is the primary fix.** The gap is that nothing asks the server
  in quiet stretches; a 30 s poll of `/api/fragments/sidebar` closes it. The
  server's panel cache (usage.mjs / balances.mjs) decides how often the vendors
  are really called — the poll just makes sure SOMETHING asks, so the
  stale-while-revalidate refresh runs and the next tick serves fresh data.
- **Cache 2 min → 60 s.** With a 30 s poll, a 2-minute cache would serve the
  same value for two ticks; one minute keeps the displayed numbers within a
  minute of the vendors while bounding the call rate (one refresh per ~90 s).
- **Overrides for the test suite, following the existing `CCHUB_*` pattern:**
  `CCHUB_USAGE_CACHE_MS` / `CCHUB_BALANCE_CACHE_MS` shorten the server caches,
  `window.CCHUB_SIDEBAR_POLL_MS` (set via `addInitScript`) shortens the poll —
  otherwise the browser test would sit out a real minute.
- Poll skipped while the tab is hidden (`document.hidden`); browsers throttle
  timers there anyway.

## Status log

- [x] 2026-08-28: plan written
- [x] 2026-08-28: leaves 1–3 implemented; unit (225), browser (47, incl. the new
      "no run event" value test), e2e (220), proxy (4), deploy (9) green; all
      three gates met
