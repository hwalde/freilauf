# Der Aufgaben-Schwarm — Betriebsanleitung des Motors in diesem Ordner

Diese Datei gehört zur Projektkopie und beschreibt den laufenden Betrieb. Wie der Ordner
überhaupt hierher kommt, steht im Skill `freilauf-agent-flow-builder`
(`konzepte/aufgaben-schwarm/EINRICHTEN.md`); die Begründungen hinter dem Aufbau stehen dort in
`KONZEPT.md`.

Der Schwarm ist kein eigenes Agenten-System. Er besteht aus gewöhnlichen Freilauf-Agenten,
sichtbar im Hub unter „Agenten" beim Repository, mit eigenem Prompt und angehängtem Flow. Alles,
was Freilauf schon kann — Cron im Flow, `/agents/start` für die Skalierung, `delay` als
Zeitversatz, `extract` zum Lesen des Reports, `notify` für Meldungen —, macht Freilauf. Selbst
gebaut ist nur, was Freilauf nicht wissen kann: wie viele Aufgaben in diesem Repository offen
sind.

## Die Besetzung

| Agent | Takt | Wofür |
|---|---|---|
| Worker (gewöhnlich) | manuell — der Dispatcher startet ihn | trivial und normal, die Regel |
| Worker (billiger Spezialist) | manuell — der Dispatcher startet ihn | nur trivial |
| Worker (stark, Abo-Route) | manuell — der Dispatcher startet ihn | blockiert oder zweimal gescheitert |
| Worker (stark, Ausweich-Route) | manuell — der Dispatcher startet ihn | dasselbe, wenn die Abo-Route nicht darf |
| Dispatcher | manuell — der Wächter-Takt und der Nachlauf wecken ihn | rechnet und startet |
| Aufräumer | manuell — der Wächter-Takt weckt ihn, wenn eine Zuweisung hängt | klärt, was aus einem verschwundenen Lauf wurde; repariert nichts |
| PO-Agent (optional) | manuell — der PO-Takt weckt ihn | trägt die offenen Fragen einem Menschen vor |

Namen, Routen, Modelle und Zeitbudgets stehen in `konfig.json`. Kein Agent hat einen eigenen
Cron. Den Takt geben zwei Flows:

| Flow | Cron | tut |
|---|---|---|
| Schwarm-Takt (ohne LLM, count_runs) — der Wächter | `0 */2 * * *` | zählt die Lage per Shell; weckt den Dispatcher nur, wenn Arbeit da ist; weckt den Aufräumer bei `aufraeumer_da=1` und meldet einen Menschen bei `melden_da=1` |
| Schwarm-PO-Takt | `0 4 * * *` | weckt den PO-Agenten nur, wenn eine Frage offen ist |
| Schwarm-Nachlauf | `run_finished` | an allen Workern; weckt den Dispatcher nach einem Worker mit Fortschritt |

## Der Lebenszyklus — keine Aufgabe bleibt liegen

| Zustand einer Aufgabe | wer holt sie | was danach passiert |
|---|---|---|
| frei, trivial oder normal, 0 Versuche | gewöhnlicher Worker | geschlossen (repariert oder gegenstandslos) — oder mit Notiz zurückgegeben, Versuche +1 |
| frei, 1 Versuch | wieder die gewöhnliche Bahn | zweiter Anlauf mit der Notiz des ersten |
| blockiert, oder 2 Versuche | der eine starke Worker | ein Fall, volles Zeitbudget, keine Paketbildung |
| dritter Fehlversuch | niemand mehr | das Register setzt selbst die Marke „wartet auf PO" |
| wartet auf PO | der PO-Agent, täglich | Report an den Menschen mit nummerierten Optionen; er antwortet mit „1a, 2c" |
| Entscheid liegt vor | derselbe Agent, dieselbe Sitzung | Notiz mit dem Entscheid, Marke lösen — die Aufgabe ist wieder frei und fällt in Zeile 1 zurück |
| auch nach dem Entscheid nicht automatisierbar | niemand | Marke „wartet auf Mensch", mit der Begründung im Report |

Der Kreis schließt sich: Jede Zeile endet entweder in „geschlossen" oder in der nächsten Zeile.
Es gibt keinen Zustand, aus dem heraus nichts mehr geschieht — außer „Mensch", und der trägt
seinen Grund mit sich.

## Leerlauf kostet nichts

Kein Agent hat einen Cron. Der einzige Takt ist der Wächter-Flow, und er ist ein Shell-Aufruf
plus eine Bedingung — kein LLM. Ist nichts zu tun, schreibt er eine Notiz und ist fertig: null
Agenten-Läufe, null Token. Der Wächter startet auch dann keinen Worker, wenn Arbeit da ist: Er
weckt nur den Dispatcher. Welcher Worker, wie viele und auf welcher Route — das ist Triage- und
Quoten-Arbeit, und sie gehört an eine Stelle, nicht in zwei Bedingungs-Leitern, die
auseinanderlaufen.

