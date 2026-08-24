// cc-hub — Lauf-Erzeugung: Run-Verzeichnis, Worktree, Prompt-Zusatz, Start über cc-start
// (einziger Startweg, damit CLI und UI identische Läufe erzeugen — Planung 5).
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, cpSync, symlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import db, { getRepo, addEvent } from './db.mjs'
import { RUNS_DIR, WORKTREES_DIR, kurzid, sh } from './util.mjs'
import { claudeQuota, openrouterCredits } from './quota.mjs'
import { skillPromptZusatz } from './zusaetze.mjs'

const DEFAULT_SUFFIX = [
  '---',
  'Plattform-Regeln (cc-hub, Lauf {run_id}):',
  '- Arbeitsverzeichnis: {workdir}. Branch-Vorgabe: {branch_rule}.',
  '- Erwartete maximale Arbeitsdauer: {expected_minutes} min. Brauchst du deutlich länger,',
  '  melde es: `cc-report progress "<wo stehst du, warum länger>"`.',
  '- Legst du einen Branch oder Pull-Request an, melde es sofort:',
  '  `cc-report branch <name>` bzw. `cc-report pr <url>`.',
  '- Brauchst du eine Entscheidung eines Menschen oder hast du ein großes Problem entdeckt:',
  '  `cc-report help "<Frage/Problem>"` — dann WARTE auf die Antwort in dieser Session.',
  '- Zum Schluss IMMER: `cc-report done --file <report.md>` (was getan, was offen, was geprüft',
  '  werden sollte). Ohne diesen Aufruf gilt der Lauf als nicht abgeschlossen.',
  '- Bei Scheitern: `cc-report failed "<Grund>"`.',
  'Beende die Session nach dem Report nicht selbst; die Plattform räumt auf.',
].join('\n')

export function platformSuffix(run, branchRule, settings) {
  const tpl = settings.prompt_suffix || DEFAULT_SUFFIX
  return tpl
    .replaceAll('{run_id}', run.id)
    .replaceAll('{workdir}', run.workdir_effective)
    .replaceAll('{branch_rule}', branchRule)
    .replaceAll('{expected_minutes}', String(run.expected_minutes))
}

function expandPattern(pattern, run) {
  return String(pattern || '')
    .replaceAll('{date}', new Date().toISOString().slice(0, 10).replaceAll('-', ''))
    .replaceAll('{agent}', run.agent_name || 'einzel')
    .replaceAll('{kurz}', kurzid(run.id))
}

async function makeWorktree(repo, run, branchName) {
  const wtRoot = join(WORKTREES_DIR, repo.name)
  mkdirSync(wtRoot, { recursive: true })
  await sh('git', ['-C', repo.path, 'worktree', 'prune'])
  await sh('git', ['-C', repo.path, 'fetch', 'origin'])
  const base = repo.base_branch
  const target = join(wtRoot, `${kurzid(run.id)}-${(branchName || 'detached').replace(/\//g, '-')}`)
  // Wiederholung eines gescheiterten Laufs: der Worktree von eben liegt noch da.
  // 'git worktree add' würde daran scheitern — also weiterbenutzen, was schon steht.
  if (existsSync(target)) return target
  let r
  if (run.branch_mode === 'neu') {
    r = await sh('git', ['-C', repo.path, 'worktree', 'add', '-b', branchName, target, `origin/${base}`])
  } else if (run.branch_mode === 'fest') {
    // Bestehenden lokalen Branch nutzen, sonst von origin anlegen.
    const have = await sh('git', ['-C', repo.path, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])
    r = have.ok
      ? await sh('git', ['-C', repo.path, 'worktree', 'add', target, branchName])
      : await sh('git', ['-C', repo.path, 'worktree', 'add', '-b', branchName, target, `origin/${base}`])
  } else {
    r = await sh('git', ['-C', repo.path, 'worktree', 'add', '--detach', target, `origin/${base}`])
  }
  if (!r.ok) throw new Error(`git worktree fehlgeschlagen: ${r.stderr.trim()}`)
  // Worktree-Ergänzungen (Planung 4.0): kopieren oder verlinken.
  for (const extra of repo.extras ?? []) {
    const src = resolve(repo.path, extra.path)
    const dst = resolve(target, extra.path)
    if (!existsSync(src) || existsSync(dst)) continue
    mkdirSync(join(dst, '..'), { recursive: true })
    if (extra.mode === 'link') symlinkSync(src, dst)
    else cpSync(src, dst, { recursive: true })
  }
  return target
}

