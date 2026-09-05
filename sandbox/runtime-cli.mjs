#!/usr/bin/env node
// The one place a sandboxed run's command line is PRINTED, and deliberately not
// a second place where it is DECIDED: every rule about it lives in
// `server/sandbox/runtime.mjs`'s `buildRunArgv(spec, ctx)`, which is pure and
// unit-tested. This file reads the run's `sandbox.json`, adds the three things
// only the launcher knows — the harness command line, the pane's TERM, and the
// environment variables `fl-start` was handed — and prints the resulting argv.
//
// Why a printer and not a runner: the process that must end up in the tmux pane
// is the container client itself, because `pane-died` carries ITS exit status
// and `pipe-pane` reads ITS output (SANDBOX_RESEARCH.md §7.1). A node process
// sitting in between would break both. So `sandbox/wrap.sh` reads what this
// prints and `exec`s it — node is gone before the container starts.
//
// Output: one argument per line-less record, NUL-separated, the binary first.
// NUL because an argument may contain anything at all, a newline included (a
// `--settings` JSON does).
//
// `--print-env` prints, in the same shape, the environment the runtime CLI needs
// to reach the daemon it is meant to reach. It exists because the container
// client does NOT run in the hub's process: it runs in a tmux pane, whose
// environment tmux composed, and `docker` with no `DOCKER_HOST` falls back to
// `/var/run/docker.sock` — the rootful socket, which on a rootless installation
// is either absent or unreadable. Measured 2026-09-05 on the first real
// sandboxed run: the pane died half a second after the start with `permission
// denied while trying to connect to the docker API at
// unix:///var/run/docker.sock`, exit status 1, and the run's whole log was that
// one line. The hub itself never had the problem, because `runtimeEnv()` in
// server/sandbox/runtime.mjs hands its own calls the endpoint it resolved — the
// pane was simply the one caller that never went through it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function die (msg, code = 1) {
  process.stderr.write(`fl-sandbox: ${msg}\n`)
  process.exit(code)
}

function usage () {
  process.stderr.write(`Usage: runtime-cli.mjs <sandbox.json> [options] -- <cmd> [args...]

  --env KEY=VAL      add an environment variable for the container (repeatable)
  --env-inherit NAME take NAME from this process's own environment (repeatable).
                     An unset name is skipped, never an error — that is what lets
                     the launcher pass FL_PROMPT before it exists.
  --term VALUE       the terminal type; default \$TERM of this process.
  --print-env        print the runtime environment (KEY=VALUE, NUL-separated)
                     instead of the command line. No command is needed for it.
`)
}

const argv = process.argv.slice(2)
let specPath = null
const env = {}
const inherit = []
let term = null
let cmd = null
let printEnv = false

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--') { cmd = argv.slice(i + 1); break }
  else if (a === '--print-env') { printEnv = true }
  else if (a === '--env') { const v = argv[++i]; if (v === undefined) die('--env needs KEY=VALUE'); const eq = v.indexOf('='); if (eq < 1) die(`--env needs KEY=VALUE, got: ${v}`); env[v.slice(0, eq)] = v.slice(eq + 1) }
  else if (a === '--env-inherit') { const v = argv[++i]; if (!v) die('--env-inherit needs a name'); inherit.push(v) }
  else if (a === '--term') { term = argv[++i] ?? null }
  else if (a === '-h' || a === '--help') { usage(); process.exit(0) }
  else if (a.startsWith('-')) die(`unknown option: ${a}`)
  else if (specPath === null) specPath = a
  else die(`unexpected argument: ${a}`)
}

if (!specPath) { usage(); die('no sandbox.json given') }
if (!printEnv && (!cmd || cmd.length === 0)) die('no command given (everything after -- is the command)')

// An unset name is skipped rather than exported as the empty string: an empty
// FL_PROMPT inside the container would be a prompt the agent answers with
// nothing, which is worse than the variable not being there at all.
for (const name of inherit) {
  if (process.env[name] !== undefined && !(name in env)) env[name] = process.env[name]
}

let doc
try {
  doc = JSON.parse(readFileSync(specPath, 'utf8'))
} catch (e) {
  die(`cannot read the sandbox spec ${specPath}: ${e.message}`)
}
if (!doc || typeof doc !== 'object') die(`the sandbox spec is not a JSON object: ${specPath}`)
if (!doc.spec || typeof doc.spec !== 'object') die(`the sandbox spec has no "spec" object: ${specPath}`)
if (!doc.ctx || typeof doc.ctx !== 'object') die(`the sandbox spec has no "ctx" object: ${specPath}`)

// The hub's own module, imported from the checkout this file lives in. It is
// loaded LATE and by name so that a missing or broken module is a sentence a
// human can act on rather than a stack trace in a dying tmux pane.
let buildRunArgv
try {
  ;({ buildRunArgv } = await import(join(HERE, '..', 'server', 'sandbox', 'runtime.mjs')))
} catch (e) {
  die(`cannot load server/sandbox/runtime.mjs next to ${HERE}: ${e.message}`)
}
if (typeof buildRunArgv !== 'function') die('server/sandbox/runtime.mjs exports no buildRunArgv()')

const ctx = {
  ...doc.ctx,
  cmd,
  // The pane's own terminal type, because the container's TTY is the pane's
  // (§8.17). `--term` wins so a caller with no TERM of its own can still say.
  term: term || process.env.TERM || doc.ctx.term || 'xterm-256color',
  // The launcher's variables are added to whatever the hub already resolved;
  // the hub's own values win, because a run's identity (FL_RUN_ID, the run
  // token) is not something a launcher may talk over.
  env: { ...env, ...(doc.ctx.env ?? {}) },
}

let out
try {
  out = buildRunArgv(doc.spec, ctx)
} catch (e) {
  die(`buildRunArgv() refused this spec: ${e.message}`)
}
if (!out || typeof out.bin !== 'string' || !Array.isArray(out.args)) {
  die('buildRunArgv() did not answer { bin, args }')
}

process.stdout.write([out.bin, ...out.args].map(String).join('\0') + '\0')
