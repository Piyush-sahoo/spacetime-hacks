#!/usr/bin/env python3
"""UserPromptSubmit hook — the session link, and the human's exploration requests.

Three jobs, in one pass, because this is the only hook that already runs
synchronously on every prompt:

1. On the FIRST prompt of a session, print the link that shows this session and
   nothing else, so it lands in the terminal where the person can click it. The
   URL needs no new data: `session_id` is already written into every `touch` row
   and into `agent_session.session`, so `?repo=<slug>&session=<id>` is
   derivable the moment the session has an id.
2. Send a fire-and-forget `agent_heartbeat` so the agent shows up live in the
   presence rail.
3. Inject the human's still-pending exploration requests into the agent's
   context via `hookSpecificOutput.additionalContext`.

Everything is conditional on the repo being BOUND. There is deliberately no
default repo id, so an unbound checkout prints nothing, links to nothing and
reports nothing -- it is not on anybody's map and must not be told it is.

At most one JSON object may be printed, so the three jobs share one payload.
Silence is the correct output when there is nothing to say. Failure is silent
too: this hook must never block or reject the user's prompt.
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

    # This hook is already synchronous, so it is the right place to do the
    # (cached) repo binding for the session. An unbound checkout gets no
    # heartbeat and no query -- it is not on anybody's map.
    map_room.bind_repo(cfg, token, allow_network=True)
    if not cfg.get("repo_id"):
        _hint(map_room, cfg, session)
        return 0

    _heartbeat(map_room, cfg, token, session)

    out: dict = {}
    context: list = []

    # ---- 1. the session link, once ----------------------------------------
    link = _session_link_once(map_room, cfg, session)
    if link:
        out["systemMessage"] = "[The Map Room] this session: %s" % link
        # `systemMessage` is what puts the line in the terminal. The same link
        # also goes to the model, in one line, so that when the person asks
        # "where do I watch this?" the answer is already in context instead of
        # being a guess.
        context.append(
            "[The Map Room] This session is being drawn live at %s -- that link "
            "shows only this session's route. Drop the `&session=` part to see "
            "everything every agent has ever explored in this repo. Give the "
            "person the link if they ask where to watch." % link
        )

    # ---- 3. the human's pending requests ----------------------------------
    query = (
        "SELECT * FROM exploration_request "
        "WHERE status = 'pending' AND repo_id = %d" % cfg["repo_id"]
    )
    rows = map_room.sql(cfg, token, query)
    if rows:
        context.append(_render(rows[:MAX_REQUESTS], cfg))

    if context:
        out["hookSpecificOutput"] = {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n\n".join(context),
        }

    if out:
        print(json.dumps(out))
    return 0


def _session_link_once(map_room, cfg, session) -> str | None:
    """The per-session link, at most once per session.

    Same one-shot marker mechanism the un-indexed hint already uses, keyed on
    the session id -- so this is one line on the first prompt, not a line on
    every prompt.
    """
    link = map_room.session_link(cfg, session)
    if not link:
        return None
    if not map_room.once("session-link", str(session)):
        return None
    return link


def _hint(map_room, cfg, session) -> None:
    """Tell the user once, per session, that this repo has no map yet."""
    text = map_room.index_hint(cfg, os.path.dirname(os.path.abspath(__file__)))
    if not text:
        return
    if not map_room.once("index-hint", "%s-%s" % (session, cfg.get("repo_slug"))):
        return
    print(json.dumps({"systemMessage": text, "suppressOutput": True}))


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
