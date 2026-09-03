# Aufgaben-Schwarm in einem Projekt einrichten

Schritt für Schritt. Am Ende besitzt das Projekt seine eigene Kopie des Motors, im Hub stehen
die Agenten und drei Flows, und ein Worker hat einmal wirklich gearbeitet.

Alle Kommandos laufen aus der Wurzel des Zielrepos. `<motor>` ist der Ordnername, unter dem der
Motor im Repo liegt — Vorgabe `schwarm/`; die Skripte finden ihren Ordnernamen selbst, ein
anderer Name ist erlaubt.

## 1. Voraussetzungen prüfen

```
fl-api /api/repos                 # steht das Zielrepo hier, und mit welcher id?
fl-api /api/flows/meta            # führt die Liste `steps` den Baustein count_runs?
fl-api /api/models provider=<anbieter> harness=<harness>   # welche Modelle gibt es hier?
fl-api /api/favorites             # die überlegten Antworten des Betreibers, sie gehen vor
```

`/api/models` braucht einen Anbieter; ohne ihn antwortet der Hub mit
`{"ok": false, "error": "unbekannter Provider: "}`. Welche Anbieter es gibt, sagt
`fl-api /api/providers harness=<harness>`; die Auswahl trifft der Skill `freilauf-models`.

Dazu drei Voraussetzungen, die kein Kommando meldet und die man erst zur Laufzeit vermisst:

- **`git`-Lesezugriff auf `origin` von dieser Maschine.** Die beiden Cron-Flows laufen in einem
  eigenen, detached Checkout, den `freilauf_einrichten.py` klont und bei jedem Takt nachzieht.
  Ohne Zugriff meldet das Einrichten es auf stderr, und die Flows scheitern danach laut.
- **Ein eigener Zustandsordner je Projekt.** `hub_ids.json`, `HALT` und `journal.jsonl` liegen
  unter `~/agents/schwarm/<projekt-slug>/`; den Slug bildet der Motor aus `repo.name`. Läuft auf
  dieser Maschine schon ein Schwarm, prüfe nach dem Einrichten, dass dessen Datei noch steht —
  ein geteilter Ordner hieße: Dispatcher A startet Agenten von Projekt B. `SCHWARM_STATE_DIR`
  überschreibt den Ort, wenn ein anderer gebraucht wird.
- **Der Motor muss auf den Basis-Branch.** Der Flow-Checkout holt `origin/<basis>`; was nur
  lokal liegt, sieht er nicht.

Fehlt das Repo, lege es zuerst an (Skill `freilauf-repos`). Fehlt `count_runs`, ist der Hub zu
alt — der Baustein existiert seit dem 2026-09-03; ohne ihn nehmen die Flow-Vorlagen ihre
Deckel-Zweige nicht.

Rate keine Repo-ID, keine Agent-ID, kein Modell und keine Effort-Stufe. Vor dem Ausfüllen der
Routen den Skill `freilauf-models` lesen; ein Favorit des Betreibers schlägt jede Empfehlung.

## 2. Den Motor kopieren

```
cp -r <skill-dir>/konzepte/aufgaben-schwarm/vorlage <zielrepo>/schwarm
cd <zielrepo>
mv schwarm/konfig.beispiel.json schwarm/konfig.json     # die Vorlage wird zur eigenen Konfig
```

Das Projekt besitzt ab jetzt diese Kopie. Zur Laufzeit wird nichts aus dem Skill-Ordner
aufgerufen — kein Pfad in einem Flow, in einem Prompt oder in einem Cron-Eintrag zeigt dorthin.

`konfig.json` trägt `motor_version`. Der Wert bleibt, wie er ist: Er sagt später, gegen welche
Fassung der Vorlage zu diffen ist (`AKTUALISIEREN.md`).

## 3. Den Adapter wählen und die Konfig ausfüllen

Der Block `repo` ist der Adapter auf das Aufgaben-Register. Nimm eine der Vorlagen und setze
ihre Kommandozeilen ein:

| Register | Beschreibung |
|---|---|
| Befund-Register (`register/befund.py`) | `adapter/befund-register.md` |
| GitHub Issues | `adapter/github-issues/ADAPTER.md` — dazu das Skript `gh_aufgaben.py` ins Repo kopieren |
| etwas anderes | `adapter/EIGENER-ADAPTER.md` — die Checkliste, was zu liefern ist |

Danach die übrigen Regler: Routen und Modelle (Schritt 1), `worker_agenten` (Namen und
Zeitbudgets), `startstufen`, `max_worker`, `budgets`, `tages_budget_usd`. Kennt das Register
keine Schweregrade, setze `schweregrade` auf `["normal"]` und gib allen Aufgaben `normal`.
Soll es keinen PO-Agenten geben, lass `po_agent.id` auf `null` und die fünf `po_*`-Kommandos
leer — der PO-Takt schweigt dann, statt täglich ins Leere zu starten.

Gibt es einen bestehenden Hub-Agenten für die PO-Vorträge, trag seine ID ein. Er wird nur
aktualisiert, nie neu angelegt: Eine Neuanlage erzeugte einen zweiten Agenten gleichen Namens
und schnitte seine Lauf-Historie ab.

## 4. Trocken rechnen

```
python <motor>/dispatch.py lage
python <motor>/freilauf_einrichten.py --dry-run
```

`lage` muss eine plausible Zahl offener Aufgaben melden — vergleiche sie mit dem, was dein
Register selbst zählt. Steht dort 0, obwohl Aufgaben offen sind, stimmt `aufgaben_liste_json`
nicht.

