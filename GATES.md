# Gates: dead-code elimination, second pass

OWNS: server/web.mjs, server/pages.mjs, server/flows/web.mjs, PLAN.md, GATES.md

Scope: Remove what provably nothing reaches — two unreachable HTTP routes, the
import bindings they orphan, and two attributes the server renders that no
client, no stylesheet and no test reads — and prove that nothing which IS
reached went with them. The whole pipeline (unit, e2e, browser, proxy, deploy,
post-merge) stays green at exactly its pre-change check count.

**The suites need six environment variables unset**, and that is a property of
this machine, not of the change: it exports the real installation's
`FREILAUF_PUBLIC_URL` / `CCHUB_PUBLIC_URL` / `CCHUB_VPN_PORT` and, inside an
agent run, `CC_RUN_ID` / `CC_HUB_URL` / `FL_RUN_ID` / `FL_HUB_URL`.

Pre-change baseline, measured before the first edit on the unchanged tree
(sha `367bd55`): unit 371, e2e 285, browser 61, proxy 4, deploy 22 — every gate
below has to reproduce that number, not merely "pass".

- [x] G1: unit suite green at the baseline count — nothing removed was load-bearing
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL node test/unit.mjs
  EXPECT: /Unit tests: 371 checks passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/herbe/agents/worktrees/Freilauf/0c1fc610-detached; path=adf86b4229b4/9 entries; output=[notify] unit-broken: the api is on fire | [coding-agents] seed entry skipped: unknown coding agent: quatsch

