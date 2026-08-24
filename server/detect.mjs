// cc-hub — Erkennung von Rate-Limits und Provider-Fehlern aus Text. Reine Logik,
// keine Datenbank, kein Dateisystem: alles hier ist mit festen Eingaben testbar.
//
// Warum das überhaupt nötig ist: bei einem Rate-Limit oder Provider-Ausfall kann der
// Agent selbst nichts mehr melden — ohne API kein Werkzeugaufruf, also kein cc-report.
// Die Plattform muss es von außen sehen. Es gibt drei Quellen, in dieser Rangfolge:
//
//   hook        claude 'StopFailure' (liefert ein festes Fehler-Enum), opencode-Plugin
//               'session.error'. hermes hat KEINEN Hook für API-Fehler — dessen
//               'post_api_request' feuert nur nach einer ERFOLGREICHEN Antwort.
//   transcript  claude-Transkript (JSONL) mit isApiErrorMessage:true + error:<enum>
//   log         pipe-pane-Mitschnitt der tmux-Session (alle Harnesses). Roh, mit
//               ANSI-Steuerzeichen, Menütexten und Neuzeichnungen — darum Muster je
//               Harness und eine Bewertung, ob der Treffer wirklich ein Problem ist.

/** Vorfalltypen. Alles andere wäre Rätselraten — lieber 'unbekannt' als falsch. */
export const TYPEN = ['rate_limit', 'provider_error', 'auth_error', 'billing_error', 'model_error', 'unbekannt']

/**
 * Claudes StopFailure-Enum (Stand 2.1.241, aus dem Binary gelesen) → unser Vorfalltyp.
 * Genau dasselbe Enum steht im Transkript unter 'error'.
 */
const CLAUDE_ENUM = {
  rate_limit: 'rate_limit',
  overloaded: 'provider_error',
  server_error: 'provider_error',
  authentication_failed: 'auth_error',
  oauth_org_not_allowed: 'auth_error',
  account_on_hold: 'billing_error',
  billing_error: 'billing_error',
  model_not_found: 'model_error',
  invalid_request: 'model_error',
  max_output_tokens: null,   // kein Provider-Problem, der Agent läuft weiter
  unknown: 'unbekannt',
}
export function typVonClaudeFehler(enumWert) {
  const v = CLAUDE_ENUM[String(enumWert ?? '')]
  return v === undefined ? 'unbekannt' : v
}

/**
 * Freitext (opencode-Plugin, Logzeile) → Typ. Reihenfolge ist Absicht: Auth und
 * Billing vor Rate-Limit, weil „402 … rate" o. ä. sonst falsch einsortiert würde.
 */
export function typVonText(text) {
  const t = String(text ?? '')
  if (/\b(401|403)\b|authentication|unauthori[sz]ed|invalid (api )?key|api key (is )?(invalid|missing)|please run \/login|oauth/i.test(t)) return 'auth_error'
  if (/\b402\b|billing|insufficient (credits|funds|balance)|credit balance|account (is )?on hold|payment/i.test(t)) return 'billing_error'
  if (/\b429\b|rate.?limit|too many requests|usage limit|hit your (session|usage|weekly|daily)? ?limit|quota exceeded|resource.?exhausted/i.test(t)) return 'rate_limit'
  if (/model (not found|does not exist)|unknown model|no such model|not a valid model/i.test(t)) return 'model_error'
  if (/\b(5\d\d)\b|overload|unavailable|no endpoints|stream error|AI_APICallError|ECONNRE|ENOTFOUND|ETIMEDOUT|socket (hang up|connection was closed)|fetch failed|upstream|provider error|temporarily/i.test(t)) return 'provider_error'
  return 'unbekannt'
}

/** ANSI-CSI, OSC (Fenstertitel) und CR entfernen; \r-Neuzeichnungen werden zu Zeilen. */
export function terminalText(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')     // OSC … BEL / ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')            // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')                         // einzelne ESC-Sequenzen
    .replace(/\r\n?/g, '\n')
}

/**
 * Muster je Harness. Jedes Muster ist bewusst ENG: lieber ein Fall weniger als
 * ein Menütext, der Alarm schlägt („Upgrade to Max for higher rate limits" stand in
 * einem Produktivlauf als Rate-Limit in der DB).
 */
