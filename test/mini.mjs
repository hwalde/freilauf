// Freilauf — mini test runner for unit.mjs and e2e.mjs.
// No framework: count, print plain text, set the exit code. Nothing more is needed,
// and it keeps the suite dependency-free like the rest of the project.

const GREEN = '\x1b[32m', RED = '\x1b[31m', GREY = '\x1b[90m', OFF = '\x1b[0m'

export const counter = { ok: 0, failures: [], skipped: 0 }

export function group(title) {
  console.log(`\n${title}`)
}

/** A single check. fn may be synchronous or asynchronous; throwing = failed. */
export async function check(name, fn) {
  try {
    await fn()
    counter.ok++
    console.log(`  ${GREEN}✓${OFF} ${name}`)
  } catch (err) {
    counter.failures.push({ name, reason: err.message })
    console.log(`  ${RED}✗${OFF} ${name}`)
    console.log(`     ${GREY}${err.message.split('\n').join('\n     ')}${OFF}`)
  }
}

export function skipped(name, reason) {
  counter.skipped++
  console.log(`  ${GREY}– ${name} (${reason})${OFF}`)
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
  console.log(`${RED}${title}: ${counter.failures.length} of ${counter.ok + counter.failures.length} checks failed${OFF} (${seconds} s)`)
  for (const f of counter.failures) console.log(`  ${RED}✗${OFF} ${f.name}: ${f.reason.split('\n')[0]}`)
  return 1
}
