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
| `aufgabe_zurueckgeben` | Fehlversuch mit Grund protokollieren und die Aufgabe zurückgeben; die Zuweisung bleibt bestehen | ja |
| `aufgabe_freigeben` | die Reservierung lösen, ohne einen Fehlversuch zu protokollieren | ja |
| `aufgabe_freigeben_sofort` | zurückgeben OHNE bleibende Zuweisung — für eine Aufgabe, die dieser Lauf gar nicht angefasst hat | nein |
| `belegungen_aufraeumen` | Reservierungen lösen, deren Lauf es nachweislich nicht mehr gibt | nein |
| `zuweisungen_alt_json`, `lauf_zustand`, `lauf_bericht`, `zuweisung_loesen` | der Aufräum-Zweig | nein, aber alle vier oder keines |
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

## 4b. Die Zuweisung — die Stelle, die erst nach Wochen wehtut

Atomar reservieren reicht nicht. Die zweite Hälfte des Problems ist zeitversetzt und deshalb
schwer zu sehen: Ein Worker gibt eine Aufgabe mit Fehlversuch und Notiz zurück, aber wenn deine
Aufgaben im Repository liegen, steht beides bis zum Lauf-Ende nur in seinem Worktree und
erreicht den Basis-Branch erst beim Merge — Minuten bis Stunden später. Ist die Aufgabe sofort
wieder frei, zieht der nächste Worker sie im unveränderten Zustand und misst dieselbe Sache noch
einmal. Im Ursprungsprojekt traf das 23 Aufgaben in 15 überlappenden Lauf-Paaren; eine davon
durchlief binnen einer Stunde fünf Läufe und landete beim Menschen, obwohl nur ein
Richtungs-Entscheid fehlte.

Der Vertrag verlangt deshalb dreierlei — oder das ausdrückliche Eingeständnis, dass es fehlt:

1. **Eine Zuweisung, die die Rückgabe überlebt.** Sie wird bei der Rückgabe nicht gelöscht,
   sondern wechselt den Zustand: Solange der zuweisende Lauf lebt oder sein Ergebnis noch nicht
   sichtbar ist, wird die Aufgabe niemandem angeboten.
2. **Auflösung am nachweisbaren Ergebnis, nicht an einer Uhr.** Ist das Ergebnis des Laufs auf
   dem Basis-Branch (oder im Ticket-System) sichtbar, ist die Aufgabe sofort und stillschweigend
   wieder frei. Eine Zuweisung, die nur nach Ablauf einer Frist fällt, gibt die Aufgabe entweder
   zu früh frei oder hält sie zu lange fest — beides nach Zufall.
3. **Alte Zuweisungen müssen auffindbar sein** (`zuweisungen_alt_json`), sonst gibt es keinen
   Weg zurück, wenn ein Lauf mit seiner Zuweisung verschwindet. Dazu die drei Kommandos, mit
   denen der Aufräum-Agent den Fall klärt: Zustand des Laufs, sein Bericht, und das Lösen einer
   fremden Zuweisung mit Beleg.

Kannst du das nicht bieten, ist das kein Ausschlusskriterium, aber eine Bringschuld: Schreib in
die Grenzen deines Adapters, dass zwei Läufe dieselbe Aufgabe NACHEINANDER bearbeiten können,
und nenne das Zeitfenster als Grund. Prüfe dabei zuerst, ob dein Fenster überhaupt existiert:
Schreibt dein Werkzeug Fehlversuch und Notiz sofort dorthin, wo alle Läufe sie sehen — ein
Ticket-System etwa —, gibt es keinen Verzug zwischen Schreiben und Sichtbarwerden, und der ganze
Abschnitt betrifft dich nicht. Das Fenster entsteht durch den Merge, nicht durch die Rückgabe.

## 4c. „Lebt der Lauf noch?“ hat drei Antworten, nicht zwei

Eine Zuweisung darf sich auflösen, wenn der Lauf, der sie hält, beendet ist. Wer das prüft,
fragt meist ein anderes System — den Hub, ein Ticketsystem, die Prozessliste. Dieses System
kann aber auch schweigen: Es ist gerade nicht erreichbar, die Kennung ist ihm unbekannt, die
Anfrage läuft in eine Zeitüberschreitung.

Behandle dieses Schweigen niemals als „beendet“. Sonst löst eine einzige Störung des
befragten Systems auf einen Schlag jede Zuweisung, alle Aufgaben werden gleichzeitig wieder
vergeben, und genau die Doppelarbeit ist zurück, gegen die die Zuweisung gebaut wurde. Der
Vertrag lautet deshalb: lebt, beendet, unbekannt. Bei unbekannt bleibt die Zuweisung stehen,
und es entscheidet die Stunden-Decke, nicht eine Vermutung.

Dieser Fehler ist im Ursprungsprojekt am 2026-09-04 gebaut und noch vor dem ersten Schaden
gefunden worden: Das Prüf-Skript meldete korrekt einen dritten Code für „nicht beantwortet“,
und die aufrufende Seite warf ihn mit „beendet“ in einen Topf.

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
- [ ] Zurückgeben: Zähler steigt, und die Aufgabe wird NICHT sofort wieder angeboten,
      solange das Ergebnis des Laufs nicht sichtbar ist (führt dein Werkzeug keine
      nachwirkende Zuweisung, notiere hier stattdessen, dass sie sofort wieder in der
      Liste steht — und trag die Folge in die Grenzen ein).
- [ ] Zurückgeben ohne Nachwirkung (`aufgabe_freigeben_sofort`): die Aufgabe steht
      sofort wieder in der Liste.
- [ ] Alte Zuweisungen finden: `zuweisungen_alt_json` liefert gültiges JSON mit Aufgaben-
      und Lauf-Kennung, und `dispatch.py lage` meldet `zuweisungen_messbar=1`.
- [ ] Abschließen: die Aufgabe verschwindet aus der Liste, der Beleg ist am Eintrag lesbar.

Was du nicht prüfen konntest, schreib als offenen Punkt auf. Ein ungeprüfter Zweig, der als
geprüft gilt, ist teurer als einer, der offen dasteht.