Ist ein Platzhalter stehen geblieben, brechen beide Skripte ab und nennen jeden offenen
Schlüssel mit seinem Pfad. Das ist kein Fehler des Skripts, sondern seine Prüfung.

`--dry-run` zeigt außerdem, wie lang die gerenderten Prompts werden und welche Agenten neu
angelegt würden. Lies mindestens einen gerenderten Worker-Prompt gegen, bevor du scharf fährst:

```
python - <<'PY'
import sys; sys.path.insert(0, "<motor>")
from pathlib import Path
import freilauf_einrichten as fe, dispatch
konf = dispatch.konfig_laden(Path("."))
print(fe.worker_prompt(Path("."), konf, konf["worker_agenten"][0]))
PY
```

## 5. Scharf einrichten

```
python <motor>/freilauf_einrichten.py
python <motor>/freilauf_einrichten.py            # zweiter Lauf: identische Ausgabe?
```

Der zweite Lauf ist der eigentliche Test. Er belegt, dass ein Voll-Replace den Schaltzustand
vorhandener Agenten nicht überschreibt und keine Dubletten anlegt.

Danach den Ordner committen und auf den Basis-Branch bringen. Ohne diesen Schritt läuft nichts:
Jeder Freilauf-Lauf bekommt einen frischen Worktree aus dem Basis-Branch, und der Wächter-Flow
arbeitet in einem eigenen Checkout von `origin/<basis>` — beide finden einen nur lokal
vorhandenen Ordner nicht.

Prüfe hier außerdem: Liegt `hub_ids.json` unter `~/agents/schwarm/<projekt-slug>/`, und steht
die Datei eines etwaigen anderen Projekts unverändert daneben? Wurde sie überschrieben, teilen
sich zwei Schwärme einen Namensraum, und beide Dispatcher lesen fremde Agenten-IDs.

## 6. Sichtprüfung im Hub

Im Hub unter „Agenten" beim Repository und unter „Flows":

- Alle Worker stehen auf `schedule_kind = manuell` und tragen den Nachlauf-Flow als Attachment.
- Der Dispatcher steht auf manuell.
- Der Wächter-Takt ist aktiv und hat den Cron `0 */2 * * *`.
- Der PO-Takt ist aktiv (oder es gibt ihn bewusst nicht).
- Modell, Anbieter und Effort jedes Agenten sind die, die du in `routen` eingetragen hast.
- Der globale Pipeline-Schalter in der Statusleiste steht auf an — sonst feuert kein Cron.

Aus der Shell dasselbe:

```
python <motor>/freilauf_einrichten.py --zeige
fl-api /api/agents repo=<id>
fl-api /api/flows
```

## 7. Probelauf

Erst der Wächter, ohne etwas zu starten:

```
fl-api -X POST /api/flows/<takt-flow-id>/run
fl-api /api/flow-runs/<uuid>
```

Der Lauf muss über den `ok`-Zweig gehen. Endet er im `notify`-Zweig, konnte der Shell-Aufruf
nicht laufen — meist, weil der Motor noch nicht auf dem Basis-Branch liegt.

Dann ein Worker, von Hand:

```
fl-api --status --raw -X POST /agents/start id=<worker-id> repo=<repo-id>
fl-api /api/runs agent=<worker-id> limit=1
```

Sieh dir den Lauf an, bis er endet, und lies seinen Report. Was er belegen muss: Er hat eine
Aufgabe reserviert, sie gemessen, sie geschlossen oder mit Notiz zurückgegeben, und seine
Schlusszeile trägt die Zahlen. Ein Lauf, der „nichts frei" meldet, obwohl `lage` Aufgaben zählt,
ist kein Erfolg — dann stimmt das Hol-Kommando nicht.

## 8. Abnahme-Checkliste

Erst wenn jede Zeile belegt ist, gilt die Einrichtung als fertig. Belegt heißt: mit dem
Kommando und seiner Ausgabe, nicht mit einer Vermutung.

- [ ] `dispatch.py lage` meldet dieselbe Zahl offener Aufgaben wie das Register selbst.
- [ ] `freilauf_einrichten.py` zweimal gefahren, Ausgabe beim zweiten Mal identisch.
- [ ] Der Motor liegt auf dem Basis-Branch (`git ls-tree <basis> --name-only` findet ihn).
- [ ] Kein Pfad in einem Flow, Prompt oder Cron zeigt in den Skill-Ordner.
- [ ] Der Wächter-Flow ist einmal über den `ok`-Zweig gelaufen.
- [ ] Ein Worker hat eine echte Aufgabe bearbeitet und seine Schlusszeile richtig geformt.
- [ ] Der Nachlauf-Flow ist auf diesem Lauf gelaufen (`fl-api /api/flow-runs/<uuid>`).
- [ ] Der Not-Halt wirkt: `dispatch.py stopp` ⇒ `lage` meldet 0 Starts und `arbeit_da=0`,
      `dispatch.py weiter` nimmt es zurück.
- [ ] Die Budget-Regler stehen unter Freilaufs eigenem Budget-Gate.
- [ ] Ein Test-Log im Repo hält fest, was gefahren wurde und was ungeprüft blieb.

Was du nicht prüfen konntest, schreib als offenen Punkt auf. Ein ungeprüfter Zweig, der als
geprüft gilt, ist teurer als einer, der offen dasteht.
