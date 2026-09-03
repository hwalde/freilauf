#!/usr/bin/env python3
"""fl-plugins — find the plugin contract, see what is registered, install a package.

A coding agent, a model provider and a notification channel are all *plugins* in
Freilauf. The complete contract for all three is ONE file in the hub's own
checkout — `docs/plugins.md`, ~1450 lines — and this tool's main job is to find
that file on THIS machine and hand back its section index, so nothing has to be
restated (and go stale) anywhere else.

It also lists what is registered right now, installs and removes external
packages, and scaffolds a new one.

Run it with no arguments for the overview.

Standard library only, no venv, no dependencies. It finds the hub by itself —
`fl-plugins.py where` explains how, which is also the first thing to run when
something does not answer.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 15
HERE = os.path.dirname(os.path.abspath(__file__))
# The calling card the installation writes next to the skill it installs.
CARD = os.path.join(os.path.dirname(HERE), ".freilauf-skill.json")


# --------------------------------------------------------------- finding the hub
# Copied verbatim from fl-options.py, on purpose: a skill directory is installed
# standalone, so an import of a sibling skill would break the moment somebody
# copied one and not the other.
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
    send the reader looking for the wrong problem entirely.
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
            print("or check with: fl-plugins.py where")
            sys.exit(3)
        print("The hub answered HTTP %s for `%s`." % (e.code, path))
        sys.exit(3)


def post(path, fields):
    """POST a form to the hub.

    The plugin routes are the web UI's own: on success they answer 303 to
    /settings/plugins, and on failure an HTML *problem page* carrying the
    developer-facing English error. Neither is JSON, so this reports what really
    came back instead of pretending otherwise.
    """
    if HUB is None:
        api("/api/usage")
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(HUB + path, data=body, method="POST", headers={
        "content-type": "application/x-www-form-urlencoded",
    })

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def problems_from_html(html):
    """The <li> items of a problem page — that is where the real reason is."""
    items = re.findall(r"<li[^>]*>(.*?)</li>", html, re.S)
    out = []
    for raw in items:
        text = re.sub(r"<[^>]+>", "", raw)
        text = (text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
                    .replace("&quot;", '"').replace("&#39;", "'")).strip()
        if text:
            out.append(text)
    return out


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


# ------------------------------------------------------- finding the contract
def app_dir():
    """The hub's own code directory, and how we know.

    Order: an explicit override, the calling card the installation wrote next to
    this skill, then a walk up from this script (which finds it when the skill is
    read straight out of the checkout). Returns (dir, why) or (None, None).
    """
    override = os.environ.get("FREILAUF_APP_DIR")
    if override and os.path.isfile(os.path.join(override, "docs", "plugins.md")):
        return override, "the FREILAUF_APP_DIR environment variable"
    card = _card()
    d = card.get("app_dir")
    if d and os.path.isfile(os.path.join(d, "docs", "plugins.md")):
        return d, "the calling card next to this skill"
    walk = HERE
    for _ in range(6):
        if os.path.isfile(os.path.join(walk, "docs", "plugins.md")):
            return walk, "a walk up from this script"
        parent = os.path.dirname(walk)
        if parent == walk:
            break
        walk = parent
    return None, None


def contract_path():
    d, why = app_dir()
    return (os.path.join(d, "docs", "plugins.md"), why) if d else (None, None)


def no_contract():
    """Say honestly that the file was not found, and how to get to it anyway."""
    print("# The plugin contract was not found on this machine\n")
    card = _card()
    if not card:
        print("`%s` is missing — this skill was probably copied by hand rather" % CARD)
        print("than installed by Freilauf (Settings -> Freilauf skills).\n")
    elif not card.get("app_dir"):
        print("The calling card next to this skill carries no `app_dir`. It was written")
        print("by a hub older than this skill; re-save Settings -> Freilauf skills and")
        print("it will be rewritten.\n")
    else:
        print("The calling card points at `%s`, and there is no" % card["app_dir"])
        print("`docs/plugins.md` under it — the checkout was moved or removed.\n")
    print("Three ways to the same file:\n")
    print("1. Ask the hub where this installation lives:\n")
    print("       fl-api /api/skills\n")
    print("2. It is also in the operator's own checkout of Freilauf, which the hub lists:\n")
    print("       fl-api /api/repos\n")
    print("3. Point this tool at the checkout directly:\n")
    print("       export FREILAUF_APP_DIR=/path/to/freilauf\n")
    print("Read `docs/plugins.md` there. **Do not write a plugin from memory** —")
    print("the descriptor contract is exact and a wrong field is silently ignored.")


def cmd_docs(argv):
    path, why = contract_path()
    if not path:
        no_contract()
        sys.exit(3)
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    print("# The plugin contract\n")
    print("    %s\n" % path)
    print("Found via %s. It is %d lines — read the section you need, not the file.\n"
          % (why, len(lines)))
    want = " ".join(argv).strip().lower()
    rows, hits = [], []
    for i, line in enumerate(lines, 1):
        m = re.match(r"^(##+)\s+(.*)$", line)
        if not m or len(m.group(1)) > 3:
            continue
        title = m.group(2).strip()
        depth = "  " * (len(m.group(1)) - 2)
        rows.append([str(i), depth + title])
        if want and want in title.lower():
            hits.append((i, title))
    print(table(["line", "section"], rows))
    if want:
        if hits:
            print("Matching `%s`:\n" % want)
            for i, title in hits:
                print("    sed -n '%d,%dp' %s   # %s" % (i, i + 120, path, title))
        else:
            print("No section title contains `%s`. Search the body instead:\n" % want)
            print("    grep -n -i %s %s" % (want, path))
        return
    print("Read one section, for example:\n")
    print("    sed -n '/^## Coding agent plugin contract/,/^## Model provider/p' %s" % path)
    nxt("fl-plugins.py docs 'adding a new'",
        "fl-plugins.py list",
        "fl-plugins.py new provider <id>")


# ------------------------------------------------------------ what is there now
def plugin_dir():
    """Where external packages live, and how we know."""
    d = os.environ.get("FREILAUF_PLUGIN_DIR")
    if d:
        return d, "FREILAUF_PLUGIN_DIR"
    d = _card().get("plugin_dir")
    if d:
        return d, "the calling card next to this skill"
    return None, None


def packages():
    """Every external package directory, read from its own plugin.json."""
    d, _why = plugin_dir()
    if not d or not os.path.isdir(d):
        return []
    out = []
    for name in sorted(os.listdir(d)):
        pkg = os.path.join(d, name)
        if not os.path.isdir(pkg):
            continue
        try:
            with open(os.path.join(pkg, "plugin.json"), encoding="utf-8") as fh:
                m = json.load(fh) or {}
            out.append({"dir": name, "id": m.get("id") or "?", "kind": m.get("kind") or "?",
                        "name": m.get("name") or "", "version": m.get("version") or "?"})
        except Exception as e:
            out.append({"dir": name, "id": "?", "kind": "?", "name": "unreadable: %s" % e,
                        "version": "?"})
    return out


def cmd_list(argv):
    print("# Plugins on this installation\n")
    detect = api("/api/coding-agents/detect")["agents"]
    rows = [[a["id"], a.get("label") or a["id"],
             "yes" if a.get("configured") else "no",
             "yes" if a.get("installed") else "NOT INSTALLED"] for a in detect]
    print("## Coding agents\n")
    print(table(["id", "label", "enabled", "CLI on this machine"], rows))

    seen = {}
    for a in detect:
        if not a.get("configured"):
            continue
        p = api("/api/providers?harness=%s" % urllib.parse.quote(a["id"]))
        if p.get("subscription"):
            continue
        for row in p.get("provider") or []:
            seen.setdefault(row["id"], [row.get("label") or row["id"], []])[1].append(a["id"])
    print("## Model providers\n")
    print(table(["id", "label", "offered to"],
                [[k, v[0], ", ".join(v[1])] for k, v in sorted(seen.items())]))
    print("Only providers that are enabled AND have a credential are offered, so a")
    print("provider missing here may simply be waiting for a key.\n")

    pkgs = packages()
    d, why = plugin_dir()
    print("## External packages\n")
    if d:
        print("From `%s` (%s).\n" % (d, why))
        print(table(["id", "kind", "name", "version", "directory"],
                    [[p["id"], p["kind"], p["name"], p["version"], p["dir"]] for p in pkgs]))
    else:
        print("Unknown — neither `FREILAUF_PLUGIN_DIR` nor a calling card says where")
        print("they live. The Plugins page names the directory.\n")

    print("## What this cannot tell you\n")
    print("The hub has no JSON route for the registry, so two things are only on the")
    print("web page — **load errors** of a broken package, and the **notification")
    print("channels** with their enabled state:\n")
    print("    <hub>/settings/plugins          coding agents, providers, packages, load errors")
    print("    <hub>/settings/notifications    notification channels")
    print("\nA package listed above that is NOT working is a load error, and only that")
    print("page says why.")
    nxt("fl-plugins.py docs", "fl-plugins.py scan", "fl-plugins.py install <dir>")


# ------------------------------------------------------- changing what is there
def _report(code, html, done, path):
    # 303 is what a browser POST to these routes gets on success; the hub sends
    # the reader back to the Plugins page. Anything else is a problem page.
    if code in (200, 302, 303):
        print(done)
        return 0
    problems = problems_from_html(html)
    print("**Refused** (HTTP %s from `%s`).\n" % (code, path))
    for p in problems or ["the hub sent no reason — open <hub>/settings/plugins"]:
        print("- %s" % p)
    return 1


def cmd_install(argv):
    if not argv:
        print("# Install an external plugin package\n")
        print("    fl-plugins.py install <directory>\n")
        print("The directory must hold a `plugin.json` and the module it names. The hub")
        print("validates the manifest, copies the directory into its plugin directory and")
        print("registers it. A colliding id is REFUSED, never overridden.\n")
        nxt("fl-plugins.py new provider my-provider", "fl-plugins.py list")
        sys.exit(2)
    src = os.path.abspath(os.path.expanduser(argv[0]))
    if not os.path.isdir(src):
        print("`%s` is not a directory." % src)
        sys.exit(2)
    if not os.path.isfile(os.path.join(src, "plugin.json")):
        print("`%s` holds no `plugin.json`, so the hub will refuse it." % src)
        print("Scaffold one:  fl-plugins.py new <harness|provider|notifier> <id>")
        sys.exit(2)
    code, html = post("/settings/plugins/install", {"path": src})
    rc = _report(code, html, "Installed `%s`." % src, "/settings/plugins/install")
    if rc == 0:
        print("\nIt is registered but **not configured**: a coding agent is off until it is")
        print("switched on, a provider is on unless it was switched off, and a notifier")
        print("needs its settings. Do that under <hub>/settings/plugins.")
        nxt("fl-plugins.py list")
    sys.exit(rc)


def cmd_uninstall(argv):
    if not argv:
        print("Which package? Its id, not its directory:  fl-plugins.py uninstall <id>")
        print("See:  fl-plugins.py list")
        sys.exit(2)
    code, html = post("/settings/plugins/uninstall", {"id": argv[0]})
    rc = _report(code, html, "Removed `%s` — its directory and its configuration." % argv[0],
                 "/settings/plugins/uninstall")
    if rc == 0:
        nxt("fl-plugins.py list")
    sys.exit(rc)


def cmd_scan(argv):
    code, html = post("/settings/plugins/scan", {})
    rc = _report(code, html, "Scanned. Every registered plugin was asked whether its CLI is on\n"
                             "the PATH and whether a declared credential variable is set.",
                 "/settings/plugins/scan")
    if rc == 0:
        nxt("fl-plugins.py list")
    sys.exit(rc)


# ------------------------------------------------------------------ scaffolding
KINDS = ("harness", "provider", "notifier")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")

HEAD = """// %(kind)s plugin `%(id)s` for Freilauf.
//
// THE FULL CONTRACT IS IN docs/plugins.md OF THE HUB'S OWN CHECKOUT.
// `fl-plugins.py docs` prints its path and its section index. This file is the
// MINIMUM `validateDescriptor()` accepts and nothing more — every optional
// declaration (credentials, gate, llm, settings, launch, skills, balance) is
// described there, and a field this file does not mention is not a field that
// does not exist.
//
// Rules that bite here and nowhere else:
//   * import nothing from the hub at the top of the file. If you need one of
//     its modules, `await import()` it INSIDE the function that uses it.
//   * every user-visible string is an i18n key (labelKey, hintKey, ...) that
//     must exist in lang/en.json, lang/de.json AND lang/zh.json.
//   * the id must not collide with a registered plugin — a duplicate is
//     refused, never given precedence.