- [x] G2: e2e suite green at the baseline count — every page and every surviving route still answers
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL node test/e2e.mjs
  EXPECT: /E2E tests: 285 checks passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/herbe/agents/worktrees/Freilauf/0c1fc610-detached; path=adf86b4229b4/9 entries; output=──────────────────────────────────────────────────────────────── | [32mE2E tests: 285 checks passed[0m (82.2 s)

- [x] G3: browser suite green at the baseline count — the header and the settings
      page really drive in Chromium after losing an attribute each
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL node test/browser.mjs
  EXPECT: /Browser tests: 61 checks passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/herbe/agents/worktrees/Freilauf/0c1fc610-detached; path=adf86b4229b4/9 entries; output=──────────────────────────────────────────────────────────────── | [32mBrowser tests: 61 checks passed[0m (20.1 s)

- [x] G4: proxy, deploy and post-merge suites green at the baseline counts
  CHECK: env -u FREILAUF_PUBLIC_URL -u CCHUB_PUBLIC_URL -u CCHUB_VPN_PORT -u FREILAUF_VPN_PORT -u CC_RUN_ID -u CC_HUB_URL -u FL_RUN_ID -u FL_HUB_URL sh -c 'node test/proxy.mjs && node test/deploy.mjs && node test/post-merge.mjs'
  EXPECT: /Proxy tests: 4 checks passed[\s\S]*deploy: 22 checks passed[\s\S]*post-merge: [0-9]+ checks passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/herbe/agents/worktrees/Freilauf/0c1fc610-detached; path=adf86b4229b4/9 entries; output=──────────────────────────────────────────────────────────────── | [32mpost-merge: 19 checks passed[0m (2.8 s)

- [x] G5: not one removed name survives anywhere in the tracked tree
  CHECK: if git grep -qE 'api/fragments/session-row|api/flows/step-defaults|data-active=|data-llm-prefix' -- . ':(exclude)PLAN.md' ':(exclude)GATES.md'; then echo "remnants found"; exit 1; else echo "removal is complete"; fi
  EXPECT: removal is complete
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/herbe/agents/worktrees/Freilauf/0c1fc610-detached; path=adf86b4229b4/9 entries; output=removal is complete

- [x] G6: the same absence pattern DOES match the pre-change tree
      (the negative control for G5 — an absence check that cannot fail proves nothing)
  CHECK: if git grep -qE 'api/fragments/session-row|api/flows/step-defaults|data-active=|data-llm-prefix' 367bd55 -- . ':(exclude)PLAN.md' ':(exclude)GATES.md'; then echo "control holds"; else echo "control failed"; exit 1; fi
  EXPECT: control holds
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/herbe/agents/worktrees/Freilauf/0c1fc610-detached; path=adf86b4229b4/9 entries; output=control holds

- [x] G7: the symbols the removals could have orphaned are still reached — and
      the ones that only the removed routes reached are gone from those files.
      `sessionRow` and `defaultProps` KEEP their declarations (the sessions page
      renders the first, the unit suite calls the second); only the two import
      bindings in server/web.mjs and server/flows/web.mjs went.
  CHECK: node -e "const fs=require('fs');const rd=p=>fs.readFileSync(p,'utf8');const imports=t=>t.split('\n').filter(l=>/^import\b/.test(l)||/^\s+[A-Za-z_$][\w$, ]*,?\s*$/.test(l)).join('\n');const w=rd('server/web.mjs'),f=rd('server/flows/web.mjs'),p=rd('server/pages.mjs'),s=rd('server/flows/steps.mjs');const a=[['web.mjs imports sessionRow no more',!/sessionRow/.test(imports(w))],['flows/web.mjs imports defaultProps no more',!/defaultProps/.test(imports(f))],['pages.mjs still declares sessionRow',/export function sessionRow/.test(p)],['pages.mjs still renders it',/sessionRow\(s, ctx\)/.test(p)],['steps.mjs still exports defaultProps',/export function defaultProps/.test(s)],['no fragment route for a session row',!/fragments\/session-row/.test(w)],['no step-defaults route',!/if \(req.method === .GET. && path === ..api.flows.step-defaults/.test(f)]];let bad=0;for(const [n,ok] of a){if(!ok){console.log('FAIL: '+n);bad++}}if(bad)process.exit(1);console.log('cascade check passed')"
  EXPECT: cascade check passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/herbe/agents/worktrees/Freilauf/0c1fc610-detached; path=adf86b4229b4/9 entries; output=cascade check passed
    Positive control: the identical script run against a checkout of `367bd55`
    exits 1 and prints exactly the four removal assertions as FAIL
    (`web.mjs imports sessionRow no more`, `flows/web.mjs imports defaultProps
    no more`, `no fragment route for a session row`, `no step-defaults route`),
    while the three "still reached" assertions pass in BOTH trees. So each half
    of this gate is measuring something that can fail.

- [x] G8: the whole tree is re-scanned after the edits and its zero-reference
      lists are empty again — no dead symbol, no dead import, no orphaned
      translation key, no dead CSS class or shell function was created or left
      behind by these removals. Manual: the five scanners live outside the
      repository (they are analysis tooling, not a project asset), so their
      output is recorded here rather than re-run by the checker.
  EVIDENCE: met — all five scanners re-run on the edited tree:
    zero-reference declarations 0, dead import bindings 0, unused destructured
    bindings 0, declarations-at-any-indentation 0, per-file locals 0 (after
    checking each of the 16 raw hits by `git grep -c`: every one has ≥2 real
    occurrences and is a stripping artefact), orphaned translation keys 0 of
    1178, orphaned CSS classes 0, orphaned shell functions 0, dead shell
    variables 0. Routes matched in exactly one place: only `/telegram-setup/`,
    which AGENTS.md, docs/plugins.md, SETUP_WITH_AGENT.md and test/e2e.mjs all
    name. Each scanner was proved against `4669f3d` (the tree before the FIRST
    dead-code pass) first: the symbol scanner rediscovers 14 of the 15 symbols
    and all 7 dead imports that pass removed, the i18n scanner rediscovers
    `runform.branch_mode` and `settings.coding_agents_hint`, the per-file
    scanner rediscovers `uiTimezone`, `lastCleanupRun` and `moveSuffix`.
