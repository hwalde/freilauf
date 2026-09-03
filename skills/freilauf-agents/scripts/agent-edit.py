#!/usr/bin/env python3
"""Edit one Freilauf agent without losing the fields you did not mention.

POST /agents/edit is a full replace, not a patch: every column of the run
definition and of the schedule is written from the submitted body, so a field
left out is reset (no `active` switches the agent off, no `skills` drops every
skill, no `schedule_kind` makes the schedule manual). This script reads the
agent back from GET /api/agents, rebuilds the complete form body from the row,
applies the overrides you give and posts the whole thing.

Usage:
  agent-edit.py --id 7 [--dry-run] [--clear NAME ...] [name=value ...]

  name=value        set a field (repeat the name to send a repeated field,
                    which REPLACES the whole list: skills, flows, schedule_days)
  name=@path        take the value from a file (for a prompt)
  --clear NAME      send the field not at all (skills, flows, active, goal, ...)
  --dry-run         print the body that would be sent, post nothing

Exit codes: 0 saved, 1 refused (the problems are printed), 2 usage,
            3 the hub could not be reached.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 30


def hub_base():
    """The hub's local base URL — the session's own value first, then fl-api."""
    for var in ("FL_HUB_URL", "CC_HUB_URL"):
        if os.environ.get(var):
            return os.environ[var].rstrip("/")
    exe = shutil.which("fl-api")
    if exe:
        try:
            out = subprocess.run([exe, "--url"], capture_output=True, text=True, timeout=10)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip().rstrip("/")
        except Exception:
            pass
    die(3, "no FL_HUB_URL and no usable fl-api on the PATH")


def die(code, msg):
    print(f"agent-edit: {msg}", file=sys.stderr)
    sys.exit(code)


def get_json(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        die(3, f"the hub at {base} did not answer: {e}")


def parse_json_field(value):
    """A column that holds JSON — tolerant of NULL, '' and rubbish."""
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value or "null")
    except Exception:
        return None


def body_from_row(a):
    """The agents row as the complete form body, as a list of (name, value).

    Mirrors setupToFormBody() and zeitplanFelder() in the hub: the four fields
    that are not one-to-one are or_routing, skills, flows and schedule_days.
    """
    out = []
    add = lambda k, v: out.append((k, "" if v is None else str(v)))

    add("name", a.get("name"))
    add("repo_id", a.get("repo_id"))
    if a.get("active"):
        add("active", "1")

    add("harness", a.get("harness"))
    add("provider", a.get("provider"))
    add("model", a.get("model"))
    add("effort", a.get("effort"))

    routing = parse_json_field(a.get("or_routing")) or {}
    if a.get("or_provider"):
        add("or_mode", "pin")
        add("or_provider", a.get("or_provider"))
    elif routing.get("mode") == "auto":
        add("or_mode", "auto")
        add("or_quant", routing.get("quant_min", ""))
        add("or_region", routing.get("location", "all"))
        add("or_max_in", routing.get("max_in", ""))
        add("or_max_out", routing.get("max_out", ""))
    else:
        add("or_mode", "offen")

    add("prompt", a.get("prompt"))
    add("goal", a.get("goal"))
    add("branch_mode", a.get("branch_mode"))
    add("branch_pattern", a.get("branch_pattern"))
    if a.get("keep_on_branch"):
        add("keep_on_branch", "1")
    add("expected_minutes", a.get("expected_minutes"))

    for entry in parse_json_field(a.get("skills")) or []:
        name, _, dial = str(entry).partition(":")
        add("skills", name)
        if dial:
            add(f"skill_regler_{name}", dial)

    for att in parse_json_field(a.get("flows")) or []:
        flow_id = att.get("flowId")
        if flow_id is None:
            continue
        add("flows", flow_id)
        add(f"flow_when_{flow_id}", att.get("when") or "always")

    kind = a.get("schedule_kind") or "manuell"
    add("schedule_kind", kind)
    if kind == "woechentlich":
        # Different times per weekday are one field and outrank the two flat
        # ones — sending both would be two statements about the same schedule.
        if a.get("schedule_slots"):
            slots = a["schedule_slots"]
            add("schedule_slots", slots if isinstance(slots, str) else json.dumps(slots))
        else:
            for day in str(a.get("schedule_days") or "").split(","):
                if day.strip() != "":
                    add("schedule_days", day.strip())
            add("schedule_time", a.get("schedule_time"))
        add("schedule_weeks", a.get("schedule_weeks") or 1)
        if a.get("schedule_anchor"):
            add("schedule_anchor", a.get("schedule_anchor"))
    elif kind == "einmalig":
        add("run_at", a.get("run_at"))
    elif kind == "cron":
        add("schedule", a.get("schedule"))
    return out


def apply_overrides(pairs, overrides, clears):
    """Overrides replace a name completely; --clear removes it completely."""
    touched = {k for k, _ in overrides}
    kept = [(k, v) for k, v in pairs if k not in touched and k not in clears]
    # A cleared or replaced skill/flow must not leave its companion behind.
    for name in list(clears) + list(touched):
        if name == "skills":
            kept = [(k, v) for k, v in kept if not k.startswith("skill_regler_")]
        if name == "flows":
            kept = [(k, v) for k, v in kept if not k.startswith("flow_when_")]
    return kept + list(overrides)


def problems_from_html(html):
    block = re.search(r'<ul class="err">(.*?)</ul>', html, re.S)
    if not block:
        return []
    items = re.findall(r"<li>(.*?)</li>", block.group(1), re.S)
    unescape = lambda s: (s.replace("&amp;", "&").replace("&lt;", "<")
                          .replace("&gt;", ">").replace("&quot;", '"')
                          .replace("&#39;", "'"))
    return [unescape(re.sub(r"<[^>]+>", "", i)).strip() for i in items]


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--id", required=True, type=int, help="the agent id")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--clear", action="append", default=[], metavar="NAME")
    ap.add_argument("assignments", nargs="*", metavar="name=value")
    args = ap.parse_args()

    overrides = []
    for item in args.assignments:
        if "=" not in item:
            die(2, f'"{item}" is not name=value')
        key, value = item.split("=", 1)
        if value.startswith("@"):
            try:
                with open(value[1:], encoding="utf-8") as fh:
                    value = fh.read()
            except OSError as e:
                die(2, f"cannot read {value[1:]}: {e}")
        # `active` is a checkbox: the hub switches the agent on for `1`, `on`
        # or `true` and for nothing else. Normalising here means the caller may
        # write active=0/no/off/false and get what they meant either way.
        if key == "active":
            value = "1" if value.strip().lower() in ("1", "on", "true", "yes") else "0"

        overrides.append((key, value))

    base = hub_base()
    answer = get_json(base, "/api/agents")
    row = next((a for a in answer.get("agents", []) if a.get("id") == args.id), None)
    if row is None:
        die(2, f"no agent with id {args.id} on this hub")

    pairs = apply_overrides(body_from_row(row), overrides, set(args.clear))

    if args.dry_run:
        for key, value in pairs:
            shown = value if len(value) <= 200 else value[:200] + f"… ({len(value)} chars)"
            print(f"{key}={shown!r}")
        return 0

    data = urllib.parse.urlencode(pairs).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/agents/edit?id={args.id}", data=data,
        headers={"content-type": "application/x-www-form-urlencoded"})
    try:
        # The hub answers 303 on success; urllib would follow it and turn the
        # result into a 200 for a page we do not care about.
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(req, timeout=TIMEOUT) as r:
            code, text = r.status, ""
    except urllib.error.HTTPError as e:
        code, text = e.code, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        die(3, f"the hub at {base} did not answer: {e}")

    if code in (302, 303):
        print(f"saved (HTTP {code}) — agent {args.id}")
        return 0
    print(f"refused (HTTP {code})", file=sys.stderr)
    for p in problems_from_html(text) or ["(no problem list in the answer)"]:
        print(f"  - {p}", file=sys.stderr)
    return 1


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


if __name__ == "__main__":
    sys.exit(main())
