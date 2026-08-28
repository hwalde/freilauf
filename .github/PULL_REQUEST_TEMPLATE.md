<!--
Thanks for contributing! The ground rules are in CONTRIBUTING.md.
Delete anything below that does not apply — this is a checklist, not a form to fill.
-->

## What and why

<!-- What changes, and what was worse before. The "why" is the part that keeps it
     from being refactored away later. -->

## Checklist

- [ ] `node test/unit.mjs && node test/e2e.mjs` are green
- [ ] `node test/browser.mjs` (touched `public/hub.js`) / `test/proxy.mjs`
      (touched `vpn-proxy.mjs`) / `test/deploy.mjs` (touched `bin/cchub-deploy`)
- [ ] New UI strings go through i18n and exist in **all three** `lang/*.json`
- [ ] README changes applied to `README.md`, `README.zh-CN.md` **and** `README.de.md`
- [ ] `SETUP_WITH_AGENT.md` updated if setup, prompts, plugin contracts or flow
      blocks changed
- [ ] New `AGENTS.md`? Then a `CLAUDE.md` next to it containing only `@AGENTS.md`
- [ ] Nothing machine-specific committed (ports, IPs, hostnames, home paths,
      keys) — `./pruefe-vor-push.sh` is green
- [ ] A trap you hit is written down in the **Pitfalls** section of `AGENTS.md`
