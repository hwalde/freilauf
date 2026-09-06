# Eine Projektkopie gegen die Vorlage aktualisieren

Der Motor eines Projekts ist eine Kopie, kein Verweis. Das ist gewollt: Ein Projekt darf seinen
Motor ändern, ohne dass ein anderes davon betroffen ist. Der Preis ist Drift — die Vorlage
entwickelt sich weiter, die Kopie bleibt stehen, und irgendwann weiß niemand mehr, welche
Unterschiede Absicht sind und welche Rückstand.

Dagegen hilft eine Zahl und eine Regel. Die Zahl ist `motor_version` in `konfig.json`; sie sagt,
aus welcher Fassung der Vorlage die Kopie stammt. Die Regel: erst diffen, dann übernehmen, nie
blind überschreiben.

## Der Ablauf

### 1. Fassungen vergleichen

```
grep motor_version <zielrepo>/<motor>/konfig.json
grep motor_version <skill-dir>/konzepte/aufgaben-schwarm/vorlage/konfig.beispiel.json
```

Sind beide gleich, ist die Kopie auf dem Stand der Vorlage — jeder Unterschied darunter ist eine
Projektanpassung und bleibt.

### 2. Unterschiede sichtbar machen

```
diff -ru <skill-dir>/konzepte/aufgaben-schwarm/vorlage <zielrepo>/<motor> \
  -x konfig.json -x konfig.beispiel.json -x __pycache__ -x logs
```

Die beiden Konfigs sind ausgenommen: Die eine ist die ausgefüllte Kopie, die andere die Vorlage
mit Platzhaltern — ein Zeilen-Diff darüber ist nur Rauschen. Für sie der Schlüssel-Vergleich:

```
python - <<'PY'
import json, pathlib
a = json.loads(pathlib.Path("<skill-dir>/konzepte/aufgaben-schwarm/vorlage/konfig.beispiel.json").read_text(encoding="utf-8"))
b = json.loads(pathlib.Path("<zielrepo>/<motor>/konfig.json").read_text(encoding="utf-8"))
nur_vorlage = sorted(set(a) - set(b))
nur_projekt = sorted(set(b) - set(a))
print("neu in der Vorlage:", nur_vorlage)
print("nur im Projekt:   ", nur_projekt)
for k in ("repo",):
    if k in a and k in b:
        print(f"  {k}: neu {sorted(set(a[k]) - set(b[k]))} · eigen {sorted(set(b[k]) - set(a[k]))}")
PY
```

Ein Schlüssel, den die Vorlage neu hat, ist der interessante Fall: Er trägt meist eine Fähigkeit,
die es in der Kopie noch nicht gibt.

### 3. Jede Abweichung einordnen

Drei Sorten, und sie werden verschieden behandelt:

| Sorte | woran erkennbar | was zu tun ist |
|---|---|---|
| Rückstand | die Vorlage hat etwas, das die Kopie nicht hat, und nichts im Projekt spricht dagegen | übernehmen |
| Projektanpassung | die Kopie weicht bewusst ab (eigene Prompt-Sätze, eigene Route, eigener Flow-Zweig) | stehen lassen und im Projekt notieren, warum |
| Konflikt | beide haben dieselbe Stelle geändert | von Hand zusammenführen, nicht überschreiben |

Wenn du nicht sagen kannst, welche Sorte vorliegt, ist es keine — dann fehlt die Begründung, und
die holst du dir aus der Projekthistorie (`git log -p <motor>/<datei>`), bevor du etwas anfasst.

### 4. Übernehmen, prüfen, festhalten

```
# nur die Dateien kopieren, die wirklich Rückstand sind — nie den ganzen Ordner
cp <skill-dir>/konzepte/aufgaben-schwarm/vorlage/dispatch.py <zielrepo>/<motor>/dispatch.py

python <motor>/dispatch.py lage
python <motor>/freilauf_einrichten.py --dry-run
python <motor>/freilauf_einrichten.py
python <motor>/freilauf_einrichten.py           # zweiter Lauf: identische Ausgabe?
```

Danach `motor_version` in der Projektkonfig auf die Fassung der Vorlage setzen — aber erst, wenn
die Prüfungen grün sind. Eine hochgesetzte Zahl bei halb übernommener Vorlage ist schlimmer als
gar keine Zahl: Sie behauptet einen Stand, den es nicht gibt.

