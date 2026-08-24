// cc-hub — mini test runner for unit.mjs and e2e.mjs.
// No framework: count, print plain text, set the exit code. Nothing more is needed,
// and it keeps the suite dependency-free like the rest of the project.

const GRUEN = '\x1b[32m', ROT = '\x1b[31m', GRAU = '\x1b[90m', WEG = '\x1b[0m'

export const zaehler = { ok: 0, fehler: [], uebersprungen: 0 }

export function gruppe(titel) {
  console.log(`\n${titel}`)
}

/** A single check. fn may be synchronous or asynchronous; throwing = failed. */
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

// ---- Assertions. Deliberately few: gleich/wahr/enthaelt cover everything. ----
export function gleich(ist, soll, was = 'value') {
  if (ist !== soll) throw new Error(`${was}: got ${JSON.stringify(ist)}, expected ${JSON.stringify(soll)}`)
}
export function wahr(bedingung, was = 'condition') {
  if (!bedingung) throw new Error(`${was} does not hold`)
}
export function falsch(bedingung, was = 'condition') {
  if (bedingung) throw new Error(`${was} holds, but should not`)
}
export function enthaelt(text, teil, was = 'text') {
  if (!String(text).includes(teil)) {
    throw new Error(`${was} does not contain ${JSON.stringify(teil)}.\n  start: ${String(text).slice(0, 300)}`)
  }
}

/** Waits until bedingung() returns truthy — otherwise fails with plain text instead of hanging silently. */
export async function warteAuf(bedingung, { was = 'condition', timeoutMs = 15_000, taktMs = 250 } = {}) {
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
  throw new Error(`timeout (${timeoutMs} ms) while waiting for: ${was}` +
    (zuletzt ? `\n  last seen: ${JSON.stringify(zuletzt).slice(0, 200)}` : ''))
}

/** Final report; returns the exit code. */
export function bericht(titel, startZeit) {
  const dauer = ((Date.now() - startZeit) / 1000).toFixed(1)
  console.log(`\n${'─'.repeat(64)}`)
  if (zaehler.fehler.length === 0) {
    console.log(`${GRUEN}${titel}: ${zaehler.ok} checks passed${WEG}` +
      (zaehler.uebersprungen ? `, ${zaehler.uebersprungen} skipped` : '') + ` (${dauer} s)`)
    return 0
  }
  console.log(`${ROT}${titel}: ${zaehler.fehler.length} of ${zaehler.ok + zaehler.fehler.length} checks failed${WEG} (${dauer} s)`)
  for (const f of zaehler.fehler) console.log(`  ${ROT}✗${WEG} ${f.name}: ${f.grund.split('\n')[0]}`)
  return 1
}
