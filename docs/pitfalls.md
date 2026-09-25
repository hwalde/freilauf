# Measured traps in the tools we drive

Behaviour of tmux, git, docker, the browser and the agent CLIs that the code
cannot show and that hurt when unknown. One line each, grouped by tool; the
version measured is named where it matters. The generic ones that bite on any
change are in `AGENTS.md`.

## tmux (3.4)

- Pane targets need the colon: `-t '=name:'` for `pipe-pane`, `set-hook`,
  `capture-pane`, `display -p`; the bare form answers empty or "can't find
  pane". `tmux display -p -t '=name'` exits 0 for a session that does not
  exist — use `has-session`.
- "No server" and "I could not answer" share an exit code; only the stderr
  tells them apart (`tmuxVerdict()`).
- A dead pane sometimes records neither exit status nor signal nor death
  time, permanently (about one in six); a missing exit code is not a `0`. A
  pane killed by a signal has an empty `pane_dead_status` and a filled
  `pane_dead_signal`; a shell reports its child's signal death as `128+n`.
- `session_activity` moves on attach/select, not on output; `window_activity`
  is the activity signal.
- `attach -r` is `-f read-only,ignore-size`, and `ignore-size` does nothing
  while `window-size` is `latest`: every attached client rewraps the agent's
  window.
- A bracketed paste plus Enter lands on the screen before the hub writes the
  event; a test that captures the pane and reads events in the same breath
  races itself.
- With `mouse on` a drag is a mouse report handled by tmux's copy-mode; the
  copied text reaches the client as OSC 52 with an empty target field. A
  terminal mode written into xterm from the client is undone by tmux's next
  redraw; set modes in the pane.

## git (2.43)

- `--no-optional-locks` goes before the subcommand; after it, git rejects it
  and returns an empty status.
- A branch belongs to exactly one worktree; `worktree add` refuses the base
  branch the main checkout holds, and `--force` would leave the agent's
  commits as reverse modifications in that checkout.
- `merge-tree --write-tree --name-only origin/base tip` is a dry run: exit 1
  on conflict, the paths on stdout, no worktree touched.
- A `.gitignore` rule with a trailing slash does not match a symlink; write it
  without the slash for linked worktree extras.
- `git push` touches no working tree; `merge`/`checkout`/`reset` in the
  operator's checkout lose work.
- An emptied `.git/config` on a sha256 repository makes `ls-remote` answer
  exit 0 with an all-zero sha; mask a config with a minimal replacement, never
  an empty file. A denylist of config keys is not a boundary: a
  `filter.<n>.clean` driver selected by a tracked `.gitattributes` still runs.
## Docker (29)

- `--tmpfs` options are added to the defaults (`noexec,nodev`), not
  substituted; write `exec` out.
- `network inspect --format '{{.Gateway}}'` prints the literal `invalid IP`
  for an isolated network; read the JSON. `gateway_mode_ipv4=isolated` is
  `--internal`-only.
- A `-v` source path that does not exist becomes a directory, so a socket
  mount that was never created is a directory named like a socket.
- `docker exec -u <name>` needs an account the image has; use numeric ids.
- Docker 29 no longer says `Cannot connect to the Docker daemon`; classify on
  exit status and socket presence, print the message.
- `aa-status --enabled` exits 0 as any user and says nothing about
  confinement; read the daemon's `SecurityOptions`.
- Under a rootless daemon a container cannot reach the host on any network
  and `host-gateway` may resolve to a stale bridge; a proxy in the hub process
  cannot serve it.
- No image may set `XDG_*_HOME`, `CLAUDE_CONFIG_DIR`, `CURSOR_DATA_DIR` or
  `HERMES_HOME`: XDG outranks `HOME` for opencode and the CLI's state lands
  where the hub does not read.
## claude (Claude Code 2.1.x)

- Hook settings are `{ matcher?, hooks: [{ type, command }] }` lists per
  event; a bare command list makes claude drop the whole settings file and
  hang at a dialog.
- `StopFailure` exists but claude does not wait for it: the hook must detach
  (`setsid -f`). `SessionEnd` is awaited.
- A bracketed paste over 800 characters becomes a `[Pasted text #n]`
  placeholder, never parsed as a slash command; type the command word, paste
  the argument.
