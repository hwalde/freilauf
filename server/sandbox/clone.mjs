// Freilauf — the working copy of a SANDBOXED run (SANDBOX_RESEARCH.md §7.4).
//
// WHY a clone and not the linked worktree every other run gets: a linked
// worktree's `.git` is a pointer INTO the operator's checkout — `HEAD`, `index`
// and `logs/HEAD` live under `<repo.path>/.git/worktrees/<name>/`, everything
// shared (`objects/`, `refs/`, `config`, `hooks/`) one level up — so even
// `git add` needs `<repo.path>/.git` writable, and a container that had it
// writable would have the operator's hooks (commands the HOST runs later), the
// operator's `config` (`core.fsmonitor`, `diff.external` — more commands), the
// operator's refs (`update-ref refs/heads/main`, which `pushOperatorBase()`
// would then push) and the shared object store in the hands of an agent the
// sandbox exists because we do not trust. A private clone with the operator's
// objects borrowed READ-ONLY through `objects/info/alternates` gives the agent a
// repository that is entirely its own and costs no disk.
//
// Everything else is `makeWorktree()`'s contract, deliberately: the same target
// directory, the same three branch modes, the same reuse-on-retry, the same
// `applyExtras()`, the same readable failures — the rest of the hub must not be
// able to tell a clone from a worktree by looking at it. The one thing it MUST
// be able to tell is where a run's commits are, and that is what
// `collectRunTip()` answers.

import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import db, { getRepo } from '../db.mjs'
import { WORKTREES_DIR, kurzid, sh } from '../util.mjs'
import { t } from '../i18n.mjs'

/** A run whose working copy is a private clone rather than a linked worktree. */
export function isClone(run) {
  return run?.worktree_kind === 'clone'
}

/** The ref a collected clone tip is parked under in the operator's repository. */
export function runTipRef(runId) {
  return `refs/freilauf/runs/${runId}`
}

/**
 * The directory a run's working copy lives in — the same name a linked worktree
 * would get, because the rest of the hub reads `runs.workdir_effective` and
 * never asks how the directory came about.
 */
export function cloneDir(repo, run, branchName) {
  return join(WORKTREES_DIR, repo.name,
    `${kurzid(run.id)}-${(branchName || 'detached').replace(/\//g, '-')}`)
}

/** `<repo.path>/.git`, resolved — a repo may itself be a worktree or use a `.git` file. */
async function sourceGitDir(repoPath) {
  const r = await sh('git', ['-C', repoPath, 'rev-parse', '--git-common-dir'])
  const raw = r.ok ? r.stdout.trim() : ''
  return raw ? resolve(repoPath, raw) : join(repoPath, '.git')
}

/** Does this ref exist in that repository? */
async function hasRef(dir, ref) {
  return (await sh('git', ['-C', dir, 'show-ref', '--verify', '--quiet', ref])).ok
}

/**
 * The sibling of `makeWorktree()` in runner.mjs, for `runs.sandbox = 1`.
 *
 * Returns `{ dir, branch, baseSha }`. It also records `runs.worktree_kind =
 * 'clone'` on the row (and on the passed-in object), because that column is the
 * ONE thing that tells the integrator a tip still has to be collected — leaving
 * it to the caller would make a forgotten line a run whose work silently never
 * reaches the base branch.
 */
