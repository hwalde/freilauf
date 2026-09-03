#!/usr/bin/env python3
"""dispatch.py — das eine, was Freilauf nicht selbst kann: die offenen Aufgaben zählen.

WAS DAS IST — UND WAS NICHT
  Der Schwarm besteht aus FREILAUF-AGENTEN: vier Worker, ein Dispatcher, dazu der PO-Agent.
  Sie sind im Hub unter „Agenten" sichtbar, laufen als gewöhnliche Freilauf-Läufe und werden
  mit Freilauf-Mitteln gesteuert: `/agents/start` für die Skalierung (derselbe Agent wird
  mehrfach gestartet), Flow-Attachments für den Nachlauf. Dieses Skript startet KEINE
  Prozesse und keine Agenten außerhalb von Freilauf.

  KEIN Agent hat einen eigenen Cron. Den Takt gibt der Wächter-Flow, und der ruft genau
  dieses Skript auf — deshalb ist seine Ausgabe der Punkt, an dem sich entscheidet, ob heute
  überhaupt ein Agent anläuft.

  Seine einzige tragende Aufgabe: zählen, wie viele Aufgaben im Register offen und unbelegt
  sind, und daraus ableiten, ob und wie viele Läufe jetzt starten sollen (`lage`). Dazu ein
  Not-Halt (`stopp`/`weiter`): Der HALT-Marker setzt in `lage` alle Startzahlen auf 0 und
  wirkt damit auf jeden Weg — Wächter, Nachlauf und Dispatcher gleichermaßen.

  Wie gezählt und wie eine Aufgabe geholt/geschlossen wird, steht NICHT in diesem Skript,
  sondern im Block `repo` der Konfig — dem Adapter auf das Aufgaben-Register des Repos.
  Deshalb lässt sich dieser Ordner in jedes Repository kopieren (siehe die index.md daneben).
  Der Ordnername ist frei; das Skript liest ihn aus seinem eigenen Pfad.

AUFRUF
  python schwarm/dispatch.py <befehl> [--help]

  lage      Was offen ist, wer läuft, wie das Guthaben steht, wie viele Starts jetzt fällig sind
  stopp     Not-Halt: Worker-Agenten aus · weiter  Halt aufheben und wieder einschalten
  journal   Was der Schwarm bisher getan hat

BEISPIELE
  python schwarm/dispatch.py lage
  python schwarm/dispatch.py lage --json
  python schwarm/dispatch.py stopp
  python schwarm/dispatch.py weiter
  python schwarm/dispatch.py journal --letzte 20

SCHLUSSZEILE (byte-stabil, für Flows und Skripte)
  SCHWARM_<BEFEHL> result=OK|FAIL [key=value …]

  `lage` trägt die Zahlen, auf die der Cron-Flow seine Bedingungen legt — bewusst in der
  Schlusszeile und nicht nur im JSON, damit ein `contains`-Vergleich nicht an der
  JSON-Einrückung hängt:
  SCHWARM_LAGE result=OK arbeit_da=0|1 po_da=0|1 kandidaten_gesamt=… kandidaten_trivial=…
               kandidaten_schwer=…
               po_offen=… worker_starts_soll=… deepseek_starts_soll=…
               stark_route=fable|gemini|keine stark_starts_soll=0|1
               fable_7d_prozent=…|unbekannt fable_7d_alter_s=…|unbekannt
               kosten_heute_usd=… tages_ampel=gruen|gelb|rot
               budget_ampel=gruen|gelb|rot|unbekannt laufend=… laufend_stark=…
               laufend_dispatcher=… halt=0|1

  `arbeit_da` und `po_da` sind die zwei Flags, auf die die Cron-Flows ihre Bedingung legen.
  Sie sagen „wecken lohnt sich", nicht „es gibt Aufgaben": HALT zieht beide auf 0, eine rote
  Tages-Ampel zusätzlich `arbeit_da`, und `po_da` bleibt 0, solange `po_offen` -1 ist (die
  Zählung war nicht möglich — das ist kein Grund für einen Vortrag).

  `worker_starts_soll` ist bereits gedeckelt: Staffel minus der schon laufenden gewöhnlichen
  Schwarm-Läufe, begrenzt durch `max_worker`. Wer diese Zahl startet, kann den Schwarm nicht
  aufschaukeln. `stark_starts_soll` ist höchstens 1 und schon 0, wenn ein starker Worker läuft.

DIE ZWEI BAHNEN
  Gewöhnlich (GLM, DeepSeek): trivial und normal, mehrere parallel, Deckel `max_worker`.
  Stark (Fable oder das Ausweich-Modell): blockierte und schon gescheiterte Befunde, höchstens
  einer gleichzeitig. Welcher der beiden fährt, sagt `stark_route` — Fable, solange die
  Fable-Wochennutzung unter `fable_7d_max` liegt und die Zahl belastbar ist, sonst das
  Ausweich-Modell. Ist keine Zahl da oder ist sie als stale gemeldet, gilt die konservative
  Sicht (Ausweich-Modell), denn ein Claude-Start liefe sonst nur in ein `deferred`.

EXIT-CODES
  0 OK · 1 fachlicher Fehlschlag (Hub lehnte ab) · 2 Eingabefehler
  3 Umgebung nicht nutzbar (Hub tot, Zähl-Kommando scheitert)

ZUSTAND AUSSERHALB VON GIT
  ~/agents/schwarm/ (überschreibbar per SCHWARM_STATE_DIR):
    journal.jsonl   eine Zeile je Halt-Schaltung · hub_ids.json  Agent- und Flow-IDs
    HALT            solange die Datei existiert, meldet `lage` 0 Starts
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SELF = Path(__file__).resolve()
MOTOR = SELF.parent.name          # der Ordnername dieses Motors im Repo, Vorgabe „schwarm"

# Bis `konfig_laden()` lief, kennt niemand den Projekt-Namensraum. Der Ordnername des Motors
# ist der beste Notnagel: Er ist projektlokal und ohne Konfig verfügbar.
_SLUG = MOTOR
REPO_DEFAULT = SELF.parents[1]

# OS-Spezifik (UTF-8-Ausgabe, Shell-Aufruf) gehört an eine Stelle. Trägt das Zielrepo ein
# eigenes platform_support-Modul, zeigt die Umgebungsvariable SCHWARM_PLATFORM_SUPPORT auf
# dessen Ordner; sonst greift der schlanke Ersatz darunter (bash aus dem PATH, kein
# UTF-8-Erzwingen unter Windows). Der Motor läuft in beiden Fällen.
_ps_pfad = os.environ.get("SCHWARM_PLATFORM_SUPPORT")
if _ps_pfad:
    sys.path.insert(0, str(Path(_ps_pfad).expanduser().resolve()))
try:
    from platform_support import bash_exe, enable_utf8_io
except ImportError:  # pragma: no cover — der Regelfall in einem Repo ohne dieses Modul
    import shutil

    def enable_utf8_io() -> None:
        return

    def bash_exe() -> str:
        return shutil.which("bash") or "bash"


AUSFUELLEN = "<AUSFÜLLEN"        # Marke der Platzhalter in konfig.beispiel.json


def platzhalter_suchen(wert, pfad: str = "") -> list:
    """Alle noch nicht ausgefüllten Platzhalter der Konfig mit ihrem JSON-Pfad."""
    fund = []
    if isinstance(wert, dict):
        for k, v in wert.items():
            if str(k).startswith("_"):
                continue        # Schlüssel mit Unterstrich sind Erklärungen, keine Werte
            fund += platzhalter_suchen(v, f"{pfad}.{k}" if pfad else str(k))
    elif isinstance(wert, list):
        for i, v in enumerate(wert):
            fund += platzhalter_suchen(v, f"{pfad}[{i}]")
    elif isinstance(wert, str) and AUSFUELLEN in wert:
        fund.append((pfad, wert.strip()))
    return fund


def konfig_pruefen(konf: dict, pfad: Path, befehl: str) -> int:
    """0, wenn die Konfig ausgefüllt ist — sonst eine Meldung, die jeden offenen Schlüssel nennt.

    Ohne diese Prüfung startet der Motor mit Platzhaltern als Kommandos und scheitert erst
    weit später an einer Stelle, die nichts mehr mit der Ursache zu tun hat.
    """
    offen = platzhalter_suchen(konf)
    if not offen:
        return 0
    print(f"FEHLER: {pfad} ist noch die Vorlage — {len(offen)} Schlüssel sind nicht "
          f"ausgefüllt:", file=sys.stderr)
    for schluessel, wert in offen:
        print(f"  {schluessel}\n      {wert}", file=sys.stderr)
    print("Nächster Schritt: diese Schlüssel in der Konfig ersetzen. Was hineingehört, "
          "sagt der Platzhaltertext selbst; die Kommandos liefert der Adapter "
          "(adapter/ im Konzept-Ordner).", file=sys.stderr)
    schluss(befehl, False, platzhalter=len(offen))
    return 2


SCHWEREN = ("blockiert", "normal", "trivial")


# ── Ausgabe ──────────────────────────────────────────────────────────────────

def schluss(befehl: str, ok: bool, **kv) -> None:
    teile = [f"SCHWARM_{befehl.upper()}", f"result={'OK' if ok else 'FAIL'}"]
    for k, v in kv.items():
        if isinstance(v, bool):
            v = "1" if v else "0"
        teile.append(f"{k}={v}")
    print(" ".join(teile))


def fehler(befehl: str, text: str, *, naechster_schritt: str = "", code: int = 1, **kv) -> int:
    print(f"FEHLER: {text}", file=sys.stderr)
    if naechster_schritt:
        print(f"Nächster Schritt: {naechster_schritt}", file=sys.stderr)
    schluss(befehl, False, **kv)
    return code


# ── Zustand außerhalb von git ────────────────────────────────────────────────

def projekt_slug(konf: dict | None = None) -> str:
    """Der Namensraum dieses Schwarms — ein Ordnername, kein Anzeigename."""
    global _SLUG
    if konf:
        roh = (konf.get("repo") or {}).get("name") or ""
        if roh:
            _SLUG = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(roh)).strip("-") or "schwarm"
    return _SLUG


def state_dir(konf: dict | None = None) -> Path:
    """Der Zustand außerhalb von git — JE PROJEKT ein eigener Ordner.

    Früher war das ein einziger globaler Ordner. Das trägt genau so lange, wie auf einer
    Maschine nur ein Schwarm läuft: Der zweite überschreibt `hub_ids.json` des ersten, und
    dessen Dispatcher startet danach fremde Agenten. Sein HALT-Marker hielte beide an, sein
    Journal vermischte beide. Deshalb `~/agents/schwarm/<projekt-slug>/`.

    `SCHWARM_STATE_DIR` bleibt der Override und wird NICHT um den Slug erweitert — wer ihn
    setzt, hat den Namensraum schon gewählt.
    """
    roh = os.environ.get("SCHWARM_STATE_DIR")
    d = Path(roh) if roh else Path.home() / "agents" / "schwarm" / projekt_slug(konf)
    d.mkdir(parents=True, exist_ok=True)
    return d


def journal_schreib(eintrag: dict) -> None:
    eintrag = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), **eintrag}
    with open(state_dir() / "journal.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(eintrag, ensure_ascii=False) + "\n")


def halt_marker() -> Path:
    return state_dir() / "HALT"


def hub_ids() -> dict:
    pfad = state_dir() / "hub_ids.json"
    if not pfad.is_file():
        return {}
    try:
        konf = json.loads(pfad.read_text(encoding="utf-8"))
        projekt_slug(konf)          # Namensraum für state_dir() festlegen
        return konf
    except (ValueError, OSError):
        return {}


# ── Konfiguration ────────────────────────────────────────────────────────────

def konfig_pfad(repo: Path, explizit: str = "") -> Path:
    """Die Konfig: entweder ausdrücklich genannt (--konfig) oder <repo>/<motor>/konfig.json."""
    return Path(explizit).expanduser().resolve() if explizit else repo / MOTOR / "konfig.json"


def konfig_laden(repo: Path, explizit: str = "") -> dict:
    pfad = konfig_pfad(repo, explizit)
    try:
        return json.loads(pfad.read_text(encoding="utf-8"))
    except OSError as e:
        raise SystemExit(fehler("konfig", f"{pfad} nicht lesbar ({e.strerror}).",
                                naechster_schritt=f"--repo <pfad zum checkout> oder --konfig "
                                                  f"<datei> setzen; die Vorlage heißt "
                                                  f"konfig.beispiel.json.", code=3))
    except ValueError as e:
        raise SystemExit(fehler("konfig", f"{pfad} ist kein gültiges JSON: {e}",
                                naechster_schritt="Datei reparieren; die Vorlage dazu ist "
                                                  "konfig.beispiel.json.", code=3))


def repo_id(konf: dict) -> int:
    return int((konf.get("repo") or {}).get("repo_id", 1))


# ── Freilauf-Hub ─────────────────────────────────────────────────────────────

class _KeinRedirect(urllib.request.HTTPRedirectHandler):
    """303 ist bei den HTML-Endpunkten die ERFOLGSMELDUNG — sie darf nicht verschluckt werden."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_KeinRedirect)


