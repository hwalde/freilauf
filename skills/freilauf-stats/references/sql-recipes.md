# Cross-run statistics: read-only SQL

Read this when the question spans more than one run — spend over a week, runs
per outcome, the slowest agents, which incidents keep coming back. The hub has
no page and no API route for any of that; the database is the only source.

## Opening it safely

The path resolves through `bin/fl-paths.sh` (installed to `~/.local/bin`),
because an installation migrated from the old name may still keep its data
under the old directory or the old file name:

```bash
source ~/.local/bin/fl-paths.sh
DB="$(fl_db_file)"
```

**The hub is writing to this file while you read it.** It runs in WAL mode with
`busy_timeout = 5000`, so a reader does not block it — but only if the reader
really is a reader:

```bash
sqlite3 -readonly "$DB" "SELECT count(*) FROM runs;"
```

If `sqlite3` is not on the machine, use `node:sqlite` — the same zero-dependency
binding the hub itself uses (there is no `better-sqlite3` in this tree), and it
takes a read-only flag:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1],{readOnly:true});
console.log(db.prepare('SELECT status, count(*) n FROM runs GROUP BY status').all())" "$DB"
```

Rules:

- **Read only.** Never `UPDATE`, `INSERT` or `DELETE` here. Every write in this
  system goes through a POST route that validates; a second write path is a
  second set of rules to keep in step, and a hand-written `UPDATE runs` bypasses
  `addEvent()` — the pages would silently stop agreeing with the database.
- Use `-readonly` (or `file:$DB?mode=ro`) so a typo cannot become a write.
- `-header -column` or `-json` make the output readable.
- Timestamps are **UTC text**, `YYYY-MM-DD HH:MM:SS`, comparable with
  `datetime('now', '-7 days')`.

## The columns worth knowing

`runs` — one row per run, definition copy included (a run shows what it really
started with, whatever the agent was edited to later):

| column | note |
|---|---|
| `id` | uuid; `substr(id,1,8)` is the short id the UI shows |
| `title` | every run has one; agent name, typed title, or a prompt-derived fallback |
| `repo_id`, `agent_id` | `agent_id` is NULL for a single run, and is NULLed when the agent is deleted |
| `status` | `scheduled` `deferred` `running` `waiting_help` `done` `failed` `aborted` (CHECK) |
| `harness`, `model`, `provider`, `effort` | no CHECK on `harness` |
| `started_at`, `ended_at`, `last_activity_at` | UTC text |
| `expected_minutes` | read live by the watcher's thresholds |
| `quota5_start`/`_end`, `quota7_start`/`_end` | percent; `quota7_*` is the **binding** weekly window for that run |
| `cost_eur` | claude only, the subscription delta (see below) |
| `cost_usd` | real API spend where the harness reports one |
| `tokens_in`, `tokens_out`, `rate_limit_hits` | default 0 |
| `archived_at` | NULL = visible in the overview |
| `finish_state`, `merge_status`, `merged_sha`, `merge_attempts` | the integrator |
| `followup_since`, `followups`, `followup_open` | follow-up commissions |
| `resolves_run_id` | non-NULL = this is a conflict run, not work anybody asked for |
| `telegram_on` | 0 = no message about this run on any channel |

`cost_eur = max(0, quota7_end − quota7_start) / 100 / 4.348 × abo_price`, with
`abo_price` from `settings` (default 200). It is an estimate against a
subscription, not money that moved, and it is written once by
`finishCostsPass()` in the watcher — a run in a terminal status with
`quota7_end IS NULL` has not been costed yet.

`events (id, run_id, ts, kind, payload)` — append-only. `payload` is a JSON
string or NULL; `json_extract(payload,'$.field')` reads it. An anomaly that was
retracted is **renamed** to `cleared:anomaly:…`, never deleted.

`incidents (id, run_id, typ, quelle, schwere, erst_gesehen, zuletzt_gesehen,
anzahl, beleg, geloest_am, geloest_von, wieder_geoeffnet, notify_at,
gemeldet_am)` — one row per (run, type), reopened on recurrence.
`run_id IS NULL` = a **global** incident. `geloest_am IS NULL` = open.
`schwere` is `'gelb'` or `'rot'`.

## Verified queries

All of these parse against the current schema. Run them with
`sqlite3 -readonly -header -column "$DB" "<query>"`.

**Spend per repo, last 7 days**

```sql
SELECT p.name AS repo, count(*) AS runs,
       round(sum(COALESCE(r.cost_eur,0)),2) AS eur,
       round(sum(COALESCE(r.cost_usd,0)),4) AS usd
  FROM runs r JOIN repos p ON p.id = r.repo_id
 WHERE r.ended_at >= datetime('now','-7 days')
 GROUP BY p.name ORDER BY eur DESC;
