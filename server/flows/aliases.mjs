// Freilauf flows — step types that were renamed.
//
// A step's `type` is persisted: in `flows.definition` and in the definition
// snapshot every `flow_runs` row carries. Renaming one is therefore a data
// question, not a naming one — and this module is the answer, deliberately in a
// file of its own because both ends need it and they cannot import each other:
// `steps.mjs` reaches `run-def.mjs` and from there back into `flows/db.mjs`, so
// db.mjs importing steps.mjs would close a ring. Nothing is imported here at
// all, which is what makes it safe from either side.
//
// Two mechanisms, and both are wanted:
//
//   * `renameSteps()` rewrites a definition on the way OUT of the database, so
//     the designer, the validator and the variable catalog only ever see
//     today's names. It runs on read rather than as an UPDATE over every row: a
//     rewrite that runs on read cannot half-fail, a flow nobody opens is never
//     touched, and the new name is written back the next time it is saved.
//   * an alias in `STEP_MAP` (steps.mjs) is the belt under that brace. A
//     definition can reach the engine some other way — an older client posting
//     one, a suspended flow run resumed from a row nobody rewrote — and
//     "unknown step type 'telegram'" would fail a flow over a rename.

/** Old step type → the step it is today. */
export const STEP_ALIASES = { telegram: 'notify' }

/**
 * A copy of the definition with every aliased step type replaced. Recursive:
 * a renamed step inside a switch branch or a container body is renamed too.
 * Never mutates its input, and never throws on a shape it does not recognize —
 * a definition it cannot walk is handed back as it came.
 */
export function renameSteps(def) {
  if (!def || typeof def !== 'object') return def
  const walk = (seq) => (Array.isArray(seq) ? seq.map(step => {
    if (!step || typeof step !== 'object') return step
    const out = { ...step }
    if (STEP_ALIASES[out.type]) out.type = STEP_ALIASES[out.type]
    if (out.sequence) out.sequence = walk(out.sequence)
    if (out.branches && typeof out.branches === 'object') {
      out.branches = Object.fromEntries(Object.entries(out.branches).map(([k, v]) => [k, walk(v)]))
    }
    return out
  }) : seq)
  return { ...def, sequence: walk(def.sequence) }
}
