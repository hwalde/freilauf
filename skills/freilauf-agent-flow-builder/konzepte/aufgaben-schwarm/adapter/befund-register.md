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

  "aufgaben_liste_json": "python register/befund.py liste --frei --unbelegt --json --lokal",
  "listen_felder": {
    "id": "id", "schwere": "schwere", "art": "art", "titel": "titel",
    "fundort": "fundort", "versuche": "versuche", "angelegt": "angelegt"
  },
  "aufgabe_holen": "python register/befund.py naechster --belegen --lauf \"$FL_RUN_ID\" --lokal --auch-unverifiziert --schwere <schwere>",
  "aufgabe_holen_zusatz_gescheitert": "--min-versuche <n>",
  "aufgabe_holen_zusatz_stark": "--max-versuche 3",
  "aufgabe_ansehen": "python register/befund.py zeig <id> --langtext",
  "aufgabe_abschliessen": "python register/befund.py schliessen <id> --beleg \"<Kommando + Ergebnis>\"",
  "aufgabe_zurueckgeben": "python register/befund.py versuch <id> --grund \"<woran es lag>\" && python register/befund.py freigebe <id>",
  "aufgabe_notiz": "python register/befund.py notiz <id> --text \"<Zwischenstand>\"",
  "aufgabe_neu": "python register/befund.py neu",
  "belegungen_zeigen": "python register/befund.py belegungen",

  "po_liste_json": "python register/befund.py liste --wartet-auf po --json --lokal",
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

## Der Fallstrick, der Läufe gekostet hat

`befund.py` gleicht offene Einträge gegen den Basis-Branch ab. In einem frischen Worktree kann
dieser Abgleich fehlgehen und fast alle Einträge fälschlich als „schon geschlossen" markieren —
gemessen am 2026-09-03: `offen=1` statt `offen=58` in zwei Worktrees mit identischem HEAD.

Deshalb tragen oben alle listenden Kommandos `--lokal`, und `aufgaben_hinweis` sagt dem Worker
ausdrücklich, der Markierung nicht zu glauben, solange die Datei unter `register/` liegt. Ein
Worker hatte sonst einen Eintrag reserviert, ihn gegen eine Liste ohne `--lokal` gegengeprüft,
die Markierung geglaubt und wieder freigegeben — eine Schleife, die wie ein leeres Register
aussieht. Ist der Abgleich in deiner Fassung repariert, kann `--lokal` aus den Kommandos
verschwinden; der Prompt bleibt auch dann richtig.

## Grenzen

- Die Reservierung liegt außerhalb der Worktrees und damit außerhalb von git — sie ist
  maschinenlokal. Ein Schwarm auf einer zweiten Maschine sieht sie nicht; Folge ist
  Doppelarbeit, nie Datenverlust.
- Hängt eine Reservierung, obwohl der Lauf tot ist: `befund.py belegungen --aufraeumen` löst nur,
  wessen Worktree verschwunden ist; sonst gezielt `befund.py freigebe <id>`.
- Das Register lebt im Repo. Ein Befund gehört auf den Branch, auf dem der Code lebt, den er
  beschreibt — und wird im selben Commit geschlossen wie sein Fix.
