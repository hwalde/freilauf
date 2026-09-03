#!/usr/bin/env python3
"""gh_aufgaben.py — GitHub Issues als Aufgaben-Register eines Freilauf-Schwarms bedienen.

WOFÜR DAS DA IST
  Ein Aufgaben-Schwarm liest seine Arbeit nicht aus einem festen Ticket-System, sondern
  über einen Adapter: ein Werkzeug, das genau die Unterbefehle anbietet, die der Block
  `repo` in `konfig.json` aufruft. Vorbild ist `python register/befund.py …` aus dem
  Ursprungsprojekt. Dieser Adapter bildet denselben Vertrag auf GitHub Issues ab
  und ruft dafür ausschließlich `gh` auf — keine Bibliothek, keine eigene Datenhaltung.

ABBILDUNG GITHUB ↔ VERTRAG
  Warteschlange   Label `schwarm` — nur Issues mit diesem Label sind Aufgaben des Schwarms
  Belegung        Label `in-arbeit`, zusätzlich Assignee, wenn GitHub ihn annimmt
  Notiz           Issue-Kommentar
  wartet_auf      Labels `wartet-auf:po` und `wartet-auf:mensch`
  Schweregrad     Labels `schwere:trivial` | `schwere:normal` | `schwere:blockiert` (Vorgabe normal)
  Art             Labels `art:bug` | `art:aufgabe` (Vorgabe aufgabe)
  Versuchszähler  Labels `versuch:1` | `versuch:2` | `versuch:3`, keines heißt 0; Deckel 3
  Fundort         die erste Zeile im Body, die mit `Fundort:` beginnt (sonst leer)
  Schließen       Kommentar mit dem Beleg, danach `gh issue close`

AUFRUF
  python gh_aufgaben.py [--repo owner/name] [--dry-run] <befehl> [optionen]
  python gh_aufgaben.py <befehl> --help      Details zu einem Befehl

  liste       Offene Aufgaben als Kopfzeilen oder als JSON (--json)
  naechster   Die Aufgabe, die als nächstes dran ist; --belegen reserviert sie
  zeig        Eine Aufgabe ansehen (Kopf; Body und Kommentare nur mit --langtext)
  schliessen  Aufgabe abschließen — Kommentar mit Pflicht-Beleg, dann Issue schließen
  versuch     Gescheiterten Versuch protokollieren (zählt hoch; bei 3 Eskalation an PO)
  freigebe    Belegung zurückgeben (Label `in-arbeit` weg, Assignee weg)
  belegungen  Wer hält gerade was
  notiz       Zwischenstand als Kommentar anhängen
  setze       Wartezustand ändern (--wartet-auf po | mensch | keins)
  neu         Aufgabe anlegen (validiert Fundort, Population und Frage)

BEISPIELE
  python gh_aufgaben.py --repo hwalde/freilauf liste --frei --unbelegt --json
  python gh_aufgaben.py naechster --schwere normal --belegen --lauf "$FL_RUN_ID"
  python gh_aufgaben.py zeig 42 --langtext
  python gh_aufgaben.py notiz 42 --text "Ursache eingegrenzt auf den Cache-Schlüssel"
  python gh_aufgaben.py versuch 42 --grund "Testlauf bricht weiterhin im Setup ab"
  python gh_aufgaben.py schliessen 42 --beleg "pytest -q tests/ → 214 passed"
  python gh_aufgaben.py --dry-run freigebe 42
  python gh_aufgaben.py neu --titel "Zeitzone im Report falsch" \
      --fundort "src/report.py:88" --population "12 Treffer (rg 'localtime' src/)" \
      --frage "UTC oder Nutzer-Zeitzone?" --schwere normal --art bug

REPO-WAHL
  --repo owner/name  vor  Umgebungsvariable GH_AUFGABEN_REPO  vor  dem Repository des
  aktuellen Arbeitsverzeichnisses (`gh repo view`).

SCHLUSSZEILE (byte-stabil, für Flows)
  GH_AUFGABEN_<BEFEHL> result=OK|FAIL [key=value …]
    liste       n=<anzahl>
    naechster   id=<n> kandidaten=<k> belegt=ja|nein   bzw.   n=0, wenn nichts frei ist
    versuch     id=<n> versuche=<n> [eskaliert=po]
  Die Zahlen stehen in der Schlusszeile, weil Freilauf-Flows sie mit `contains` vergleichen.

EXIT-CODES
  0 OK · 1 fachlicher Fehlschlag (Issue unbekannt, schon geschlossen, Belegung verloren)
  2 Eingabefehler (Pflichtangabe fehlt, unbekannter Wert, --aufraeumen)
  3 Umgebung nicht nutzbar (kein `gh`, nicht angemeldet, Repository unbekannt)

GRENZEN
  Die Belegung über ein Label ist nicht atomar: Zwei Läufe können dieselbe Aufgabe greifen.
  Der Adapter liest jeden Kandidaten unmittelbar vor dem Setzen noch einmal und prüft
  danach nach, ob das Label wirklich sitzt — das verkleinert das Fenster, schließt es aber
  nicht. Wer eine harte Reservierung braucht, nimmt einen Adapter mit Dateisperre.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

LABEL_WARTESCHLANGE = "schwarm"
LABEL_ARBEIT = "in-arbeit"
LABEL_WARTET = {"po": "wartet-auf:po", "mensch": "wartet-auf:mensch"}
SCHWEREN = ("trivial", "normal", "blockiert")
ARTEN = ("bug", "aufgabe")
VERSUCHE_DECKEL = 3
LISTE_LIMIT = 500
FUNDORT_PRAEFIX = "Fundort:"
LOGIN_MUSTER = re.compile(r"^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$")

# Ausgabe-Felder je Aufgabe — der Vertrag, den `listen_felder` in konfig.json spiegelt.
FELDER = ("id", "schwere", "art", "titel", "fundort", "versuche", "angelegt", "wartet_auf")


class UmgebungsFehler(Exception):
    """`gh` fehlt, ist nicht angemeldet oder das Repository ist unbekannt (Exit 3)."""


class FachFehler(Exception):
    """Die Aufgabe gibt es nicht, sie ist schon zu oder die Belegung ging verloren (Exit 1)."""


# ── Ausgabe ────────────────────────────────────────────────────────────────────────────
def _schluss(befehl: str, result: str, **kv) -> None:
    rest = " ".join(f"{k}={v}" for k, v in kv.items())
    print(f"GH_AUFGABEN_{befehl.upper()} result={result}" + (f" {rest}" if rest else ""))


def _fehler(befehl: str, text: str, *, code: int = 2, **kv) -> int:
    print(f"FEHLER: {text}", file=sys.stderr)
    _schluss(befehl, "FAIL", **kv)
    return code


def _kurz(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1] + "…"


# ── gh aufrufen ────────────────────────────────────────────────────────────────────────
def _gh_vorhanden() -> None:
    if shutil.which("gh") is None:
        raise UmgebungsFehler(
            "Das Kommando `gh` ist nicht im Pfad. Installiere die GitHub-CLI "
            "(https://cli.github.com) und melde dich mit `gh auth login` an."
        )


def _gh(args: list[str], *, timeout: int = 90) -> subprocess.CompletedProcess:
    _gh_vorhanden()
    try:
        return subprocess.run(
            ["gh", *args], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise UmgebungsFehler(
            f"`gh {shlex.join(args)}` antwortete nicht innerhalb von {timeout} Sekunden. "
            "Prüfe die Netzverbindung und wiederhole den Aufruf."
        ) from None


def _deute_fehler(args: list[str], p: subprocess.CompletedProcess) -> Exception:
    """Ordnet einen gh-Fehlschlag der Umgebung (Exit 3) oder der Fachlichkeit (Exit 1) zu."""
    text = ((p.stderr or "") + (p.stdout or "")).strip()
    klein = text.lower()
    ruf = f"`gh {shlex.join(args)}`"
    if any(s in klein for s in ("authentication", "not logged in", "gh auth login",
                                "bad credentials", "requires authentication")):
        return UmgebungsFehler(
            f"{ruf} ist nicht angemeldet.\n  Melde dich an: gh auth login\n"
            f"  Meldung: {_kurz(text, 300)}"
        )
    if any(s in klein for s in ("could not resolve to a repository", "no such host",
                                "network is unreachable", "connection refused",
                                "not a git repository", "could not determine")):
        return UmgebungsFehler(
            f"{ruf} erreicht das Repository nicht.\n"
            "  Nenne es ausdrücklich: --repo owner/name (oder setze GH_AUFGABEN_REPO), "
            "und prüfe die Netzverbindung.\n  Meldung: " + _kurz(text, 300)
        )
    if "rate limit" in klein:
        return UmgebungsFehler(
            f"{ruf} lief in das API-Limit von GitHub.\n"
            "  Warte die Rückstellung ab (`gh api rate_limit`) und wiederhole den Aufruf.\n"
            "  Meldung: " + _kurz(text, 300)
        )
    if "label" in klein and ("not found" in klein or "could not add" in klein):
        return FachFehler(
            f"{ruf} kennt eines der Labels nicht.\n"
            "  Lege die Labels des Schwarms einmalig an — die `gh label create`-Zeilen "
            "stehen in ADAPTER.md, Abschnitt Einrichtung.\n  Meldung: " + _kurz(text, 300)
        )
    return FachFehler(f"{ruf} schlug fehl.\n  Meldung: {_kurz(text, 400)}")


def _gh_ok(args: list[str], *, timeout: int = 90) -> str:
    p = _gh(args, timeout=timeout)
    if p.returncode != 0:
        raise _deute_fehler(args, p)
    return p.stdout


def _gh_json(args: list[str], *, timeout: int = 90):
    roh = _gh_ok(args, timeout=timeout)
    try:
        return json.loads(roh or "null")
    except json.JSONDecodeError:
        raise UmgebungsFehler(
            f"`gh {shlex.join(args)}` lieferte kein JSON.\n"
            "  Prüfe die gh-Version (`gh --version`, gebraucht wird mindestens 2.0) "
            "und wiederhole den Aufruf.\n  Anfang der Ausgabe: " + _kurz(roh, 200)
        ) from None


# ── Repo ───────────────────────────────────────────────────────────────────────────────
def _repo(a) -> str:
    if a.repo:
        return a.repo
    aus_umgebung = os.environ.get("GH_AUFGABEN_REPO", "").strip()
    if aus_umgebung:
        return aus_umgebung
    p = _gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], timeout=30)
    if p.returncode != 0 or not p.stdout.strip():
        raise UmgebungsFehler(
            "Das Repository steht nicht fest: Das Arbeitsverzeichnis gehört zu keinem "
            "GitHub-Repository, das `gh` kennt.\n"
            "  Nenne es ausdrücklich: --repo owner/name — oder setze GH_AUFGABEN_REPO=owner/name."
        )
    return p.stdout.strip()


def _angemeldeter_benutzer() -> str | None:
    p = _gh(["api", "user", "--jq", ".login"], timeout=30)
    return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None


# ── Aufgaben lesen ─────────────────────────────────────────────────────────────────────
def _labels(issue: dict) -> list[str]:
    return [str(eintrag.get("name", "")) for eintrag in (issue.get("labels") or [])]


def _fundort(body: str) -> str:
    for zeile in (body or "").splitlines():
        if zeile.strip().startswith(FUNDORT_PRAEFIX):
            return zeile.strip()[len(FUNDORT_PRAEFIX):].strip()
    return ""


def _versuche(labels: list[str]) -> int:
    hoechst = 0
    for name in labels:
        m = re.fullmatch(r"versuch:(\d+)", name)
        if m:
            hoechst = max(hoechst, int(m.group(1)))
    return hoechst


def _wartet_auf(labels: list[str]) -> str:
    for schluessel, name in LABEL_WARTET.items():
        if name in labels:
            return schluessel
    return ""


def _aufgabe(issue: dict) -> dict:
    labels = _labels(issue)
    schwere = next((s for s in SCHWEREN if f"schwere:{s}" in labels), "normal")
    art = next((s for s in ARTEN if f"art:{s}" in labels), "aufgabe")
    return {
        "id": str(issue.get("number")),
        "schwere": schwere,
        "art": art,
        "titel": issue.get("title") or "",
        "fundort": _fundort(issue.get("body") or ""),
        "versuche": _versuche(labels),
        "angelegt": (issue.get("createdAt") or "")[:10],
        "wartet_auf": _wartet_auf(labels),
        # Nicht Teil der Feld-Liste, aber für Filter und Anzeige gebraucht:
        "_belegt": LABEL_ARBEIT in labels,
        "_assignees": [str(x.get("login", "")) for x in (issue.get("assignees") or [])],
        "_url": issue.get("url") or "",
        "_labels": labels,
    }


LIST_FELDER = "number,title,labels,body,createdAt,assignees,url"
VIEW_FELDER = "number,title,labels,body,createdAt,assignees,url,state"


def _hole_alle(repo: str) -> list[dict]:
    roh = _gh_json(["issue", "list", "-R", repo, "--label", LABEL_WARTESCHLANGE,
                    "--state", "open", "--limit", str(LISTE_LIMIT), "--json", LIST_FELDER])
    aufgaben = [_aufgabe(i) for i in (roh or [])]
    aufgaben.sort(key=lambda x: (x["angelegt"], int(x["id"])))
    return aufgaben


def _hole_eine(repo: str, nummer: str) -> dict:
    if not re.fullmatch(r"\d+", str(nummer)):
        raise FachFehler(
            f"{nummer!r} ist keine Issue-Nummer. Die id einer Aufgabe ist die Nummer des "
            "Issues, etwa 42 — sieh sie in `gh_aufgaben.py liste` nach."
        )
    roh = _gh_json(["issue", "view", str(nummer), "-R", repo, "--json", VIEW_FELDER])
    if not roh:
        raise FachFehler(f"Issue {nummer} gibt es in {repo} nicht. Prüfe die Nummer mit `liste`.")
    a = _aufgabe(roh)
    a["_state"] = str(roh.get("state", "")).lower()
    a["_body"] = roh.get("body") or ""
    return a


def _pruefe_schwarm(a: dict, befehl: str) -> None:
    if LABEL_WARTESCHLANGE not in a["_labels"]:
        raise FachFehler(
            f"Issue {a['id']} trägt das Label `{LABEL_WARTESCHLANGE}` nicht und gehört damit "
            f"nicht zur Warteschlange des Schwarms.\n  Nimm es auf: "
            f"gh issue edit {a['id']} --add-label {LABEL_WARTESCHLANGE}"
        )
    if a.get("_state") == "closed" and befehl != "zeig":
        raise FachFehler(
            f"Issue {a['id']} ist bereits geschlossen — daran ist nichts mehr zu tun.\n"
            f"  Wieder öffnen, falls das ein Irrtum war: gh issue reopen {a['id']}"
        )


# ── Schreiben (achtet auf --dry-run) ───────────────────────────────────────────────────
def _schreibe(a, args: list[str], *, timeout: int = 90) -> str | None:
    """Führt einen schreibenden gh-Aufruf aus — oder zeigt ihn nur, wenn --dry-run gilt."""
    if a.dry_run:
        print("  dry-run: gh " + shlex.join(args))
        return None
    return _gh_ok(args, timeout=timeout)


def _heute() -> str:
    return _dt.date.today().isoformat()


# ── liste ──────────────────────────────────────────────────────────────────────────────
def cmd_liste(a) -> int:
    repo = _repo(a)
    aufgaben = _hole_alle(repo)
    treffer = aufgaben
    if a.frei:
        treffer = [x for x in treffer if not x["wartet_auf"]]
    if a.unbelegt:
        treffer = [x for x in treffer if not x["_belegt"]]
    if a.schwere:
        treffer = [x for x in treffer if x["schwere"] == a.schwere]
    if a.wartet_auf:
        gesucht = "" if a.wartet_auf == "keins" else a.wartet_auf
        treffer = [x for x in treffer if x["wartet_auf"] == gesucht]

    if a.json:
        print(json.dumps([{k: x[k] for k in FELDER} for x in treffer],
                         ensure_ascii=False, indent=1))
        _schluss("liste", "OK", n=len(treffer))
        return 0

    if not treffer:
        if aufgaben:
            print("Keine Aufgabe für diesen Filter.")
        else:
            print(f"Die Warteschlange ist leer: In {repo} trägt kein offenes Issue das Label "
                  f"`{LABEL_WARTESCHLANGE}`.\n"
                  "  Aufgabe anlegen: gh_aufgaben.py neu --titel … --fundort … "
                  "--population … --frage …")
    else:
        print(f"  {'ID':<7} {'ART':<8} {'SCHW':<10} V  {'WARTET':<7} {'BELEGT':<7} TITEL")
        for x in treffer:
            print(f"  {x['id']:<7} {x['art']:<8} {x['schwere']:<10} {x['versuche']}  "
                  f"{(x['wartet_auf'] or '–'):<7} {('ja' if x['_belegt'] else '–'):<7} "
                  f"{_kurz(x['titel'], 58)}")
        print(f"\n{len(treffer)} von {len(aufgaben)} offenen Aufgaben in {repo}")
        print("  Ansehen: gh_aufgaben.py zeig <id> --langtext · "
              "Kandidat: gh_aufgaben.py naechster")
    _schluss("liste", "OK", n=len(treffer))
    return 0


# ── naechster ──────────────────────────────────────────────────────────────────────────
def cmd_naechster(a) -> int:
    min_v = max(0, int(a.min_versuche or 0))
    max_v = VERSUCHE_DECKEL - 1 if a.max_versuche is None else int(a.max_versuche)
    if min_v > max_v:
        return _fehler("naechster",
                       f"--min-versuche {min_v} ist größer als --max-versuche {max_v} — die Menge "
                       "ist leer.\n  Beide Grenzen zählen einschließlich; die Vorgabe ist "
                       f"0 … {VERSUCHE_DECKEL - 1} (unter dem Versuchs-Deckel {VERSUCHE_DECKEL}).")
    repo = _repo(a)
    aufgaben = _hole_alle(repo)
    kandidaten = [x for x in aufgaben
                  if not x["wartet_auf"] and not x["_belegt"]
                  and min_v <= x["versuche"] <= max_v
                  and (not a.schwere or x["schwere"] == a.schwere)]

    if not kandidaten:
        filter_text = " ".join(t for t in (
            f"--schwere {a.schwere}" if a.schwere else "",
            f"--min-versuche {min_v}" if min_v else "",
            f"--max-versuche {max_v}" if a.max_versuche is not None else "") if t)
        belegt = sum(1 for x in aufgaben if x["_belegt"])
        wartend = sum(1 for x in aufgaben if x["wartet_auf"])
        print(f"Keine freie Aufgabe in {repo}: nichts ist unbelegt, frei von Wartezuständen und "
              f"im Versuchs-Fenster {min_v}…{max_v}.\n"
              f"  Bestand: {len(aufgaben)} offen, davon {belegt} belegt und {wartend} wartend.\n"
              "  Belegungen ansehen: gh_aufgaben.py belegungen · Wartende: "
              "gh_aufgaben.py liste --wartet-auf po")
        if filter_text:
            print(f"  Der Filter `{filter_text}` engt zusätzlich ein — ohne ihn kann es "
                  "Kandidaten geben.")
        _schluss("naechster", "OK", n=0)
        return 0

    gewaehlt = kandidaten[0]
    if a.belegen:
        gewaehlt = _belege_ersten(a, repo, kandidaten)
        if gewaehlt is None:
            print("Alle Kandidaten sind inzwischen belegt (Wettlauf verloren).\n"
                  "  Wiederhole den Aufruf — oder sieh nach, wer hält: gh_aufgaben.py belegungen")
            _schluss("naechster", "FAIL", n=len(kandidaten))
            return 1
        print(f"BELEGT: {gewaehlt['id']} · [{gewaehlt['art']}/{gewaehlt['schwere']}] "
              f"{gewaehlt['titel']}")
    else:
        print(f"Als nächstes dran: {gewaehlt['id']} · [{gewaehlt['art']}/{gewaehlt['schwere']}] "
              f"{gewaehlt['titel']}")
    print(f"  Fundort:  {gewaehlt['fundort'] or '–'}")
    print(f"  Versuche: {gewaehlt['versuche']} · angelegt {gewaehlt['angelegt']}")
    print(f"  Langform: {gewaehlt['_url']}")
    print("  ↳ Details, Messungen und Vorgeschichte stehen im Issue-Body und in den Kommentaren.\n"
          f"    Nur bei Bedarf lesen: gh_aufgaben.py zeig {gewaehlt['id']} --langtext")
    if len(kandidaten) > 1:
        print(f"\n  {len(kandidaten) - 1} weitere Kandidaten: "
              "gh_aufgaben.py liste --frei --unbelegt")
    if a.belegen:
        print("\n  Die Belegung ist ein Label, keine Sperre. Vorzeitig abgeben: "
              f"gh_aufgaben.py freigebe {gewaehlt['id']}")
    else:
        print("\n  Reservieren: gh_aufgaben.py naechster --belegen --lauf <lauf-id>")
    _schluss("naechster", "OK", id=gewaehlt["id"], kandidaten=len(kandidaten),
             belegt=("ja" if a.belegen else "nein"))
    return 0


def _belege_ersten(a, repo: str, kandidaten: list[dict]) -> dict | None:
    """Nimmt den ersten Kandidaten, den wir wirklich bekommen. Nicht atomar — siehe Grenzen."""
    for kandidat in kandidaten:
        if not a.dry_run:
            frisch = _hole_eine(repo, kandidat["id"])
            if frisch["_belegt"] or frisch.get("_state") == "closed":
                continue
        _schreibe(a, ["issue", "edit", kandidat["id"], "-R", repo, "--add-label", LABEL_ARBEIT])
        _setze_assignee(a, repo, kandidat["id"])
        if a.dry_run:
            return kandidat
        nach = _hole_eine(repo, kandidat["id"])
        if nach["_belegt"]:
            kandidat["_belegt"] = True
            return kandidat
    return None


def _setze_assignee(a, repo: str, nummer: str) -> None:
    """Assignee ist Schmuck, das Label ist die Belegung — ein Fehlschlag hält nichts auf."""
    kandidaten: list[str] = []
    if a.lauf and LOGIN_MUSTER.fullmatch(a.lauf):
        kandidaten.append(a.lauf)
    if a.dry_run:
        kandidaten.append(kandidaten[0] if kandidaten else "<angemeldeter Benutzer>")
    else:
        benutzer = _angemeldeter_benutzer()
        if benutzer and benutzer not in kandidaten:
            kandidaten.append(benutzer)
    for name in kandidaten:
        args = ["issue", "edit", str(nummer), "-R", repo, "--add-assignee", name]
        if a.dry_run:
            print("  dry-run: gh " + shlex.join(args))
            return
        if _gh(args).returncode == 0:
            return
    print("  Hinweis: Kein Assignee gesetzt — GitHub nimmt nur Mitarbeitende des Repositorys an. "
          f"Die Belegung trägt allein das Label `{LABEL_ARBEIT}`.", file=sys.stderr)


# ── zeig ───────────────────────────────────────────────────────────────────────────────
def cmd_zeig(a) -> int:
    repo = _repo(a)
    x = _hole_eine(repo, a.id)
    print(f"Aufgabe {x['id']} · {x['titel']}")
    print(f"  art:         {x['art']}")
    print(f"  schwere:     {x['schwere']}")
    print(f"  fundort:     {x['fundort'] or '–'}")
    print(f"  versuche:    {x['versuche']}")
    print(f"  angelegt:    {x['angelegt']}")
    print(f"  wartet_auf:  {x['wartet_auf'] or '–'}")
    print(f"  belegt:      {'ja' if x['_belegt'] else 'nein'}"
          + (f" · {', '.join(x['_assignees'])}" if x["_assignees"] else ""))
    print(f"  zustand:     {x.get('_state', '?')}")
    print(f"  url:         {x['_url']}")
    if a.langtext:
        print("\n── Body ──")
        print(x["_body"].strip() or "(leer)")
        kommentare = _gh_json(["issue", "view", str(a.id), "-R", repo, "--json", "comments"])
        liste = (kommentare or {}).get("comments") or []
        print(f"\n── Kommentare ({len(liste)}) ──")
        for k in liste:
            autor = ((k.get("author") or {}).get("login")) or "?"
            wann = (k.get("createdAt") or "")[:10]
            print(f"\n[{wann} · {autor}]\n{(k.get('body') or '').strip()}")
    else:
        print(f"\n  Body und Kommentare nur bei Bedarf: "
              f"gh_aufgaben.py zeig {x['id']} --langtext")
    _schluss("zeig", "OK", id=x["id"])
    return 0


# ── schliessen ─────────────────────────────────────────────────────────────────────────
def cmd_schliessen(a) -> int:
    repo = _repo(a)
    x = _hole_eine(repo, a.id)
    _pruefe_schwarm(x, "schliessen")
    text = f"Abgeschlossen am {_heute()}.\n\nBeleg: {a.beleg}"
    _schreibe(a, ["issue", "comment", x["id"], "-R", repo, "--body", text])
    _schreibe(a, ["issue", "close", x["id"], "-R", repo, "--reason", "completed"])
    print(f"Geschlossen: {x['id']} · {x['titel']}")
    print(f"  Beleg als Kommentar hinterlegt. Wieder öffnen: gh issue reopen {x['id']} -R {repo}")
    _schluss("schliessen", "OK", id=x["id"])
    return 0


# ── versuch ────────────────────────────────────────────────────────────────────────────
def cmd_versuch(a) -> int:
    repo = _repo(a)
    x = _hole_eine(repo, a.id)
    _pruefe_schwarm(x, "versuch")
    neu = min(x["versuche"] + 1, VERSUCHE_DECKEL)
    entfernen = [f"versuch:{n}" for n in range(1, VERSUCHE_DECKEL + 1)
                 if f"versuch:{n}" in x["_labels"] and n != neu]
    edit = ["issue", "edit", x["id"], "-R", repo, "--add-label", f"versuch:{neu}"]
    for name in entfernen:
        edit += ["--remove-label", name]
    _schreibe(a, edit)
    _schreibe(a, ["issue", "comment", x["id"], "-R", repo,
                  "--body", f"Gescheiterter Versuch {neu} am {_heute()}: {a.grund}"])
    eskaliert = False
    if neu >= VERSUCHE_DECKEL and x["wartet_auf"] != "po":
        _schreibe(a, ["issue", "edit", x["id"], "-R", repo,
                      "--add-label", LABEL_WARTET["po"]])
        _schreibe(a, ["issue", "comment", x["id"], "-R", repo, "--body",
                      f"Eskalation an den Produktinhaber am {_heute()}: {VERSUCHE_DECKEL} "
                      f"Versuche sind gescheitert, zuletzt an — {a.grund}. Die Aufgabe wartet "
                      "ab jetzt auf eine Entscheidung und wird von `naechster` nicht mehr "
                      "ausgegeben."])
        eskaliert = True
    print(f"Versuch {neu} von {VERSUCHE_DECKEL} vermerkt an {x['id']} · {x['titel']}")
    if eskaliert:
        print(f"  Der Deckel ist erreicht: Label `{LABEL_WARTET['po']}` gesetzt, PO-Kommentar "
              "angehängt.\n"
              f"  Nach dem Entscheid freigeben: gh_aufgaben.py setze {x['id']} --wartet-auf keins")
    else:
        print("  Belegung abgeben, damit ein anderer Lauf ran kann: "
              f"gh_aufgaben.py freigebe {x['id']}")
    kv = {"id": x["id"], "versuche": neu}
    if eskaliert:
        kv["eskaliert"] = "po"
    _schluss("versuch", "OK", **kv)
    return 0


# ── freigebe ───────────────────────────────────────────────────────────────────────────
def cmd_freigebe(a) -> int:
    repo = _repo(a)
    x = _hole_eine(repo, a.id)
    if not x["_belegt"] and not x["_assignees"]:
        print(f"Aufgabe {x['id']} war nicht belegt — nichts zu tun.")
        _schluss("freigebe", "OK", id=x["id"], geaendert="nein")
        return 0
    edit = ["issue", "edit", x["id"], "-R", repo]
    if x["_belegt"]:
        edit += ["--remove-label", LABEL_ARBEIT]
    for name in x["_assignees"]:
        edit += ["--remove-assignee", name]
    _schreibe(a, edit)
    print(f"Freigegeben: {x['id']} · {x['titel']}")
    print("  Ein anderer Lauf kann sie jetzt nehmen: gh_aufgaben.py naechster --belegen")
    _schluss("freigebe", "OK", id=x["id"], geaendert="ja")
    return 0


# ── belegungen ─────────────────────────────────────────────────────────────────────────
def cmd_belegungen(a) -> int:
    if a.aufraeumen:
        return _fehler(
            "belegungen",
            "`--aufraeumen` gibt es in diesem Adapter nicht. Eine Belegung ist hier ein Label "
            "auf GitHub und damit für alle sichtbar — sie ist nicht maschinenlokal und kann "
            "nicht wie eine Dateisperre verfallen; dieser Adapter weiß nicht, ob der haltende "
            "Lauf noch lebt.\n"
            "  Sieh nach, wer hält: gh_aufgaben.py belegungen — und gib gezielt zurück: "
            "gh_aufgaben.py freigebe <id>")
    repo = _repo(a)
    belegt = [x for x in _hole_alle(repo) if x["_belegt"]]
    if not belegt:
        print(f"Keine Aufgabe in {repo} trägt das Label `{LABEL_ARBEIT}` — alles frei.")
    else:
        print(f"  {'ID':<7} {'SCHW':<10} {'ASSIGNEE':<20} TITEL")
        for x in belegt:
            print(f"  {x['id']:<7} {x['schwere']:<10} "
                  f"{_kurz(', '.join(x['_assignees']) or '–', 20):<20} {_kurz(x['titel'], 48)}")
        print(f"\n{len(belegt)} belegt. Zurückgeben: gh_aufgaben.py freigebe <id>")
    _schluss("belegungen", "OK", n=len(belegt))
    return 0


# ── notiz ──────────────────────────────────────────────────────────────────────────────
def cmd_notiz(a) -> int:
    repo = _repo(a)
    x = _hole_eine(repo, a.id)
    _schreibe(a, ["issue", "comment", x["id"], "-R", repo,
                  "--body", f"Zwischenstand {_heute()}: {a.text}"])
    print(f"Notiz an {x['id']} angehängt · {x['titel']}")
    _schluss("notiz", "OK", id=x["id"])
    return 0


# ── setze ──────────────────────────────────────────────────────────────────────────────
def cmd_setze(a) -> int:
    repo = _repo(a)
    x = _hole_eine(repo, a.id)
    _pruefe_schwarm(x, "setze")
    ziel = a.wartet_auf
    edit = ["issue", "edit", x["id"], "-R", repo]
    grundlaenge = len(edit)
    for schluessel, name in LABEL_WARTET.items():
        if name in x["_labels"] and schluessel != ziel:
            edit += ["--remove-label", name]
    if ziel != "keins" and LABEL_WARTET[ziel] not in x["_labels"]:
        edit += ["--add-label", LABEL_WARTET[ziel]]
    if len(edit) == grundlaenge:
        print(f"Aufgabe {x['id']} wartet bereits auf `{x['wartet_auf'] or 'keins'}` — "
              "nichts zu tun.")
        _schluss("setze", "OK", id=x["id"], wartet_auf=ziel, geaendert="nein")
        return 0
    _schreibe(a, edit)
    print(f"Gesetzt: {x['id']} wartet_auf={ziel} · {x['titel']}")
    if ziel == "keins":
        print("  Die Aufgabe ist wieder wählbar: gh_aufgaben.py naechster --belegen")
    else:
        print(f"  Sie ist damit aus `naechster` heraus: gh_aufgaben.py liste --wartet-auf {ziel}")
    _schluss("setze", "OK", id=x["id"], wartet_auf=ziel, geaendert="ja")
    return 0


# ── neu ────────────────────────────────────────────────────────────────────────────────
def cmd_neu(a) -> int:
    fehlend = [n for n, w in (("--titel", a.titel), ("--fundort", a.fundort),
                              ("--population", a.population), ("--frage", a.frage))
               if not (w or "").strip()]
    if fehlend:
        return _fehler("neu",
                       "Diese Pflichtangaben fehlen: " + ", ".join(fehlend) + ".\n"
                       "  Eine Aufgabe ohne Fundort, gemessene Population und offene Frage ist "
                       "für den nächsten Lauf wertlos — er müsste alles neu erheben.\n"
                       "  Beispiel: gh_aufgaben.py neu --titel \"Zeitzone im Report falsch\" "
                       "--fundort \"src/report.py:88\" "
                       "--population \"12 Treffer (rg 'localtime' src/)\" "
                       "--frage \"UTC oder Nutzer-Zeitzone?\"")
    repo = _repo(a)
    body = (f"{FUNDORT_PRAEFIX} {a.fundort.strip()}\n\n"
            f"## Population\n\n{a.population.strip()}\n\n"
            f"## Zu klären vor der Reparatur\n\n{a.frage.strip()}\n")
    args = ["issue", "create", "-R", repo, "--title", a.titel.strip(), "--body", body,
            "--label", LABEL_WARTESCHLANGE,
            "--label", f"schwere:{a.schwere}", "--label", f"art:{a.art}"]
    aus = _schreibe(a, args)
    if a.dry_run:
        _schluss("neu", "OK", dry_run="ja")
        return 0
    zeilen = [z.strip() for z in (aus or "").splitlines() if z.strip()]
    url = zeilen[-1] if zeilen else ""
    nummer = url.rsplit("/", 1)[-1] if url else "?"
    print(f"Angelegt: {nummer} · {a.titel.strip()}")
    print(f"  {url}")
    print(f"  Ansehen: gh_aufgaben.py zeig {nummer} --langtext")
    _schluss("neu", "OK", id=nummer)
    return 0


# ── CLI ────────────────────────────────────────────────────────────────────────────────
def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="gh_aufgaben.py",
        description="GitHub Issues als Aufgaben-Register eines Freilauf-Schwarms bedienen.",
        epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", metavar="owner/name",
                   help="Repository. Vorgabe: GH_AUFGABEN_REPO, sonst das Repository des "
                        "aktuellen Arbeitsverzeichnisses.")
    p.add_argument("--dry-run", action="store_true",
                   help="Schreibende Befehle zeigen den gh-Aufruf, führen ihn aber nicht aus.")
    sub = p.add_subparsers(dest="befehl", metavar="<befehl>")

    s = sub.add_parser("liste", help="Offene Aufgaben auflisten (Kopfzeilen oder JSON)",
                       description="Offene Issues mit dem Label `schwarm` auflisten. Mit --json "
                                   "kommt erst die JSON-Liste, danach die Schlusszeile mit n=.",
                       formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    s.add_argument("--frei", action="store_true", help="nur ohne Wartezustand")
    s.add_argument("--unbelegt", action="store_true", help=f"nur ohne Label `{LABEL_ARBEIT}`")
    s.add_argument("--json", action="store_true",
                   help="JSON-Liste der Felder " + ", ".join(FELDER))
    s.add_argument("--wartet-auf", dest="wartet_auf", choices=("po", "mensch", "keins"),
                   help="nach Wartezustand filtern; `keins` heißt: ohne Wartezustand")
    s.add_argument("--schwere", choices=SCHWEREN, help="nach Schweregrad filtern")
    s.add_argument("--lokal", action="store_true",
                   help="wird angenommen und ignoriert (Vertrags-Kompatibilität zu befund.py)")
    s.set_defaults(fn=cmd_liste)

    s = sub.add_parser("naechster", help="Die Aufgabe, die als nächstes dran ist",
                       description="Wählt die älteste passende Aufgabe, die frei von "
                                   "Wartezuständen und unbelegt ist.",
                       formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    s.add_argument("--schwere", choices=SCHWEREN)
    s.add_argument("--belegen", action="store_true",
                   help=f"Label `{LABEL_ARBEIT}` setzen und, wenn möglich, einen Assignee")
    s.add_argument("--lauf", metavar="<id>",
                   help="Lauf-Kennung; wird als Assignee versucht, sonst der angemeldete Benutzer")
    s.add_argument("--min-versuche", type=int, default=0, metavar="N")
    s.add_argument("--max-versuche", type=int, default=None, metavar="N",
                   help=f"Vorgabe {VERSUCHE_DECKEL - 1} (unter dem Deckel {VERSUCHE_DECKEL})")
    s.add_argument("--auch-unverifiziert", action="store_true",
                   help="wird angenommen und ignoriert (GitHub kennt kein Verifiziert-Feld)")
    s.add_argument("--lokal", action="store_true",
                   help="wird angenommen und ignoriert (Vertrags-Kompatibilität zu befund.py)")
    s.set_defaults(fn=cmd_naechster)

    s = sub.add_parser("zeig", help="Eine Aufgabe ansehen", epilog=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("id", help="Issue-Nummer")
    s.add_argument("--langtext", action="store_true", help="Body und Kommentare mit ausgeben")
    s.set_defaults(fn=cmd_zeig)

    s = sub.add_parser("schliessen", help="Aufgabe abschließen (Kommentar mit Beleg, dann close)",
                       epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("id")
    s.add_argument("--beleg", required=True, metavar="<text>",
                   help="Kommando und Ergebnis, die den Fix belegen")
    s.set_defaults(fn=cmd_schliessen)

    s = sub.add_parser("versuch", help="Gescheiterten Versuch protokollieren", epilog=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("id")
    s.add_argument("--grund", required=True, metavar="<text>", help="woran es lag")
    s.set_defaults(fn=cmd_versuch)

    s = sub.add_parser("freigebe", help="Belegung zurückgeben", epilog=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("id")
    s.set_defaults(fn=cmd_freigebe)

    s = sub.add_parser("belegungen", help="Wer hält gerade was", epilog=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("--aufraeumen", action="store_true",
                   help="gibt es hier nicht — meldet das und endet mit Exit 2")
    s.set_defaults(fn=cmd_belegungen)

    s = sub.add_parser("notiz", help="Zwischenstand als Kommentar anhängen", epilog=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("id")
    s.add_argument("--text", required=True, metavar="<text>")
    s.set_defaults(fn=cmd_notiz)

    s = sub.add_parser("setze", help="Wartezustand ändern", epilog=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("id")
    s.add_argument("--wartet-auf", dest="wartet_auf", required=True,
                   choices=("po", "mensch", "keins"))
    s.set_defaults(fn=cmd_setze)

    s = sub.add_parser("neu", help="Aufgabe anlegen", epilog=__doc__,
                       formatter_class=argparse.RawDescriptionHelpFormatter)
    s.add_argument("--titel", required=True, metavar="<t>")
    s.add_argument("--fundort", required=True, metavar="<f>", help="Datei:Zeile")
    s.add_argument("--population", required=True, metavar="<p>",
                   help="gemessene Häufigkeit, mit dem Kommando, das sie erzeugt")
    s.add_argument("--frage", required=True, metavar="<q>",
                   help="was vor der Reparatur zu klären ist")
    s.add_argument("--schwere", choices=SCHWEREN, default="normal")
    s.add_argument("--art", choices=ARTEN, default="aufgabe")
    s.set_defaults(fn=cmd_neu)
    return p


def main(argv: list[str] | None = None) -> int:
    for strom in (sys.stdout, sys.stderr):
        try:
            strom.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 — ältere Ströme können das nicht, dann bleibt es dabei
            pass
    p = _parser()
    a = p.parse_args(argv)
    if not getattr(a, "befehl", None):
        p.print_help()
        return 2
    befehl = a.befehl
    try:
        return int(a.fn(a))
    except UmgebungsFehler as e:
        return _fehler(befehl, str(e), code=3)
    except FachFehler as e:
        return _fehler(befehl, str(e), code=1)
    except KeyboardInterrupt:
        return _fehler(befehl, "Abgebrochen. Wiederhole den Aufruf, wenn es weitergehen soll.",
                       code=1)


if __name__ == "__main__":
    sys.exit(main())
