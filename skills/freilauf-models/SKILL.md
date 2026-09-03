---
name: freilauf-models
description: >
  Choose the coding agent, model provider, model and reasoning effort for a
  Freilauf run, agent, favorite or flow step. Use this skill whenever you are
  about to fill in a harness/provider/model/effort field for Freilauf, when
  someone asks "which model should this run use", when a run has to be cheap,
  fast, free or especially careful, or when another Freilauf skill sends you
  here — even if the words "model" or "provider" are not used.
license: CC BY 4.0
metadata:
  project: Freilauf
  source: https://github.com/hwalde/freilauf
  freilauf_role: shared
---

# Picking the model for a Freilauf run

> **Arrived here from another Freilauf skill?** Then you already have what you
> came for — read on. If you were only *pointed* at this file, read it once and
> keep it for the rest of the task; the other Freilauf skills all defer their
> model decisions to it, and there is no point loading it twice. It sits next
> to them: `../freilauf-models/SKILL.md` from any of them, and on an agent with
> slash-invocation it is `/freilauf-models`.

Freilauf never guesses a model. Every run, agent, favorite and flow step carries
four fields, and this skill decides them:

| field | what it is | who has one |
|---|---|---|
| `harness` | the **coding agent** CLI: `claude`, `opencode`, `hermes`, `cursor`, or an installed plugin | everything |
| `provider` | the **model provider** the coding agent buys tokens from | only a coding agent that is not on a subscription |
| `model` | the model identifier, exactly as the provider spells it | everything |
| `effort` | the reasoning level | only where the CLI accepts one |

**Ask this installation before you decide anything.** The recommendations
further down are advice; what is actually configured on this machine is a fact,
and the two disagree regularly.

## Step 1 — the operator's favorites are the first answer

A **favorite** is exactly this half of a run definition, saved under a name by
the person who owns this hub. It is their considered answer to "what do I
normally run with", so it outranks every recommendation in this file.

```bash
fl-api /api/favorites
```

```jsonc
{ "ok": true, "max": 3,
  "favorites": [
    { "id": 1, "name": "Nightly", "harness": "opencode", "provider": "deepseek",
      "model": "deepseek-v4-flash", "effort": "high",
      "or_provider": null, "or_routing": null,
      "skills": "[\"unlazy:3\"]", "flows": null,
      "summary": "opencode · deepseek-v4-flash · effort high · unlazy (depth 3)" } ] }
```

Rules:

