# Adapter: GitHub Issues

Ein Aufgaben-Schwarm liest seine Arbeit nicht aus einem festen Ticket-System, sondern über
einen Adapter — ein Werkzeug, das genau die Unterbefehle anbietet, die der Block `repo` in
`konfig.json` aufruft. Vorbild des Vertrags ist `python register/befund.py …` aus dem
Ursprungsprojekt. Dieser Adapter bildet ihn auf GitHub Issues ab und ruft dafür
ausschließlich `gh` auf: keine Bibliothek, kein Zustand neben dem Repository. Nimm ihn, wenn
die Aufgaben ohnehin als Issues liegen und Menschen sie im Browser sehen sollen — nicht,
wenn viele Läufe gleichzeitig greifen und Doppelarbeit teuer ist (siehe Grenzen).

## Abbildung GitHub ↔ Vertrag

| Vertrag | GitHub |
| --- | --- |
| Warteschlange | Label `schwarm` — nur offene Issues mit diesem Label sind Aufgaben |
| id | Issue-Nummer als Zeichenkette |
| Belegung | Label `in-arbeit`, zusätzlich Assignee, wenn GitHub ihn annimmt |
| Notiz | Issue-Kommentar |
| wartet_auf | Labels `wartet-auf:po` und `wartet-auf:mensch` |
| schwere | `schwere:trivial` · `schwere:normal` · `schwere:blockiert` (fehlt eines: `normal`) |
| art | `art:bug` · `art:aufgabe` (fehlt eines: `aufgabe`) |
| versuche | `versuch:1` · `versuch:2` · `versuch:3`, keines heißt 0; Deckel 3 |
| fundort | erste Zeile im Body, die mit `Fundort:` beginnt (sonst leer) |
| angelegt | `createdAt`, auf YYYY-MM-DD gekürzt |
| Abschluss | Kommentar mit dem Beleg, danach `gh issue close --reason completed` |

Jede Aufgabe kommt als JSON mit den Feldern `id`, `schwere`, `art`, `titel`, `fundort`,
`versuche`, `angelegt`, `wartet_auf`.

## Einrichtung (einmalig je Repository)

Die Labels müssen im Repository existieren, sonst weist `gh issue edit` sie zurück.

```bash
R=owner/name
gh label create schwarm            -R "$R" -c "#1d76db" -d "Aufgabe des Schwarms"
gh label create in-arbeit          -R "$R" -c "#fbca04" -d "Von einem Lauf belegt"
gh label create wartet-auf:po      -R "$R" -c "#d93f0b" -d "Wartet auf eine PO-Entscheidung"
gh label create wartet-auf:mensch  -R "$R" -c "#d93f0b" -d "Wartet auf einen Menschen"
gh label create schwere:trivial    -R "$R" -c "#c2e0c6"
gh label create schwere:normal     -R "$R" -c "#bfd4f2"
gh label create schwere:blockiert  -R "$R" -c "#b60205"
gh label create art:bug            -R "$R" -c "#d73a4a"
gh label create art:aufgabe        -R "$R" -c "#0075ca"
gh label create versuch:1          -R "$R" -c "#e4e669"
gh label create versuch:2          -R "$R" -c "#e4e669"
gh label create versuch:3          -R "$R" -c "#e4e669"
```

Dazu gehört ein angemeldetes `gh` (`gh auth status`) mit `repo`-Scope. Das Repository wählt
`--repo owner/name`, ersatzweise die Umgebungsvariable `GH_AUFGABEN_REPO`, ersatzweise das
Repository des Arbeitsverzeichnisses. Setze `GH_AUFGABEN_REPO` im Schwarm, dann bleiben die
Kommandozeilen unten kurz. Probe vor dem ersten Lauf:
`python .../gh_aufgaben.py liste` muss eine Liste oder `n=0` liefern.

## Konfig-Schnipsel für den Block `repo`

`SCHWARM` steht für den Pfad zu diesem Adapter, etwa `schwarm/adapter/gh_aufgaben.py`.

```json
"aufgaben_liste_json": "python SCHWARM/gh_aufgaben.py liste --frei --unbelegt --json",
"listen_felder": {
  "id": "id", "schwere": "schwere", "art": "art", "titel": "titel",
  "fundort": "fundort", "versuche": "versuche", "angelegt": "angelegt"
},
"aufgabe_holen": "python SCHWARM/gh_aufgaben.py naechster --belegen --lauf \"$FL_RUN_ID\" --schwere <schwere>",
"aufgabe_holen_zusatz_gescheitert": "--min-versuche <n>",
"aufgabe_holen_zusatz_stark": "--max-versuche 3",
"aufgabe_ansehen": "python SCHWARM/gh_aufgaben.py zeig <id> --langtext",
"aufgabe_abschliessen": "python SCHWARM/gh_aufgaben.py schliessen <id> --beleg \"<Kommando + Ergebnis>\"",
"aufgabe_zurueckgeben": "python SCHWARM/gh_aufgaben.py versuch <id> --grund \"<woran es lag>\" && python SCHWARM/gh_aufgaben.py freigebe <id>",
"aufgabe_notiz": "python SCHWARM/gh_aufgaben.py notiz <id> --text \"<Zwischenstand>\"",
"aufgabe_neu": "python SCHWARM/gh_aufgaben.py neu",
"belegungen_zeigen": "python SCHWARM/gh_aufgaben.py belegungen",
"po_liste_json": "python SCHWARM/gh_aufgaben.py liste --wartet-auf po --json",
"po_ansehen": "python SCHWARM/gh_aufgaben.py zeig <id> --langtext",
"po_entscheid_notieren": "python SCHWARM/gh_aufgaben.py notiz <id> --text \"PO-Entscheid <Datum>: <Entscheid>\"",
"po_freigeben": "python SCHWARM/gh_aufgaben.py setze <id> --wartet-auf keins",
"po_an_menschen": "python SCHWARM/gh_aufgaben.py setze <id> --wartet-auf mensch",
"gate": "gh auth status"
```

