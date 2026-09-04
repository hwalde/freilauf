# Contributing to Freilauf

**Pull requests are very welcome.** Bug reports, plugin files for further coding
agents or model providers, translations, documentation fixes — all of it. You do
not need to ask first; a draft PR with a question in it is a perfectly good way
to start a conversation.

**Not writing code?** Wishes count too. [ROADMAP.md](ROADMAP.md) says what is
already planned — it is a short list on purpose — and an
[issue](https://github.com/hwalde/freilauf/issues) is the right place for
anything that is not on it. "I tried to do X and Freilauf made it hard" is a
useful report even without a proposed solution.

If a coding agent is doing the work: point it at
[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md) and [AGENTS.md](AGENTS.md) first.
Both are written to be read by agents.

## Ground rules

- **Project language is English** — source, comments, documentation, commit
  messages. (`lang/de.json` and `lang/zh.json` are the obvious exception.)
- **No hardcoded UI strings.** Everything user-visible goes through `t('key')`
  on the server and `window.FREILAUF_I18N` in the browser. `lang/en.json`,
  `lang/de.json` and `lang/zh.json` must carry the **same key set** with
  non-empty values — a unit test enforces it. Add English first; if you cannot
  translate, say so in the PR and translate the key with your best attempt
  rather than leaving it out.
- **The three READMEs are maintained together**: `README.md` (English, the
  reference), `README.zh-CN.md`, `README.de.md`. A change to one that belongs in
  all three belongs in all three. `ROADMAP.md` is the deliberate exception among
  the public-facing documents: English only, linked from all three.
- **Keep `SETUP_WITH_AGENT.md` current.** If your change touches installation,
  the prompt an agent receives, the plugin contracts or the flow building
  blocks, update it in the same PR.
- **New coding agents and model providers are plugins**, and since the registry
  became dynamic that is more true than it used to be: a built-in is one file
  under `server/harnesses/` or `server/providers/`, registered in
  `server/plugins/registry.mjs` — and anything a *third party* ships is a
  package directory with a `plugin.json`, which needs no change to this
  repository at all. Before opening a PR that adds a vendor, ask whether it has
  to live here: a plugin package you publish yourself is released on your
  schedule, not ours. If it does belong here, please do not hardcode harness or
  provider specifics anywhere outside the plugin file — thresholds go in `gate`,
  keys in `credentials`, the launch command line in `launch`, and the hub's own
  LLM calls in `llm`. The contract is in
  [docs/plugins.md](docs/plugins.md), which is the one document to read (or to
  hand your agent) before writing a plugin.
- **A plugin's UI strings are i18n keys** (`descriptionKey`, `labelKey`,
  `hintKey`, `hinweisKey`), added to all three catalogs in the same PR. A plugin
  may not name a string that is not there, and a unit test says so.
- **Every directory with an `AGENTS.md` gets a `CLAUDE.md` next to it containing
  exactly one line — `@AGENTS.md`.** Never put content into a `CLAUDE.md` here.
  A unit test checks both halves.
- **Nothing machine-specific in the repository.** No real ports, IP addresses,
  hostnames, home paths, certificates or keys — the defaults in `env.example`
  are deliberately fictional. `./pruefe-vor-push.sh` greps the committed state
  for exactly that, and it is installable as a pre-push hook:
  `bash setup/02-install-scripts.sh --hooks` links it, together with
  `deploy-after-merge.sh` as `post-merge`. Both are opt-in — a deploy and a
  migration run that same setup script, and neither may arm a hook behind your back.

## Before you open the PR

```bash
node test/unit.mjs && node test/e2e.mjs     # required
node test/browser.mjs                       # if you touched public/hub.js  (needs playwright)
node test/proxy.mjs                         # if you touched vpn-proxy.mjs
node test/deploy.mjs                        # if you touched bin/freilauf-deploy
node test/post-merge.mjs                    # if you touched deploy-after-merge.sh
bash -n bin/fl-start                        # if you touched a bin/ script (unit.mjs does this too)
./pruefe-vor-push.sh                        # no private values in the commits
```

The e2e suite is sandboxed — its own port, database, test repo, plugin directory
and tmux sessions — so it is safe to run next to a live hub. If you add a suite
or a fixture that loads plugins, point `FREILAUF_PLUGIN_DIR` into the sandbox: it
is a test fence exactly like `FREILAUF_AGENTS_SEED`, and without it the suite loads
whatever the operator happens to have installed and stops being reproducible.

## What makes a PR easy to merge

- One concern per PR. A plugin file plus its three i18n keys is one concern; a
  plugin file plus a refactor of the scheduler is two.
- Say **why**, not just what. `AGENTS.md` is written that way on purpose — most
  of the surprising code in this project is surprising because something else
  was worse, and the reason is what keeps it from being "cleaned up" later.
- If you found a trap, add it to the **Pitfalls** section of `AGENTS.md`. That
  list is the most valuable file in the repository.
- Screenshots for UI changes; the exact command and its output for anything
  operational.

## Licensing of contributions

Freilauf is licensed under [CC BY 4.0](LICENSE). By opening a pull request you
agree that your contribution is published under the same license.