Trag in das Test-Log des Projekts ein, was du übernommen hast, was du bewusst nicht übernommen
hast und warum.

## Was ausdrücklich nicht passiert

- Kein automatisches Nachziehen. Der Skill schreibt nie in ein Projekt, und kein Lauf zieht sich
  eine neue Motor-Fassung selbst.
- Kein Überschreiben von `konfig.json`. Sie gehört dem Projekt. Neue Schlüssel der Vorlage werden
  einzeln eingesetzt, mit ihrem Erklärungs-Schlüssel daneben.
- Kein Überschreiben angepasster Prompts. Ein Prompt, in dem das Projekt eigene Sätze stehen hat,
  wird zusammengeführt, nicht ersetzt — sonst verschwindet eine Regel, die jemand aus einem
  Fehlschlag gelernt hat.

## Wenn das Projekt die Vorlage überholt

Es kommt vor, dass eine Projektkopie etwas löst, das alle Kopien betrifft. Dann geht die
Änderung den umgekehrten Weg: zurück in die Vorlage im Skill, mit erhöhter `motor_version` in
`konfig.beispiel.json`, und mit einem Satz im Konzept, der sagt, was sich geändert hat. Erst
danach ziehen die anderen Projekte nach. Eine Verbesserung, die nur in einer Kopie lebt, ist für
jede andere unsichtbar.

## Bekannte Abweichungen der Vorlage vom ersten Bau

Die Vorlage stammt aus dem Motor-Ordner des Ursprungsprojekts (Fassung 1.4.0, 2026-09-05).
Gegenüber dem Original ist sie an fünf Stellen verallgemeinert. Wer die beiden diffed, findet
diese fünf — und sonst nur Projektanpassungen. Steht in einem Diff etwas anderes, ist eine der
beiden Seiten hinter der anderen zurück, und der Rückstand gehört behoben statt erklärt:

- Der Ordnername wird aus dem eigenen Pfad gelesen (`MOTOR`), statt fest `schwarm` zu heißen.
- Kein Pfad auf ein projekteigenes `platform_support`-Modul mehr; wer eines hat, zeigt mit der
  Umgebungsvariable `SCHWARM_PLATFORM_SUPPORT` darauf, sonst greift der schlanke Ersatz.
- Beide Skripte kennen `--konfig <datei>` und prüfen vor dem ersten Zugriff, ob noch Platzhalter
  in der Konfig stehen; sie brechen dann mit der Liste der offenen Schlüssel ab.
- Der Prompt des PO-Agenten wird gerendert wie der Worker-Prompt; seine fünf Kommandos kommen aus
  dem Block `repo`, statt im Prompt zu stehen.
- Der Zustandsordner heißt im Ursprungsprojekt nach dessen Repo-Slug; in der Vorlage ergibt ihn
  `repo.name` aus der Konfig. Beide bilden dieselbe Regel ab — ein Ordner je Projekt.

Was 1.4.0 gegenüber 1.3.0 geändert hat — eine Rechnung, die niemand aufgemacht hatte:

Die starke Bahn hatte zwei eigene Agenten und eine Quoten-Frage davor: eine Abo-Route
(Claude Code), solange deren Wochennutzung unter der Schwelle lag, sonst ein teureres
Ausweich-Modell über OpenRouter. Beides ist entfallen. Der Grund steht in den Lauf-Kosten des
Hubs (`fl-api /api/runs?repo=<n>&archived=1`, Feld `cost_usd`, gemessen 2026-09-05): Zehn Läufe
der starken Bahn kosteten 86,61 USD, also 8,66 USD je Lauf, gegen 0,14 USD in der gewöhnlichen
Bahn — das 62-Fache für zwei Punkte Abstand im Artificial Analysis Intelligence Index (59 gegen
57). Ein einzelner entgleister Lauf verbrannte davon 72,66 USD, endete `aborted` und mergte
nichts; auch ohne ihn bleibt das Elffache. Die Abo-Route kam nie zum Zug, weil ihre Wochenquote
durchgehend belegt war — sie war ein Jahr lang Theorie und hat nie eine Aufgabe angefasst.

