# cc-hub

[English](README.md) · [中文](README.zh-CN.md) · **Deutsch**

**Eine Weboberfläche, die deine Coding-Agenten für dich laufen lässt — geplant,
unbeaufsichtigt und von außen beobachtet.** Claude Code, opencode, hermes und
cursor-agent arbeiten jeweils in einem eigenen Git-Worktree in einer eigenen
tmux-Session; cc-hub startet sie, beobachtet sie, sammelt ihre Reports, merged
ihre Arbeit und meldet sich per Telegram, wenn etwas dich braucht.

> ### 🤖 Aufsetzen? Lass es deinen Agenten machen.
> Du benutzt ohnehin schon einen Coding-Agenten. Zeig ihm
> **[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md)** — eine Anleitung, die *für*
> Agenten geschrieben ist: Sie erklärt das System, fragt dich die Handvoll
> Werte, die sie nicht raten kann, und installiert es.
> *"Lies SETUP_WITH_AGENT.md und richte mir das ein."*
> (Das Dokument ist englisch — Projektsprache.)

```
Browser --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux-Sessions
(über WireGuard)   vpn-proxy.mjs           server/hub.mjs      cc-<name>-<id>
                   cchub-vpn.service       cchub.service       cc-oc-/he-/cu-…
                   └──── beide laufen aus dem Deploy-Checkout ────┘
                         (~/agents/deploy/cc-hub, siehe unten)
```

## Wofür du das willst

Dein Coding-Agent funktioniert gut, solange du davor sitzt. cc-hub ist für die
Zeit, in der du das nicht tust:

- **Aufgabe hinlegen und weggehen.** Jeder Lauf bekommt einen eigenen Worktree
  und eine eigene tmux-Session, also kommen sich Läufe nie in die Quere — und du
  kannst dich später auf jeden davon aufschalten und den ganzen Bildschirm lesen.
- **Arbeit planen.** „Jede Nacht um 2 die offenen Issues durchsehen." Ein *Agent*
  ist eine gespeicherte Laufdefinition plus Name und Zeitplan; ein *Einzellauf*
  ist dasselbe Formular ohne diese beiden.
- **Wissen, wenn es schiefging — auch wenn der Agent es nicht mehr sagen kann.**
  Ein Agent im Rate Limit kann nichts mehr melden, also beobachtet der Hub von
  außen: tmux-Zustand, Logs, Transcripts, Hooks, Provider-Puls.
- **Ein fertiger Lauf heißt: die Arbeit ist auf `main`.** Der Hub merged auf
  Wunsch selbst, prüft die Behauptung des Laufs, bevor er sie glaubt, und
  schickt den noch lebenden Agenten zurück, um Fehlendes nachzuliefern.
- **Ein Ort für vier CLIs.** Welche Coding-Agenten der Hub fahren darf und
  welche Modell-Provider jeder davon nutzen darf, ist eine Einstellung — keine
  Codeänderung.

## Was drin ist

- **Coding-Agenten als Plugins** — claude, opencode, hermes, cursor. In der
  Oberfläche konfiguriert (Einstellungen → Coding agents); der Hinzufügen-Dialog
  erkennt installierte CLIs. Neue Coding-Agenten und Provider sind einzelne
  Dateien ([docs/plugins.md](docs/plugins.md)).
- **Agenten und Einzelläufe** aus einem Formular: Coding-Agent, Modell,
  Reasoning-Stufe, Prompt, Repo, Branch-Regel, Zeitplan. Ein **Quick-Run**-Knopf
  auf jeder Seite startet einen Lauf aus einem gespeicherten Favoriten mit zwei
  Feldern.
- **Terminal im Browser** (xterm.js über WebSocket, standardmäßig read-only) —
  zuschauen, hineintippen, einen Hilferuf beantworten.
- **Reports** über `cc-report` (done / failed / help / progress / branch / pr),
  mit `inbox.jsonl` als Rückfallebene, wenn der Hub nicht erreichbar ist.
- **Integration**: Der Hub merged fertige Läufe selbst in den Basis-Branch,
  seriell pro Repo, in einem eigenen Worktree — ein dreckiger Worktree, ein
  Konflikt oder ein roter Merge-Check eskalieren erst an den Agenten und erst
  dann an dich.
