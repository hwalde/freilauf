// Freilauf — sandbox profiles: the spec of §7.2 under a name
// (SANDBOX_RESEARCH.md §7.13).
//
// A repo names one profile as its default, an agent may name another, and both
// may narrow it. The table is small and the CRUD is dull; the one rule worth
// writing down is what happens when somebody edits a built-in.
//
// ## A built-in is edited by writing a copy
//
// The hub seeds four profiles (`builtin = 1`). They are the hub's own defaults,
// which means a later release must be able to correct them — a "Balanced" that
// still names a registry that moved is worse than no default at all. But an
// operator who tuned one has an equal claim to their edit surviving the next
// deploy. Both are true, so they are kept apart: `saveProfile()` on a built-in
// INSERTS a copy with `builtin = 0`, and `seedBuiltinProfiles()` only ever
// rewrites rows that are still marked built-in. Nobody's work is silently
// overwritten, in either direction.
import db from '../db.mjs'
import { normalizeSpec } from './spec.mjs'
import { engineCapabilities } from './proxy.mjs'

/**
 * The four of §7.13 — the Docker Sandboxes trio plus the rollout mode.
 *
 * `name` is stored, English and stable, because it is this row's identity and
 * a database cannot follow the reader's language; `titleKey` and `descKey` are
 * what a page prints. A profile the operator renames simply becomes their own
 * row, which is exactly the copy-on-write rule above.
 */
// ## A shipped profile must be able to start a run
//
// Three of these four asked for `secrets.mode: 'inject'` and
// `network.engine: 'iron-proxy'`, and shipped that way for a while — with the
// consequence that Balanced, Locked down and Audit **could not start a run on
// any machine**, because `inject` needs an engine that terminates TLS and
// iron-proxy is not installed anywhere yet. The refusal at launch was right
// (§7.8: falling back to `env` would put the real key inside the very container
// the profile promised held nothing but a placeholder). What was wrong was
// promising it in the default.
//
// So the shipped defaults are what a plain Docker installation can really run:
// the built-in CONNECT proxy, `secrets.mode: 'env'`. That is not a retreat from
// the design — the allowlist, the read-only root, the resource fence and the
// per-run home are the wall, and every one of them works today. `inject` is an
// EXPLICIT UPGRADE: install and configure iron-proxy, copy a profile (editing a
// built-in writes a copy — see above) and set
//
//     "network": { "engine": "iron-proxy", "tlsTerminate": true },
//     "secrets": { "mode": "inject" }
//
// The three settings are one decision and stand together; the profile editor
// refuses `inject` where the chosen engine cannot do it, and `setSecrets()` on
// the built-in engine refuses it again at launch. A default that cannot start a
// run is the one thing worse than a default that is not the strictest possible.
export const BUILTIN_PROFILES = [
  {
    key: 'balanced',
    name: 'Balanced',
    titleKey: 'sandbox.profile.balanced',
    descKey: 'sandbox.profile.balanced_desc',
    spec: {
      network: {
        mode: 'allowlist',
        engine: 'builtin',
        presets: ['harness', 'provider', 'git-host', 'package-registries'],
        tlsTerminate: false,
      },
      secrets: { mode: 'env', gitFetch: 'mirror' },
      resources: { memory: '8g', memorySwap: '8g', cpus: 4 },
      innerSandbox: 'off',
    },
  },
  {
    key: 'locked_down',
    name: 'Locked down',
    titleKey: 'sandbox.profile.locked_down',
    descKey: 'sandbox.profile.locked_down_desc',
    spec: {
      network: {
        mode: 'allowlist',
        engine: 'builtin',
        // The model and nothing else. No package registry, so a run that wants
        // to install something has to be given it — which is the point.
        presets: ['harness', 'provider'],
        tlsTerminate: false,
      },
      filesystem: { readOnlyRoot: true, extras: 'ro' },
      secrets: { mode: 'env', gitFetch: 'mirror' },
      resources: { memory: '4g', memorySwap: '4g', cpus: 2 },
      innerSandbox: 'off',
    },
  },
  {
    key: 'open_network',
    name: 'Open network',
    titleKey: 'sandbox.profile.open_network',
    descKey: 'sandbox.profile.open_network_desc',
    spec: {
      // The filesystem and the resource limits are the whole wall here. For the
      // repository whose build reaches half the internet and where an allowlist
      // would be a week of whack-a-mole — still worth having, because the
      // container is still a container.
      network: { mode: 'open', engine: 'builtin', presets: [], tlsTerminate: false },
      secrets: { mode: 'env', gitFetch: 'mirror' },
      resources: { memory: '8g', memorySwap: '8g', cpus: 4 },
      innerSandbox: 'off',
    },
  },
  {
    key: 'audit',
    name: 'Audit',
    titleKey: 'sandbox.profile.audit',
    descKey: 'sandbox.profile.audit_desc',
    spec: {
      // Balanced, but nothing is blocked: every request that WOULD have been
      // denied is written down instead. The mode one rolls out in — an
      // allowlist is only believable once somebody has read a week of what it
      // would have cost.
      network: {
        mode: 'allowlist',
        engine: 'builtin',
        presets: ['harness', 'provider', 'git-host', 'package-registries'],
        auditOnly: true,
        tlsTerminate: false,
      },
      secrets: { mode: 'env', gitFetch: 'mirror' },
      resources: { memory: '8g', memorySwap: '8g', cpus: 4 },
      innerSandbox: 'off',
    },
  },
]

