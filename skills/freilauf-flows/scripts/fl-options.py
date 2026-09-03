#!/usr/bin/env python3
"""fl-options — what can I choose, and is what I filled in valid?

Every dropdown in the Freilauf web UI is a list this tool can print: the
repositories, the agents, the coding agents and their providers, models and
effort levels, the operator's saved favorites, the flows you can attach. It also
CHECKS a run definition before you post it and tells you what is wrong and what
the valid values are.

Run it with no arguments for the overview.

Standard library only, no venv, no dependencies. It finds the hub by itself —
`fl-options.py where` explains how, which is also the first thing to run when
something does not answer.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

TIMEOUT = 15
HERE = os.path.dirname(os.path.abspath(__file__))
# The calling card the installation writes next to the skill it installs.
CARD = os.path.join(os.path.dirname(HERE), ".freilauf-skill.json")


# --------------------------------------------------------------- finding the hub
def _card():
    try:
        with open(CARD, encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("installation") or {}
    except Exception:
        return {}


def _port_from_env_file():
    """The operator's own `env` file, which is where a non-default port lives."""
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    for name in ("freilauf", "cc-hub"):
        path = os.environ.get("FREILAUF_ENV_FILE") or os.path.join(base, name, "env")
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    m = re.match(r"\s*(?:export\s+)?(?:FREILAUF|CCHUB)_LOCAL_PORT\s*=\s*[\"']?(\d+)", line)
                    if m:
                        return m.group(1), path
        except OSError:
            continue
    return None, None


def candidates():
    """Every place the hub could be, best first, each with why we think so."""
    out = []
    run_url = os.environ.get("FL_HUB_URL") or os.environ.get("CC_HUB_URL")
    if run_url:
        out.append((run_url.rstrip("/"), "FL_HUB_URL — set by the hub that started this run"))
    if os.environ.get("FREILAUF_HUB_URL"):
        out.append((os.environ["FREILAUF_HUB_URL"].rstrip("/"), "FREILAUF_HUB_URL — set by hand"))
    card = _card()
    if card.get("url"):
        out.append((card["url"].rstrip("/"), "the installation that installed this skill (%s)" % card.get("id", "?")))
    port, path = _port_from_env_file()
    if port:
        out.append(("http://127.0.0.1:%s" % port, "FREILAUF_LOCAL_PORT in %s" % path))
    out.append(("http://127.0.0.1:8791", "the code default"))
    seen, uniq = set(), []
    for url, why in out:
        if url not in seen:
            seen.add(url)
            uniq.append((url, why))
    return uniq


def _get(url, path):
    req = urllib.request.Request(url + path, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def find_hub():
    """The first candidate that answers. Returns (url, why) or (None, tried).

    Probed with `/api/usage`, which every Freilauf release has had — NOT with
    one of the routes these skills use. A hub older than the skill answers 404
    for those, and reporting "no hub found" when one is plainly running would
    send the reader looking for the wrong problem entirely. `api()` says
    "deploy the hub" when a route is missing; that is a different sentence.
    """
    tried = []
    for url, why in candidates():
        try:
            answer = _get(url, "/api/usage")
            if isinstance(answer, dict) and "ok" in answer:
                return url, why
            tried.append((url, why, "answered, but not like a Freilauf hub"))
        except Exception as e:
            tried.append((url, why, type(e).__name__))
    return None, tried


HUB = None


def api(path):
    global HUB
    if HUB is None:
        HUB, why = find_hub()
        if HUB is None:
            print("# No Freilauf hub answered\n")
            print("Tried, in order:\n")
            for url, reason, err in why:
                print("- `%s` — %s (%s)" % (url, reason, err))
            print("\nIf Freilauf runs on this machine, `freilauf status` says on which port.")
            print("Then either export it once:\n")
            print("    export FREILAUF_HUB_URL=http://127.0.0.1:<port>\n")
            print("...or, if the hub is up, re-save Settings -> Freilauf skills so it")
            print("writes its address next to this skill again.")
            sys.exit(3)
    try:
        return _get(HUB, path)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("The hub answered 404 for `%s`.\n" % path)
            print("That route arrived with the release that ships these skills, so this")
            print("hub is probably older than the skill. Deploy it (`freilauf deploy`),")
            print("or check with: fl-options.py where")
            sys.exit(3)
        print("The hub answered HTTP %s for `%s`." % (e.code, path))
        sys.exit(3)


# ------------------------------------------------------------------ formatting
def table(headers, rows):
    if not rows:
        return "_none_\n"
    widths = [len(h) for h in headers]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(str(c)))
    line = lambda cells: "| " + " | ".join(str(c).ljust(widths[i]) for i, c in enumerate(cells)) + " |"
    out = [line(headers), "|" + "|".join("-" * (w + 2) for w in widths) + "|"]
    out += [line(r) for r in rows]
    return "\n".join(out) + "\n"


