---
name: freilauf-plugins
description: >
  Connect something new to Freilauf, or install what somebody else wrote. Use
  this skill when the task is to add a coding agent, a model provider or a
  notification channel to Freilauf, to write or debug a Freilauf plugin, or to
  install, enable, configure or remove a plugin package. Also use it for
  "connect X to Freilauf", "Freilauf does not offer Y yet", "send the
  notifications to Slack/Discord/email instead", "add another LLM provider",
  "make Freilauf drive this other CLI agent", "the vendor is missing from the
  dropdown" and "here is a plugin, install it" — even when the word "plugin" is
  never said.
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
---

# Adding something to Freilauf

Three kinds of thing are plugins, and everything else in the hub consults the
registry rather than naming a vendor:

| kind | what it is | ends up in |
|---|---|---|
| `harness` | a **coding agent** — a CLI the hub drives in a tmux session | the harness dropdown of every run form |
| `provider` | a **model provider** the coding agents buy tokens from | the provider/model pickers, the usage panel, a budget gate |
| `notifier` | a **notification channel** the hub reports through | Settings → Notifications, and the flow `notify` step |

A **built-in** is one file in the hub's checkout. A **third party's** plugin is
a *package directory* holding `plugin.json` and a module — it needs no change
to the Freilauf repository at all, and that is the form to prefer unless the
vendor genuinely belongs in the project.

## The contract is one file, and you must read it

`docs/plugins.md` in the hub's own checkout is the complete contract for all
three kinds: every descriptor field, the manifest, the registry, the context a
plugin is handed instead of `process.env`, the `credentials` / `gate` / `llm` /
`launch` / `skills` declarations, and a numbered checklist per kind at the end.
**Nothing is restated here on purpose** — a second copy would drift, and a
plugin written from a summary is a plugin with silently ignored fields in it.

It is ~1450 lines. Do not read it whole; get its section index and read the two
or three sections your kind needs:

```bash
scripts/fl-plugins.py docs                 # the path + every section, with line numbers
scripts/fl-plugins.py docs "adding a new"  # jump straight to the checklists
```

**How the file is found**, in this order: `FREILAUF_APP_DIR` → the `app_dir` in
`.freilauf-skill.json`, the calling card the installation wrote next to this
skill → a walk up from the script (which works when the skill is read straight
out of a checkout).

**If it is not found**, `docs` says so and exits 3 rather than inventing an
answer. Then: `fl-api /api/skills` reports this installation, `fl-api
/api/repos` lists the operator's own checkouts (Freilauf is usually one of
them), and `export FREILAUF_APP_DIR=/path/to/freilauf` points the tool at it.
Do not write a plugin without the contract in front of you.

## The order of work

1. **Read the contract section for your kind** — `Coding agent plugin
   contract`, `Model provider plugin contract` or `Notifier plugin contract`,
   then the matching `Adding a new …` checklist.
2. **Look at what is already there**: `scripts/fl-plugins.py list` (what is
   registered and enabled here), and the built-in files named in the contract's
   directory tree are the best worked examples there are.
3. **Scaffold**: `scripts/fl-plugins.py new <harness|provider|notifier> <id>`
   writes a package directory with a `plugin.json` and an `index.mjs` carrying
   the minimum descriptor. It is a skeleton, not a working plugin.
4. **Fill it in**, then **install** it and switch it on.
5. **Test it**: a provider by picking a model in a run form, a notifier by the
   "send test message" button on its card, a coding agent by starting one
   throwaway run.

## Installing, enabling, removing

```bash
scripts/fl-plugins.py install /path/to/package   # validate the manifest, copy it in, register it
scripts/fl-plugins.py list                       # what is registered now
scripts/fl-plugins.py uninstall <id>             # its directory AND its stored configuration
scripts/fl-plugins.py scan                       # ask the machine again: which CLIs, which credentials
```

**Installing is not enabling.** The two are separate on purpose, and the
default differs per kind: an unconfigured **coding agent is off** (a fresh
installation has none and nags until one is configured), an unconfigured
**provider is on**, and a **notifier** does nothing until its required settings
are filled in. Credentials, allowed providers, thresholds and the plugin's own
settings all live on its card:

- `<hub>/settings/plugins` — coding agents, model providers, external packages,
  and the **load errors** of a package that failed
- `<hub>/settings/notifications` — one card per notification channel

Those two pages are also the only place some of that is visible: there is **no
JSON route for the registry**, so `list` reports coding agents, the providers
offered to them and the packages on disk, and says plainly what it cannot see.
`install` / `uninstall` / `scan` post to the web UI's own routes, which answer a
303 on success and an HTML problem page on failure; the script reports whichever
came back rather than pretending it is JSON.

## Traps that cost an hour each

One line each — the reason is in the section named next to it. Read the section
before you argue with the rule.

- **A plugin file imports nothing from the hub at the top.** A static import
  closes a cycle through the registry and kills an unrelated file with a
  `ReferenceError`; use `await import()` inside the function that needs it.
  → *Import rules — what changed, and the one trap that is measured*
- **An external coding agent without a `launch` declaration cannot start a
  run** — there is no `case` for it in `bin/fl-start`. → *The launch
  declaration*
- **A duplicate id is refused, never given precedence.** A package calling
  itself `claude` does not replace the coding agent runs start with. → *The
  registry*
- **Every user-visible string is an i18n key** (`descriptionKey`, `labelKey`,
  `hintKey`, `hinweisKey`) and must exist in **all three** of `lang/en.json`,
  `lang/de.json`, `lang/zh.json`. A unit test enforces identical key sets, and
  a plugin may not name a string that is not there. → the `Adding a new …`
  checklists
- **`SETTINGS_KEYS` is a function, not a constant** (see AGENTS.md, Pitfalls):
  a plugin's settings are only in the allowlist because it is evaluated per
  save. If you add a settings surface anywhere, do not freeze that list at
  module level — a field that looks like it saved and did not is the worst
  shape a bug can take.
- **Read credentials through `ctx.secret()`, settings through `ctx.setting()`**
  — never `process.env`. That indirection is the whole reason an operator's own
  key, or their own variable name, works everywhere at once. → *The injected
  context*
- **Declare a capability only where it has been measured.** `ownCredentials()`,
  `skills` directories and `resumeCommand()` each become a sentence the UI
  states as fact; a guess there is worse than leaving the capability out.
- **`send()` must not throw** for a delivery that merely failed — return
  `{ ok: false, error }`. `notify()` is a call that cannot be allowed to break
  its caller. → *Notifier plugin contract*
- **Nothing configured is a complete installation.** A hub with no notifier
  schedules, watches and merges exactly as one with three; do not add a
  warning, a banner or a required step that says otherwise.

## Where this skill stops

- **Choosing a model, provider or effort for a run** — that is
  `../freilauf-models/SKILL.md`. This skill is about making a vendor *available*;
  that one is about picking from what is available.
- **Extra skills** (`~/agents/zusaetze/…`, the per-run opt-in checkboxes) are a
  different mechanism entirely and are not plugins.
- **Contributing a built-in back to the project**: read `CONTRIBUTING.md` in the
  checkout first. It asks the fair question — a plugin package you publish
  yourself is released on your schedule, not the project's — and lists the tests
  a PR has to pass.
