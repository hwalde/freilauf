# cc-hub

Web-Oberfläche zur Verwaltung autonomer Coding-Agenten — **claude** (Claude Code),
**opencode**, **hermes** und **cursor** (cursor-agent). Agenten laufen in
tmux-Sessions, jeder Lauf in einem eigenen git-Worktree. Der Hub plant Läufe
(Cron/Zeitpläne), beobachtet sie, sammelt Berichte ein und meldet per Telegram.

```
Browser --https--> <wg-IP>:8790 --http--> 127.0.0.1:8791 --> tmux-Sessions
(via WireGuard)    vpn-proxy.mjs           server/hub.mjs      cc-<name>-<id>
                   cchub-vpn.service       cchub.service       cc-oc-/he-/cu-…
```

## Was es kann

- **Agenten** als gespeicherte Definitionen (Harness, Modell, Denk-Aufwand, Prompt,
  Repo, Zeitplan) — geplante Läufe starten automatisch, Einzelläufe per Formular.
- **Beobachtung von außen**: tmux-Status, pipe-pane-Logs, Harness-Transkripte und
  Hooks. Rate-Limits und Provider-Ausfälle werden auch dann erkannt, wenn der Agent
  selbst nichts mehr melden kann (`server/detect.mjs`, Provider-Puls, optionales
  Prüf-LLM über OpenRouter).
- **Terminal im Browser** (xterm.js über WebSocket, standardmäßig read-only) —
  zuschauen, Text nachschieben, Hilferufe beantworten.
- **Berichte**: Agenten melden sich über `cc-report` zurück (done / failed / help /
  progress / branch / pr); Fallback `inbox.jsonl`, wenn der Hub nicht erreichbar ist.
- **Telegram**: Benachrichtigung bei Abschluss, Hilferuf, Auffälligkeit — mit Link
  auf die Detailseite (Setup-Assistent in den Einstellungen).
- **Quota-Gate**: geplante Starts warten, wenn das Claude-Abo-Kontingent oder das
  OpenRouter-Guthaben zur Neige geht.

## Sicherheitsmodell

Der Hub kann tmux steuern — das ist Shell-Zugriff. Deshalb:

- `server/hub.mjs` bindet **fest an 127.0.0.1**; aus dem Netz führt kein Weg direkt hin.
- Davor sitzt `vpn-proxy.mjs` (TLS), der **ausschließlich an die eigene
  WireGuard-Adresse** bindet — `CCHUB_VPN_BIND` ist Pflicht, es gibt absichtlich
  keinen Default. WireGuard ist die Auth-Schicht; ein eigenes Login gibt es nicht.
- Host-Allowlist + Origin-Prüfung (`CCHUB_ALLOWED_HOSTS`) als Zaun gegen
  DNS-Rebinding und CSRF; `Sec-Fetch-Site: cross-site` wird abgelehnt.
- **Fail-closed**: `cchub-vpn.service` startet nach Reboot bewusst nicht automatisch
  (`cchub on` schaltet den Zugang frei); die ufw-Regeln aus `setup/04-firewall.sh`
  erlauben den VPN-Port nur auf `wg0` und verbieten ihn überall sonst.

**Betreibe den Hub niemals ohne diese Schichten in einem erreichbaren Netz.**

## Installation

Voraussetzungen: Linux mit systemd (User-Units), Node.js ≥ 22 (`node:sqlite`), tmux,
git, jq, curl; mindestens eine Agent-CLI (`claude`, `opencode`, `hermes` oder
`cursor-agent`) im PATH. Zertifikate z. B. mit [mkcert](https://github.com/FiloSottile/mkcert).

```bash
./setup/01-npm-install.sh       # node-pty, ws, xterm.js
./setup/02-install-scripts.sh   # cc-start/-attach/-kill/-help/-report + cchub nach ~/.local/bin
./setup/03-install-services.sh  # ~/.config/cc-hub/env (aus env.example) + systemd-Units
sudo ./setup/04-firewall.sh     # ufw: VPN-Port nur auf wg0 (einmalig)
```

Danach in `~/.config/cc-hub/env` mindestens `CCHUB_VPN_BIND` und
`CCHUB_ALLOWED_HOSTS` setzen (siehe `env.example`), Zertifikate ablegen, dann:

```bash
cchub status    # Hub-Prozess, VPN-Zugang, Pipeline, laufende Sessions
cchub on        # VPN-Proxy starten → Website über WireGuard erreichbar
```

## Tests

```bash
node test/unit.mjs          # reine Logik (Cron, Zeitpläne, Quota-Gate, Parser) — ~1 s
node test/e2e.mjs           # kompletter Hub im Sandkasten, Stub statt echter Agenten — ~30 s
node test/e2e.mjs --echt    # zusätzlich EIN echter claude-Lauf (verbraucht Quota)
```

Die E2E-Suite startet einen zweiten Hub auf einem freien Port mit eigener Datenbank,
eigenem Test-Repo und eigenem `cc-start`-Stub — sie fasst weder Produktivdaten noch
fremde tmux-Sessions an.

## Entwicklung

Entwickler-Wissen (Architektur-Entscheidungen, Harness-Eigenheiten, bekannte Fallen)
steht in [CLAUDE.md](CLAUDE.md) — gedacht für Menschen **und** Coding-Agenten.
Maschinenspezifische Werte gehören nicht in dieses Repo (siehe Hinweis dort);
`./pruefe-vor-push.sh` prüft das vor jedem Push.
