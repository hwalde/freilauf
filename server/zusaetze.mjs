// Freilauf — extra skills: selectable work instructions for runs and agents.
//
// DELIBERATELY not a .claude/skills folder: there every claude instance would
// load the skill automatically. These skills (e.g. "unlazy" against lazy small
// models) shall only take effect when they were CHECKED while creating an
// agent or run — the prompt then gets a line pointing at the SKILL.md (full
// path).
//
// Location: ~/agents/zusaetze/<name>/SKILL.md — outside the repo; installed by
// setup/02-install-scripts.sh (git clone, commit-pinned). Every folder with a
// SKILL.md automatically appears as a checkbox in the forms.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { t } from './i18n.mjs'
import { env } from './env.mjs'

export function zusaetzeDir() {
  return env('ZUSAETZE_DIR') ?? join(homedir(), 'agents', 'zusaetze')
}

/** Frontmatter fields (name, description) from a SKILL.md — tolerant, no YAML parser. */
function frontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/)
  const out = {}
  if (!m) return out
  for (const zeile of m[1].split('\n')) {
    const f = zeile.match(/^(name|description):\s*(.+)$/)
    if (f) out[f[1]] = f[2].trim()
  }
  return out
}

/**
 * Available extra skills: [{ name, titel, beschreibung, pfad }].
 * 'name' is the folder name (which is also what goes in the DB), 'pfad' the
 * full path to the SKILL.md. If the folder is missing, there are simply no
 * checkboxes.
 */
export function zusatzSkills() {
  const dir = zusaetzeDir()
  let eintraege = []
  try { eintraege = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const d of eintraege) {
    if (!d.isDirectory()) continue
    const pfad = join(dir, d.name, 'SKILL.md')
    if (!existsSync(pfad)) continue
    let fm = {}
    try { fm = frontmatter(readFileSync(pfad, 'utf8').slice(0, 4096)) } catch {}
    out.push({ name: d.name, titel: fm.name ?? d.name, beschreibung: fm.description ?? '', pfad })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Validate the selection from a form (checkboxes 'skills', multiple) and
 * return it as JSON for the DB. Unknown names are dropped — only what really
 * exists ends up in the DB; null instead of '[]' so legacy rows stay
 * inconspicuous.
 */
export function skillsAusFormular(b) {
  // parseForm puts multi-checkboxes under '<name>_list'; JSON callers may also
  // send a list directly.
  const roh = Array.isArray(b.skills_list) ? b.skills_list
    : b.skills == null ? [] : Array.isArray(b.skills) ? b.skills : [b.skills]
  const bekannt = new Set(zusatzSkills().map(s => s.name))
  const gewaehlt = [...new Set(roh.filter(s => bekannt.has(s)))].map(name => {
    // Dial value (e.g. depth) from the matching select — valid values only.
    const wert = String(b[`skill_regler_${name}`] ?? '').trim()
    const erlaubt = (REGLER[name]?.optionen ?? []).some(([v]) => v !== '' && v === wert)
    return erlaubt ? `${name}:${wert}` : name
  })
  return gewaehlt.length ? JSON.stringify(gewaehlt) : null
}

export function skillListe(skillsJson) {
  try { return JSON.parse(skillsJson || '[]') } catch { return [] }
}

// ---- dials per skill --------------------------------------------------------
// Some skills have a documented knob. For unlazy that is the depth-tree depth:
// SKILL.md names "tree N" as an explicit trigger, and references/method.md
// promises "Honor an explicit tree N request". Depth ≤3 works solo in one
// session, ≥4 orchestrates with plan.md, own gates per subtask and parallel
// dispatch (OWNS:/rolling dispatch).
// The value is stored in the entry itself: "unlazy" or "unlazy:4".
// Labels/options are i18n keys, resolved when rendering.
const REGLER = {
  unlazy: {
    labelKey: 'skills.depth_label',
    optionen: [
      ['', 'skills.depth_auto'],
      ['2', 'skills.depth_2'],
      ['3', 'skills.depth_3'],
      ['4', 'skills.depth_4'],
      ['5', 'skills.depth_5'],
    ],
  },
}

export function eintragName(eintrag) { return String(eintrag).split(':')[0] }
export function eintragWert(eintrag) {
  const w = String(eintrag).split(':')[1]
  return w && /^\d$/.test(w) ? w : null
}
/** Display text for the detail page: "unlazy (depth 4)" instead of "unlazy:4". */
export function skillAnzeige(skillsJson) {
  return skillListe(skillsJson).map(e => {
    const w = eintragWert(e)
    return w ? `${eintragName(e)} (${t('skills.depth_short', { n: w })})` : eintragName(e)
  })
}

/**
 * Prompt addition for the selected skills. The run carries a COPY of the
 * selection — if a skill later disappears from disk, the addition says so
 * honestly instead of pointing at a dead file.
 */
export function skillPromptZusatz(skillsJson) {
  const namen = skillListe(skillsJson)
  if (!namen.length) return ''
  const vorhanden = new Map(zusatzSkills().map(s => [s.name, s]))
  const zeilen = ['Working method (selected extra skills):']
  for (const eintrag of namen) {
    const n = eintragName(eintrag), wert = eintragWert(eintrag)
    const s = vorhanden.get(n)
    if (s) {
      zeilen.push(`- FIRST read the file ${s.pfad} completely and apply the working method described`
        + ` there during the ENTIRE task. File references in it are relative to ${join(s.pfad, '..')}.`)
      // unlazy: "tree N" is the documented trigger for the depth-tree depth.
      if (wert && n === 'unlazy') {
        zeilen.push(`  For this task "tree ${wert}" is explicitly requested — use the depth tree with depth ${wert}.`)
      }
    } else {
      zeilen.push(`- (Skill '${n}' was selected but no longer exists under ${zusaetzeDir()} — skip it.)`)
    }
  }
  return zeilen.join('\n')
}

/** Checkbox markup for the forms (single run + agent). */
export function skillFelder(skillsJson) {
  const eintraege = new Map(skillListe(skillsJson).map(e => [eintragName(e), eintragWert(e)]))
  const skills = zusatzSkills()
  if (!skills.length) return ''
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  return `<fieldset><legend>${esc(t('skills.legend'))}</legend>
  ${skills.map(s => {
    const regler = REGLER[s.name]
    const wert = eintraege.get(s.name) ?? ''
    return `<label class="chk"><input type="checkbox" name="skills" value="${esc(s.name)}" ${eintraege.has(s.name) ? 'checked' : ''}>
    <b>${esc(s.titel)}</b>${s.beschreibung ? ` — <span class="dim">${esc(s.beschreibung.slice(0, 180))}</span>` : ''}</label>
    ${regler ? `<label class="chk skill-regler">↳ ${esc(t(regler.labelKey))}
      <select name="skill_regler_${esc(s.name)}">${regler.optionen.map(([v, key]) =>
        `<option value="${esc(v)}" ${v === wert ? 'selected' : ''}>${esc(t(key))}</option>`).join('')}</select></label>` : ''}`
  }).join('')}
  </fieldset>`
}
