#!/usr/bin/env python3
"""SessionEnd hook — put this session's lamps out.

Why this exists
---------------
Nothing in the module ever wrote `online: false` on an agent row. `bumpSession`
only ever writes `true`, and `identity_disconnected` speaks only for
`participant`, because a Claude Code hook is a plain HTTP caller with no
persistent connection for the database to notice dropping. So an agent stayed
lit forever, and the map painted actor colour for somebody who had gone home.

This hook is the missing edge. It calls `end_session(session)`, which clears
`online` on the session's own row AND on every subagent row keyed
`<session>/<actor>` beneath it.

Hook API
--------
`SessionEnd` is a real event (https://code.claude.com/docs/en/hooks) and is
declarable in a plugin's `hooks/hooks.json`. Its matcher values are `clear`,
`resume`, `logout`, `prompt_input_exit`, `other`; we register with no matcher so
every kind of ending counts. The only stdin field this hook needs is
`session_id`, which is a common field present on every hook event, so nothing
here depends on an undocumented event-specific shape.

SessionEnd hooks share a ~1.5s budget, raised to the configured per-hook
timeout. `hooks.json` asks for 3s and the HTTP call is capped at 2s, so the
worst case is bounded well inside it. Output is irrelevant at session end, so
nothing is printed. Garbage or empty stdin exits 0. Every error is swallowed:
a broken hook must never be the last thing a person sees.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEBUG = "--debug" in sys.argv


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0
    if not isinstance(payload, dict):
        payload = {}

    import map_room

    session = payload.get("session_id") or payload.get("sessionId") or ""
    if not session or session == "unknown-session":
        return 0

    cwd = payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR")
    cfg = map_room.load_config(cwd)
    token = map_room.read_token()

    # Cache-only: at session end there is no reason to pay for git or a lookup.
    # An unbound checkout has no agent row to switch off in the first place.
    map_room.bind_repo(cfg, token, allow_network=False)
    if not cfg.get("repo_id") and not cfg.get("repo_slug"):
        # `end_session` is keyed on the session string alone and does not need a
        # repo, so a deferred binding is not a reason to skip it. Only a truly
        # unknown checkout is.
        if cfg.get("repo_id_source") not in ("deferred", "config"):
            return 0

    result = map_room.end_session(cfg, token, str(session))
    if DEBUG:
        print("end_session(%s) -> %s" % (session, result))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
