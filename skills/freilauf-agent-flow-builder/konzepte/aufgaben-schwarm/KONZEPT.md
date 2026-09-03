# Aufgaben-Schwarm — was das Konzept löst und wie es gebaut ist

Ein Repository sammelt kleine technische Aufgaben an: Bugs, die niemand anfasst, weil jeder
einzelne zu klein für eine Sitzung und zu groß für nebenbei ist. Ein Teil davon ist erwartbar
gegenstandslos — was man erst weiß, wenn jemand nachmisst. Genau diese Arbeit — nachmessen,
schließen oder minimal reparieren — ist gleichförmig, billig zu modellieren und braucht keinen
Menschen.

Der Aufgaben-Schwarm ist eine Besetzung von Freilauf-Agenten, die ein solches Register
selbständig abarbeitet: Ein Wächter zählt im Zwei-Stunden-Takt, ob Arbeit da ist, ein Dispatcher
entscheidet, wie viele Läufe auf welcher Route starten, und die Worker bedienen sich selbst am
Register. Wer nicht weiterkommt, gibt zurück; was zweimal scheitert, bekommt einen stärkeren
Agenten; was auch der nicht entscheiden kann, wird einem Menschen als nummerierte Wahl
vorgelegt.

Das Konzept setzt kein bestimmtes Ticket-System voraus. Was ein Register können muss, steht als
Vertrag im Block `repo` der Konfig; ein Adapter erfüllt ihn (siehe `adapter/`).

## Die Bauteile

Nichts davon ist ein eigenes Agenten-System. Es sind gewöhnliche Freilauf-Agenten und
Freilauf-Flows, sichtbar im Hub. Selbst gebaut ist nur, was Freilauf nicht wissen kann: wie
viele Aufgaben in diesem Repository offen sind.

| Bauteil | Art | Takt | Aufgabe |
|---|---|---|---|
| Worker (gewöhnlich) | Agent | manuell | trivial und normal; nimmt sich ein kleines Paket |
| Worker (billiger Spezialist) | Agent | manuell | nur trivial; bekommt seinen Platz vor den gewöhnlichen |
| Worker (stark, Abo-Route) | Agent | manuell | blockiert oder zweimal gescheitert; genau ein Fall |
| Worker (stark, Ausweich-Route) | Agent | manuell | dasselbe, wenn die Abo-Quote nicht reicht |
| Dispatcher | Agent | manuell | zählt, prüft Guthaben und Quote, startet die Worker mit Zeitversatz |
| PO-Agent (optional) | Agent | manuell | trägt die offenen Fragen einem Menschen vor und arbeitet die Antwort ein |
| Wächter-Takt | Flow, cron `0 */2` | alle zwei Stunden | zählt per Shell, weckt den Dispatcher nur bei Arbeit; ohne LLM |
| PO-Takt | Flow, cron `0 4` | täglich | weckt den PO-Agenten nur, wenn eine Frage offen ist |
| Nachlauf | Flow, `run_finished` | nach jedem Worker | liest den Report per `extract`, weckt den Dispatcher bei Fortschritt |
| `dispatch.py lage` | Skript | vom Flow und vom Dispatcher gerufen | die einzige Rechenstelle: zählen, staffeln, deckeln |

Der Wächter startet nie selbst einen Worker. Welcher Worker, wie viele und auf welcher Route ist
Triage- und Quoten-Arbeit; sie gehört an eine Stelle, nicht in zwei Bedingungs-Leitern, die mit
der Zeit auseinanderlaufen.

## Der Lebenszyklus — keine Aufgabe bleibt liegen