export async function makeSandboxClone(repo, run, opts = {}) {
  const branchName = opts.branch ?? run.branch_expected ?? null
  const detached = run.branch_mode === 'keiner' || !branchName
  const base = repo.base_branch || 'main'
  const target = cloneDir(repo, run, detached ? null : branchName)

  mkdirSync(join(WORKTREES_DIR, repo.name), { recursive: true })
  // Same reason as in makeWorktree(): `origin/<base>` has to mean today's
  // origin/<base>, and the clone borrows its objects — so the fetch that makes
  // them exist happens in the SOURCE, once, before anything is cloned.
  await sh('git', ['-C', repo.path, 'fetch', 'origin'], { timeout: 120_000 })

  // Retry of a failed run: the clone from before is still there. Reuse it as it
  // stands — exactly what makeWorktree() does, and for the same reason: the
  // interrupted half of the work is still what the run wants merged.
  if (existsSync(target)) {
    markClone(run, target)
    return { dir: target, branch: detached ? null : branchName, baseSha: await headOf(target) }
  }

  // "A branch belongs to exactly one worktree" is git's rule for worktrees and
  // git cannot enforce it across clones — so the hub keeps enforcing it by
  // policy, with the same check and the same sentence the worktree path uses.
  if (!detached) {
    const { branchWorktree } = await import('../runner.mjs')
    const occupied = await branchWorktree(repo.path, branchName)
    if (occupied) throw new Error(t('run.branch_in_use', { branch: branchName, worktree: occupied }))
  }

  const objects = join(await sourceGitDir(repo.path), 'objects')
  const steps = [
    // A placeholder initial branch: whatever we check out below replaces it, and
    // an unborn branch leaves no ref behind. `-c init.defaultBranch` rather than
    // `init -b` so this also works on a git that predates that flag.
    ['git', ['-c', 'init.defaultBranch=freilauf-init', 'init', '-q', target]],
    ['git', ['-C', target, 'remote', 'add', 'origin', repo.path]],
    // origin/<x> in the clone means origin/<x> everywhere else — the platform
    // prompt tells every agent `git fetch origin && git merge origin/<base>`.
    ['git', ['-C', target, 'config', 'remote.origin.fetch', '+refs/remotes/origin/*:refs/remotes/origin/*']],
    // …and the operator's LOCAL branches arrive under local/*, which is what
    // "existing branch" mode needs: that branch may exist only on this machine.
    ['git', ['-C', target, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/local/*']],
  ]
  try {
    for (const [bin, args] of steps) {
      const r = await sh(bin, args)
      if (!r.ok) throw new Error(r.stderr.trim() || `${bin} ${args.join(' ')}`)
    }
    // Borrow the operator's objects read-only. `git init` already made
    // objects/info; the mkdir is for a git that did not.
    mkdirSync(join(target, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(target, '.git', 'objects', 'info', 'alternates'), `${objects}\n`)

    // Cheap: everything the source already has is in the alternate, so this
    // transfers refs and almost no objects.
    const fetched = await sh('git', ['-C', target, 'fetch', '-q', 'origin'], { timeout: 300_000 })
    if (!fetched.ok) throw new Error(fetched.stderr.trim() || 'fetch origin')

    // The one thing a clone does NOT inherit that a linked worktree does: the
    // committer identity out of the shared config. An agent that cannot commit
    // cannot deliver, so these two keys travel — and deliberately nothing else
    // of the operator's config, which is the whole point of §7.4.1.
    for (const key of ['user.name', 'user.email']) {
      const v = await sh('git', ['-C', repo.path, 'config', '--get', key])
      if (v.ok && v.stdout.trim()) await sh('git', ['-C', target, 'config', key, v.stdout.trim()])
    }

    const start = await startPoint(target, base, detached ? null : branchName)
    const r = detached
      ? await sh('git', ['-C', target, 'checkout', '-q', '--detach', start])
      : await sh('git', ['-C', target, 'checkout', '-q', '-b', branchName, start])
    if (!r.ok) throw new Error(r.stderr.trim() || `checkout ${start}`)
  } catch (err) {
    // A half-built clone is worse than none: the next retry would find the
    // directory standing and reuse a repository with no HEAD.
    try { rmSync(target, { recursive: true, force: true }) } catch { /* best effort */ }
    throw new Error(t('sandbox.clone.failed', { err: String(err.message ?? err).trim() }))
  }

  const { applyExtras } = await import('../runner.mjs')
  applyExtras(repo, target)
  markClone(run, target)
  return { dir: target, branch: detached ? null : branchName, baseSha: await headOf(target) }
}

/**
 * Where a checkout starts from, in makeWorktree()'s order: the operator's own
 * local branch first (that is what "existing branch" means), then the same name
 * on origin (a branch that so far only exists there must not be re-based onto
 * the base branch — the first push would bounce off as non-fast-forward), then
 * the base branch.
 *
 * `local/<base>` at the end is the one case the worktree path cannot have: a
 * source repository with no `origin` of its own has no `origin/<base>` for
 * anything to start from, and the clone can still see its branches.
 */
async function startPoint(target, base, branchName) {
  if (branchName) {
    if (await hasRef(target, `refs/remotes/local/${branchName}`)) return `local/${branchName}`
    if (await hasRef(target, `refs/remotes/origin/${branchName}`)) return `origin/${branchName}`
  }
  if (await hasRef(target, `refs/remotes/origin/${base}`)) return `origin/${base}`
  return `local/${base}`
}

async function headOf(dir) {
  const r = await sh('git', ['-C', dir, 'rev-parse', 'HEAD'])
  return r.ok ? r.stdout.trim() : null
}

function markClone(run, dir) {
  run.worktree_kind = 'clone'
  if (dir) run.workdir_effective ??= dir
  try { db.prepare(`UPDATE runs SET worktree_kind='clone' WHERE id=?`).run(run.id) } catch { /* a run row is not required to exist */ }
}

/**
 * The tip the integrator should merge — and, for a clone, the step that makes it
 * reachable from the operator's repository at all (§7.4.3).
 *
 * A linked worktree shares the operator's object store, so its HEAD is already
 * there and this is a plain `rev-parse`: the no-op is the point, because it lets
 * `tipOf()` call this unconditionally and one function hides the difference. A
 * clone's new objects live in the clone, so one fetch copies them over and parks
 * the commit under `refs/freilauf/runs/<id>`; everything after — the merge-tree
 * dry run, the merge in the integration worktree, the merge check, the push, the
 * backup branch, a conflict run — is unchanged.
 *
 * This local fetch runs `git-upload-pack` INSIDE a repository the agent
 * controls, and it is the one host-side git operation on agent-controlled data
 * the design keeps. **It was measured** [git 2.43.0, §11a.1]: against a clone
 * carrying `core.fsmonitor`, `core.sshCommand`, `core.alternateRefsCommand`,
 * `core.pager`, `core.editor`, `uploadpack.packObjectsHook` and `diff.external`
 * all set to a marker command, plus twelve executable hooks, six variants of
 * this fetch fired **nothing at all** — `uploadpack.packObjectsHook` is honoured
 * only in PROTECTED configuration, and git's own manual says why. So the bundle
 * variant §7.4.3 offers is not needed, and only this function would change if
 * that ever stopped being true.
 *
 * `GIT_CONFIG_NOSYSTEM=1` and `-c uploadpack.allowAnySHA1InWant=false` changed
 * nothing in that measurement and stay as documentation of intent — a reader
 * should not have to rediscover which scopes were considered. What they are NOT
 * is a boundary; the boundary here is that the command runs in the SOURCE
 * repository, which is the operator's.
 *
 * Returns the sha as a string, or null — `tipOf()`'s existing shape.
 */
export async function collectRunTip(run) {
  const dir = run?.workdir_effective
  if (!dir || !existsSync(dir)) return null
  if (!isClone(run)) return headOf(dir)

  const repo = getRepo(run.repo_id)
  if (!repo?.path) return headOf(dir)

  // The branch when the run has one, HEAD when it works detached — both name the
  // same commit, and a named branch makes the fetch readable in a reflog.
  const src = run.branch_expected ? `refs/heads/${run.branch_expected}` : 'HEAD'
  const ref = runTipRef(run.id)
  const r = await sh('git', [
    '-C', repo.path,
    '-c', 'uploadpack.allowAnySHA1InWant=false',
    'fetch', '-q', '--no-tags', dir, `+${src}:${ref}`,
  ], { timeout: 300_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  if (!r.ok) {
    // Fail soft in the direction that says LESS: the caller's next question is
    // "is this tip mergeable", and answering it against a commit the operator's
    // repository cannot see would be a merge that fails halfway.
    return null
  }
  const sha = await sh('git', ['-C', repo.path, 'rev-parse', ref])
  return sha.ok ? sha.stdout.trim() : null
}

/**
 * Remove a run's clone and the ref its tip was parked under. Safe to call twice
 * (both halves are "make it gone", not "undo something"), and it REFUSES a
 * directory that is not under the hub's worktrees root — a path check rather
 * than trust, because `workdir_effective` is a column and an `rm -rf` of the
 * wrong string is not a mistake one recovers from.
 *
 * `git worktree remove` is deliberately not involved: a clone was never
 * registered as a worktree, and `worktree prune` never sees it.
 */
export async function removeClone(run) {
  const repo = run?.repo_id != null ? getRepo(run.repo_id) : null
  const dir = run?.workdir_effective
  let removed = false
  let error = null

  if (dir) {
    if (!insideWorktreesRoot(dir)) {
      error = t('sandbox.clone.outside_root', { dir, root: WORKTREES_DIR })
    } else if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); removed = true } catch (err) { error = String(err.message ?? err) }
    }
  }
  // The ref goes even when the directory did not: it is a leftover in the
  // OPERATOR's repository, and nothing else ever deletes it.
  if (repo?.path && run?.id) await sh('git', ['-C', repo.path, 'update-ref', '-d', runTipRef(run.id)])
  return { ok: !error, removed, error }
}

