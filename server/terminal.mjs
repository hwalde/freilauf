// cc-hub — terminal in the browser (planning 7.4): node-pty spawns `tmux attach-session`;
// resize frame "\0{cols,rows}"; pty.kill() only terminates the tmux client, never the session.
// Write access hangs on `?ro=0` and is fail-closed: if the parameter is missing or holds
// anything else, we attach with `-r` AND discard every input. The client sets
// ro=0 only for runs with an open session (pages.mjs: data-live).
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { getRun } from './db.mjs'
import { sh } from './util.mjs'

const SESSION_RE = /^cc-[A-Za-z0-9_-]+$/   // planning 11

export function startTerminalServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/term') return   // leave other upgrades (if added later) untouched
    const runId = url.searchParams.get('run') ?? ''
    const readOnly = url.searchParams.get('ro') !== '0'
    const run = /^[0-9a-f-]{36}$/.test(runId) ? getRun(runId) : null
    // Planning 11: check session names against the pattern + run ownership.
    if (!run || !run.tmux_session || !SESSION_RE.test(run.tmux_session)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    const has = await sh('tmux', ['has-session', '-t', `=${run.tmux_session}`])
    if (!has.ok) {
      socket.write('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, run.tmux_session, readOnly)
    })
  })
}

function attach(ws, session, readOnly) {
  // '-r' is a flag of attach-session, so it must come AFTER it — placed before,
  // tmux would take it for a global flag and abort.
  // The agent's window rewraps to the browser size while watching. That comes from
  // the resize frame, NOT from the write access — the read-only client did it
  // just the same (measured). '-f ignore-size' does not help against it: with
  // 'window-size latest' (default) the most recently active client still counts.
  // To pin the size you need 'window-size manual' on the session.
  const args = readOnly
    ? ['attach-session', '-r', '-t', `=${session}`]
    : ['attach-session', '-t', `=${session}`]
  const ptyProc = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols: 120, rows: 30,
    cwd: process.env.HOME,
    env: process.env,
  })

  ptyProc.onData(d => { if (ws.readyState === ws.OPEN) ws.send(d) })
  ptyProc.onExit(({ exitCode }) => {
    try { ws.close() } catch {}
  })
  ws.on('message', (data) => {
    const s = String(data)
    if (s.startsWith('\0')) {           // resize frame: \0{cols},{rows}
      const [c, r] = s.slice(1).split(',').map(Number)
      if (Number.isFinite(c) && Number.isFinite(r)) {
        try { ptyProc.resize(Math.min(Math.max(c, 20), 500), Math.min(Math.max(r, 5), 300)) } catch {}
      }
      return
    }
    // No filtering of individual keys: whoever may write may also type Ctrl-C or
    // `exit` — that is the price of usability and cannot be filtered out sensibly.
    // The earlier comparison against the string '\x03\x03kill' never matched.
    if (!readOnly) ptyProc.write(s)
  })
  ws.on('close', () => { try { ptyProc.kill() } catch {} })   // only the tmux client dies
  ws.on('error', () => { try { ptyProc.kill() } catch {} })
}
