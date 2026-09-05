#!/usr/bin/env python3
"""SubagentStop hook — put ONE subagent's lamp out, leaving the parent lit.

A subagent inherits the parent's `session_id`; what distinguishes it is the
`agent_id` the payload carries only for a subagent. The module files a
subagent's presence under the composite key `<session>/<actor>`, where actor is
`<agent_type>~<agent_id[:8]>` when the type is known and `<agent_id[:8]>` when
it is not — exactly the string `post_tool_use.py` builds. This hook rebuilds
the same key and ends just that row, so a finished subagent goes dark while the
main agent, which is still working, stays lit.

`SubagentStop` is a real event (https://code.claude.com/docs/en/hooks) and is
declarable in a plugin's `hooks/hooks.json`; its matcher is the agent type.
`agent_id` / `agent_type` are documented as common fields present "if in
subagent". If neither is present we do NOTHING rather than guess — ending the
bare `session_id` here would switch off the main agent every time a subagent
finished, which is worse than a lamp left on. `SessionEnd` sweeps the whole tree
anyway, so nothing leaks permanently.

Fire-and-forget with the same discipline as every other hook: ~2s HTTP cap,
errors swallowed, exit 0 on garbage or empty stdin, nothing printed.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEBUG = "--debug" in sys.argv


def actor_key(payload: dict) -> str:
    """`<agent_type>~<agent_id[:8]>`, or `<agent_id[:8]>`, or ''.

    Kept byte-identical to the construction in `post_tool_use.py`; if the two
    ever disagree this hook silently ends a row that does not exist.
    """
    agent_id = payload.get("agent_id") or payload.get("agentId") or ""
    agent_type = payload.get("agent_type") or payload.get("agentType") or ""
    if not agent_id:
        return ""
    actor = str(agent_id)[:8]
    if agent_type:
        actor = "%s~%s" % (str(agent_type)[:24], actor)
    return actor


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

    actor = actor_key(payload)
    if not actor:
        # Not identifiable as a subagent. Ending the bare session here would
        # darken the main agent, so we stop.
        if DEBUG:
            print("no agent_id in payload; nothing to end")
        return 0

    cwd = payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR")
    cfg = map_room.load_config(cwd)
    token = map_room.read_token()

    result = map_room.end_session(cfg, token, "%s/%s" % (session, actor))
    if DEBUG:
        print("end_session(%s/%s) -> %s" % (session, actor, result))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
