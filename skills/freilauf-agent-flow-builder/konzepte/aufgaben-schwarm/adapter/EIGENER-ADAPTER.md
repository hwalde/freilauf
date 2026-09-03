# Einen eigenen Adapter schreiben — die Checkliste

Ein Adapter ist kein Programm, sondern eine Zusage: Er liefert die Kommandos, die der Block
`repo` der Konfig verlangt, in der Form, die der Motor erwartet. Was dahinter liegt — ein
Python-Werkzeug, ein `gh`-Aufruf, ein `curl` gegen eine API, ein Shell-Einzeiler über
Markdown-Dateien — ist dem Motor gleichgültig.

Schreib den Adapter erst, wenn keine der beiden Vorlagen passt: `befund-register.md` für ein
dateibasiertes Register im Repo, `github-issues/ADAPTER.md` für Issues in GitHub.

## 1. Die Felder

Jede Aufgabe muss diese acht Felder liefern können. Zwei davon sind Pflicht, sechs dürfen leer
oder konstant sein — der Motor rechnet dann entsprechend gröber.

| Feld | Pflicht | Bedeutung | wenn es das nicht gibt |
|---|---|---|---|
| `id` | ja | eindeutig, stabil, in einer Kommandozeile verwendbar | ohne id kein Adapter |
| `schwere` | ja | `trivial`, `normal` oder `blockiert` | überall `normal` setzen, `schweregrade` auf `["normal"]` |
| `art` | nein | Bug oder Aufgabe, nur für den Prompt | leer lassen |
| `titel` | nein | eine Zeile | leer lassen |
| `fundort` | nein | Datei und Zeile, wo es weitergeht | leer lassen |
| `versuche` | nein | Zahl der Fehlversuche | 0; die starke Bahn holt dann nur Blockiertes |

Zum Feld `versuche` gehört ein Wert in der Konfig: `versuchs_deckel` (Vorgabe 3). Er sagt, ab
wie vielen Fehlversuchen eine Aufgabe an einen Menschen geht, und er muss zu dem passen, was
dein Werkzeug wirklich tut — setzt es die Marke für den Menschen beim dritten Versuch, steht
hier 3. Zwei Regeln, die daraus folgen und die man teuer lernt:

- Der Motor zählt Aufgaben **oberhalb** des Deckels für keine Bahn mehr. Führt dein Werkzeug
  gar keinen Zähler, liefere `versuche: 0` — dann greift nur die Blockiert-Regel, und nichts
  fällt heraus.
- Beim Freigeben durch den Menschen bleibt der Zähler meist stehen. Der Motor zählt deshalb
  **einschließlich** des Deckels, und `aufgabe_holen_zusatz_stark` muss dieselbe Menge holen
  (im mitgelieferten Register-Adapter: `--max-versuche <deckel>`). Zählen und Holen dürfen hier
  nie auseinandergehen: Zählt der Motor mehr, weckt er Worker, die nichts finden; zählt er
  weniger, bleibt die freigegebene Aufgabe für immer liegen.
| `angelegt` | nein | Datum | leer lassen |
| `wartet_auf` | nein | `""`, `po` oder `mensch` | leer; dann gibt es keinen PO-Zweig |

Die Namen dürfen anders heißen — `listen_felder` bildet sie ab.

## 2. Die Kommandos

Jedes läuft über bash im Wurzelverzeichnis des Repos und bekommt seine Platzhalter (`<id>`,
`<schwere>`, `<n>`, `$FL_RUN_ID`) beim Rendern beziehungsweise vom Worker gefüllt.

| Konfig-Schlüssel | muss tun | Pflicht |
|---|---|---|
| `aufgaben_liste_json` | die offenen, unbelegten Aufgaben als JSON-Liste auf stdout drucken | ja |
| `aufgabe_holen` | genau eine freie Aufgabe der genannten Schwere holen und atomar reservieren | ja |
| `aufgabe_ansehen` | eine Aufgabe vollständig zeigen, mit Vorgeschichte und Notizen | ja |
| `aufgabe_abschliessen` | eine Aufgabe schließen und den Beleg entgegennehmen | ja |
| `aufgabe_zurueckgeben` | Fehlversuch mit Grund protokollieren und die Reservierung lösen | ja |
| `aufgabe_notiz` | einen Zwischenstand anhängen | ja |
| `aufgabe_neu` | eine neue Aufgabe anlegen | ja |
| `belegungen_zeigen` | zeigen, wer was reserviert hält | ja |
| `gate` | die Prüfung, die vor dem Abschließen grün sein muss | ja |
| `aufgabe_holen_zusatz_gescheitert` | Zusatz, der nur schon gescheiterte Aufgaben liefert | nein |
| `aufgabe_holen_zusatz_stark` | Zusatz, der auch eine Aufgabe am Versuchs-Deckel findet | nein |
| `po_liste_json`, `po_ansehen`, `po_entscheid_notieren`, `po_freigeben`, `po_an_menschen` | der PO-Zweig | nein, aber alle fünf oder keines |

