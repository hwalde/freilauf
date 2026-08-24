# cc-hub

Web-Oberfläche zur Verwaltung autonomer Coding-Agenten (claude / opencode / hermes / cursor).
Agenten laufen in tmux-Sessions, jeder Lauf in einem eigenen git-Worktree. Der Hub
plant, beobachtet, sammelt Berichte ein und meldet per Telegram.

> **Keine privaten Infos in dieser Datei.** Alles Maschinen- und Betreiberspezifische
> (echte Ports, VPN-Adressen, Hostnamen, Firewall-Details, Zertifikatswege) gehört in
> `CLAUDE.local.md` — gitignoriert, versioniert im privaten Schwester-Repo
> `cc-hub-private`. Claude Code lädt beide Dateien automatisch. Verweise auf
> „Planung x.y“ in Code-Kommentaren meinen das interne Planungsdokument (ebenfalls im
> Schwester-Repo, nicht Teil dieses Repos).

## Architektur

```
Browser --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux-Sessions
(via WireGuard)    vpn-proxy.mjs           server/hub.mjs      cc-<name>-<id>
                   cchub-vpn.service       cchub.service       cc-oc-/he-/cu-…

(8790/8791 sind die Code-Defaults; die echten Werte kommen aus ~/.config/cc-hub/env.)
```

- **`server/hub.mjs`** bindet fest an `127.0.0.1` — nie direkt aus dem Netz erreichbar.
  HTTP + WebSocket-Terminal + Scheduler + Watcher laufen in diesem einen Prozess.
- **`vpn-proxy.mjs`** bindet ausschließlich an die WireGuard-Adresse. Fällt die Firewall
  aus, lauscht dort trotzdem nichts nach außen. Host-Allowlist + Origin-Prüfung sind der
  Rebinding-/CSRF-Zaun (`CCHUB_ALLOWED_HOSTS` in `~/.config/cc-hub/env`).
- **systemd-User-Units**: `cchub.service` startet automatisch, `cchub-vpn.service`
  bewusst **nicht** (fail-closed). Steuerung: `cchub on|off|status|logs`.
- **Läufe** entstehen ausschließlich über `~/.local/bin/cc-start`; Agenten melden sich
  über `~/.local/bin/cc-report` zurück (HTTP an den Hub, Fallback `inbox.jsonl`).
- Zustand: SQLite unter `~/.local/share/cc-hub/cc-hub.db`, Laufdaten in `~/agents/runs`,
  Worktrees in `~/agents/worktrees`. Alle Pfade sind über `CCHUB_*`-Variablen umlegbar —
  genau davon lebt die Testsuite.

## Tests

```bash
node test/unit.mjs          # reine Logik (Cron, Zeitpläne, Quota-Gate, Parser) — ~1 s
node test/e2e.mjs           # kompletter Hub im Sandkasten, Stub statt echter Agenten — ~30 s
node test/e2e.mjs --echt    # zusätzlich EIN echter claude-Lauf (verbraucht Quota)
node test/e2e.mjs --keep    # Sandkasten stehen lassen (Fehlersuche)
```

Die E2E-Suite startet einen **zweiten Hub** auf einem freien Port mit eigener Datenbank,
eigenem Test-Repo und eigenem `cc-start`-Stub. Sie darf deshalb jederzeit im Live-Betrieb
laufen: Produktivdatenbank, `~/agents` und fremde tmux-Sessions werden nie angefasst,
und beendet werden nur die selbst erzeugten Sessions (auch bei Strg-C).
Watcher-Durchgänge stößt die Suite direkt an, statt auf den 30-Sekunden-Takt zu warten.

## Modelle, Provider und Denk-Aufwand

Nichts davon ist im Code eingetippt — alles kommt aus der jeweils maßgeblichen Quelle:

