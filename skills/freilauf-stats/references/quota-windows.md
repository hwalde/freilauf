# Claude's quota windows, and how fresh a number really is

Read this when a quota figure has to be defended: which window binds a run, how
old the number is, why it moved, or why the budget gate deferred something.

Source files: `server/claude-usage.mjs` (the live half), `server/quota.mjs`
(the merge, the window mathematics and the meters), `server/harnesses/claude.mjs`
(the `usage()` and `gate` declarations).

## The three windows

| window | reported as | binds |
|---|---|---|
| 5 hours | `five`, `resets_at` | **every** claude run |
| 7 days, general | `seven_general`, `seven_resets_at` | **every** claude run |
| 7 days, per model | `weekly_scoped[]` — `{label, pct, resets_at, stale, at}` | only a run **on that model** |

`seven` is the **maximum** of the general week and every scoped week. It is the
account's own worst case and is what the folded rail draws with one dot. It is
**not** the window that governs any particular run.

`seven_fable` / `seven_fable_resets_at` still exist as flat fields because the
gate, the cost estimate and `/api/usage`'s consumers name them. They are simply
the scoped window that calls itself Fable — nothing about "Fable" is hardcoded
anywhere in the matching.

## Which window binds a run

Five functions in `server/quota.mjs`, and every caller that knows a model uses
one of them instead of `seven`:

| function | answers |
|---|---|
| `windowAppliesToModel(label, model)` | does this per-model window concern that model? |
| `weeklyWindows(quota, model)` | the general week plus every scoped week that applies |
| `weeklyBinding(quota, model)` | the fullest of those, with its label and reset time |
| `sevenFor(quota, model)` | the same as a bare percentage |
| `sevenForRun(run, quota)` | the same for a run row; a non-claude harness filters nothing |

**The match is on the model IDENTIFIER**, because that is the only thing a run
carries. The account labels its scoped window with a display name (`Fable`);
the same model reaches the CLI as `fable` and as `claude-fable-5`. So the rule
is: a *naming token* of the label (≥ 3 letters) occurring in the identifier.
Words that name no model are filtered out first —
`claude`, `anthropic`, `model`, `models`, `weekly`, `week`, `limit` — because a
window called "Claude Fable 5" would otherwise match every claude identifier
there is.

Two cases answer **yes** deliberately, and both are the conservative direction
(letting a run into a full window costs more than deferring it):

- the run carries **no model** — claude then picks its own default and the hub
  does not know which one;
- the label contains **no naming token at all** (the live parser falls back to
  the surface name or a bare `7d`).

