# Escalations: the contract for an external resolver

A supervisor run hands a problem it cannot solve inside the hub (credentials,
credit, a service on the machine, a system elsewhere) to somebody outside it.
The hub only keeps the list. Whoever collects it — another machine, a script, a
human — is the **external resolver**; this page is what it writes against. The
implementation is `server/escalations.mjs`.

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
  parameter it cannot take (`by` missing or not a name, an outcome outside the
  list, a note over 500 characters).
- A name (`by`) is 1–64 characters of letters, digits and `. _ @ -`.
- Two resolvers claiming the same escalation: exactly one gets the 200.
- `outcome=operator` means the problem now lies with the human.
- `dismiss` is the operator's "not a problem" and is not meant for a resolver.
  The hub's escalations page resolves and dismisses through routes of its own,
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

## Reaching the hub

The hub listens on 127.0.0.1 only. `bin/fl-api` serves a resolver that can run
commands on the hub's machine (for example over SSH):

```
fl-api --raw /api/escalations state=open
fl-api --raw -X POST /api/escalations/12/claim by=resolver-1
fl-api --raw -X POST /api/escalations/12/resolve outcome=solved note="Token rotated."
```

Its exit codes: `0` an HTTP 2xx, `1` an HTTP error (the body is still printed;
`--status` prints the code to stderr), `3` the hub could not be reached. Exit 3
is how a resolver tells "the hub is down" from "nothing to do". A resolver on
another machine goes through the TLS proxy and sees HTTP status codes only.

## When the operator is told

With `supervision_escalation_grace_minutes` at 0 (the default) the operator is
told on the urgent route when an escalation is raised. The timed announcements
— an escalation unclaimed past a grace above 0, a claimed one not resolved
within 24 hours, each once — come with the hub's supervision clock, which this
version does not run yet. A run whose notifications are muted is announced on
no channel.
