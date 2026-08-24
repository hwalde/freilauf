// cc-hub — Prüf-LLM (optional): zweite Meinung zu Log-Treffern des Detektors.
//
// Der Scanner findet Zeilen, die nach Rate-Limit oder Provider-Fehler aussehen. Er
// kann aber nicht wissen, ob der Agent danach weitermacht oder ob das nur ein Menütext
// war. Wenn eingeschaltet, bekommt ein Modell über OpenRouter die letzten Zeilen des
// bereinigten Terminals und antwortet STRUKTURIERT (json_schema) — kein Freitext, den
// man dann wieder parsen müsste.
//
// Fail-loud: ist OpenRouter selbst nicht erreichbar oder kein Schlüssel da, bleibt der
// Scanner-Treffer ungeprüft stehen (gelb, wird nach Zeit/Anzahl rot). Lieber ein
// Alarm zu viel als ein verschluckter Ausfall.
import { getSetting, setSetting } from './db.mjs'
import { TYPEN } from './detect.mjs'

const MIN_ABSTAND_MS = 10 * 60_000    // je Lauf höchstens alle 10 min eine Anfrage
const MAX_ZEICHEN = 12_000            // Kontext-Deckel: Kosten und Latenz
const zuletzt = new Map()             // runId → ms der letzten Anfrage

export function pruefLlmAktiv() {
  return getSetting('llm_check_on') === '1' && !!getSetting('llm_check_model') && !!process.env.OPENROUTER_API_KEY
}

/** Zuletzt verwendete Modelle — „verwendet" heißt: in den Einstellungen gespeichert. */
export function llmModelleMru() {
  try { return JSON.parse(getSetting('llm_check_models_mru') || '[]').filter(Boolean).slice(0, 10) } catch { return [] }
}
export function llmModellMerken(model) {
  const m = String(model ?? '').trim()
  if (!m) return
  const liste = [m, ...llmModelleMru().filter(x => x !== m)].slice(0, 10)
  setSetting('llm_check_models_mru', JSON.stringify(liste))
}

const SCHEMA = {
  name: 'vorfall_urteil',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['problem', 'typ', 'blockiert', 'begruendung', 'zitat'],
    properties: {
      problem: { type: 'boolean', description: 'true, wenn der Agent wirklich durch ein Rate-Limit, einen Provider-Ausfall, Auth- oder Guthabenproblem behindert ist' },
      typ: { type: 'string', enum: [...TYPEN, 'kein'] },
      blockiert: { type: 'boolean', description: 'true, wenn der Agent aktuell NICHT weiterarbeitet (steht, wartet, abgebrochen)' },
      begruendung: { type: 'string' },
      zitat: { type: 'string', description: 'die eine Zeile aus dem Terminal, die das belegt (wörtlich), oder leer' },
    },
  },
}

const SYSTEM = `Du bewertest den Terminal-Mitschnitt eines autonomen Coding-Agenten (claude code, opencode oder hermes).
Frage: Ist der Agent gerade durch ein Rate-Limit, einen Provider-Ausfall (5xx, overloaded, nicht erreichbar),
ein Anmelde-/Token-Problem oder fehlendes Guthaben behindert?
Wichtig:
- Menütexte, Hilfetexte, Statuszeilen ("Upgrade to Max for higher rate limits") sind KEIN Problem.
- Wenn der Agent selbst Code oder Texte über Rate-Limits liest, schreibt oder sucht, ist das KEIN Problem.
- Ein Retry, nach dem die Arbeit sichtbar weitergeht, ist ein Hinweis (problem=true, blockiert=false).
- Steht am Ende des Mitschnitts eine Fehlermeldung und danach nichts Produktives mehr, ist das problem=true, blockiert=true.
Antworte ausschließlich im vorgegebenen JSON-Schema.`

/**
 * Eine Bewertung anfordern. Liefert das Urteil oder null (aus, gedrosselt, Fehler).
 * 'zeilen' sind bereits bereinigte Terminalzeilen, die letzten zuerst NICHT —
 * chronologisch, so wie sie im Log stehen.
 */
export async function pruefeTreffer({ runId, harness, treffer, zeilen, jetztMs = Date.now(), erzwingen = false }) {
  if (!pruefLlmAktiv()) return null
  const vorher = zuletzt.get(runId) ?? 0
  if (!erzwingen && jetztMs - vorher < MIN_ABSTAND_MS) return { gedrosselt: true }
  zuletzt.set(runId, jetztMs)

  let kontext = zeilen.join('\n')
  if (kontext.length > MAX_ZEICHEN) kontext = '…\n' + kontext.slice(-MAX_ZEICHEN)
  const user = `Harness: ${harness}\nVerdächtige Zeile(n) des Scanners:\n${treffer.map(t => `- [${t.typ}] ${t.zeile}`).join('\n')}\n\nLetzte Terminalzeilen (chronologisch, bereinigt):\n\`\`\`\n${kontext}\n\`\`\``

  const model = getSetting('llm_check_model')
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: SCHEMA },
    temperature: 0,
    max_tokens: 600,
  }
  const orProvider = getSetting('llm_check_or_provider')
  if (orProvider) body.provider = { order: [orProvider], allow_fallbacks: false }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/hwalde/cc-hub',
        'X-Title': 'cc-hub Prüf-LLM',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return { fehler: `HTTP ${res.status}` }
    const j = await res.json()
    const roh = j?.choices?.[0]?.message?.content
    const urteil = JSON.parse(typeof roh === 'string' ? roh : JSON.stringify(roh))
    if (typeof urteil?.problem !== 'boolean') return { fehler: 'Antwort ohne problem-Feld' }
    return { ...urteil, model, usage: j?.usage ?? null }
  } catch (e) {
    return { fehler: e.message }
  }
}

/** Nur für Tests: Drossel zurücksetzen. */
export function _drosselZuruecksetzen() { zuletzt.clear() }
