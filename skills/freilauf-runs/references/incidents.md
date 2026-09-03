# Incidents, anomalies and what they actually prove

Read this when a run is red or yellow, when an incident will not go away, or
when you need to judge whether a detected error is real.

The one rule to carry over from SKILL.md §3: **none of these signals says the
coding agent stopped.** Check liveness first.

---

## Where a detection comes from

An agent that hits a rate limit cannot report it — without an API there is no
tool call. So detection runs from the outside, and the channels differ per
coding agent. That is why the same symptom is trustworthy on one harness and
mere screen text on another.

| source | harness | severity on first sight |
|---|---|---|
| claude `StopFailure` hook → `fl-report _api_error` | claude | **red** — a fixed vendor enum, no guessing |
| claude transcript JSONL (`isApiErrorMessage`, `error`) | claude | **red**, with a timestamp |
| opencode plugin `session.error` → `fl-report _api_error` | opencode | **red** |
| the tmux `pipe-pane` log, scanned per harness pattern | all — and the **only** source for hermes and cursor | **yellow** |
| provider pulse, every 5 minutes | global | red after 2 failures, closes on recovery |

hermes has no hook for API errors (`post_api_request` fires only after success).
cursor has none either, and there is no open pulse endpoint for its API — so the
hub deliberately answers "not monitored" for cursor rather than "healthy".
cursor does at least reject an unknown model loudly and by name.

The log and the transcript are read **by byte offset** (`runs.log_offset`,
`runs.transcript_offset`), so every line is counted exactly once. Every decision
the detector made is appended to `~/agents/runs/<uuid>/detektor.jsonl` — read
that file when you want to know *why* an incident exists.

---

## A yellow log hit turns red only under conditions

```
veto:      measurable work AFTER the last hit  → stays yellow, forever
red if:    ≥ 2 hits within 10 minutes
red if:    ≥ 5 minutes of silence since the hit — but only where activity is measured
otherwise: yellow, and it expires after 30 minutes without recurrence
```

Two subtleties that decide most arguments:

- **Work after the hit vetoes escalation.** An agent that kept producing output
  is demonstrably not blocked by an API error, so the hit was text on its
  screen. Patterns can always be tricked; a run that keeps working cannot.
- **No activity source means UNKNOWN, not silent.** `last_activity_at` is empty
  for hermes by design, so silence is never an argument there — repetition and
  the optional check LLM are the only escalation paths on that harness.

A claude hook report whose `session_id` is not the run's own id is **ignored**:
the agent spawned its own claude (a probe, a test), which inherited the
worktree's hooks and `FL_RUN_ID` but carries a different session id. Its API
errors are the run's subject matter, not the run's provider problems.

---

## Which incidents need a human

| group | types | what it means |
|---|---|---|
| **Needs you** | `auth_error`, `billing_error`, `model_error`, `merge_blocked`, `tmux_gone`, `tmux_unreachable` — **plus any `rot` incident on a run that ended `failed`/`aborted`** | it will not get better by waiting; every following run walks into the same wall |
| **Noticed** | everything else: `rate_limit`, `provider_error`, `provider_down:*`, `unbekannt` | the hub deferred, retried, or the run simply carried on |

A red incident does not page immediately: it has a grace period (default 10
minutes) and is only announced if it is **still open** when it comes due. One
that resolves itself in the meantime never pages, and one that was announced
also announces its own recovery.

---

## Incidents close themselves

The record stays — history, counts, the detector's protocol — but it stops
counting as open:

| situation | closes? |
|---|---|
| the run reached `done` | yes, all of its incidents (except `merge_blocked`) |
| red, run still going | only on **positive evidence**: measurable work after the last occurrence and 10 minutes without recurrence. Silence proves nothing — a genuinely blocked agent is silent too |
| yellow, run still going | 30 minutes without recurrence |
| red on a `failed`/`aborted` run | **no** — that is why the run did not come through |
| `merge_blocked` | never by time: the integrator owns its recovery |
| `provider_down:*` | never by time: the pulse owns its recovery |
| `tmux_gone` / `tmux_unreachable` | never by time: tmux answering again does not undo the sessions that died |

Resolving by hand (`POST /api/incidents/<id>/resolve`) only silences it. A
recurrence **reopens** it and notifies again — the auto-alarm principle.

---

## Anomalies: a separate mechanism

Anomalies are `events` rows on the run, written by the watcher, and they drive
the traffic light rather than the "Needs you" list.

| kind | when |
|---|---|
| `anomaly:no_activity` | no measurable work for the configured stretch |
| `anomaly:soft_overrun` | past 80 % of `expected_minutes` (yellow) |
| `anomaly:overrun` | past 100 % (red, notifies once) |
| `anomaly:followup_soft_overrun` / `anomaly:followup_overrun` | the same two, for an open follow-up commission, counting from the commission |
| `anomaly:quota_full` | the binding claude window is exhausted; the payload names which one |
| `anomaly:session_gone` | the tmux session vanished |
| `anomaly:worktree_dirty` | uncommitted changes left behind |
| `anomaly:unpushed` | commits that exist only on this machine |
| `anomaly:exit_without_report` | the process ended without reporting |

**Retraction renames, it does not delete.** `clearAnomalies()` rewrites the kind
to `cleared:anomaly:…`, so:

- match `anomaly:` as a **prefix of the whole kind**, not as a substring, or you
  will count retracted statements as live ones;
- a raised `expected_minutes`, a `progress` report and a new follow-up
  instruction all retract the overrun pair — and drop the notification flag with
  them, so a genuine overrun of the new duration can page once more.

`anomaly:quota_full` is only ever written for a **claude** run, and only for a
window that binds *that run's model*: the general week binds every claude run, a
per-model week only a run on that model. A run on another harness draws nothing
from those windows and must not be coloured red by them.

---

## Reading it all at once

```bash
fl-api /api/runs/<uuid> > /tmp/run.json
python3 - <<'PY'
import json
r = json.load(open('/tmp/run.json'))
print(r['run']['status'], r['run']['finish_state'], r['run']['merge_status'])
print(r['liveness'])
print([e['kind'] for e in r['events'] if e['kind'].startswith('anomaly:')])
print([(i['typ'], i['schwere'], i['geloest_am']) for i in r['incidents']])
PY
```

An open incident is one with `geloest_am` null.
