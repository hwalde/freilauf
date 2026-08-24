// cc-hub — Zusatz-Skills: wählbare Arbeitsanweisungen für Läufe und Agenten.
//
// BEWUSST kein .claude/skills-Ordner: dort würde jede claude-Instanz den Skill
// automatisch laden. Diese Skills (z. B. „unlazy" gegen faule kleine Modelle) sollen
// nur wirken, wenn sie beim Anlegen eines Agenten oder Laufs ANGEHAKT wurden — dann
// bekommt der Prompt eine Zeile, die auf die SKILL.md (voller Pfad) verweist.
//
// Ablage: ~/agents/zusaetze/<name>/SKILL.md — außerhalb des Repos; installiert wird
// über setup/02-install-scripts.sh (git clone, Commit-gepinnt). Jeder Ordner mit
// einer SKILL.md taucht automatisch als Häkchen in den Formularen auf.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function zusaetzeDir() {
  return process.env.CCHUB_ZUSAETZE_DIR ?? join(homedir(), 'agents', 'zusaetze')
}

/** Frontmatter-Felder (name, description) aus einer SKILL.md — tolerant, ohne YAML-Parser. */
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
 * Verfügbare Zusatz-Skills: [{ name, titel, beschreibung, pfad }].
 * 'name' ist der Ordnername (das ist auch, was in der DB steht), 'pfad' der volle
 * Pfad zur SKILL.md. Fehlt der Ordner ganz, gibt es schlicht keine Häkchen.
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
 * Auswahl aus einem Formular (Checkboxen 'skills', mehrfach) prüfen und als JSON
 * für die DB liefern. Unbekannte Namen fliegen raus — in der DB steht nur, was es
 * wirklich gibt; null statt '[]', damit Bestandszeilen unauffällig bleiben.
 */
export function skillsAusFormular(b) {
  // parseForm legt Mehrfach-Checkboxen unter '<name>_list' ab; JSON-Aufrufer können
  // auch direkt eine Liste schicken.
  const roh = Array.isArray(b.skills_list) ? b.skills_list
    : b.skills == null ? [] : Array.isArray(b.skills) ? b.skills : [b.skills]
  const bekannt = new Set(zusatzSkills().map(s => s.name))
  const gewaehlt = [...new Set(roh.filter(s => bekannt.has(s)))].map(name => {
    // Regler-Wert (z. B. Tiefe) aus dem zugehörigen Select — nur gültige Werte.
    const wert = String(b[`skill_regler_${name}`] ?? '').trim()
    const erlaubt = (REGLER[name]?.optionen ?? []).some(([v]) => v !== '' && v === wert)
    return erlaubt ? `${name}:${wert}` : name
  })
  return gewaehlt.length ? JSON.stringify(gewaehlt) : null
}

export function skillListe(skillsJson) {
  try { return JSON.parse(skillsJson || '[]') } catch { return [] }
}

// ---- Regler je Skill --------------------------------------------------------
// Manche Skills haben einen dokumentierten Drehknopf. Bei unlazy ist das die
// Depth-Tree-Tiefe: SKILL.md nennt „tree N" als expliziten Trigger, und
// references/method.md verspricht „Honor an explicit tree N request". Tiefe ≤3
// arbeitet solo in einer Session, ≥4 orchestriert mit plan.md, eigenen Gates je
// Teilaufgabe und paralleler Vergabe (OWNS:/rolling dispatch).
// Gespeichert wird der Wert im Eintrag selbst: "unlazy" oder "unlazy:4".
const REGLER = {
  unlazy: {
    label: 'Arbeitstiefe',
    optionen: [
      ['', 'Skill entscheidet'],
      ['2', 'Tiefe 2 — solo, schnell'],
      ['3', 'Tiefe 3 — solo, gründlich'],
      ['4', 'Tiefe 4 — orchestriert, parallele Teilaufgaben'],
      ['5', 'Tiefe 5 — maximal (teuer und langsam!)'],
    ],
  },
}

export function eintragName(eintrag) { return String(eintrag).split(':')[0] }
export function eintragWert(eintrag) {
  const w = String(eintrag).split(':')[1]
  return w && /^\d$/.test(w) ? w : null
}
/** Anzeige-Text für die Detailseite: "unlazy (Tiefe 4)" statt "unlazy:4". */
export function skillAnzeige(skillsJson) {
  return skillListe(skillsJson).map(e => {
    const w = eintragWert(e)
    return w ? `${eintragName(e)} (Tiefe ${w})` : eintragName(e)
  })
}

/**
 * Prompt-Zusatz für die gewählten Skills. Der Lauf trägt eine KOPIE der Auswahl —
 * verschwindet ein Skill später von der Platte, sagt der Zusatz das ehrlich, statt
 * auf eine tote Datei zu verweisen.
 */
export function skillPromptZusatz(skillsJson) {
  const namen = skillListe(skillsJson)
  if (!namen.length) return ''
  const vorhanden = new Map(zusatzSkills().map(s => [s.name, s]))
  const zeilen = ['Arbeitsweise (gewählte Zusatz-Skills):']
  for (const eintrag of namen) {
    const n = eintragName(eintrag), wert = eintragWert(eintrag)
    const s = vorhanden.get(n)
    if (s) {
      zeilen.push(`- Lies ZUERST die Datei ${s.pfad} vollständig und wende die dort beschriebene`
        + ` Arbeitsweise während des GESAMTEN Auftrags an. Dateiverweise darin sind relativ zu ${join(s.pfad, '..')}.`)
      // unlazy: „tree N" ist der dokumentierte Trigger für die Depth-Tree-Tiefe.
      if (wert && n === 'unlazy') {
        zeilen.push(`  Für diesen Auftrag ist ausdrücklich "tree ${wert}" angefordert — nutze den Depth Tree mit Tiefe ${wert}.`)
      }
    } else {
      zeilen.push(`- (Skill '${n}' war gewählt, liegt aber nicht mehr unter ${zusaetzeDir()} — überspringen.)`)
    }
  }
  return zeilen.join('\n')
}

/** Anzeige-Häkchen für die Formulare (Einzellauf + Agent). */
export function skillFelder(skillsJson) {
  const eintraege = new Map(skillListe(skillsJson).map(e => [eintragName(e), eintragWert(e)]))
  const skills = zusatzSkills()
  if (!skills.length) return ''
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  return `<fieldset><legend>Zusatz-Skills (opt-in, landen als Anweisung im Prompt)</legend>
  ${skills.map(s => {
    const regler = REGLER[s.name]
    const wert = eintraege.get(s.name) ?? ''
    return `<label class="chk"><input type="checkbox" name="skills" value="${esc(s.name)}" ${eintraege.has(s.name) ? 'checked' : ''}>
    <b>${esc(s.titel)}</b>${s.beschreibung ? ` — <span class="dim">${esc(s.beschreibung.slice(0, 180))}</span>` : ''}</label>
    ${regler ? `<label class="chk skill-regler">↳ ${esc(regler.label)}
      <select name="skill_regler_${esc(s.name)}">${regler.optionen.map(([v, t]) =>
        `<option value="${esc(v)}" ${v === wert ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}`
  }).join('')}
  </fieldset>`
}