## 3. Die Form der Ausgabe

- Jedes Kommando endet mit einer byte-stabilen Schlusszeile:
  `<WERKZEUG>_<BEFEHL> result=OK|FAIL key=value …`. Die Zahlen gehören in diese Zeile, nicht
  nur ins JSON: Flows vergleichen sie mit `contains`, und ein `contains` auf eingerücktes JSON
  bricht bei jeder Formatänderung. Vergleiche immer mit einem Leerzeichen am Ende
  (`n=0 `), sonst passt `n=4` auch auf `n=42`.
- Bei `--json` darf die Schlusszeile hinter dem JSON stehen; der Motor liest den JSON-Kopf und
  ignoriert den Rest.
- Exit-Codes: 0 in Ordnung (auch „nichts frei"), 1 fachlicher Fehlschlag, 2 Eingabefehler,
  3 Umgebung nicht nutzbar. Der Worker-Prompt unterscheidet daran drei Fälle: Aufgabe bekommen,
  nichts frei, Werkzeugfehler. Nur der dritte darf `fl-report failed` auslösen.
- „Nichts frei" ist kein Fehler. Exit 0 und `n=0` in der Schlusszeile — sonst meldet ein leeres
  Register jeden Lauf als Fehlschlag.
- Fehlermeldungen gehen nach stderr und nennen den nächsten Schritt.

## 4. Die Reservierung — die Stelle, an der es wirklich klemmt

`aufgabe_holen` soll atomar sein: prüfen und belegen in einem Schritt, nicht nacheinander.
Zwei Worker starten mit `versatz_minuten` Abstand, aber der Abstand ist eine Bequemlichkeit,
keine Sperre.

Wo echte Atomarität nicht erreichbar ist — viele Ticket-APIs bieten kein Setzen mit
Vorbedingung —, ist das kein Ausschlusskriterium, aber eine Bringschuld: Schreib die Folge in
die Grenzen deines Adapters („nicht atomar, Doppelarbeit möglich, nie Datenverlust"), verkleinere
das Fenster (unmittelbar vor dem Setzen frisch lesen, danach verifizieren) und setze
`versatz_minuten` und `stark_max_parallel` entsprechend. Der mitgelieferte GitHub-Adapter macht
genau das und legt es offen (`github-issues/ADAPTER.md`, Abschnitt „Grenzen") — er ist das
Beispiel für diesen Fall, nicht die Ausnahme von der Regel.

- Dateibasiert: eine Sperrdatei mit `O_EXCL` anlegen, außerhalb des Worktrees, mit der Lauf-ID
  darin. Diese Sperre ist maschinenlokal — ein Schwarm auf einer zweiten Maschine sieht sie nicht.
- API-basiert: ein Feld setzen, das nur einmal gesetzt werden kann (Assignee, Statuswechsel mit
  Vorbedingung). Ohne Vorbedingung gewinnt der letzte Schreiber, und beide Worker glauben, sie
  hätten die Aufgabe.
- Eine hängende Reservierung braucht einen Weg zurück: ein Kommando, das löst, wessen Lauf es
  nicht mehr gibt.

## 5. Prüfen, bevor der erste Agent startet

```
<dein adapter> --help                       # ohne Netz, ohne Anmeldung
<dein adapter> liste --json                 # gültiges JSON plus Schlusszeile
python <motor>/dispatch.py lage             # zählt der Motor dieselbe Zahl?
```

Dann diese fünf Gegenproben, jede mit ihrer echten Ausgabe im Test-Log:

- [ ] Leeres Register: `liste --json` liefert `[]` und `n=0`, Exit 0.
- [ ] Holen bei leerem Register: Exit 0, `n=0`, keine Reservierung.
- [ ] Holen zweimal hintereinander: beim zweiten Mal eine andere Aufgabe oder `n=0`, nie dieselbe.
- [ ] Zurückgeben: Zähler steigt, Reservierung ist gelöst, die Aufgabe taucht wieder in der Liste auf.
- [ ] Abschließen: die Aufgabe verschwindet aus der Liste, der Beleg ist am Eintrag lesbar.

Was du nicht prüfen konntest, schreib als offenen Punkt auf. Ein ungeprüfter Zweig, der als
geprüft gilt, ist teurer als einer, der offen dasteht.
