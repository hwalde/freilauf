# Plugin architecture: coding agents and providers

cc-hub treats the supported coding agent CLIs ("harnesses") and the model
providers as **plugins**: one plain-object descriptor per file, collected by a
registry. Adding support for a new coding agent or provider means adding one
file and registering it — the rest of the hub (forms, run start, log detection,
provider pulse, usage panel, database CHECK constraint) follows the registries.

```
server/harnesses/          coding agent plugins
  index.mjs                registry: HARNESS_PLUGINS, getHarness(), detectInstalled()
  claude.mjs  opencode.mjs  hermes.mjs  cursor.mjs
server/providers/          model provider plugins
  index.mjs                registry: PROVIDER_PLUGINS, getProvider(), providerHasKey()
  openrouter.mjs  deepseek.mjs  opencode-zen.mjs
server/coding-agents.mjs   operator configuration (Settings → Coding agents) + seed
server/usage.mjs           aggregates plugin usage() for the UI
```

**Ground rules for plugin files**

- Plugins are pure data plus functions with injected helpers.
- They must **not** import `db.mjs` or `i18n.mjs` — `db.mjs` imports the harness
  registry itself (to keep the CHECK on `agents.harness` in sync), so that would
  be an import cycle. UI strings are therefore expressed as **i18n keys**
  (`hinweisKey`), resolved by the callers.
- Everything a plugin claims should come from an authoritative source (the CLI
  itself, the vendor API, a measured behavior) — see the table in
  [AGENTS.md](../AGENTS.md).

## Coding agent plugin contract (`server/harnesses/<id>.mjs`)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | registry key; also the value stored in `agents.harness` / `runs.harness` |
| `label` | string | display name in the UI |
| `bin` | string | executable checked with `command -v` (install detection in the add dialog) |
| `installHint` | string | one-liner shown when the CLI is not installed |
| `sessionTag` | string | tmux session prefix part: sessions are named `cc-<sessionTag><name>` (`''`, `'oc-'`, `'he-'`, `'cu-'`) |
| `subscription` | boolean | `true` = models come from the account, no provider selection (claude, cursor) |
| `providers` | string[] | provider plugin ids this harness can use (empty for subscription harnesses) |
| `keyFreeProviders` | string[] | subset of `providers` usable **without** an own API key |
| `pulseId(run)` | fn → string\|null | which pulse target to check while this run is active; `null` = explicitly not monitored |
| `pulseTargets` | object | extra pulse targets `{id: {url, okStatus[]}}` beyond the provider plugins (claude contributes `anthropic`) |
| `logPatterns` | `[{typ, re}]` | narrow regexes for the pipe-pane log scan; `typ` ∈ `TYPEN` from `detect.mjs` |
| `turnEndsRun` | boolean (optional) | `true` = the end of a turn ends the RUN, not just a note (`_turn_end` → `finishByTurnEnd()` in `reports.mjs`). Set it when the CLI keeps running after the work is done, so neither `_pane_died` nor `_exit` will ever come — cursor's TUI does exactly that |
| `hookFiles({ccReport})` | fn (optional) | files the hub writes into the workspace before the start: `[{path, content}]`, `path` relative to the worktree. `ccReport` is the absolute path of `cc-report` — hook commands must not depend on `PATH`. An existing file is never overwritten, and `harnessOwnedPaths()` keeps these paths out of the worktree cleanup's dirty check |
| `goal` | `{max, command(condition)}` (optional) | this CLI takes a SECOND prompt, one that says when the run is done — claude's `/goal <condition>`. `max` is the longest condition it accepts, `command()` builds the line. Presence is the whole capability check: the form shows the goal field only for these harnesses (`harnessesWithGoal()`), and `server/goal.mjs` types the line into the session after the start, because a slash command has no CLI flag |
| `promptRules` | string (optional) | extra prompt lines for this harness, appended to the platform rules by `platformSuffix()` — also to a custom template from the settings, because they describe the machine, not the operator's house rules |
| `fetchModels()` | async fn | model list for subscription harnesses (cached by `models.mjs`) |
| `effortLevels()` | async fn (optional) | levels the CLI itself accepts (probed; cached 24 h) |
| `effortOptions({provider, model, helpers})` | async fn | levels for a concrete combination; returns `{stufen, standard?, pflicht?, quelle?, hinweisKey}` — `stufen: null` hides the form field. `helpers` = `{ownLevels, registryEffort, openrouterEffort}` |
| `modelArgs(run)` | fn | CLI arguments for `cc-start`; returns `{args, fehlt}` (`fehlt` = provider ids whose key is missing) |
| `usage()` | async fn | subscription usage for the overview panel, or `null` (see `usage.mjs` for the shapes: `{kind:'claude', five, seven, seven_general, seven_fable, resets_at, plan}` / `{kind:'cursor', plan, spent_usd, included_usd, remaining_usd, cycle_end}`) |

### Adding a new coding agent