def nxt(*lines):
    print("\nNext:")
    for l in lines:
        print("  " + l)


# ------------------------------------------------------------------- commands
def cmd_overview():
    api("/api/usage")                # finds the hub, or explains why it did not
    url = HUB
    why = next((w for u, w in candidates() if u == url), "")
    repos = api("/api/repos")["repos"]
    active = [r for r in repos if r.get("active", 1)]
    favs = api("/api/favorites")["favorites"]
    print("# Freilauf options\n")
    print("Hub: `%s` (%s)\n" % (url, why))
    print(table(
        ["command", "what it lists"],
        [["`repos`", "%d repositories (%d you can start runs in)" % (len(repos), len(active))],
         ["`agents`", "the stored agents, with their schedule"],
         ["`coding-agents`", "which coding agents are configured here"],
         ["`agent <id>`", "one coding agent: its providers, models, effort levels"],
         ["`favorites`", "%d saved setup(s) — the operator's own preference" % len(favs)],
         ["`flows`", "the flows you can attach to an agent or a run"],
         ["`check k=v ...`", "validate a run definition BEFORE you post it"],
         ["`new`", "a ready-to-edit command for a new run"],
         ["`where`", "how the hub was found, and what else was tried"]]))
    if favs:
        print("The operator has %d favorite(s). A favorite is their considered answer to"
              % len(favs))
        print("\"what do I normally run with\" — prefer it over any recommendation.")
    nxt("fl-options.py repos", "fl-options.py new --repo <id>")


def cmd_where():
    print("# Where the hub is\n")
    print("Looked for it in this order — the first that answers wins:\n")
    url, why = find_hub()
    for i, (cand, reason) in enumerate(candidates(), 1):
        mark = "**answers**" if cand == url else "no answer"
        print("%d. `%s` — %s _(%s)_" % (i, cand, reason, mark))
    card = _card()
    print("\n## The calling card next to this skill\n")
    if card:
        print(table(["what", "value"], [[k, card[k]] for k in sorted(card)]))
        print("Freilauf rewrites this file whenever it syncs the skills, so a moved port")
        print("or data directory reaches this script by itself.")
    else:
        print("`%s` is missing — this skill was probably copied by hand rather than" % CARD)
        print("installed by Freilauf (Settings -> Freilauf skills).")
    if url is None:
        print("\n**Nothing answered.** `freilauf status` says whether a hub runs here.")
        sys.exit(3)
    print("\nUsing: `%s`" % url)
    print("Override for this shell:  export FREILAUF_HUB_URL=%s" % url)


def cmd_repos():
    repos = api("/api/repos")["repos"]
    rows = [[r["id"], r["name"], r["base_branch"],
             "hub" if r["merge_mode"] == "hub" else "off",
             "active" if r.get("active", 1) else "DEACTIVATED"] for r in repos]
    print("# Repositories (%d)\n" % len(repos))
    print(table(["id", "name", "base", "merge", "state"], rows))
    aus = [r["name"] for r in repos if not r.get("active", 1)]
    if aus:
        print("Deactivated (%s): no run starts there and it is in no dropdown."
              % ", ".join(aus))
        print("Reactivate:  fl-api -X POST /repos/toggle id=<id> active=1")
    nxt("fl-options.py agents --repo <id>", "fl-options.py new --repo <id>")


