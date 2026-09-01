# Plugin architecture: coding agents, model providers and notification channels

Coding agents (the CLI "harnesses" the hub drives in a tmux session), model
providers and notification channels are **plugins**: one plain-object descriptor
per file, collected by a registry. Everything else in the hub — forms, run
start, log detection, the provider pulse, the usage panel, the budget gate, the
hub's own LLM calls, every message it sends a human — consults that registry
rather than naming a vendor.

Until recently the registries were static objects built at import time, and
adding a coding agent meant editing the hub. They are **mutable** now, and a
third party can drop a package on the machine that joins them at startup. That
one change is what the rest of this document is about: what a package looks
like, what a descriptor may declare, what a plugin is handed instead of the
process environment, and which of the old rules survived.

```
server/plugins/
  registry.mjs   THE registry: HARNESS_PLUGINS, PROVIDER_PLUGINS, NOTIFIER_PLUGINS, register/unregister, errors
  manifest.mjs   manifest + descriptor validation — pure, no I/O, unit-testable
  loader.mjs     loadExternalPlugins(): read the plugin directory, validate, register
  install.mjs    install from a directory, uninstall, list packages (broken ones included)
  store.mjs      table plugin_config: enabled, providers, credentials, per-plugin settings
  settings.mjs   plugin-declared SettingField → settings key, value, gate list
  context.mjs    pluginCtx(id): what a plugin is handed instead of process.env / db.mjs
  discovery.mjs  scanSystem(): which CLIs are installed, which credential variables are set
  web.mjs        the Plugins page and its routes
server/harnesses/          built-in coding agents
  index.mjs                front door — re-exports the registry, unchanged for its importers
  claude.mjs  opencode.mjs  hermes.mjs  cursor.mjs
  cli-llm.mjs              spawning a coding agent CLI as a one-shot model source
server/providers/          built-in model providers
  index.mjs                front door — re-exports the registry
  openrouter.mjs  deepseek.mjs  opencode-zen.mjs
server/notifiers/          built-in notification channels
  index.mjs                front door — re-exports the registry
  telegram.mjs             the only built-in one
server/notify.mjs          THE facade: notify(), notifiersConfigured(), sendTest()
server/notifications.mjs   Settings → Notifications, and the setup-wizard dispatcher
bin/fl-notify              the same facade from outside the hub process (deploy scripts)
server/llm/
  json.mjs     tolerant JSON extraction and repair (pure)
  schema.mjs   the minimal JSON-Schema subset: validate/coerce, and explain to a model
  alerts.mjs   throttled, deduplicated alerts for failed LLM calls
server/coding-agents.mjs   the old coding-agent API, now an adapter over plugin_config
server/usage.mjs           aggregates plugin usage() for the UI
server/balances.mjs        aggregates plugin balance() for the UI
```

## What a plugin is, and where it lives

A plugin is a **descriptor object**: data plus functions, with no state of its
own and nothing imported from the hub. It is a `harness` (a coding agent), a
`provider` (a model provider) or a `notifier` (a notification channel); the
three contracts overlap in their optional halves (`credentials`, `settings`) and
differ in everything else.

Built-in plugins live where they always did:

```
server/harnesses/<id>.mjs      shipped coding agents
server/providers/<id>.mjs      shipped model providers
server/notifiers/<id>.mjs      shipped notification channels
```

An external plugin is a **package directory** under the plugin directory
(`FREILAUF_PLUGIN_DIR`, default `~/.local/share/freilauf/plugins`):

```
<FREILAUF_PLUGIN_DIR>/<id>/
    plugin.json     the manifest
    index.mjs       export default { …descriptor }
```

```json
{ "api": 1, "id": "mistral", "kind": "provider", "name": "Mistral",
  "version": "1.0.0", "description": "…", "main": "index.mjs",
  "homepage": "https://…", "author": "…" }
```

`validateManifest()` (manifest.mjs) enforces: `api` must be exactly `1`; `id`
matches `^[a-z0-9][a-z0-9-]{1,39}$`; `kind` is `harness`, `provider` or
`notifier`; `name`
and `version` are present; `main` defaults to `index.mjs` and may neither start
with `/` nor contain `..` — a manifest must not be able to import something else
on the machine. The returned value is a **normalized copy** carrying only the
fields the hub reads, so a manifest cannot smuggle extra keys into the
registry's metadata.

`loadExternalPlugins()` runs in `hub.mjs` **before anything reads the
registry**: a plugin that arrives after the first form was rendered is a plugin
the operator cannot choose. A missing plugin directory is the normal case, not
an error. `FREILAUF_PLUGIN_DIR` has to be a test fence as much as a setting: a
suite that does not point it into its own sandbox loads the operator's real
external packages and stops being reproducible — the same fence
`FREILAUF_AGENTS_SEED` and `FREILAUF_CLAUDE_CREDENTIALS` already are.

**One bad package never costs the hub.** Every step of loading is caught, and
the failure is recorded rather than thrown: a manifest that will not parse, a
`main` that does not exist, a module that throws on import, a descriptor that
fails validation, an id collision. `listPackages()` additionally lists what lies
in the plugin directory and did *not* register, so "I installed it and nothing
happened" has an answer on the Plugins page.

## The registry

`server/plugins/registry.mjs` owns `HARNESS_PLUGINS`, `PROVIDER_PLUGINS` and
`NOTIFIER_PLUGINS`. `server/harnesses/index.mjs`, `server/providers/index.mjs`
and `server/notifiers/index.mjs` are front doors that **re-export those very
objects** — the same identity, not a copy — so all their importers were
untouched by the rebuild and a plugin registered later is simply present in the
object every importer already holds. That is the whole reason the registry is
mutable: by the time a package on disk has been read, every static importer has
long since captured the object.

| Function | Answers |
|---|---|
| `registerPlugin(desc, {source, manifest, dir})` | add a descriptor; `{ok}` or `{ok:false,error}` |
| `unregisterPlugin(id)` | remove an external plugin; a **built-in is refused** |
| `allPlugins()` | every registered plugin with `{id, kind, source, manifest, dir, plugin}` |
| `getPlugin(id)` | one descriptor, whichever kind it is |
| `pluginKind/pluginSource/pluginManifest/pluginDirOf` | its metadata |
| `registryErrors()` / `addRegistryError(where, error)` | every load failure, newest last |
| `harnessIds/getHarness/harnessLabel/goalSpec/harnessesWithGoal/detectInstalled` | the harness half |
| `providerIds/getProvider/providerLabel/providerHasKey` | the provider half |
| `notifierIds/getNotifier/notifierLabel/notifiersWithSetup` | the notifier half |
| `binaryPresent(bin)` | `command -v` — never throws, a missing binary is a normal answer |

**Load order**: the built-ins are registered at module evaluation (they are
static imports of this file), then `loadExternalPlugins()` walks the plugin
directory in `readdir` order. Dotted entries and non-directories are skipped
without complaint; a symlinked package is followed.

**A duplicate id is refused, never overridden.** A package calling itself
`claude` would otherwise be able to replace the coding agent the operator's runs
are started with, and say nothing about it. The refusal is recorded in
`registryErrors()` with which source already holds the id, and the same check
runs a second time in `installFromDirectory()` — *before* anything is copied to
disk, so a colliding package is not even written.

**`registryErrors()` collects instead of throwing**, and that is the point:
errors are developer-facing English sentences, rendered **verbatim** on the
Plugins page next to the package that produced them. They are not UI strings and
are deliberately not translated — a load failure one cannot search for is worse
than an untranslated one.

## Import rules — what changed, and the one trap that is measured

### The CHECK on `agents.harness` is gone

`db.mjs` used to generate a `CHECK(harness IN (…))` on the `agents` table from
the harness registry, which meant `db.mjs` imported the registry. **That import
was the cycle** that made dynamic loading impossible:

- a plugin loaded from disk arrives long after the schema was written, and a
  coding agent that is only known at runtime cannot be named in a constraint
  that is written at schema time;
- plugin files were forbidden to import `db.mjs`, because that closed the ring;
- `quota.mjs` needed a dynamic import to reach a harness;
- the budget gate could not go through `balances.mjs` / `usage.mjs`.

`harnessCheckAufloesen()` in db.mjs removes the clause once and idempotently,
with the same `tabelleUmziehen()` technique the old `harnessCheckErweitern()`
used: the new table header is fetched from `sqlite_master` and edited at that
one spot, so retrofitted columns, defaults and the UNIQUE survive; copying is
column-wise by name. A fresh database never had the clause and is left alone; an
unrecognized shape is left alone too, with a warning — better to touch nothing
than to rebuild a table blindly.

**Nothing is lost.** Which harness is acceptable was never decided by the
database: `runDefFromForm()`, `saveAgent()`, `createRun()` and
`saveCodingAgent()` all validate against the registry and always did. The CHECK
only ever turned a bug into a 500 one layer further down — which is why
`runs.harness` has carried no CHECK since the beginning.

### What a plugin may import

- An **external** plugin may import whatever it likes, `db.mjs` included: the
  cycle is gone. It should not need to — everything it can want arrives in
  `pluginCtx` — and a plugin that imports nothing of ours is the one that
  survives a refactor.