| Zustand | wer holt ihn | was danach passiert |
|---|---|---|
| frei, trivial oder normal, 0 Versuche | gewöhnlicher Worker | geschlossen — oder mit Notiz zurückgegeben, Versuche +1 |
| frei, 1 Versuch | wieder die gewöhnliche Bahn | zweiter Anlauf, mit der Notiz des ersten |
| blockiert, oder 2 Versuche | der eine starke Worker | ein Fall, volles Zeitbudget, keine Paketbildung |
| dritter Fehlversuch | niemand mehr | das Register setzt selbst „wartet auf PO" |
| wartet auf PO | der PO-Agent, täglich | nummerierte Optionen an den Menschen; er antwortet mit „1a, 2c" |
| Entscheid liegt vor | derselbe Agent, dieselbe Sitzung | Notiz mit dem Entscheid, Marke lösen — wieder frei |
| auch danach nicht automatisierbar | niemand | Marke „wartet auf Mensch", mit Begründung im Report |

Jede Zeile endet in „geschlossen" oder in der nächsten Zeile. Es gibt keinen Zustand, aus dem
heraus nichts mehr geschieht — außer „Mensch", und der trägt seinen Grund mit sich. Ohne diese
Eigenschaft wäre der Schwarm eine Maschine, die sich die leichten Fälle heraussucht und den Rest
still liegen lässt.

## Skalierung, Quote, Budget

Skaliert wird über die Zahl der Starts, nicht über Ein- und Ausschalten: Derselbe Worker-Agent
wird mehrfach gestartet, jeder Start ist ein eigener Lauf mit eigenem Worktree und eigener
tmux-Sitzung. Zwischen zwei Starts liegen `versatz_minuten` Minuten; die atomare Reservierung im
Register fängt den Rest ab.

- Staffel: `startstufen` sagt, wie viele gewöhnliche Läufe bei wie vielen freien Aufgaben
  starten. Über allem steht `max_worker` abzüglich der laufenden Schwarm-Läufe — `lage` liefert
  die Zahl bereits gedeckelt, wer sie startet, kann den Schwarm nicht aufschaukeln.
- Der billige Spezialist bekommt seinen Platz vor der Staffel, sonst schöpft sie den Deckel
  allein aus und er käme nie zum Zug.
- Starke Bahn: höchstens `stark_max_parallel` (Vorgabe 1) gleichzeitig, nie beide Routen.
- Abo-Quote: Gemessen wird das Wochenfenster mit dem Abo-Label aus `fl-api /api/usage`
  (`weekly_scoped`), nicht `seven` — `seven` ist das Maximum aller Fenster und beantwortet eine
  andere Frage. Jede Zahl kommt mit ihrem Alter; eine als stale gemeldete Zahl gilt als nicht
  belastbar, denn direkt nach einem Reset kann der erinnerte Wert der alte sein, und wer darauf
  einen Abo-Start baut, kauft sich ein `deferred`. Ohne belastbare Zahl fährt die Ausweich-Route.
- Geld: `budgets` sind die Guthaben-Schwellen je Anbieter, absichtlich über Freilaufs eigenem
  Budget-Gate. `tages_budget_usd` summiert die echten Lauf-Kosten eines Kalendertages; gelb heißt
  „starke Bahn aus", rot heißt „gar keine Starts". Ein Abo-Lauf meldet keine Kosten — sein Preis
  ist der Anteil an der Wochenquote, und deren Deckel ist `fable_7d_max`. Abo-Verbrauch ist ein
  Preis, kein Nullwert.
- Leerlauf kostet nichts: Kein Agent hat einen Cron, der einzige Takt ist der Wächter-Flow, und
  der ist ein Shell-Aufruf plus eine Bedingung. Ein Tag ohne offene Aufgaben ergibt null
  Agenten-Läufe und null Token.

Die eine Falle dabei: Scheitert der Shell-Aufruf, fehlt das Flag `arbeit_da=1` in der Ausgabe —
und eine Bedingung auf einen fehlenden Wert liest sich genau wie „nichts zu tun". Der Wächter
prüft deshalb zuerst, ob der Aufruf gelang, und meldet den Ausfall per `notify`. Ein Flow, der
grün meldet und nichts tut, ist der teuerste Fehler dieses Systems.

## Voraussetzungen