def cmd_agents(argv):
    repo = None
    if "--repo" in argv:
        repo = argv[argv.index("--repo") + 1]
    agents = api("/api/agents" + ("?repo=%s" % repo if repo else ""))["agents"]
    rows = [[a["id"], a["name"], a.get("repo_name") or a["repo_id"], a["harness"],
             a.get("model") or "-", a.get("schedule_kind") or "manuell",
             "on" if a.get("active") else "off"] for a in agents]
    print("# Agents (%d)%s\n" % (len(agents), " in repo %s" % repo if repo else ""))
    print(table(["id", "name", "repo", "coding agent", "model", "schedule", "state"], rows))
    if not agents:
        print("No agent yet. One is a stored run definition plus a name and a schedule.")
    nxt("fl-options.py agent <coding agent>", "fl-api /api/runs agent=<id> limit=10")


def cmd_coding_agents():
    d = api("/api/coding-agents/detect")["agents"]
    rows = [[a["id"], a.get("label") or a["id"],
             "yes" if a.get("configured") else "no",
             "yes" if a.get("installed") else "NOT INSTALLED"] for a in d]
    print("# Coding agents\n")
    print(table(["id", "name", "configured", "CLI on this machine"], rows))
    usable = [a["id"] for a in d if a.get("configured")]
    if not usable:
        print("None is configured — no run can start. Settings -> Plugins switches one on.")
    else:
        print("Only a CONFIGURED one can run. Details for one of them:")
        print("  fl-options.py agent %s" % usable[0])


def cmd_agent(argv):
    if not argv:
        print("Which coding agent? Try:  fl-options.py coding-agents")
        sys.exit(2)
    h = argv[0]
    prov = api("/api/providers?harness=%s" % h)
    print("# %s\n" % h)
    if prov.get("subscription"):
        print("Runs on its own subscription. Do **not** send `provider` — it is refused.\n")
        models = api("/api/models?provider=%s&harness=%s" % (h, h))
    else:
        ids = [p["id"] for p in prov.get("provider") or []]
        if not ids:
            print("No model provider is available for it (none configured, or no credential).")
            print("Settings -> Plugins is where that is fixed.")
            return
        print("Providers: %s\n" % ", ".join("`%s`" % i for i in ids))
        chosen = argv[1] if len(argv) > 1 else ids[0]
        print("Models below are for `%s` — pass another as: fl-options.py agent %s <provider>\n"
              % (chosen, h))
        models = api("/api/models?provider=%s&harness=%s" % (chosen, h))
    if models.get("ok"):
        names = [m["id"] for m in models["models"]]
        print("Models (%d): %s\n" % (len(names), ", ".join("`%s`" % n for n in names[:40])))
        if len(names) > 40:
            print("_(%d more — the list is long by design; copy an id verbatim.)_\n" % (len(names) - 40))
        eff = api("/api/effort?harness=%s&model=%s" % (h, names[0] if names else ""))
        if eff.get("ok") and eff.get("stufen"):
            print("Effort: %s" % ", ".join("`%s`" % s for s in eff["stufen"]))
            if eff.get("standard"):
                print("Default: `%s`" % eff["standard"])
        else:
            print("Effort: not a field for this coding agent%s."
                  % (" — %s" % eff.get("hinweis") if eff.get("hinweis") else ""))
    else:
        print("The model list is not reachable: %s" % models.get("error"))
    print("\nNEVER invent a model id — copy one from this list.")
    nxt("fl-options.py check harness=%s model=<id> prompt='...'" % h)


def cmd_favorites():
    favs = api("/api/favorites")
    rows = [[f["id"], f["name"], f["harness"], f.get("provider") or "-",
             f.get("model") or "-", f.get("effort") or "-"] for f in favs["favorites"]]
    print("# Favorites (%d of max %d)\n" % (len(rows), favs["max"]))
    print(table(["id", "name", "coding agent", "provider", "model", "effort"], rows))
    print("A favorite is the setup half of a run, saved by the operator. It carries no")
    print("prompt, branch rule or duration — those still belong to the task.")
    print("\nPrefer a fitting favorite over any recommendation, and say which one you used.")
    if rows:
        nxt("fl-options.py new --favorite %s --repo <id>" % rows[0][0])


def cmd_flows():
    flows = api("/api/flows")["flows"]
    rows = [[f["id"], f["name"], (f.get("trigger") or {}).get("kind", "?"),
             "on" if f.get("active") else "off"] for f in flows]
    print("# Flows (%d)\n" % len(flows))
    print(table(["id", "name", "trigger", "state"], rows))
    print("Only a `run_finished` flow can be attached to an agent or a run.")
    print("Attach with the repeatable fields:  flows=<id> flow_when_<id>=always|done|failed|not_done|aborted")


