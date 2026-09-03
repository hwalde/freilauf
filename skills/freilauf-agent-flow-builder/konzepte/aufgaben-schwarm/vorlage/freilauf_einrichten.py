#!/usr/bin/env python3
"""freilauf_einrichten.py — die Schwarm-Agenten und ihre Flows im Hub anlegen.

WAS DAS ANLEGT
  Fünf gespeicherte Freilauf-Agenten im Repo aus `konfig.json` — sichtbar im Hub unter
  „Agenten", alle mit `schedule_kind=manuell`, denn KEINER hat einen eigenen Cron mehr:

    Schwarm-Worker (GLM)                 gestartet vom Dispatcher
    Schwarm-Worker (DeepSeek, trivial)   gestartet vom Dispatcher
    Schwarm-Worker (stark, Fable)        gestartet vom Dispatcher, höchstens einer der beiden
    Schwarm-Worker (stark, Gemini)       gestartet vom Dispatcher, höchstens einer der beiden
    Schwarm-Dispatcher                   geweckt vom Wächter-Takt und vom Nachlauf

  Dazu der PO-Agent aus `konfig.po_agent` — nur AKTUALISIERT, nie neu angelegt.

  Dazu drei Flows:
    Schwarm-Nachlauf                    run_finished, AKTIV, an alle Worker ATTACHED
    Schwarm-Takt (ohne LLM, count_runs) cron 0 */2, AKTIV — der Wächter und der EINZIGE Takt
    Schwarm-PO-Takt                     cron 0 4,   AKTIV — weckt den PO-Agenten, wenn nötig

  Skaliert wird NICHT über Ein-/Ausschalten, sondern indem derselbe Worker-Agent mehrfach
  gestartet wird; der Zeitversatz dazwischen kommt aus `versatz_minuten`.

  LEERLAUF KOSTET NICHTS. Der einzige Takt ist der Wächter-Flow: Er zählt per Shell die Lage
  und startet den Dispatcher NUR, wenn Arbeit da ist. Ist das Register leer, kostet ein Tag
  zwölf Shell-Aufrufe und zwölf Notizen — null Agenten-Läufe, null Token.

IDEMPOTENZ, UND WAS DAS SKRIPT NICHT ÜBERSCHREIBT
  Ein zweiter Lauf schreibt Prompt, Modell, Zeitplan und Dauer neu, lässt aber den
  Schaltzustand vorhandener AGENTEN in Ruhe — den besitzt im Betrieb der Not-Halt
  (`dispatch.py stopp`). Der Schaltzustand der beiden CRON-FLOWS wird dagegen immer auf
  „aktiv" gesetzt: Sie sind der einzige Antrieb, und ein vergessenes „aus" hielte den Schwarm
  für immer an, ohne dass jemand sähe warum. Zum Anhalten dient der HALT-Marker, der auf
  `lage` wirkt und damit auf jeden Weg. Mit `--worker-zuruecksetzen` holt man ihn bewusst auf die
  Konfig-Vorgabe zurück. Fremde Agenten desselben Repos werden nie angefasst;
  `--aufraeumen` löscht ausschließlich die in `konfig._abgeloeste_agenten` genannten
  Vorgänger-Agenten dieses Schwarms.

WARUM VOLL-REPLACE
  `POST /agents/edit?id=<n>` ist kein Patch: Jede nicht mitgeschickte Spalte wird
  zurückgesetzt (fehlendes `active` schaltet den Agenten AUS, fehlendes `flows` löst das
  Flow-Attachment). Dieses Skript sendet deshalb immer den vollständigen Satz Felder.

AUFRUF
  python schwarm/freilauf_einrichten.py --zeige      Ist-Zustand im Hub, ändert nichts
  python schwarm/freilauf_einrichten.py --dry-run    alles rechnen, nichts schreiben
  python schwarm/freilauf_einrichten.py             anlegen bzw. aktualisieren
  python schwarm/freilauf_einrichten.py --aufraeumen abgelöste Schwarm-Agenten löschen
  python schwarm/freilauf_einrichten.py --dispatcher-inaktiv --worker-zuruecksetzen

SCHLUSSZEILE
  SCHWARM_EINRICHTEN result=OK|FAIL agenten=<n> dispatcher=<id> nachlauf=<id> takt=<id>
                     po_takt=<id>

EXIT-CODES
  0 OK · 1 Hub lehnte etwas ab · 2 Eingabefehler · 3 Hub nicht erreichbar / Dateien fehlen
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
from pathlib import Path

SELF = Path(__file__).resolve()
MOTOR = SELF.parent.name          # der Ordnername dieses Motors im Repo, Vorgabe „schwarm"
REPO_DEFAULT = SELF.parents[1]

_ps_pfad = os.environ.get("SCHWARM_PLATFORM_SUPPORT")
if _ps_pfad:
    sys.path.insert(0, str(Path(_ps_pfad).expanduser().resolve()))
try:
    from platform_support import enable_utf8_io
except ImportError:  # pragma: no cover — der Regelfall in einem Repo ohne dieses Modul
    def enable_utf8_io() -> None:
        return

sys.path.insert(0, str(SELF.parent))
from dispatch import (hub_get, hub_post_form, hub_post_json, hub_url,  # noqa: E402
                      konfig_laden, konfig_pfad, konfig_pruefen, projekt_slug, repo_id, schluss, state_dir)


def fehler_liste(html: str) -> list:
    """Die Ablehnungsgründe aus der 400-Seite von /agents/edit herausziehen."""
    block = re.search(r'<ul class="err">(.*?)</ul>', html, re.S)
    if not block:
        return [re.sub(r"<[^>]*>", " ", html).strip()[:300]]
    return [re.sub(r"<[^>]*>", "", s).strip()
            for s in re.findall(r"<li>(.*?)</li>", block.group(1), re.S)]


# ── Prompts rendern ──────────────────────────────────────────────────────────

def hol_ablauf(konf: dict, w: dict) -> str:
    """Der Abschnitt „so kommst du an Arbeit" — je Bahn ein anderer.

    Gewöhnliche Bahn: die Schweregrade der Reihe nach, dann auffüllen bis zur Paketgröße.
    Starke Bahn: erst das Blockierte, dann das schon zweimal Gescheiterte — und genau eine
    Aufgabe, weil das ganze Zeitbudget diesem einen Fall gehört.
    """
    r = konf.get("repo") or {}
    holen = r.get("aufgabe_holen", "")
    if not w.get("stark"):
        schweren = list(w.get("schweregrade") or ["trivial"])
        kette = (", dann ".join(f"`{s}`" for s in schweren) if len(schweren) > 1
                 else f"nur `{schweren[0]}` — andere Schweregrade sind für dich tabu")
        groessen = konf.get("paketgroesse") or {}
        regel = "\n".join(f"- Erster Treffer `{s}` ⇒ nimm bis zu {groessen.get(s, 1)} Aufgaben "
                          f"dieser Schwere." for s in schweren)
        return (f"```\n{holen}\n```\n\n"
                f"Probiere die Schweregrade in dieser Reihenfolge: {kette}. Der erste, der "
                f"etwas liefert, bestimmt dein Paket:\n\n{regel}\n\n"
                f"Fülle danach mit demselben Kommando und demselben Schweregrad auf, bis die "
                f"Paketgröße erreicht ist oder nichts mehr kommt.")
    min_versuche = int(konf.get("stark_min_versuche", 2))
    zusatz = (r.get("aufgabe_holen_zusatz_gescheitert") or "").replace("<n>", str(min_versuche))
    # Zusatz für BEIDE starken Hol-Kommandos: Ein vom PO freigegebener Befund behält seinen
    # Versuchszähler (3); ohne diesen Zusatz fände ihn niemand mehr — er bliebe liegen.
    stark = (r.get("aufgabe_holen_zusatz_stark") or "").strip()
    erst = (holen.replace("<schwere>", "blockiert") + (" " + stark if stark else "")).strip()
    dann = (holen.replace("<schwere>", "normal") + (" " + zusatz if zusatz else "")
            + (" " + stark if stark else "")).strip()
    return (
        "Du arbeitest die Fälle, an denen die gewöhnlichen Worker nicht weiterkommen: was als\n"
        "blockiert eingetragen ist, und was schon zweimal vergeblich versucht wurde. Hol dir\n"
        "genau eine Aufgabe, in dieser Reihenfolge:\n\n"
        f"1. Zuerst das Blockierte:\n\n```\n{erst}\n```\n\n"
        f"2. Erst wenn das „nichts frei\" meldet, das schon Gescheiterte:\n\n```\n{dann}\n```\n\n"
        "Der erste Treffer ist dein ganzes Paket: eine Aufgabe, nicht mehr. Fülle nicht auf.\n"
        "Dein Zeitbudget gehört diesem einen Fall — er hat es nötig, sonst läge er nicht hier.\n"
        "Der Langtext trägt die Notizen der gescheiterten Versuche; lies sie, bevor du\n"
        "denselben Weg noch einmal gehst.")


def worker_prompt(repo: Path, konf: dict, w: dict) -> str:
    r = konf.get("repo") or {}
    vorlage = (repo / MOTOR / "prompts" / "worker.md").read_text(encoding="utf-8")
    zusatz = "\n".join(f"   - {z}" for z in (r.get("zusatz_gates") or []))
    harness = ((konf.get("routen") or {}).get(w["route"]) or {}).get("harness")
    doku = (r.get("doku_pflicht_subagent") if harness == "claude" else None) \
        or r.get("doku_pflicht", "(für dieses Repo keine gesonderte Doku-Pflicht)")
    ersetzungen = {
        "{{WORKER_NAME}}": w["name"],
        "{{ROUTE}}": w["route"],
        "{{WORKER_MINUTEN}}": str(worker_minuten(konf, w)),
        "{{HOL_ABLAUF}}": hol_ablauf(konf, w),
        "{{REGISTER_BESCHREIBUNG}}": r.get("register_beschreibung", "dem Aufgaben-Register"),
        "{{AUFGABEN_WORT}}": r.get("aufgaben_wort", "Eintrag"),
        "{{AUFGABEN_WORT_MEHRZAHL}}": r.get("aufgaben_wort_mehrzahl", "Einträge"),
        "{{REGELN_DATEI}}": r.get("regeln_datei", "CLAUDE.md"),
        "{{AUFGABEN_HINWEIS}}": r.get("aufgaben_hinweis", ""),
        "{{AUFGABE_ANSEHEN}}": r.get("aufgabe_ansehen", ""),
        "{{AUFGABE_ABSCHLIESSEN}}": r.get("aufgabe_abschliessen", ""),
        "{{AUFGABE_ZURUECKGEBEN}}": r.get("aufgabe_zurueckgeben", ""),
        "{{AUFGABE_NOTIZ}}": r.get("aufgabe_notiz", ""),
        "{{AUFGABE_NEU}}": r.get("aufgabe_neu", ""),
        "{{GATE}}": r.get("gate", ""),
        "{{ZUSATZ_GATES}}": zusatz,
        "{{DOKU_PFLICHT}}": doku,
        "{{REPO_REGELN_SNIPPET}}": r.get("regeln_snippet", ""),
    }
    for marke, wert in ersetzungen.items():
        vorlage = vorlage.replace(marke, str(wert))
    offen = re.findall(r"\{\{[A-Z_]+\}\}", vorlage)
    if offen:
        raise SystemExit(f"FEHLER: Platzhalter ohne Wert in worker.md: {', '.join(sorted(set(offen)))}")
    return vorlage


def dispatcher_prompt(repo: Path, konf: dict) -> str:
    """Der Dispatcher-Prompt — auch er wird gerendert, nicht roh durchgereicht.

    Zwei Dinge darin sind installationsabhängig und dürfen nicht als Literal dastehen: der
    Ordnername des Motors (er muss nicht `schwarm` heißen) und der Pfad der `hub_ids.json`
    (der liegt seit dem projektbezogenen Zustandsordner unter dem Projekt-Slug).
    """
    vorlage = (repo / MOTOR / "prompts" / "dispatcher.md").read_text(encoding="utf-8")
    ersetzungen = {
        "{{MOTOR_ORDNER}}": MOTOR,
        "{{HUB_IDS_PFAD}}": str(state_dir(konf) / "hub_ids.json"),
    }
    for marke, wert in ersetzungen.items():
        vorlage = vorlage.replace(marke, wert)
    offen = re.findall(r"\{\{[A-Z_]+\}\}", vorlage)
    if offen:
        raise SystemExit("FEHLER: Platzhalter ohne Wert in dispatcher.md: "
                         + ", ".join(sorted(set(offen))))
    return vorlage


def po_prompt(repo: Path, konf: dict, po: dict) -> str:
    """Der Prompt des PO-Agenten — dieselbe Platzhalter-Mechanik wie beim Worker.

    Die fünf PO-Kommandos stehen im Block `repo` der Konfig, damit dieser Prompt in jedem
    Repository gilt und nicht die Kommandos eines bestimmten Werkzeugs mitschleppt.
    """
    r = konf.get("repo") or {}
    vorlage = (repo / MOTOR / "prompts"
               / po.get("prompt_datei", "po-praesentation.md")).read_text(encoding="utf-8")
    ersetzungen = {
        "{{PO_LISTE_JSON}}": r.get("po_liste_json", ""),
        "{{PO_ANSEHEN}}": r.get("po_ansehen", ""),
        "{{PO_ENTSCHEID_NOTIEREN}}": r.get("po_entscheid_notieren", ""),
        "{{PO_FREIGEBEN}}": r.get("po_freigeben", ""),
        "{{PO_AN_MENSCHEN}}": r.get("po_an_menschen", ""),
        "{{GATE}}": r.get("gate", ""),
        "{{AUFGABEN_WORT}}": r.get("aufgaben_wort", "Eintrag"),
        "{{AUFGABEN_WORT_MEHRZAHL}}": r.get("aufgaben_wort_mehrzahl", "Einträge"),
    }
    for marke, wert in ersetzungen.items():
        vorlage = vorlage.replace(marke, str(wert))
    offen = re.findall(r"\{\{[A-Z_]+\}\}", vorlage)
    if offen:
        raise SystemExit(f"FEHLER: Platzhalter ohne Wert in {po.get('prompt_datei')}: "
                         f"{', '.join(sorted(set(offen)))}")
    if not r.get("po_liste_json"):
        print("  ! konfig.repo.po_liste_json ist leer — der PO-Agent bekäme einen Prompt "
              "ohne Sammel-Kommando. Entweder die fünf po_*-Kommandos füllen oder "
              "po_agent.id auf null setzen.", file=sys.stderr)
    return vorlage


def worker_minuten(konf: dict, w: dict) -> int:
    """Das Zeitbudget dieses Workers: eigener Wert, sonst der Bahn-Wert, sonst der Standard."""
    if w.get("minuten"):
        return int(w["minuten"])
    if w.get("stark"):
        return int(konf.get("stark_minuten", 60))
    return int(konf.get("worker_minuten", 45))


# ── Agenten ──────────────────────────────────────────────────────────────────

def route_felder(konf: dict, route: str) -> dict:
    r = (konf.get("routen") or {}).get(route)
    if not r:
        raise SystemExit(f"FEHLER: Route {route!r} steht nicht in konfig.routen.")
    modell = r.get("model")
    # Eine Route darf ihre Modell-ID aus einem eigenen Regler oben in der Konfig beziehen —
    # so lässt sich das Ausweich-Modell der starken Bahn an EINER Stelle wechseln.
    regler = r.get("modell_regler")
    if regler and konf.get(regler):
        modell = konf[regler]
    felder = {"harness": r.get("harness"), "provider": r.get("provider"),
              "model": modell, "effort": r.get("effort")}
    for k in ("or_mode", "or_provider", "or_quant"):
        if r.get(k):
            felder[k] = r[k]
    return felder


def agent_body(konf: dict, *, name: str, prompt: str, route: str, cron: str, minuten: int,
               aktiv: bool, flow_id=None) -> list:
    felder = [("name", name), ("repo_id", repo_id(konf))]
    if aktiv:
        felder.append(("active", "1"))   # fehlendes Feld heißt AUS — wie die Checkbox
    felder += list(route_felder(konf, route).items())
    felder += [("prompt", prompt),
               ("branch_mode", konf.get("branch_mode", "keiner")),
               ("expected_minutes", minuten)]
    # Ohne Cron-Ausdruck: schedule_kind `manuell`. Der Agent fährt dann NUR, wenn ihn jemand
    # startet — der Dispatcher oder der Takt-Flow. Das ist die starke Bahn.
    felder += ([("schedule_kind", "cron"), ("schedule", cron)] if cron
               else [("schedule_kind", "manuell")])
    if flow_id:
        felder += [("flows", flow_id), (f"flow_when_{flow_id}", "always")]
    return felder


def agenten_im_hub(konf: dict) -> dict:
    return {a["name"]: a for a in hub_get("/api/agents", repo=repo_id(konf)).get("agents") or []}


def po_agent_speichern(repo: Path, konf: dict, vorhanden: dict):
    """Den bestehenden PO-Agenten aktualisieren — Cron, Dauer und Prompt, sonst nichts.

    Er wird über seine ID aus der Konfig adressiert und NIE neu angelegt: Er ist älter als
    der Schwarm, und eine Neuanlage würde einen zweiten Agenten gleichen Namens erzeugen und
    seine Lauf-Historie vom neuen Eintrag trennen. Fehlt die ID im Hub, ist das eine Meldung,
    kein Abbruch — der Schwarm selbst funktioniert ohne ihn.
    """
    po = konf.get("po_agent") or {}
    if not po.get("id"):
        return None
    ids = {a["id"]: a for a in vorhanden.values()}
    alt = ids.get(int(po["id"]))
    if not alt:
        print(f"  ! PO-Agent #{po['id']} steht nicht in Repo {repo_id(konf)} — "
              f"nicht aktualisiert. Er wird bewusst nicht neu angelegt; ID in "
              f"konfig.po_agent.id prüfen.", file=sys.stderr)
        return None
    body = agent_body(konf, name=po.get("name", alt["name"]),
                      prompt=po_prompt(repo, konf, po),
                      route=po.get("route", "glm"), cron=po.get("cron", ""),
                      minuten=int(po.get("minuten", 90)), aktiv=True)
    status, koerper = hub_post_form(f"/agents/edit?id={alt['id']}", body)
    if status != 303:
        print(f"FEHLER: Hub lehnte den PO-Agenten #{alt['id']} ab:", file=sys.stderr)
        for p in fehler_liste(koerper):
            print(f"  - {p}", file=sys.stderr)
        return None
    print(f"  #{alt['id']:<4} AN  {po.get('name', alt['name']):<36} "
          f"cron={po.get('cron')} (PO-Präsentation)")
    return alt["id"]


def agent_speichern(konf: dict, vorhanden: dict, name: str, body: list) -> tuple:
    alt = vorhanden.get(name)
    pfad = f"/agents/edit?id={alt['id']}" if alt else "/agents/edit"
    status, koerper = hub_post_form(pfad, body)
    if status != 303:
        return None, fehler_liste(koerper)
    return name, None


# ── Der eigene Checkout der Flows ────────────────────────────────────────────

def _git(*args, cwd=None):
    """Ein git-Aufruf. Rückgabe (ok, ausgabe) — nie eine Ausnahme, der Aufrufer entscheidet."""
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode == 0, (p.stdout + p.stderr).strip()


def flow_checkout_pfad(konf: dict, repo_pfad: str) -> Path:
    roh = (konf.get("flow_checkout") or "").strip()
    if roh:
        return Path(roh).expanduser()
    # Der Projekt-Slug steckt bereits im Zustandsordner — hier nicht noch einmal anhängen.
    return state_dir(konf) / "checkout"


def flow_checkout_sicherstellen(konf: dict, repo_pfad: str, basis: str) -> tuple:
    """Den eigenen, detached Checkout der Flows anlegen bzw. auf origin/<basis> nachziehen.

    WARUM ÜBERHAUPT: Die Cron-Flows brauchen einen Ordner, in dem `schwarm/dispatch.py`
    zuverlässig in der Fassung liegt, die auf dem Basis-Branch steht. Der Repo-Pfad aus dem
    Hub ist der Arbeits-Checkout des Menschen — Freilauf mergt dorthin nicht zurück, dort
    liegen lokale Änderungen, und dort kann jederzeit ein alter Commit ausgecheckt sein.
    Genau das ist am 2026-09-03 passiert und hat den Schwarm angehalten.

    Ein `git worktree` des Arbeits-Checkouts wäre der naheliegende, aber falsche Griff: Er
    teilt sich dessen `.git` und damit Stash, Index und Worktree-Liste. Deshalb ein eigener
    Klon mit eigenem `.git`.

    Rückgabe (pfad, ok, meldung). Bei ok=False bleibt der Pfad trotzdem gesetzt: Der Flow
    scheitert dann laut an seinem `lage.ok`-Riegel, statt still nichts zu tun.
    """
    ziel = flow_checkout_pfad(konf, repo_pfad)
    ok, url = _git("remote", "get-url", "origin", cwd=repo_pfad)
    if not ok or not url:
        return ziel, False, f"origin-URL von {repo_pfad} nicht lesbar: {url}"
    if not (ziel / ".git").exists():
        ziel.parent.mkdir(parents=True, exist_ok=True)
        ok, aus = _git("clone", "--no-checkout", url, str(ziel))
        if not ok:
            return ziel, False, f"git clone {url} → {ziel} scheiterte: {aus[:300]}"
    ok, aus = _git("fetch", "-q", "origin", cwd=str(ziel))
    if not ok:
        return ziel, False, f"git fetch in {ziel} scheiterte (kein Netz?): {aus[:300]}"
    ok, aus = _git("checkout", "-q", "--detach", f"origin/{basis}", cwd=str(ziel))
    if not ok:
        return ziel, False, f"git checkout --detach origin/{basis} scheiterte: {aus[:300]}"
    ok, sha = _git("rev-parse", "--short", "HEAD", cwd=str(ziel))
    return ziel, True, f"detached auf origin/{basis} ({sha})"


# ── Flows ────────────────────────────────────────────────────────────────────

def flow_laden(repo: Path, datei: str, ersetzungen: dict) -> dict:
    roh = (repo / MOTOR / "flows" / datei).read_text(encoding="utf-8")
    for marke, wert in ersetzungen.items():
        roh = roh.replace(marke, str(wert))
    daten = json.loads(roh)
    daten.pop("_hinweis", None)
    return daten


def flow_finden(name: str):
    for f in hub_get("/api/flows").get("flows") or []:
        if f.get("name") == name:
            return f
    return None


# ── Ist-Zustand ──────────────────────────────────────────────────────────────

def zeige(konf: dict) -> int:
    print(f"Hub: {hub_url()}  ·  Repo {repo_id(konf)}")
    vorhanden = agenten_im_hub(konf)
    namen = [w["name"] for w in konf.get("worker_agenten") or []]
    namen.append(konf.get("dispatcher_name", "Schwarm-Dispatcher"))
    for n in namen:
        a = vorhanden.get(n)
        if a:
            print(f"  Agent #{a['id']:<4} {'AN ' if a['active'] else 'aus'} {n:<36} "
                  f"cron={a.get('schedule') or '-':<14} {a['harness']}/"
                  f"{a.get('provider') or '-'}/{a['model']}  flows={a.get('flows')}")
        else:
            print(f"  Agent  —    {n} existiert noch nicht")
    for n in ("Schwarm-Nachlauf", "Schwarm-Takt (ohne LLM, count_runs)", "Schwarm-PO-Takt"):
        f = flow_finden(n)
        print(f"  Flow  #{f['id']:<4} {'AN ' if f['active'] else 'aus'} {n:<36} "
              f"trigger={f['trigger']}" if f else f"  Flow   —    {n} existiert noch nicht")
    ids = state_dir(konf) / "hub_ids.json"
    print(f"  IDs   {ids}")
    if ids.is_file():
        print("        " + ids.read_text(encoding="utf-8").replace("\n", "\n        ").strip())
    schluss("einrichten", True, modus="zeige")
    return 0


# ── Hauptlauf ────────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="freilauf_einrichten.py",
        description="Die drei Schwarm-Agenten und ihre Flows im Freilauf-Hub anlegen "
                    "bzw. aktualisieren.",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--repo", default=str(REPO_DEFAULT),
                    help=f"Checkout mit {MOTOR}/konfig.json (Standard: {REPO_DEFAULT})")
    ap.add_argument("--konfig", default="",
                    help=f"eine andere Konfig-Datei lesen (Standard: <repo>/{MOTOR}/konfig.json)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dispatcher-aktiv", dest="disp", action="store_true", default=None)
    g.add_argument("--dispatcher-inaktiv", dest="disp", action="store_false",
                   help="den Dispatcher-Agenten ausgeschaltet lassen (dann trägt der "
                        "Cron-Flow 'Schwarm-Takt' — aber nie beide zugleich)")
    ap.add_argument("--worker-zuruecksetzen", action="store_true",
                    help="den Schaltzustand der Worker auf die Konfig-Vorgabe zurückholen "
                         "(sonst bleibt er, wie ihn `dispatch.py stopp` gestellt hat)")
    ap.add_argument("--aufraeumen", action="store_true",
                    help="die in konfig._abgeloeste_agenten genannten Vorgänger-Agenten dieses "
                         "Schwarms LÖSCHEN. Unumkehrbar — die vergangenen Läufe bleiben "
                         "erhalten, nur die Definition verschwindet")
    ap.add_argument("--zeige", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    repo = Path(args.repo).resolve()
    pfad = konfig_pfad(repo, args.konfig)
    if not pfad.is_file():
        print(f"FEHLER: {pfad} gibt es nicht.", file=sys.stderr)
        print(f"Nächster Schritt: konfig.beispiel.json nach {MOTOR}/konfig.json kopieren und "
              f"ausfüllen — oder --repo bzw. --konfig setzen.", file=sys.stderr)
        schluss("einrichten", False)
        return 2
    konf = konfig_laden(repo, args.konfig)
    schlecht = konfig_pruefen(konf, pfad, "einrichten")
    if schlecht:
        return schlecht

    try:
        if args.zeige:
            return zeige(konf)
        repos = {r["id"]: r for r in hub_get("/api/repos").get("repos") or []}
        vorhanden = agenten_im_hub(konf)
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"FEHLER: Hub {hub_url()} antwortet nicht ({e}).", file=sys.stderr)
        print("Nächster Schritt: fl-api --url  ·  Hub starten, dann erneut.", file=sys.stderr)
        schluss("einrichten", False)
        return 3
    if repo_id(konf) not in repos:
        print(f"FEHLER: Repo {repo_id(konf)} kennt der Hub nicht. Bekannt: "
              f"{', '.join(str(i) for i in sorted(repos))}", file=sys.stderr)
        print(f"Nächster Schritt: repo.repo_id in {pfad} korrigieren.", file=sys.stderr)
        schluss("einrichten", False)
        return 2
    repo_pfad = repos[repo_id(konf)]["path"]
    basis = repos[repo_id(konf)].get("base_branch") or "main"

    disp_name = konf.get("dispatcher_name", "Schwarm-Dispatcher")
    disp_alt = vorhanden.get(disp_name)
    disp_aktiv = (bool(disp_alt.get("active")) if (args.disp is None and disp_alt)
                  else True if args.disp is None else bool(args.disp))
    nachlauf_alt = flow_finden("Schwarm-Nachlauf")
    nachlauf_id = nachlauf_alt["id"] if nachlauf_alt else None

    # Schaltzustand der Worker: bei Neuanlage die Konfig-Vorgabe, sonst der Ist-Zustand.
    plan = []
    for w in konf.get("worker_agenten") or []:
        alt = vorhanden.get(w["name"])
        aktiv = (bool(w.get("start_aktiv"))
                 if (alt is None or args.worker_zuruecksetzen) else bool(alt.get("active")))
        plan.append((w, alt, aktiv))

    if args.dry_run:
        print("TROCKEN — es wurde nichts geschrieben.")
        print(f"  Repo-Pfad im Hub (Arbeits-Checkout des Menschen, NICHT der cwd der Flows): "
              f"{repo_pfad}")
        ko = flow_checkout_pfad(konf, repo_pfad)
        print(f"  cwd der Flows (eigener detached Checkout): {ko}"
              f"{'' if (ko / '.git').exists() else '  — existiert noch nicht, würde geklont'}")
        for w, alt, aktiv in plan:
            print(f"  Worker {'#' + str(alt['id']) if alt else 'neu':<6} "
                  f"{w['name']:<36} aktiv={int(aktiv)} "
                  f"cron={w.get('cron') or 'manuell'!r} route={w['route']} "
                  f"modell={route_felder(konf, w['route'])['model']} "
                  f"minuten={worker_minuten(konf, w)} "
                  f"prompt={len(worker_prompt(repo, konf, w))} Zeichen")
        print(f"  Dispatcher {'#' + str(disp_alt['id']) if disp_alt else 'neu':<6} "
              f"aktiv={int(disp_aktiv)} cron={konf.get('dispatcher_cron')!r} "
              f"prompt={len(dispatcher_prompt(repo, konf))} Zeichen")
        po = konf.get("po_agent") or {}
        if po.get("id"):
            da = any(a["id"] == int(po["id"]) for a in vorhanden.values())
            print(f"  PO-Agent   #{po['id']:<5} {'vorhanden' if da else 'fehlt im Hub'} "
                  f"cron={po.get('cron')!r} minuten={po.get('minuten')} "
                  f"prompt={len(po_prompt(repo, konf, po))} Zeichen")
        for datei in ("nachlauf.json", "takt-soll.json", "po-takt.json"):
            f = flow_laden(repo, datei, {"@REPO_PFAD@": repo_pfad, "@DISPATCHER_AGENT_ID@": 0,
                                         "@EXTRACT_QUELLE@": "x", "@EXTRACT_MODELL@": "x",
                                         "@WORKER_GLM_ID@": 0, "@WORKER_DS_ID@": 0,
                                         "@WORKER_FABLE_ID@": 0, "@WORKER_GEMINI_ID@": 0,
                                         "@PO_AGENT_ID@": 0,
                                         "@FLOW_CWD@": str(flow_checkout_pfad(konf, repo_pfad)),
                                         "@BASIS_BRANCH@": basis,
                                         "@MOTOR_ORDNER@": MOTOR,
                                         "@REPO_ID@": repo_id(konf),
                                         "@MAX_WORKER@": konf.get("max_worker", 3),
                                         "@BELEGUNGEN_KOMMANDO@": "x",
                                         "@VERSATZ@": konf.get("versatz_minuten", 3)})
            alt = flow_finden(f["name"])
            print(f"  Flow  {'#' + str(alt['id']) if alt else 'neu':<6} {f['name']:<36} "
                  f"aktiv={f['active']} trigger={f['trigger']}")
        for n in (konf.get("_abgeloeste_agenten") or []):
            if n in vorhanden and n not in {w["name"] for w in konf.get("worker_agenten") or []}:
                print(f"  Abgelöst: #{vorhanden[n]['id']} {n}"
                      f"{' — würde gelöscht' if args.aufraeumen else ' (--aufraeumen löscht ihn)'}")
        schluss("einrichten", True, dry=1)
        return 0

    # 1) Dispatcher (die Flow-Vorlage braucht seine ID)
    name, probleme = agent_speichern(konf, vorhanden, disp_name, agent_body(
        konf, name=disp_name, prompt=dispatcher_prompt(repo, konf),
        route=konf.get("dispatcher_route", "glm"), cron=konf.get("dispatcher_cron", "0 */2 * * *"),
        minuten=konf.get("dispatcher_minuten", 15), aktiv=disp_aktiv))
    if probleme:
        print(f"FEHLER: Hub lehnte {disp_name!r} ab:", file=sys.stderr)
        for p in probleme:
            print(f"  - {p}", file=sys.stderr)
        schluss("einrichten", False)
        return 1

    # 2) Worker
    for w, _alt, aktiv in plan:
        name, probleme = agent_speichern(konf, vorhanden, w["name"], agent_body(
            konf, name=w["name"], prompt=worker_prompt(repo, konf, w), route=w["route"],
            cron=w.get("cron", ""), minuten=worker_minuten(konf, w), aktiv=aktiv,
            flow_id=nachlauf_id))
        if probleme:
            print(f"FEHLER: Hub lehnte {w['name']!r} ab:", file=sys.stderr)
            for p in probleme:
                print(f"  - {p}", file=sys.stderr)
            schluss("einrichten", False)
            return 1

    # 2b) Der PO-Agent — vorhanden, wird nur aktualisiert. Nie neu angelegt: Seine ID steht in
    #     der Konfig, weil er älter ist als der Schwarm und seine Lauf-Historie behalten soll.
    po_id = po_agent_speichern(repo, konf, vorhanden)

    jetzt = agenten_im_hub(konf)
    disp_id = jetzt[disp_name]["id"]
    worker_ids = {w["schluessel"]: jetzt[w["name"]]["id"] for w in konf.get("worker_agenten") or []}

    # 3) Flows — der Nachlauf hängt an beiden Worker-Agenten (Attachment IST der Filter)
    extract = konf.get("extract_modell") or {}
    marken = {"@REPO_PFAD@": repo_pfad, "@DISPATCHER_AGENT_ID@": disp_id,
              "@REPO_ID@": repo_id(konf),
              "@EXTRACT_QUELLE@": extract.get("llmSource", ""),
              "@EXTRACT_MODELL@": extract.get("model", ""),
              "@VERSATZ@": konf.get("versatz_minuten", 3),
              "@MAX_WORKER@": konf.get("max_worker", 3),
              "@BELEGUNGEN_KOMMANDO@": (konf.get("repo") or {}).get(
                  "belegungen_zeigen", "(kein Belegungs-Kommando konfiguriert)"),
              "@WORKER_GLM_ID@": worker_ids.get("glm", 0),
              "@WORKER_DS_ID@": worker_ids.get("ds", 0),
              "@WORKER_FABLE_ID@": worker_ids.get("fable", 0),
              "@WORKER_GEMINI_ID@": worker_ids.get("gemini", 0)}
    marken["@PO_AGENT_ID@"] = po_id or 0
    ko_pfad, ko_ok, ko_meldung = flow_checkout_sicherstellen(konf, repo_pfad, basis)
    marken["@FLOW_CWD@"] = str(ko_pfad)
    marken["@BASIS_BRANCH@"] = basis
    marken["@MOTOR_ORDNER@"] = MOTOR
    print(f"  Flow-Checkout {ko_pfad}: {ko_meldung}")
    if not ko_ok:
        print(f"  ! Der Flow-Checkout ist NICHT nutzbar: {ko_meldung}", file=sys.stderr)
        print("    Die Cron-Flows scheitern dann laut an ihrem lage.ok-Riegel (notify), "
              "statt still nichts zu tun. Nächster Schritt: git-Zugang zu origin prüfen.",
              file=sys.stderr)
    flow_ids = {}
    for datei, schluessel in (("nachlauf.json", "nachlauf_flow_id"),
                              ("takt-soll.json", "takt_flow_id"),
                              ("po-takt.json", "po_takt_flow_id")):
        entwurf = flow_laden(repo, datei, marken)
        alt = flow_finden(entwurf["name"])
        if alt:
            entwurf["id"] = alt["id"]
            # Den Schaltzustand des Betreibers achten — aber NUR beim Nachlauf. Die beiden
            # Cron-Flows SIND seit dem Umbau der einzige Antrieb: Bliebe hier ein altes „aus"
            # stehen, liefe der Schwarm nie wieder an, und niemand sähe warum. Wer den Schwarm
            # anhalten will, nimmt `dispatch.py stopp` — der HALT-Marker wirkt auf `lage` und
            # damit auf jeden Weg, nicht nur auf einen Flow.
            if schluessel == "nachlauf_flow_id":
                entwurf["active"] = bool(alt["active"])
        if schluessel == "nachlauf_flow_id":
            entwurf["attachments"] = [{"agentId": jetzt[w["name"]]["id"], "when": "always"}
                                      for w in konf.get("worker_agenten") or []]
        antwort = hub_post_json("/api/flows/save", entwurf)
        if not antwort.get("ok"):
            print(f"FEHLER: Flow {entwurf['name']!r} abgelehnt:", file=sys.stderr)
            for p in antwort.get("problems") or [antwort]:
                print(f"  - {p}", file=sys.stderr)
            print(f"Nächster Schritt: {MOTOR}/flows/*.json gegen fl-api /api/flows/meta "
                  f"prüfen.", file=sys.stderr)
            schluss("einrichten", False, dispatcher=disp_id)
            return 1
        flow_ids[schluessel] = antwort["id"]
        for h in antwort.get("hints") or []:
            print(f"  Hinweis zu {entwurf['name']!r}: {h}")

    # Abgelöste Flows löschen — namentlich, wie bei den Agenten. „Schwarm-Takt (ohne LLM)"
    # war die Fassung ohne count_runs; sie startete Worker direkt an der Triage vorbei und
    # hätte als zweiter Cron neben dem Wächter doppelt gestartet.
    for name in (konf.get("_abgeloeste_flows") or []):
        alt = flow_finden(name)
        if not alt:
            continue
        antwort = hub_post_json(f"/api/flows/{alt['id']}/delete", {})
        if antwort.get("ok"):
            print(f"  Gelöscht: Flow #{alt['id']} {name} (abgelöst vom Wächter-Takt)")
        else:
            print(f"  ! Löschen von Flow {name!r} scheiterte: {antwort}", file=sys.stderr)

    ids_datei = state_dir(konf) / "hub_ids.json"
    ids_datei.write_text(json.dumps(
        {"repo_id": repo_id(konf), "dispatcher_agent_id": disp_id,
         "dispatcher_name": disp_name,
         "po_agent_id": po_id,
         "worker": [{"schluessel": w["schluessel"], "name": w["name"],
                     "id": worker_ids[w["schluessel"]], "route": w["route"],
                     "cron": w.get("cron") or "", "stark": bool(w.get("stark")),
                     "schweregrade": w.get("schweregrade")}
                    for w in konf.get("worker_agenten") or []],
         **flow_ids}, ensure_ascii=False, indent=1), encoding="utf-8")

    # 4) Vorgänger-Agenten dieses Schwarms — nur auf ausdrückliche Anweisung, nur die genannten
    geloescht = []
    aktuelle = {w["name"] for w in konf.get("worker_agenten") or []} | {disp_name}
    for n in (konf.get("_abgeloeste_agenten") or []):
        alt = vorhanden.get(n)
        if not alt or n in aktuelle:
            continue
        if not args.aufraeumen:
            print(f"  Abgelöst und noch da: #{alt['id']} {n} — löschen mit --aufraeumen")
            continue
        status, _ = hub_post_form("/agents/delete", {"id": alt["id"]})
        if status in (200, 303):
            geloescht.append(f"#{alt['id']} {n}")
        else:
            print(f"  ! Löschen von {n} scheiterte (HTTP {status})", file=sys.stderr)
    for g in geloescht:
        print(f"  Gelöscht: {g} (seine vergangenen Läufe bleiben in der Übersicht)")

    print(f"Agenten im Repo {repo_id(konf)}:")
    for w in konf.get("worker_agenten") or []:
        a = jetzt[w["name"]]
        print(f"  #{a['id']:<4} {'AN ' if a['active'] else 'aus'} {w['name']:<36} "
              f"cron={w.get('cron') or 'manuell (nur der Dispatcher startet ihn)'}")
    print(f"  #{disp_id:<4} {'AN ' if disp_aktiv else 'aus'} {disp_name:<36} "
          f"cron={konf.get('dispatcher_cron')}")
    print(f"Flows: Nachlauf #{flow_ids['nachlauf_flow_id']} (aktiv, an alle Worker attached) "
          f"· Wächter-Takt #{flow_ids['takt_flow_id']} (aktiv, cron 0 */2 — der einzige Antrieb) "
          f"· PO-Takt #{flow_ids['po_takt_flow_id']} (aktiv, cron 0 4)")
    print(f"IDs geschrieben nach {ids_datei}")
    schluss("einrichten", True, agenten=len(plan) + 1, dispatcher=disp_id,
            nachlauf=flow_ids["nachlauf_flow_id"], takt=flow_ids["takt_flow_id"],
            po_takt=flow_ids["po_takt_flow_id"])
    return 0


if __name__ == "__main__":
    enable_utf8_io()
    sys.exit(main())
