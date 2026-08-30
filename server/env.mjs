// Freilauf — the one place the hub reads its own environment variables.
//
// Every seam of this hub is an environment variable (`FREILAUF_DATA_DIR`,
// `FREILAUF_LOCAL_PORT`, `FREILAUF_QUOTA_JSON`, … — the test suites live on
// them). They were all called `CCHUB_*` before the project was renamed, and
// they are set in exactly the places a rename cannot reach on its own: the
// operator's `~/.config/…/env`, a systemd drop-in, a shell profile, a CI job.
//
// So a read goes `FREILAUF_X` first and `CCHUB_X` second, and it is written
// down HERE rather than at each of the ~60 call sites — one function is
// reviewable, sixty `??` chains are how half of them end up missing the
// fallback. `bin/fl-paths.sh` is the same rule for the shell scripts.
//
// Deliberately no coercion and no defaults of its own: `undefined` means "not
// set", and every caller keeps the `?? default` / `Number(...)` it had. The
// hub already has one entry in AGENTS.md for `Number('')` being a finite 0;
// a helper that quietly turned an empty string into a default would add a
// second one.

const NEW = 'FREILAUF_'
const OLD = 'CCHUB_'

/**
 * Variables whose NAME changed with the rename, not just its prefix. Both were
 * `CCHUB_CC_<script>`, and `CC_` in the middle stopped meaning anything the day
 * the scripts became `fl-*`.
 */
const ALIASES = {
  START_SCRIPT: 'CCHUB_CC_START',
  REPORT_SCRIPT: 'CCHUB_CC_REPORT',
}

/**
 * `env('DATA_DIR')` → `process.env.FREILAUF_DATA_DIR`, else the old
 * `CCHUB_DATA_DIR`, else `undefined`. The full name may be passed instead of
 * the suffix (`env('FREILAUF_DATA_DIR')` is the same question).
 */
export function env(name) {
  const key = name.startsWith(NEW) ? name.slice(NEW.length) : name
  const neu = process.env[NEW + key]
  if (neu !== undefined) return neu
  const alias = ALIASES[key]
  if (alias !== undefined) {
    const v = process.env[alias]
    if (v !== undefined) return v
  }
  const alt = process.env[OLD + key]
  if (alt !== undefined) return alt
  return undefined
}

/** True when either name is set to exactly this value — for the `=== '1'` switches. */
export function envIs(name, value) {
  return env(name) === value
}

/** Both names, for a caller that has to hand an environment on (plugin contexts). */
export function envNames(name) {
  const key = name.startsWith(NEW) ? name.slice(NEW.length) : name
  return ALIASES[key] ? [NEW + key, ALIASES[key]] : [NEW + key, OLD + key]
}
