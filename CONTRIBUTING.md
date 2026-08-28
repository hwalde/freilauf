# Contributing to cc-hub

**Pull requests are very welcome.** Bug reports, plugin files for further coding
agents or model providers, translations, documentation fixes — all of it. You do
not need to ask first; a draft PR with a question in it is a perfectly good way
to start a conversation.

If a coding agent is doing the work: point it at
[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md) and [AGENTS.md](AGENTS.md) first.
Both are written to be read by agents.

## Ground rules

- **Project language is English** — source, comments, documentation, commit
  messages. (`lang/de.json` and `lang/zh.json` are the obvious exception.)
- **No hardcoded UI strings.** Everything user-visible goes through `t('key')`
  on the server and `window.CCHUB_I18N` in the browser. `lang/en.json`,
  `lang/de.json` and `lang/zh.json` must carry the **same key set** with
  non-empty values — a unit test enforces it. Add English first; if you cannot
  translate, say so in the PR and translate the key with your best attempt
  rather than leaving it out.
- **The three READMEs are maintained together**: `README.md` (English, the
  reference), `README.zh-CN.md`, `README.de.md`. A change to one that belongs in
  all three belongs in all three.
- **Keep `SETUP_WITH_AGENT.md` current.** If your change touches installation,
  the prompt an agent receives, the plugin contracts or the flow building
  blocks, update it in the same PR.
- **New coding agents and providers are plugins** — one file under
  `server/harnesses/` or `server/providers/`, registered in the respective
  `index.mjs`. Please do not hardcode harness specifics anywhere else; the
  contract is in [docs/plugins.md](docs/plugins.md).
- **Every directory with an `AGENTS.md` gets a `CLAUDE.md` next to it containing
  exactly one line — `@AGENTS.md`.** Never put content into a `CLAUDE.md` here.
  A unit test checks both halves.
- **Nothing machine-specific in the repository.** No real ports, IP addresses,
  hostnames, home paths, certificates or keys — the defaults in `env.example`
  are deliberately fictional. `./pruefe-vor-push.sh` greps the committed state
  for exactly that, and it is installable as a pre-push hook.

## Before you open the PR

```bash
node test/unit.mjs && node test/e2e.mjs     # required
node test/browser.mjs                       # if you touched public/hub.js  (needs playwright)
node test/proxy.mjs                         # if you touched vpn-proxy.mjs
node test/deploy.mjs                        # if you touched bin/cchub-deploy
./pruefe-vor-push.sh                        # no private values in the commits
```

The e2e suite is sandboxed — its own port, database, test repo and tmux sessions
— so it is safe to run next to a live hub.

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

cc-hub is licensed under [CC BY 4.0](LICENSE). By opening a pull request you
agree that your contribution is published under the same license.
