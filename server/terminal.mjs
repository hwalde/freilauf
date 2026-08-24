// cc-hub — Terminal im Browser (Planung 7.4): node-pty spawnt `tmux attach-session`;
// Resize-Frame "\0{cols,rows}"; pty.kill() beendet nur den tmux-Client, nie die Session.
// Schreibrechte hängen an `?ro=0` und sind fail-closed: fehlt der Parameter oder steht
// etwas anderes drin, wird mit `-r` angehängt UND jede Eingabe verworfen. Der Client
// setzt ro=0 nur für Läufe mit offener Session (pages.mjs: data-live).
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { getRun } from './db.mjs'
import { sh } from './util.mjs'

const SESSION_RE = /^cc-[A-Za-z0-9_-]+$/   // Planung 11

export function startTerminalServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/term') return   // andere Upgrades (falls später) unberührt lassen
    const runId = url.searchParams.get('run') ?? ''
    const readOnly = url.searchParams.get('ro') !== '0'
    const run = /^[0-9a-f-]{36}$/.test(runId) ? getRun(runId) : null
    // Planung 11: Session-Namen gegen Muster prüfen + Run-Zugehörigkeit.
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
  // '-r' ist ein Flag von attach-session, muss also DAHINTER stehen — vorangestellt
  // hielte tmux es für ein globales Flag und bräche ab.
  // Das Fenster des Agenten bricht beim Zuschauen auf die Browsergröße um. Das kommt
  // vom Resize-Frame, NICHT von den Schreibrechten — der read-only-Client tat es
  // genauso (gemessen). '-f ignore-size' hilft dagegen nicht: bei 'window-size latest'
  // (Default) zählt der zuletzt aktive Client trotzdem. Wer die Größe festnageln will,
  // braucht 'window-size manual' auf der Session.
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
    if (s.startsWith('\0')) {           // Resize-Frame: \0{cols},{rows}
      const [c, r] = s.slice(1).split(',').map(Number)
      if (Number.isFinite(c) && Number.isFinite(r)) {
        try { ptyProc.resize(Math.min(Math.max(c, 20), 500), Math.min(Math.max(r, 5), 300)) } catch {}
      }
      return
    }
    // Kein Filtern einzelner Tasten: wer schreiben darf, darf auch Strg-C oder `exit`
    // tippen — das ist der Preis der Bedienbarkeit und lässt sich nicht sinnvoll
    // aussieben. Der frühere Vergleich auf die Zeichenkette '\x03\x03kill' traf nie zu.
    if (!readOnly) ptyProc.write(s)
  })
  ws.on('close', () => { try { ptyProc.kill() } catch {} })   // nur der tmux-Client stirbt
  ws.on('error', () => { try { ptyProc.kill() } catch {} })
}