Where this is asked: `budgetGate()` (a block names the window and hands out
*that* window's reset time), `anomaly:quota_full` in the watcher (only claude
runs, and only a window binding that run's model), and both ends of the cost
subtraction `quota7_start` / `quota7_end`.

## Three sources, merged by age

A window's value can come from any of three places, and `claudeQuota()` decides
**per window**:

1. **the live account answer** — `GET https://api.anthropic.com/api/oauth/usage`,
   bearer token out of `~/.claude/.credentials.json`. Its `limits[]` array is
   preferred over the flat keys beside it because it is self-describing: each
   entry carries `group` (`session` | `weekly`), `kind` (`weekly_all` for the
   general week), `percent`, `resets_at`, and for a scoped window the model's
   display name. This is the truth, and it always wins.
2. **the last live answer**, remembered on disk in
   `~/.local/share/freilauf/claude-windows.json` (`FREILAUF_CLAUDE_WINDOWS_JSON`)
   — every window of the last successful answer, the general ones per field, the
   scoped ones per label, each with the epoch-ms it was read. On disk because
   this hub deploys often and a restart would otherwise drop back to older
   knowledge. A remembered window past its own `resets_at` is **forgotten**
   (24 h when it carries none, `FREILAUF_CLAUDE_WINDOW_MEMORY_MS`): stale-but-
   conservative is fine for a display and not fine for a gate that would defer
   runs against a quota that has long since refilled.
3. **`~/.claude/quota.json`** — the fallback. Claude never writes this file: it
   hands the windows to the *status line*, which mirrors them, and only while an
   interactive session is rendering. The per-model entry (`seven_day_fable`) is
   written by a script belonging to an entirely different project.

Where the live answer says nothing, the **newer** of the remaining two wins.
Dating rules for the file: `five_hour` and `seven_day` are dated by the file's
mtime (honest — the status line writes exactly those two), the per-model week is
dated `0` unless its own `fetched_at` says otherwise (the mtime belongs to a
window that entry does not describe).

Anything that is not the current live reading is marked **`stale`** and carries
its `at`; the panel prints "as of …" beside it. Measured, this matters: on
2026-08-28 the panel showed a per-model week at 80 % while the account said
**88 %** — eight points on the window that binds runs on that model, with the
gate deferring at 95 %.

## Five rules the hub keeps

1. **Never write `quota.json`.** It belongs to the status line and to that other
   project's script.
2. **Never refresh the OAuth token.** `expiresAt` is checked and that is all —
   racing claude for its own credentials file could invalidate the operator's
   live session, and no panel is worth that. An expired token means "stay
   silent".
3. **Fail soft in every direction.** No credentials, no network, an HTTP error,
   a renamed field: all mean "no live answer", and `claudeQuota()` is then byte
   for byte the function it was before the live source existed.
4. **The gate stays synchronous.** `claudeQuota()` sits on the launch path, in
   the watcher pass and in the cost calculation, so the *refresh* is async and
   fills a cache (`refreshClaudeLimits()`, called from the watcher and from the
   usage aggregator) while the *read* is not.
5. **A failed refresh backs off.** Each failure doubles the wait
   (2 min → 30 min cap, `FREILAUF_CLAUDE_USAGE_BACKOFF_MS` /
   `…_BACKOFF_MAX_MS`); the vendor's `Retry-After` wins when it is longer, and
   one success clears it. The account really does rate-limit this endpoint.

## Two nulls that lie

- `Number(null)` is `0` **and finite**, and the endpoint sends nulls for windows
  the account does not have (`seven_day_opus: null` sits in the same response).
  Without a guard a missing window arrives as a confident 0 % — which is not
  merely wrong: it counts as an answer and shuts out the fallback for a whole
  TTL.
- An answer carrying **no window at all is not an answer**. `parseLimits()`
  returns `null` for it, so an empty success cannot shadow the file.

## The budget gate in detail

`budgetGate(harness, model, provider)` in `server/scheduler.mjs`:

1. the **coding agent's** own gate, when it declares one — claude and cursor run
   on their own subscription and no provider is involved;
2. otherwise the **model provider's** gate — OpenRouter credits, the DeepSeek
   balance;
3. otherwise `LEGACY_DEFAULT_GATE = 'openrouter'`. History, not preference:
   every provider-based harness ran on OpenRouter before there was a provider
   column, and a hand-typed `openrouter/author/slug` model still arrives with
   `provider = null`.

A known provider that declares **no** gate (opencode-zen reports no balance)
blocks nothing. The on/off switch is handled by the caller, so a plugin cannot
forget it; a gate that throws logs a warning and does not block.

### The declared thresholds

| plugin | key | setting key | default |
|---|---|---|---|
| claude | `gate_on` | `claude_gate_on` | 1 |
| | `five` | `claude_gate_5h` | 90 |
| | `seven` | `claude_gate_7d` | 95 |
| | `fable` | `claude_gate_fable` | `null` → follows the general 7-day threshold |
| cursor | `gate_on` | `cursor_gate_on` | 1 |
| | `pct` | `cursor_gate_pct` | 95 |
| openrouter | `gate_on` | `openrouter_gate_on` | 1 |
| | `min_usd` | `openrouter_min_eur` | 5 |
| deepseek | `gate_on` | `deepseek_gate_on` | 1 |
| | `min_usd` | `deepseek_min_usd` | 2 |

`openrouter_min_eur` holds **dollars**. Renaming a stored key would be a
migration for nothing, which is the same rule that leaves `runs.telegram_on`
named after one channel.

A cleared numeric field falls back to the field's own default: the settings page
writes every input as a string, so `''` has to mean "not set" and never `0`.

`claudeGateBlocked()` measures **each window against its own threshold** — the
5-hour one against `five`, the general week and every non-fable scoped week
against `seven`, a scoped week called Fable against `fable`. The reason names
the blocking windows (`Claude quota: 5h 92 % / 7d Fable 96 %`) and hands out the
blocking window's reset time.

`balanceGateBlocked()` and `usageGateBlocked()` are the two vendor-free meters
behind the rest. Both cache for `METER_TTL_MS` = 2 min, both return
`{blocked: false}` on **no signal** (no plugin, no `balance()`/`usage()`, no
credential, no answer, no earlier answer), and a failed refresh keeps the
previous reading. `unavailableBlocks` is DeepSeek's `is_available === false`.

**The gate does not go through the aggregators** (`usage.mjs` / `balances.mjs`):
it needs one number from one plugin and it sits on the launch path.

## What a block produces

- `runs.status = 'deferred'`
- event `deferred`, payload `{reason, resets_at}`
- a notification (unless the run's `telegram_on` is 0, which mutes every message
  about that run and writes `notify_muted` instead)
- the watcher's `retryDeferred()` asks the same gate every pass and starts the
  run the moment it opens (event `deferred_retry`)
- `POST /api/runs/<id>/start` forces it past the gate (event `forced_start`);
  only a `deferred` run may go, anything else answers 400
