#!/usr/bin/env python3
"""run-alive — is the coding agent behind a run still there?

`status` is what the run REPORTED. It is not what the machine is doing, and the
two disagree constantly: three of the four coding agents stay alive in their TUI
after the work is done, so a run on `done` usually still has a live agent.

Run it with no arguments for the overview.

Standard library only. Finds the hub the same way `fl-options.py` does — if
nothing answers, `fl-options.py where` explains what was tried.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

TIMEOUT = 20
HERE = os.path.dirname(os.path.abspath(__file__))
CARD = os.path.join(os.path.dirname(HERE), ".freilauf-skill.json")

# --- finding the hub --------------------------------------------------------
# Deliberately a copy of the block in `fl-options.py` rather than an import: a
# skill directory is installed standalone, so a script that imported a sibling
# would break the moment somebody copied one skill and not the other. Two short
# copies that a unit test can compare beat one import that can go missing.


def _card():
    try:
        with open(CARD, encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("installation") or {}
    except Exception:
        return {}


def _port_from_env_file():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    for name in ("freilauf", "cc-hub"):
        path = os.environ.get("FREILAUF_ENV_FILE") or os.path.join(base, name, "env")
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    m = re.match(r"\s*(?:export\s+)?(?:FREILAUF|CCHUB)_LOCAL_PORT\s*=\s*[\"']?(\d+)", line)
                    if m:
                        return m.group(1)
        except OSError:
            continue
    return None


def _get(url, path):
    req = urllib.request.Request(url + path, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def hub():
    urls = []
    for v in (os.environ.get("FL_HUB_URL"), os.environ.get("CC_HUB_URL"),
              os.environ.get("FREILAUF_HUB_URL"), _card().get("url")):
        if v:
            urls.append(v.rstrip("/"))
    port = _port_from_env_file()
    if port:
        urls.append("http://127.0.0.1:%s" % port)
    urls.append("http://127.0.0.1:8791")
    for u in dict.fromkeys(urls):
        try:
            if "ok" in (_get(u, "/api/usage") or {}):
                return u
        except Exception:
            continue
    print("No Freilauf hub answered. `fl-options.py where` lists what was tried.")
    sys.exit(3)


# --- the report -------------------------------------------------------------
VERDICTS = {
    "working": "pane alive, and the record says it is running",
    "idle_in_tui": "pane alive, run over — the NORMAL state of a finished claude/opencode/cursor run",
    "process_gone": "the session exists, every pane in it is dead",
    "no_session": "no session name was ever recorded",
    "unknown": "tmux could not be asked, OR the session is gone — never read this as 'the agent is gone'",
}


def rows_for(base, ids):
    out = []
    for rid in ids:
        try:
            d = _get(base, "/api/runs/%s" % rid)
        except urllib.error.HTTPError:
            out.append((rid[:8], "?", "unavailable", "-", "-", "the hub would not answer for this id"))
            continue
        r, l = d["run"], d["liveness"]
        out.append((r.get("short_id") or r["id"][:8], r.get("status") or "-", l.get("verdict") or "-",
                    l.get("tmux_session") or "-", l.get("last_activity_at") or "-",
                    (r.get("title") or "")[:50]))
    return out


def table(headers, rows):
    widths = [len(h) for h in headers]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(str(c)))
    line = lambda c: "| " + " | ".join(str(x).ljust(widths[i]) for i, x in enumerate(c)) + " |"
    return "\n".join([line(headers), "|" + "|".join("-" * (w + 2) for w in widths) + "|"]
                     + [line(r) for r in rows]) + "\n"


def usage():
    print(__doc__.strip())
    print("""
    run-alive.py <run-uuid>        one run
    run-alive.py --repo <id>       every unarchived run of a repo
    run-alive.py --status running  every run in that status

The point is the gap between the `status` and `verdict` columns:
""")
    for k, v in VERDICTS.items():
        print("  %-13s %s" % (k, v))
    print("\nNext:  fl-options.py repos   (to find a repo id)")


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        usage()
        return
    base = hub()
    if argv[0] == "--repo" and len(argv) > 1:
        ids = [r["id"] for r in _get(base, "/api/runs?limit=200&repo=%s" % argv[1])["runs"]]
        what = "repo %s" % argv[1]
    elif argv[0] == "--status" and len(argv) > 1:
        ids = [r["id"] for r in _get(base, "/api/runs?limit=200&status=%s" % argv[1])["runs"]]
        what = "status %s" % argv[1]
    elif argv[0].startswith("-"):
        print("No option `%s`." % argv[0])
        usage()
        sys.exit(2)
    else:
        ids, what = [argv[0]], "one run"
    if not ids:
        print("No run matches %s." % what)
        print("\nNext:  fl-options.py repos")
        sys.exit(1)
    # Newest first is what the list already is, and a cap is what keeps this a
    # view instead of a dump: a repo with a year of history would otherwise put
    # hundreds of rows into the reader's context for one question.
    gesamt = len(ids)
    if "--all" not in argv:
        ids = ids[:15]
    rows = rows_for(base, ids)
    print("# Liveness — %s (%d of %d, newest first)\n" % (what, len(rows), gesamt)
          if gesamt > len(rows) else "# Liveness — %s (%d)\n" % (what, len(rows)))
    print(table(["short", "status", "verdict", "session", "last activity", "title"], rows))
    seen = {r[2] for r in rows}
    for v in ("idle_in_tui", "unknown", "working"):
        if v in seen:
            print("`%s`: %s" % (v, VERDICTS[v]))
    if "idle_in_tui" in seen:
        print("\nSuch a run can be given more work: fl-api -X POST /api/runs/<id>/send text='...'")
    if "unknown" in seen:
        print("\nConfirm an `unknown` before concluding anything:  tmux has-session -t '=<session>'")
    if gesamt > len(rows):
        print("\n%d older run(s) not shown. All of them:  run-alive.py %s --all"
              % (gesamt - len(rows), " ".join(argv[:2])))
    if len(rows) == 1 and rows[0][1] not in ("-", "?"):
        print("\nFull detail, incl. its errors and files:  fl-api /api/runs/%s" % ids[0])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