Der Wächter darf nicht blind werden. Kann `dispatch.py lage --json` nicht laufen, fehlt
`arbeit_da=1` in der Ausgabe — und eine Bedingung auf einen fehlenden Wert liest sich genau wie
„nichts zu tun". Der Flow prüft deshalb zuerst `{{vars.lage.ok}}` und meldet den Ausfall per
`notify`, statt still in den Leerlauf-Zweig zu fallen.

## Die starke Bahn — Ausnahme, nicht Regel

Die gewöhnliche Route löst den Großteil der Aufgaben allein; darauf ist der Schwarm ausgelegt.
Die starke Bahn greift nur, wo das nachweislich nicht reicht: bei einer als blockiert
eingetragenen Aufgabe, und bei einer, an der die gewöhnliche Bahn schon zweimal gescheitert ist.
Höchstens ein starker Worker läuft gleichzeitig.

Welche der beiden starken Routen fährt, entscheidet die Abo-Wochennutzung, und `dispatch.py
lage` rechnet es aus (`stark_route`):

| `stark_route` | wann |
|---|---|
| `fable` | Abo-Woche unter `fable_7d_max`, Zahl belastbar, 5-Stunden-Fenster unter `claude_5h_max` |
| `gemini` | Abo-Woche darüber, keine Zahl da, oder die Zahl als stale gemeldet |
| `keine` | nichts Schweres frei, schon einer in der Luft, Tages-Ampel nicht grün, oder Halt |

Gemessen wird das Wochenfenster mit dem Abo-Label aus `fl-api /api/usage` (`weekly_scoped`),
nicht `seven` — `seven` ist das Maximum aller Wochenfenster und beantwortet eine andere Frage.
Jede Zahl kommt mit ihrem Alter. Eine als stale gemeldete Zahl gilt als nicht belastbar: Direkt
nach einem Reset kann der erinnerte Wert noch der alte sein, und wer darauf einen Abo-Start
baut, kauft sich ein `deferred`. Widersprechen sich `lage` und der Skill `freilauf-stats`, gilt
die konservativere Sicht.

## Zuweisung: das Zeitfenster zwischen Rückgabe und Merge

Die Reservierung ist atomar; das Problem sitzt woanders. Ein Worker gibt eine Aufgabe mit
Fehlversuch und Notiz zurück, aber beides erreicht den Basis-Branch erst, wenn sein Lauf endet
und Freilauf mergt — Minuten bis Stunden später. Bis dahin sähe jeder andere Worker eine freie,
unveränderte Aufgabe, maße dieselbe Sache noch einmal nach und zählte den Zähler ein zweites
Mal hoch. Im Ursprungsprojekt wurden so 23 Aufgaben von mindestens zwei Läufen angefasst, in 15
überlappenden Lauf-Paaren, davon 7 mit weniger als vier Minuten Startabstand; eine davon lief
binnen einer Stunde durch fünf Läufe und landete beim Menschen, obwohl nur ein Richtungs-Entscheid
fehlte.

Die Antwort ist eine Zuweisung, die die Rückgabe überlebt. Sie wird nicht gelöscht, sondern
wechselt den Zustand: Solange der zuweisende Lauf lebt oder sein Ergebnis noch nicht auf dem
Basis-Branch sichtbar ist, wird die Aufgabe niemandem angeboten; ist es sichtbar, ist sie sofort
und stillschweigend wieder frei. Eine Ausnahme bleibt gewollt: Was ein Lauf gar nicht angefasst
hat (geholt, dann einen gesetzten Wartestatus gesehen), geht ohne Nachwirkung zurück
(`aufgabe_freigeben_sofort`) — sonst hielte eine Zuweisung eine Aufgabe fest, an der niemand
gearbeitet hat.

### Wenn ein Lauf mit seiner Zuweisung verschwindet

Der teure Restfall: Der Lauf stürzt ab, oder sein Ergebnis kommt nie an. Dann überlebt die
Zuweisung ihn, und die Aufgabe ist nicht erledigt, sondern unsichtbar — und niemand merkt es.
Dagegen die Aufräum-Leiter mit genau zwei Sprossen: Ab `zuweisung_alt_stunden` weckt der
Wächter-Flow EINMAL den Aufräum-Agenten für diese Aufgabe; hängt sie `zuweisung_melde_stunden`
später immer noch, wird kein zweiter Agent geschickt, sondern per `notify` ein Mensch
benachrichtigt — einmal, danach ist Ruhe. Wofür schon ein Aufräum-Lauf startete und was
gemeldet wurde, steht in `aufraeum_laeufe.json` im Zustandsordner. Ohne dieses Verzeichnis
schickt jeder Takt einen weiteren Agenten auf dieselbe Zuweisung; das Verzeichnis IST die Regel
„je Aufgabe genau ein Aufräum-Lauf".