- A **built-in** plugin file (`server/harnesses/*.mjs`, `server/providers/*.mjs`,
  `server/notifiers/*.mjs`) still must not import `db.mjs`, `i18n.mjs`,
  `models.mjs` or `plugins/context.mjs`. They are imported *by* the registry, so
  anything they pull in is pulled in during the registry's own evaluation. UI
  strings are therefore i18n **keys** (`labelKey`, `hintKey`, `hinweisKey`,
  `descriptionKey`), resolved by the callers — and where a plugin renders a
  whole page (a notifier's `setup`), the translator is **handed in** rather than
  imported.
- `server/harnesses/cli-llm.mjs` and `server/harnesses/patterns.mjs` are the two
  shared helpers a plugin file may import, precisely because neither imports
  anything of the hub's. `cli-llm.mjs` repeats the "read a listing through a
  file, not a pipe" detour that also lives in `models.mjs` for exactly this
  reason.

### `claude.mjs` imports `quota.mjs` lazily, and that is load-bearing

`server/harnesses/claude.mjs` reaches `quota.mjs` in three places — the gate's
`check`, `usage()`, and nothing else — and every one of them uses
`await import('../quota.mjs')` rather than a static import at the top of the
file. This is not a style preference. A static import closes this ring:

```
plugins/registry.mjs → harnesses/claude.mjs → quota.mjs
      → plugins/context.mjs → plugins/store.mjs → plugins/registry.mjs
```

`store.mjs` does real work at module evaluation: it creates `plugin_config` and
`discovery` and runs the one-time migration out of `coding_agents`, and that
migration calls `pluginSource()` **back into the registry** — which, on this
path, is still halfway through evaluating its own module body. The bindings it
would need (`META`, `HARNESS_PLUGINS`) are in their temporal dead zone, and the
first thing to touch them dies there. Both places in claude.mjs that need the
windows are `async` anyway, so the lazy import costs nothing.

The rule that follows: **a plugin file that needs something from the hub's own
modules imports it inside the function that uses it.** The provider gates do the
same (`await import('../quota.mjs')` inside `check`), for the same reason.

## The injected context

A plugin never touches `process.env` or `db.mjs` itself. `pluginCtx(pluginId)`
(context.mjs) is what it is handed instead, and that single indirection is what
makes two things work at once: an external package does its job without
importing anything of ours, and the **operator's own credential** — a stored
value, or a differently named environment variable — is honoured everywhere,
because the plugin asks `ctx.secret()` instead of reading a fixed name.

| Member | What it does |
|---|---|
| `json(url, headers = {}, init = {})` | `fetch` with `AbortSignal.timeout` (8 s default, `init.timeoutMs` overrides — an LLM completion needs more than a catalog fetch). A non-2xx answer throws `HTTP <status>`, the one error shape every caller in the hub matches on. The signal is set **after** the init spread, so an init object cannot disarm the timeout |
| `registry()` | the cached models.dev snapshot (6 h; parallel askers share one request; a failed refresh keeps serving the previous snapshot) |
| `provider(id)` | another **provider's** descriptor, or `null` — resolved through the registry at **call** time |
| `env` | `process.env`, for legacy reads — prefer `secret()` |
| `secret(key = 'api_key')` | the resolved credential, or `null` |
| `setting(key, fallback)` | this plugin's own declared setting value |
| `setSetting(key, value)` | write one of this plugin's OWN settings — resolved through the same field declaration, so a declared `settingKey` is honoured in both directions and a plugin can never write another plugin's row. A notifier's setup wizard needs it; there is nothing else it could store its token in |
| `log(msg)` | one fail-soft console line, prefixed with the plugin id |

`json` and `registry` used to be `providerCtx()` in models.mjs; they live here
now and models.mjs delegates, so there is exactly one implementation of the
timeout, of the error shape and of the models.dev cache.

**Credential resolution order** (`credentialValue()` in store.mjs), implemented
once and used by everything:

1. an explicit value the operator stored for this plugin
   (`config.credentials[key].value`);
2. `process.env[config.credentials[key].envVar]` — the variable the operator
   *named* for this plugin;
3. the first of the plugin's own declared `credentials[].envKeys` that is set in
   the environment.

`ctx.setting(key, fallback)` resolves through the plugin's own field
declarations, so a historic `settingKey` is honoured; a key the plugin never
declared falls back to the namespaced `plugin_<id>_<key>`.

`pluginCtx(null)` is legal for the handful of callers that only want the fetch
helper and the registry (the model-catalog fetches predate credentials);
`secret()` then answers `null` rather than guessing.

**`ctx.provider(id)` exists because a static import of it is a cycle.** A
provider-based coding agent has to know a provider's opencode prefix, its
models.dev key and the environment variables it declares — and
`server/providers/index.mjs` re-exports the plugin registry, whose module body
builds `{claude, opencode, hermes, cursor}` out of the very plugin files that
would be importing it. `import { getProvider } from '../providers/index.mjs'` at
the top of `harnesses/opencode.mjs` therefore made that file unimportable on its
own — `ReferenceError: Cannot access 'opencode' before initialization`, and
invisible while the hub runs because the registry is always reached first.
`ctx.provider(id)` resolves at **call** time, which is after every module has
finished evaluating. A plugin that needs the answer where no context is at hand
and an `await` is allowed uses the lazy import instead
(`(await import('../providers/index.mjs')).getProvider(id)`), the same pattern
`quota.mjs` is reached with. **In a synchronous method there is no third way**:
`modelArgs()` without a context has no provider descriptor, so it uses the
provider id verbatim and passes no credential. That is a degradation and not a
lie — `runner.mjs`, the only caller that launches a run, always passes one.

**Who builds a context is a caller, never a plugin.** `models.mjs`,
`quota.mjs`, `balances.mjs`, `usage.mjs`, `scheduler.mjs` and `runner.mjs` each
call `pluginCtx(id)` and pass it in. One detail worth knowing: `runner.mjs`
hands `modelArgs` the context of `run.provider || run.harness`, because the
credential a run needs belongs to the **provider**, not to the coding agent
spawning it.

## Coding agent plugin contract (`server/harnesses/<id>.mjs`)

The minimum `validateDescriptor()` enforces before a harness is registered:
`id`, `label`, `bin`, a boolean `subscription`, an array `providers`, a
non-empty `logPatterns`, and the four functions `modelArgs`, `effortOptions`,
`usage`, `pulseId`. Everything else is optional by design — the hub asks for it
and does without.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | registry key; also the value stored in `agents.harness` / `runs.harness` |
| `label` | string | display name in the UI |
| `bin` | string | executable checked with `command -v` (install detection, discovery scan) |
| `installHint` | string | one-liner shown when the CLI is not installed |
| `sessionTag` | string | tmux session prefix part: sessions are named `fl-<sessionTag><name>` (`''`, `'oc-'`, `'he-'`, `'cu-'`) |
| `subscription` | boolean | `true` = models come from the account, no provider selection (claude, cursor) |
| `providers` | string[] | provider plugin ids this harness can use (empty for subscription harnesses) |
| `keyFreeProviders` | string[] | subset of `providers` this coding agent reaches **without** an own credential. A **declaration**, and the answer of last resort: `modelArgs()` decides "this run is missing a key" on it on the launch path, where nothing may be probed, and the Plugins page falls back to it when `ownCredentials()` cannot be asked |
| `ownCredentials(ctx)` | async fn (optional) | which model providers this CLI holds credentials for **itself** — `null` (could not be asked), `[]` (asked, holds none), or the ids. Cached by `harnessOwnCredentials()` in `models.mjs`; see below |
| `descriptionKey` | i18n key (optional) | 1–3 sentences shown on the plugin's card |
| `credentials` | `[{key, envKeys[], labelKey, helpKey?, required?}]` (optional) | what the operator can configure; see below |
| `settings` | `SettingField[]` (optional) | operator-configurable fields rendered on the plugin's card |
| `gate` | `{label?, switchKey?, fields[], check(ctx, values, run)}` (optional) | the budget gate for runs on this coding agent — claude and cursor declare one |
| `llm` | `{schema, overhead?, models(ctx), complete(ctx, req)}` (optional) | this coding agent can answer the hub's own questions; see below |
| `launch` | `{promptMode, args[], interactiveArgs?, bin?, sessionTag?, installHint?, stderrLog?, submitNudge?}` (optional) | how `bin/fl-start` calls this CLI. **Without it an external coding agent cannot start a run at all**; see "The launch declaration" |
| `pulseId(run)` | fn → string\|null | which pulse target to check while this run is active; `null` = explicitly *not monitored*, which is not the same as healthy |
| `pulseTargets` | object | extra pulse targets `{id: {url, okStatus[]}}` beyond the provider plugins (claude contributes `anthropic`) |
| `logPatterns` | `[{typ, re}]` | narrow regexes for the pipe-pane log scan; `typ` ∈ `TYPEN` from `detect.mjs` |
| `turnEndsRun` | boolean (optional) | `true` = the end of a turn ends the RUN (`_turn_end` → `finishByTurnEnd()` in `reports.mjs`). Set it when the CLI keeps running after the work is done, so neither `_pane_died` nor `_exit` will ever come — cursor's TUI does exactly that |
| `hookFiles({ccReport})` | fn (optional) | files the hub writes into the workspace before the start: `[{path, content}]`, `path` relative to the worktree. `ccReport` is the absolute path of `fl-report` — hook commands must not depend on `PATH`. An existing file is never overwritten, and `harnessOwnedPaths()` keeps these paths out of the worktree cleanup's dirty check |
| `goal` | `{max, command(condition)}` (optional) | this CLI takes a SECOND prompt, one that says when the run is done — claude's `/goal <condition>`. `max` is the longest condition it accepts, `command()` builds the line. Presence is the whole capability check: the form shows the goal field only for these harnesses (`harnessesWithGoal()`), and `server/goal.mjs` types the line into the session after the start, because a slash command has no CLI flag |
| `promptRules` | string (optional) | extra prompt lines for this harness, appended to the platform rules by `platformSuffix()` — also to a custom template from the settings, because they describe the machine, not the operator's house rules |
| `fetchModels()` | async fn | model list for subscription harnesses (cached by `models.mjs`) |
| `effortLevels()` | async fn (optional) | levels the CLI itself accepts (probed; cached 24 h) |
| `effortOptions({provider, model, helpers})` | async fn | levels for a concrete combination; returns `{stufen, standard?, pflicht?, quelle?, hinweisKey}` — `stufen: null` hides the form field. `helpers` = `{ownLevels, registryEffort, openrouterEffort}` |
| `modelArgs(run, ctx)` | fn | CLI arguments for `fl-start`; returns `{args, fehlt}` (`fehlt` = provider ids whose credential is missing). **Two arguments now** — see below |
| `resumeCommand(run)` | fn (optional) | the shell command a HUMAN continues this run's session with, `cd <workdir> && …` included; `null` when the CLI has no reliable way (hermes). Called by `server/integrate.mjs` for every escalation message, the run's detail page and the failed/aborted Telegram texts. Only the plugin knows how its CLI names a session — claude gets `--session-id <run id>` from the hub and can name it back, cursor's id is its transcript's directory, opencode continues the last session of the worktree |
| `usage(ctx)` | async fn | subscription usage for the overview panel, or `null`. Shapes in `usage.mjs`: `{kind:'claude', five, seven, seven_general, seven_fable, weekly_scoped, live, resets_at, plan}` / `{kind:'cursor', plan, spent_usd, included_usd, included_estimated?, remaining_usd, pct, cycle_end}` |

### `modelArgs(run, ctx)` takes a context now

The second parameter is what makes an operator-supplied credential reach a run
at all. `opencode.mjs` and `hermes.mjs` resolve the key as

```js
const key = ctx?.secret?.('api_key')
  || (prov?.envKeys ?? []).map(n => process.env[n]).find(Boolean) || null
```

— `ctx.secret()` first (stored value, named variable, declared variable), the
plain environment read as the fallback for a caller that passes no context (the
unit suite is one). `claude.mjs` and `cursor.mjs` accept the parameter and
ignore it: they run on a subscription and have no provider credential, and the
signature stays the same across the four so a caller never has to ask which kind
it is holding.

Under **which name** the key travels is decided by what the environment already
holds: the names the provider declares that are *set* are passed through as
`--env NAME=value`, so the agent inside the tmux session keeps reading the
variable it knows; only a credential that comes from nowhere else goes out under
every declared name. It has to travel as `--env` at all because **a tmux session
inherits nothing** — a variable that is not passed here does not exist over
there.

### `ownCredentials(ctx)` — who supplies the key, asked instead of guessed

Under every model provider on a coding agent's card the Plugins page prints one
sentence: whose key this provider is reached with. That sentence used to be
derived from `keyFreeProviders` alone and read *"works without an own key"* — a
hard-coded guess about somebody else's configuration, and one that sounds like a
fault report standing next to a provider that works perfectly well.

`ownCredentials(ctx)` is the optional capability that turns the guess into an
answer: the CLI is asked what it actually holds. It is given the ordinary
injected context (`pluginCtx(id)`), so `ctx.env` rather than a bare `process.env`
read is what makes it testable.

| Answer | Means | What the caller does with it |
|---|---|---|
| `null` | the question could not be answered — not installed, never logged in, unreadable, or a store shape this code does not recognise | falls back to the declared `keyFreeProviders`. **Never rendered as a claim**: "unknown" is not something the operator may read as a fact about their machine |
| `[]` | the CLI was asked and holds no credentials at all | a real answer, and printed as one |
| `[providerId, …]` | the providers **of this plugin** the CLI has its own access data for | the row says so (`provider.access_agent_key`), and the card says once that this agent keeps credentials of its own |

Four rules, each of them load-bearing:

- **The caller caches it, not the plugin** — `harnessOwnCredentials(harness)` in
  `server/models.mjs`, through the same cache `effortLevels()` uses (5 min TTL).
  A plugin file may not import that module, and a page renders one card per
  registered harness. The cached value is wrapped in an object on purpose: the
  cache helper treats a bare `null` as "nothing cached", so the *unknown* answer
  would otherwise re-probe on every single render.
- **It is fail-soft in every direction.** A probe that throws is an unknown
  answer, never a failed page — `harnessOwnCredentials()` catches, and
  `providerChoiceBlock()` in `pages.mjs` catches again around the call. A plugin
  that does not implement the capability arrives at `null` by the same route, so
  nothing has to special-case its absence.
- **It may touch the machine, so it is never on the launch path.**
  `modelArgs()` still decides "this run is missing a key" on the declared
  `keyFreeProviders`: a start may not wait on a file read or a spawned process,
  and a declaration cannot fail. The two are the same question asked in two
  places with different budgets — which is exactly why `keyFreeProviders` stays.
- **Only ids ever leave the function.** The store it reads holds the keys
  themselves; a value must never travel towards a page.

**Absence is a legitimate answer.** `hermes.mjs` deliberately declines to
implement it: hermes stores whatever `hermes setup` was given, but nothing about
that location has been measured here, and a capability that guesses is worse than
one that is missing — missing means "ask the declaration", guessed means "the
page states it as fact".

**Why opencode reads `auth.json` rather than parsing `opencode auth list`.** Both
were measured. The command prints a boxed TUI listing carrying the vendors'
*display* names ("DeepSeek") wrapped in ANSI colour codes, so using it would mean
matching prose back onto provider ids — and re-doing that on every wording change
upstream — and it costs a process on top. The file
(`$XDG_DATA_HOME/opencode/auth.json`, else `~/.local/share/opencode/auth.json`)
is keyed by opencode's **own provider id**, which is exactly what the provider
plugins' `ocPrefix` already maps onto, so the mapping is the one the rest of that
plugin uses anyway. The price is a path that belongs to opencode's internals, and
that price is paid by the `null` contract: no file, no permission, or a top-level
shape that is not "provider id → entry" all answer *unknown* instead of the
confident lie "holds nothing".

### The launch declaration

The tmux side lives in bash, and `bin/fl-start` has to keep working with **no
hub behind it** — a human types `fl-start -H opencode` on the command line. So
the four shipped coding agents keep a `case` of their own in that script, and
that case, not the plugin, is what a claude/opencode/hermes/cursor run is
launched from.

**Every other coding agent is launched from its `launch` declaration.**
`launchSpec(harness)` in `server/runner.mjs` resolves it, the hub writes it into
the run directory as `launch.json` (mode `0600`, never into the worktree — a
stray file there counts as uncommitted work at the finish gate), and
`fl-start --spec <file>` reads it with `jq`. `launchable(harness)` asks the same
question **before** a worktree exists, so a coding agent nothing can start says
so instead of leaving a tmux session running nothing.

```js
launch: {
  promptMode: 'argv',                  // argv | stdin | file
  args: [                              // autonomous start
    '--permission-mode', '{mode}',
    { when: 'model',  args: ['--model', '{model}'] },
    { when: 'effort', args: ['--effort', '{effort}'] },
    '{prompt}',
  ],
  interactiveArgs: [ … ],              // optional; default: `args` without the prompt
  // bin, sessionTag, installHint fall back to the descriptor's own fields
  stderrLog: '{home}/.cache/myagent/{session}.log',   // optional, appended with 2>>
  submitNudge: { waitFor: 'ctrl+p', timeoutSec: 90 }, // optional, see below
}
```

- **An entry is a string or a conditional group.** `{ when, unless, args }` names
  one of `model | provider | effort | prompt | session_id | settings` and asks
  whether it is set. Placeholders inside a string: `{model} {provider} {effort}
  {mode} {session_id} {settings} {workdir} {session} {prompt_file} {stderr_log}
  {home}`.
- **`{prompt}` must be a WHOLE argument**, never part of one — fl-start
  substitutes the shell variable holding the text there, and an interactive start
  simply drops that argument.
- **`promptMode`** decides how the text arrives: `argv` puts it in the `{prompt}`
  argument, `stdin` feeds it in with a here-string (a here-string and not a pipe,
  so the CLI still becomes the pane's own process and `pane-died` keeps meaning
  what it means everywhere else), `file` hands over `{prompt_file}` and leaves
  the file in place for the CLI to read.
- **An option whose placeholder the spec never mentions is REFUSED**, not
  silently passed through — the same rule as `--effort` for cursor. A declaration
  that says nothing about `{effort}` means this CLI has no effort flag, and a
  form that offered one would be lying.
- **`sessionTag` is what keeps `fl-attach` and `fl-kill` honest.** Sessions are
  named `fl-<sessionTag><name>`; fl-start appends `<id>:<tag>` to
  `~/.local/share/freilauf/harness-tags` (`FREILAUF_HARNESS_TAGS`) the first time it
  launches such an agent, and `bin/fl-harness-tags.sh` reads that file. Those two
  scripts read tmux, not the hub's database — without the tag file a `fl-fa-*`
  session answers "claude", which is what the untagged name has always meant.
- **`submitNudge`** is the generic form of the Enter that opencode needs: wait
  for a string to appear on the pane, then press Enter once. A TUI that swallows
  a long prompt needs it, and a declaration is the only way a coding agent this
  script has never heard of can ask for the same thing. Only the object form is
  passed through — fl-start asks `jq` for `.submitNudge.waitFor`, and a bare
  `true` would be an error there rather than a default.

The built-in plugins declare `launch` anyway (claude's is next to its `case`'s
command line, and both produce the same argv). It is not read for them —
`launchSpec()` returns `null` for the four fl-start knows — but it is the shape a
third party's coding agent is read from, written down where the rest of that
plugin lives. **Keep the two in step if a command line ever changes.**

## Model provider plugin contract (`server/providers/<id>.mjs`)

The minimum: `id`, `label`, a `fetchModels` function, and either `envKeys` or
`credentials`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | registry key; also the value stored in `agents.provider` / `runs.provider` |
| `label` | string | display name — it is a column heading in a 268 px sidebar, so keep it short |
| `envKeys` | string[] | env vars holding a credential; passed into the agent session via `fl-start --env` and used for "is this provider offerable?" |
| `credentials` | `[{key, envKeys[], labelKey, helpKey?, required?}]` (optional) | the same thing, declared: what the Plugins page renders and what `ctx.secret()` resolves through. A provider that declares only `envKeys` is read as one credential called `api_key` (`credentialSpec()`), so every caller sees one list instead of two cases |
| `descriptionKey` | i18n key (optional) | 1–3 sentences on the plugin's card |
| `ocPrefix` | string | opencode's **own** id for this provider: the model prefix, and the key its credential store is keyed by — which is what `ownCredentials()` reads (pitfall: Zen is `opencode`, not `opencode-zen`) |
| `mdKey` | string | key of this provider in the models.dev registry (effort levels) |
| `pulse` | `{url, okStatus[]}` | health-pulse endpoint (watcher) |
| `settings` | `SettingField[]` (optional) | operator-configurable fields on the plugin's card |
| `gate` | `{label?, switchKey?, fields[], check(ctx, values, run)}` (optional) | the budget gate for a run drawing on this provider |
| `llm` | `{schema, overhead?, models(ctx), complete(ctx, req)}` (optional) | this provider can answer the hub's own questions |
| `fetchModels(ctx)` | async fn | model catalog |
| `balance(ctx)` | async fn (optional) | account balance in the normalized shape below; `null` = no key, no answer, nothing to report |

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

### OpenRouter best-provider routing (`routing` capability)

The third optional provider capability, beside `balance` and `llm`. The
OpenRouter catalog serves one model from many hosting vendors, and those
disagree in quantization (fp4 … bf16), price (up to 3× for the same weights) and
health (`status`, `uptime_last_30m`) — none of which the free routing decides
in the caller's favour. The hub therefore ships an automatic best-provider
selection, ported from a measured in-house algorithm (a production pipeline's
LLM client and model preflight) and generalized from its fixed
fp8 policy:

```js
routing: {
  parseConfig, endpointFits, quantizationsFrom,   // re-exports of the pure module
  async resolve(ctx, modelId, cfg, { refresh }) → { ok, order, best, quant, prices, dropped, cached, veraltet, at },
  async resolveForRun(ctx, modelId, storedRouting),   // the run shape (start path)
}
```

- **The decision rule lives in `server/providers/openrouter-routing.mjs`**, a
  module that imports nothing of the hub, so the provider plugin, the harness
  plugins and the unit suite judge one endpoint list by ONE code. Eligible :=
  quantization **known** (null/unknown is never a match — the measured
  fallstrick: OpenRouter routes null to the strongest quantized host) ∧ at
  least `quant_min` ("fp8 or better" — a lower bound computed from one rank
  table, never an enumeration the future ages out) ∧ healthy (`status >= 0`,
  uptime ≥ 90 % when reported) ∧ tool support ∧ region ∧ price caps. Ranked:
  without a minimum, the BEST quantization a healthy provider serves wins
  before price breaks the tie; with a minimum everything at or above it
  competes on price. The result is an ordered chain (`provider.order` +
  `allow_fallbacks: false`), not one name — a one-name list is the failure mode
  the source algorithm measured as "one 429 and the whole run falls".
- **Cached per model+config** (`~/.local/share/freilauf/openrouter-routing.json`,
  `FREILAUF_OR_ROUTING_JSON`), TTL 24 h: the same model with the same requirements
  gets the SAME order on the next run, not a re-rolled one. A failed fetch
  serves the stale answer marked `veraltet` — never a fresh failure dressed up
  as a selection.
- **The requirements the form asks for** (`or-routing` fieldset, mode "auto",
  folded away): minimum quantization (a lower bound on the same scale the
  parser normalizes fp4/fp5/q4/nf4/mxfp4/int8/fp8/bf16/… onto), provider region
  (US / EU / DE / China; a provider the region map cannot place is dropped),
  max input and output price (USD per million tokens). Providers reporting no
  quantization are always out — `quantization: null` means "no statement", not
  "unquantized".
- **Only opencode receives it per run.** The pin and the auto config travel in
  `OPENCODE_CONFIG_CONTENT`
  (`provider: { order, allow_fallbacks: false, quantizations? }`); hermes has
  no per-run provider routing (only its global failover config), and claude and
  cursor run on subscriptions. The form shows the block for OpenRouter on every
  harness and says where it cannot take effect.
- **The resolution happens at start, once** (`resolveRouting()` in
  `scheduler.mjs`, before `createRun`), and is frozen into the run's definition
  copy: the run page shows what it really launched with. Fail-soft by
  construction — any failure launches unpinned and logs the reason; a start
  never fails on its own convenience feature.
- The hub's own LLM jobs accept `auto` in their serving-provider fields
  (`llm_*_or_provider`), resolved by the same cache in `complete()` — default
  requirements, per model.

## Notifier plugin contract (`server/notifiers/<id>.mjs`)

The minimum `validateDescriptor()` enforces: `id`, `label`, and a `send`
function. Everything that makes a channel configurable is optional, because the
smallest useful notifier is a webhook with a URL in a setting and a `send` that
posts to it.

**Notifications are optional, and that is a contract too.** A hub with no
notifier configured schedules, watches, merges, records and reports exactly as
one with three — it simply says nothing out loud. Nothing in the hub treats that
as a problem: no banner, no warning, no required step in the Welcome wizard, no
error from any call site. Whatever you write here must keep that true.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | registry key; also the directory name of an external package and the last path segment of its setup wizard |
| `label` | string | display name on the Notifications page |
| `descriptionKey` | i18n key (optional) | 1–3 sentences on the channel's card |
| `settings` | `SettingField[]` (optional) | operator-configurable fields, the same shape the gates use — including the `settingKey` escape hatch. A field marked `required: true` is part of the default answer to "is this channel configured?" |
| `credentials` | `[{key, envKeys[], labelKey, helpKey?, required?}]` (optional) | exactly the provider declaration, rendered by the same block and resolved through `ctx.secret()` |
| `configured(ctx)` | fn → boolean (optional) | overrides the default readiness rule below, for a channel whose readiness is not a matter of filled-in fields |
| `send(message, ctx)` | async fn | **the contract.** Deliver one normalized message; return `{ ok, error? }` |
| `test(message, ctx)` | async fn (optional) | what the "send test message" button calls; without it the button calls `send`. **Same signature as `send`** — the facade calls whichever exists with the same two arguments |
| `setup` | `{ labelKey?, render, actions?, json? }` (optional) | a server-rendered setup wizard the plugin brings; see below |

### The message

`send()` receives one normalized object. The hub composes it; how it is rendered
belongs entirely to the channel — Telegram turns it into escaped HTML with an
inline button, a webhook would turn it into JSON, an SMTP notifier into a
subject and a body.

```js
{
  kind: 'run' | 'incident' | 'llm_alert' | 'flow' | 'repo' | 'deploy' | 'test' | 'system',
  text: 'the message, plain text, newline-separated',
  html: null,                       // optional pre-rendered HTML; the hub never sets it
  url: 'https://hub…/runs/<id>',    // optional deep link
  linkLabel: 'Open detail page',    // translated label for that link
  runId: '<uuid>' | null,           // the run this is about, when there is one
  attachment: { fileName, content } | null,
}
```

Four rules a `send()` must keep:

- **Never throw for a delivery that merely failed.** `{ ok: false, error: '…' }`
  is the answer; the facade logs it through a throttle and carries on with the
  other channels. A thrown error is caught too, but it costs the error message
  its shape. Add `errorKey: 'my.key'` when the failure has a NAME the operator
  should read in their own language ("no bot token saved") — the "send test
  message" button renders it, and an untranslated `error` there would be English
  on a German page. `error` stays as the developer-facing fallback, and a
  package that knows nothing about i18n still produces something readable.
- **`text` is the content, `html` is a courtesy.** The hub composes plain text
  and nothing else, so a channel that renders only `html` would render nothing.
- **The attachment is optional to USE.** It exists because a report has to
  arrive complete and most channels truncate; a channel with no file concept
  ignores it, and one that has to choose sends the text and appends the file
  only when the text really does not fit (Telegram's rule: over 4096 characters,
  or a file worth more than ~3000).
- **`url` is a link, not a promise.** Render it as a button, append it to the
  text, or drop it.

### Is it configured?

`notifierConfigured(id)` (notify.mjs) is the question that decides whether the
hub speaks at all, and the default rule reads the declaration: every `required`
setting must hold a non-empty value, and every `required` credential must
resolve. A plugin may answer for itself with `configured(ctx)`. Anything that
throws while being asked is "not configured" — a broken channel is not a reason
to fail a run.

**A registered notifier is ENABLED by default**, like a model provider and for a
reason one step stronger: an installation that already had a token in `settings`
has no `plugin_config` row for it either, and an off-by-default notifier would
silence a channel that worked the minute before the upgrade. Enabled is not
configured; the fresh installation stays quiet all the same.

### `setup`: a wizard the plugin brings

Some channels need more than a form — Telegram wants a BotFather token, then a
chat id read out of `getUpdates`, then a test message. That is knowledge about
Telegram and it travels with the plugin:

```js
setup: {
  labelKey: 'notify.setup_open',
  async render(ctx, page, url) { return '<div class="card">…</div>' },
  actions: { token: async (ctx, page, body) => ({ ok: true }) | ({ error: '…' }) },
  json:    { chats: async (ctx, page, url) => ({ status?, body }) },
}
```

The hub serves three routes for it, and nothing else:

| Route | Calls |
|---|---|
| `GET /settings/notifications/<id>` | `setup.render()`, wrapped in the ordinary layout |
| `POST /settings/notifications/<id>/<name>` | `setup.actions[name]` — `{ error }` renders a problem page, anything else redirects back to the wizard |
| `GET /settings/notifications/<id>/json/<name>` | `setup.json[name]` — its `body` is sent as JSON |

`test` is offered to every wizard **without the plugin declaring it**: sending
one message is the last step of every setup there is.

`page` is `{ t, e, base }` — the translator, the HTML escaper, and this
plugin's own base path. Handing the translator IN is what lets a *built-in*
plugin render a translated page without importing `i18n.mjs`; the import rule
above is not negotiable, and a wizard that could only speak English would be a
poor trade for it. Writing goes through `ctx.setSetting()`, so a wizard can only
ever store its own plugin's settings.

An external plugin cannot add server routes of its own — these three are all
there is. For most channels that is plenty: a webhook, a Slack app or an SMTP
sender is fully described by `settings` and `credentials`, and needs no `setup`
at all.

### The facade: `server/notify.mjs`

Nothing in the hub imports a notifier. Every message goes through one function,
and that indirection is what makes the channel swappable *and* optional.

| Function | Answers |
|---|---|
| `notify(message)` | send to every enabled, configured notifier — in parallel, every failure caught. `{ sent, delivered, results }`; never throws |
| `notifyLong(text, {fileName, fileContent, url, kind, runId})` | the same, in the shape the report callers think in |
| `notifiersConfigured()` | would a message go anywhere at all? |
| `configuredNotifiers()` / `notifierPlugins()` / `notifierConfigured(id)` | the list, and the readiness of one |
| `sendTest(id)` | the "send test message" button; names `disabled` / `not configured` rather than reporting a success nobody had |
| `notifyOnFor(runId)` / `notifyMuted(runId)` | the per-run checkbox under the terminal |
| `publicBase()` / `detailUrl(runId)` | re-exported from `util.mjs`, where they belong: a link is a fact about the installation, not about a channel |

Per-notifier failures are logged **through a throttle** — one line per
`(notifier, reason)` per ten minutes, with what was suppressed named in the next
one. A wrong token fails on every single message the hub sends, and a journal
that repeats that is a journal nobody reads (the same argument `llm/alerts.mjs`
is built on, one layer out).

**The per-run dedupe is deliberately NOT here.** `notifyRun()` in `reports.mjs`
owns it, because "has the operator been told this once?" is a fact about the
RUN. Its flag is the event `notified:<type>`; the old name `telegram_sent:<type>`
is still read, so a run that was told about its overrun before the rebuild is
not told again after it. The column behind the per-run checkbox is still
`runs.telegram_on` — renaming a column means rebuilding the table, which is the
same "a migration for nothing" rule that leaves `openrouter_min_eur` holding
dollars.

### `bin/fl-notify`: the facade from outside

`bin/freilauf-deploy` has to be able to report a failed deploy at a moment when the
hub may be the thing that is down, so it cannot POST to it. It used to read
`telegram_token` and `telegram_chat` out of the SQLite database and curl the Bot
API — a second, independent Telegram implementation in bash that no facade could
reach and no other channel could be added to.

`fl-notify "<text>" [--url u] [--kind k] [--run id] [--file f] [--strict] [--quiet]`
loads the plugin directory and calls the same facade. It finds the hub's modules
via `FREILAUF_ROOT`, then its own checkout, then `FREILAUF_DEPLOY_DIR` /
`~/agents/deploy/freilauf`, then `~/projects/freilauf`, and confirms each candidate
by `server/notify.mjs` actually being there. Exit `0` when delivered **or when
nothing is configured** — both are fine, and a deploy must not fail because
there is nobody to tell; `--strict` turns the second one into a `1`.

## Gates: the budget gate is plugin-declared

`budgetGate(harness, model, provider)` in `scheduler.mjs` keeps its signature
and its behaviour, and stopped knowing any vendor. It used to be an if-chain on
the four literals `'claude'`, `'cursor'`, `'deepseek'`, `'openrouter'`, with the
thresholds read in the scheduler and the logic in `quota.mjs` — so an installed
plugin could not bring a gate of its own, and the settings page carried a "quota
threshold" field nothing ever read.

**Routing** — what the run draws from decides which gate is asked:

1. the **coding agent's** gate, when it declares one. claude and cursor run on
   their own subscription and no provider is involved at all.
2. otherwise the **model provider's** gate — OpenRouter credits, the DeepSeek
   balance. A known provider *without* a gate (opencode-zen reports no balance)
   draws on nothing the hub can meter, and answers `null`.
3. otherwise `LEGACY_DEFAULT_GATE = 'openrouter'`. This is history, not a
   preference: every provider-based harness ran on OpenRouter before there was a
   provider column, and a hand-typed `openrouter/author/slug` model still
   arrives with `provider = null`. Dropping the fallthrough would let exactly
   those runs start into an empty account.

**The declaration:**

```js
gate: {
  label: 'Cursor',            // optional — what the reason line calls this account
  switchKey: 'gate_on',       // optional — the field key of the on/off switch
  fields: [ SettingField, … ],
  async check(ctx, values, run) { … }   // → null (open) | { reason, resets_at? }
}
```

- **`fields` are rendered under Settings → Budget gates** for every registered,
  enabled plugin that declares them (`gatePlugins()`), and every declared key
  joins the settings allowlist (`allPluginSettingKeys()`).
- **`values` are typed before `check` sees them** (`gateValues()` in
  scheduler.mjs): a `switch` becomes a boolean, a `number` a number, anything
  else the stored string. A field the operator **cleared** falls back to the
  field's own `default` — the settings page writes every input as a string, so
  `''` has to mean "not set" and never `0`. A field whose default is `null`
  stays `null` on purpose: that is how claude's fable threshold says "follow the
  general 7-day one", a fallback only the plugin can compute.
- **The on/off switch is handled by the caller, not by `check`.** `askGate()`
  reads `values[switchKey]` and returns `null` without asking the plugin, so a
  plugin cannot forget it — switching a gate off *is* the decision that this
  window does not govern starts.
- **`run` is `{harness, model, provider}`.** It travels because claude's answer
  depends on the MODEL: a Fable week at 96 % says nothing about a run on Sonnet
  (see "Which 7-day window binds" in [AGENTS.md](../AGENTS.md)).
- **A gate that throws does not block.** `askGate()` catches, warns with the
  plugin id, and answers `null`. A broken plugin is a reason to say so in the
  log, never to stop the hub starting runs.

### `settingKey`: the escape hatch that keeps history

```
SettingField = { key, type: 'number'|'text'|'password'|'select'|'switch',
                 default, labelKey, hintKey?, options?, min?, max?, step?, settingKey? }
```

A field without `settingKey` is stored as `plugin_<id>_<key>`, which is what
makes two plugins declaring a field called `threshold` harmless. A field **with**
one is stored under exactly that name — and that is why the rebuild needed no
settings migration at all: the built-in gates declare the keys they have always
used (`claude_gate_on`, `claude_gate_5h`, `claude_gate_7d`,
`claude_gate_fable`, `cursor_gate_on`, `cursor_gate_pct`, `cursor_included_usd`,
`openrouter_gate_on`, `openrouter_min_eur`, `deepseek_gate_on`,
`deepseek_min_usd`). `openrouter_min_eur` holds a **dollar** figure and keeps
its name for the same reason: renaming a stored key would need a migration for
nothing.

### The generic meters in `quota.mjs`

The gate logic moved into the plugins; what stayed behind in `quota.mjs` is the
claude-window mathematics and **two meters that name no vendor**:

| Function | Measures | Used by |
|---|---|---|
| `balanceGateBlocked(pluginId, {minimum, currency, unavailableBlocks, label})` | the plugin's `balance()` | openrouter, deepseek |
| `usageGateBlocked(pluginId, {threshold, includedFallback, label})` | the plugin's `usage()` — spend ÷ included amount of the running period | cursor |
| `claudeGateBlocked(quota, model, {five, seven, fable})` | the claude windows, each against its own threshold | claude |
| `providerRemaining(pluginId, currency)` | one cached balance reading (2 min TTL) | the two above |

`unavailableBlocks` is for the one provider that reports a verdict of its own:
DeepSeek's `is_available === false` outranks the figure next to it, because
promotional credit expires while the number still looks healthy.

**No signal never blocks.** No plugin, no `balance()`, no credential, no answer
and no earlier answer all end in `null`, and a gate that blocked on any of them
would defer runs over a provider it simply cannot see. A failed refresh keeps
the previous reading — it is still the best there is.

**The gate still asks the plugin directly, not the aggregators.**
`balances.mjs` and `usage.mjs` reach the database through `coding-agents.mjs`,
and the gate sits on the launch path; one number from one plugin does not need
an aggregator. `openrouterGateBlocked`, `deepseekGateBlocked` and
`cursorGateBlocked` still exist as one-line wrappers, and the reason is
specific: the unit suite cache-busts `quota.mjs` to get a fresh meter cache per
case, and a delegation into the plugin would import the un-busted module back
and hand it the previous case's reading.

## The `llm` capability: the hub's own questions

The hub asks a small model a few things of its own — a name for each run,
whether a log line is a real outage, what a report contains, which worktree
extras a repository wants. All four calls used to be hardcoded OpenRouter, each
with its own copy of the request and its own error style. A plugin that declares
`llm` can answer them instead.

```js
llm: {
  schema: 'native' | 'json_object' | 'prompt',
  overhead?: true,
  async models(ctx),                 // → [{id, name}]
  async complete(ctx, req),          // → { text, usage?, raw? }   throws on failure
}
```

### The three `schema` modes

`schema` is a **declaration of what the source can enforce**, and the layer
above (`server/llm`) picks its strategy from it:

| Value | What the adapter does | Who declares it |
|---|---|---|
| `native` | pass the JSON schema over the wire — `response_format: {type:'json_schema', json_schema:{name, strict:true, schema}}`, or claude's `--json-schema` flag | openrouter, claude |
| `json_object` | ask for valid JSON without a schema (`response_format: {type:'json_object'}`); the **shape** still has to be described in the prompt | deepseek |
| `prompt` | nothing at all — the strict instructions and the schema description are the only thing there is | opencode-zen, opencode, hermes, cursor |

Declaring less than the truth costs a paragraph of tokens; declaring more than
the truth means a mode that is **silently ignored**, and then the caller skips
the strict prompt as well. opencode-zen declares `prompt` for exactly that
reason: it is a proxy in front of many upstream models and documents nothing
about `response_format`.

**`native` means the schema travels natively — not that the model obeys it.**
claude's `--json-schema` is implemented as a **forced tool call**, and a model
may decline a tool. Measured: five runs of one adversarial prompt on `haiku` —
four came back `stop_reason: tool_use` with a conforming `structured_output`,
the fifth came back `stop_reason: end_turn`, with **no** `structured_output` at
all and prose sitting in `result`. So `native` is the right declaration (the
schema really does go over the wire, and the strict paragraph really is
unnecessary), and "it enforces the schema" would be one word too strong.

What makes the mode reliable is what stands behind it, and both halves are
load-bearing: the claude adapter reads `structured_output` and, when it is
absent, hands back `j.result` as the answer text instead of an empty one — so
the declining run's prose reaches the layer above rather than vanishing — and
`server/llm` then reads that text tolerantly (`json.mjs`) and, when it is really
not JSON, reprompts **once** with the exact complaint. A `native` source
therefore still goes through the tolerant reader and the validator like every
other one; nothing in `server/llm` is skipped for it except the strict prompt.

### The `req` a `complete()` receives

| Field | Meaning |
|---|---|
| `model` | the model identifier, in whatever shape this source names its models |
| `system` | system text. A source with no system-prompt flag folds it into the prompt itself (`${system}\n\n${prompt}`) |
| `prompt` | the user prompt |
| `schema` | the JSON schema, when the caller wants structured output. **Its presence is the request for strict mode** — that is what `json_object` keys off |
| `schemaName` | a name for the schema (`native` sources pass it along) |
| `maxTokens` | default 1000 in the HTTP adapters |
| `temperature` | default 0 |
| `timeoutMs` | 60 s for an HTTP provider, 180 s for a CLI |
| `servingProvider` | OpenRouter's serving-provider pin — `provider: {order:[x], allow_fallbacks:false}`; the value `auto` resolves the best provider per model with default requirements |
| `orRouting` | an auto-routing config `{mode:'auto', quant_min?, location?, max_in?, max_out?}` — resolved per model through the plugin's `routing` capability and cache; takes precedence over `servingProvider` |
| `orRoutingRefresh` | OpenRouter only — resolve `orRouting` with `refresh: true`, ignoring the 24 h cache. The `llmJson` recovery round uses it when a `parse`/`validate` failure has already spent the retry budget: the cached order is exactly the one that just answered unusably, so a genuinely different serving provider is what a fresh resolve is asked for |
| `purpose` | the caller's name (`title`, `check`, `extract`, `extras`); OpenRouter sends it as `X-Title` |

The answer is `{ text, usage, raw }`. **`text` is always a string** — a source
whose API hands back an object stringifies it (claude's `structured_output`,
cursor's `result`). A transport failure **throws**; it does not return a
falsy answer, because "the model said nothing" and "the call did not happen"
are different facts and the alert channel keys on which one it was.

### Adapters do no coaxing

An adapter sends the request and reports the answer. It does **not** append
instructions, does not strip fences, does not retry and does not validate. All
of that belongs to `server/llm`, once, for every source:

- `json.mjs` — tolerant extraction: strip markdown fences, cut leading and
  trailing prose by scanning for the first balanced `{`/`[` while respecting
  strings and escapes, then repair the common damages (trailing commas,
  single-quoted keys, smart quotes, `NaN`/`Infinity`). It **never evaluates**
  the text — not `eval`, not `new Function`, not `vm` — and it uses a character
  scanner rather than a regex, because a `}` inside a string value closes
  nothing and no regular expression knows that.
- `schema.mjs` — `validate()` coerces as well as checks (`"true"` → `true`,
  `"3"` → `3`, a single value into a one-element array), because a small model
  answering `"true"` is right about the answer and wrong about the type; and
  `strictPrompt()` / `describeForPrompt()` / `repairPrompt()` are how a schema
  is explained to a source that cannot be handed one. There is no Ajv and there
  must not be: this project has zero runtime dependencies.
- `alerts.mjs` — one throttled Telegram message per failure *signature*
  (`purpose|source|model|errorClass`), what was suppressed in between counted
  and named in the next message, a global hourly ceiling, and everything
  fail-soft.

Two places coaxing one model is how the answers stop being reproducible. The
English strings in `schema.mjs` are **prompt text sent to a model**, deliberately
not `t()` keys — a prompt that changed with the operator's UI language would
change the model's answer with it. An i18n sweep must leave them alone.

`server/llm/sources.mjs` (the model-source registry: providers with `llm` plus
harnesses with `llm`) and `server/llm/index.mjs` (`llmJson()`, the one entry
point every direct LLM call goes through) sit on top of these three: they are
the layer that picks the strategy from the source's declared `schema`, runs the
extraction, validates and coerces, reprompts once with the exact complaint, and
raises the alert when even that fails. **A plugin never sees any of it** — the
capability described above is the whole contract, and it is complete whichever
state those two modules are in.

### `overhead: true`

A coding agent starts a whole session to answer one question. It is slower and
dearer than a model provider, and `overhead: true` is what makes the UI say so
wherever such a source can be picked. It is also the one way to try the hub out
with nothing configured but a coding agent and a subscription that is already
being paid for.

## Coding agents as model sources — the measured facts

`server/harnesses/cli-llm.mjs` holds the half all four CLIs share: spawning.
Three rules, each learned the hard way.

1. **stdin is always redirected.** claude burns a fixed three seconds waiting on
   a terminal that never speaks; opencode wants `/dev/null`. Whatever the prompt
   is, it goes in and the pipe is closed immediately, so a CLI reading "until
   EOF" gets its EOF.
2. **There is always a wall-clock timeout, with a `SIGKILL` behind the polite
   signal.** The child is spawned `detached`, in a process group of its own, and
   the timeout signals the **group** — measured: `sh -c "sleep 30"` with a one
   second timeout returned after thirty, because killing only the spawned shell
   left the `sleep` it had forked holding the stdout pipe. After the grace
   period the helper *answers* rather than waiting for `close`, which would wait
   for every inherited pipe.
3. **stdout and stderr are captured separately.** They disagree about which one
   carries an error, and merging them makes one CLI's noise look like another's
   failure.

`runCli()` returns `{code, signal, stdout, stderr, timedOut, spawnError}` and
never throws for a process that merely failed — a binary that is not installed
is a normal answer here. `cliFailure()` turns that into the one error shape, so
a caller can tell a timeout from a missing binary from the CLI's own complaint.
`ndjson()` parses streamed events tolerantly. `cliLines()` reads a listing
command's output **through a file, never a pipe**: `opencode models --pure`
prints 568 lines and loses chunks at process exit through a pipe (measured: 168,
244, 260, 307 instead of 360 OpenRouter models, with perfectly stable output in
a shell), and a silently halved catalog is worse than none.

Versions probed: claude 2.1.251, opencode 1.18.25, hermes 0.20.5, cursor-agent
2026.08.25.

| | claude | opencode | hermes | cursor-agent |
|---|---|---|---|---|
| schema support | **native `--json-schema`** | none | none | none |
| `llm.schema` | `'native'` | `'prompt'` | `'prompt'` | `'prompt'` |
| answer read from | `structured_output`, else `result` | concatenated `text` parts of the NDJSON stream | raw stdout | `result` of the single envelope |
| failure shows on | stdout envelope, `is_error: true` | stdout NDJSON `type:'error'` | stdout, plain text | **stderr** |
| latency | 2.5 s lean | 3.3 s | 2.8 s | 6.7 s |
| input floor | **3 476 lean** / 55 k default | **31 027 hard floor** | n/a | ~14 k incl. cache reads |

The two rows above are the last real-integration run's own measurements
(`node test/echt.mjs`), one trivial question per CLI, and they are worth
re-reading whenever a vendor ships: a first probe put claude's floor at ~1.9 k,
opencode's at ~30 k and cursor's at ~8.5 k, and every one of those was low.
cursor's number in particular is only honest when **cache reads are counted in**
— they are input the account pays for, and leaving them out is what made it look
half the size.

`exit code ≠ 0` is the only universal failure signal. Three vendor-specific
traps, all of which cost time:

- **claude's `subtype` lies.** It still says `"success"` on a failed call.
  `is_error: true` is the field to read.
- **claude's lean flag set is not optional.** The default flags make claude load
  settings, MCP servers, slash commands and the whole tool surface before it
  says a word, and the operator pays for all of it as input on every single
  call. How much dearer that is depends on the model, so do not carry one
  headline number around: it is **several times**, and the last measurement is
  **3.9× on haiku** ($0.0186 with the default flags against $0.0048 with these).
  An earlier probe on a costlier model came out at 42×. The direction is the
  fact; the factor is a reading. And the prompt goes on **stdin, never
  positionally**: `--tools ""` is variadic and would eat it.
  ```js
  ['-p','--output-format','json','--model',model,
   '--safe-mode','--setting-sources','','--strict-mcp-config',
   '--disable-slash-commands','--no-session-persistence',
   '--system-prompt',system,'--tools','',
   '--json-schema',JSON.stringify(schema)]
  ```
- **opencode's stderr must be ignored.** It writes dozens of "unknown format
  uint64" lines on every single run; treating that as failure would mean the
  source never works at all. Its input floor of 31 027 tokens is why only free
  or cheap models make sense there.
  ```js
  ['run','--pure','--format','json','-m',`${provider}/${model}`, prompt]
  ```
- **opencode reports an unknown model as a server fault.** A model id it does
  not know comes back as
  `{"type":"error","name":"UnknownError","data":{"message":"Unexpected server
  error"}}` — byte for byte what a genuine upstream outage produces. There is no
  "no such model" anywhere in it, so a typo in a model id and a broken vendor
  are indistinguishable from the outside; diagnosing that cost an hour. When
  opencode answers `UnknownError`, **check the model id against
  `opencode models --pure` before believing the outage.**
- **OpenCode Zen's free models rotate through 429/500/503 constantly.** The
  `*-free` ids are a shared pool, and a run of a handful of calls will meet all
  three codes. Anything that depends on them must read a 5xx as **"try later"**,
  never as a defect: an incident, a red test or an alert raised on the first one
  is a false alarm about somebody else's queue. Pick a paid id for anything that
  has to answer now.
- **hermes's three muzzle flags are all load-bearing.** Without
  `--safe-mode --reasoning none -t ''` stdout came back as 4420 bytes of a boxed
  reasoning block, because hermes' own system prompt mandates tool use even for
  arithmetic. The prompt goes on stdin via `--query-file -`. Its model ids are
  `<freilauf provider id>/<model>` — the hub's own provider id in front, not the
  vendor's marketing name — which is why `hermes.llm.models()` builds the list
  out of models.dev with `id` prefixed by the plugin's own provider ids (451
  available at the last measurement).
  ```js
  ['chat','--query-file','-','-Q','--safe-mode','--reasoning','none','-t','',
   '-m',`${provider}/${model}`,'--run-budget','120']
  ```
- **cursor needs `--trust`, or it hangs.** Without it the CLI sits at "Do you
  trust the contents of this directory?" and nothing happens at all.
  `--mode ask` is the only way to make it read-only.
  ```js
  ['-p','--output-format','json','--model',modelId,'--trust','--mode','ask', prompt]
  ```

**There is no second "which provider" field anywhere**, and that is a
consequence rather than a simplification: opencode's and hermes's own model
identifiers already carry the provider (`anthropic/claude-…`, `openrouter/…`).
The source picker is one flat list and the model picker below it is filled by
that source's own `models()`.

## Operator configuration, storage and seeding

The registry says what the hub **could** drive; `plugin_config` holds what the
operator has **configured**.

```sql
plugin_config(
  plugin_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                    -- harness | provider | notifier
  enabled    INTEGER NOT NULL DEFAULT 1,
  config     TEXT NOT NULL DEFAULT '{}',       -- {providers:[], credentials:{}, settings:{}}
  source     TEXT NOT NULL DEFAULT 'builtin',  -- builtin | external
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')))
```

One table for all three kinds, because they are the same question:
`coding_agents` only ever knew coding agents, so a model provider had no place
to carry an enabled flag, a credential or a setting of its own, and a
notification channel had no place at all.

**`isPluginEnabled(id)` defaults differently per kind, on purpose.** An
unconfigured coding agent is **off** — a fresh installation deliberately has
none and shows a banner until one is configured. An unconfigured provider or
notifier is **on**: there was no enable flag for either before this table, and
inventing an off-by-default one would switch off working installations. For a
notifier the argument goes one step further: an installation that already had a
Telegram token in `settings` has no row here either, and an off-by-default
channel would have gone silent on upgrade. Enabled is not configured, so a fresh
installation stays quiet all the same.

**Credentials are stored as a mode, not as a value.**
`setCredential(pluginId, key, {mode, envVar, value})`: `'env'` stores the name
of the variable to read, `'value'` stores the secret itself, anything else
forgets the override so the plugin's declared variables apply again. A stored
value lives in the hub's local SQLite database as plain text — the same file
that already holds the Telegram token. It is offered because a machine cannot
always be given another environment variable; where it can, naming the variable
is the better answer and the UI says so. **An empty `value` submit means "keep
what is stored"**: the form renders a password field it cannot pre-fill, and
saving the form must not silently delete a key.

### The one-time migration out of `coding_agents`

Guarded by the settings key `plugins_migrated`, not by "is the new table empty":
an operator who deletes every coding agent after the migration must not get the
old rows back on the next restart. Each row becomes a `plugin_config` row with
`kind='harness'` and `config={"providers":[…]}`. **The old table is left in
place untouched** and nothing reads it any more, so a rollback to an earlier hub
finds its data.

`server/coding-agents.mjs` is now an **adapter** over `plugin_config` with a
byte-compatible exported API (`listCodingAgents`, `enabledCodingAgents`,
`codingAgentFor`, `isHarnessEnabled`, `providersForHarness`, `saveCodingAgent`,
`deleteCodingAgent`, `seedFilePath`, `seedIfEmpty`, `unconfiguredHarnessIds`)
and the same row shape, so its call sites and both test groups keep working.

### Seeding

On first start with no coding agent configured, the hub seeds from
`~/.config/freilauf/coding-agents.json` (override: `FREILAUF_AGENTS_SEED`):

```json
{ "coding_agents": [
  { "harness": "claude",   "enabled": true, "providers": [] },
  { "harness": "opencode", "enabled": true, "providers": ["opencode-zen", "deepseek", "openrouter"] }
] }
```

The seed goes through `saveCodingAgent()`, so a harness or provider the registry
does not know never reaches the database, and it never overwrites an existing
configuration — operator edits win.

## Discovery: what is on this machine, asked once

`scanSystem()` (discovery.mjs) asks, for every **registered** plugin: is this
coding agent's binary on the PATH, and is any of this provider's declared
credential variables set? Results are upserted into the `discovery` table. It is
called from `hub.mjs` **after** the server listens, fire-and-forget and wrapped
in try/catch — never on a request path, never blocking a start — and again from
the "Scan again" button.

```sql
discovery(
  id          TEXT PRIMARY KEY,   -- '<kind>:<pluginId>'
  kind        TEXT NOT NULL,
  plugin_id   TEXT NOT NULL,
  detail      TEXT,               -- JSON: {bin} or {envVar}
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  asked_at    TEXT,
  answer      TEXT)               -- added | dismissed
```

Two rules the module hangs on:

- **A found credential is named, never read.** The row carries the NAME of the
  environment variable and nothing else. A discovery row is rendered into a page
  and could travel with a database copy; a secret in it would be a secret in
  places nobody expects one. A notifier is scanned the same way a provider is —
  by its declared credential variables — so one that declares none (Telegram
  keeps its token in a setting) simply produces no finding.
- **The operator is asked once.** The upsert never overwrites `asked_at` or
  `answer`, and the write happens when the operator **answers** (Add or Not
  now), not when a page renders — a page that only shows something has not asked
  anybody anything. Dismissing therefore stays dismissed across restarts.

`openDiscoveries()` is what is worth suggesting: registered, unconfigured, and
unanswered. `discoveryBanner()` renders it above the content on every page and
is **derived, not passed** — the layout calls it and it answers out of the
database. Its "Not now" dismisses **all** open findings at once: from a banner
there is nothing to tell them apart by, and a banner one cannot get rid of is
worse than no banner.

## The Plugins page — `/settings/plugins`

One page for the whole question "what can this hub drive, and with whose
credentials". `/settings/coding-agents` is a 303 redirect to it.

1. **Found on this machine** — the unanswered discovery rows, each with what was
   found (the binary, or the *name* of an environment variable), an "Add" and a
   "Not now" button, plus the "Scan again" line and when the last scan was.
2. **Coding agents** — one card per registered harness plugin, configured or
   not, which is what subsumes the old "add a coding agent" list: enabled
   switch, the allowed model providers as checkboxes — each carrying one
   sentence saying **whose** key it is reached with, from `ownCredentials()`
   where the plugin can be asked and from `keyFreeProviders` where it cannot —
   install state from `detectInstalled()` with the install hint when it is
   missing, the credentials block, the plugin's own `settings` fields, and for
   an external package its version and a "Remove".
3. **Model providers** — one card per registered provider plugin: enabled
   switch, the credentials block, badges for "can answer the hub's own
   questions" (`llm`), "balance visible" (`balance`) and "credential present",
   the plugin's own `settings` fields, version and "Remove" for an external one.
4. **Plugin packages** — every external package with id, kind, name, version,
   path and its load error as it stands (a notifier package appears here too);
   the registry's error list below it; an "Install from a directory" form; and a
   note that built-ins cannot be removed.

Notification channels are **not** on this page — they have one of their own,
`/settings/notifications`, because the question there is different: not "what
can this hub drive" but "where does it say things, and does it have to say them
anywhere at all". It renders the same card blocks (`checkbox`,
`credentialsBlock`, `settingsBlock`, `cardFooter` are exported from
`plugins/web.mjs` for exactly that) plus a test button and a link to the
plugin's own setup wizard, and it opens by saying that all of it is optional.
`/telegram-setup` is a 303 to the Telegram plugin's wizard.