- **Ein Modell für beide Bahnen.** Die starke Bahn behält ihre Berechtigung, aber nicht ihr
  Modell: Ihr Wert steckt in der Arbeitsweise — genau eine Aufgabe je Lauf, das ganze
  Zeitbudget, und als einzige Bahn Zugriff auf Blockiertes. Aus zwei starken Agenten wird einer,
  `Schwarm-Worker (stark)`, auf der neuen Route `stark`. Er nennt bewusst kein Modell im Namen,
  damit ein späterer Wechsel den Namen nicht zur Lüge macht.
- **Neuer Regler `stark_modell`** (Route `stark` zieht ihn über `modell_regler`) — die eine
  Stelle für einen Modellwechsel. Vorgabe ist dasselbe Modell wie in der gewöhnlichen Bahn. Wer
  wechselt, prüft `routen.stark.or_provider` mit: Dort steht ein fester Anbieter, der zum neuen
  Modell passen muss.
- **Entfallene Regler:** `fable_7d_max`, `claude_5h_max`, `stark_ausweich_modell` und die Routen
  der beiden alten starken Agenten. `dispatch.py` liest damit gar keine Nutzungszahlen mehr
  (`claude_quota()` ist ersatzlos weg), und aus der Schlusszeile von `lage` fallen
  `stark_route`, `fable_7d_prozent` und `fable_7d_alter_s`. `stark_starts_soll` bleibt und ist
  weiterhin 0 oder 1.
- **`lage` unterscheidet die Bahnen jetzt an der Marke `stark` aus der Konfig**, nicht mehr am
  Routennamen. Das war vorher am Modell ablesbar und ist es nicht mehr, seit beide Bahnen
  dasselbe fahren.
- **Die gelbe Tages-Ampel schaltet weiterhin die starke Bahn ab** — aber aus einem anderen
  Grund, und der steht jetzt dabei: nicht weil sie die teure wäre, sondern weil sie je Lauf am
  wenigsten schließt (eine Aufgabe, höchstens einer gleichzeitig). Wird das Geld knapp, läuft
  zuerst weiter, was mehr Aufgaben je Dollar erledigt.

So zieht ein bestehendes Projekt nach:

1. `vorlage/dispatch.py`, `vorlage/freilauf_einrichten.py`, `vorlage/prompts/dispatcher.md` und
   `vorlage/flows/takt-soll.json` übernehmen.
2. In der eigenen `konfig.json`: die beiden starken Worker-Einträge durch einen ersetzen
   (`schluessel` und `route` je `stark`), die Route `stark` anlegen, `stark_modell` setzen,
   `fable_7d_max`, `claude_5h_max` und `stark_ausweich_modell` löschen und die alten Agenten-
   Namen in `_abgeloeste_agenten` eintragen.
3. `freilauf_einrichten.py --dry` fahren und prüfen, dass genau ein starker Worker angelegt und
   die zwei alten als abgelöst gemeldet werden; dann scharf mit `--aufraeumen`.
4. `motor_version` auf `1.4.0` setzen — erst danach.

Was 1.3.0 gegenüber 1.2.0 geändert hat — die zweite Ursache derselben Doppelarbeit, und sie
hat mit der Reservierung nichts zu tun:

Gemessen im Ursprungsprojekt wurden 23 Aufgaben von mindestens zwei Läufen angefasst, in 15
überlappenden Lauf-Paaren, davon 7 mit weniger als vier Minuten Startabstand; zwei
Merge-Commits mussten parallele Notizen derselben Datei zusammenführen, und eine Aufgabe
durchlief binnen einer Stunde fünf Läufe und landete beim Menschen, obwohl nur ein
Richtungs-Entscheid fehlte. Die Reservierung war daran unschuldig — sie ist atomar. Schuld war
ein Zeitfenster: Fehlversuch und Notiz eines Laufs erreichen den Basis-Branch erst beim Merge,
und bis dahin sah jeder andere Worker eine freie, unveränderte Aufgabe. Das ist unabhängig von
der `--lokal`-Krücke aus 1.2.0; beide belegten Fälle traten nach deren Entfernung auf.

- **Die Zuweisung überlebt die Rückgabe.** Sie wird nicht gelöscht, sondern wechselt den
  Zustand: Solange der zuweisende Lauf lebt oder sein Ergebnis noch nicht auf dem Basis-Branch
  sichtbar ist, wird die Aufgabe niemandem angeboten; ist es sichtbar, ist sie sofort und
  stillschweigend wieder frei. Der Worker-Prompt erklärt das im Rückgabe-Abschnitt und verbietet
  ausdrücklich, die Sperre mit einem Erzwingen-Schalter zu umgehen.