def hub_url() -> str:
    for var in ("FL_HUB_URL", "FREILAUF_HUB_URL"):
        wert = os.environ.get(var)
        if wert:
            return wert.rstrip("/")
    # Visitenkarte, die Freilauf neben seine Skills legt
    for kandidat in sorted((Path.home() / ".claude" / "skills")
                           .glob("freilauf-*/.freilauf-skill.json")):
        try:
            daten = json.loads(kandidat.read_text(encoding="utf-8"))
            url = (daten.get("installation") or {}).get("url")
            if url:
                return str(url).rstrip("/")
        except (ValueError, OSError):
            continue
    return "http://127.0.0.1:8791"


def hub_get(pfad: str, **params):
    url = hub_url() + pfad
    if params:
        url += "?" + urllib.parse.urlencode(
            {k: v for k, v in params.items() if v not in (None, "")})
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as antwort:
        return json.loads(antwort.read().decode("utf-8"))


def hub_post_form(pfad: str, felder) -> tuple:
    """POST als Formular ohne Redirect-Auflösung. Rückgabe (status, body): 303 = gespeichert."""
    paare = [(k, str(v)) for k, v in (felder.items() if isinstance(felder, dict) else felder)
             if v not in (None, "")]
    daten = urllib.parse.urlencode(paare).encode("utf-8")
    req = urllib.request.Request(hub_url() + pfad, data=daten, method="POST",
                                 headers={"content-type": "application/x-www-form-urlencoded"})
    try:
        with _OPENER.open(req, timeout=60) as antwort:
            return antwort.status, antwort.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def hub_post_json(pfad: str, koerper: dict) -> dict:
    daten = json.dumps(koerper, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(hub_url() + pfad, data=daten, method="POST",
                                 headers={"content-type": "application/json",
                                          "accept": "application/json"})
    try:
        with _OPENER.open(req, timeout=60) as antwort:
            return json.loads(antwort.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        roh = e.read().decode("utf-8", "replace")
        try:
            return json.loads(roh)
        except ValueError:
            return {"ok": False, "problems": [f"HTTP {e.code}: {roh[:300]}"]}


# ── Aufgaben zählen (repo-spezifisch, aus der Konfig) ────────────────────────

def aufgaben(repo: Path, konf: dict) -> list:
    """Die offenen, unbelegten Aufgaben — über das Kommando aus konfig.repo.aufgaben_liste_json."""
    kommando = (konf.get("repo") or {}).get("aufgaben_liste_json")
    if not kommando:
        raise SystemExit(fehler("lage", "konfig.repo.aufgaben_liste_json fehlt.",
                                naechster_schritt=f"In {MOTOR}/konfig.json ein Kommando "
                                                  f"eintragen, das die offenen Aufgaben als "
                                                  f"JSON-Liste druckt (siehe adapter/).",
                                code=2))
    p = subprocess.run([bash_exe(), "-lc", kommando], cwd=str(repo), capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise SystemExit(fehler("lage", f"Zähl-Kommando scheiterte (Exit {p.returncode}): "
                                        f"{(p.stderr or p.stdout).strip()[:300]}",
                                naechster_schritt=f"Von Hand fahren: {kommando}", code=3))
    # Auf das JSON darf eine byte-stabile Schlusszeile folgen (Vertrag der Werkzeuge dieses
    # Repos) — raw_decode liest nur den JSON-Kopf und ignoriert den Rest.
    roh = p.stdout.lstrip()
    try:
        return json.JSONDecoder().raw_decode(roh)[0] if roh else []
    except ValueError:
        raise SystemExit(fehler("lage", "Das Zähl-Kommando lieferte kein JSON.",
                                naechster_schritt=f"Von Hand fahren: {kommando}", code=3))


VERSUCHS_DECKEL_VORGABE = 3  # Vorgabe: ab so vielen Versuchen geht eine Aufgabe an den Menschen.


def versuchs_deckel(konf: dict) -> int:
    """Ab wie vielen Versuchen eine Aufgabe an einen Menschen geht — aus der Konfig.

    Nicht als Modul-Konstante: Ein fremder Adapter darf einen anderen Deckel führen, und ein
    hart verdrahteter Wert zählt dort still falsch. Der Wert MUSS zu dem passen, was das
    Aufgaben-Werkzeug selbst tut (siehe adapter/EIGENER-ADAPTER.md).
    """
    return int(konf.get("versuchs_deckel", VERSUCHS_DECKEL_VORGABE))


def erlaubte_schweren(konf: dict) -> tuple:
    """Die Schweregrade der GEWÖHNLICHEN Bahn (glm/ds).

    `blockiert` gehört nie dazu: Dieser Schalter (`blockiert_erlaubt`) gilt allein für die
    starke Bahn. Schwache Urteiler sollen nicht nach der Arbeit greifen, für die es einen
    starken Worker gibt.
    """
    return tuple(s for s in (konf.get("schweregrade") or ["trivial", "normal"])
                 if s != "blockiert")


def kandidaten(liste: list, konf: dict) -> list:
    f = (konf.get("repo") or {}).get("listen_felder") or {}
    k_schwere, k_versuche = f.get("schwere", "schwere"), f.get("versuche", "versuche")
    erlaubt = erlaubte_schweren(konf)
    # Obergrenze ist NICHT der Versuchs-Deckel, sondern der Einstieg der starken Bahn: Was
    # dort hingehört, darf hier nicht mehr mitgezählt werden — sonst weckt die Staffel Worker
    # für Arbeit, die ihr Hol-Kommando nicht mehr hergibt.
    grenze = int(konf.get("stark_min_versuche", 2))
    return [b for b in liste
            if b.get(k_schwere) in erlaubt
            and int(b.get(k_versuche) or 0) < grenze]


def kandidaten_schwer(liste: list, konf: dict) -> list:
    """Die Aufgaben der STARKEN Bahn — gezählt wie sie geholt werden, nie großzügiger.

    Der starke Worker fragt zwei Dinge an: `--schwere blockiert`, und danach die schon
    gescheiterten in genau den Schweregraden aus seiner Konfig, ab `stark_min_versuche`
    Versuchen. Diese Funktion bildet dieselbe Menge — jede Abweichung nach oben weckt einen
    Worker, der dann nichts findet.

    Die Liste kommt aus `aufgaben_liste_json` und ist damit bereits frei (kein `wartet_auf`)
    und unbelegt. Was den Versuchs-Deckel erreicht hat, ist für niemanden mehr Arbeit — das
    Register hat es dann selbst auf `wartet_auf: po` gestellt.
    """
    f = (konf.get("repo") or {}).get("listen_felder") or {}
    k_schwere, k_versuche = f.get("schwere", "schwere"), f.get("versuche", "versuche")
    blockiert_zaehlt = bool(konf.get("blockiert_erlaubt"))
    mindest = int(konf.get("stark_min_versuche", 2))
    deckel = versuchs_deckel(konf)
    # Genau die Schweregrade, die der starke Worker im zweiten Hol-Versuch anfragt — sonst
    # zählt `lage` mehr, als der Worker holen kann, und der Dispatcher startet ihn auf eine
    # Aufgabe, die es für ihn nicht gibt. Ein Fable-Lauf für n=0 kostet Wochenquote.
    gescheitert_schweren = {s for w in konf.get("worker_agenten") or [] if w.get("stark")
                            for s in (w.get("schweregrade") or []) if s != "blockiert"}
    treffer = []
    for b in liste:
        versuche = int(b.get(k_versuche) or 0)
        # EINSCHLIESSLICH des Deckels. Eine vom Menschen wieder freigegebene Aufgabe behält
        # ihren Zähler — die meisten Aufgaben-Werkzeuge setzen ihn beim Lösen der Marke nicht
        # zurück. Zählte man sie hier heraus, fände sie das Hol-Kommando
        # (`aufgabe_holen_zusatz_stark`) zwar noch, aber niemand weckte je einen Worker dafür:
        # Sie bliebe für immer liegen, und genau das soll dieses System nicht können.
        if versuche > deckel:
            continue
        if b.get(k_schwere) == "blockiert":
            if blockiert_zaehlt:
                treffer.append(b)
        elif versuche >= mindest and b.get(k_schwere) in gescheitert_schweren:
            treffer.append(b)
    return treffer


def po_offen(repo: Path, konf: dict) -> int:
    """Wie viele Aufgaben auf eine Entscheidung eines Menschen warten (`wartet_auf: po`).

    Kein Fehlschlag, wenn das Kommando fehlt oder scheitert: Diese Zahl ist ein Bericht an
    den Menschen, kein Schaltkriterium — -1 heißt „nicht ermittelbar"."""
    kommando = (konf.get("repo") or {}).get("po_liste_json")
    if not kommando:
        return -1
    p = subprocess.run([bash_exe(), "-lc", kommando], cwd=str(repo), capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        return -1
    roh = (p.stdout or "").lstrip()
    try:
        return len(json.JSONDecoder().raw_decode(roh)[0]) if roh else 0
    except (ValueError, TypeError):
        return -1


# ── Agenten des Schwarms ─────────────────────────────────────────────────────

def agenten_im_hub(konf: dict) -> dict:
    """Name → Agenten-Zeile, für die fünf Agenten dieses Schwarms."""
    namen = {w["name"] for w in konf.get("worker_agenten") or []}
    namen.add(konf.get("dispatcher_name", "Schwarm-Dispatcher"))
    gefunden = {}
    for a in hub_get("/api/agents", repo=repo_id(konf)).get("agents") or []:
        if a.get("name") in namen:
            gefunden[a["name"]] = a
    return gefunden


def laufende(konf: dict) -> list:
    """Läufe der Schwarm-Agenten, die gerade in der Luft sind.

    Jeder Treffer trägt zwei Marken: `stark` für die starke Bahn (Fable/Gemini) und
    `dispatcher` für den Dispatcher selbst. Drei Kategorien, nicht zwei — denn der Dispatcher
    rechnet die Staffel, WÄHREND er läuft. Zählte er als gewöhnlicher Worker mit, bliebe von
    `max_worker` immer ein Platz weniger übrig, und die oberste Stufe der Staffel wäre nie
    erreichbar. `max_worker` gilt für die gewöhnliche Bahn, `stark_max_parallel` für die
    starke, und für den Dispatcher sorgen die Flows mit ihrem eigenen `count_runs`.
    """
    im_hub = agenten_im_hub(konf)
    stark_ids = {im_hub[w["name"]]["id"] for w in konf.get("worker_agenten") or []
                 if w.get("stark") and w["name"] in im_hub}
    disp = im_hub.get(konf.get("dispatcher_name", "Schwarm-Dispatcher"))
    disp_ids = {disp["id"]} if disp else set()
    ids = {a["id"] for a in im_hub.values()}
    treffer = []
    for status in ("running", "waiting_help", "scheduled", "deferred"):
        for r in (hub_get("/api/runs", repo=repo_id(konf), status=status,
                          limit=200).get("runs") or []):
            if r.get("agent_id") in ids:
                treffer.append({"id": r.get("id"), "short_id": r.get("short_id"),
                                "agent": r.get("agent_name"), "status": r.get("status"),
                                "started_at": r.get("started_at"),
                                "stark": r.get("agent_id") in stark_ids,
                                "dispatcher": r.get("agent_id") in disp_ids})
    return treffer


# ── Budget ───────────────────────────────────────────────────────────────────

def budget(konf: dict) -> dict:
    grenzen = konf.get("budgets") or {}
    erg = {"openrouter_usd": None, "deepseek_usd": None, "deepseek_verfuegbar": None,
           "ampel": "unbekannt", "gruende": [],
           "hinweis": "Zahlen aus dem Hub-Cache (TTL 60 s) — bis zu eine Minute alt."}
    try:
        daten = hub_get("/api/usage")
    except (urllib.error.URLError, OSError, ValueError) as e:
        erg["gruende"].append(f"Hub antwortet nicht auf /api/usage ({e})")
        return erg
    for eintrag in daten.get("balances") or []:
        if not eintrag.get("ok"):
            erg["gruende"].append(f"{eintrag.get('provider')}: konfiguriert, aber stumm")
            continue
        d = eintrag.get("data") or {}
        usd = None
        for betrag in d.get("amounts") or []:
            if (betrag.get("currency") or "").upper() == "USD":
                usd = betrag.get("remaining")
        if eintrag.get("provider") == "openrouter":
            erg["openrouter_usd"] = usd
        elif eintrag.get("provider") == "deepseek":
            erg["deepseek_usd"] = usd
            erg["deepseek_verfuegbar"] = d.get("available")
    o_min = float(grenzen.get("openrouter_min_usd", 0) or 0)
    d_min = float(grenzen.get("deepseek_min_usd", 0) or 0)
    erg["openrouter_ok"] = erg["openrouter_usd"] is None or erg["openrouter_usd"] >= o_min
    erg["deepseek_ok"] = ((erg["deepseek_usd"] is None or erg["deepseek_usd"] >= d_min)
                          and erg["deepseek_verfuegbar"] is not False)
    if not erg["openrouter_ok"]:
        erg["gruende"].append(f"OpenRouter {erg['openrouter_usd']} USD < {o_min}")
    if not erg["deepseek_ok"]:
        erg["gruende"].append(f"DeepSeek {erg['deepseek_usd']} USD < {d_min} "
                              f"oder available=false")
    # „Nicht berichtet" ist nie „null": ohne Zahl bleibt die Ampel unbekannt, nicht rot.
    if not erg["openrouter_ok"] and not erg["deepseek_ok"]:
        erg["ampel"] = "rot"
    elif not erg["openrouter_ok"] or not erg["deepseek_ok"]:
        erg["ampel"] = "gelb"
    elif erg["openrouter_usd"] is None and erg["deepseek_usd"] is None:
        erg["ampel"] = "unbekannt"
    else:
        erg["ampel"] = "gruen"
    return erg


def kosten_heute(konf: dict) -> dict:
    """Was die Schwarm-Läufe dieses Kalendertages (UTC) an echtem API-Geld gekostet haben.

    Nur `cost_usd` — die Zahl, die der Harness wirklich berichtet. Ein Claude-Abo-Lauf hat
    keine: Sein Preis ist der Anteil an der Wochenquote, und den deckelt `fable_7d_max`.
    """
    grenze = float(konf.get("tages_budget_usd", 0) or 0)
    erg = {"usd": 0.0, "laeufe": 0, "grenze_usd": grenze, "ampel": "gruen",
           "ohne_zahl": 0, "grund": ""}
    ids = {a["id"] for a in agenten_im_hub(konf).values()}
    heute = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for r in hub_get("/api/runs", repo=repo_id(konf), limit=200).get("runs") or []:
        if r.get("agent_id") not in ids:
            continue
        if not str(r.get("started_at") or "").startswith(heute):
            continue
        erg["laeufe"] += 1
        if r.get("cost_usd") is None:
            erg["ohne_zahl"] += 1
        else:
            erg["usd"] += float(r["cost_usd"])
    erg["usd"] = round(erg["usd"], 4)
    if grenze <= 0:
        erg["grund"] = "keine Tagesgrenze gesetzt"
        return erg
    if erg["usd"] >= 2 * grenze:
        erg["ampel"] = "rot"
        erg["grund"] = (f"{erg['usd']} USD heute ≥ 2 × {grenze} USD — es wird nichts "
                        f"gestartet")
    elif erg["usd"] >= grenze:
        erg["ampel"] = "gelb"
        erg["grund"] = (f"{erg['usd']} USD heute ≥ {grenze} USD — die starke Bahn fällt "
                        f"aus, die gewöhnliche läuft weiter")
    else:
        erg["grund"] = f"{erg['usd']} von {grenze} USD an {erg['laeufe']} Läufen heute"
    return erg


# ── Claude-Kontingent (die starke Bahn) ──────────────────────────────────────

def claude_quota(konf: dict) -> dict:
    """Die Fable-Wochennutzung und das 5-Stunden-Fenster aus `/api/usage`.

    `seven` wäre die falsche Zahl: Sie ist das MAXIMUM aller Wochenfenster, nicht das
    Fenster, das einen Fable-Lauf bindet. Gebunden wird ein Fable-Lauf vom Fenster mit dem
    Label „Fable" (`weekly_scoped`), ersatzweise vom Feld `seven_fable`.

    Jede Zahl kommt mit ihrem Alter. Eine als `stale` gemeldete Zahl gilt hier als NICHT
    nutzbar: Direkt nach einem Reset kann der erinnerte Wert noch der alte sein, und wer
    darauf einen Claude-Start baut, kauft sich ein `deferred`. Ohne belastbare Zahl fährt
    die starke Bahn auf Gemini — die konservative Sicht.
    """
    erg = {"fable_7d_prozent": None, "fable_7d_stale": None, "fable_7d_alter_s": None,
           "fable_7d_resets_at": None, "claude_5h_prozent": None, "claude_5h_stale": None,
           "claude_konfiguriert": False, "fable_nutzbar": False, "gruende": [],
           "hinweis": "Zahlen aus dem Hub-Cache (TTL 60 s) — bis zu eine Minute alt."}
    try:
        daten = hub_get("/api/usage")
    except (urllib.error.URLError, OSError, ValueError) as e:
        erg["gruende"].append(f"Hub antwortet nicht auf /api/usage ({e})")
        return erg
    eintrag = next((u for u in daten.get("usage") or [] if u.get("harness") == "claude"), None)
    if eintrag is None:
        erg["gruende"].append("Claude Code ist auf diesem Hub nicht eingerichtet")
        return erg
    erg["claude_konfiguriert"] = True
    if not eintrag.get("ok"):
        erg["gruende"].append("Claude Code ist eingerichtet, antwortet aber nicht")
        return erg
    d = eintrag.get("data") or {}
    jetzt_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    fenster = next((w for w in d.get("weekly_scoped") or []
                    if "fable" in str(w.get("label") or "").lower()), None)
    if fenster:
        erg["fable_7d_prozent"] = fenster.get("pct")
        erg["fable_7d_stale"] = bool(fenster.get("stale"))
        erg["fable_7d_resets_at"] = fenster.get("resets_at")
        if fenster.get("at"):
            erg["fable_7d_alter_s"] = max(0, (jetzt_ms - int(fenster["at"])) // 1000)
    elif d.get("seven_fable") is not None:
        erg["fable_7d_prozent"] = d.get("seven_fable")
        erg["fable_7d_stale"] = False
        erg["fable_7d_resets_at"] = d.get("seven_fable_resets_at")

    erg["claude_5h_prozent"] = d.get("five")
    erg["claude_5h_stale"] = d.get("five_at") is not None

    grenze = float(konf.get("fable_7d_max", 80) or 80)
    grenze_5h = float(konf.get("claude_5h_max", 90) or 90)
    if erg["fable_7d_prozent"] is None:
        erg["gruende"].append("Fable-Wochenfenster meldet keine Zahl")
    elif erg["fable_7d_stale"]:
        erg["gruende"].append(
            f"Fable-Wochenfenster {erg['fable_7d_prozent']} % ist als stale gemeldet "
            f"(gelesen vor {erg['fable_7d_alter_s']} s) — nicht belastbar")
    elif float(erg["fable_7d_prozent"]) >= grenze:
        erg["gruende"].append(f"Fable-Woche {erg['fable_7d_prozent']} % ≥ {grenze} %")
    elif erg["claude_5h_prozent"] is not None and float(erg["claude_5h_prozent"]) >= grenze_5h:
        erg["gruende"].append(f"Claude-5-Stunden-Fenster {erg['claude_5h_prozent']} % "
                              f"≥ {grenze_5h} % — ein Start würde deferred")
    else:
        erg["fable_nutzbar"] = True
    return erg


# ── Der Schaltplan ───────────────────────────────────────────────────────────

def start_stufe(anzahl: int, konf: dict) -> int:
    """Wie viele GLM-Worker-Läufe bei so vielen Kandidaten gestartet werden sollen."""
    stufe = 0
    for s in sorted(konf.get("startstufen") or [], key=lambda x: x.get("ab_kandidaten", 0)):
        if anzahl >= int(s.get("ab_kandidaten", 0)):
            stufe = int(s.get("starts", 0))
    return stufe


def stark_plan(konf: dict, schwer: int, quota: dict, bud: dict, halt: bool,
               laufend_stark: int, tag: dict) -> dict:
    """Welcher starke Worker jetzt laufen soll — höchstens einer, nie zwei.

    Rangfolge: Gibt es nichts Schweres, läuft nichts. Läuft schon ein starker Worker, kommt
    kein zweiter dazu. Sonst entscheidet die Fable-Wochennutzung: unter `fable_7d_max`
    Prozent Claude Code mit Modell `fable`, darüber (oder ohne belastbare Zahl) OpenCode mit
    Gemini. Reicht auch das Gemini-Guthaben nicht, läuft gar nichts — ein Start liefe sonst
    nur in ein `deferred`.
    """
    gruende = []
    deckel = int(konf.get("stark_max_parallel", 1) or 1)
    if halt:
        return {"route": "keine", "starts": 0,
                "grund": "Halt-Marker gesetzt — es wird nichts gestartet"}
    if tag.get("ampel") in ("gelb", "rot"):
        return {"route": "keine", "starts": 0,
                "grund": f"Tages-Ampel {tag['ampel']}: {tag['grund']}"}
    if schwer < 1:
        return {"route": "keine", "starts": 0,
                "grund": "kein blockierter und kein gescheiterter Befund frei"}
    if laufend_stark >= deckel:
        return {"route": "keine", "starts": 0,
                "grund": f"{laufend_stark} starker Worker in der Luft, "
                         f"stark_max_parallel={deckel} — kein zweiter"}
    if quota.get("fable_nutzbar"):
        gruende.append(f"Fable-Woche {quota.get('fable_7d_prozent')} % < "
                       f"{konf.get('fable_7d_max', 80)} % ⇒ Claude Code mit Modell fable")
        return {"route": "fable", "starts": 1, "grund": "; ".join(gruende)}
    gruende.extend(quota.get("gruende") or ["Fable-Kontingent nicht nutzbar"])
    if not bud.get("openrouter_ok", True):
        gruende.append("OpenRouter unter der Schwelle — auch Gemini fällt aus")
        return {"route": "keine", "starts": 0, "grund": "; ".join(gruende)}
    gruende.append("⇒ OpenCode mit google/gemini-3.8-flash")
    return {"route": "gemini", "starts": 1, "grund": "; ".join(gruende)}


def startplan(konf: dict, anzahl: int, trivial: int, bud: dict, halt: bool,
              laufend: int, tag: dict) -> dict:
    """Wie viele Läufe je Worker-Agent der GEWÖHNLICHEN Bahn jetzt zusätzlich starten sollen.

    Skaliert wird über die Zahl der Starts desselben Agenten, nicht über Ein-/Ausschalten.
    Die Obergrenze `max_worker` gilt für die gewöhnliche Bahn und rechnet deren bereits
    laufende Läufe ab — sonst schaukelt sich jeder Takt weiter auf. Die starke Bahn hat
    ihren eigenen Deckel (`stark_max_parallel`) und zählt hier nicht mit.
    """
    gruende = []
    frei = max(0, int(konf.get("max_worker", 3)) - laufend)
    # Der DeepSeek-Worker bekommt seinen Platz ZUERST: Er ist der billige Spezialist für die
    # trivialen Aufgaben, und die GLM-Staffel würde den Deckel sonst regelmäßig allein
    # ausschöpfen — gemessen: 42 Kandidaten ⇒ Staffel 3 ⇒ 0 Plätze für DeepSeek.
    ds = 1 if (trivial >= 1 and bud.get("deepseek_ok", True)) else 0
    ds = min(ds, frei)
    gruende.append(f"DeepSeek {ds} Start ({trivial} triviale frei, Guthaben "
                   f"{'ok' if bud.get('deepseek_ok', True) else 'zu knapp'})")
    glm = start_stufe(anzahl, konf)
    gruende.append(f"{anzahl} Kandidaten ⇒ Staffel {glm}")
    if not bud.get("openrouter_ok", True):
        glm = 0
        gruende.append("OpenRouter unter der Schwelle — kein GLM-Start")
    glm = min(glm, max(0, frei - ds))
    if halt:
        glm = ds = 0
        gruende.append("Halt-Marker gesetzt — es wird nichts gestartet")
    if tag.get("ampel") == "rot":
        glm = ds = 0
        gruende.append(f"Tages-Ampel rot: {tag['grund']}")
    gruende.append(f"{laufend} gewöhnliche Schwarm-Läufe in der Luft, max_worker="
                   f"{konf.get('max_worker', 3)} ⇒ {frei} Plätze frei")
    return {"glm_starts": glm, "deepseek_starts": ds, "frei": frei,
            "versatz_minuten": int(konf.get("versatz_minuten", 3)),
            "grund": "; ".join(gruende)}


def lage_erheben(repo: Path, konf: dict) -> dict:
    liste = aufgaben(repo, konf)
    f = (konf.get("repo") or {}).get("listen_felder") or {}
    k_schwere = f.get("schwere", "schwere")
    kand = kandidaten(liste, konf)
    schwer = kandidaten_schwer(liste, konf)
    nach_schwere = {s: sum(1 for b in kand if b.get(k_schwere) == s) for s in SCHWEREN}
    try:
        agenten = agenten_im_hub(konf)
        in_arbeit = laufende(konf)
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise SystemExit(fehler("lage", f"Hub {hub_url()} antwortet nicht ({e}).",
                                naechster_schritt="fl-api --url · Hub starten, dann erneut.",
                                code=3))
    bud = budget(konf)
    quota = claude_quota(konf)
    tag = kosten_heute(konf)
    halt = halt_marker().exists()
    po_zahl = po_offen(repo, konf)
    laufend_stark = [r for r in in_arbeit if r.get("stark")]
    laufend_dispatcher = [r for r in in_arbeit if r.get("dispatcher")]
    laufend_normal = [r for r in in_arbeit
                      if not r.get("stark") and not r.get("dispatcher")]
    plan = startplan(konf, len(kand), nach_schwere["trivial"], bud, halt,
                     len(laufend_normal), tag)
    plan_stark = stark_plan(konf, len(schwer), quota, bud, halt, len(laufend_stark), tag)

    k_id, k_art, k_titel = f.get("id", "id"), f.get("art", "art"), f.get("titel", "titel")
    k_fundort = f.get("fundort", "fundort")
    return {
        "stand": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "repo_id": repo_id(konf), "repo_pfad": str(repo), "hub": hub_url(), "halt": halt,
        "aufgaben": {"kandidaten": len(kand), "nach_schwere": nach_schwere,
                     "roh_offen": len(liste), "schwer": len(schwer),
                     "erlaubte_schweregrade": list(erlaubte_schweren(konf))},
        "kandidaten": [{"id": b.get(k_id), "art": b.get(k_art), "schwere": b.get(k_schwere),
                        "titel": (b.get(k_titel) or "")[:160],
                        "fundorte": len(b.get(k_fundort) or [])} for b in kand[:25]],
        "schwere_kandidaten": [{"id": b.get(k_id), "schwere": b.get(k_schwere),
                                "versuche": int(b.get(f.get("versuche", "versuche")) or 0),
                                "titel": (b.get(k_titel) or "")[:160]} for b in schwer[:25]],
        "agenten": [{"name": n, "id": a["id"], "aktiv": bool(a["active"]),
                     "cron": a.get("schedule"), "model": a.get("model"),
                     "route": next((w["route"] for w in konf.get("worker_agenten") or []
                                    if w["name"] == n), None)}
                    for n, a in sorted(agenten.items())],
        "laufende": in_arbeit,
        "budget": bud,
        "claude_quota": quota,
        "tageskosten": tag,
        "startplan": plan,
        "startplan_stark": plan_stark,
        # Die Zahlen, auf die der Cron-Flow seine Bedingungen legt — flach und gleichlautend
        # mit der Schlusszeile, damit ein `contains` nicht an der JSON-Einrückung hängt.
        "kandidaten_gesamt": len(kand),
        "kandidaten_trivial": nach_schwere["trivial"],
        "kandidaten_schwer": len(schwer),
        "po_offen": po_zahl,
        "fable_7d_prozent": quota["fable_7d_prozent"],
        "fable_7d_alter_s": quota["fable_7d_alter_s"],
        "fable_7d_stale": quota["fable_7d_stale"],
        "kosten_heute_usd": tag["usd"],
        "tages_ampel": tag["ampel"],
        # Zwei Flags für die beiden Cron-Flows. Ein Flow kann kein UND: Jede Verknüpfung
        # hieße denselben Teilbaum zweimal im JSON, und eine der beiden Fassungen veraltet
        # still. Die Verknüpfung gehört deshalb hierher, wo sie einmal steht und prüfbar ist.
        #
        # `arbeit_da` heißt nicht „es gibt Aufgaben", sondern „es lohnt sich, den Dispatcher
        # zu wecken". Deshalb ziehen HALT und die rote Tages-Ampel es auf 0: Ein Dispatcher,
        # der bei gesetztem HALT geweckt wird, rechnet lauter Nullen aus und kostet trotzdem
        # einen GLM-Lauf — zwölfmal am Tag, für nichts.
        "arbeit_da": 0 if (halt or tag["ampel"] == "rot")
                     else (1 if (len(kand) > 0 or len(schwer) > 0) else 0),
        # `po_da` ist aus demselben Grund ein Flag und keine Zahl: `po_offen` ist -1, wenn die
        # Zählung nicht möglich war, und „nicht ermittelbar" darf keinen Vortrag auslösen.
        "po_da": 1 if (po_zahl > 0 and not halt) else 0,
        "worker_starts_soll": plan["glm_starts"],
        "deepseek_starts_soll": plan["deepseek_starts"],
        "stark_route": plan_stark["route"],
        "stark_starts_soll": plan_stark["starts"],
        "laufend_stark": len(laufend_stark),
        "laufend_dispatcher": len(laufend_dispatcher),
        "budget_ampel": bud["ampel"],
    }


def lage_drucken(l: dict) -> None:
    print(f"Schwarm-Lage · {l['stand']} · Repo {l['repo_id']} · Hub {l['hub']}")
    if l["halt"]:
        print("  HALT gesetzt — alle Worker gehen aus. Aufheben: dispatch.py weiter")
    a = l["aufgaben"]
    print(f"  Offen und unbelegt (erlaubt: {', '.join(a['erlaubte_schweregrade'])}): "
          f"{a['kandidaten']} von {a['roh_offen']}")
    print("    nach Schwere: " + ", ".join(f"{s}={a['nach_schwere'][s]}" for s in SCHWEREN))
    print(f"    für die starke Bahn (blockiert oder schon gescheitert): {a['schwer']}")
    print(f"    wartet auf einen Menschen (wartet_auf: po): "
          f"{l['po_offen'] if l['po_offen'] >= 0 else 'nicht ermittelbar'}")
    print("  Agenten im Hub:")
    stark_route = l["stark_route"]
    for ag in l["agenten"]:
        if ag["route"] is None:
            starts = ""
        elif ag["route"] == "deepseek":
            starts = f"  → {l['deepseek_starts_soll']}× starten"
        elif ag["route"] in ("fable", "gemini"):
            starts = (f"  → {l['stark_starts_soll']}× starten"
                      if ag["route"] == stark_route else "  → 0× starten")
        else:
            starts = f"  → {l['worker_starts_soll']}× starten"
        print(f"      #{ag['id']:<4} {'AN ' if ag['aktiv'] else 'aus'}  {ag['name']:<36} "
              f"cron={ag['cron'] or 'manuell':<14}{starts}")
    print(f"  In der Luft: {len(l['laufende'])} (davon stark: {l['laufend_stark']}, "
          f"Dispatcher: {l['laufend_dispatcher']} — der zählt nicht gegen max_worker)")
    for r in l["laufende"]:
        print(f"      {r['short_id']}  {r['status']:<10}  {r['agent']}")
    b = l["budget"]
    print(f"  Budget: Ampel {b['ampel']} · OpenRouter {b['openrouter_usd']} USD · "
          f"DeepSeek {b['deepseek_usd']} USD")
    print(f"    {b['hinweis']}")
    for g in b["gruende"]:
        print(f"    ! {g}")
    t = l["tageskosten"]
    print(f"  Tageskosten: {t['usd']} USD · Ampel {t['ampel']} · {t['grund']}")
    if t["ohne_zahl"]:
        print(f"    {t['ohne_zahl']} Läufe ohne cost_usd (Abo-Läufe berichten keins) — "
              f"ihr Preis steht in der Wochenquote, nicht hier")
    q = l["claude_quota"]
    alter = ("unbekannt alt" if q["fable_7d_alter_s"] is None
             else f"gelesen vor {q['fable_7d_alter_s']} s")
    print(f"  Fable-Woche: {q['fable_7d_prozent']} % ({alter}"
          f"{', als stale gemeldet' if q['fable_7d_stale'] else ''}) · "
          f"Claude 5 h: {q['claude_5h_prozent']} %")
    for g in q["gruende"]:
        print(f"    ! {g}")
    print(f"  Startplan: {l['startplan']['grund']}")
    print(f"    Zeitversatz zwischen zwei Starts: "
          f"{l['startplan']['versatz_minuten']} Minuten")
    print(f"  Starke Bahn: Route {l['stark_route']}, {l['stark_starts_soll']} Start · "
          f"{l['startplan_stark']['grund']}")


# ── Schalten ─────────────────────────────────────────────────────────────────

def worker_schalten(konf: dict, lage: dict, an: bool) -> tuple:
    """Die Worker-Agenten hart an- oder ausschalten — NUR für den Not-Halt (`stopp`/`weiter`).

    Der eigentliche Halt ist der HALT-Marker: Er zieht in `lage` alle Startzahlen und beide
    Wecken-Flags auf 0, und daran hängen Wächter, Nachlauf und Dispatcher gleichermaßen.
    Dieser Schalter ist der zweite Riegel — er verhindert, dass ein Agent von Hand oder aus
    einem fremden Flow heraus gestartet wird, während der Halt steht.
    """
    agenten = {a["name"]: a for a in lage["agenten"]}
    aenderungen, fehlgeschlagen = [], []
    for w in konf.get("worker_agenten") or []:
        ag = agenten.get(w["name"])
        if not ag:
            fehlgeschlagen.append({"agent": w["name"],
                                   "fehler": "im Hub nicht gefunden — "
                                             "freilauf_einrichten.py laufen lassen"})
            continue
        if bool(ag["aktiv"]) == bool(an):
            continue
        # /agents/toggle KIPPT den Schalter — deshalb nur aufrufen, wenn Ist und Soll abweichen.
        status, _ = hub_post_form("/agents/toggle", {"id": ag["id"], "repo": lage["repo_id"]})
        if status not in (200, 303):
            fehlgeschlagen.append({"agent": w["name"], "id": ag["id"],
                                   "fehler": f"/agents/toggle antwortete HTTP {status}"})
            continue
        aenderungen.append({"agent": w["name"], "id": ag["id"], "nach": an})
    if aenderungen:
        journal_schreib({"ereignis": "halt_geschaltet", "an": an, "aenderungen": aenderungen})
    return aenderungen, fehlgeschlagen


# ── CLI ──────────────────────────────────────────────────────────────────────

def baue_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="dispatch.py",
        description="Die offenen Aufgaben zählen und daraus ableiten, wie viele "
                    "Worker-Läufe jetzt zusätzlich zu starten sind.",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--repo", default=str(REPO_DEFAULT),
                    help=f"Checkout mit {MOTOR}/konfig.json (Standard: {REPO_DEFAULT})")
    ap.add_argument("--konfig", default="",
                    help=f"eine andere Konfig-Datei lesen (Standard: <repo>/{MOTOR}/konfig.json)")
    sub = ap.add_subparsers(dest="befehl", required=True)

    p = sub.add_parser("lage", help="Was offen ist, wer läuft, wie viele Starts fällig sind")
    p.add_argument("--json", action="store_true")

    sub.add_parser("stopp", help="Not-Halt: Worker-Agenten aus, `lage` meldet 0 Starts")
    sub.add_parser("weiter", help="Not-Halt aufheben und die Worker-Agenten wieder einschalten")

    p = sub.add_parser("journal", help="Was der Schwarm bisher getan hat")
    p.add_argument("--letzte", type=int, default=20)
    p.add_argument("--json", action="store_true")
    return ap


def main(argv=None) -> int:
    args = baue_parser().parse_args(argv)
    repo = Path(args.repo).resolve()
    pfad = konfig_pfad(repo, getattr(args, "konfig", "") or "")
    if not pfad.is_file():
        return fehler(args.befehl, f"{pfad} gibt es nicht.",
                      naechster_schritt=f"--repo <pfad zum checkout> oder --konfig <datei> "
                                        f"setzen. Beim Einrichten: konfig.beispiel.json nach "
                                        f"{MOTOR}/konfig.json kopieren und ausfüllen.", code=2)
    konf = konfig_laden(repo, getattr(args, "konfig", "") or "")
    schlecht = konfig_pruefen(konf, pfad, args.befehl)
    if schlecht:
        return schlecht

    if args.befehl == "weiter":
        war = halt_marker().exists()
        halt_marker().unlink(missing_ok=True)
        journal_schreib({"ereignis": "halt_aufgehoben"})
        lage = lage_erheben(repo, konf)
        aend, fehl = worker_schalten(konf, lage, an=True)
        print("Halt aufgehoben." if war else "Kein Halt gesetzt.")
        print(f"  {len(aend)} Worker-Agenten wieder eingeschaltet: "
              f"{', '.join(a['agent'] for a in aend) or '(waren schon an)'}")
        for f_ in fehl:
            print(f"  ! {f_['agent']}: {f_['fehler']}")
        schluss("weiter", not fehl, war_gesetzt=war, eingeschaltet=len(aend))
        return 0 if not fehl else 1

    if args.befehl == "journal":
        pfad = state_dir() / "journal.jsonl"
        zeilen = ([z for z in pfad.read_text(encoding="utf-8").splitlines() if z.strip()]
                  if pfad.is_file() else [])[-max(1, args.letzte):]
        if args.json:
            print(json.dumps([json.loads(z) for z in zeilen], ensure_ascii=False, indent=1))
        else:
            for z in zeilen:
                e = json.loads(z)
                aend = ", ".join(f"{a['agent']}→{'AN' if a['nach'] else 'aus'}"
                                 for a in e.get("aenderungen") or [])
                print(f"{e.get('ts')}  {e.get('ereignis'):<16} {aend or e.get('agent') or ''}")
            if not zeilen:
                print(f"Journal leer ({pfad}).")
        schluss("journal", True, zeilen=len(zeilen))
        return 0

    if args.befehl == "stopp":
        halt_marker().write_text(
            datetime.now(timezone.utc).isoformat(timespec="seconds") + "\n", encoding="utf-8")
        journal_schreib({"ereignis": "halt_gesetzt"})
        lage = lage_erheben(repo, konf)
        aend, fehl = worker_schalten(konf, lage, an=False)
        print(f"Halt gesetzt: {halt_marker()}")
        print(f"  {len(aend)} Worker-Agenten abgeschaltet: "
              f"{', '.join(a['agent'] for a in aend) or '(waren schon aus)'}")
        print("Laufende Läufe werden NICHT beendet. Einzeln beenden:")
        for r in lage["laufende"]:
            print(f"  fl-kill {r['short_id']}      # {r['agent']}")
        if not lage["laufende"]:
            print("  (nichts in der Luft)")
        print("Aufheben: python schwarm/dispatch.py weiter")
        schluss("stopp", not fehl, abgeschaltet=len(aend), laufend=len(lage["laufende"]))
        return 0 if not fehl else 1

    if args.befehl == "lage":
        lage = lage_erheben(repo, konf)
        if args.json:
            print(json.dumps(lage, ensure_ascii=False, indent=1))
        else:
            lage_drucken(lage)
        schluss("lage", True, arbeit_da=lage["arbeit_da"], po_da=lage["po_da"],
                kandidaten_gesamt=lage["kandidaten_gesamt"],
                kandidaten_trivial=lage["kandidaten_trivial"],
                kandidaten_schwer=lage["kandidaten_schwer"],
                po_offen=lage["po_offen"],
                worker_starts_soll=lage["worker_starts_soll"],
                deepseek_starts_soll=lage["deepseek_starts_soll"],
                stark_route=lage["stark_route"],
                stark_starts_soll=lage["stark_starts_soll"],
                fable_7d_prozent=("unbekannt" if lage["fable_7d_prozent"] is None
                                  else lage["fable_7d_prozent"]),
                fable_7d_alter_s=("unbekannt" if lage["fable_7d_alter_s"] is None
                                  else lage["fable_7d_alter_s"]),
                kosten_heute_usd=lage["kosten_heute_usd"],
                tages_ampel=lage["tages_ampel"],
                budget_ampel=lage["budget_ampel"], laufend=len(lage["laufende"]),
                laufend_stark=lage["laufend_stark"],
                laufend_dispatcher=lage["laufend_dispatcher"], halt=lage["halt"])
        return 0

    return fehler(args.befehl or "unbekannt", f"Unbekannter Befehl {args.befehl!r}.",
                  naechster_schritt="python schwarm/dispatch.py --help", code=2)


if __name__ == "__main__":
    enable_utf8_io()
    sys.exit(main())
