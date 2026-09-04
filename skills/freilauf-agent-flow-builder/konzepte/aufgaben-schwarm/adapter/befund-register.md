# Adapter: Befund-Register (`register/befund.py`)

Das Befund-Register des Ursprungsprojekts: eine Markdown-Datei je Bug beziehungsweise
technischer Aufgabe unter `register/`, bedient über ein Python-Werkzeug. Es ist der Ursprung
dieses Konzepts und der einzige Adapter, dessen Kommandos echte Pfade eines bestimmten Projekts
tragen — in einem anderen Repo mit demselben Werkzeug bleiben sie unverändert, nur `repo_id`
und die Gates ändern sich.

## Warum dieses Register den Vertrag von Haus aus erfüllt

- Jedes Kommando endet mit einer byte-stabilen Schlusszeile (`BEFUND_LISTE result=OK n=…`),
  auf die ein Flow eine `contains`-Bedingung legen kann.
- `naechster --belegen` reserviert atomar über eine Datei außerhalb des Worktrees. Zwei
  gleichzeitige Läufe greifen nie nach derselben Aufgabe.
- `versuch` zählt Fehlversuche und eskaliert beim dritten selbst auf `wartet_auf: po`. Der
  Lebenszyklus „keine Aufgabe bleibt liegen" braucht dafür keine eigene Logik im Motor.
- Ein Eintrag verlangt beim Anlegen Fundort, gemessene Population und die offene Frage. Damit
  bekommt ein Worker Messbares statt eines Urteils.

## Der Block `repo` für `konfig.json`

```json
{
  "repo_id": 1,
  "name": "beispiel-projekt",
  "aufgaben_wort": "Befund",
  "aufgaben_wort_mehrzahl": "Befunde",
  "register_beschreibung": "dem Befund-Register `register/` — eine Markdown-Datei je Bug bzw. technischer Aufgabe, bedient über `python register/befund.py`",
  "regeln_datei": "CLAUDE.md",

  "aufgaben_liste_json": "python register/befund.py liste --frei --unbelegt --json",
  "listen_felder": {
    "id": "id", "schwere": "schwere", "art": "art", "titel": "titel",
    "fundort": "fundort", "versuche": "versuche", "angelegt": "angelegt"
  },
  "aufgabe_holen": "python register/befund.py naechster --belegen --lauf \"$FL_RUN_ID\" --auch-unverifiziert --schwere <schwere>",
  "aufgabe_holen_zusatz_gescheitert": "--min-versuche <n>",
  "aufgabe_holen_zusatz_stark": "--max-versuche 3",
  "aufgabe_ansehen": "python register/befund.py zeig <id> --langtext",
  "aufgabe_abschliessen": "python register/befund.py schliessen <id> --beleg \"<Kommando + Ergebnis>\"",
  "aufgabe_zurueckgeben": "python register/befund.py versuch <id> --grund \"<woran es lag>\" && python register/befund.py freigebe <id>",
  "aufgabe_notiz": "python register/befund.py notiz <id> --text \"<Zwischenstand>\"",
  "aufgabe_freigeben": "python register/befund.py freigebe <id>",
  "aufgabe_freigeben_sofort": "python register/befund.py freigebe <id> --sofort",
  "aufgabe_neu": "python register/befund.py neu",
  "belegungen_zeigen": "python register/befund.py belegungen",
  "belegungen_aufraeumen": "python register/befund.py belegungen --aufraeumen",

  "zuweisungen_alt_json": "python register/befund.py belegungen --aelter-als <stunden> --json",
  "lauf_zustand": "fl-api /api/runs/<lauf>",
  "lauf_bericht": "cat ~/agents/runs/<lauf>/report.md",
  "zuweisung_loesen": "python register/befund.py freigebe <id> --fremd --beleg \"<was aus dem Lauf wurde>\"",

  "po_liste_json": "python register/befund.py liste --wartet-auf po --json",
  "po_ansehen": "python register/befund.py zeig <id> --langtext",
  "po_entscheid_notieren": "python register/befund.py notiz <id> --text \"PO-Entscheid <Datum>: <Entscheid>\"",
  "po_freigeben": "python register/befund.py setze <id> --wartet-auf keins",
  "po_an_menschen": "python register/befund.py setze <id> --wartet-auf mensch",

  "gate": "python register/befund.py lint",
  "zusatz_gates": []
}
```

