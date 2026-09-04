#!/usr/bin/env python3
"""lauf_lebt.py — lebt dieser Freilauf-Lauf noch? Exit 0 = ja.

WOFÜR DAS DA IST
  Das Aufgaben-Register weiß nichts über Freilauf. Es muss aber wissen, ob der Lauf, dem eine
  Aufgabe zugewiesen ist, noch arbeitet — sonst löst es entweder eine lebende Zuweisung (der
  Lauf verliert seine Arbeit) oder es lässt eine tote für immer stehen (die Aufgabe wird
  niemandem mehr angeboten). Dafür hat `befund.py` den Haken `BEFUND_LAUF_LEBT_CMD`: ein
  Kommando, an das die Lauf-Kennung ANGEHÄNGT wird; Exit 0 heißt „lebt".

  Dieses Skript ist genau dieser Haken für einen Freilauf-Hub. Gesetzt wird er in
  `konfig.repo.belegungen_aufraeumen` — dort, wo wirklich aufgeräumt wird. Ohne den Haken
  fällt das Register auf den Worktree-Test zurück: Worktree weg ⇒ Lauf beendet. Der ist
  gröber, aber nie falsch in die gefährliche Richtung.

  Ohne Haken UND ohne Worktree-Aussage bleibt die Notdecke `BEFUND_ZUWEISUNG_MAX_STUNDEN`.

AUFRUF
  python <motor>/lauf_lebt.py <lauf-id>

  In der Konfig:
    BEFUND_LAUF_LEBT_CMD='python <motor>/lauf_lebt.py' python register/befund.py belegungen --aufraeumen

SCHLUSSZEILE (byte-stabil)
  SCHWARM_LAUF_LEBT result=OK lebt=0|1 lauf=<id> status=<status>|unbekannt

EXIT-CODES
  0 der Lauf lebt (running, scheduled, deferred, waiting_help)
  1 der Lauf ist beendet (done, failed, cancelled, …)
  2 Eingabefehler (keine Lauf-Kennung)
  3 Hub nicht erreichbar oder Lauf unbekannt — die Frage ist NICHT beantwortet

  Wichtig für den Aufrufer: Exit 3 ist kein „beendet“. Ein Register, das den Haken nutzt,
  muss drei Antworten unterscheiden — Exit 0 lebt, Exit 1 beendet, alles andere unbekannt —
  und darf bei unbekannt keine Zuweisung lösen. Sonst gälten bei einer einzigen Störung
  alle Läufe als beendet, alle Zuweisungen fielen auf einmal, und die Doppelarbeit wäre
  zurück, gegen die die Zuweisung gebaut ist. Dieses Skript meldet deshalb bei einem
  unerreichbaren Hub 3 und niemals 1, und schreibt die Ursache auf stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SELF = Path(__file__).resolve()
sys.path.insert(0, str(SELF.parent))
from dispatch import enable_utf8_io, hub_url  # noqa: E402

# Ein Lauf in einem dieser Zustände kann noch schreiben und mergen. Alles andere ist vorbei.
LEBENDE = ("running", "scheduled", "deferred", "waiting_help", "queued", "starting")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="lauf_lebt.py",
        description="Lebt dieser Freilauf-Lauf noch? Exit 0 = ja. Haken für "
                    "BEFUND_LAUF_LEBT_CMD.",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("lauf", nargs="?", help="Lauf-Kennung (UUID oder Kurzform)")
    args = ap.parse_args(argv)
    if not args.lauf:
        print("FEHLER: keine Lauf-Kennung angegeben.", file=sys.stderr)
        print("Nächster Schritt: python <motor>/lauf_lebt.py <lauf-id>", file=sys.stderr)
        print("SCHWARM_LAUF_LEBT result=FAIL lebt=0 lauf=- status=unbekannt")
        return 2

    url = f"{hub_url()}/api/runs/{urllib.parse.quote(args.lauf)}"
    try:
        req = urllib.request.Request(url, headers={"accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as antwort:
            daten = json.loads(antwort.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"FEHLER: Hub {hub_url()} antwortet nicht auf /api/runs/{args.lauf} ({e}).",
              file=sys.stderr)
        print("Nächster Schritt: fl-api --url · Hub starten. Solange die Frage unbeantwortet "
              "ist, darf keine Zuweisung als beendet gelten.", file=sys.stderr)
        print(f"SCHWARM_LAUF_LEBT result=FAIL lebt=0 lauf={args.lauf} status=unbekannt")
        return 3

    lauf = daten.get("run") or {}
    status = str(lauf.get("status") or "").strip()
    if not status:
        print(f"FEHLER: Der Hub kennt den Lauf {args.lauf} nicht (kein status im Ergebnis).",
              file=sys.stderr)
        print("Nächster Schritt: fl-api /api/runs/<id> von Hand fahren.", file=sys.stderr)
        print(f"SCHWARM_LAUF_LEBT result=FAIL lebt=0 lauf={args.lauf} status=unbekannt")
        return 3

    lebt = status in LEBENDE
    print(f"SCHWARM_LAUF_LEBT result=OK lebt={1 if lebt else 0} lauf={args.lauf} "
          f"status={status}")
    return 0 if lebt else 1


if __name__ == "__main__":
    enable_utf8_io()
    sys.exit(main())
