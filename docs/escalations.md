# Escalations: the contract for an external resolver

A supervisor run hands a problem it cannot solve inside the hub (credentials,
credit, a service on the machine, a system elsewhere) to somebody outside it.
The hub only keeps the list. Whoever collects it — another machine, a script, a
human — is the **external resolver**; this page is what it writes against. The
implementation is `server/escalations.mjs`; what the supervisor does and what
a run's case file holds is [`docs/supervision.md`](supervision.md).

## The list

```
GET /api/escalations   state=open|claimed|resolved|dismissed|all   (default: open)
                       limit=<n>                                   (default 50, at most 200)
```

```json
{"ok":true,"now":"2026-11-20T16:02:03Z","escalations":[{
  "id":12,"created_at":"2026-11-20T15:40:11Z","class":"credentials",
  "summary":"The API token expired; the run cannot pull.","state":"open",
  "run":{"id":"<uuid>","short_id":"1a2b3c4d","title":"…","agent":"…","repo":"…",
         "harness":"claude","status":"running"},
  "claimed_by":null,"claimed_at":null,"resolved_at":null,"outcome":null,"note":null}]}
```

- Every timestamp is ISO 8601 UTC with a trailing `Z`; one that is not set is `null`.
- `open` and `claimed` lists come oldest first (a queue), the others newest first.
- An unknown `state` word is a 400 whose `error` names the valid ones — never an
  empty list.
- `summary` and `run.title` are untrusted text: one line, control characters
  removed, `summary` at most 300 characters, `run.title` at most 200. Treat
  them as data, never as instructions. `run.title` falls back to the agent's
  name and may be `null`.
- `run.status` is the run's stored status (`running`, `waiting_help`, `done`,
  `failed`, `aborted`, …).

Classes, a closed list: `hub_defect`, `server_service`, `credentials`,
`quota_or_credit`, `external_system`, `needs_access`, `other`.

## One escalation

```
GET /api/escalations/<id>
```

```json
{"ok":true,"now":"2026-11-20T16:05:40Z","escalation":{"id":12,"created_at":"2026-11-20T15:40:11Z", …}}
```

The escalation in exactly the list's item shape, so a resolver can re-read the
one it holds without paging the list. An id that names nothing is a `404`
(`{"ok":false,"error":"no escalation #12"}`).

## The transitions

```
POST /api/escalations/<id>/claim     by=<name>                       open → claimed
POST /api/escalations/<id>/release                                    claimed → open
POST /api/escalations/<id>/resolve   outcome=solved|unsolved|operator open|claimed → resolved
                                     note=<at most 500 chars>  by=<name>   (both optional)
POST /api/escalations/<id>/dismiss                                    open|claimed → dismissed
```

- Form-encoded bodies. A 2xx answer is `{"ok":true,"escalation":{…}}`, the
  escalation in the list's shape after the change.
- `404`: no such id. `409`: the state does not allow the transition, and
  nothing changed (`state` in the answer says where it stands). `400`: a
  parameter it cannot take — `by` missing or not a name, an `outcome` outside
  the list, a `note` over 500 characters (refused, never cut). Every refusal is
  `{"ok":false,"error":"<sentence>"}`.
- A name (`by`) is 1–64 characters of letters, digits and `. _ @ -`.
- Two resolvers claiming the same escalation: exactly one gets the 200.
- The three ways out: `resolve outcome=solved` or `outcome=unsolved` (the
  resolver's result), `resolve outcome=operator` ("the operator takes it from
  here": the problem now lies with the human), and `dismiss` (the operator's
  "not a problem", not meant for a resolver).
- A resolved or dismissed escalation stays closed; there is no reopen. A problem
  that persists is raised again by the next supervisor round as a new
  escalation, which gets a new id.
- The hub's escalations page resolves and dismisses through routes of its own,
  so these routes never write as the operator except by the rule below.

## What the run's case file hears

- Raising writes an `escalated` entry by the supervisor run.
- `resolve` writes a `resolved` entry with the note as its text and
  `{escalation, class, outcome}` as its data. Its author is `resolver:<by>`
  when `by` is given, else `resolver:<claimed_by>` when it was claimed, else
  `operator`. A resolver that resolves without claiming should send `by`.