/**
 * Hook-Format von Claude Code: JEDES Ereignis ist eine Liste aus
 * { matcher?, hooks: [{ type, command }] } — eine nackte Kommandoliste lehnt Claude ab.
 * Und zwar nicht nur teilweise: eine fehlerhafte Settings-Datei wird KOMPLETT
 * verworfen ("Files with errors are skipped entirely") und der Lauf bleibt an einem
 * interaktiven Dialog stehen. Damit fiele die gesamte Rückmeldekette aus.
 */
export function claudeSettingsJson() {
  const hook = (cmd) => [{ hooks: [{ type: 'command', command: cmd }] }]
  return JSON.stringify({
    hooks: {
      Stop: hook('cc-report _turn_end'),
      SessionEnd: hook('cc-report _exit'),
      Notification: hook('cc-report _idle'),
      // Rate-Limit, overloaded, Auth, Billing …: Claude nennt den Grund als festes Enum
      // auf stdin. Verifiziert mit Claude Code 2.1.241 (simuliertes 429 mit
      // anthropic-ratelimit-unified-status: rejected → error: "rate_limit").
      // ACHTUNG: Auf diesen Hook wartet Claude NICHT — der Prozess ist binnen 100 ms
      // weg, und mit ihm der Hook (gemessen: 'cat' kommt durch, 'sleep 0.1' nicht).
      // Darum 'setsid -f': cc-report läuft abgekoppelt in eigener Session weiter und
      // liest das Ereignis aus der ererbten stdin-Pipe.
      StopFailure: hook('setsid -f cc-report _api_error >/dev/null 2>&1'),
    },
  })
}

/** Legt den Run-Datensatz an (Definitions-Kopie) und gibt die Run-ID zurück. */
export function createRun({ repoId, agentId = null, harness, model = null, provider = null,
  orProvider = null, effort = null, prompt, promptExtra = null, branchMode, branchPattern = null,
  expectedMinutes, skills = null }) {
  if (!['claude', 'opencode', 'hermes', 'cursor'].includes(harness)) throw new Error('unbekannte Harness')
  if (!prompt?.trim()) throw new Error('Prompt ist leer')
  const id = randomUUID()
  db.prepare(`INSERT INTO runs(id, repo_id, agent_id, status, harness, model, provider, or_provider,
              effort, prompt, prompt_extra, branch_mode, branch_pattern, expected_minutes, skills, last_activity_at)
              VALUES(?,?,?, 'running', ?,?,?,?,?,?,?,?,?,?,? , datetime('now'))`)
    .run(id, repoId, agentId, harness, model, provider, orProvider, effort, prompt, promptExtra,
      branchMode, branchPattern, expectedMinutes, skills)
  return id
}

// opencode spricht Provider über ein Präfix am Modell an. Achtung, Stolperfalle:
// OpenCode Zen heißt dort schlicht 'opencode' — NICHT 'opencode-zen' (so steht es
// zwar in der Doku, aber 'opencode models --pure' sagt etwas anderes).
const OC_PREFIX = { openrouter: 'openrouter', deepseek: 'deepseek', 'opencode-zen': 'opencode' }

// Der Standard-Agent von opencode; unter diesem Schlüssel liegt die Modell-/Varianten-
// Wahl. 'opencode debug config' führt hier keinen eigenen Eintrag, die Statuszeile
// zeigt „Build" — deshalb dieser Name.
const OC_AGENT = 'build'

// Welcher Key gehört zu welchem Provider? tmux vererbt die Umgebung NICHT — was der
// Agent braucht, muss über cc-start --env in die Session gereicht werden.
const PROVIDER_KEYS = {
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  'opencode-zen': ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
}