- **Incidents**: Rate Limits und Provider-Ausfälle werden über mehrere
  unabhängige Kanäle erkannt und einmal gemeldet, nicht fünfmal.
- **Subscription-Verbrauch** — Claudes 5-Stunden- und 7-Tage-Fenster, Cursors
  Ausgaben im laufenden Zyklus, OpenRouter-Guthaben — in der Seitenleiste jeder
  Seite, plus ein **Budget-Gate**, das geplante Starts zurückstellt, bevor sie
  in ein leeres Kontingent laufen — und nur das, was das Fenster wirklich
  betrifft: Claudes allgemeine Woche bremst jeden Lauf, eine modellbezogene
  Woche nur die Läufe auf diesem Modell. Dieselbe Seitenleiste zeigt, was alle
  tmux-Sessions der Maschine an Speicher kosten, alle acht Minuten neu gemessen:
  Eine Session überlebt ihren Agenten absichtlich — diese Rechnung läuft leise
  mit.
- **No-Code-Flows**: ein grafischer Designer für das, was nach einem Lauf
  passiert — laufenden Agenten eine Nachricht schicken, Folgeläufe starten und
  auf sie warten, per LLM strukturierte Daten aus einem Report ziehen,
  verzweigen, über Listen laufen, Telegram, HTTP, Shell-Kommando
  ([server/flows/AGENTS.md](server/flows/AGENTS.md)).
- **Telegram**-Benachrichtigungen mit Link direkt auf den Lauf.
- **Mehrsprachige Oberfläche**: English (Standard), 中文, Deutsch —
  Einstellungen → UI language.

## Sicherheitsmodell — bitte diesen Abschnitt lesen

Der Hub kann tmux steuern. **Das ist Shell-Zugriff.** Deshalb:

- `server/hub.mjs` bindet **fest an `127.0.0.1`**; es gibt keinen direkten Weg
  aus dem Netz.
- Davor sitzt `vpn-proxy.mjs` (TLS) und bindet **ausschließlich an die eigene
  WireGuard-Adresse**. `CCHUB_VPN_BIND` ist Pflicht — es gibt bewusst keinen
  Default. **WireGuard ist die Auth-Schicht; cc-hub hat keinen eigenen Login.**
- Host-Allowlist + Origin-Prüfung (`CCHUB_ALLOWED_HOSTS`) sind der Zaun gegen
  DNS-Rebinding und CSRF; `Sec-Fetch-Site: cross-site` wird abgewiesen.
- **Fail-closed**: `cchub-vpn.service` startet nach einem Reboot bewusst *nicht*
  von selbst (`cchub on` schaltet den Zugang frei), und
  `setup/04-firewall.sh` erlaubt den VPN-Port nur auf `wg0` und verbietet ihn
  überall sonst.

**Betreibe den Hub in einem erreichbaren Netz niemals ohne diese Schichten.**

## Installation

