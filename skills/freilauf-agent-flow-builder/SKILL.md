---
name: freilauf-agent-flow-builder
description: Erprobte Bauformen aus Freilauf-Agenten und Freilauf-Flows in einem Projekt einrichten, prüfen und aktualisieren. Aktiviere diesen Skill, sobald ein Projekt seine Aufgaben, Bugs, Tickets oder Issues automatisch abarbeiten lassen soll, jemand einen Schwarm oder eine Aufgaben-Automatik einrichten will, Agenten für ein Repository angelegt werden sollen, die sich selbst Arbeit holen, oder ein bestehendes Konzept in ein weiteres Repository übernommen bzw. gegen die Vorlage aktualisiert werden soll — auch bei Formulierungen ohne das Wort Freilauf, etwa "unsere offenen Bugs sollen sich selbst abarbeiten", "richte den Schwarm in Repo X ein", "Agenten anlegen, die das Register leerräumen", "das läuft im anderen Projekt schon, hol es hierher", "warum steht bei uns eine alte Fassung des Motors".
---

# Freilauf-Bauformen einrichten

Dieser Skill ist ein Katalog erprobter Bauformen aus Freilauf-Agenten und Freilauf-Flows. Jedes
Konzept liegt als eigener Ordner unter `konzepte/` und bringt mit, was zum Einrichten nötig ist:
die Begründung, die Anleitung, die Vorlage des Motors und die Adapter.

## Regeln

- Dieser Skill ist ein Builder, kein Motor. Zur Laufzeit wird nichts aus dem Skill-Ordner
  aufgerufen: Kein Flow, kein Prompt, kein Cron-Eintrag und kein Agent zeigt hierher. Was ein
  Projekt braucht, wird in das Projekt kopiert; das Projekt besitzt seine Kopie und darf sie
  ändern.
- Die Aufgabenquelle ist ein Vertrag, keine Annahme. Kein Konzept setzt ein bestimmtes
  Ticket-System voraus — ein Adapter liefert die Kommandos, die die Konfiguration verlangt. Wähle
  einen vorhandenen Adapter oder schreib einen nach der Checkliste.
- Bevorzuge, was Freilauf schon kann. Cron gehört in einen Flow, Skalierung in `/agents/start`,
  Zeitversatz in `delay`, Report-Auswertung in `extract`, Meldungen in `notify`. Selbst gebaut
  wird nur, was der Hub nicht wissen kann — bei den Aufgaben-Konzepten ist das genau eine Sache:
  wie viele Aufgaben in diesem Repository offen sind.
- Jeder Lauf ist ein gewöhnlicher Freilauf-Run: eigener Worktree, eigene tmux-Sitzung, sichtbar
  im Hub, abgerechnet über dieselben Budget- und Quoten-Gates. Es entsteht kein zweites
  Agenten-System neben Freilauf.
- Rate nichts, was der Hub weiß. Repo-IDs, Agent-IDs, Modelle, Anbieter und Effort-Stufen kommen
  aus `fl-api /api/repos`, `/api/agents`, `/api/models` und `/api/favorites` — für diese
  Installation, die einzige, die zählt. Ein Favorit des Betreibers schlägt jede Empfehlung.
- Vor dem Ausfüllen von Modell-Feldern den Skill `freilauf-models` lesen, für die Flow-Vorlagen
  `freilauf-flows`, für die Agenten-Felder `freilauf-agents`.

## Die Konzepte

### Aufgaben-Schwarm — `konzepte/aufgaben-schwarm/`

Eine Besetzung von Freilauf-Agenten arbeitet ein Aufgaben-Register eines Repositories
selbständig ab. Ein Wächter-Flow zählt im Zwei-Stunden-Takt ohne LLM, ob Arbeit da ist, und
weckt nur dann einen Dispatcher; der entscheidet anhand von Guthaben, Abo-Quote und Tagesbudget,
wie viele Worker auf welcher Route starten. Die Worker bedienen sich selbst am Register,
reservieren atomar, messen nach und schließen oder geben mit Notiz zurück. Was zweimal
scheitert oder als blockiert eingetragen ist, bekommt einen stärkeren Agenten mit vollem
Zeitbudget für genau einen Fall; was auch der nicht entscheiden kann, legt ein PO-Agent einem
Menschen als nummerierte Wahl vor und arbeitet dessen Antwort wieder ein. Keine Aufgabe bleibt
liegen: Jeder Zustand endet in „geschlossen" oder in der nächsten Stufe. Ein Tag ohne offene
Aufgaben kostet null Agenten-Läufe und null Token. Geeignet für Register mit vielen kleinen,
messbaren Einträgen — nicht für Arbeit, die echtes Urteil verlangt.

- Begründung, Architektur, Grenzen: [`konzepte/aufgaben-schwarm/KONZEPT.md`](konzepte/aufgaben-schwarm/KONZEPT.md)
- Einrichten, Schritt für Schritt, mit Abnahme-Checkliste: [`konzepte/aufgaben-schwarm/EINRICHTEN.md`](konzepte/aufgaben-schwarm/EINRICHTEN.md)
- Eine bestehende Projektkopie gegen die Vorlage aktualisieren: [`konzepte/aufgaben-schwarm/AKTUALISIEREN.md`](konzepte/aufgaben-schwarm/AKTUALISIEREN.md)
- Der Motor zum Kopieren: `konzepte/aufgaben-schwarm/vorlage/`
- Adapter: `konzepte/aufgaben-schwarm/adapter/befund-register.md` · `konzepte/aufgaben-schwarm/adapter/github-issues/ADAPTER.md` · `konzepte/aufgaben-schwarm/adapter/EIGENER-ADAPTER.md`

## Ein weiteres Konzept aufnehmen

Ein Konzept gehört hierher, sobald es in einem Projekt wirklich gelaufen ist und ein zweites
Projekt es gebrauchen könnte. Die Form ist für jedes gleich:

```
konzepte/<name>/
  KONZEPT.md        Problem, Architektur mit Tabelle der Agenten und Flows, Grenzen
  EINRICHTEN.md     Schritt für Schritt bis zur Abnahme-Checkliste
  AKTUALISIEREN.md  Projektkopie gegen die Vorlage diffen und übernehmen
  vorlage/          der Motor zum Kopieren, generisch, mit konfig.beispiel.json
  adapter/          je Anbindung eine Beschreibung, dazu EIGENER-ADAPTER.md
```

Dazu ein Eintrag in der Liste oben: drei bis acht Sätze, die sagen, was das Konzept löst, wie es
grob gebaut ist und wofür es nicht taugt — und der Link auf den Ordner. Alles Repo-Spezifische
gehört in `konfig.beispiel.json` als Platzhalter, nie in den Motor; `motor_version` in der
Beispiel-Konfig bekommt bei jeder Änderung an der Vorlage eine neue Zahl.
