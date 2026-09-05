#!/usr/bin/env node
// Freilauf — the egress proxy, as it runs INSIDE its own container
// (SANDBOX_RESEARCH.md §7.5.1, §11b).
//
// WHY THIS FILE IS FOUR LINES OF WORK AND FORTY OF REASON.
//
// Under a rootless daemon the hub cannot host the run's CONNECT listener at all:
// the run's bridge lives in rootlesskit's own network namespace, so binding that
// network's gateway answers EADDRNOTAVAIL, a container on an `--internal`
// network reaches neither the host's loopback nor its public address, and
// `host-gateway` resolves to the stopped rootful daemon's leftover bridge. The
// listener therefore runs HERE — on the run's own internal network, with a
// second leg to `bridge` for its own egress, dialled by the agent as
// `http://fl-proxy-<run id>:8080`.
//
// It is NOT a second proxy. Everything that decides anything — `hostVerdict`,
// `deniedCidr`, the 403 body with its `fl-report access` sentence, `auditLine` —
// is `server/sandbox/proxy.mjs`, bind-mounted read-only from the hub's own
// checkout together with `lang/`. Two matchers would be two allowlists that
// agree until the day they do not, and the day they do not is the day one of
// them lets something out.
//
// What the container is handed, and nothing else:
//
//   FL_PROXY_POLICY   the hub's policy document (read-only mount). Re-read on
//                     every change: THIS is the control channel — the hub cannot
//                     reach a management port here, which is the whole problem.
//   FL_PROXY_OUT      the one writable directory. `egress.jsonl` is written into
//                     it and the hub tails it; `ready.json` says the listener is
//                     up, which is what the hub waits for instead of believing
//                     `docker run`'s exit code.
//   FL_PROXY_PORT     8080 by default — the port `buildRunArgv()` has always
//                     written into the agent's HTTPS_PROXY when no host address
//                     was known.
//   FL_PROXY_BIND     0.0.0.0. The container is on the run's internal network
//                     and on `bridge`, and nothing else can address it.
//   FL_PROXY_LANG     which of the three catalogs the 403 speaks. The agent
//                     reads that sentence, and the operator picked a language.
//
// No credential is mounted, and none can be: the built-in engine tunnels TLS
// rather than terminating it, so there is no header for it to hold.
import { setLanguage } from '../server/i18n.mjs'
import { runProxyProcess } from '../server/sandbox/proxy.mjs'

const policyPath = process.env.FL_PROXY_POLICY || '/etc/freilauf/proxy/policy.json'
const outDir = process.env.FL_PROXY_OUT || '/var/freilauf/out'
const port = Number(process.env.FL_PROXY_PORT || 8080)
const bind = process.env.FL_PROXY_BIND || '0.0.0.0'

setLanguage(process.env.FL_PROXY_LANG || 'en')

let stopping = false
try {
  const { handle, stop } = await runProxyProcess({
    policyPath, outDir, port, bind, runId: process.env.FL_RUN_ID || null,
  })
  // One line, on stdout, so `docker logs` answers "did it come up and with
  // what" without anybody having to read a file inside a container they cannot
  // attach to. The policy itself is NOT printed: an allow list is not a secret,
  // but a log line is the one place a future field carrying one would end up.
  process.stdout.write(`freilauf proxy listening on ${bind}:${handle.port} for run ${handle.runId ?? '?'}\n`)

  // `--init` reaps, SIGTERM is what `docker stop` sends, and a proxy that
  // ignores it costs every teardown ten seconds of SIGKILL grace.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (stopping) return
      stopping = true
      stop().then(() => process.exit(0), () => process.exit(0))
    })
  }
} catch (err) {
  // The hub reads this back out of `docker logs` and puts it into the launch
  // failure, so it has to be the reason and not a stack trace's first line.
  process.stderr.write(`freilauf proxy failed to start: ${err?.message || String(err)}\n`)
  process.exit(1)
}