const BUILTIN_BY_NAME = new Map(BUILTIN_PROFILES.map(p => [p.name, p]))

export function listProfiles() {
  return db.prepare('SELECT * FROM sandbox_profiles ORDER BY builtin DESC, name').all()
}

export function getProfile(id) {
  const n = Number(id)
  if (!Number.isFinite(n) || n <= 0) return null
  return db.prepare('SELECT * FROM sandbox_profiles WHERE id = ?').get(n) ?? null
}

export function getProfileByName(name) {
  return db.prepare('SELECT * FROM sandbox_profiles WHERE name = ?').get(String(name ?? '')) ?? null
}

/**
 * The stored document of a profile, as a partial spec. A row that is missing
 * or holds broken JSON answers `{}` — a page must never crash over a profile,
 * and `{}` is a valid profile by construction (§7.2).
 */
export function profileSpec(id) {
  const row = getProfile(id)
  if (!row) return {}
  try {
    const doc = JSON.parse(row.spec || '{}')
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
  } catch {
    return {}
  }
}

/** The same, filled out against DEFAULT_SPEC — for anything that READS fields. */
export function profileSpecFull(id) {
  return normalizeSpec(profileSpec(id))
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1-$2')

/** A free name near the one that was asked for — the `moveAgent()` rule. */
function freeName(wanted, excludeId = null) {
  const taken = (n) => {
    const row = getProfileByName(n)
    return !!row && row.id !== excludeId
  }
  if (!taken(wanted)) return wanted
  const copy = `${wanted} (copy)`
  return taken(copy) ? `${wanted} ${stamp()}` : copy
}

/**
 * Write a profile. `spec` may be an object or the JSON text a form field held.
 *
 * Returns `{ id, name, copied, problems }` — `problems` are i18n keys with
 * params, like every other form answer in this module. Editing a built-in
 * writes a copy instead (see the header), and `copied` says so, because a save
 * that quietly landed somewhere else is a save the operator cannot find again.
 */
export function saveProfile({ id = null, name, spec = {} } = {}) {
  const problems = []
  const wanted = String(name ?? '').trim()
  if (!wanted) problems.push({ key: 'sandbox.problem.profile_name_missing', params: {} })

  let doc = spec
  if (typeof doc === 'string') {
    const raw = doc.trim()
    if (raw === '') doc = {}
    else {
      try { doc = JSON.parse(raw) } catch (err) {
        problems.push({ key: 'sandbox.problem.json', params: { error: String(err.message) } })
        doc = null
      }
    }
  }
  if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc))) {
    problems.push({ key: 'sandbox.problem.not_object', params: {} })
    doc = null
  }
  // A profile that names BOTH `secrets.mode: inject` and an engine that cannot
  // inject contradicts itself, and the contradiction is only noticed at launch
  // otherwise — where it fails a run rather than a form. Deliberately narrow:
  // only when ONE document says both. A profile asking for `inject` without
  // naming an engine is not refused, because the engine may come from the hub
  // setting or from the layer above, and refusing it here would forbid a
  // combination that resolves perfectly well.
  const wantsInject = doc?.secrets?.mode === 'inject'
  const namedEngine = typeof doc?.network?.engine === 'string' ? doc.network.engine : null
  if (wantsInject && namedEngine && engineCapabilities(namedEngine).inject !== true) {
    problems.push({ key: 'sandbox.problem.profile_inject_engine', params: { engine: namedEngine } })
  }
  if (problems.length) return { id: null, name: wanted, copied: false, problems }

  const text = JSON.stringify(doc)
  const existing = id === null || id === undefined || id === '' ? null : getProfile(id)
  if ((id ?? '') !== '' && !existing) {
    return { id: null, name: wanted, copied: false, problems: [{ key: 'sandbox.problem.profile_unknown', params: { id: String(id) } }] }
  }

  // Copy-on-write: a built-in keeps its own row so the next hub release may
  // still correct it, and the edit becomes a row of the operator's own.
  if (existing && existing.builtin) {
    const finalName = freeName(wanted === existing.name ? `${wanted} (edited)` : wanted)
    const info = db.prepare(`INSERT INTO sandbox_profiles (name, spec, builtin) VALUES (?, ?, 0)`).run(finalName, text)
    return { id: Number(info.lastInsertRowid), name: finalName, copied: true, problems: [] }
  }
  if (existing) {
    const finalName = freeName(wanted, existing.id)
    db.prepare(`UPDATE sandbox_profiles SET name = ?, spec = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(finalName, text, existing.id)
    return { id: existing.id, name: finalName, copied: false, problems: [] }
  }
  const finalName = freeName(wanted)
  const info = db.prepare(`INSERT INTO sandbox_profiles (name, spec, builtin) VALUES (?, ?, 0)`).run(finalName, text)
  return { id: Number(info.lastInsertRowid), name: finalName, copied: false, problems: [] }
}

/**
 * Remove a profile.
 *
 * A built-in is REFUSED rather than removed: `seedBuiltinProfiles()` would put
 * it back at the next start, and a delete that undoes itself is a lie. What an
 * operator wants there is a different default on the repo, not a hole in the
 * list.
 *
 * Whoever pointed at it stops pointing (repos and agents fall back to the layer
 * above, which is what an unset profile has always meant). A RUN is left alone
 * on purpose: once it launched, `runs.sandbox_spec` is the truth about what it
 * ran as, and the profile id next to it is only how it got there.
 */
export function deleteProfile(id) {
  const row = getProfile(id)
  if (!row) return { ok: false, problems: [{ key: 'sandbox.problem.profile_unknown', params: { id: String(id) } }] }
  if (row.builtin) return { ok: false, problems: [{ key: 'sandbox.problem.profile_builtin', params: { name: row.name } }] }
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE repos SET sandbox_profile_id = NULL WHERE sandbox_profile_id = ?').run(row.id)
    db.prepare('UPDATE agents SET sandbox_profile_id = NULL WHERE sandbox_profile_id = ?').run(row.id)
    db.prepare('DELETE FROM sandbox_profiles WHERE id = ?').run(row.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    return { ok: false, problems: [{ key: 'sandbox.problem.profile_delete', params: { error: String(err.message) } }] }
  }
  return { ok: true, problems: [] }
}

/**
 * Seed the four built-ins, idempotently. Called once when this module is first
 * imported — the same place `panel_values` gets its table — so anything that
 * lists profiles finds them, whether the request came through a page, a flow or
 * a test.
 *
 * A row that is still `builtin = 1` is brought back in line with the code, so a
 * hub update keeps its own defaults current. A row an operator made (the copy
 * of a built-in, or one of their own) is never touched.
 */
export function seedBuiltinProfiles() {
  const ins = db.prepare(`INSERT INTO sandbox_profiles (name, spec, builtin) VALUES (?, ?, 1)`)
  const upd = db.prepare(`UPDATE sandbox_profiles SET spec = ?, updated_at = datetime('now') WHERE id = ? AND builtin = 1`)
  for (const p of BUILTIN_PROFILES) {
    const text = JSON.stringify(p.spec)
    const row = getProfileByName(p.name)
    if (!row) ins.run(p.name, text)
    else if (row.builtin && row.spec !== text) upd.run(text, row.id)
  }
}

/** The built-in this row came from, if any — for the label a page prints. */
export function builtinFor(row) {
  return row?.builtin ? (BUILTIN_BY_NAME.get(row.name) ?? null) : null
}

try {
  seedBuiltinProfiles()
} catch {
  // A hub whose profile table cannot be seeded still starts: the sandbox is an
  // opt-in feature, and every layer below treats "no profile" as `{}`.
}
