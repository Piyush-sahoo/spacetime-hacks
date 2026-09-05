#!/usr/bin/env python3
"""Hand-operated side of The Map Room plugin — what the skill drives.

    map_room_cli.py pending
    map_room_cli.py claim <request_id> [agent_name]
    map_room_cli.py complete <request_id> "findings"
    map_room_cli.py coverage
    map_room_cli.py doctor

Unlike the hooks, this one is allowed to be loud: it is invoked deliberately and
its output is meant to be read.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import map_room as m  # noqa: E402


def _ctx():
    cfg = m.load_config()
    return cfg, m.read_token()


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
        print('usage: map_room_cli.py complete <request_id> "findings"', file=sys.stderr)
        return 2
    cfg, token = _ctx()
    result = " ".join(argv[1:])[:4000]
    out = m.complete_request(cfg, token, argv[0], result)
    return _report("completed request #%s" % argv[0], out)


def cmd_coverage(argv) -> int:
    cfg, token = _ctx()
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
    print("repo_id     : %s" % cfg["repo_id"])
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
    "pending": cmd_pending,
    "claim": cmd_claim,
    "complete": cmd_complete,
    "coverage": cmd_coverage,
    "doctor": cmd_doctor,
}


def main() -> int:
    argv = [a for a in sys.argv[1:] if a != "--debug"]
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return 2
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main())
