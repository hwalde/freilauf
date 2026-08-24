// cc-hub — Modell-Listen der Provider (Planung: Provider wählen, Modelle dynamisch).
// Alle Abrufe passieren HIER, im Server: der Browser erreicht nur den Hub auf
// 127.0.0.1 und soll keine fremden Hosts kontaktieren.
//
// Grundhaltung wie bei openrouterCredits() in quota.mjs: eine hängende oder kaputte
// Provider-API darf das Formular NIE blockieren. Im Zweifel kommt eine veraltete
// Liste oder gar keine — der freie Slug-Eingabe-Weg funktioniert immer.

import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

const LISTE_MS = 6 * 60 * 60 * 1000   // Modell-Listen ändern sich selten
const ENDPUNKTE_MS = 15 * 60 * 1000   // Serving-Provider schwanken häufiger
const ZEITLIMIT = 8_000

export const PROVIDER = {
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek (direkt)',
  'opencode-zen': 'OpenCode Zen',
}

/**
 * Welche Provider kann eine Harness überhaupt? Nachgemessen, nicht geraten:
 *  - claude spricht ausschließlich über das Abo — dort wählt man nur das Modell.
 *  - cursor genauso: das Cursor-Abo ist der einzige Weg, die Modellliste ist
 *    kontogebunden ('cursor-agent models').
 *  - opencode kennt Zen (freie Modelle sogar ohne Schlüssel) und OpenRouter;
 *    DeepSeek direkt erscheint in opencode erst, wenn ein Schlüssel da ist.
 *  - hermes verlangt für Zen und DeepSeek zwingend einen Schlüssel
 *    ("No usable credentials found for provider 'opencode-zen'"), bleibt hier also
 *    bei OpenRouter.
 * Ein Provider ohne Schlüssel wird gar nicht erst angeboten: das Dropdown soll nur
 * zeigen, was auch wirklich losläuft.
 */
export function providerFuerHarness(harness) {
  const key = (...namen) => namen.some(n => !!process.env[n])
  const alle = {
    claude: [],
    cursor: [],
    opencode: [
      { id: 'opencode-zen', label: PROVIDER['opencode-zen'], hinweis: 'freie Modelle ohne Schlüssel' },
      // DeepSeek bringt opencode inzwischen selbst mit — hier nachgemessen: ein Lauf
      // über deepseek/deepseek-v4-flash läuft ohne eigenen Schlüssel durch.
      { id: 'deepseek', label: PROVIDER.deepseek, hinweis: 'über opencode, ohne eigenen Schlüssel' },
      ...(key('OPENROUTER_API_KEY') ? [{ id: 'openrouter', label: PROVIDER.openrouter }] : []),
    ],
    hermes: [
      ...(key('OPENROUTER_API_KEY') ? [{ id: 'openrouter', label: PROVIDER.openrouter }] : []),
      ...(key('OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY') ? [{ id: 'opencode-zen', label: PROVIDER['opencode-zen'] }] : []),
      ...(key('DEEPSEEK_API_KEY') ? [{ id: 'deepseek', label: PROVIDER.deepseek }] : []),
    ],
  }
  return alle[harness] ?? []
}

/**
 * Modelle für claude. Es gibt keinen Katalog-Endpunkt ohne API-Schlüssel (das Abo
 * hat keinen), deshalb eine gepflegte Liste: die Aliasse, die immer auf die neueste
 * Fassung zeigen, plus die festen Kennungen. Eigene Eingabe bleibt jederzeit möglich.
 */