Was die Leiter nicht löst: Beide Schwellen sind Schätzungen. Dauert ein Merge länger als
`zuweisung_alt_stunden`, läuft ein Aufräumer auf eine völlig intakte Zuweisung — er erkennt das
(der Lauf lebt noch) und lässt sie in Ruhe; es kostet einen Lauf, nicht die Aufgabe. Und ist die
Zählung nicht möglich, meldet `lage` `zuweisungen_messbar=0` und beide Flags bleiben 0: Eine
Messung, die nicht gelang, weckt keinen Agenten und piept keinen Menschen an — ein hängender
Eintrag bliebe dann hängen, sichtbar nur in der Ausgabe von `lage`.

## Skalierung, Deckel, Budget

Skaliert wird über die Zahl der Starts, nicht über Ein- und Ausschalten. Der Dispatcher startet
denselben Worker-Agenten mehrfach; jeder Start ist ein eigener Freilauf-Lauf mit eigenem
Worktree und eigener tmux-Sitzung. Zwischen zwei Starts liegen `versatz_minuten` Minuten — der
Zeitversatz verhindert, dass zwei Worker im selben Moment nach derselben Aufgabe greifen; die
atomare Reservierung des Registers fängt den Rest ab.

Die Staffel steht in `konfig.startstufen` (Vorgabe: 1–3 Aufgaben ⇒ 1 Start, 4–8 ⇒ 2, ab 9 ⇒ 3).
Der billige Spezialist bekommt seinen Platz vor den gewöhnlichen Starts, sonst schöpft die
Staffel den Deckel regelmäßig allein aus. Über allem steht `max_worker` abzüglich der schon
laufenden Schwarm-Läufe; `lage` liefert die Zahlen bereits gedeckelt — wer sie startet, kann den
Schwarm nicht aufschaukeln.

Ein Worker bekommt keine Aufgabenliste zugeteilt, er bedient sich selbst: Der gewöhnliche holt
sich eine Aufgabe und füllt je nach Schwere bis zur `paketgroesse` auf, der starke holt sich
genau eine. Findet ein Worker nichts, meldet er sich sofort mit einem Ein-Zeilen-Report fertig —
das ist der gewollte Normalfall bei leerem Register, nicht ein Fehlschlag.

Was deckelt:

- `budgets` — die Guthaben-Schwellen je Anbieter, absichtlich über Freilaufs eigenem Budget-Gate;
- `tages_budget_usd` — die Tagessumme über alle Schwarm-Läufe, Worker wie Dispatcher. Gelb
  heißt: starke Bahn aus. Rot heißt: gar keine Starts. Die Zahl zählt nur Läufe der
  Schwarm-Agenten; alles andere am selben Schlüssel sieht sie nicht. Setze sie weit: Sie ist
  ein Netz gegen das Verrennen, keine Abrechnung;
- `fable_7d_max` — der Deckel für den Abo-Verbrauch, der in keiner USD-Zahl auftaucht;
- `max_worker` für die gewöhnliche Bahn, `stark_max_parallel` für die starke.

## Was wo liegt

| Datei | wofür |
|---|---|
| `konfig.json` | alle Regler. Der Block `repo` trägt alles Repo-Spezifische — die Kommandos auf das Aufgaben-Register plus die Gates |
| `dispatch.py` | `lage` (zählen und die Staffel rechnen) · `aufraeumer` (hängende Zuweisungen, Vormerk-Verzeichnis) · `stopp`/`weiter` (Not-Halt) · `journal` |
| `prompts/worker.md` | die Vorlage aller Worker-Prompts; `freilauf_einrichten.py` rendert die Kommandos aus `konfig.repo` hinein und den Hol-Ablauf je Bahn |
| `prompts/dispatcher.md` | der Prompt des Dispatchers |
| `prompts/aufraeumer.md` | der Prompt des Aufräumers; seine vier Kommandos kommen aus `konfig.repo` |
| `prompts/po-praesentation.md` | der Prompt des PO-Agenten, ebenfalls gerendert |
| `flows/nachlauf.json` | `run_finished`-Flow, an alle Worker angehängt; deckelt per `count_runs` |
| `flows/takt-soll.json` | der Wächter: der einzige Takt, LLM-frei |
| `flows/po-takt.json` | weckt den PO-Agenten, wenn eine Frage offen ist |
| `freilauf_einrichten.py` | legt Agenten und Flows an bzw. schreibt sie zurück; idempotent |
| `lauf_lebt.py` | Haken für die Aufgabenquelle: lebt dieser Lauf noch? Exit 0 = ja. Gesetzt im Aufräum-Kommando der Konfig |