- **If a favorite fits the task, use it and say which one** ("started with your
  favorite *Nightly*"). Do not silently improve on it.
- Favorites are the *setup* only. They carry no prompt, no branch rule, no
  duration — those still belong to the task.
- There are at most three. If none fits, say so in one sentence and pick from
  the recommendations below.

## Step 2 — what this machine can actually run

A recommendation for a coding agent that is not installed, or a provider with no
credential, is a run that fails at its first API call. Check:

The Freilauf skills for runs, agents and flows ship a tool that prints all of
this, and validates a combination before you post it:

```bash
<skill-dir>/scripts/fl-options.py coding-agents   # which are configured here
<skill-dir>/scripts/fl-options.py agent opencode  # its providers, models, effort levels
<skill-dir>/scripts/fl-options.py check harness=opencode provider=deepseek model=... effort=...
```

The raw endpoints, if you would rather ask directly:

```bash
fl-api /api/coding-agents/detect          # which CLIs exist, which are configured
fl-api /api/providers harness=opencode    # the providers THIS coding agent may use
fl-api /api/models provider=deepseek harness=opencode
fl-api /api/effort harness=claude provider= model=opus
```

`/api/providers` answers `subscription: true` for `claude` and `cursor` — those
two run on the account that is logged in and take **no** `provider` at all.
Their model list comes from the harness itself, so ask for it with the harness
id in the `provider` parameter (`/api/models provider=cursor`).
`/api/effort` answers `{ok: false, error: …}` when the field does not apply —
`stufen` is only present in the `ok: true` answer.

## Step 3 — the recommendations

Ordered by what they are for, not by price. Every one of them is a *default*,
not a menu: pick the first row that matches the task and move on.

### Free, for anything routine

| | |
|---|---|
| harness | `opencode` |
| provider | `opencode-zen` |
| model | `Big Pickle` (as `/api/models` spells it — copy the id from there) |
| effort | whatever `/api/effort` offers; leave empty if it offers nothing |

Costs nothing. Use it for routine work, for anything repetitive, and whenever
you are about to run something several times. OpenCode Zen's free pool rotates
through 429/500/503 constantly — a 5xx from it means "try later", not "broken".

### Excellent price/performance, for real development work

| model | harness / provider | effort | when |
|---|---|---|---|
| `z-ai/glm-5.3-flash` | `opencode` / `openrouter` | `high` | software development, very strong for the money |
| `google/gemini-3.8-flash` | `opencode` / `openrouter` | `medium`, `high` for hard work | a step smarter than glm-5.3-flash, and dearer |
| `deepseek/deepseek-v4-flash-0731` | `opencode` / `openrouter` | `high` | workhorse: simple tasks and plenty of development work |
| `deepseek-v4-flash` | `opencode` / `deepseek` | `high` | the same workhorse bought directly from DeepSeek |

**The levels differ per model — ask, do not assume.**
`fl-api /api/effort harness=opencode provider=<provider> model=<id>` answers for
the exact combination. Measured on this installation on 2026-09-03: both DeepSeek
rows and `z-ai/glm-5.3-flash` offer `low, high, max` and **no `medium`**, while
`google/gemini-3.8-flash` offers `low, medium, high` and no `max`. For opencode
the levels come straight out of the models.dev catalog
(`reasoning.supported_efforts`, `server/providers/openrouter.mjs`) — nothing maps
one name onto another, so a `medium` sent to a model that has none is discarded
in silence and the run reasons at the model's default.

**For the three OpenRouter rows: pin the quantization.** OpenRouter serves one
model from many serving providers whose quantization differs by a factor of
four in effective precision, under the same model name — a stronger-quantized
host silently makes the model worse. Set the serving-provider mode to `auto`
with a minimum quantization of `fp8` (a *lower* bound: fp8 and everything above
it qualifies):

- run form / agent form / favorite: `or_mode=auto`, `or_quant=fp8`
- flow step `start_single_run`: `orMode=auto`, `orQuant=fp8`

This is only passed through for **opencode** runs; hermes has no per-run
provider routing, and the form says so.

### On the Claude subscription

Only when the operator has a Claude Code subscription (`/api/coding-agents/detect`
shows `claude` configured). No `provider` field.

| model | effort | when |
|---|---|---|
| `opus` | `high` | very good development work, when it has to be Claude Code |
| `sonnet` | `medium` | simple tasks. **Never `max` on sonnet** — at that price opus is the better buy |
| `fable` | `high` | extremely critical work only: a complex plan, an architecture decision |

**`fable` needs the operator's explicit confirmation before you start it.** It
is expensive and it eats the weekly quota fast, which then blocks *every other*
claude run on this hub (Freilauf defers a start at 95 % of the binding window).
It also does not work on the Claude **Pro** plan at all — only through extra
usage, and only if that is switched on. So: ask, name the cost, and start it
only after a yes.

### cursor

`cursor` takes **no** `effort` field: the level is part of the model id
(`…-low`, `…-medium`, `…-high`, `…-xhigh`, `…-max`), and `…-fast` is the more
expensive fast mode. Use only an id that `/api/models provider=cursor` printed
verbatim — cursor rejects anything assembled by hand, and its documented
bracket syntax (`model[effort=high]`) is model-dependent and unreliable.

## The mistakes that cost the most

- **Sending a `provider` to claude or cursor.** They are subscription harnesses;
  the form refuses it and so does the API.
- **Inventing a model id.** opencode reports an unknown model as
  `UnknownError: Unexpected server error` — byte for byte what a real provider
  outage looks like. Always copy the id from `/api/models`.
- **Leaving an OpenRouter model unpinned** and then wondering why quality moved.
- **Picking `fable` or `opus` for a small job.** The weekly window is shared by
  every claude run on this hub; burning it on a docs fix defers somebody's
  build.
- **Reaching for a reasoning level the model does not have.** `/api/effort`
  answers per combination; an unknown level is silently discarded by opencode
  and silently ignored by hermes.

## Cost and budget, in one paragraph

Freilauf meters what it can: claude and cursor against their subscription
windows, OpenRouter and DeepSeek against the account balance. A start that
would run into an exhausted budget is **deferred**, not failed, and picked up
again when the window refills. `fl-api /api/usage` shows every window and
balance the hub can see. If a run comes back `deferred`, that is the gate — do
not retry it in a loop; either wait, or ask the operator whether to force it.