`aufgaben_hinweis`, `regeln_snippet`, `doku_pflicht` und `doku_pflicht_subagent` sind
projektabhängig und stehen nicht in dieser Vorlage — sie tragen die Schreibregeln und die
Doku-Pflicht des jeweiligen Repos.

## Die drei Optionen, die dieser Adapter braucht

Nicht jede Fassung von `befund.py` kennt sie. Vor dem ersten Lauf gegenprüfen mit
`python register/befund.py naechster --help`:

| Option | wofür | fehlt sie |
|---|---|---|
| `--schwere <s>` | die Bahnen trennen: der gewöhnliche Worker greift nie nach Blockiertem | jeder Hol-Versuch endet mit `unrecognized arguments`, Exit 2 |
| `--min-versuche <n>` | der zweite Hol-Versuch der starken Bahn | `aufgabe_holen_zusatz_gescheitert` leer lassen; die starke Bahn holt dann nur Blockiertes |
| `--max-versuche <n>` | eine vom PO wieder freigegebene Aufgabe behält ihren Zähler und wäre sonst für jede Bahn unsichtbar | `aufgabe_holen_zusatz_stark` leer lassen und in Kauf nehmen, dass eskalierte Aufgaben liegen bleiben |

Fehlt eine Option, scheitert der Worker laut: Sein Prompt trennt Werkzeugfehler (Exit ungleich 0,
`usage:`, `error:`, `Traceback`) von „nichts frei" und verlangt im ersten Fall `fl-report failed`.
Ein stiller Leerlauf ist damit ausgeschlossen — und das ist der Punkt: Ein Schwarm, der grün
meldet und nie etwas anfasst, ist der teuerste Zustand dieses Systems.

## Der Fallstrick, der Läufe gekostet hat — und warum `--lokal` heute fehlt

`befund.py` gleicht offene Einträge gegen den Basis-Branch ab. In einem frischen Worktree ging
dieser Abgleich einmal fehl und markierte fast alle Einträge fälschlich als „schon geschlossen"
— gemessen am 2026-09-03: `offen=1` statt `offen=58` in zwei Worktrees mit identischem HEAD.
Die Krücke dagegen war `--lokal`: nur den eigenen Worktree lesen.

Sie steht in den Kommandos oben bewusst NICHT mehr. Der Abgleich ist seit dem 2026-09-03
repariert, und in der Nacht darauf hat die Krücke messbar geschadet: Drei Läufe zogen
nacheinander dieselben zwei Aufgaben und eskalierten sie dreimal an einen Menschen, weil keiner
die Arbeit des anderen sah. Eine Option, die nur den eigenen Arbeitsbereich liest, gehört in
kein Hol-Kommando eines Schwarms. Ist der Abgleich in deiner Fassung noch defekt, repariere ihn,
statt ihn zu umgehen; der Worker fährt ohnehin `git fetch origin`, bevor er sich Arbeit holt.

## Grenzen

- Die Reservierung liegt außerhalb der Worktrees und damit außerhalb von git — sie ist
  maschinenlokal. Ein Schwarm auf einer zweiten Maschine sieht sie nicht; Folge ist
  Doppelarbeit, nie Datenverlust.
- Hängt eine Reservierung, obwohl der Lauf tot ist: `befund.py belegungen --aufraeumen` löst nur,
  wessen Worktree verschwunden ist; sonst gezielt `befund.py freigebe <id>`. `dispatch.py lage`
  fährt dieses Aufräumen seit Motor 1.3.0 vor jedem Zählen selbst.
- Die Zuweisung überlebt die Rückgabe: Ein zurückgegebener Befund wird nicht sofort wieder
  angeboten, weil Versuchszähler und Notiz erst mit dem Merge auf `origin/main` ankommen. Was
  ein Lauf gar nicht angefasst hat, geht mit `freigebe --sofort` ohne diese Nachwirkung zurück.
  Verschwindet ein Lauf mitsamt seiner Zuweisung, findet der Aufräum-Agent sie über
  `belegungen --aelter-als <stunden> --json`.
- Das Register lebt im Repo. Ein Befund gehört auf den Branch, auf dem der Code lebt, den er
  beschreibt — und wird im selben Commit geschlossen wie sein Fix.
