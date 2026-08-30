// Freilauf — where this installation keeps its things.
//
// The project was called cc-hub, so an installation that has not run
// `setup/migrate-from-cc-hub.sh` yet still has its configuration in
// `~/.config/cc-hub`, its database in `~/.local/share/cc-hub` and its deploy
// checkout in `~/agents/deploy/cc-hub`. The first release under the new name
// therefore has to be able to run out of the OLD layout — it is deployed by
// the old deploy script, into the old checkout, restarted by the old unit,
// with the old `EnvironmentFile`.
//
// The rule is one sentence, and it is written here and in `bin/fl-paths.sh`
// and nowhere else: **the new path when it exists, the old one when only that
// exists, the new one otherwise.** A fresh installation therefore never
// creates the old layout, and a migrated one never looks back.
//
// Not affected, and deliberately: `~/agents/runs`, `~/agents/worktrees`,
// `~/agents/integrate` and `~/agents/zusaetze` were never named after the
// product.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from './env.mjs'

/** The new path if it is there, the old one if only IT is there, else the new one. */
export function pick(neu, alt) {
  if (existsSync(neu)) return neu
  if (existsSync(alt)) return alt
  return neu
}

const xdg = (variable, fallback) => process.env[variable] || join(homedir(), ...fallback)

/** `~/.config/freilauf`, or the old `~/.config/cc-hub` while that is what exists. */
export function configDir() {
  const base = xdg('XDG_CONFIG_HOME', ['.config'])
  return pick(join(base, 'freilauf'), join(base, 'cc-hub'))
}

/** `~/.local/share/freilauf` — the database, the plugin packages, the small state files. */
export function dataDir() {
  return env('DATA_DIR') ?? pick(
    join(xdg('XDG_DATA_HOME', ['.local', 'share']), 'freilauf'),
    join(xdg('XDG_DATA_HOME', ['.local', 'share']), 'cc-hub'))
}

/** The checkout the systemd units start from (`bin/freilauf-deploy` owns it). */
export function deployDir() {
  return env('DEPLOY_DIR') ?? pick(
    join(homedir(), 'agents', 'deploy', 'freilauf'),
    join(homedir(), 'agents', 'deploy', 'cc-hub'))
}

/**
 * The SQLite file. Two questions, one rule: the directory may still be the old
 * one, and inside it the file may still carry the old name. A database that
 * exists is never left behind — creating `freilauf.db` next to a populated
 * `cc-hub.db` would look like a hub that lost every run it ever did.
 */
export function dbPath() {
  const dir = dataDir()
  return pick(join(dir, 'freilauf.db'), join(dir, 'cc-hub.db'))
}

/** The TLS material for the VPN proxy. */
export function certDir() {
  return env('CERT_DIR') ?? pick(
    join(homedir(), '.local', 'certs', 'freilauf'),
    join(homedir(), '.local', 'certs', 'cc-hub'))
}