- `--resume <id>` without a prompt waits for input in every permission mode;
  with a prompt it continues.
- `--session-id <id>` refuses an id whose transcript exists ("Session ID … is
  already in use") and exits; renaming `<id>.jsonl` is enough to reuse it.
- Claude rewrites transcripts it is not working in, in batches: a file's mtime
  is not the agent's activity; read the newest record's timestamp.
- Background subagent completions arrive as `<task-notification>` user
  messages and fire `UserPromptSubmit`; `SubagentStop` fires with the main
  session's id.
- `--json-schema` is a forced tool call the model may decline; fall back to
  `result`.
- The transcript is written ~20 ms after the Stop hook runs.
- The usage endpoint sends `null` for windows the account lacks and
  rate-limits the caller; `Number(null)` is 0.

## opencode (1.18.x)

- `--prompt` past ~2 KB is not submitted by itself and past ~4 KB the session
  is never created; the launcher nudges Enter and offloads a long task to a
  file.
- `--session <id> --prompt` and `--continue --prompt` drop the prompt in the
  TUI; paste the continuation after the status bar shows `ctrl+p`.
  `--continue` is scoped to the project, never to a worktree — a resume must
  not rely on it.
- `--auto` auto-rejects `external_directory`; every path outside the worktree
  needs an explicit allow, and a blocked run looks like a hung provider.
- An unknown model answers `UnknownError: Unexpected server error`, byte for
  byte an outage; check the id against `opencode models --pure` first.
  Zen `*-free` models rotate through 429/500/503.
- The task tool opens a child session per subagent in the same directory;
  "the newest session here" is usually a finished subagent.
- An unknown reasoning variant is discarded silently; the variant only works
  in the same config block as the model.

## cursor (cursor-agent)

- `-p` prints and exits; the prompt goes as a positional after `--`; without
  `--trust` the session hangs at the trust dialog.
- Hooks are `{ version, hooks: { <event>: [{ command }] } }` (flat lists —
  claude's nesting is silently ignored); no hook for API errors; no pulse
  endpoint.
- The TUI stays at "Add a follow-up" forever; the end is the `stop` hook or
  `turn_ended` in the transcript.
- The bracket syntax `model[effort=…]` is model-dependent; only a flat id from
  `cursor-agent models` is reliable; effort is part of the id.
- Cursor reads `CLAUDE.md`, `.claude/skills`, `.claude/agents`, settings and
  hooks; there is no local switch.
- The status line `⠠⠛ Globbing  555 tokens` matches `\b5\d\d\b`; an HTTP
  status counts only next to an error word.
- The dashboard usage endpoint has no contract; the spending percentage is in
  the display sentences, not the numeric fields.

## hermes (0.21)

- Splits a hook command itself and runs no shell: `VAR=x cmd` is "command not
  found".
- Does not validate `--reasoning` and runs with the default on nonsense;
  swallows an unknown model silently; `post_api_request` fires only on
  success.
- `-q` on a TTY seeds an interactive session and stays; `-Q`/`--oneshot` are
  one-shot. No per-run provider routing.

## Browser and Node

- `statSync().mtimeMs` is a float and `Date.now()` an integer; a file written
  in the current millisecond sorts as "newer than now".
- A denied CONNECT socket needs its `error` listener before the DNS lookup or
  the process dies on curl's reset of the refused tunnel.
- xterm stops propagation on its own element; listeners for real drags must be
  in the capture phase, and tests must drive a real mouse.
- Under the native Fullscreen API only the fullscreen element's subtree
  renders; move the toast box inside.
- A browser opens at most six HTTP/1.1 connections per origin and an
  EventSource holds one forever; `pipe()` does not destroy an upstream whose
  destination went away.
- `confirm(${JSON.stringify(x)})` inside a `"` attribute needs HTML escaping
  after the JSON.
- An `<input hidden>` companion `0` before a checkbox is what makes "off" and
  "not on the page" different requests; `hidden` alone still submits — use
  `disabled` too.
- A skill or hermes hook that runs Python in place writes `__pycache__` into
  the installed copy.

## The log scanner

- Menu text (`Upgrade to Max for higher rate limits`), the hub's own section
  headings, a test's success lines and a source line with a quoted argument
  list all match an incident pattern when an agent working on this repository
  scrolls them through its screen.
