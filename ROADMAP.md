# Roadmap

What is planned for Freilauf, and where to say what you would like to see next.

**This list is deliberately incomplete.** Freilauf is deployed from `main`
whenever something lands, and most of what gets built is not big enough to
announce in advance — a form that learns a field, a plugin, a pitfall turned
into a guard rail. Those simply appear, and
[CHANGELOG.md](CHANGELOG.md) is where they are written down. What stands here
is the other kind: the few changes large enough that it is worth telling you
about them before they exist, so you can plan around them, argue with them, or
help build them.

So: things not on this page are still coming, and things on this page carry no
date. There are no releases and therefore no milestones — an item is
*researched*, *being built*, or *landed*, and when it lands it moves to the
changelog.

## Planned

### Running agents in a sandbox

**Status: designed, nothing implemented.** The design study is in this
repository: **[SANDBOX_RESEARCH.md](SANDBOX_RESEARCH.md)**.

Today a Freilauf run starts its coding agent unattended — `--permission-mode
dontAsk`, `--auto`, `--yolo`, `--force` — as the operator's own user, on the
operator's own machine. That is the whole point of the hub, and it is also the
reason a company will not switch it on: nobody wants to approve every shell
command by hand, and nobody wants an agent that need not ask for anything to be
standing in their home directory either.

The plan is to let a run's agent work inside a boundary that was configured
*before* it started — optionally, per repository as the default, and per agent
or single run as an override in either direction. What the design study
recommends, in short:

- **A container around the agent, tmux on the host.** The pane command becomes a
  `docker run …` around the agent's own command line, so everything the hub
  already does with tmux — the log pipe, the pane-died hook, typed messages,
  the browser terminal, `fl-attach`, `fl-kill` — keeps working unchanged, and
  it works for *every* coding agent, including ones that arrive as a plugin.
- **A working copy the agent may have.** A sandboxed run gets a clone of its
  own instead of a linked worktree, because a linked worktree would mean handing
  the container the operator's `.git` read-write. The integrator collects the
  result with a `git fetch` and merges it the way it merges everything else.
- **A network policy that lives outside the container** — open, none, or an
  allowlist — enforced by an egress proxy, so a blocked host is a readable
  refusal rather than a hang, and the policy can be widened **while the agent is
  running** instead of costing you the run.
- **Filesystem, resources and secrets configurable at the same two levels**, with
  provider keys that never have to enter the container at all.
- **A way to notice when the sandbox blocked something the agent needed**, and
  three buttons to do something about it.

It is planned as phases that ship on their own and are off by default, so an
installation that wants none of this keeps behaving exactly as it does today.
The design study's §10 has the phasing, and its §11 lists the questions still to
be measured before the first line is written.

## Not on this page

Everything else. Smaller improvements, plugins for further coding agents,
model providers and notification channels, translations, and whatever the next
pitfall teaches us. If you want to know what actually changed and when, read
[CHANGELOG.md](CHANGELOG.md) — it is grouped by day, newest first.

## Wishes are welcome

**Feature requests are genuinely welcome**, and this is a small enough project
that yours can change what gets built next.

- **Open an issue:** <https://github.com/hwalde/freilauf/issues> — a feature
  request, a bug, a question, or "I tried to do X and Freilauf made it hard"
  are all worth writing down. You do not need to have a solution in mind.
- **Send a pull request:** the ground rules and the pre-submit checklist are in
  [CONTRIBUTING.md](CONTRIBUTING.md). A draft PR with a question in it is a
  perfectly good way to start.
- **Or just talk to me.** I like hearing what people do with this. Write an
  e-mail — the address is on
  [entwickler-training.de](https://entwickler-training.de) — or say hello in an
  issue. If you are considering this for a company and want help introducing
  it, consulting and training are on the same site.

## About this document

Written in English, like everything in this repository except the UI and the
three READMEs (see [AGENTS.md](AGENTS.md)). A roadmap that had to be maintained
in three languages would go stale in two of them, and a stale roadmap is worse
than none — so this one stays in one language and is linked from all three
READMEs instead.