| Was | Woher | Warum nicht anders |
|---|---|---|
| Provider je Harness | `providerFuerHarness()` | claude läuft nur über das Abo; hermes braucht für Zen/DeepSeek einen Schlüssel, opencode nicht |
| Modelle für opencode | `opencode models --pure` | opencodes Providerliste ist credential-gated; der Anbieter-Katalog enthält Modelle, die hier sofort scheitern |
| Modelle für hermes | Anbieter-API bzw. `models.dev` | hermes hat keine eigene Liste |
| Modelle für claude | gepflegte Liste in `claudeModelle()` | ohne API-Schlüssel gibt es keinen Katalog; freie Eingabe bleibt immer möglich |
| Modelle für cursor | `cursor-agent models` | kontogebunden (kommt vom Server); dieselbe Liste nennt die CLI beim Ablehnen |
| Denk-Aufwand claude | `claude --effort __probe__` — die CLI nennt ihre Stufen selbst | kein Settings-Key, keine belastbare Env-Variable |
| Denk-Aufwand hermes | `hermes chat --help` ∩ Modell-Stufen | hermes prüft NICHT und läuft bei Unsinn still mit dem Default |
| Denk-Aufwand opencode | Modellkatalog (`~/.cache/opencode/models.json`) | opencode verwirft eine unbekannte Variante **kommentarlos** |
| Denk-Aufwand cursor | steckt **in der Modell-ID** (`…-low/-medium/-high/-xhigh/-max`) | cursor-agent hat kein `--effort`; das Feld bleibt im Formular aus |

Durchreichung: claude `--effort`, hermes `--reasoning` (cc-start übersetzt), opencode über
`OPENCODE_CONFIG_CONTENT` mit `agent.build.{model,variant}` — die Variante wirkt nur, wenn
im selben Block auch das Modell steht. Kontrolle: `~/.local/state/opencode/model.json`
führt die zuletzt benutzte Variante je Modell. cursor bekommt **nur** `--model` mit einer
ID, die `cursor-agent models` wörtlich ausgegeben hat — zusammengebaut wird dort nichts.

### cursor im Besonderen

Die 204 flachen IDs sind Basis × Denk-Stufe × Fast, schon ausmultipliziert. Deshalb wird
im Hub **nicht** in Basis + Effort zerlegt: eine so gebaute ID könnte es gar nicht geben,
und `<datalist>` filtert 204 Einträge genauso gut wie die ~360 von OpenRouter. IDs auf
`-fast` sind Cursors Schnellmodus (teurer) — sie stehen in der Liste hinten und sind
markiert, der Regelfall ist die Variante ohne.

**cursor liest die Claude-Konfiguration mit** — nachgemessen mit Kanarienvogel-Codewörtern
in einem leeren Repo, alle drei bestätigt:

| Quelle | Ergebnis |
|---|---|
| `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` | wird als Regeldatei geladen |
| `.claude/skills/*/SKILL.md` | wird als Skill geladen |
| `.claude/agents/*.md` | wird als Subagent registriert (echter `tool_call`, kein Dateilesen) |

Im Binary hängt das an `thirdPartyExtensibilityEnabled` (Default **an**); ebenso gelesen
werden `.claude/settings.json`, `.claude/settings.local.json`, `.claude/commands` und
Claude-**Hooks**. Einen lokalen Schalter dafür gibt es **nicht** — `allow_third_party_plugin_imports`
ist ein serverseitiges Team-/Enterprise-Feld.

Folge für cc-hub: Ein cursor-Lauf zieht sich `~/.claude/skills` und die `CLAUDE.md` des
Worktrees **automatisch** herein. Die Opt-in-Idee hinter `~/agents/zusaetze/` (bewusst
kein `.claude/skills`-Ordner) trägt bei cursor also nur halb — der Lauf sieht mehr als
seinen Prompt plus die angehakten Zusätze.

## Zusatz-Skills (opt-in)

`~/agents/zusaetze/<name>/SKILL.md` — **bewusst kein** `.claude/skills`-Ordner, sonst
lüde jede claude-Instanz sie automatisch. Jeder Ordner mit SKILL.md erscheint als
Häkchen im Agenten- und Einzellauf-Formular (`zusaetze.mjs`); bei Auswahl bekommt der
Prompt die Anweisung, die SKILL.md (voller Pfad) zu lesen und anzuwenden. Installiert
Commit-gepinnt über `setup/02-install-scripts.sh` (aktuell: `unlazy` für faule/kleine
Modelle), nicht Teil dieses Repos. Pfad-Override für Tests: `CCHUB_ZUSAETZE_DIR`.

