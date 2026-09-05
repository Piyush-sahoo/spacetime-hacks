#!/usr/bin/env python3
"""PostToolUse hook — report what the agent just touched to The Map Room.

Matched against Read|Edit|Write|Grep|Glob. Reads the hook payload on stdin,
pulls file paths out of it, makes them repo-relative and POSTs them to the
`report_touch` reducer.

Contract, absolutely non-negotiable: this must never block the agent's turn and
must never fail it. The network call happens in a detached child process; the
parent exits 0 within milliseconds. Every error is swallowed.

Run with --debug to do it synchronously and print what happened.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEBUG = "--debug" in sys.argv


def log(msg: str) -> None:
    if DEBUG:
        print(msg, file=sys.stderr)


def main() -> int:
    try:
        raw = sys.stdin.read()
    except Exception:
        return 0
    if not raw.strip():
        return 0

    try:
        payload = json.loads(raw)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0

    import map_room

    tool_name = payload.get("tool_name") or payload.get("toolName") or ""
    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
    # The documented PostToolUse field is `tool_response`; the other spellings
    # are accepted defensively so the hook cannot go blind on a variant payload.
    tool_response = (
        payload.get("tool_response")
        or payload.get("tool_result")
        or payload.get("toolResponse")
    )
    session = payload.get("session_id") or payload.get("sessionId") or "unknown-session"
    cwd = payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR")

    if not tool_name:
        return 0

    cfg = map_room.load_config(cwd)
    log("tool=%s session=%s project=%s" % (tool_name, session, cfg["project_dir"]))

    try:
        paths = map_room.extract_paths(tool_name, tool_input, tool_response)
        paths = map_room.to_repo_relative(paths, cfg["project_dir"])
    except Exception as exc:
        log("extract failed: %s" % exc)
        return 0

    log("paths=%r" % (paths,))
    if not paths:
        return 0

    token = map_room.read_token()

    if DEBUG:
        print(map_room.report_touch(cfg, token, session, tool_name, paths))
        return 0

    _fire_and_forget(map_room, cfg, token, session, tool_name, paths)
    return 0


def _fire_and_forget(map_room, cfg, token, session, tool_name, paths) -> None:
    """Detach so the agent's turn is never waiting on the network."""
    try:
        pid = os.fork()
    except Exception:
        # No fork on this platform: fall back to a bounded blocking call.
        try:
            map_room.report_touch(cfg, token, session, tool_name, paths)
        except Exception:
            pass
        return

    if pid > 0:
        return  # parent: done, instantly

    # child
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
        map_room.report_touch(cfg, token, session, tool_name, paths)
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