const MUSTER = {
  claude: [
    // Ausgabe bei Abo-Limit: "You've hit your session limit · resets 8:36pm"
    { typ: 'rate_limit', re: /you'?ve hit your (session|usage|weekly|daily|5.?hour|7.?day)? ?limit/i },
    { typ: 'rate_limit', re: /API Error: 429/i },
    { typ: 'rate_limit', re: /rate_limit_error/i },
    { typ: 'provider_error', re: /API Error: 5\d\d/i },
    { typ: 'provider_error', re: /overloaded_error|\bOverloaded\b/ },
    { typ: 'auth_error', re: /API Error: (401|403)|Please run \/login|OAuth token (has )?expired/i },
    { typ: 'billing_error', re: /API Error: 402|credit balance is too low/i },
    { typ: 'provider_error', re: /API Error:.*(fetch failed|socket|ECONN|ETIMEDOUT)/i },
  ],
  opencode: [
    // opencode: AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.
    { typ: 'rate_limit', re: /rate.?limited|rate limit|\b429\b|too many requests/i },
    { typ: 'auth_error', re: /\b(401|403)\b|unauthori[sz]ed|invalid api key|authentication/i },
    { typ: 'billing_error', re: /\b402\b|insufficient credits|credit balance/i },
    { typ: 'provider_error', re: /AI_APICallError|AI_RetryError|ProviderError|stream error|\b5\d\d\b|overloaded|no endpoints|unavailable/i },
  ],
  hermes: [
    // hermes (conversation_loop.py): "⏳ Retrying in 12.0s (rate limited by upstream provider (429))..."
    //                                "⚠️  API call failed (attempt 2/5): RateLimitError (HTTP 429)"
    { typ: 'rate_limit', re: /rate.?limited|rate limit|\b429\b|RateLimitError/i },
    { typ: 'auth_error', re: /AuthenticationError|\b(401|403)\b|invalid api key/i },
    { typ: 'billing_error', re: /\b402\b|insufficient|billing/i },
    { typ: 'provider_error', re: /API call failed|Retrying in .*\(|overloaded|\b5\d\d\b|APIConnectionError|InternalServerError|ServiceUnavailable/i },
  ],
  // cursor hat wie hermes KEINEN Hook für API-Fehler (das Hook-Enum kennt
  // beforeShellExecution/afterFileEdit/stop/beforeSubmitPrompt, aber nichts für einen
  // fehlgeschlagenen Aufruf) — der Log-Scan ist hier die einzige Quelle.
  // 'Cannot use this model' ist Cursors laute Ablehnung einer unbekannten Modell-ID;
  // die kommt sofort beim Start und ist ein sicherer Treffer, kein Rauschen.
  cursor: [
    { typ: 'rate_limit', re: /rate.?limit|\b429\b|too many requests|usage limit reached|out of (requests|credits)/i },
    { typ: 'auth_error', re: /\b(401|403)\b|not (logged in|authenticated)|unauthori[sz]ed|please run .?cursor-agent login|invalid api key/i },
    { typ: 'billing_error', re: /\b402\b|insufficient (credits|funds)|billing|subscription (expired|required)|hard limit/i },
    { typ: 'model_error', re: /Cannot use this model/i },
    { typ: 'provider_error', re: /\b5\d\d\b|overloaded|unavailable|connection (error|refused|closed)|ECONNRE|ETIMEDOUT|fetch failed|stream (error|disconnected)/i },
  ],
}

/**
 * Zeilen, die Treffer enthalten, aber KEIN Fehler sind. Hier landet, was in der Praxis
 * schon falsch gezündet hat — plus die naheliegenden Verwandten.
 */
const AUSNAHMEN = [
  /upgrade to max/i,                       // Claude-Befehlsmenü: "/upgrade … higher rate limits"
  /\/(upgrade|usage|usage-credits|status|help)\b/,  // Menüzeilen mit Slash-Befehl
  /^\s*[│|]?\s*(rate|usage) limit(s)?\s*[│|]?\s*$/i, // nackte Überschrift (z. B. /usage-Tabelle)
  /\bgrep\b|\brg\b|\bsed\b|\bawk\b/,        // der Agent sucht selbst nach dem Wort
  /cc-hub|detect\.mjs|incidents|test\/(unit|e2e)/, // Arbeit an genau diesem Code
  /\b(describe|it|test|expect)\(/,          // Testcode
  /retry_after|retryAfter|rateLimit[A-Z]|rate_limit_hits|RATE_LIMIT/, // Bezeichner in Quelltext
]

/**
 * Durchsucht bereinigte Zeilen mit den Mustern einer Harness.
 * Liefert [{ typ, zeile, index }] — jede Zeile höchstens einmal (erstes Muster gewinnt).
 */
export function scanneZeilen(harness, zeilen) {
  const muster = MUSTER[harness] ?? []
  const treffer = []
  zeilen.forEach((roh, index) => {
    const zeile = roh.trim()
    if (!zeile || zeile.length > 2000) return
    if (AUSNAHMEN.some(a => a.test(zeile))) return
    for (const m of muster) {
      if (m.re.test(zeile)) { treffer.push({ typ: m.typ, zeile: zeile.slice(0, 300), index }); break }
    }
  })
  return treffer
}

/**
 * Neue Bytes eines Logs scannen. 'text' ist der Ausschnitt ab dem alten Offset.
 * Die letzte, evtl. unvollständige Zeile wird NICHT gewertet und auch nicht
 * „verbraucht": der neue Offset zeigt auf ihren Anfang, sie kommt beim nächsten
 * Durchgang vollständig. Sonst zerreißt ein Zeilenumbruch mitten im Wort den Treffer.
 */
export function scanneNeueBytes(harness, text, altOffset) {
  const sauber = terminalText(text)
  const letzterUmbruch = sauber.lastIndexOf('\n')
  if (letzterUmbruch < 0) return { treffer: [], neuerOffset: altOffset }
  const komplett = sauber.slice(0, letzterUmbruch)
  // Der Offset zählt ROHE Bytes; die Bereinigung ändert Längen. Darum wird der Rest
  // über die rohe Länge der unvollständigen Schlusszeile zurückgerechnet.
  const rohRest = Buffer.byteLength(text.slice(text.lastIndexOf('\n') + 1), 'utf8')
  const neuerOffset = altOffset + Buffer.byteLength(text, 'utf8') - rohRest
  return { treffer: scanneZeilen(harness, komplett.split('\n')), neuerOffset }
}

/**
 * Claude-Transkript (JSONL): API-Fehler stehen als eigene Zeilen mit
 * isApiErrorMessage:true und error:<enum>. Liefert [{ typ, ts, text }].
 */
export function transkriptFehler(jsonlText) {
  const out = []
  for (const line of String(jsonlText ?? '').split('\n')) {
    if (!line.includes('"isApiErrorMessage":true')) continue
    try {
      const j = JSON.parse(line)
      if (!j?.isApiErrorMessage) continue
      const typ = typVonClaudeFehler(j.error)
      if (typ === null) continue
      const c = j.message?.content
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map(x => x?.text ?? '').join(' ') : ''
      out.push({ typ, ts: j.timestamp ?? null, text: text.trim().slice(0, 300), enum: j.error ?? null })
    } catch { /* halbe Zeile — nächster Durchgang */ }
  }
  return out
}

/**
 * Bewertung eines LOG-Treffers (Hooks und Transkript brauchen das nicht, die sind
 * eindeutig). Dein Kriterium: ein echtes Limit steht AM ENDE — danach passiert nichts
 * mehr. Ein Treffer, hinter dem der Agent weiterarbeitet, war ein Retry oder ein
 * Menütext.
 *
 *   rot   – mehrere Treffer in kurzer Zeit (Retry-Schleife) ODER seit dem letzten
 *           Treffer Stille (keine Aktivität) über 'stilleMs'
 *   gelb  – erster, einzelner Treffer: vormerken, Ampel gelb, KEIN Telegram
 */
export function bewerteLogTreffer({ anzahl, erstGesehenMs, zuletztGesehenMs, letzteAktivitaetMs, jetztMs,
  fensterMs = 10 * 60_000, stilleMs = 5 * 60_000, schwelle = 2 }) {
  if (anzahl >= schwelle && (zuletztGesehenMs - erstGesehenMs) <= fensterMs) return 'rot'
  const still = letzteAktivitaetMs == null || letzteAktivitaetMs <= zuletztGesehenMs
  if (still && (jetztMs - zuletztGesehenMs) >= stilleMs) return 'rot'
  return 'gelb'
}

/** Menschlicher Name je Typ (für Übersicht, Telegram). */
export const TYP_TEXT = {
  rate_limit: 'Rate-Limit',
  provider_error: 'Provider-Fehler',
  auth_error: 'Anmeldung/Token',
  billing_error: 'Guthaben/Abrechnung',
  model_error: 'Modell nicht verfügbar',
  provider_down: 'Provider nicht erreichbar',
  llm_warnung: 'Prüf-LLM-Warnung',
  unbekannt: 'API-Fehler',
}