## Vorfälle (Rate-Limit, Provider-Ausfall)

Bei einem Rate-Limit oder Provider-Ausfall kann der Agent nichts mehr melden — ohne API
kein Werkzeugaufruf. Die Erkennung läuft deshalb von außen, in drei Stufen, alle münden
in `incidents` (ein Datensatz je Lauf und Typ; lösen per Knopf, geht bei erneutem
Auftreten **wieder auf** und meldet erneut per Telegram — Autoalarm-Prinzip):

| Quelle | Harness | Sofort rot? |
|---|---|---|
| Hook `StopFailure` → `cc-report _api_error` | claude | ja (festes Enum) |
| Transkript-JSONL `isApiErrorMessage` + `error` | claude | ja (zweiter Kanal, mit Zeitstempel) |
| Plugin `session.error` → `cc-report _api_error` | opencode | ja |
| pipe-pane-Log, Muster je Harness (`detect.mjs`) | alle, für hermes und cursor die **einzige** Quelle | nein: gelb; rot bei Wiederholung binnen 10 min oder 5 min Stille danach — oder wenn das optionale Prüf-LLM (Einstellungen, OpenRouter) es bestätigt |
| Provider-Puls (Anthropic/OpenRouter/DeepSeek alle 5 min) | global | nach 2 Fehlschlägen, schließt sich bei Erholung |

cursor hat wie hermes **keinen** Hook für API-Fehler (sein Hook-Enum kennt
`beforeShellExecution`, `afterFileEdit`, `stop`, `beforeSubmitPrompt` — nichts für einen
fehlgeschlagenen Aufruf), und für `api2.cursor.sh` gibt es keinen offenen Puls-Endpunkt:
`providerVonLauf()` liefert dort bewusst `null` („nicht überwacht", nicht „gesund").
Dafür lehnt cursor ein unbekanntes Modell **laut** ab (`Cannot use this model: …`) —
anders als opencode und hermes, die Unsinn stillschweigend schlucken.

Log und Transkript werden per **Offset** gelesen (`runs.log_offset`/`transcript_offset`):
nur neue Bytes, jede Zeile zählt einmal. Jede Entscheidung steht in
`~/agents/runs/<id>/detektor.jsonl`. hermes hat **keinen** Hook für API-Fehler
(`post_api_request` feuert nur nach Erfolg).

## Fallen, die hier schon Zeit gekostet haben