- Ein Freilauf-Hub, erreichbar über `fl-api`, mit dem Zielrepo als Repository (`fl-api /api/repos`).
- Der Flow-Baustein `count_runs` — im Hub vorhanden seit dem 2026-09-03. Prüfen mit
  `fl-api /api/flows/meta`; fehlt er, nehmen die Flow-Vorlagen ihre Deckel-Zweige nicht.
- Ein Aufgaben-Register mit einem Adapter, der den Vertrag erfüllt (siehe `adapter/`).
- Modelle und Routen, die es auf dieser Installation wirklich gibt: `fl-api /api/models provider=<anbieter>` und
  `fl-api /api/favorites`. Eine erfundene Modell-ID meldet opencode als „Unexpected server
  error" — von einem Anbieter-Ausfall nicht zu unterscheiden.

## Grenzen

- Die Reservierung ist so gut wie das Register. Eine maschinenlokale Sperre (Datei im
  Home-Verzeichnis) sieht ein Schwarm auf einer zweiten Maschine nicht; Folge ist Doppelarbeit,
  nie Datenverlust. Ein Adapter auf ein zentrales Ticket-System hat das Problem nicht, dafür
  aber Rennen zwischen zwei gleichzeitigen Zugriffen.
- Die Abo-Route hängt an einer fremden Zahl. Ist die Quote hoch, fährt der Schwarm dauerhaft auf
  der Ausweich-Route — und die ist meist nur ein frischer Kopf mit ganzem Zeitbudget, nicht viel
  mehr Verstand. Wer den Abstand zwischen gewöhnlicher und starker Bahn nicht kennt, überschätzt,
  was die Eskalation bringt.
- Der Motor muss auf dem Basis-Branch liegen. Jeder Lauf bekommt einen frischen Worktree, und
  der Wächter-Flow arbeitet in einem eigenen, detached Checkout von `origin/<basis>`: Ein nur
  lokal vorhandener Ordner ist für beide unsichtbar, und der Schwarm scheitert bei jedem Takt.
  Der eigene Checkout ist dabei kein Umweg, sondern Absicht — der Arbeits-Checkout des Menschen
  wird von Freilauf nie nachgezogen und kann beliebig alt sein.
- Ein Hub-Neustart lässt laufende Flow-Läufe scheitern. Ein Nachlauf, der gerade unterwegs war,
  weckt den Dispatcher nicht; der nächste Takt holt es nach.
- Der Schwarm misst, er urteilt nicht. Im Worker-Prompt steht kein „beurteile", sondern durchweg
  „miss nach, mit dem Kommando aus dem Eintrag" — ein gemessener Ist-Zustand ist überprüfbar,
  ein Urteil nicht. Aufgaben, die echtes Urteil verlangen, gehören nicht in dieses Register.

## Langfristig: Einlagerung in Freilauf

Der Schwarm baut heute nach, was ein Hub auch selbst könnte: eine Warteschlange von Aufgaben,
eine Reservierung, einen Zähler für Fehlversuche, eine Marke „wartet auf einen Menschen". Zwei
Wege stehen zur Wahl, und dieser Skill entscheidet sie nicht:

- Freilauf bekommt eigene Tickets: Aufgaben werden ein Objekt des Hubs, mit Zustand,
  Reservierung und Versuchszähler. Alles liegt an einer Stelle, die Flows adressieren Tickets
  direkt, ein Adapter entfällt. Der Preis ist ein weiteres Ticket-System neben denen, die das
  Team schon hat.
- Freilauf bekommt Plugins auf fremde Ticket-Systeme: GitHub Issues, Jira, Linear. Die Aufgaben
  bleiben, wo das Team sie ohnehin pflegt; der Hub liest und schreibt über ein Plugin. Der Preis
  ist je Anbindung ein eigenes Plugin und ein gemeinsamer Nenner, der schmaler ist als jedes
  einzelne System.

Bis dahin gilt der Vertrag in diesem Konzept: Er ist genau die Schnittstelle, die beide Wege
später ersetzen würden, und deshalb kein verlorener Aufwand.