/**
 * Ist ein eigener Schlüssel überhaupt nötig? opencode bringt für DeepSeek und für die
 * freien Zen-Modelle eigenen Zugang mit — dort ohne Schlüssel zu warnen, wäre ein
 * Fehlalarm (nachgemessen: beide Läufe gingen ohne durch). hermes dagegen verlangt für
 * jeden Provider Zugangsdaten und bricht sonst mit "No usable credentials" ab.
 */
function keyNoetig(harness, provider) {
  if (harness === 'opencode') return provider === 'openrouter'
  return true
}

/**
 * Modell-/Provider-Argumente für die gewählte Harness.
 * Ohne Provider (Bestand) geht 'model' wortwörtlich raus wie bisher.
 */
export function harnessModelArgs(run) {
  const args = []
  const fehlt = []
  if (!run.model) return { args, fehlt }

  // claude spricht nur über das Abo: kein Provider, aber sehr wohl ein Modell
  // (Alias wie 'opus' oder volle Kennung wie 'claude-opus-5').
  if (run.harness === 'claude') {
    args.push('--model', run.model)
    if (run.effort) args.push('--effort', run.effort)
    return { args, fehlt }
  }

  // cursor spricht wie claude nur über sein Abo: kein Provider, kein --effort. Die
  // Modell-ID trägt die Denk-Stufe schon in sich ('claude-opus-5-xhigh'), und sie geht
  // wortwörtlich raus — genau so, wie 'cursor-agent models' sie ausgegeben hat.
  // Ein 'effort' am Lauf wäre hier ein Widerspruch; cc-start lehnt ihn ohnehin ab.
  if (run.harness === 'cursor') {
    args.push('--model', run.model)
    return { args, fehlt }
  }

  if (!run.provider) {
    args.push('--model', run.model)
    return { args, fehlt }
  }

  if (run.harness === 'opencode') {
    args.push('--model', `${OC_PREFIX[run.provider]}/${run.model}`)
  } else if (run.harness === 'hermes') {
    // hermes trennt beides: Modell bare bzw. author/slug, Provider als eigenes Argument.
    args.push('--model', run.model, '--provider', run.provider)
    if (run.effort) args.push('--effort', run.effort)   // cc-start übersetzt das nach --reasoning
  }

  for (const name of PROVIDER_KEYS[run.provider] ?? []) {
    if (process.env[name]) args.push('--env', `${name}=${process.env[name]}`)
  }
  if (keyNoetig(run.harness, run.provider) && !(PROVIDER_KEYS[run.provider] ?? []).some(n => process.env[n])) {
    fehlt.push(run.provider)
  }

  // opencode nimmt beides über EINE zusammengeführte Konfiguration entgegen
  // (OPENCODE_CONFIG_CONTENT); globale Plugins und MCP-Server bleiben dabei erhalten.
  if (run.harness === 'opencode') {
    const cfg = {}
    // Serving-Provider festnageln.
    if (run.or_provider && run.provider === 'openrouter') {
      cfg.provider = { openrouter: { models: { [run.model]: { options: {
        provider: { order: [run.or_provider], allow_fallbacks: false },
      } } } } }
    }
    // Denk-Aufwand: '--variant' gibt es nur bei 'opencode run', cc-start startet aber
    // die TUI. Der Weg dorthin ist agent.<default>.variant — und der wirkt NUR, wenn
    // im selben Block auch das Modell steht (nachgemessen: --model allein reicht nicht).
    if (run.effort) {
      cfg.agent = { [OC_AGENT]: { model: `${OC_PREFIX[run.provider]}/${run.model}`, variant: run.effort } }
    }
    if (Object.keys(cfg).length) args.push('--env', 'OPENCODE_CONFIG_CONTENT=' + JSON.stringify(cfg))
  }
  return { args, fehlt }
}

/**
 * Startet einen vorbereiteten Lauf: Worktree, Prompt, cc-start.
 * Liefert { ok, session?, error? }.
 */
