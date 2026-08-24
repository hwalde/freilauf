// cc-hub — Mini-Testrunner für unit.mjs und e2e.mjs.
// Kein Framework: Zählen, Klartext ausgeben, Exit-Code setzen. Mehr braucht es nicht,
// und es hält die Suite abhängigkeitsfrei wie den Rest des Projekts.

const GRUEN = '\x1b[32m', ROT = '\x1b[31m', GRAU = '\x1b[90m', WEG = '\x1b[0m'

export const zaehler = { ok: 0, fehler: [], uebersprungen: 0 }

export function gruppe(titel) {
  console.log(`\n${titel}`)
}

/** Eine Prüfung. fn darf synchron oder asynchron sein; wirft = durchgefallen. */
export async function pruefe(name, fn) {
  try {
    await fn()
    zaehler.ok++
    console.log(`  ${GRUEN}✓${WEG} ${name}`)
  } catch (err) {
    zaehler.fehler.push({ name, grund: err.message })
    console.log(`  ${ROT}✗${WEG} ${name}`)
    console.log(`     ${GRAU}${err.message.split('\n').join('\n     ')}${WEG}`)
  }
}

export function uebersprungen(name, grund) {
  zaehler.uebersprungen++
  console.log(`  ${GRAU}– ${name} (${grund})${WEG}`)
}

// ---- Zusicherungen. Bewusst wenige: gleich/wahr/enthaelt decken alles ab. ----
export function gleich(ist, soll, was = 'Wert') {
  if (ist !== soll) throw new Error(`${was}: ist ${JSON.stringify(ist)}, erwartet ${JSON.stringify(soll)}`)
}
export function wahr(bedingung, was = 'Bedingung') {
  if (!bedingung) throw new Error(`${was} trifft nicht zu`)
}
export function falsch(bedingung, was = 'Bedingung') {
  if (bedingung) throw new Error(`${was} trifft zu, sollte aber nicht`)
}
export function enthaelt(text, teil, was = 'Text') {
  if (!String(text).includes(teil)) {
    throw new Error(`${was} enthält ${JSON.stringify(teil)} nicht.\n  Anfang: ${String(text).slice(0, 300)}`)
  }
}

/** Wartet, bis bedingung() wahr liefert — sonst Fehler mit Klartext statt stiller Hänger. */
export async function warteAuf(bedingung, { was = 'Bedingung', timeoutMs = 15_000, taktMs = 250 } = {}) {
  const ende = Date.now() + timeoutMs
  let zuletzt
  while (Date.now() < ende) {
    try {
      zuletzt = await bedingung()
      if (zuletzt) return zuletzt
    } catch (err) {
      zuletzt = err.message
    }
    await new Promise(r => setTimeout(r, taktMs))
  }
  throw new Error(`Zeitüberschreitung (${timeoutMs} ms) beim Warten auf: ${was}` +
    (zuletzt ? `\n  zuletzt gesehen: ${JSON.stringify(zuletzt).slice(0, 200)}` : ''))
}

/** Abschlussbericht; liefert den Exit-Code. */
export function bericht(titel, startZeit) {
  const dauer = ((Date.now() - startZeit) / 1000).toFixed(1)
  console.log(`\n${'─'.repeat(64)}`)
  if (zaehler.fehler.length === 0) {
    console.log(`${GRUEN}${titel}: ${zaehler.ok} Prüfungen bestanden${WEG}` +
      (zaehler.uebersprungen ? `, ${zaehler.uebersprungen} übersprungen` : '') + ` (${dauer} s)`)
    return 0
  }
  console.log(`${ROT}${titel}: ${zaehler.fehler.length} von ${zaehler.ok + zaehler.fehler.length} Prüfungen fehlgeschlagen${WEG} (${dauer} s)`)
  for (const f of zaehler.fehler) console.log(`  ${ROT}✗${WEG} ${f.name}: ${f.grund.split('\n')[0]}`)
  return 1
}
