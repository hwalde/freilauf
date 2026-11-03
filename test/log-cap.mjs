#!/usr/bin/env node
// Freilauf — the size cap on a run's terminal recording (bin/fl-log-cap), in a real
// tmux session: `pipe-pane` is what can block, drop or kill this filter, and a pipe
// from a test says nothing about that.
//
//   node test/log-cap.mjs             about 40 s, with a small limit
//   node test/log-cap.mjs --long      the real 5 MB limit at 300 KB/s for 200 s
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { group, check, equal, isTrue, summary, skipped } from './mini.mjs'

const started = Date.now()
const SB = mkdtempSync(join(tmpdir(), 'freilauf-logcap-'))
process.env.FREILAUF_DATA_DIR = join(SB, 'data')
const { readLogFrom, readLogTail } = await import('../server/run-log.mjs')
const { scanNewBytes } = await import('../server/detect.mjs')

const CAP = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fl-log-cap')
const LONG = process.argv.includes('--long')
const SOCKET = `freilauf-logcap-${process.pid}`
const tmux = (...a) => spawnSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`

// Writes at a fixed rate, and says afterwards at which rate it really got rid of it:
// a filter that slows the agent shows up here. Colour per character, like opencode.
const PRODUCER = join(SB, 'producer.mjs')
writeFileSync(PRODUCER, `
import { writeFileSync, writeSync, existsSync } from 'node:fs'
const [rate, seconds, report, flagFile] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4], process.argv[5]]
const line = Buffer.from('\\x1b[38;5;11mx\\x1b[0m'.repeat(60) + '\\n')
const t0 = Date.now(); let n = 0
const tick = () => {
  const passed = (Date.now() - t0) / 1000
  if (passed >= seconds) { writeFileSync(report, JSON.stringify({ bytes: n, seconds: passed })); setTimeout(() => {}, 600000); return }
  while (n < rate * passed) { writeSync(1, line); n += line.length }
  if (flagFile && existsSync(flagFile)) writeSync(1, 'RateLimitError (HTTP 429)\\n')
  setTimeout(tick, 20)
}
tick()
`)

let serial = 0
function session(command, logf, max) {
  const name = `cap${++serial}`
  const r = tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '30', command)
  equal(r.status, 0, `tmux new-session: ${r.stderr}`)
  const armed = tmux('pipe-pane', '-o', '-t', `=${name}:`, `exec ${q(CAP)} ${q(logf)}${max ? ` ${max}` : ''}`)
  equal(armed.status, 0, `pipe-pane: ${armed.stderr}`)
  return name
}
const filterPid = (logf) => spawnSync('pgrep', ['-f', `${CAP} ${logf}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number)
const prod = (rate, seconds, report, flag = '') => `node ${q(PRODUCER)} ${rate} ${seconds} ${q(report)} ${flag ? q(flag) : ''}`
const feed = (logf, input, max) => spawnSync(CAP, [logf, ...(max ? [String(max)] : [])], { input })