Zu `gate`: Der Adapter hat kein Gegenstück zu `befund.py lint` — die Form der Einträge
erzwingt GitHub selbst. `gh auth status` prüft stattdessen, was hier wirklich brechen kann.
Wer mehr will, hängt an `zusatz_gates` die Gates des eigenen Repositorys (Tests, Linter).

Jeder Unterbefehl endet mit einer byte-stabilen Schlusszeile auf stdout:
`GH_AUFGABEN_<BEFEHL> result=OK|FAIL key=value …` — `liste` mit `n=<anzahl>`, `naechster`
mit `id=<n> kandidaten=<k> belegt=ja|nein` oder mit `n=0`, wenn nichts frei ist (Exit 0, kein
Fehler). Exit-Codes: 0 in Ordnung, 1 fachlicher Fehlschlag, 2 Eingabefehler, 3 Umgebung nicht
nutzbar. Mit `--dry-run` zeigen schreibende Befehle ihren `gh`-Aufruf, ohne ihn zu fahren.

## Grenzen

- Keine nachwirkende Zuweisung. `freigebe` nimmt das Label `in-arbeit` und die Assignees weg,
  und das Issue ist im selben Augenblick wieder frei — der Adapter kennt weder
  `aufgabe_freigeben_sofort` noch `zuweisungen_alt_json` noch `zuweisung_loesen`, und der
  Aufräum-Agent bleibt hier ohne Arbeit (`lage` meldet `zuweisungen_messbar=0`). Das ist zum
  großen Teil unschädlich, und der Grund ist wichtiger als die Lücke: Das Zeitfenster, gegen
  das eine Zuweisung schützt, entsteht durch den MERGE, nicht durch die Rückgabe. `versuch`
  setzt hier das Label `versuch:n` und schreibt den Kommentar sofort auf GitHub, sichtbar für
  jeden Lauf im selben Moment; es gibt keinen Verzug zwischen Schreiben und Sichtbarwerden.
  Ein zweiter Lauf, der das Issue direkt danach zieht, sieht den erhöhten Zähler und die Notiz
  des Vorgängers — genau das, was ein dateibasiertes Register erst nach dem Merge kann.
  Was bleibt: Stirbt ein Lauf, nachdem er `in-arbeit` gesetzt hat, aber bevor er etwas
  schreibt, hält das Label das Issue fest, und niemand räumt es weg. Der Adapter weiß nicht, ob
  der haltende Lauf noch lebt; das muss ein Mensch mit `freigebe <id>` lösen.
- Keine atomare Reservierung. Ein Label ist keine Dateisperre: Zwei Läufe können dieselbe
  Aufgabe im selben Augenblick greifen, und beide arbeiten dann daran. Der Adapter liest
  jeden Kandidaten unmittelbar vor dem Setzen noch einmal und prüft danach nach, ob
  `in-arbeit` sitzt; das verkleinert das Fenster, schließt es aber nicht. Folge ist
  Doppelarbeit, nie Datenverlust.
- Kein `--aufraeumen`. Eine Belegung liegt hier auf GitHub und ist für alle sichtbar, nicht
  maschinenlokal; der Adapter kann nicht wissen, ob der haltende Lauf noch lebt. Der Befehl
  meldet das und endet mit Exit 2. Hängengebliebene Belegungen gibt ein Mensch oder ein
  Aufräum-Flow gezielt mit `freigebe <id>` zurück.
- `gh` braucht Netz und Anmeldung; ohne beides steht der Schwarm (Exit 3).
- Rate-Limit. Jeder Unterbefehl kostet mindestens einen API-Aufruf, `naechster --belegen`
  vier bis sechs. Bei vielen parallelen Läufen im Minutentakt ist das Limit erreichbar; der
  Adapter erkennt die Meldung und gibt Exit 3 zurück.
- Kein Verifiziert-Feld und keine lokale Sicht: `--auch-unverifiziert` und `--lokal` werden
  angenommen und ignoriert. `liste` liefert höchstens 500 offene Aufgaben.
- Der Adapter legt keine Labels an und rührt Issues ohne Label `schwarm` nicht an.
