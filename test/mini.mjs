// Freilauf — mini test runner for unit.mjs and e2e.mjs.
// No framework: count, print plain text, set the exit code. Nothing more is needed,
// and it keeps the suite dependency-free like the rest of the project.

const GREEN = '\x1b[32m', RED = '\x1b[31m', GREY = '\x1b[90m', OFF = '\x1b[0m'

export const counter = { ok: 0, failures: [], skipped: 0 }

export function group(title) {
  console.log(`\n${title}`)
}

/**
 * Is a `check` callback running right now? `skipped()` is called from
 * both sides — standalone ("the whole suite is skipped, openssl is missing")
 * and from INSIDE a check that discovers halfway through that it cannot run —
 * and the two have to end differently. The suites are strictly sequential
 * (`await check(...)`, never `Promise.all`), so one flag is enough.
 */
let inCheck = false

/** What a skip inside a check throws, so `check` can tell it from a failure. */
const SKIPPED = Symbol('skipped')

/** A single check. fn may be synchronous or asynchronous; throwing = failed. */
export async function check(name, fn) {
  const outer = inCheck
  inCheck = true
  try {
    await fn()
    counter.ok++
    console.log(`  ${GREEN}✓${OFF} ${name}`)
  } catch (err) {
    // A skip is not a pass. It used to be exactly that: `skipped()`
    // inside a callback returned normally, so the counter went up by one and a
    // green ✓ was printed for a check that had asserted nothing — and the
    // summary's "N checks passed" silently included it. The skip has already
    // printed its own line by the time this throw arrives.
    if (err?.[SKIPPED]) { inCheck = outer; return }
    counter.failures.push({ name, reason: err.message })
    console.log(`  ${RED}✗${OFF} ${name}`)
    console.log(`     ${GREY}${err.message.split('\n').join('\n     ')}${OFF}`)
  } finally {
    inCheck = outer
  }
}

export function skipped(name, reason) {
  counter.skipped++
  console.log(`  ${GREY}– ${name} (${reason})${OFF}`)
  // Inside a check the skip has to END the check: falling through would run the
  // assertions the skip exists to avoid, and returning would let `check` count
  // a pass. The sentinel carries the name so a suite that catches everything
  // still says what was skipped.
  if (inCheck) {
    const err = new Error(`skipped: ${name} (${reason})`)
    err[SKIPPED] = true
    throw err
  }
}

// ---- Assertions. Deliberately few: equal/isTrue/contains cover everything. ----
export function equal(actual, expected, what = 'value') {
  if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
export function isTrue(condition, what = 'condition') {
  if (!condition) throw new Error(`${what} does not hold`)
}
export function isFalse(condition, what = 'condition') {
  if (condition) throw new Error(`${what} holds, but should not`)
}
export function contains(text, part, what = 'text') {
  if (!String(text).includes(part)) {
    throw new Error(`${what} does not contain ${JSON.stringify(part)}.\n  start: ${String(text).slice(0, 300)}`)
  }
}

/** Waits until condition() returns truthy — otherwise fails with plain text instead of hanging silently. */
export async function waitFor(condition, { what = 'condition', timeoutMs = 15_000, tickMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await condition()
      if (last) return last
    } catch (err) {
      last = err.message
    }
    await new Promise(r => setTimeout(r, tickMs))
  }
  throw new Error(`timeout (${timeoutMs} ms) while waiting for: ${what}` +
    (last ? `\n  last seen: ${JSON.stringify(last).slice(0, 200)}` : ''))
}

/** Final summary; returns the exit code. */
export function summary(title, startTime) {
  const seconds = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n${'─'.repeat(64)}`)
  if (counter.failures.length === 0) {
    console.log(`${GREEN}${title}: ${counter.ok} checks passed${OFF}` +
      (counter.skipped ? `, ${counter.skipped} skipped` : '') + ` (${seconds} s)`)
    return 0
  }
  console.log(`${RED}${title}: ${counter.failures.length} of ${counter.ok + counter.failures.length} checks failed${OFF}` +
    (counter.skipped ? `, ${counter.skipped} skipped` : '') + ` (${seconds} s)`)
  for (const f of counter.failures) console.log(`  ${RED}✗${OFF} ${f.name}: ${f.reason.split('\n')[0]}`)
  return 1
}
