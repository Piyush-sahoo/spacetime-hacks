#!/usr/bin/env python3
"""Hand-operated side of The Map Room plugin — what the skill drives.

    map_room_cli.py report <path> [<path>...]   report files this agent just looked at
    map_room_cli.py pending
    map_room_cli.py claim <request_id> [agent_name]
    map_room_cli.py complete <request_id> "findings"   (2-3 plain lines, newline separated)
    map_room_cli.py complete <request_id> -             read the findings from stdin
    map_room_cli.py coverage
    map_room_cli.py doctor
    map_room_cli.py index [owner/repo]     build the map for this repo
    map_room_cli.py rebind                 forget the cached repo binding

Unlike the hooks, this one is allowed to be loud: it is invoked deliberately and
its output is meant to be read.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import map_room as m  # noqa: E402


def _ctx(bind: bool = True):
    cfg = m.load_config()
    token = m.read_token()
    if bind:
        m.bind_repo(cfg, token, allow_network=True)
    return cfg, token


def _require_repo(cfg) -> bool:
    if cfg.get("repo_id"):
        return True
    source = cfg.get("repo_id_source")
    if source == "not-indexed":
        print("%s is not indexed yet -- nothing is being reported for this repo."
              % cfg.get("repo_slug"))
        print("Build its map with:  python3 %s index" % os.path.abspath(__file__))
    elif source == "no-remote":
        print("No `origin` remote in %s, so this checkout is not bound to a map."
              % cfg["project_dir"])
        print("Pin one explicitly with MAP_ROOM_REPO_ID=<id> or .map-room.json.")
    else:
        print("Could not resolve a repo (%s). Nothing reported." % source)
    return False


# --------------------------------------------------------------------------
# self-reporting: the one-liner a cooperative agent calls itself
# --------------------------------------------------------------------------
#
# Claude Code gets its touches from a PostToolUse hook -- the harness runs it,
# the model has no say. Agents with no such hook have to report themselves, and
# this is the whole interface they need:
#
#     map_room_cli.py report src/app.py tests/test_app.py
#
# Same reducer, same binding rules, same silence on an unindexed repo.

SESSION_TTL = 4 * 60 * 60


def _session_id(cfg) -> str:
    """The session these touches belong to.

    An explicit MAP_ROOM_SESSION always wins -- an agent that knows its own
    session id (opencode, Codex) should pass it so the ?session= link matches
    what the person sees in their terminal. Otherwise we mint one per checkout
    and keep it for four hours, so a working session stays one route on the map
    instead of fragmenting into a new dot per file.
    """
    explicit = (os.environ.get("MAP_ROOM_SESSION") or "").strip()
    if explicit:
        return explicit[:120]
    import time
    import uuid
    path = os.path.join(m.state_root(), "session",
                        m._safe_key(cfg["project_dir"], 120) + ".json")
    now = time.time()
    try:
        with open(path, encoding="utf-8") as fh:
            cached = json.load(fh)
        if cached.get("session") and now - float(cached.get("at") or 0) < SESSION_TTL:
            cached["at"] = now
            _write_json(path, cached)
            return str(cached["session"])
    except Exception:
        pass
    fresh = "%s-%s" % (cfg["agent_name"], uuid.uuid4().hex[:12])
    _write_json(path, {"session": fresh, "at": now})
    return fresh


def _write_json(path: str, payload: dict) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    except Exception:
        pass


def cmd_report(argv) -> int:
    """report <path>... [--bash CMD] [--tool NAME] [--session ID] [--agent NAME] [--quiet]

    `--bash` hands a whole shell command over to the same parser the Claude Code
    hook uses, so an integration that sees `cat src/app.py` reports what was
    actually read rather than nothing. Paths it is unsure about are dropped --
    a missed touch leaves a region dark, an invented one lights the wrong one.
    """
    paths, tool, session, agent, quiet, bash = [], "Read", None, None, False, None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("--tool", "--session", "--agent", "--bash") and i + 1 < len(argv):
            value = argv[i + 1]
            if arg == "--tool":
                tool = value
            elif arg == "--session":
                session = value
            elif arg == "--bash":
                bash = value
            else:
                agent = value
            i += 2
            continue
        if arg == "--quiet":
            quiet = True
            i += 1
            continue
        paths.append(arg)
        i += 1

    if not paths and bash is None:
        print("usage: map_room_cli.py report <path> [<path>...] "
              "[--bash '<shell command>'] [--tool NAME] [--session ID]",
              file=sys.stderr)
        return 2

    cfg = m.load_config()
    if agent:
        cfg["agent_name"] = agent
    token = m.read_token()
    m.bind_repo(cfg, token, allow_network=True)

    if not cfg.get("repo_id"):
        # Deliberate: an unindexed repo reports nothing rather than landing on
        # somebody else's map. Say so once, then stay quiet.
        if not quiet:
            _require_repo(cfg)
        return 0

    if bash is not None:
        paths = list(paths) + m.extract_bash_paths(bash, cfg["project_dir"])
        if tool == "Read":
            tool = "Bash"
    rel = m.to_repo_relative(paths, cfg["project_dir"])
    if not rel:
        if not quiet:
            print("Nothing to report -- no path was inside %s." % cfg["project_dir"])
        return 0

    session = session or _session_id(cfg)
    out = m.report_touch(cfg, token, session, tool, rel)
    text = str(out or "").strip()
    if text.startswith("HTTP ") or text.startswith("ERROR:"):
        if not quiet:
            print("FAILED to report: %s" % text, file=sys.stderr)
        return 1
    if quiet:
        return 0
    print("Reported %d path%s to %s as %s."
          % (len(rel), "" if len(rel) == 1 else "s", cfg.get("repo_slug") or cfg["repo_id"],
             cfg["agent_name"]))
    link = m.session_link(cfg, session)
    if link and m.once("selflink", session):
        print("Watch this session: %s" % link)
    return 0


def cmd_pending(argv) -> int:
    cfg, token = _ctx()
    rows = m.pending_requests(cfg, token, limit=50)
    if not rows:
        print("No pending exploration requests.")
        return 0
    print("Pending exploration requests (%d):" % len(rows))
    for row in rows:
        print(m.request_line(row))
    return 0


def cmd_claim(argv) -> int:
    if not argv:
        print("usage: map_room_cli.py claim <request_id> [agent_name]", file=sys.stderr)
        return 2
    cfg, token = _ctx()
    agent = argv[1] if len(argv) > 1 else None
    out = m.claim_request(cfg, token, argv[0], agent)
    return _report("claimed request #%s" % argv[0], out)


def cmd_complete(argv) -> int:
    if len(argv) < 2:
        print('usage: map_room_cli.py complete <request_id> "findings"   (or: ... complete <id> - <<\'EOF\')',
              file=sys.stderr)
        return 2
    cfg, token = _ctx()
    if argv[1] == "-" and len(argv) == 2:
        # A finding is 3-5 lines. Heredocs and pipes are the sane way to hand
        # multi-line text to a CLI without the shell eating the breaks.
        result = _clean(sys.stdin.read())
    else:
        result = _clean(" ".join(argv[1:]))
    out = m.complete_request(cfg, token, argv[0], result)
    return _report("completed request #%s" % argv[0], out)


def _clean(text: str) -> str:
    """Tidy a finding WITHOUT flattening it.

    The newlines are the structure -- the map splits on them to render points --
    so nothing here may collapse "\n" into a space. Only CRLF, trailing spaces
    and runs of blank lines go; the single line breaks survive to the reducer,
    which stores the string verbatim."""
    lines = [ln.rstrip() for ln in str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    out, blank = [], False
    for ln in lines:
        if not ln.strip():
            blank = bool(out)          # never open with a blank line
            continue
        if blank:
            out.append("")             # at most one blank line between points
            blank = False
        out.append(ln)
    return "\n".join(out)[:4000]


def cmd_index(argv) -> int:
    """Build the map for a GitHub repo. ~3s regardless of repo size."""
    cfg, token = _ctx(bind=False)
    slug = argv[0] if argv else m.parse_remote_slug(m.git_remote_url(cfg["project_dir"]))
    if not slug or "/" not in slug:
        print("usage: map_room_cli.py index <owner/repo>   (no origin remote to infer from)",
              file=sys.stderr)
        return 2
    print("Indexing %s ..." % slug)
    out = m.index_repo(cfg, token, slug)
    text = str(out or "").strip()
    if text.startswith("HTTP ") or text.startswith("ERROR:"):
        print("FAILED: %s" % text, file=sys.stderr)
        return 1
    # Confirm against the slug we actually asked for -- not against whatever
    # this working directory's remote happens to be.
    m.clear_bind_cache(cfg["project_dir"])
    repo_id, reached = m.lookup_repo_id(cfg, token, slug)
    if repo_id:
        print("Indexed. %s is repo_id %s." % (slug, repo_id))
        return 0
    print("%s was not indexed -- no repo row exists for it.%s"
          % (slug, "" if reached else " (could not reach the database)"),
          file=sys.stderr)
    return 1


def cmd_rebind(argv) -> int:
    cfg, _ = _ctx(bind=False)
    removed = m.clear_bind_cache(cfg["project_dir"])
    print("Cleared %d cached binding(s) for %s." % (removed, cfg["project_dir"]))
    return cmd_doctor([])


def cmd_coverage(argv) -> int:
    cfg, token = _ctx()
    if not _require_repo(cfg):
        return 1
    # Scope the denominator to this repo: `node` holds every repo's graph, so an
    # unscoped COUNT(*) silently divides by the whole database.
    total = _scalar(m.sql(
        cfg, token,
        "SELECT COUNT(*) AS n FROM node WHERE repo_id = %d" % int(cfg["repo_id"]),
    ))
    # No GROUP BY in SpacetimeDB SQL, and aggregates need an alias.
    explored = _scalar(m.sql(
        cfg, token,
        "SELECT COUNT(*) AS n FROM node_cov WHERE repo_id = %d AND explored = true"
        % int(cfg["repo_id"]),
    ))
    touches = _scalar(m.sql(
        cfg, token,
        "SELECT COUNT(*) AS n FROM touch WHERE repo_id = %d" % int(cfg["repo_id"]),
    ))
    if total is None:
        print("Could not reach %s/%s." % (cfg["host"], cfg["db"]))
        return 1
    if explored is None:
        print("%d nodes. Coverage tables are not deployed yet." % total)
        return 0
    pct = (100.0 * explored / total) if total else 0.0
    filled = int(round(pct / 5))
    print("Coverage (repo %s): %d of %d nodes explored (%.1f%%)"
          % (cfg["repo_id"], explored, total, pct))
    print("  [%s%s]" % ("#" * filled, "." * (20 - filled)))
    if touches is not None:
        print("  %d touches reported" % touches)
    return 0


def cmd_doctor(argv) -> int:
    cfg, token = _ctx()
    print("host        : %s" % cfg["host"])
    print("database    : %s" % cfg["db"])
    print("repo_id     : %s  (%s)" % (cfg.get("repo_id") or "UNBOUND -- reporting nothing",
                                       cfg.get("repo_id_source")))
    print("repo_slug   : %s" % (cfg.get("repo_slug") or "-"))
    print("git remote  : %s" % (m.git_remote_url(cfg["project_dir"]) or "-"))
    print("agent_name  : %s" % cfg["agent_name"])
    print("project_dir : %s" % cfg["project_dir"])
    print("token       : %s" % ("found (%d chars)" % len(token) if token else "MISSING -- run `spacetime login`"))
    node = _scalar(m.sql(cfg, token, "SELECT COUNT(*) AS n FROM node"))
    print("sql /node   : %s" % ("ok, %d rows" % node if node is not None else "unreachable"))
    for table in ("touch", "node_cov", "exploration_request", "agent_session"):
        n = _scalar(m.sql(cfg, token, "SELECT COUNT(*) AS n FROM %s" % table))
        print("sql /%-19s: %s" % (table, "%d rows" % n if n is not None else "not deployed / private"))
    return 0


def _scalar(rows):
    if not rows:
        return None
    row = rows[0]
    if not isinstance(row, dict) or not row:
        return None
    value = list(row.values())[0]
    try:
        return int(value)
    except Exception:
        return None


def _report(what: str, out) -> int:
    if out is None:
        print("%s (no response body)" % what)
        return 0
    text = str(out).strip()
    if text.startswith("HTTP ") or text.startswith("ERROR:"):
        print("FAILED to %s: %s" % (what, text), file=sys.stderr)
        return 1
    print(what)
    return 0


COMMANDS = {
    "report": cmd_report,
    "pending": cmd_pending,
    "claim": cmd_claim,
    "complete": cmd_complete,
    "coverage": cmd_coverage,
    "doctor": cmd_doctor,
    "index": cmd_index,
    "rebind": cmd_rebind,
}


def main() -> int:
    argv = [a for a in sys.argv[1:] if a != "--debug"]
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return 2
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main())