# ------------------------------------------------------- filling a run in
BRANCH_MODES = ["keiner", "neu", "fest"]


def cmd_check(argv):
    """Validate the fields of a run definition and say exactly what is wrong."""
    fields = {}
    for a in argv:
        if "=" in a:
            k, v = a.split("=", 1)
            fields[k] = v
    if not fields:
        print("# Check a run definition\n")
        print("Give the fields you intend to post, and this says what is wrong:\n")
        print("    fl-options.py check harness=claude model=opus effort=high \\")
        print("        repo_id=1 prompt='Fix the flaky test' branch_mode=keiner\n")
        print("It checks them against THIS installation — configured coding agents, the")
        print("models that coding agent really offers, the effort levels it accepts.")
        return
    print("# Checking a run definition\n")
    problems, notes = [], []
    # Width from the real fields, so the reasons line up instead of ragging.
    w = max([len(k) + len(v) + 1 for k, v in fields.items()] + [14])

    def ok(k, why):
        print("OK       %-*s %s" % (w, k + "=" + fields[k], why))

    def bad(k, why):
        problems.append(k)
        print("WRONG    %-*s %s" % (w, k + "=" + fields.get(k, ""), why))

    h = fields.get("harness")
    detect = {a["id"]: a for a in api("/api/coding-agents/detect")["agents"]}
    if not h:
        problems.append("harness")
        print("MISSING  %-*s required. Choose one: %s" % (w, "harness",
              ", ".join(k for k, v in detect.items() if v.get("configured")) or "(none configured)"))
    elif h not in detect:
        bad("harness", "no such coding agent. Known: %s" % ", ".join(detect))
    elif not detect[h].get("configured"):
        bad("harness", "not configured here — Settings -> Plugins switches it on")
    else:
        ok("harness", "configured")
        prov = api("/api/providers?harness=%s" % h)
        sub = prov.get("subscription")
        ids = [p["id"] for p in prov.get("provider") or []]
        if fields.get("provider"):
            if sub:
                bad("provider", "%s runs on a subscription and takes no provider" % h)
            elif fields["provider"] not in ids:
                bad("provider", "not available for %s. Valid: %s" % (h, ", ".join(ids) or "(none)"))
            else:
                ok("provider", "available for %s" % h)
        elif not sub and ids:
            notes.append("provider is empty — %s needs one of: %s" % (h, ", ".join(ids)))
        # A provider that was just rejected must not decide which model list we
        # check against, or the answer is about the wrong catalogue entirely.
        p = h if (sub or "provider" in problems) else (fields.get("provider") or h)
        if fields.get("model"):
            models = api("/api/models?provider=%s&harness=%s" % (p, h))
            names = [m["id"] for m in models.get("models") or []]
            if models.get("ok") and names and fields["model"] not in names:
                want = fields["model"].lower()
                near = [n for n in names if want in n.lower() or n.lower() in want][:5]
                bad("model", "not offered here." + (" Did you mean: %s" % ", ".join(near) if near
                                                    else " See: fl-options.py agent %s" % h))
            elif models.get("ok"):
                ok("model", "offered by %s" % p)
            else:
                notes.append("the model list is unreachable, so `model` was not checked")
        else:
            notes.append("model is empty — the coding agent picks its own default")
        if fields.get("effort"):
            eff = api("/api/effort?harness=%s&provider=%s&model=%s"
                      % (h, fields.get("provider", ""), fields.get("model", "")))
            stufen = eff.get("stufen") or []
            if eff.get("ok") and stufen and fields["effort"] not in stufen:
                bad("effort", "not accepted. Valid: %s" % ", ".join(stufen))
            elif eff.get("ok") and not stufen:
                bad("effort", "%s has no effort field%s" % (h, " — " + eff["hinweis"] if eff.get("hinweis") else ""))
            else:
                ok("effort", "accepted")

    if fields.get("repo_id"):
        repos = {str(r["id"]): r for r in api("/api/repos")["repos"]}
        r = repos.get(str(fields["repo_id"]))
        if not r:
            bad("repo_id", "no such repo. See: fl-options.py repos")
        elif not r.get("active", 1):
            bad("repo_id", "'%s' is deactivated — no run starts there" % r["name"])
        else:
            ok("repo_id", "'%s', base %s" % (r["name"], r["base_branch"]))
    else:
        problems.append("repo_id")
        print("MISSING  %-*s required. See: fl-options.py repos" % (w, "repo_id"))

    if not fields.get("prompt", "").strip():
        problems.append("prompt")
        print("MISSING  %-*s required — the task itself" % (w, "prompt"))
    else:
        ok("prompt", "%d characters" % len(fields["prompt"]))

    bm = fields.get("branch_mode")
    if bm and bm not in BRANCH_MODES:
        bad("branch_mode", "German wire values: %s (no branch / new / existing)" % ", ".join(BRANCH_MODES))
    elif bm:
        ok("branch_mode", "no branch" if bm == "keiner" else "new branch" if bm == "neu" else "existing branch")
        if bm in ("neu", "fest") and not fields.get("branch_pattern"):
            bad("branch_pattern", "required with branch_mode=%s" % bm)
    else:
        notes.append("branch_mode is empty — defaults to `keiner` (no branch)")

    for n in notes:
        print("NOTE     %s" % n)
    print("")
    if problems:
        print("**%d problem(s): %s.** Fix them and run this again." % (len(problems), ", ".join(problems)))
        sys.exit(1)
    print("**All good.** Post it with:\n")
    print("    fl-api -X POST /api/runs \\\n        " + " \\\n        ".join(
        "%s=%s" % (k, _quote(v)) for k, v in fields.items()))