"""

BODIES = {
    "harness": """const plugin = {
  id: '%(id)s',
  label: '%(label)s',
  bin: '%(id)s',                 // the CLI this drives
  subscription: false,           // true = own account, takes no model provider
  providers: [],                 // model provider ids this CLI can be pointed at
  keyFreeProviders: [],          // ...of those, the ones it reaches with no own key

  // Narrow: a menu line reading "Upgrade for higher rate limits" once sat in
  // the database as a rate limit on a production run.
  logPatterns: [
    { re: /\\brate limit\\b/i, typ: 'rate_limit' },
  ],

  /** CLI arguments for the model. `fehlt` names what could not be passed. */
  modelArgs(run, _ctx = null) {
    const args = []
    if (run.model) args.push('--model', run.model)
    return { args, fehlt: [] }
  },

  /** The reasoning levels this CLI really accepts. `null` = it has no such flag. */
  async effortOptions() {
    return { stufen: null }
  },

  /** Subscription usage for the sidebar, or null when there is nothing to meter. */
  async usage(_ctx = null) {
    return null
  },

  /** The provider pulse this agent's runs belong to, or null for "not monitored". */
  pulseId: () => null,

  // REQUIRED for an external coding agent: without `launch` nothing can start a
  // run, and `launchable()` says so before a worktree exists. See "The launch
  // declaration" in docs/plugins.md.
  launch: {
    promptMode: 'argv',
    args: [
      { when: 'model', args: ['--model', '{model}'] },
      '{prompt}',
    ],
    sessionTag: '%(tag)s-',
  },
}