- **Neuer Konfig-Schlüssel `aufgabe_freigeben_sofort`** — Rückgabe ohne bleibende Zuweisung, für
  den einen Fall, in dem ein Lauf die Aufgabe gar nicht angefasst hat (geholt, dann einen
  gesetzten Wartestatus gesehen). Der Riegel im Worker-Prompt benutzt jetzt diesen Schlüssel.
  Fehlt er, rendert der Prompt `aufgabe_freigeben` — für eine Aufgabenquelle ohne nachwirkende
  Zuweisung ist das die richtige Fassung.
- **Neuer Agent „Schwarm-Aufräumer"** samt `prompts/aufraeumer.md`, für den Fall, dass ein Lauf
  mit seiner Zuweisung verschwindet. Er repariert nichts: Er stellt je hängender Zuweisung fest,
  was aus dem Lauf wurde, hält verlorene Messungen als Notiz an der Aufgabe fest und löst die
  Zuweisung mit Beleg. Konfig: `aufraeumer_name`/`_route`/`_minuten`/`_max_parallel`, dazu die
  vier Kommandos `zuweisungen_alt_json`, `lauf_zustand`, `lauf_bericht`, `zuweisung_loesen`.
  Warum ein eigener Agent statt einer Regel im Worker-Prompt: die Entwurfsregel in `KONZEPT.md`.
- **Die Aufräum-Leiter hat genau zwei Sprossen, und ein Verzeichnis erzwingt das.** Ab
  `zuweisung_alt_stunden` genau EIN Aufräum-Lauf je Aufgabe, danach — nach
  `zuweisung_melde_stunden` — EINE Meldung an einen Menschen, dann Ruhe. Vorgemerkt wird in
  `aufraeum_laeufe.json` im Zustandsordner; ohne dieses Verzeichnis schickt jeder Takt einen
  weiteren Agenten auf denselben Fall.
- **`dispatch.py`**: neuer Unterbefehl `aufraeumer` (mit `--vormerken` und `--gemeldet`), neue
  Felder in der Schlusszeile von `lage` (`zuweisungen_alt`, `zuweisungen_ohne_lauf`,
  `zuweisungen_meldereif`, `zuweisungen_messbar`, `aufraeumer_da`, `melden_da`,
  `laufend_aufraeumer`). Ist die Zählung nicht möglich, stehen beide Flags auf 0: Eine Messung,
  die nicht gelang, weckt keinen Agenten und piept keinen Menschen an.
- **`lage` räumt vor dem Zählen hängende Reservierungen auf** (`belegungen_aufraeumen`, leer
  lassen erlaubt). Das ist die einzige Stelle, die in jedem Takt läuft: Eine hängende
  Reservierung blendet ihre Aufgabe aus der Zählung aus, `arbeit_da` liest 0, und der
  Dispatcher, der es heilen könnte, wird gar nicht erst geweckt. Ein Fehlschlag ist folgenlos.
- **Der Wächter-Flow hat zwei neue Zweige**, beide auf Flags derselben Schlusszeile:
  `aufraeumer_da=1` merkt vor und weckt den Aufräumer (mit `count_runs`-Deckel), `melden_da=1`
  setzt den Melde-Vermerk und schickt ein `notify` an einen Menschen.

So zieht ein bestehendes Projekt nach:

1. `vorlage/dispatch.py`, `vorlage/freilauf_einrichten.py`, `vorlage/flows/takt-soll.json` und
   `vorlage/prompts/aufraeumer.md` übernehmen; in `prompts/worker.md` nur die zwei geänderten
   Stellen zusammenführen (der Riegel bei gesetztem Wartestatus benutzt jetzt
   `{{AUFGABE_FREIGEBEN_SOFORT}}`, und der Rückgabe-Abschnitt erklärt die Zuweisung).
2. In die eigene `konfig.json` einsetzen: `aufgabe_freigeben_sofort`, `belegungen_aufraeumen`,
   die vier Aufräum-Kommandos, den Agenten-Block `aufraeumer_*` und die zwei Schwellen
   `zuweisung_alt_stunden` / `zuweisung_melde_stunden`.