def _quote(v):
    return "'%s'" % v.replace("'", "'\\''") if re.search(r"[\s'\"$]", v) else v


def cmd_new(argv):
    repo = argv[argv.index("--repo") + 1] if "--repo" in argv else None
    fav_id = argv[argv.index("--favorite") + 1] if "--favorite" in argv else None
    repos = [r for r in api("/api/repos")["repos"] if r.get("active", 1)]
    favs = api("/api/favorites")["favorites"]
    if repo is None:
        if len(repos) == 1:
            repo = str(repos[0]["id"])
        else:
            print("# A new run\n\nWhich repository?\n")
            print(table(["id", "name", "base"], [[r["id"], r["name"], r["base_branch"]] for r in repos]))
            nxt("fl-options.py new --repo <id>")
            return
    fav = next((f for f in favs if str(f["id"]) == str(fav_id)), None) or (favs[0] if favs else None)
    print("# A ready command for a new run\n")
    parts = ["repo_id=%s" % repo]
    if fav:
        parts += ["harness=%s" % fav["harness"]]
        for key, name in (("provider", "provider"), ("model", "model"), ("effort", "effort")):
            if fav.get(key):
                parts.append("%s=%s" % (name, fav[key]))
        print("Setup taken from the favorite **%s** — the operator's own preference.\n" % fav["name"])
    else:
        parts += ["harness=<coding agent>", "model=<model>"]
        print("No favorite is saved, so fill the setup in yourself:")
        print("  fl-options.py coding-agents\n")
    parts += ["prompt='<the task>'", "branch_mode=keiner", "expected_minutes=45"]
    print("    fl-api -X POST /api/runs \\\n        " + " \\\n        ".join(parts))
    print("\nReplace the prompt. `branch_mode=keiner` means no branch; `neu` or `fest`")
    print("need a `branch_pattern` as well.")
    nxt("fl-options.py check " + " ".join(p for p in parts if not p.startswith("prompt")))


COMMANDS = {
    "repos": lambda a: cmd_repos(),
    "agents": cmd_agents,
    "coding-agents": lambda a: cmd_coding_agents(),
    "agent": cmd_agent,
    "favorites": lambda a: cmd_favorites(),
    "flows": lambda a: cmd_flows(),
    "check": cmd_check,
    "new": cmd_new,
    "where": lambda a: cmd_where(),
}


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        cmd_overview()
        return
    cmd = argv[0]
    if cmd not in COMMANDS:
        print("No command `%s`. Available: %s" % (cmd, ", ".join(sorted(COMMANDS))))
        print("Run it with no arguments for the overview.")
        sys.exit(2)
    COMMANDS[cmd](argv[1:])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