export async function launchRun(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) throw new Error(`Run ${runId} nicht gefunden`)
  const repo = getRepo(run.repo_id)
  const agent = run.agent_id ? db.prepare('SELECT * FROM agents WHERE id = ?').get(run.agent_id) : null
  const kurz = kurzid(runId)
  const runDir = join(RUNS_DIR, runId)
  mkdirSync(runDir, { recursive: true })

  let workdir = repo.path
  let branchExpected = null
  try {
    if (run.branch_mode === 'neu' || run.branch_mode === 'fest') {
      branchExpected = expandPattern(run.branch_pattern, { ...run, agent_name: agent?.name, id: runId })
    }
    // Jeder Lauf arbeitet in einem eigenen Worktree — auch bei Erwartung "keiner"
    // (dann detached HEAD; Wegwerf-Änderungen; Planung 4.0).
    workdir = await makeWorktree(repo, run, branchExpected)
  } catch (err) {
    failRun(runId, `Start fehlgeschlagen:\n\n${err.message}`)
    return { ok: false, error: err.message }
  }

  const mainSha = await sh('git', ['-C', repo.path, 'rev-parse', 'HEAD'])
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]))
  const branchRule = run.branch_mode === 'neu'
    ? `Lege einen neuen Branch an, Name nach dem Muster ${branchExpected}.`
    : run.branch_mode === 'fest'
      ? `Arbeite auf dem bestehenden Branch ${branchExpected}.`
      : 'Kein Branch — der Worktree ist detached; Änderungen sind Wegwerf-Änderungen.'
  const fullPrompt = [run.prompt, run.prompt_extra?.trim(),
    skillPromptZusatz(run.skills),
    platformSuffix({ ...run, id: runId, workdir_effective: workdir }, branchRule, settings).trim()]
    .filter(Boolean).join('\n\n')
  writeFileSync(join(runDir, 'prompt.md'), fullPrompt, { mode: 0o600 })

  const q = claudeQuota()
  const credits = await openrouterCredits()
  db.prepare(`UPDATE runs SET status='running', workdir_effective=?, worktree=?, branch_expected=?,
              main_sha_start=?, quota5_start=?, quota7_start=? WHERE id=?`)
    .run(workdir, workdir !== repo.path ? workdir : null, branchExpected,
      mainSha.ok ? mainSha.stdout.trim() : null, q.five, q.seven, runId)
  addEvent(runId, 'started', { workdir, harness: run.harness, model: run.model,
    provider: run.provider ?? null, effort: run.effort ?? null })

  const args = ['--harness', run.harness,
    '--name', (agent?.name ?? 'einzel').toLowerCase().replaceAll(/[^a-z0-9_-]/g, '-'),
    '--id', kurz,
    '--env', `CC_RUN_ID=${runId}`,
    '--env', 'CC_HUB_URL=http://127.0.0.1:' + (process.env.CCHUB_LOCAL_PORT ?? '8791'),
    '--log', join(runDir, 'log.txt'), '--keep',
    '-f', join(runDir, 'prompt.md'), workdir]
  const modelArgs = harnessModelArgs(run)
  args.unshift(...modelArgs.args)
  if (modelArgs.fehlt.length) {
    // Lieber starten und es sichtbar festhalten, als kommentarlos ins Messer laufen:
    // ohne Key stirbt der Lauf sonst erst beim ersten API-Aufruf des Agenten.
    addEvent(runId, 'warn', { fehlender_key: modelArgs.fehlt.join(', ') })
  }
  if (run.harness === 'claude') args.unshift('--session-id', runId, '--settings', claudeSettingsJson())

  const r = await sh(process.env.CCHUB_CC_START ?? `${homedir()}/.local/bin/cc-start`, args, { timeout: 120_000 })
  const m = r.stdout.match(/Session '([^']+)' gestartet/)
  const session = m ? m[1] : null
  if (!r.ok || !session) {
    failRun(runId, `Start fehlgeschlagen (cc-start):\n\n${r.stderr || r.stdout}`)
    return { ok: false, error: r.stderr || r.stdout }
  }
  db.prepare('UPDATE runs SET tmux_session=? WHERE id=?').run(session, runId)
  addEvent(runId, 'tmux_started', { session })
  return { ok: true, session }
}

export function failRun(runId, text) {
  db.prepare(`UPDATE runs SET status='failed', ended_at=datetime('now'), report_md=? WHERE id=?`)
    .run(text, runId)
  addEvent(runId, 'failed', {})
}