1. Create `server/harnesses/<id>.mjs` with the fields above and register it in
   `server/harnesses/index.mjs`.
2. Teach `bin/cc-start` how to launch the CLI (the launch command lines are the
   one part the bash script keeps itself: add a `case` for the harness, its
   autonomous/interactive command and the session tag). This is a known,
   documented limitation of the plugin pattern — the tmux side lives in bash.
3. Add any new i18n `hinweisKey` strings to all three `lang/*.json` files.
4. If the harness reports API errors through a hook of its own, wire it to
   `cc-report _api_error` (see the opencode plugin installed by
   `setup/02-install-scripts.sh`).
5. Ask how a run of this harness **ends**. If the process exits when the work is
   done, `_pane_died`/`_exit` already cover it. If the CLI stays up instead
   (cursor), the harness needs `turnEndsRun` plus a channel that reports the turn
   end — a `hookFiles` entry, and ideally a second, hook-free source; see
   "cursor: when a run is over" in [AGENTS.md](../AGENTS.md).
6. Done: the database CHECK, the settings page, install detection, forms,
   detection patterns and the pulse follow the registry automatically. Configure
   the new coding agent under Settings → Coding agents.

## Provider plugin contract (`server/providers/<id>.mjs`)

| Field | Type | Meaning |
|---|---|---|
| `id` | string | registry key; also the value stored in `agents.provider` / `runs.provider` |
| `label` | string | display name |
| `envKeys` | string[] | env vars holding a credential; passed into the agent session via `cc-start --env` (tmux does not inherit the environment) and used for "is this provider offerable?" |
| `ocPrefix` | string | model prefix opencode uses for this provider (pitfall: Zen is `opencode`, not `opencode-zen`) |
| `mdKey` | string | key of this provider in the models.dev registry (effort levels) |
| `pulse` | `{url, okStatus[]}` | health-pulse endpoint (watcher) |
| `fetchModels(ctx)` | async fn | model catalog; `ctx` = `{json, registry, env}` (`json` = fetch helper with timeout, `registry()` = cached models.dev snapshot) |
| `balance(ctx)` | async fn, optional | account balance in the normalized shape below; `null` = no key, no answer, nothing to report |

### `balance()` — the normalized shape

```js
{
  available: true | false | null,     // the provider's own verdict; null = not reported
  amounts: [{ currency: 'USD', remaining: 12.34, granted: 1.0, topped_up: 11.34 }],
}
```

The shape is normalized rather than passed through because the two providers
that implement it disagree on almost everything: OpenRouter keeps **one** pot,
reports it as **numbers** (`total_credits` minus `total_usage`) and says nothing
about whether calls still go through; DeepSeek reports **strings**, **one entry
per currency** (an account can hold CNY and USD at once) and adds
`is_available`, which no one else has.

Rules a plugin must keep:

- **`granted` / `topped_up` are optional**, `currency` and `remaining` are not.
- **`available: null` means "not reported", never "fine".** Same rule the
  provider pulse follows — a provider that stays silent is not a healthy one.
- **Return `null` rather than an empty result.** A row of zeroes claims a fact
  the endpoint never stated.
- **Do not fold currencies together.** One number for an account holding two
  currencies silently drops one of them.

`server/balances.mjs` aggregates all of it (cached, fail-soft, one row per
provider with its own `ok` flag) for the usage panel and `GET /api/usage`. It
asks only providers that at least one **enabled** coding agent may use and that
actually have a credential — a balance nobody can act on is noise.

**The budget gate does NOT go through that aggregator.** `openrouterGateBlocked()`
in `quota.mjs` calls the plugin directly, because `balances.mjs` reaches the
database via `coding-agents.mjs`, and `db.mjs` imports the harness registry,
which imports `quota.mjs` — routing the gate through the aggregator closes
exactly the cycle this document warns about above.

### Adding a new provider

1. Create `server/providers/<id>.mjs`, register it in
   `server/providers/index.mjs`.
2. Reference the id from the `providers` list of every harness plugin that can
   use it (plus `keyFreeProviders` when no own key is needed).
3. Document the credential env var in `env.example`.
4. Enable the provider per coding agent under Settings → Coding agents.
5. Optional: implement `balance()` — the usage panel then shows it without a
   line of UI code.

## Operator configuration and seeding

`server/coding-agents.mjs` stores which plugins the operator actually enabled
(table `coding_agents`: harness, enabled, providers as JSON). Forms and
`createRun()` only accept configured & enabled coding agents; the provider
dropdown is capability ∩ operator selection ∩ available credentials.

On first start with an empty table the hub seeds from
`~/.config/cc-hub/coding-agents.json` (override: `CCHUB_AGENTS_SEED`):

```json
{ "coding_agents": [
  { "harness": "claude",   "enabled": true, "providers": [] },
  { "harness": "opencode", "enabled": true, "providers": ["opencode-zen", "deepseek", "openrouter"] }
] }
```

The seed never overwrites an existing configuration — operator edits win.
