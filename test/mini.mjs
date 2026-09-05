// Freilauf — mini test runner for unit.mjs and e2e.mjs.
// No framework: count, print plain text, set the exit code. Nothing more is needed,
// and it keeps the suite dependency-free like the rest of the project.

const GRUEN = '\x1b[32m', ROT = '\x1b[31m', GRAU = '\x1b[90m', WEG = '\x1b[0m'

export const zaehler = { ok: 0, fehler: [], uebersprungen: 0 }

export function gruppe(titel) {
  console.log(`\n${titel}`)
}

/**
 * Is a `pruefe` callback running right now? `uebersprungen()` is called from
 * both sides — standalone ("the whole suite is skipped, openssl is missing")
 * and from INSIDE a check that discovers halfway through that it cannot run —
 * and the two have to end differently. The suites are strictly sequential
 * (`await pruefe(...)`, never `Promise.all`), so one flag is enough.
 */
let inPruefe = false

/** What a skip inside a check throws, so `pruefe` can tell it from a failure. */
const UEBERSPRUNGEN = Symbol('uebersprungen')

/** A single check. fn may be synchronous or asynchronous; throwing = failed. */
export async function pruefe(name, fn) {
  const draussen = inPruefe
  inPruefe = true
  try {
    await fn()
    zaehler.ok++
    console.log(`  ${GRUEN}✓${WEG} ${name}`)
  } catch (err) {
    // A skip is not a pass. It used to be exactly that: `uebersprungen()`
    // inside a callback returned normally, so the counter went up by one and a
    // green ✓ was printed for a check that had asserted nothing — and the
    // summary's "N checks passed" silently included it. The skip has already
    // printed its own line by the time this throw arrives.
    if (err?.[UEBERSPRUNGEN]) { inPruefe = draussen; return }
    zaehler.fehler.push({ name, grund: err.message })
    console.log(`  ${ROT}✗${WEG} ${name}`)
    console.log(`     ${GRAU}${err.message.split('\n').join('\n     ')}${WEG}`)
  } finally {
    inPruefe = draussen
  }
}

export function uebersprungen(name, grund) {
  zaehler.uebersprungen++
  console.log(`  ${GRAU}– ${name} (${grund})${WEG}`)
  // Inside a check the skip has to END the check: falling through would run the
  // assertions the skip exists to avoid, and returning would let `pruefe` count
  // a pass. The sentinel carries the name so a suite that catches everything
  // still says what was skipped.
  if (inPruefe) {
    const err = new Error(`skipped: ${name} (${grund})`)
    err[UEBERSPRUNGEN] = true
    throw err
  }
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
  console.log(`${ROT}${titel}: ${zaehler.fehler.length} of ${zaehler.ok + zaehler.fehler.length} checks failed${WEG}` +
    (zaehler.uebersprungen ? `, ${zaehler.uebersprungen} skipped` : '') + ` (${dauer} s)`)
  for (const f of zaehler.fehler) console.log(`  ${ROT}✗${WEG} ${f.name}: ${f.grund.split('\n')[0]}`)
  return 1
}
