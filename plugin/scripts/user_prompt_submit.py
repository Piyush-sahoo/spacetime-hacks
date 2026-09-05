#!/usr/bin/env python3
"""UserPromptSubmit hook — inject the human's pending exploration requests.

Queries `exploration_request` for rows still in status "pending" and, only if
there are any, injects them into the agent's context via
`hookSpecificOutput.additionalContext`.

Also sends a fire-and-forget `agent_heartbeat` so the agent shows up live in
The Map Room's presence rail.

Silence is the correct output when nothing is pending. Failure is silent too:
this hook must never block or reject the user's prompt.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MAX_REQUESTS = 12


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0
    if not isinstance(payload, dict):
        payload = {}

    import map_room

    session = payload.get("session_id") or payload.get("sessionId") or "unknown-session"
    cwd = payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR")
    cfg = map_room.load_config(cwd)
    token = map_room.read_token()

    _heartbeat(map_room, cfg, token, session)

    query = (
        "SELECT * FROM exploration_request "
        "WHERE status = 'pending' AND repo_id = %d" % cfg["repo_id"]
    )
    rows = map_room.sql(cfg, token, query)
    if not rows:
        return 0

    context = _render(rows[:MAX_REQUESTS], cfg)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }))
    return 0


def _render(rows: list, cfg: dict) -> str:
    import map_room

    lines = [
        "[The Map Room] The human watching the coverage map has asked you to "
        "explore these regions:",
        "",
    ]
    for row in rows:
        lines.append(map_room.request_line(row))
    lines += [
        "",
        "Each one is a dark region on a shared map that a human clicked because "
        "nobody has looked there yet. Use the `map-room` skill: claim the "
        "request, send a subagent scoped to that path, then complete the request "
        "with what it found.",
        "If the user's own message is clearly about something else, do that first "
        "and tell them these requests are waiting.",
    ]
    return "\n".join(lines)


def _heartbeat(map_room, cfg, token, session) -> None:
    """Announce the agent as online. Detached so the prompt is never delayed."""
    try:
        pid = os.fork()
    except Exception:
        return
    if pid > 0:
        return
    try:
        os.setsid()
    except Exception:
        pass
    try:
        devnull = os.open(os.devnull, os.O_RDWR)
        os.dup2(devnull, 0)
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
    except Exception:
        pass
    try:
        # map_room.heartbeat coerces repo_id to a JSON number; the reducer
        # rejects a string u64 with a 400.
        map_room.heartbeat(cfg, token, session)
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