3. Prüfen, ob das eigene Aufgaben-Werkzeug die nötigen Optionen hat (Rückgabe ohne Nachwirkung,
   alte Zuweisungen auflisten, fremde Zuweisung mit Beleg lösen). Fehlt eines, lass den
   zugehörigen Konfig-Schlüssel leer — der Motor bleibt an dieser Stelle still, statt laut zu
   scheitern — und trag die Folge in die Grenzen des Projekts ein.
4. `dispatch.py lage` fahren und `zuweisungen_messbar` ansehen, dann
   `freilauf_einrichten.py --dry-run`, dann scharf, dann ein zweites Mal auf Idempotenz.
5. `motor_version` auf `1.3.0` setzen — erst danach.

Was 1.2.0 gegenüber 1.1.0 geändert hat — drei Lehren aus der ersten durchgelaufenen Nacht
(49 Läufe, und die Zahl der Fragen an den Menschen stieg von 14 auf 28):

- **Zeit ist kein Fehlversuch.** Worker gaben Aufgaben zurück, weil sie nicht in 45 Minuten
  passten. Beim dritten solchen Rückgeben schiebt das Register den Eintrag zu einem Menschen —
  der bekommt dann eine Frage vorgelegt, die keine ist. `worker_minuten` und `stark_minuten`
  stehen jetzt auf 300, und der Worker-Prompt trägt die eigentliche Regel: Große Aufgaben
  werden zerlegt und in Teilschritten committet, ein Fehlversuch wird nur protokolliert, wenn
  ein inhaltlicher Reparaturweg nachweislich gescheitert ist. Läuft die Zeit aus: Zwischenstand
  committen, notieren, freigeben — ohne Fehlversuch. Dafür gibt es den neuen Konfig-Schlüssel
  `aufgabe_freigeben`.
- **Kein `--lokal` mehr in den Register-Kommandos.** Die Krücke stammte aus einem längst
  reparierten Fehler und ließ jeden Worker nur seinen eigenen Worktree sehen. Folge: Drei Läufe
  zogen nacheinander dieselben zwei Aufgaben und eskalierten sie dreimal an den Menschen. Der
  `aufgaben_hinweis` sagt jetzt das Gegenteil (`git fetch origin` vor dem Holen), und der
  Worker-Prompt hat einen harten Riegel: Trägt der Eintrag nach dem Belegen ein `wartet_auf`,
  wird er sofort freigegeben — kein Fehlversuch, keine Zeile Code.
- **Der Dispatcher wartet nie auf seine Worker.** Er startet, protokolliert, endet; die
  Rückmeldung liefert der Nachlauf-Flow. Stand in den Flows schon so (`wait: false`), fehlte
  aber als Satz im Prompt.

Was 1.1.0 gegenüber 1.0.0 geändert hat, und warum es beim Nachziehen nicht fehlen darf:

- **Eigener Checkout für die Cron-Flows.** 1.0.0 ließ das `shell_command` im Repo-Pfad aus dem
  Hub laufen — dem Arbeits-Checkout des Menschen. Freilauf zieht den nie nach; er stand im
  Ursprungsprojekt auf einem alten Commit ohne Motor-Ordner, und der Schwarm lief zwei Takte
  lang ins Leere. 1.1.0 klont einen eigenen, detached Checkout (`flow_checkout`) und zieht ihn
  bei jedem Takt selbst nach.
- **Zustandsordner je Projekt.** 1.0.0 legte `hub_ids.json`, `HALT` und `journal.jsonl` in einen
  globalen Ordner. Ein zweites Projekt auf derselben Maschine überschrieb damit die Agenten-IDs
  des ersten, und dessen Dispatcher startete fremde Worker. 1.1.0 hängt den Projekt-Slug an.
- **Versuchs-Deckel aus der Konfig** (`versuchs_deckel`) statt als Konstante, und die starke
  Bahn zählt einschließlich des Deckels — sonst bleibt eine vom Menschen wieder freigegebene
  Aufgabe für immer liegen.
- **Der Motor-Ordnername ist auch in Flows und Prompt eine Marke** (`@MOTOR_ORDNER@`,
  `{{MOTOR_ORDNER}}`). Vorher stand dort das Literal, und ein umbenannter Ordner ergab einen
  Wächter, der bei jedem Takt in den `notify`-Zweig fiel.
