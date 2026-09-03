// Freilauf — the hub's own agent skills, and where they are installed.
//
// This repository ships a family of skills (`skills/<name>/SKILL.md`) that
// teach ANY coding agent how to drive this hub: its runs, agents, repos,
// flows, statistics and its model choices. They are written to the open
// Agent Skills specification (agentskills.io), so the same directory is read
// by claude, cursor, opencode, hermes and everything else that follows it.
//
// Three questions, and this module answers all three:
//
//   1. WHERE does a coding agent look for skills? Not here — that is the
//      coding agent's own knowledge, so it lives in its plugin descriptor
//      (`skills: { user: [...], project: [...] }`, see docs/plugins.md), next
//      to `launch`, `goal` and `hookFiles`. The hub carries no vendor paths.
//   2. WHICH directories does the hub write to? The SMALLEST SET that covers
//      every configured coding agent. Three of the four shipped ones read
//      `~/.claude/skills`; only hermes does not. So the answer for a machine
//      with all four is two directories, and it FALLS OUT of the
//      declarations — nothing about it is typed in.
//   3. WHAT may be deleted again? Only what this hub wrote. Every installed
//      directory carries a marker file naming this installation, and the
//      state file lists them. A directory of the operator's own that happens
//      to have the same name is left alone and reported, never overwritten
//      and never removed.
//
// This is deliberately NOT the mechanism in `zusaetze.mjs`. That one is
// opt-in per run and therefore stays out of `.claude/skills`, because
// everything there is loaded automatically. These skills are the opposite by
// intent: they are about the hub itself, they are useless to a run that is
// not talking to it, and they cost nothing until an agent's description
// matcher decides they are relevant. That is why they may live in the
// automatic directories — and why the whole thing is off until the operator
// says yes (Settings → Skills, or the Welcome wizard).
//
// Copies, not symlinks. Claude Code documents that it follows a symlinked
// skill directory; the other three do not document it either way, and a
// symlink into the deploy checkout dies the day that checkout is moved or
// re-cloned. A copy costs a few kilobytes and cannot fail later.
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.mjs'
import { dataDir } from './paths.mjs'
import { getSetting } from './db.mjs'
import { allPlugins } from './plugins/registry.mjs'
import { isPluginEnabled } from './plugins/store.mjs'

/** The file an installed skill directory carries so the hub recognises its own work. */
export const MARKER = '.freilauf-skill.json'
export const STATE_VERSION = 1

/** `skills/` in this checkout — resolved from the module, never from the cwd. */
export function skillsSourceDir() {
  return env('SKILLS_SOURCE_DIR')
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

/** Where the hub remembers what it installed. Next to the database, not in the repo. */
export function skillsStateFile() {
  return env('SKILLS_STATE') ?? join(dataDir(), 'skills-installed.json')
}

/** The two switches (Settings → Skills). Installation is off until it is asked for. */
export function skillsInstallOn() { return getSetting('skills_install') === '1' }
export function skillsAutoUpdate() { return getSetting('skills_auto_update', '1') === '1' }

/**
 * The home directory the user-level declarations are resolved against.
 *
 * `FREILAUF_SKILLS_HOME` is a TEST FENCE as much as a setting, and the same
 * kind as `FREILAUF_PLUGIN_DIR`: every other sandbox variable points into the
 * suite's own directory, but a coding agent's skill directory is derived from
 * `$HOME` — so without this a suite run would write into (and later delete
 * from) the operator's real `~/.claude/skills`. A suite that does not set it is
 * not merely unreproducible, it is destructive.
 */
export function skillsHome() { return env('SKILLS_HOME') ?? homedir() }

/** `~/x` → `<home>/x`. A declaration may also carry an absolute path. */
export function expandHome(p, home = skillsHome()) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') return home
  if (s.startsWith('~/')) return join(home, s.slice(2))
  return s
}

// ---------------------------------------------------------------- the source