export default plugin
""",
    "provider": """const plugin = {
  id: '%(id)s',
  label: '%(label)s',

  // Declared credentials carry a label and a help text on the Plugins page;
  // a bare `envKeys` array works too and is read as one `api_key`.
  credentials: [
    { key: 'api_key', envKeys: ['%(env)s_API_KEY'], labelKey: 'plugin.%(id)s.api_key' },
  ],

  /** The model catalog. Read the key through the context, never process.env. */
  async fetchModels(ctx) {
    const key = await ctx.secret('api_key')
    if (!key) return []
    const j = await ctx.json('https://api.example.com/v1/models', {
      headers: { authorization: `Bearer ${key}` },
    })
    return (j.data ?? []).map(m => ({ id: m.id, name: m.name ?? m.id }))
  },

  // Optional, and each one buys a whole feature without a line of UI code:
  //   balance(ctx)  -> the usage panel shows the account balance
  //   gate          -> a budget gate of this provider's own
  //   llm           -> the hub may ask this provider its own four questions
}

export default plugin
""",
    "notifier": """const plugin = {
  id: '%(id)s',
  label: '%(label)s',

  // What the operator has to fill in. `required` is how the hub knows whether
  // this channel may speak at all.
  settings: [
    { key: 'webhook', type: 'text', required: true, labelKey: 'plugin.%(id)s.webhook' },
  ],

  /**
   * The one required function. The hub composes plain text; how it is rendered
   * is this channel's business. Never throw for a delivery that merely failed —
   * notify() must stay a call that cannot break its caller.
   *
   * message: { kind, text, url, linkLabel, runId, attachment }
   */
  async send(message, ctx) {
    const url = await ctx.setting('webhook')
    if (!url) return { ok: false, error: 'no webhook configured' }
    try {
      await ctx.json(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(message?.text ?? '') }),
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  },
}

