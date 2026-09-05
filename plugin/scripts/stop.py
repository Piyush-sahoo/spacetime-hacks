#!/usr/bin/env python3
"""Stop hook — close the idle gap.

The `UserPromptSubmit` hook only delivers the human's exploration requests when
the human types something. So a click that lands while the agent is finishing a
task waits for the next prompt, and a click that lands after the agent has gone
idle is never seen at all.

This hook fires when the agent finishes a turn. If the human has clicked a dark
region and nothing has picked it up yet, it feeds the request back into the
conversation so the agent continues into the exploration on its own -- no human
keystroke required -- and rings the terminal bell so a person watching the
terminal knows a click landed.

Verified contract (Claude Code 2.1.x)
------------------------------------
stdin:  { "session_id", "transcript_path", "cwd", "permission_mode",
          "hook_event_name": "Stop",
          "stop_hook_active": bool,
          "last_assistant_message": str | null, ... }

stdout: { "systemMessage": str,          # line shown to the human
          "terminalSequence": str,       # BEL / notification OSC, emitted for us
          "hookSpecificOutput": {
              "hookEventName": "Stop",
              "additionalContext": str   # non-error feedback; the conversation
          } }                            # continues so the model can act on it

`additionalContext` is deliberately used instead of `decision: "block"`.
Blocking routes through the stop-hook *error* path: it shows the user a "Stop
hook error occurred" notification and counts against
CLAUDE_CODE_STOP_HOOK_BLOCK_CAP. `additionalContext` is the non-error
continuation path and produces neither.

Not looping, in three layers
----------------------------
1. `stop_hook_active` is true whenever this Stop is ending a turn that a Stop
   hook itself continued. We exit 0 immediately, no output. This alone makes an
   unbounded loop impossible: every continuation we cause is followed by a stop
   we refuse to act on.
2. Each request id is nudged at most once per session (a small local marker
   file). Two consecutive stops never push the same request twice.
3. Only `status = 'pending'` rows are ever considered. Anything claimed or done
   is invisible here.

Same fire-and-forget discipline as the other two hooks: short timeouts, every
error swallowed, always exit 0. A dead network or a dead database makes this
hook silent, never slow and never fatal.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# At most this many requests are pushed in one stop. Keeps the injected block
# readable and the SQL round trip bounded.
MAX_REQUESTS = 6

# Marker files older than this are swept on write, so the state dir cannot grow
# without bound across sessions.
MARKER_TTL_SECONDS = 7 * 24 * 60 * 60

BEL = "\a"


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0
    if not isinstance(payload, dict):
        payload = {}

    # ---- guard 1: never continue a turn we already continued ----------------
    # Accept both spellings defensively; the documented field is snake_case.
    if payload.get("stop_hook_active") or payload.get("stopHookActive"):
        return 0

    import map_room

    session = payload.get("session_id") or payload.get("sessionId") or "unknown-session"
    cwd = payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR")
    cfg = map_room.load_config(cwd)
    token = map_room.read_token()

    # An unbound checkout has no map, so it can have no requests. Cached, so
    # this costs a stat in the normal case.
    map_room.bind_repo(cfg, token, allow_network=True)
    if not cfg.get("repo_id"):
        return 0

    # ---- guard 3: only genuinely pending rows -------------------------------
    try:
        rows = map_room.pending_requests(cfg, token, limit=MAX_REQUESTS * 4) or []
    except Exception:
        return 0
    if not rows:
        return 0  # the common case: completely invisible

    # ---- guard 2: one nudge per request per session -------------------------
    seen = _load_seen(session)
    fresh = []
    for row in rows:
        rid = str(row.get("id", ""))
        if rid and rid not in seen:
            fresh.append(row)
        if len(fresh) >= MAX_REQUESTS:
            break
    if not fresh:
        return 0

    _save_seen(session, seen | {str(r.get("id", "")) for r in fresh})

    print(json.dumps({
        "systemMessage": _system_message(fresh),
        "terminalSequence": BEL,
        "suppressOutput": True,
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "additionalContext": _render(fresh),
        },
    }))
    return 0


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

def _system_message(rows: list) -> str:
    """The line a human watching the terminal sees, prefixed with a bell.

    The bell is also requested through `terminalSequence`, which is the
    harness-native path (BEL is on its allowlist). It is repeated here so the
    notification still carries an audible cue on a client that ignores the
    field. Nothing is written to /dev/tty directly -- raw bytes would smear the
    running TUI.
    """
    if len(rows) == 1:
        row = rows[0]
        where = row.get("path") or "a region"
        return "%s[The Map Room] Someone clicked %s on the map. Exploring it now." % (BEL, where)
    return "%s[The Map Room] Someone clicked %d regions on the map. Exploring them now." % (
        BEL, len(rows),
    )


def _render(rows: list) -> str:
    import map_room

    lines = [
        "[The Map Room] You have finished your turn, and while you were working "
        "the human watching the coverage map clicked "
        + ("a dark region" if len(rows) == 1 else "%d dark regions" % len(rows))
        + ". Nobody has picked "
        + ("it" if len(rows) == 1 else "them")
        + " up yet:",
        "",
    ]
    for row in rows:
        lines.append(map_room.request_line(row))
    lines += [
        "",
        "There is no new user message behind this -- the click itself is the "
        "request, and it arrived after you stopped. Handle it now with the "
        "`map-room` skill: claim the request, send a subagent scoped to that "
        "path, then complete the request with what it found.",
        "",
        "Then stop and summarise what you found. Do not go looking for more work "
        "afterwards: any request still open will reach you again.",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# per-session nudge markers
# --------------------------------------------------------------------------

def _state_dir() -> str | None:
    base = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.expanduser("~/.claude")
    path = os.path.join(base, "map-room", "stop-seen")
    try:
        os.makedirs(path, exist_ok=True)
        return path
    except Exception:
        return None


def _marker_path(session: str) -> str | None:
    directory = _state_dir()
    if not directory:
        return None
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(session))[:120]
    return os.path.join(directory, "%s.json" % (safe or "unknown"))


def _load_seen(session: str) -> set:
    path = _marker_path(session)
    if not path:
        return set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return {str(x) for x in data} if isinstance(data, list) else set()
    except Exception:
        return set()


def _save_seen(session: str, ids: set) -> None:
    path = _marker_path(session)
    if not path:
        return
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(sorted(ids), fh)
    except Exception:
        pass
    _sweep(os.path.dirname(path))


def _sweep(directory: str) -> None:
    """Drop markers from long-dead sessions. Best effort, never fatal."""
    try:
        cutoff = time.time() - MARKER_TTL_SECONDS
        for name in os.listdir(directory)[:500]:
            full = os.path.join(directory, name)
            try:
                if os.path.isfile(full) and os.path.getmtime(full) < cutoff:
                    os.remove(full)
            except Exception:
                continue
    except Exception:
        pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        # Never let a Stop hook fail a turn.
        sys.exit(0)