export function claudeModelle() {
  return [
    { id: 'opus', name: 'Opus (Alias, immer die neueste Fassung)' },
    { id: 'fable', name: 'Fable (Alias)' },
    { id: 'sonnet', name: 'Sonnet (Alias)' },
    { id: 'haiku', name: 'Haiku (Alias)' },
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
    { id: 'claude-fable-5', name: 'Claude Fable 5' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  ].map(m => ({ ...m, ctx: null, tools: true }))
}

/**
 * Modelle für cursor. Einzige maßgebliche Quelle ist 'cursor-agent models': die Liste
 * ist KONTOGEBUNDEN (sie kommt vom Server, nicht aus dem Binary), und genau dieselbe
 * Liste nennt die CLI beim Ablehnen eines unbekannten Modells.
 *
 * Anders als bei opencode ist der Umweg über eine Datei hier NICHT nötig: fünf Läufe
 * über eine Pipe lieferten fünfmal identisch 204 Zeilen, und der Aufruf dauert unter
 * einer Sekunde. Das opencode-Problem (halbierte Ausgabe bei Prozessende) tritt hier
 * nicht auf.
 *
 * Format je Zeile: '<id> - <Anzeigename>'. Der Denk-Aufwand steckt bei cursor IN der
 * ID ('claude-opus-5-xhigh'), es gibt kein --effort — deshalb wird hier nichts
 * zerlegt: was in der Liste steht, geht wortwörtlich als --model raus. Eine
 * zusammengebaute ID könnte es gar nicht geben.
 */
async function cursorModelle() {
  const { stdout } = await execFileAsync('cursor-agent', ['models'], { timeout: 30_000 })
  const modelle = []
  for (const zeile of stdout.split('\n')) {
    // Kopfzeile ('Available models') und der Tipp am Ende haben kein ' - ' bzw.
    // keine ID-Form; beides fällt durch dieses Muster von selbst raus.
    const m = zeile.trim().match(/^([A-Za-z0-9][\w.\-]*)\s+-\s+(.+)$/)
    if (!m) continue
    const [, id, name] = m
    modelle.push({
      id,
      name,
      ctx: /\b1M\b/.test(name) ? 1_000_000 : null,
      tools: true,
      // '-fast' ist Cursors Schnellmodus (teurer, weniger gründlich). Sichtbar
      // machen, damit die Nicht-Fast-Variante die naheliegende Wahl bleibt.
      fast: id.endsWith('-fast'),
    })
  }
  if (!modelle.length) throw new Error('cursor-agent models lieferte keine Modelle')
  // Nicht-Fast zuerst, sonst alphabetisch: der Regelfall soll oben stehen.
  return modelle.sort((a, b) => (a.fast - b.fast) || a.id.localeCompare(b.id))
}

const cache = new Map()      // schlüssel -> { at, value }
const laufend = new Map()    // schlüssel -> Promise; parallele Formularaufrufe teilen einen Abruf

function frisch(schluessel, maxAlter) {
  const e = cache.get(schluessel)
  return e && Date.now() - e.at < maxAlter ? e.value : null
}

async function holen(schluessel, maxAlter, abrufen) {
  const gut = frisch(schluessel, maxAlter)
  if (gut) return { liste: gut, veraltet: false }
  if (laufend.has(schluessel)) return laufend.get(schluessel)

  const p = (async () => {
    try {
      const wert = await abrufen()
      cache.set(schluessel, { at: Date.now(), value: wert })
      return { liste: wert, veraltet: false }
    } catch (err) {
      const alt = cache.get(schluessel)?.value
      console.warn(`[models] ${schluessel}: ${err.message}${alt ? ' — liefere veraltete Liste' : ''}`)
      return alt ? { liste: alt, veraltet: true } : { liste: null, veraltet: false, fehler: err.message }
    } finally {
      laufend.delete(schluessel)
    }
  })()
  laufend.set(schluessel, p)
  return p
}

async function json(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ZEITLIMIT) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---------------- die drei Provider ----------------

async function openrouterModelle() {
  const j = await json('https://openrouter.ai/api/v1/models')
  return (j.data ?? []).map(m => ({
    id: m.id,
    name: m.name ?? m.id,
    ctx: m.context_length ?? null,
    // Ein Coding-Agent ohne Werkzeug-Unterstützung ist nutzlos — das wollen wir sehen.
    tools: (m.supported_parameters ?? []).includes('tools'),
    // Maßgeblich ist das Feld 'reasoning', NICHT supported_parameters: nur dort stehen
    // die erlaubten Stufen und ob Reasoning für dieses Modell Pflicht ist.
    reasoning: m.reasoning?.supported_efforts?.length
      ? { stufen: m.reasoning.supported_efforts,
          standard: m.reasoning.default_effort ?? null,
          pflicht: m.reasoning.mandatory === true }
      : null,
  })).sort((a, b) => a.id.localeCompare(b.id))
}

/** Namen und Preise aus der Registry, die opencode selbst benutzt. */
async function registry() {
  return holen('models.dev', LISTE_MS, () => json('https://models.dev/api.json'))
    .then(r => r.liste ?? {})
}

async function zenModelle() {
  // Katalog des Anbieters: enthält auch Modelle, die ohne Zen-Schlüssel nicht laufen.
  // Gefiltert wird weiter unten anhand dessen, was das lokale opencode annimmt.
  const meta = (await registry())?.opencode?.models ?? {}
  const j = await json('https://opencode.ai/zen/v1/models')
  return (j.data ?? []).map(m => ({
    id: m.id,
    name: meta[m.id]?.name ?? m.id,
    ctx: meta[m.id]?.limit?.context ?? null,
    tools: meta[m.id]?.tool_call !== false,
    frei: meta[m.id]?.cost?.input === 0 || m.id.endsWith('-free'),
  })).sort((a, b) => a.id.localeCompare(b.id))
}

async function deepseekModelle() {
  // Der offizielle Endpunkt braucht einen Schlüssel. Ohne Schlüssel nehmen wir die
  // Registry, die opencode selbst benutzt — dort stehen sogar Namen und Kontextlängen.
  const key = process.env.DEEPSEEK_API_KEY
  if (key) {
    const j = await json('https://api.deepseek.com/models', { Authorization: `Bearer ${key}` })
    return (j.data ?? []).map(m => ({ id: m.id, name: m.id, ctx: null, tools: true }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  const modelle = (await registry())?.deepseek?.models ?? {}
  return Object.entries(modelle).map(([id, m]) => ({
    id,
    name: m.name ?? id,
    ctx: m.limit?.context ?? null,
    tools: m.tool_call !== false,
  })).sort((a, b) => a.id.localeCompare(b.id))
}

// So spricht opencode die Provider an (Stolperfalle: Zen heißt dort 'opencode').
const OC_PREFIX = { openrouter: 'openrouter', deepseek: 'deepseek', 'opencode-zen': 'opencode' }

/**
 * 'opencode models --pure' liefert 568 Zeilen — aber nur zuverlässig, wenn die Ausgabe
 * in eine DATEI geht. Liest node sie über eine Pipe, gehen beim Prozessende Teile
 * verloren: gemessen 168, 244, 260, 307 statt 360 OpenRouter-Modellen, bei völlig
 * stabiler Ausgabe in der Shell. Ein stillschweigend halbierter Katalog wäre schlimmer
 * als gar keiner — darum der Umweg über eine temporäre Datei.
 */
async function opencodeCliListe() {
  const datei = join(tmpdir(), `cc-hub-opencode-models-${process.pid}.txt`)
  try {
    await execFileAsync('sh', ['-c', `opencode models --pure > ${JSON.stringify(datei)}`], { timeout: 120_000 })
    return readFileSync(datei, 'utf8')
  } finally {
    try { rmSync(datei, { force: true }) } catch { /* Aufräumen ist Beiwerk */ }
  }
}

/**
 * Welche Modelle nimmt das LOKALE opencode für diesen Provider wirklich an?
 * Die Providerliste von opencode ist credential-gated — der Anbieter-Katalog enthält
 * dagegen auch Modelle, die hier mangels Schlüssel sofort scheitern würden.
 * Liefert null, wenn opencode nicht befragbar ist (dann bleibt der Katalog).
 */
async function opencodeIds(provider) {
  const prefix = OC_PREFIX[provider]
  if (!prefix) return null
  const alle = await holen('opencode-cli', LISTE_MS, async () => {
    const stdout = await opencodeCliListe()
    return stdout.split('\n').map(z => z.trim()).filter(Boolean)
  })
  if (!alle.liste) return null
  return alle.liste.filter(z => z.startsWith(prefix + '/')).map(z => z.slice(prefix.length + 1))
}

/**
 * Modelle eines Providers. Liefert { liste, veraltet, fehler? } — 'liste' ist null,
 * wenn nichts zu holen war; dann bleibt dem Formular die freie Slug-Eingabe.
 */
function katalog(provider) {
  switch (provider) {
    case 'openrouter': return holen('openrouter', LISTE_MS, openrouterModelle)
    case 'opencode-zen': return holen('opencode-zen', LISTE_MS, zenModelle)
    case 'deepseek': return holen('deepseek', LISTE_MS, deepseekModelle)
    default: return Promise.resolve({ liste: null, veraltet: false, fehler: `unbekannter Provider: ${provider}` })
  }
}

export async function modelList(provider, harness = null) {
  if (provider === 'claude') return { liste: claudeModelle(), veraltet: false }
  if (provider === 'cursor') return holen('cursor', LISTE_MS, cursorModelle)
  const k = await katalog(provider)
  if (harness !== 'opencode') return k

  // Für opencode zählt, was opencode annimmt. Der Katalog liefert nur noch die
  // Beschreibung dazu (Name, Kontext, Preis-Hinweis).
  const ids = await opencodeIds(provider)
  if (!ids?.length) return k.liste ? { ...k, katalog: true } : k
  const meta = new Map((k.liste ?? []).map(m => [m.id, m]))
  return {
    liste: ids.map(id => meta.get(id) ?? { id, name: id, ctx: null, tools: true })
      .sort((a, b) => a.id.localeCompare(b.id)),
    veraltet: k.veraltet ?? false,
  }
}

/**
 * Serving-Provider (Endpunkte) eines OpenRouter-Modells.
 * Wichtig: als Wert IMMER 'tag' benutzen — 'provider_name' ist nicht eindeutig
 * (dasselbe „Google" steht für mehrere Regionen).
 */
export function orEndpoints(modelId) {
  const id = String(modelId ?? '').trim()
  // OpenRouter-IDs dürfen mit '~' beginnen (z. B. ~anthropic/claude-fable-latest).
  if (!/^[\w.~\-]+\/[\w.~\-:]+$/.test(id)) {
    return Promise.resolve({ liste: null, veraltet: false, fehler: 'Modell-ID sieht nicht nach author/slug aus' })
  }
  return holen(`endpoints:${id}`, ENDPUNKTE_MS, async () => {
    const j = await json(`https://openrouter.ai/api/v1/models/${id}/endpoints`)
    return (j.data?.endpoints ?? []).map(ep => ({
      tag: ep.tag,
      name: ep.provider_name ?? ep.tag,
      ctx: ep.context_length ?? null,
      uptime: ep.uptime_last_30m ?? null,
    })).filter(ep => ep.tag)
  })
}

/** Wann wurde die Liste zuletzt geholt? Für den Hinweis „Stand hh:mm". */
export function standVon(provider) {
  const at = cache.get(provider)?.at
  return at ? new Date(at).toISOString() : null
}

// ================= Reasoning-Effort =================
// Drei Ebenen, die verschieden streng sind — deshalb hier zusammengeführt statt
// irgendwo eine Stufenliste einzutippen:
//   claude   nimmt jede seiner Stufen für JEDES Modell (nachgemessen, kein Gating)
//   opencode prüft gegen seinen Katalog und verwirft Unbekanntes KOMMENTARLOS
//   hermes   prüft gar nichts und reicht alles durch

const HARNESS_MS = 24 * 60 * 60 * 1000     // ändert sich nur beim CLI-Update

const glatt = (t) => String(t ?? '').replace(/\s+/g, ' ')
const stufenAus = (t) => t.split(/,|\bor\b/).map(x => x.trim().toLowerCase())
  .filter(x => /^[a-z]+$/.test(x))

/**
 * Welche Stufen nimmt die claude-CLI? Nicht geraten, sondern die CLI selbst gefragt:
 * bei einem Unsinnswert nennt sie ihre Liste auf stderr — in unter einer Sekunde und
 * ohne einen Lauf zu starten (--version bricht danach ab). Klappt das nicht, steht
 * dieselbe Liste in --help. Klappt auch das nicht, kommt null und das Feld verschwindet,
 * statt eine erfundene Liste anzubieten.
 */
async function claudeStufen() {
  const ausProbe = await execFileAsync('claude', ['--effort', '__probe__', '--version'], { timeout: 15_000 })
    .catch(err => err)
  const m1 = glatt(ausProbe?.stderr).match(/Valid values:\s*([^.]+)\./)
  if (m1) return stufenAus(m1[1])
  const { stdout } = await execFileAsync('claude', ['--help'], { timeout: 15_000 })
  const m2 = glatt(stdout).match(/--effort <level>\s*Effort level for the current session\s*\(([^)]+)\)/)
  return m2 ? stufenAus(m2[1]) : null
}

/** hermes nennt seine Stufen nur in der Hilfe zu --reasoning; eine andere Quelle gibt es nicht. */
async function hermesStufen() {
  const { stdout } = await execFileAsync('hermes', ['chat', '--help'], { timeout: 20_000 })
  const m = glatt(stdout).match(/--reasoning LEVEL Reasoning effort for this session:\s*([^.]+)\./)
  return m ? stufenAus(m[1]) : null
}

function harnessStufen(harness) {
  if (harness === 'claude') return holen('stufen:claude', HARNESS_MS, claudeStufen)
  if (harness === 'hermes') return holen('stufen:hermes', HARNESS_MS, hermesStufen)
  return Promise.resolve({ liste: null })
}

/** opencodes eigener Katalogabzug — byte-gleich mit models.dev, aber ohne Netz. */
async function katalogRegistry() {
  const lokal = join(homedir(), '.cache', 'opencode', 'models.json')
  try { return JSON.parse(readFileSync(lokal, 'utf8')) } catch { /* dann eben über das Netz */ }
  return registry()
}

const MD_KEY = { openrouter: 'openrouter', deepseek: 'deepseek', 'opencode-zen': 'opencode' }

/**
 * Effort-Stufen eines Modells laut Katalog. Genau diese Liste ist es, gegen die
 * opencode validiert. Nur type==='effort' hat Stufen — 'toggle' (nur an/aus) und
 * 'budget_tokens' (nur Tokenbudget) können zwar Reasoning, aber keine Stufen; dort
 * wäre ein Stufen-Dropdown schlicht falsch.
 */
async function registryEffort(provider, model) {
  const kat = await holen('katalog-registry', LISTE_MS, katalogRegistry)
  const m = kat.liste?.[MD_KEY[provider]]?.models?.[model]
  if (!m?.reasoning) return null
  const eff = (m.reasoning_options ?? []).find(o => o.type === 'effort')
  return eff?.values?.length ? { stufen: eff.values, standard: null, pflicht: false } : null
}

/** Was OpenRouter selbst über das Modell sagt (kennt zusätzlich Standard und Pflicht). */
async function openrouterEffort(model) {
  const k = await katalog('openrouter')
  return k.liste?.find(m => m.id === model)?.reasoning ?? null
}

/**
 * Stufen für genau diese Kombination aus Harness, Provider und Modell.
 * Liefert { stufen: null }, wenn nichts Verlässliches zu holen ist — dann blendet das
 * Formular das Feld aus. Ein Feld, das nichts bewirkt, wäre schlimmer als keines:
 * bei opencode und hermes verpufft eine falsche Stufe lautlos.
 */
export async function effortOptionen(harness, provider, model) {
  if (!harness) return { stufen: null, hinweis: 'keine Harness angegeben' }

  if (harness === 'claude') {
    const s = await harnessStufen('claude')
    return s.liste
      ? { stufen: s.liste, standard: null, pflicht: false, quelle: 'cli',
          hinweis: 'Stufen laut claude --help; gilt für alle Abo-Modelle' }
      : { stufen: null, hinweis: 'claude nennt keine Stufen' }
  }

  if (harness === 'cursor') {
    // Kein Feld anbieten: cursor-agent hat kein --effort. Die Stufe ist Teil der
    // Modell-ID, also schon bei der Modellwahl entschieden. Ein zusätzliches
    // Dropdown könnte hier nur eine ID erzeugen, die es nicht gibt.
    return { stufen: null, hinweis: 'cursor kodiert den Denk-Aufwand in die Modell-ID '
      + '(z. B. …-low, …-high, …-xhigh, …-max) — die Stufe steckt schon in der Modellwahl' }
  }

  if (!provider || !model) return { stufen: null, hinweis: 'erst Provider und Modell wählen' }

  if (harness === 'opencode') {
    // Nur der Katalog zählt: eine Stufe, die opencode nicht kennt, wird still verworfen.
    const r = await registryEffort(provider, model)
    return r
      ? { ...r, quelle: 'registry', hinweis: 'Stufen laut Modellkatalog — opencode nimmt nur diese an' }
      : { stufen: null, hinweis: 'für dieses Modell führt der Katalog keine Effort-Stufen' }
  }

  if (harness === 'hermes') {
    // hermes prüft nichts, also schneiden wir seine Stufen mit dem, was das Modell kann.
    const s = await harnessStufen('hermes')
    if (!s.liste) return { stufen: null, hinweis: 'hermes nennt keine Stufen' }
    const modell = provider === 'openrouter'
      ? await openrouterEffort(model)
      : await registryEffort(provider, model)
    if (!modell) return { stufen: null, hinweis: 'für dieses Modell sind keine Effort-Stufen bekannt' }
    const schnitt = s.liste.filter(x => modell.stufen.includes(x))
    // 'none' nur, wenn der Provider Reasoning nicht zur Pflicht macht — sonst
    // antwortet OpenRouter mit "Reasoning is mandatory for this endpoint".
    if (!modell.pflicht && s.liste.includes('none')) schnitt.unshift('none')
    return schnitt.length
      ? { stufen: schnitt, standard: modell.standard ?? null, pflicht: modell.pflicht, quelle: 'openrouter',
          hinweis: 'Stufen, die hermes UND das Modell kennen' }
      : { stufen: null, hinweis: 'hermes und das Modell haben keine gemeinsame Stufe' }
  }
  return { stufen: null, hinweis: `unbekannte Harness: ${harness}` }
}