// ---------------------------------------------------------------------------
// Masking a `.git/config` — the one generator, used in two places
// ---------------------------------------------------------------------------

/**
 * §7.4.2 mounts the operator's `.git` read-only into the container and masks its
 * `config`, because a remote URL may carry a token and `core.fsmonitor`,
 * `core.sshCommand` and `diff.external` are commands. The design said "an empty
 * file", and **that is wrong** [measured, 11a.2]: on a `--object-format=sha256`
 * repository whose config was emptied, `git log` says "your current branch
 * appears to be broken" and — the dangerous one — `git ls-remote` answered
 * **exit 0 with an all-zero sha**. A wrong answer that exits 0 is the same trap
 * `--no-optional-locks` already has an entry in AGENTS.md for.
 *
 * `core.repositoryformatversion` and the `[extensions]` block are what tell git
 * what the repository IS; without them git reads it as something else. So the
 * mask is not an absence, it is a minimal REPLACEMENT, and this is the one
 * function that builds it — the container mount and the host rescue path
 * (exec.mjs) must not have two ideas of what "masked" means.
 *
 * What it keeps, and nothing else:
 *   - `core.repositoryformatversion` and every `extensions.*` — the format;
 *   - the handful of `core.*` flags that describe the FILESYSTEM rather than a
 *     command (`bare`, `filemode`, `symlinks`, `ignorecase`, `logallrefupdates`,
 *     `precomposeunicode`);
 *   - `user.name` / `user.email` only when the caller asks (`keepIdentity`),
 *     because a rescue `git commit` on a masked clone would otherwise die with
 *     "please tell me who you are".
 *
 * Everything else goes: `remote.*` (the token), `core.fsmonitor`,
 * `core.sshCommand`, `core.pager`, `core.editor`, `core.alternateRefsCommand`,
 * `diff.*`, `filter.*`, `merge.*`, `uploadpack.*` — every one of which can name
 * a command.
 *
 * Known limit, stated rather than hidden: a **partial clone** declares
 * `extensions.partialClone = origin` and needs `remote.origin.*` to fill a blob
 * in. The extension is kept (so git still knows what the repository is) and the
 * promisor remote is not, so such a fetch fails LOUDLY. That is the direction
 * this whole function exists for.
 */