/** Frontmatter of a SKILL.md — tolerant, no YAML parser (same rule as zusaetze.mjs). */
function frontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out = {}
  if (!m) return out
  let key = null
  for (const raw of m[1].split(/\r?\n/)) {
    const f = raw.match(/^(name|description):\s*(.*)$/)
    if (f) { key = f[1]; out[key] = f[2].trim(); continue }
    // A folded scalar (`description: >`) continues on the indented lines below.
    if (key && /^\s+\S/.test(raw)) out[key] = `${out[key]} ${raw.trim()}`.trim()
    else if (/^\S/.test(raw)) key = null
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/^["'>|]\s*/, '').replace(/["']$/, '').trim()
  return out
}

/** Every file of a skill directory, relative and sorted — the marker excluded. */
function payloadFiles(dir, base = dir) {
  const out = []
  for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name === MARKER) continue
    const full = join(dir, d.name)
    if (d.isDirectory()) out.push(...payloadFiles(full, base))
    else if (d.isFile()) out.push({ rel: full.slice(base.length + 1).split('\\').join('/'), full })
  }
  return out
}

/** Content hash of a skill directory — what "is this copy current?" is decided on. */
export function skillHash(dir) {
  const h = createHash('sha256')
  for (const f of payloadFiles(dir)) {
    h.update(f.rel); h.update('\0')
    h.update(readFileSync(f.full)); h.update('\0')
  }
  return h.digest('hex')
}

/**
 * The skills this checkout ships: every `skills/<name>/` holding a SKILL.md.
 * `[{ name, title, description, dir, hash, files }]`, sorted. A missing source
 * directory is not an error — it simply means this build ships none.
 */