- **tmux-Ziele brauchen den Doppelpunkt.** `-t "=name"` ist für `pipe-pane` und
  `set-hook` kein gültiges Ziel („can't find pane" / „no such window"); richtig ist
  `-t "=name:"`. Und `tmux display -p -t "=name"` liefert für eine **nicht existierende**
  Session Exit-Code 0 — wer damit auf „Session weg?" prüft, prüft nichts. Dafür ist
  `tmux has-session` da.
- **Das Terminal ist fail-closed, und zwar zweifach.** `/term` schaltet Schreibrechte nur
  bei explizitem `?ro=0` frei (`terminal.mjs`); fehlt der Parameter, hängt tmux mit `-r`
  an UND jede Eingabe wird verworfen. Der Client setzt `ro=0` anhand von `data-live` aus
  `pages.mjs`. Wer nur eine der beiden Seiten anfasst, bekommt ein Terminal, das
  kommentarlos nichts tut — genau so lag es lange, weil `ro=0` nirgends vorkam.
- **`tmux attach -r` ist nur die Abkürzung für `-f read-only,ignore-size`.** Und
  `ignore-size` nützt nichts, solange `window-size` auf `latest` (Default) steht: der
  Browser bricht das Fenster des Agenten beim Zuschauen auf seine Größe um — mit und ohne
  Schreibrechte gleichermaßen. Gegenmittel wäre `window-size manual` auf der Session.
- **`cc-start`-Positionsargumente.** `cc-start [name] [verzeichnis]`; ist der Name über
  `--name` gesetzt (so ruft der Hub auf), rutscht das Verzeichnis auf Platz 1. Sonst
  startet der Agent im Arbeitsverzeichnis des Aufrufers statt im Worktree.
- **Claude-Hook-Format.** Jedes Ereignis ist eine Liste aus
  `{ matcher?, hooks: [{ type, command }] }`. Eine nackte Kommandoliste lässt Claude die
  Settings-Datei **komplett** verwerfen und den Lauf an einem Dialog hängen.
- **`StopFailure` gibt es — aber Claude wartet nicht darauf.** (Claude Code 2.1.241; das
  Enum steht im Binary: `rate_limit`, `overloaded`, `server_error`, `authentication_failed`,
  `billing_error`, `model_not_found`, …) Der Prozess ist binnen 100 ms nach dem Ereignis
  weg und reißt den Hook mit; `SessionEnd` wird dagegen abgewartet. Der Hook muss deshalb
  sofort abkoppeln: `setsid -f cc-report _api_error` — die stdin-Pipe mit dem JSON erbt
  der Kindprozess. Simulieren ohne Quota: Mini-HTTP-Server, der 429 mit
  `anthropic-ratelimit-unified-status: rejected` antwortet, und `ANTHROPIC_BASE_URL`
  darauf zeigen lassen (so macht es `test/e2e.mjs`).
- **Worktree-Ergänzungen mit `mode: "link"`** legen ein Symlink an. Eine `.gitignore`-Regel
  mit Schrägstrich (`referenz/`) greift dafür **nicht** — der Worktree gilt dann dauerhaft
  als schmutzig und wird nie aufgeräumt. Regel ohne Schrägstrich schreiben.
- **Der Log-Scanner trifft Menütexte.** „Upgrade to Max for higher rate limits" aus dem
  `/`-Menü stand in einem Produktivlauf als Rate-Limit in der DB. Muster in `detect.mjs`
  sind darum eng, es gibt eine Ausnahmeliste, und ein einzelner Log-Treffer ist nur gelb.
- **`cursor-agent -p` ist für einen Lauf falsch.** `-p/--print` druckt und beendet sich —
  die tmux-Session wäre sofort weg. Der Prompt gehört als **Positionsargument** hinter
  `--` (`cursor-agent --force --trust -- "$CC_PROMPT"`); dann arbeitet die TUI den Auftrag
  ab und bleibt danach stehen, wie bei opencode.
- **Ohne `--trust` hängt cursor am Dialog** „Do you trust the contents of this directory?"
  — die Session lebt, tut aber nichts. Dasselbe Muster wie Claudes Trust-Flag, nur als
  Kommandozeilenschalter statt als Eintrag in `~/.claude.json`.
- **Cursors Bracket-Syntax ist modellabhängig und als Fundament unbrauchbar.**
  `grok-4.6[effort=high,fast=false]` läuft, aber `claude-opus-4-8[context=1m,effort=high,fast=false]`
  — das Beispiel aus Cursors **eigener** Hilfe — wird abgelehnt. Verlässlich ist nur eine
  flache ID aus `cursor-agent models`.
- **`agents.harness` trägt einen CHECK, `runs.harness` nicht.** SQLite kann einen CHECK
  nicht per ALTER ändern, und `CREATE TABLE IF NOT EXISTS` greift bei einer bestehenden
  Datenbank nicht — eine neue Harness braucht deshalb den Tabellen-Umbau in
  `harnessCheckErweitern()` (db.mjs). Der holt den Tabellenkopf aus `sqlite_master` und
  ersetzt nur die eine Stelle, damit nachgerüstete Spalten, Defaults und das UNIQUE
  sicher überleben.
- **Ein grüner Test beweist nur den Weg, den der Test genommen hat.** `curl` auf
  die VPN-IP vom Server aus läuft über `lo` und sagt nichts über die Firewall; echte
  Erreichbarkeit nur von einem VPN-Client prüfen.