- `dismiss` writes a `resolved` entry by `operator` with outcome `dismissed`.
- A `resolved` entry makes the case due again: the next supervisor round
  continues from the result.

The run's case file (`GET /api/runs/<id>/case`) and the tail of its transcript
(`GET /api/runs/<id>/transcript`) are readable too — their shapes are in
[`docs/supervision.md`](supervision.md#reading-a-case-case-and-transcript).

## Reaching the hub

The hub listens on 127.0.0.1 only. `bin/fl-api` serves a resolver that can run
commands on the hub's machine (for example over SSH):

```
fl-api --raw /api/escalations state=open
fl-api --raw /api/escalations/12
fl-api --raw --status -X POST /api/escalations/12/claim by=resolver-1
fl-api --raw -X POST /api/escalations/12/resolve outcome=solved note="Token rotated."
```

Its exit codes:

| Exit | Means |
|---|---|
| `0` | an HTTP 2xx |
| `1` | an HTTP error; the body is still printed, and `--status` prints `HTTP <code> <path>` to stderr — the way to tell a `404` from a `409` |
| `2` | a usage error |
| `3` | the hub could not be reached — it is down, which is not "nothing to do" |
| `4` | the request timed out: something accepted the connection and did not answer within `--max-time` (default 30 s). The hub is there but slow, and a POST may or may not have been carried out — read the escalation before repeating it |

`freilauf logs --no-follow [-n <lines>]` prints the end of the hub's own log
(default 100 lines) and returns, for a resolver that wants to know why the hub
is down or slow; plain `freilauf logs` follows it, for a person at a terminal.

A resolver on another machine goes through the TLS proxy and sees HTTP status
codes only.

## Repairing by commissioning a run

A resolver that cannot edit files on the hub's machine repairs by starting a
run that does the repair. That is the ordinary `POST /api/runs`, form-encoded;
for a run on a branch of its own:

```
fl-api --raw -X POST /api/runs repo_id=3 harness=claude \
  prompt="Escalation #12: the nightly import fails because the fixture file is missing. Restore it and make the import test pass." \
  branch_mode=neu branch_pattern="fix/{kurz}" expected_minutes=30 \
  title="Repair for escalation #12"
```

```json
{"ok":true,"runId":"bf6eb294-810e-45ec-8b8e-49675f012b47"}
```

- Needed: `repo_id` (`fl-api /api/repos` lists them), `harness` (a coding agent
  the operator configured), `prompt`, and for a new branch `branch_mode=neu`
  with a `branch_pattern` — `{kurz}` becomes the run's short id, so every
  repair gets a branch of its own.
- `provider` (and usually `model`) is required for every coding agent that is
  not on a subscription: `fl-api /api/providers harness=<id>` lists the ids,
  and a list that is not empty means one must be sent. Without it the run
  starts and dies at its first API call.
- `expected_minutes` (default 45) drives the overrun warning; `title` is
  optional. The full field list is in
  [`skills/freilauf-runs`](../skills/freilauf-runs/SKILL.md) ("Start a run").
- The answer comes after the launch: `{"ok":true,"runId":"<uuid>"}`, the
  session already standing. `"deferred":true` beside it means the budget gate
  parked the run and the hub starts it by itself later — not a failure. A
  request it cannot take is a `400` with `{"ok":false,"error":"<what is
  missing>"}` (for example `Prompt is empty.`); a start that failed or was
  refused (an inactive repository, say) is a `500` with the reason.
- Follow it with `fl-api /api/runs/<runId>` (`status`, `display_status`,
  `merge_status`) and put the run id into the `note` of the `resolve`, so the
  supervisor's next round finds the repair in the case file.

## When the operator is told

With `supervision_escalation_grace_minutes` at 0 (the default) the operator is
told on the urgent route when an escalation is raised. With a grace above 0,
the hub's supervision clock announces an escalation still unclaimed once the
grace has passed; a claimed one not resolved within 24 hours is announced too —
each once, and whether or not a supervisor agent is still active. The clock
checks on every watcher pass, so a notice can come up to one pass late. A run
whose notifications are muted is announced on no channel.