Voraussetzungen: Linux mit systemd (User-Units), Node.js ≥ 22 (`node:sqlite`),
tmux, git, jq, curl, ein WireGuard-Interface und mindestens ein Agenten-CLI
(`claude`, `opencode`, `hermes`, `cursor-agent`) im `PATH`. Zertifikate z. B.
mit [mkcert](https://github.com/FiloSottile/mkcert).

```bash
./setup/01-npm-install.sh       # node-pty, ws, xterm.js — für DIESEN Checkout (Tests, Entwicklung)
./setup/02-install-scripts.sh   # cc-start/-attach/-kill/-help/-report + cchub + cchub-deploy → ~/.local/bin
./setup/03-install-services.sh  # ~/.config/cc-hub/env (aus env.example) + systemd-Units
sudo ./setup/04-firewall.sh     # ufw: VPN-Port nur auf wg0 (einmalig)
```

Danach mindestens `CCHUB_VPN_BIND` und `CCHUB_ALLOWED_HOSTS` in
`~/.config/cc-hub/env` setzen (siehe [`env.example`](env.example)), die
Zertifikate hinlegen und die erste Version live bringen:

```bash
cchub-deploy --init --from "$PWD"   # klont nach ~/agents/deploy/cc-hub und deployt
cchub status                        # Hub-Prozess, VPN-Zugang, Pipeline, Sessions, deployte Sha
cchub on                            # VPN-Proxy starten → über WireGuard erreichbar
```

**Das Erste in der Oberfläche:** unter **Einstellungen → Coding agents** deine
Coding-Agenten anlegen — auf einer frischen Installation weist ein Banner auf
jeder Seite darauf hin. Eine optionale Seed-Datei
`~/.config/cc-hub/coding-agents.json` füllt das beim ersten Start vor; genau das
macht ein geskriptetes Setup reproduzierbar.

> Erreichbarkeit **von einem VPN-Client aus** prüfen, niemals mit `curl` auf dem
> Server selbst: Diese Anfrage läuft über `lo` und sagt nichts über deine
> Firewall.

### Eine Version live bringen

Die systemd-Units starten `~/agents/deploy/cc-hub` — ein Klon, der allein dem
Hub gehört und immer detached auf einem Commit steht. Der Checkout, in dem du
arbeitest, betreibt nie einen Dienst; unfertige Arbeit kann also nie ausgeliefert
werden.

```bash
cchub deploy            # fetch, origin/main auschecken, Abhängigkeiten (nur wenn das Lockfile
                        # sich bewegt hat), cc-*-Skripte neu installieren, Neustart,
                        # Health-Check — Rollback, wenn er fehlschlägt
cchub deploy <ref>      # stattdessen diesen Commit
cchub-deploy --status   # deployte Sha, Origin-Sha, wie weit zurück
cchub-deploy --rollback # zurück auf den zuvor deployten Commit
```

Ein fehlgeschlagenes Deploy rollt auf den laufenden Commit zurück und meldet das
per Telegram. Die laufende Sha steht in der Seitenleiste jeder Seite — „ist meine
Änderung live?" ist damit ein Blick. `cchub restart` bleibt, was es sagt: ein
Neustart, ohne Deploy.

## Tests

```bash
node test/unit.mjs          # reine Logik (Cron, Zeitpläne, Budget-Gate, Parser, Registries, i18n, Docs) — ~1 s
node test/e2e.mjs           # kompletter Hub im Sandkasten, Stub statt echter Agenten — ~40 s
node test/e2e.mjs --echt    # zusätzlich EIN echter Lauf pro Harness (verbraucht Kontingent)
node test/browser.mjs       # public/hub.js in echtem Chromium — ~10 s (braucht playwright)
node test/proxy.mjs         # vpn-proxy.mjs gegen einen Stub-Upstream — <1 s
node test/deploy.mjs        # bin/cchub-deploy gegen ein bare origin — ~3 s
```

Die e2e-Suite startet einen zweiten Hub auf einem freien Port mit eigener
Datenbank, eigenem Test-Repo und eigenem `cc-start`-Stub — sie fasst weder
Produktivdaten noch fremde tmux-Sessions an und darf deshalb neben einem
laufenden Hub laufen.

## Mach es zu deinem

cc-hub ist der Arbeitsablauf eines Betreibers, in Code gegossen, veröffentlicht
weil er dir vielleicht einen Monat spart. **Forke es, ändere es, reiß Teile
raus.** Die Nähte, an denen gezogen werden soll: Harness- und Provider-Plugins,
der Plattform-Prompt-Zusatz, Repo-Prompts, opt-in-Zusatzskills in
`~/agents/zusaetze/` und die No-Code-Flows. Die Tabelle steht in
[SETUP_WITH_AGENT.md](SETUP_WITH_AGENT.md).

## Mitmachen

**Pull Requests sind sehr willkommen** — Fehlerberichte, Plugin-Dateien für
weitere Coding-Agenten oder Provider, Übersetzungen, Doku-Korrekturen. Die
Grundregeln und die Checkliste vor dem Absenden stehen in
[CONTRIBUTING.md](CONTRIBUTING.md).

Entwicklerwissen — Architekturentscheidungen, Eigenheiten der einzelnen
Harnesses und eine lange Liste von Fallen, die schon jemanden einen Nachmittag
gekostet haben — steht in [AGENTS.md](AGENTS.md), geschrieben für Menschen
**und** Coding-Agenten.

## Lizenz

[CC BY 4.0](LICENSE) — nutzen, ändern, kommerziell einsetzen. Nur mit
Namensnennung: **Herbert Walde** nennen, auf
<https://github.com/hwalde/cc-hub> verlinken, die Lizenz verlinken und angeben,
ob du etwas geändert hast.