try {
  if (spawnSync('tmux', ['-V']).status !== 0) {
    skipped('tmux is not installed', 'this suite needs a real session')
  } else {
    group('The filter on its own')

    await check('a small log is every byte, unchanged, with no header', () => {
      const f = join(SB, 'small.log')
      const body = Buffer.from('first\nsecond \x1b[31mred\x1b[0m\n')
      equal(feed(f, body).status, 0, 'ends on end of input')
      isTrue(readFileSync(f).equals(body), 'identical')
      equal(readLogFrom(f, 0).text, body.toString(), 'and readable from the start')
    })

    await check('end of input does not empty the file (dd truncates a stdout it wrote nothing to)', () => {
      const f = join(SB, 'eof.log')
      writeFileSync(f, 'already here\n')
      feed(f, Buffer.alloc(0))
      equal(readFileSync(f, 'utf8'), 'already here\n', 'still there')
    })

    await check('a resumed run from before the cap: its big log moves aside whole, the count goes on', () => {
      const f = join(SB, 'resume.log')
      writeFileSync(f, 'x'.repeat(2_000_000))
      feed(f, Buffer.from('new\n'), 600_000)
      isTrue(statSync(f).size <= 600_000, `limit holds: ${statSync(f).size}`)
      equal(statSync(`${f}.before-cap`).size, 2_000_000, 'the old log is untouched')
      const r = readLogFrom(f, 2_000_000)
      equal(r.size, 2_000_004, 'the count includes the old file')
      equal(r.text, 'new\n', 'and a scanner at the old offset reads the new bytes only')
    })

    await check('what a filter killed in mid-rotation left behind is cleaned up', () => {
      const f = join(SB, 'stale.log')
      writeFileSync(`${f}.cap.12345`, 'half a copy')
      feed(f, Buffer.from('x\n'))
      isTrue(!existsSync(`${f}.cap.12345`), 'gone')
    })

    await check('the count stays exact over many cuts and over a restart of the filter', () => {
      const f = join(SB, 'count.log')
      const chunk = (i) => Buffer.from(`${String(i).padStart(10, '0')}\n`.repeat(2000))
      let total = 0
      for (const round of [0, 1, 2]) {
        const input = Buffer.concat(Array.from({ length: 20 }, (_, i) => chunk(round * 100 + i)))
        total += input.length
        feed(f, input, 300_000)
      }
      isTrue(statSync(f).size <= 300_000, `limit holds: ${statSync(f).size}`)
      const r = readLogFrom(f, 0)
      equal(r.size, total, 'everything ever written')
      equal(r.von + Buffer.byteLength(r.text), total, 'the bytes read end at the end')
      isTrue(r.text.endsWith(chunk(219).toString()), 'and they are the newest')
    })

    await check('a directory that is gone or read-only does not stop it draining', () => {
      const gone = join(SB, 'no-such-dir', 'x.log')
      equal(feed(gone, Buffer.alloc(3_000_000, 0x41), 600_000).status, 0, 'no directory: drains and ends')
      const ro = join(SB, 'readonly'); mkdirSync(ro)
      const f = join(ro, 'x.log')
      writeFileSync(f, '')
      chmodSync(ro, 0o555)
      try {
        equal(feed(f, Buffer.alloc(3_000_000, 0x42), 600_000).status, 0, 'no rename possible: ends')
        isTrue(statSync(f).size <= 600_000, `and the limit holds in place: ${statSync(f).size}`)
      } finally { chmodSync(ro, 0o755) }
    })

    group('Inside a real tmux session')

    await check('300 KB/s: under the limit, not slowed, no filter left behind', async () => {
      const f = join(SB, 'tmux.log'), report = join(SB, 'tmux.json')
      const name = session(prod(300_000, 12, report), f, 1_000_000)
      let max = 0
      for (let i = 0; i < 65; i++) { await sleep(200); if (existsSync(f)) max = Math.max(max, statSync(f).size) }
      isTrue(max <= 1_000_000, `largest size seen: ${max}`)
      const { bytes, seconds } = JSON.parse(readFileSync(report, 'utf8'))
      isTrue(bytes / seconds > 290_000, `the program kept its rate: ${Math.round(bytes / seconds / 1000)} KB/s`)
      equal(readLogFrom(f, 0).size >= bytes * 0.99, true, 'the count covers what was written')
      tmux('kill-session', '-t', `=${name}`)
      await sleep(500)
      equal(filterPid(f).length, 0, 'the filter ended with the session')
    })

    await check('a killed filter takes nothing with it: the program goes on, tmux says the pipe is off', async () => {
      const f = join(SB, 'killed.log'), report = join(SB, 'killed.json')
      const name = session(prod(100_000, 3, report), f)
      await sleep(800)
      for (const pid of filterPid(f)) { spawnSync('pkill', ['-KILL', '-P', String(pid)]); try { process.kill(pid, 'SIGKILL') } catch {} }
      await sleep(300)
      equal(tmux('display-message', '-p', '-t', `=${name}:`, '#{pane_pipe}').stdout.trim(), '0', 'pipe off')
      await sleep(3000)
      isTrue(existsSync(report), 'the program finished its work')
      equal(tmux('has-session', '-t', `=${name}`).status, 0, 'the session stands')
      tmux('kill-session', '-t', `=${name}`)
    })

    await check('a filter that stops reading does not stop the program', async () => {
      const f = join(SB, 'stopped.log'), report = join(SB, 'stopped.json')
      const name = session(prod(300_000, 4, report), f)
      await sleep(500)
      const pids = filterPid(f)
      for (const pid of pids) { spawnSync('pkill', ['-STOP', '-P', String(pid)]); process.kill(pid, 'SIGSTOP') }
      await sleep(4200)
      const { bytes, seconds } = JSON.parse(readFileSync(report, 'utf8'))
      isTrue(bytes / seconds > 290_000, `rate while nobody reads: ${Math.round(bytes / seconds / 1000)} KB/s`)
      for (const pid of pids) { process.kill(pid, 'SIGCONT'); spawnSync('pkill', ['-CONT', '-P', String(pid)]) }
      await sleep(1500)
      isTrue(readLogFrom(f, 0).size >= bytes * 0.99, 'and everything tmux held arrives afterwards')
      tmux('kill-session', '-t', `=${name}`)
    })

    await check('hermes: a hit after many cuts is found, through the watcher\'s own read', async () => {
      const f = join(SB, 'hit.log'), report = join(SB, 'hit.json'), flag = join(SB, 'hit.flag')
      const name = session(prod(300_000, 8, report, flag), f, 1_000_000)
      await sleep(5000)
      const before = readLogFrom(f, 0)
      isTrue(before.skipped > 0, 'cut several times by now')
      let offset = before.von + Buffer.byteLength(before.text)
      writeFileSync(flag, '')
      await sleep(400)
      rmSync(flag)
      await sleep(300)
      const chunk = readLogFrom(f, offset)
      const { treffer, neuerOffset } = scanNewBytes('hermes', chunk.text, chunk.von)
      isTrue(treffer.some(t => t.typ === 'rate_limit'), 'the error line')
      isTrue(neuerOffset > offset, 'the position moved on')
      tmux('kill-session', '-t', `=${name}`)
    })

    if (LONG) {
      group('The long run: the real limit, 300 KB/s, 200 s')
      await check('the whole picture', async () => {
        const SECONDS = 200
        const f = join(SB, 'long.log'), report = join(SB, 'long.json'), flag = join(SB, 'long.flag')
        const name = session(prod(300_000, SECONDS, report, flag), f)
        let max = 0, offset = 0, found = 0, passes = 0, lost = 0
        const t0 = Date.now()
        let nextPass = t0 + 30_000
        while (Date.now() - t0 < (SECONDS - 1) * 1000) {
          await sleep(100)
          if (existsSync(f)) max = Math.max(max, statSync(f).size)
          // One error line shortly before every watcher pass, as a live retry loop would.
          if (Date.now() > nextPass - 2000 && !existsSync(flag) && Date.now() < nextPass) writeFileSync(flag, '')
          if (Date.now() >= nextPass) {
            if (existsSync(flag)) rmSync(flag)
            nextPass += 30_000
            const c = readLogFrom(f, offset)
            lost += c.skipped
            const { treffer, neuerOffset } = scanNewBytes('hermes', c.text, c.von)
            offset = neuerOffset
            passes++
            if (treffer.some(t => t.typ === 'rate_limit')) found++
          }
        }
        await sleep(1500)
        const { bytes, seconds } = JSON.parse(readFileSync(report, 'utf8'))
        console.log(`    produced ${(bytes / 1e6).toFixed(1)} MB at ${Math.round(bytes / seconds / 1000)} KB/s; largest file ${max} bytes; final ${statSync(f).size}; `
          + `${passes} passes, hit in ${found}; skipped ${(lost / 1e6).toFixed(1)} MB`)
        isTrue(max <= 5_000_000, `largest size seen: ${max}`)
        isTrue(bytes / seconds > 295_000, `not slowed: ${Math.round(bytes / seconds / 1000)} KB/s`)
        isTrue(bytes > 50_000_000, 'well past the limit')
        equal(found, passes, 'the error found on every pass')
        equal(readLogTail(f, 100).length, 100, 'the tail reads')
        tmux('kill-session', '-t', `=${name}`)
      })
    }
  }
} finally {
  tmux('kill-server')
  rmSync(SB, { recursive: true, force: true })
}
process.exit(summary('Log cap', started))
