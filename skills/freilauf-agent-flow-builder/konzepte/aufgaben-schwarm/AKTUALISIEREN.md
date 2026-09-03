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

Die Vorlage stammt aus dem Motor-Ordner des Ursprungsprojekts (Fassung 1.1.0, 2026-09-04).
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
