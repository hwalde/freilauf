# Gates: dead-code elimination

OWNS: server/**, lang/*.json, test/unit.mjs, test/echt.mjs,
test/verify-agent-lifecycle.mjs, PLAN.md, GATES.md

Scope: Remove code nothing reaches — dead exported functions, dead test seams
no suite calls, dead imports and translation keys no code renders — and prove
that nothing which IS reached went with them. The whole pipeline (unit, e2e,
browser, proxy, deploy) stays green at exactly its pre-change check count, and
no removed name survives anywhere in the tracked tree.

**The suites need six environment variables unset**, and that is a property of
this machine, not of the change: it exports the real installation's
`FREILAUF_PUBLIC_URL` / `CCHUB_PUBLIC_URL` / `CCHUB_VPN_PORT` and, inside an
agent run, `CC_RUN_ID` / `CC_HUB_URL` / `FL_RUN_ID` / `FL_HUB_URL`. `cleanupPrompt` reads
the first group through `publicBase()` and the deploy suite's `fl-report` shim
reads the second, so one unit check and one deploy check fail on the operator's
own environment before and after any edit here. Measured on the unchanged tree:
360/361 unit and 21/22 deploy with them set, 361/361 and 22/22 with them unset.

Pre-change baseline, measured before the first edit: unit 361, e2e 280,
proxy 4, deploy 22, browser 61 — every gate below has to reproduce that number,
not merely "pass".

- [x] G1: unit suite green at the baseline count — nothing removed was load-bearing
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL node test/unit.mjs
  EXPECT: /Unit tests: 361 checks passed/
  EVIDENCE: met — exit 0, `Unit tests: 361 checks passed`, the pre-change count
    exactly. This is the suite that holds the three catalogs to identical key
    sets, so it also proves the 18 removed translation keys went out of all
    three. Raw transcript is machine-local under ~/.unlazy/ (gitignored).

- [x] G2: e2e suite green at the baseline count — every page and route still answers
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL node test/e2e.mjs
  EXPECT: /E2E tests: 280 checks passed/
  EVIDENCE: met — exit 0, `E2E tests: 280 checks passed`, the pre-change count exactly.
    Covers the routes that outlived the page removed here: the `/settings/coding-agents`
    303 and both `/settings/coding-agents/save` posts.

- [x] G3: browser suite green at the baseline count
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL node test/browser.mjs
  EXPECT: /Browser tests: 61 checks passed/
  EVIDENCE: met — exit 0, `Browser tests: 61 checks passed`, the pre-change count exactly.

- [x] G4: proxy and deploy suites green at the baseline counts
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL sh -c 'node test/proxy.mjs && node test/deploy.mjs'
  EXPECT: /Proxy tests: 4 checks passed[\s\S]*deploy: 22 checks passed/
  EVIDENCE: met — exit 0, `Proxy tests: 4 checks passed` and `deploy: 22 checks passed`,
    both the pre-change counts. The deploy suite is what exercises the cc-hub
    transition shims, none of which this change touches.

- [x] G5: not one removed name survives anywhere in the tracked tree
  CHECK: if git grep -qE 'pageCodingAgents|pluginProviders|enabledPlugins|pluginSettingValues|allDiscoveries|firstJsonValue|TELEGRAM_LIMITS|CAPTION_MAX|currentArchiveKeepMs|_cleanupGetSetting|_cleanupSetSetting|_resetState|_sourcesReset|_registryReset|_usageCacheAge|runform\.branch_mode|settings\.coding_agents_hint|ca\.providers_legend|ca\.providers_hint|ca\.no_providers|ca\.intro|ca\.none|ca\.add_title|ca\.all_configured|ca\.detect_note|ca\.installed|ca\.not_installed|ca\.install_hint|ca\.detected|ca\.enabled|ca\.delete_confirm|ca\.add|ca\.plugin_missing' -- . ':(exclude)PLAN.md' ':(exclude)GATES.md'; then echo "remnants found"; exit 1; else echo "removal is complete"; fi
  EXPECT: removal is complete
  EVIDENCE: met — exit 0, printed `removal is complete`. `git grep` over every tracked
    file (source, tests, docs, shell, catalogs) for all 15 removed identifiers
    and all 18 removed translation keys finds nothing outside PLAN.md/GATES.md,
    which name them as the record of the change.

- [x] G6: the same absence pattern DOES match the pre-change tree
      (the negative control for G5 — an absence check that cannot fail proves nothing)
  CHECK: if git grep -qE 'pageCodingAgents|pluginProviders|enabledPlugins|pluginSettingValues|allDiscoveries|firstJsonValue|TELEGRAM_LIMITS|CAPTION_MAX|currentArchiveKeepMs|_cleanupGetSetting|_cleanupSetSetting|_resetState|_sourcesReset|_registryReset|_usageCacheAge|runform\.branch_mode|settings\.coding_agents_hint|ca\.providers_legend|ca\.providers_hint|ca\.no_providers|ca\.intro|ca\.none|ca\.add_title|ca\.all_configured|ca\.detect_note|ca\.installed|ca\.not_installed|ca\.install_hint|ca\.detected|ca\.enabled|ca\.delete_confirm|ca\.add|ca\.plugin_missing' HEAD -- . ':(exclude)PLAN.md' ':(exclude)GATES.md'; then echo "control holds"; else echo "control failed"; exit 1; fi
  EXPECT: control holds
  EVIDENCE: met — exit 0, printed `control holds`. The identical pattern run against
    `HEAD` matches 83 lines, so G5's silence is a measurement and not a broken
    expression.

- [x] G7: the two orphaned verification scripts still pass — they were KEPT,
      not deleted, because they are the only coverage of what they check
  CHECK: node scripts/gates-msg-header.mjs && node test/verify-agent-lifecycle.mjs --migration && node test/verify-agent-lifecycle.mjs --lifecycle
  EXPECT: /message-header gates OK[\s\S]*migration verification passed[\s\S]*lifecycle verification passed/
  EVIDENCE: met — exit 0, all three markers printed. Both scripts are unreferenced by
    package.json and by every suite, and both are the ONLY coverage of what they
    check (the `repo / AGENT name REPORT:` header; the `UNIQUE(repo_id, name)`
    rebuild, the move suffix, delete-keeps-runs). Deleting them would have traded
    a dead-file count for a real coverage hole, so they were kept.
