# PLAN — Quick Run → full run form handoff (tree 3)

## Goal

In the Quick Run dialog, the operator can decide "I want more settings" and
open the single-run form as a **full run in a new window**, carrying over the
task (prompt) and the settings already chosen: the favorite's setup (harness,
provider, model, effort, skills, flows), the branch rule and the start time.

## Depth tree

```
Root: Quick Run → /runs/new in a new window, carrying prompt + settings
├── 1  Server: the run form accepts a favorite as its template
│    ├── 1.1  favorites.mjs: favoriteTemplate(fav) — favorite in the agent-row
│    │         shape runDefFields() reads
│    └── 1.2  pages.mjs pageRunForm: prefer ?agent > ?favorite > lastRunChoice
├── 2  Server: the dialog offers the handoff
│    └── 2.1  quickRunDialog: "More settings" button (i18n en/de/zh), CSS
├── 3  Client (public/hub.js)
│    ├── 3.1  QR section: park dialog FormData in sessionStorage, window.open
│    │         /runs/new?repo=&favorite=, close the dialog
│    └── 3.2  /runs/new restore: apply parked fields onto the MAIN form before
│              the start/branch syncs run, then remove the key
└── 4  Verify
     ├── 4.1  unit + i18n suites green
     ├── 4.2  new browser test: handoff carries prompt, branch, start and the
     │         favorite's setup into the new-window run form
     └── 4.3  e2e suite green
```

## Decisions

- **New window** via `window.open(...)` from the click handler — a user gesture,
  so no popup block. `sessionStorage` is copied into the window the opener
  opens, so the parked dialog state reaches the new tab (the flow-parking
  pattern already relies on the same storage).
- **Favorite travels in the URL** (`?favorite=<id>`), not through the parked
  blob: the setup lives server-side and is the form's *template*; the parked
  blob only carries what the dialog itself knows (prompt, branch, start time).
- The parked key `cchub:qrfull` is separate from the flow-parking key
  (`cchub:form:…`), so the two mechanisms cannot collide.
- Restore runs **early** in hub.js, before the start-time and branch syncs, so
  those re-evaluate against the restored values.

## Status log

- [x] 2026-08-28: plan written
- [x] 2026-08-28: all leaves implemented; unit (188), browser (40, incl. the new
      handoff test), e2e (181) green; all four gates met
