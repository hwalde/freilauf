# Two e2e cases for `run_merged` that need the real merge integrator

The branch `feat/flow-run-merged` brought the trigger, the dispatch and the
`shell_command` block. What it could not bring is a **real merge**: the
integrator (`server/integrate.mjs`) lives in the other branch, so the e2e group
"Flows: run_merged fires, and shell_command really runs" writes the merge the
way it will find it — by SQL, plus the `merged` event.

Whoever merges the two branches adds these two cases to that group. They are the
ones that prove the seam between the two pieces of work, which is exactly what
neither branch could test on its own.

## 1. A clean run is merged and the flow starts

- an agent run of the sandbox repo ends `done` with a commit on its branch
- the integrator merges it (whatever the branch calls to do that: the watcher
  pass, `integrateRun()`, the button)
- assert: `runs.merge_status='merged'`, `merged_sha` set, an event `merged`
  whose payload carries `sha` and a non-empty `files`
- after `flowsTick()`: exactly **one** flow run of the `run_merged` flow, its
  `trigger.run.id` the merged run, `trigger.merge.sha` equal to `merged_sha`,
  `trigger.merge.base` the repo's base branch, `trigger.merge.files` the paths
  the merge really changed (not the ones the run touched in its worktree)
- a second `flowsTick()` starts nothing more

## 2. A merge over a conflict run fires exactly once

- an origin run whose merge fails on a conflict (`merge_status` blocked), so the
  integrator starts a conflict run: `resolves_run_id` on the conflict run,
  `resolver_run_id` on the origin run
- the conflict run ends and its work is merged — **both** rows get
  `merge_status='merged'` with the **same** `merged_sha`
- after `flowsTick()`: exactly **one** flow run, and its `trigger.run.id` is the
  **origin** run, never the conflict run
- `trigger.merge.resolver_run_id` names the conflict run
- both rows carry `merge_dispatched=1` — the conflict run is marked and skipped,
  or the next pass would look at it again

The second case is the one worth having. The dispatch fires per run, the flow
has to fire per **integration**, and the two only differ when a conflict run was
involved. `test/unit.mjs` asserts the skip against hand-written rows; only the
real integrator proves that it writes the two rows the skip depends on.