```

**Runs per outcome, last 7 days**

```sql
SELECT status, count(*) AS n FROM runs
 WHERE COALESCE(ended_at, started_at) >= datetime('now','-7 days')
 GROUP BY status ORDER BY n DESC;
```

**The slowest runs, against what was expected**

```sql
SELECT substr(id,1,8) AS short_id, title, harness, model, expected_minutes,
       round((julianday(ended_at)-julianday(started_at))*1440) AS minutes
  FROM runs WHERE ended_at IS NOT NULL
 ORDER BY minutes DESC LIMIT 10;
```

**Work in flight, all repos**

```sql
SELECT p.name AS repo, r.status, count(*) AS n
  FROM runs r JOIN repos p ON p.id = r.repo_id
 WHERE r.archived_at IS NULL
   AND r.status IN ('running','waiting_help','scheduled','deferred')
 GROUP BY p.name, r.status;
```

(The sidebar additionally counts finished runs with `followup_since IS NOT NULL`
under `running` — add that arm to match it exactly.)

**Why runs were deferred, most recent first**

```sql
SELECT substr(run_id,1,8) AS short_id, ts,
       json_extract(payload,'$.reason')    AS reason,
       json_extract(payload,'$.resets_at') AS resets_at
  FROM events WHERE kind='deferred' ORDER BY id DESC LIMIT 10;
```

**Anomalies of the last week** (already excludes retracted ones — they are
renamed to `cleared:anomaly:…`)

```sql
SELECT kind, count(*) AS n FROM events
 WHERE kind LIKE 'anomaly:%' AND ts >= datetime('now','-7 days')
 GROUP BY kind ORDER BY n DESC;
```

**Open incidents by type and severity**

```sql
SELECT typ, schwere, count(*) AS n FROM incidents
 WHERE geloest_am IS NULL GROUP BY typ, schwere ORDER BY n DESC;
```

**What each claude run cost of the weekly window**

```sql
SELECT substr(id,1,8) AS short_id, model, quota7_start, quota7_end,
       round(quota7_end - quota7_start, 2) AS pct_points, cost_eur
  FROM runs WHERE harness='claude' AND quota7_end IS NOT NULL
 ORDER BY pct_points DESC LIMIT 10;
```

**Token hogs of the last week**

```sql
SELECT substr(id,1,8) AS short_id, harness, model,
       tokens_in, tokens_out, rate_limit_hits, cost_usd
  FROM runs WHERE started_at >= datetime('now','-7 days')
 ORDER BY (COALESCE(tokens_in,0)+COALESCE(tokens_out,0)) DESC LIMIT 10;
```

## Caveats when reporting the result

- A running run's `quota7_end`, `cost_eur` and `cost_usd` are still NULL. Sums
  therefore describe **finished** work; say so.
- `cost_eur` and `cost_usd` are not the same currency and not the same kind of
  number (a subscription delta versus real API spend). Never add them together.
- A conflict run (`resolves_run_id IS NOT NULL`) is the integrator's tool, not
  work the operator asked for. Exclude it when counting "runs I started".
- Archived runs are still in the table. `archived_at IS NULL` is what the
  overview shows.
