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

> **Running agents in a sandbox has landed.** It is optional and off by
> default; the reference is **[docs/sandbox.md](docs/sandbox.md)**, the design
> study behind it is **[SANDBOX_RESEARCH.md](SANDBOX_RESEARCH.md)**, and what
> arrived is written down in [CHANGELOG.md](CHANGELOG.md). One piece of it is
> deliberately unfinished and is big enough to stand here.
>
> **Credentials that never enter the container has landed too**, and it used to
> stand on this page as "built, and never run against the real thing". It has
> now met the binary: a profile saying `secrets: inject` holds a placeholder in
> the container while the egress proxy swaps the real credential in on the way
> out, and that was measured rather than reasoned about. So was the sentence
> under it that said an enforced allowlist needs a rootful daemon — it does not
> any more; the proxy is itself a container. Both are in the changelog. The two
> limits that remain are permanent rather than pending, and live in
> [docs/sandbox.md](docs/sandbox.md): a credential the client *signs* with
> (AWS SigV4, any HMAC scheme) can never be injected by something sitting in
> front of it, and a coding agent whose plugin cannot name the header carrying
> its key needs the environment-variable mode and says so.

### A sandbox for machines that cannot have Docker

**Status: named, not built.** Today the sandbox is a container, and Docker (or
Podman) is a prerequisite for it. Podman is implemented with its own
user-namespace mapping, and untried — no podman is installed here. **gVisor is
implemented and has never had a daemon to run on**: no machine here has `runsc`
registered, so all that could be established is that asking for a runtime the
daemon does not know fails at `docker run` with *"unknown or invalid runtime
name"* rather than silently falling back. If your daemon does have gVisor
registered, you are the first. What does not exist is the
"light" mode the design study names — a process-level sandbox with no container
runtime at all, for a laptop or a locked-down host where installing a daemon is
not an option. The spec already accepts the value and the hub refuses it with a
sentence saying so.

### Not planned: looking at what the agent sends

Stated here because it is the thing people most often assume a sandbox does.
Freilauf's network policy decides on the **hostname** and inspects no content —
no request bodies, no paths, no responses. So an allowed host is a way out for
anything the agent wants to put there, and content inspection or data-loss
prevention is **out of scope**, now and as a direction. It is a different
product, and a boundary that pretended to do it badly would be worse than one
that says it does not. [docs/sandbox.md](docs/sandbox.md) has the rest of that
list, in more detail than most people will want.

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
