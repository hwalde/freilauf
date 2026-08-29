# Gates: land the weekly "daily" collapse on main with a clean GATES.md

OWNS: server/util.mjs, lang/en.json, lang/de.json, lang/zh.json, test/unit.mjs,
GATES.md, PLAN.md

Scope: Carry the feature from run fbb33d06 (a weekly schedule covering all
seven weekdays reads "daily") onto current main, with a GATES.md that contains
no machine-specific values, and let the hub's integrator merge it.

- [x] G1: the collapse is implemented and covered by the unit suite
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — node test/unit.mjs: 260 checks passed, incl. the
    "all seven weekdays every week read \"daily\"" group and the
    "all days with a multi-week interval keep the day list" group.

- [x] G2: the exact outcome — all days + every week reads "daily at 07:30",
  every 2 weeks keeps its cadence and day list, a partial selection is the
  ordinary weekly line
  CHECK: node -e "import('./server/util.mjs').then(m=>{const s=m.scheduleText;const a={schedule_kind:'woechentlich',schedule_days:'1,2,3,4,5,6,0',schedule_time:'07:30'};const b={...a,schedule_weeks:2,schedule_anchor:'2026-08-24'};const c={...a,schedule_days:'1,3,5'};const r=[];if(s(a)!=='daily at 07:30')r.push('all-days weekly: '+s(a));if(s(b)!=='every 2 weeks: Mon, Tue, Wed, Thu, Fri, Sat, Sun at 07:30')r.push('every-2-weeks: '+s(b));if(s(c)!=='weekly: Mon, Wed, Fri at 07:30')r.push('partial: '+s(c));if(r.length)throw new Error(r.join(' | '));console.log('all-days weekly reads daily: OK')})"
  EXPECT: all-days weekly reads daily: OK
  EVIDENCE: met — the one-liner exited 0 and printed the marker; full evidence
    lives in the machine-local .unlazy/ (gitignored).

- [x] G3: no machine-specific value in the committed state — the pre-push
  check's own scan of HEAD finds nothing
  CHECK: bash pruefe-vor-push.sh
  EXPECT: OK: no forbidden patterns in the committed state.
  EVIDENCE: met — the hook printed the OK line on the committed state.

- [x] G4: the i18n key sets stay identical across all three language files
  CHECK: node test/unit.mjs
  EXPECT: checks passed
  EVIDENCE: met — the i18n group enforces identical key sets; the unit suite
    is green (see G1).

- [x] G5: the feature lands on origin/main via the hub's integrator
  EVIDENCE: met — after cc-report done the integrator merged and pushed; the
    tip of origin/main carries the scheduleText collapse and the daily_line key.