Routes: `GET /settings/plugins`, and `POST` to `…/save`, `…/add`, `…/remove`
(forget a plugin's configuration; the plugin stays registered), `…/install`,
`…/uninstall` (delete an external package's directory and its configuration),
`…/scan`, `…/discovery`. Validation failures go to `problemPage()`, success
redirects back.

Three page-level rules worth knowing:

- **A credential is named, never shown.** The page says whether a key was found
  and which variable it came from; the value never reaches the markup.
- **Every switch carries a hidden companion field with `0`.** A `<form>` sends
  nothing at all for an unticked checkbox, so without it a saved form could
  never switch anything **off**. All of them go through one `checkbox()` helper
  so the rule cannot be forgotten in one place only.
- **The card footer stands outside the save form.** A `<form>` inside a `<form>`
  is not nesting, it is a parse error: the parser drops the inner one and its
  button submits the outer — which here would mean "Remove" quietly *saving* the
  plugin.

## Adding a new coding agent

1. Create `server/harnesses/<id>.mjs` (built-in) or a package directory with a
   `plugin.json` and an `index.mjs` (external). Export the descriptor as the
   **default export**. `validateDescriptor()` requires `id`, `label`, `bin`,
   `subscription`, `providers`, a non-empty `logPatterns`, and `modelArgs`,
   `effortOptions`, `usage`, `pulseId`.
2. Register it: add it to `HARNESS_PLUGINS` in `server/plugins/registry.mjs` for
   a built-in; an external package registers itself when the hub loads the
   plugin directory.
3. **Say how the CLI is launched.** An **external** plugin declares `launch`
   (see "The launch declaration"): the hub writes it into the run directory and
   `fl-start --spec` starts the session from it — no bash edit, no hub release.
   A plugin with no `launch` cannot start a run, and `launchable()` says so
   before a worktree exists. A **built-in** added to `server/harnesses/` gets a
   `case` in `bin/fl-start` instead, because that script must keep working with
   no hub behind it; declare `launch` next to it anyway, and keep the two in
   step.
4. Add every new i18n key the plugin names (`descriptionKey`, `labelKey`,
   `hintKey`, `hinweisKey`) to **all three** catalogs — `lang/en.json`,
   `lang/de.json`, `lang/zh.json`. A unit test enforces identical key sets and
   non-empty values; a plugin may not name a string that is not there.
5. If the CLI reports API errors through a hook of its own, wire it to
   `fl-report _api_error` (see the opencode plugin installed by
   `setup/02-install-scripts.sh`). Otherwise the pipe-pane log scan is the only
   source, and `logPatterns` should stay narrow — a menu line reading "Upgrade
   to Max for higher rate limits" once sat in the database as a rate limit on a
   production run.
6. Ask how a run of this harness **ends**. If the process exits when the work is
   done, `_pane_died` / `_exit` already cover it. If the CLI stays up instead
   (cursor), the harness needs `turnEndsRun` plus a channel that reports the turn
   end — a `hookFiles` entry, and ideally a second, hook-free source; see
   "cursor: when a run is over" in [AGENTS.md](../AGENTS.md).
7. Optional but worth it: `resumeCommand(run)`. Every escalation the integration
   produces ends with "here is how you pick this session up"; a harness without
   it names the worktree instead. Find out from the CLI's own `--help` rather
   than guessing — a command that opens somebody ELSE's conversation is worse
   than no command.
8. Optional: `gate` if this coding agent runs on an account the hub can meter,
   and `llm` if its CLI can answer a one-shot question. For `llm`, read the
   three rules in `cli-llm.mjs` first and declare `overhead: true`.
   `ownCredentials(ctx)` too — but **only if the CLI's credential store has been
   measured**: it decides a sentence the Plugins page states as fact, and a
   guess there is worse than leaving the capability out (see above). Declare
   `keyFreeProviders` either way; that is what the launch path reads.
9. Done: install detection, the discovery scan, the forms, the Plugins page, the
   detection patterns, the pulse and the budget-gate routing all follow the
   registry. Configure the new coding agent under Settings → Plugins.

## Adding a new model provider

1. Create `server/providers/<id>.mjs` or an external package. Minimum: `id`,
   `label`, `fetchModels(ctx)`, and either `envKeys` or `credentials`. Declare
   `credentials` — `envKeys` alone still works and is read as one `api_key`
   credential, but only a declared credential carries a label and a help text on
   the Plugins page.
2. Resolve the key as `ctx.secret('api_key')` with the plain environment read as
   the fallback, never as a bare `process.env` lookup: that is the whole reason
   the operator's own key and their own variable name work.
3. Reference the id from the `providers` list of every harness plugin that can
   use it, and register the plugin in `server/providers/index.mjs`' registry for
   a built-in. Add it to that harness's `keyFreeProviders` when the CLI reaches
   it with no own key: that list is the launch path's answer and the Plugins
   page's fallback, not a description of the operator's machine —
   `ownCredentials()` is what asks the CLI itself. If the harness is opencode,
   set `ocPrefix` as well; both the model ids and the credential probe map
   through it.
4. Document the credential environment variable in `env.example`.
5. Add the plugin's i18n keys to all three `lang/*.json` catalogs.
6. Optional: `balance()` — the usage panel then shows it without a line of UI
   code, and a `gate` can measure against it with `balanceGateBlocked(id, …)`.
7. Optional: `llm` — declare honestly which of the three schema modes the
   endpoint really supports.
8. Enable the provider under Settings → Plugins, and allow it per coding agent
   on that agent's card.

## Adding a new notification channel

1. Create `server/notifiers/<id>.mjs` (built-in) or a package directory with a
   `plugin.json` carrying `"kind": "notifier"` and an `index.mjs` (external).
   Export the descriptor as the **default export**. `validateDescriptor()`
   requires `id`, `label` and `send` — nothing else.
2. Declare what the operator has to fill in as `settings` (and/or
   `credentials`), and mark the fields that make the channel usable
   `required: true` — that is how the hub knows whether it may speak at all.
   Read them with `ctx.setting()` / `ctx.secret()`, never from `process.env`.
3. Write `send(message, ctx)`. Return `{ ok: true }` or
   `{ ok: false, error: '…' }`; do not throw for a delivery that merely failed.
   Render from `message.text`; use `url`, `runId` and `attachment` if your
   channel has a place for them, and ignore them if it does not.
4. Register a built-in in `NOTIFIER_PLUGINS` in `server/plugins/registry.mjs`;
   an external package registers itself when the hub loads the plugin directory.
5. Add every i18n key the descriptor names (`descriptionKey`, the fields'
   `labelKey`/`hintKey`) to **all three** catalogs — `lang/en.json`,
   `lang/de.json`, `lang/zh.json`. A unit test enforces identical key sets.
6. Optional: `test()` if a test message should look different from a real one,
   and `setup` if the channel needs a guided setup rather than a form.
7. Done. The card, the enabled switch, the credentials block, the test button,
   the flow `notify` step, `bin/fl-notify` and every message the hub sends all
   follow the registry. Configure it under **Settings → Notifications**.

## Known limits, stated rather than hidden

- **The four shipped coding agents keep their own `case` in `bin/fl-start`**,
  and that is deliberate rather than pending: the script has to work with no hub
  behind it, so for claude, opencode, hermes and cursor the command line lives
  there and is the single source of truth. An external plugin needs no bash edit
  at all — it declares `launch` and the hub hands that over with `--spec`. The
  limit that remains is the duplication: a built-in's `case` and its `launch`
  block are two copies of one command line, and nothing checks that they agree.
- **`--spec` needs `jq`.** It is a documented prerequisite of the project, but a
  machine without it can still start the four built-ins and nothing else.
- **i18n is not generated.** A plugin declares keys; somebody has to put them in
  three catalogs.
- **An external plugin cannot add routes.** A notifier's `setup` gets the three
  addresses listed above and nothing more. That is enough for a guided setup and
  not enough for an arbitrary page, which is the trade this contract makes on
  purpose: three routes the hub owns are three routes it can reason about.
- **`alerts.mjs` mentions no channel any more**, but it still keys its throttle
  on the failure signature and not on the channel. Two configured notifiers
  therefore share one alert window — which is right (the failure is the news,
  not the number of ways it was announced) and worth knowing.