export function availableSkills() {
  const root = skillsSourceDir()
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const dir = join(root, d.name)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    let fm = {}
    try { fm = frontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8').slice(0, 8192)) } catch { /* a skill without readable frontmatter is still a skill */ }
    out.push({
      name: d.name,
      title: fm.name ?? d.name,
      description: fm.description ?? '',
      dir,
      hash: skillHash(dir),
      files: payloadFiles(dir).length,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ------------------------------------------------------- what the plugins say

/**
 * Every registered coding agent and the skill directories it reads.
 * `[{ id, label, enabled, user: [abs], project: [rel] }]` — a plugin without a
 * `skills` declaration is listed with two empty lists, because "this coding
 * agent has no skill mechanism the hub knows about" is an answer worth showing
 * on the Plugins page rather than a row that silently disappears.
 */
export function harnessSkillRoots() {
  return allPlugins()
    .filter(p => p.kind === 'harness')
    .map(({ id, plugin }) => ({
      id,
      label: plugin?.label ?? id,
      enabled: isPluginEnabled(id),
      user: (plugin?.skills?.user ?? []).map(p => expandHome(p)).filter(Boolean),
      project: (plugin?.skills?.project ?? []).map(p => String(p).trim()).filter(Boolean),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The smallest set of user-level directories that covers every given coding
 * agent — a greedy set cover, which for a handful of coding agents is exact
 * and, more importantly, DETERMINISTIC:
 *
 *   1. most coding agents covered wins,
 *   2. then the lowest summed preference rank (a plugin lists its own
 *      directory first, so a coding agent alone on the machine gets its
 *      native one),
 *   3. then the path, alphabetically.
 *
 * Returns `[{ dir, harnesses: [id] }]`. A coding agent that declares no user
 * directory covers itself with nothing and is reported by `skillTargets()`.
 */
export function coveringUserRoots(harnesses) {
  const need = new Set(harnesses.filter(h => h.user.length).map(h => h.id))
  const rank = new Map()          // dir -> { covers: Set<id>, rankSum }
  for (const h of harnesses) {
    h.user.forEach((dir, i) => {
      const e = rank.get(dir) ?? { covers: new Set(), rankSum: 0 }
      e.covers.add(h.id); e.rankSum += i
      rank.set(dir, e)
    })
  }
  const chosen = []
  while (need.size) {
    let best = null
    for (const [dir, e] of rank) {
      const gain = [...e.covers].filter(id => need.has(id)).length
      if (!gain) continue
      const cand = { dir, gain, rankSum: e.rankSum, covers: e.covers }
      if (!best || cand.gain > best.gain
        || (cand.gain === best.gain && cand.rankSum < best.rankSum)
        || (cand.gain === best.gain && cand.rankSum === best.rankSum && cand.dir < best.dir)) best = cand
    }
    if (!best) break            // cannot happen: every id in `need` has a directory
    chosen.push({ dir: best.dir, harnesses: [...best.covers].filter(id => need.has(id)).sort() })
    for (const id of best.covers) need.delete(id)
  }
  return chosen.sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * Where this installation would put its skills right now.
 * `{ targets: [{dir, harnesses}], skipped: [{id, reason}] }` — `skipped` names
 * a configured coding agent the hub cannot serve, so the page can say so
 * instead of quietly installing nothing for it.
 */
export function skillTargets(roots = harnessSkillRoots()) {
  const enabled = roots.filter(r => r.enabled)
  const usable = enabled.filter(r => r.user.length)
  return {
    targets: coveringUserRoots(usable),
    skipped: enabled.filter(r => !r.user.length).map(r => ({ id: r.id, label: r.label, reason: 'no_declaration' })),
  }
}

// ------------------------------------------------------------------ the state

export function readState() {
  try {
    const raw = JSON.parse(readFileSync(skillsStateFile(), 'utf8'))
    return { version: STATE_VERSION, entries: Array.isArray(raw?.entries) ? raw.entries : [] }
  } catch { return { version: STATE_VERSION, entries: [] } }
}

function writeState(state) {
  const file = skillsStateFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: STATE_VERSION, entries: state.entries }, null, 2)}\n`, { mode: 0o600 })
  } catch (e) { console.log(`[freilauf] skills: state not written (${e.message})`) }
}

/**
 * Does this directory belong to us? The marker is the primary answer, because
 * it travels WITH the directory: a fresh data directory loses the state file
 * but not the knowledge of who wrote the copy. The state file is the second
 * answer, for a marker somebody deleted.
 */
export function ownedByHub(dir, state = readState()) {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'))
    if (m && m.freilauf === true) return true
  } catch { /* no marker, or not ours */ }
  return state.entries.some(e => e.dir === dir)
}

// ---------------------------------------------------------------- installing

function copySkill(source, target) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, dereference: true })
}

function writeMarker(target, skill) {
  writeFileSync(join(target, MARKER), `${JSON.stringify({
    freilauf: true, skill: skill.name, hash: skill.hash, at: new Date().toISOString(),
  }, null, 2)}\n`)
}

/**
 * The hash of what is REALLY in `dir` — measured, not remembered.
 *
 * The marker records the hash the copy was made from, and that was the first
 * answer here. It is the wrong one: it says nothing about the copy as it
 * stands now, so a file edited by hand in the target directory looked current
 * for ever and "keep them up to date" quietly meant "keep the marker up to
 * date". Measuring costs one directory read per skill per sync, which for a
 * handful of small text files is nothing next to a promise that does not hold.
 */
function installedHash(dir) {
  try { return skillHash(dir) } catch { return null }
}

/**
 * Bring the installation in line with the settings. One function, both
 * directions — which is the whole point: "installed" is not an action that was
 * once performed, it is a state that is re-established.
 *
 *   install off  → every directory this hub wrote is removed
 *   install on   → every skill exists in every target directory
 *                  ...its CONTENT is refreshed only when `skills_auto_update`
 *                     is on (or `force`), so an operator who switched updates
 *                     off keeps the copy they have
 *
 * Never throws. The report is machine-readable; the page translates it.
 */
export function syncSkills({ force = false, install = null, autoUpdate = null } = {}) {
  const on = install ?? skillsInstallOn()
  const refresh = force || (autoUpdate ?? skillsAutoUpdate())
  const state = readState()
  const report = { on, installed: [], updated: [], removed: [], unchanged: [], conflicts: [], errors: [], targets: [], skipped: [] }

  const skills = availableSkills()
  const { targets, skipped } = on ? skillTargets() : { targets: [], skipped: [] }
  report.targets = targets
  report.skipped = skipped

  const wanted = new Map()      // dir -> {skill, root}
  for (const t of targets) for (const s of skills) wanted.set(join(t.dir, s.name), { skill: s, root: t.dir })

  // 1. remove what is no longer wanted — ours only, and said out loud when not.
  const keep = []
  for (const e of state.entries) {
    if (wanted.has(e.dir)) { keep.push(e); continue }
    if (!existsSync(e.dir)) continue                       // somebody removed it by hand
    if (!ownedByHub(e.dir, state)) { report.conflicts.push({ dir: e.dir, reason: 'not_ours' }); continue }
    try { rmSync(e.dir, { recursive: true, force: true }); report.removed.push(e.dir) }
    catch (err) { report.errors.push({ dir: e.dir, error: err.message }) }
  }

  // 2. install / refresh what is wanted.
  const entries = new Map(keep.map(e => [e.dir, e]))
  for (const [dir, { skill, root }] of wanted) {
    try {
      const there = existsSync(dir)
      if (there && !ownedByHub(dir, state)) { report.conflicts.push({ dir, skill: skill.name, reason: 'not_ours' }); continue }
      const have = there ? installedHash(dir) : null
      // What the state file records is what is REALLY in that directory, which
      // with updates switched off is not the same as what this build ships.
      // A state that recorded the source's hash there would claim a copy the
      // page then contradicts one line further down.
      let hash = skill.hash
      let at = new Date().toISOString()
      if (there && (have === skill.hash || !refresh)) {
        report.unchanged.push(dir)
        hash = have ?? skill.hash
        at = state.entries.find(e => e.dir === dir)?.at ?? at   // installed then, not verified now
      } else {
        copySkill(skill.dir, dir)
        writeMarker(dir, skill)
        ;(there ? report.updated : report.installed).push(dir)
      }
      entries.set(dir, { dir, root, skill: skill.name, hash, at })
    } catch (err) { report.errors.push({ dir, skill: skill.name, error: err.message }) }
  }

  writeState({ entries: [...entries.values()].sort((a, b) => a.dir.localeCompare(b.dir)) })
  return report
}

/**
 * What switching installation OFF would delete — the list the confirmation
 * dialog shows. `owned: false` means the hub would leave that directory alone.
 */
export function removalPlan() {
  const state = readState()
  return state.entries
    .filter(e => existsSync(e.dir))
    .map(e => ({ dir: e.dir, skill: e.skill, owned: ownedByHub(e.dir, state) }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * Directories the hub WOULD write to and may not, because something else is
 * already there under that name. Recomputed on every render rather than
 * carried across the redirect from a sync: a conflict is a state of the file
 * system, and one that has been resolved by hand must stop being reported
 * without anybody having to press anything. `[{dir, skill}]`.
 */
export function skillConflicts() {
  if (!skillsInstallOn()) return []
  const state = readState()
  const out = []
  for (const t of skillTargets().targets) {
    for (const s of availableSkills()) {
      const dir = join(t.dir, s.name)
      if (existsSync(dir) && !ownedByHub(dir, state)) out.push({ dir, skill: s.name })
    }
  }
  return out
}

/** What is installed where, for the settings page. `[{dir, skills:[{name, current}]}]`. */
export function installedOverview() {
  const state = readState()
  const current = new Map(availableSkills().map(s => [s.name, s.hash]))
  const byRoot = new Map()
  for (const e of state.entries) {
    if (!existsSync(e.dir)) continue
    const root = e.root ?? resolve(e.dir, '..')
    const list = byRoot.get(root) ?? []
    list.push({ name: e.skill, dir: e.dir, current: current.get(e.skill) === installedHash(e.dir) })
    byRoot.set(root, list)
  }
  return [...byRoot.entries()]
    .map(([dir, list]) => ({ dir, skills: list.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * The one call the rest of the hub makes. Fire-and-forget, never throws, and
 * silent when there is nothing to do — it runs at every start and after every
 * plugin change, and a hub that logged a paragraph each time would be worse
 * than one that logged nothing.
 */
export function syncSkillsQuiet(reason = '') {
  try {
    if (!skillsInstallOn()) {
      // Still worth a pass: a switch that was turned off while the hub was
      // down leaves directories behind that nobody would otherwise remove.
      if (!readState().entries.length) return null
    }
    const r = syncSkills()
    const moved = r.installed.length + r.updated.length + r.removed.length
    if (moved || r.conflicts.length || r.errors.length) {
      console.log(`[freilauf] skills${reason ? ` (${reason})` : ''}: `
        + `${r.installed.length} installed, ${r.updated.length} updated, ${r.removed.length} removed`
        + `${r.conflicts.length ? `, ${r.conflicts.length} left alone` : ''}`
        + `${r.errors.length ? `, ${r.errors.length} failed` : ''}`)
    }
    return r
  } catch (e) {
    console.log(`[freilauf] skills: sync failed (${e.message})`)
    return null
  }
}

/** Is `dir` a directory at all? Used by the page to say "will be created". */
export function rootExists(dir) {
  try { return statSync(dir).isDirectory() } catch { return false }
}