export default plugin
""",
}


def cmd_new(argv):
    if len(argv) < 2 or argv[0] not in KINDS:
        print("# Scaffold a plugin package\n")
        print("    fl-plugins.py new <harness|provider|notifier> <id> [directory]\n")
        print(table(["kind", "what it is"],
                    [["`harness`", "a coding agent — a CLI the hub drives in a tmux session"],
                     ["`provider`", "a model provider the coding agents can be pointed at"],
                     ["`notifier`", "a notification channel the hub reports through"]]))
        print("The id is lowercase letters, digits and dashes, 2 to 40 characters.")
        nxt("fl-plugins.py docs 'adding a new'")
        sys.exit(2)
    kind, pid = argv[0], argv[1]
    if not ID_RE.match(pid):
        print("`%s` is not a legal plugin id: lowercase letters, digits and dashes," % pid)
        print("2 to 40 characters, never starting with a dash.")
        sys.exit(2)
    target = os.path.abspath(os.path.expanduser(argv[2] if len(argv) > 2 else pid))
    if os.path.exists(target):
        print("`%s` already exists — refusing to write into it." % target)
        sys.exit(2)
    label = pid.replace("-", " ").title()
    subs = {"id": pid, "kind": kind, "label": label,
            "env": re.sub(r"[^A-Z0-9]", "_", pid.upper()),
            "tag": pid[:2]}
    os.makedirs(target)
    manifest = {"api": 1, "id": pid, "kind": kind, "name": label,
                "version": "0.1.0", "main": "index.mjs",
                "description": "A Freilauf %s plugin." % kind}
    with open(os.path.join(target, "plugin.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    with open(os.path.join(target, "index.mjs"), "w", encoding="utf-8") as fh:
        fh.write((HEAD + BODIES[kind]) % subs)
    print("# Scaffolded a %s package\n" % kind)
    print(table(["file", "what it is"],
                [["`%s/plugin.json`" % target, "the manifest the hub validates first"],
                 ["`%s/index.mjs`" % target, "the descriptor, as the default export"]]))
    print("**It is a skeleton, not a working plugin.** Read the contract before")
    print("filling it in — the section for this kind is:\n")
    path, _why = contract_path()
    section = {"harness": "Coding agent plugin contract",
               "provider": "Model provider plugin contract",
               "notifier": "Notifier plugin contract"}[kind]
    if path:
        print("    sed -n '/^## %s/,/^## /p' %s" % (section, path))
    else:
        print('    fl-plugins.py docs "%s"' % section)
    nxt("fl-plugins.py docs '%s'" % section.lower(),
        "fl-plugins.py install %s" % target)


# ------------------------------------------------------------------------ where
def cmd_where(argv):
    print("# Where the hub and its contract are\n")
    print("Looked for the hub in this order — the first that answers wins:\n")
    url, _why = find_hub()
    for i, (cand, reason) in enumerate(candidates(), 1):
        mark = "**answers**" if cand == url else "no answer"
        print("%d. `%s` — %s _(%s)_" % (i, cand, reason, mark))
    card = _card()
    print("\n## The calling card next to this skill\n")
    if card:
        print(table(["what", "value"], [[k, card[k]] for k in sorted(card)]))
    else:
        print("`%s` is missing — this skill was probably copied by hand rather than" % CARD)
        print("installed by Freilauf (Settings -> Freilauf skills).\n")
    path, why = contract_path()
    print("\n## The plugin contract\n")
    if path:
        print("`%s`\n\n%s." % (path, why))
    else:
        print("**Not found.** Run `fl-plugins.py docs` for the three ways to it.")
    if url is None:
        print("\n**No hub answered.** `freilauf status` says whether one runs here.")
        sys.exit(3)
    print("\nUsing hub: `%s`" % url)


# --------------------------------------------------------------------- overview
def cmd_overview():
    print("# Freilauf plugins\n")
    print("A coding agent, a model provider and a notification channel are all")
    print("plugins: one descriptor object per file, collected by a registry.\n")
    path, why = contract_path()
    if path:
        print("The complete contract for all three is **one file**:\n")
        print("    %s\n" % path)
        print("_(%s)_ — `docs` prints its section index. **Read it before writing a" % why)
        print("plugin;** nothing here restates it, on purpose.\n")
    else:
        print("**The contract file was not found on this machine** — run `docs` for the")
        print("three ways to it. Do not write a plugin without it.\n")
    print(table(
        ["command", "what it does"],
        [["`docs [text]`", "the contract's path and section index; `text` jumps to a section"],
         ["`list`", "what is registered here: coding agents, providers, packages"],
         ["`new <kind> <id>`", "scaffold a package directory (harness | provider | notifier)"],
         ["`install <dir>`", "install an external package from a directory"],
         ["`uninstall <id>`", "remove an external package and its configuration"],
         ["`scan`", "ask the machine again which CLIs and credentials are there"],
         ["`where`", "how the hub and the contract were found, and what else was tried"]]))
    print("Order of work: read the contract section for your kind -> `new` -> fill it")
    print("in -> `install` -> switch it on and configure it under Settings -> Plugins")
    print("-> test it.")
    nxt("fl-plugins.py docs", "fl-plugins.py list")


COMMANDS = {
    "docs": cmd_docs,
    "list": cmd_list,
    "install": cmd_install,
    "uninstall": cmd_uninstall,
    "scan": cmd_scan,
    "new": cmd_new,
    "where": cmd_where,
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