const MASK_CORE_KEYS = new Set([
  'core.repositoryformatversion', 'core.bare', 'core.filemode', 'core.symlinks',
  'core.ignorecase', 'core.logallrefupdates', 'core.precomposeunicode',
])

export async function maskedGitConfigEntries(configPath, { keepIdentity = false } = {}) {
  // `--list -z` rather than plain `--list`: entries are NUL-separated and key
  // and value are split by the FIRST newline, so a value containing a newline
  // (which a hostile config may well have) cannot forge an extra entry.
  const r = await sh('git', ['config', '--file', configPath, '--list', '-z'])
  const out = []
  if (!r.ok) return out
  for (const entry of r.stdout.split('\0')) {
    if (!entry) continue
    const nl = entry.indexOf('\n')
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase()
    const value = nl < 0 ? 'true' : entry.slice(nl + 1)     // a valueless key is `true`
    const keep = MASK_CORE_KEYS.has(key)
      || key.startsWith('extensions.')
      || (keepIdentity && (key === 'user.name' || key === 'user.email'))
    if (keep) out.push([key, value])
  }
  // A repository whose config says nothing about its format is format 0, and
  // saying so explicitly is what keeps the mask a complete statement.
  if (!out.some(([k]) => k === 'core.repositoryformatversion')) {
    out.unshift(['core.repositoryformatversion', '0'])
  }
  return out
}

/**
 * Write that minimal config to `targetPath`. The entries are written **by git
 * itself** (`git config --file`), never by string concatenation: quoting a
 * config value correctly is git's job, and a hand-rolled writer is one escaped
 * backslash away from turning a value into a section header.
 */
export async function writeMaskedGitConfig(sourceConfigPath, targetPath, opts = {}) {
  const entries = await maskedGitConfigEntries(sourceConfigPath, opts)
  mkdirSync(join(targetPath, '..'), { recursive: true })
  writeFileSync(targetPath, '', { mode: 0o644 })
  for (const [key, value] of entries) {
    const r = await sh('git', ['config', '--file', targetPath, key, value])
    // A key git refuses to write back is a key that cannot have come from a
    // real config; skipping it is right, failing the mask over it is not.
    if (!r.ok) continue
  }
  return entries
}

/**
 * Is this path really inside `~/agents/worktrees`? Both sides are resolved
 * through realpath where they exist, so a symlinked home still matches and a
 * clone directory that IS a symlink pointing somewhere else does not.
 */
export function insideWorktreesRoot(dir) {
  if (!dir) return false
  const real = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
  const root = real(WORKTREES_DIR)
  const target = real(dir)
  if (target === root) return false          // the root itself is never "a clone"
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}
