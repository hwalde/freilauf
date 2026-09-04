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
| Aufräumer | Agent | manuell | klärt hängende Zuweisungen verschwundener Läufe; repariert nichts |
| PO-Agent (optional) | Agent | manuell | trägt die offenen Fragen einem Menschen vor und arbeitet die Antwort ein |
| Wächter-Takt | Flow, cron `0 */2` | alle zwei Stunden | zählt per Shell, weckt den Dispatcher nur bei Arbeit, den Aufräumer nur bei einer hängenden Zuweisung, und meldet einen Menschen, wenn auch der nichts half; ohne LLM |
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

## Die Zuweisung — warum eine Rückgabe nicht sofort frei ist

Die Reservierung beim Holen ist die eine Hälfte; sie verhindert, dass zwei Läufe im selben
Augenblick nach derselben Aufgabe greifen. Die andere Hälfte ist schwerer zu sehen, weil sie
zeitversetzt zuschlägt: Ein Worker gibt eine Aufgabe mit Fehlversuch und Notiz zurück, aber
beides steht bis zum Lauf-Ende nur in seinem Worktree und erreicht den Basis-Branch erst beim
Merge — Minuten bis Stunden später. Wäre die Aufgabe sofort wieder frei, zöge sie der nächste
Worker im unveränderten Zustand und maße dieselbe Sache noch einmal nach. Im Ursprungsprojekt
wurden so 23 Aufgaben von mindestens zwei Läufen angefasst, in 15 überlappenden Lauf-Paaren,
davon 7 mit weniger als vier Minuten Startabstand; eine davon durchlief binnen einer Stunde fünf
Läufe und landete beim Menschen, obwohl nur ein Richtungs-Entscheid fehlte.

Deshalb ist eine Zuweisung kein Schloss, das man auf- und zumacht, sondern ein Zustand:

- Sie entsteht beim Holen und wird bei der Rückgabe nicht gelöscht.
- Solange der zuweisende Lauf lebt oder sein Ergebnis noch nicht auf dem Basis-Branch sichtbar
  ist, wird die Aufgabe niemandem angeboten.
- Ist das Ergebnis sichtbar, ist sie sofort und stillschweigend wieder frei. Niemand muss etwas
  aufräumen, wenn alles gutgeht.
- Was ein Lauf gar nicht angefasst hat — geholt, dann einen gesetzten Wartestatus gesehen —,
  geht ohne Nachwirkung zurück. Eine Zuweisung hielte hier eine Aufgabe fest, an der niemand
  gearbeitet hat.

## Wenn ein Lauf mit seiner Zuweisung verschwindet

Der Preis dieser Bauform ist ein neuer Fehlerfall: Stürzt der Lauf ab oder kommt sein Ergebnis
nie an, überlebt die Zuweisung ihn. Die Aufgabe ist dann nicht erledigt, sondern unsichtbar —
sie wird niemandem mehr angeboten, und niemand merkt es. Dagegen eine Leiter mit genau zwei
Sprossen und einem Verzeichnis:

1. Ab `zuweisung_alt_stunden` gilt die Zuweisung als hängend, und der Wächter-Flow weckt GENAU
   EINMAL den Aufräum-Agenten dafür. Er prüft je Eintrag, was aus dem Lauf wurde: Lebt er noch,
   bleibt die Zuweisung unangetastet. Ist sein Ergebnis angekommen, ist ohnehin nichts zu tun.
   Ist es verloren, hält er in einer Notiz an der Aufgabe fest, was der Vorgänger gemessen
   hatte — damit es nicht doppelt gemessen wird — und löst die Zuweisung mit Beleg.
2. Hängt sie `zuweisung_melde_stunden` später immer noch, wird kein zweiter Agent geschickt,
   sondern per `notify` ein Mensch benachrichtigt: Aufgaben-Kennung, Lauf-Kennung, Alter und der
   Hinweis, dass der Aufräum-Lauf bereits erfolglos war. Einmal, danach ist Ruhe.

Das Verzeichnis `aufraeum_laeufe.json` im Zustandsordner hält fest, wofür schon ein Aufräum-Lauf
startete und was gemeldet wurde. Es ist nicht Buchhaltung, sondern die Regel selbst: Ohne es
schickt jeder Takt einen weiteren Agenten auf dieselbe Zuweisung, und aus einem Ausfall wird
eine Dauerbestellung.

### Die Entwurfsregel dahinter

Eine Sorge, die selten auftritt, eigene Werkzeuge braucht und eigenes Urteil verlangt, bekommt
einen eigenen Agenten, statt in den Prompt aller anderen eingebaut zu werden. Der Aufräum-Fall
trifft einen Worker in fast keinem Lauf; eine Regel dafür in seinem Prompt konkurriert trotzdem
in jedem Lauf mit seiner eigentlichen Arbeit, und im seltenen Ernstfall hätte er sie nach einer
halben Stunde an der eigenen Aufgabe halb vergessen. Der Aufräumer dagegen hat nur diese eine
Frage und die passenden Kommandos griffbereit, läuft selten und darf gründlich sein. Die
Größenordnung, gegen die jede Sonderregel anschreibt: Der Worker-Prompt dieser Vorlage misst
10 490 Zeichen (`wc -m vorlage/prompts/worker.md`) und kommt gerendert im Ursprungsprojekt auf
12 757 (`freilauf_einrichten.py --dry-run`, Spalte `prompt=`) — jede Zeile darin fällt allen
Läufen zur Last, nicht nur dem einen, für den sie gedacht ist.

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

## Vier Regeln, die aus dem ersten Dauerbetrieb stammen

- **Zeit ist kein Fehlversuch.** Der Versuchszähler ist die Leiter zum Menschen; er darf nur
  steigen, wenn ein inhaltlicher Reparaturweg nachweislich gescheitert ist. Sonst füllt sich
  der Kanal zum Menschen mit Aufgaben, die niemand entscheiden muss — sie waren nur zu groß
  für ein Zeitfenster. Große Arbeit wird zerlegt und in Teilschritten committet.
- **Jeder Worker muss den Stand aller anderen sehen.** Die Aufgaben-Kommandos lesen den
  Basis-Branch mit, nicht nur den eigenen Worktree. Keine Option, die allein den eigenen
  Arbeitsbereich liest, gehört in die Hol-Kommandos. Sonst zieht ein Lauf, was ein anderer
  gerade abgeschlossen oder an einen Menschen abgegeben hat — gemessen: dieselbe Aufgabe
  dreimal hintereinander eskaliert.
- **Ein Eintrag mit gesetztem Wartestatus wird sofort zurückgegeben**, ohne Fehlversuch
  und ohne bleibende Zuweisung. Zwischen Holen und Lesen liegt ein Moment, und in genau
  diesem Moment kann ein anderer Lauf die Aufgabe an einen Menschen abgegeben haben.
- **Der Zustand liegt je Projekt getrennt** (`~/agents/schwarm/<projekt-slug>/`). Ein
  globaler Ordner trägt genau so lange, wie auf einer Maschine nur ein Schwarm läuft:
  Der zweite überschreibt die Agenten-IDs des ersten, und dessen Dispatcher startet
  danach fremde Agenten.

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