Zustand außerhalb von git — `~/agents/schwarm/<projekt-slug>/` (überschreibbar per `SCHWARM_STATE_DIR`), vier
Dateien: `hub_ids.json` (Agent- und Flow-IDs; der Dispatcher liest sie), `journal.jsonl`
(eine Zeile je Halt-Schaltung), `aufraeum_laeufe.json` (je Aufgaben-Kennung: wann ein Aufräum-Lauf
startete und wann gemeldet wurde) und `HALT`.

## Bedienung

```
python <motor>/dispatch.py lage                 # was offen ist, wer läuft, was zu starten ist
python <motor>/dispatch.py lage --json
python <motor>/dispatch.py aufraeumer            # hängende Zuweisungen, ohne etwas zu ändern
python <motor>/dispatch.py journal --letzte 20

python <motor>/freilauf_einrichten.py --zeige   # Ist-Zustand im Hub
python <motor>/freilauf_einrichten.py --dry-run # alles rechnen, nichts schreiben
python <motor>/freilauf_einrichten.py           # anlegen bzw. aktualisieren (idempotent)
python <motor>/freilauf_einrichten.py --aufraeumen   # abgelöste Vorgänger-Agenten löschen
```

Not-Halt:

```
python <motor>/dispatch.py stopp     # Worker-Agenten aus, `lage` meldet 0 Starts
python <motor>/dispatch.py weiter    # zurück
```

`stopp` beendet keine laufenden Läufe. Es setzt den HALT-Marker — der zieht in `lage` alle
Startzahlen und beide Wecken-Flags auf 0, sodass Wächter, Nachlauf und Dispatcher gleichermaßen
still bleiben — und schaltet zusätzlich die Worker-Agenten ab, damit auch ein Start von Hand
nicht durchkommt. Einen laufenden loswerden: `fl-kill <short-id>`; `stopp` druckt die Zeilen
dafür gleich mit. Einen der Cron-Flows abzuschalten ist der falsche Griff — `freilauf_einrichten.py`
schaltet sie beim nächsten Lauf wieder ein, und zwar mit Absicht: Sie sind der einzige Antrieb,
und ein vergessenes „aus" hielte den Schwarm für immer an, ohne dass jemand sähe warum.

Zusehen:

```
fl-api /api/runs repo=<id> status=running     # wer arbeitet
fl-api /api/flows                             # die Flows und ihr Schaltzustand
<das Belegungs-Kommando aus konfig.repo>      # wer welche Aufgabe reserviert hält
```

## Grenzen

- Die Reservierung ist so gut wie das Register. Ist sie maschinenlokal (Dateisperre im
  Home-Verzeichnis), sieht ein Schwarm auf einer zweiten Maschine sie nicht. Folge ist
  Doppelarbeit, nie Datenverlust.
- Im Worker-Prompt steht kein einziges „beurteile", sondern durchweg „miss nach, mit dem
  Kommando aus dem Eintrag". Ein gemessener Ist-Zustand ist überprüfbar, ein Urteil nicht. Wo
  eine Entscheidung nötig wäre, soll der Worker zurückgeben; das ist billiger als eine falsche
  Reparatur, und die Leiter fängt es auf.
- Ein Teil der Einträge ist erwartbar gegenstandslos. Ein Worker, der nur schließt, hat
  geliefert. Wer den Erfolg an geänderten Codezeilen misst, misst das Falsche.
- Der Motor muss auf dem Basis-Branch liegen. Jeder Freilauf-Lauf bekommt einen frischen
  Worktree, und der Wächter-Flow läuft in einem eigenen, detached Checkout von `origin/<basis>`
  (Pfad aus `flow_checkout`, leer ⇒ `<zustandsordner>/checkout`): Ein nur lokal vorhandener
  Ordner ist für beide unsichtbar. Der eigene Checkout ist Absicht — der Arbeits-Checkout des
  Menschen wird von Freilauf nie nachgezogen und kann auf einem alten Commit stehen.
- Der Zustand außerhalb von git liegt je Projekt getrennt unter
  `~/agents/schwarm/<projekt-slug>/` (`hub_ids.json`, `HALT`, `journal.jsonl`, `checkout/`).
  Zwei Projekte auf einer Maschine teilen ihn nicht; `SCHWARM_STATE_DIR` überschreibt den Ort.
- Ein Hub-Neustart lässt laufende Flow-Läufe scheitern. Ein Nachlauf, der genau dann unterwegs
  war, weckt den Dispatcher nicht — der nächste Takt holt es nach.
- OpenCode kennt keine Claude-Subagents. Eine Doku-Pflicht, die einen Subagenten verlangt,
  braucht deshalb zwei Fassungen in der Konfig (`doku_pflicht` und `doku_pflicht_subagent`).
