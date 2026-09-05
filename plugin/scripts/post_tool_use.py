#!/usr/bin/env python3
"""PostToolUse hook — report what the agent just touched to The Map Room.

Matched against Read|Edit|Write|Grep|Glob|Bash. Reads the hook payload on
stdin, pulls file paths out of it (for Bash, out of the command string), makes
them repo-relative and POSTs them to the `report_touch_timed` reducer, along
with how long the tool call took.

Contract, absolutely non-negotiable: this must never block the agent's turn and
must never fail it. The network call happens in a detached child process; the
parent exits 0 within milliseconds. Every error is swallowed.

Repo binding is part of that contract. The parent only ever consults the local
binding cache -- it never runs git or HTTP itself. On a cache miss it hands the
whole job (resolve, then report) to the detached child, so the very first tool
call in a fresh checkout is neither lost nor slow. If the checkout has no
origin remote, or its remote is not indexed, nothing is reported at all.

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


def _first_int(d, keys) -> int:
    """First key in `keys` that holds a non-negative int-ish value, else 0."""
    if not isinstance(d, dict):
        return 0
    for k in keys:
        v = d.get(k)
        if v is None or isinstance(v, bool):
            continue
        try:
            n = int(v)
        except Exception:
            continue
        if n >= 0:
            return n
    return 0


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

    # How long the tool call itself took, and which call it was. Both are in the
    # payload and both used to be thrown away. They ride to a NEW reducer into a
    # NEW side table: `touch` is populated and its shape is frozen, so adding a
    # column to it would force a destructive republish of ten loaded graphs.
    # Every plausible spelling is read, and a payload that carries none of them
    # simply reports as before -- 0 means "not known", never "instant".
    duration_ms = _first_int(payload, ("duration_ms", "durationMs", "duration"))
    if duration_ms == 0 and isinstance(tool_response, dict):
        duration_ms = _first_int(tool_response, ("duration_ms", "durationMs", "duration"))
    tool_use_id = str(
        payload.get("tool_use_id")
        or payload.get("toolUseId")
        or payload.get("tool_use_ID")
        or ""
    )[:64]

    if not tool_name:
        return 0

    cfg = map_room.load_config(cwd)

    # WHICH agent this was. Subagents INHERIT the parent's session_id, so the
    # session cannot tell them apart — but `agent_id` is present ONLY for a
    # subagent. Carry it inside `agent_name` (`claude` vs `claude/<actor>`) so
    # the map can colour each agent separately without changing report_touch's
    # signature, which would have broken every already-installed plugin.
    agent_id = payload.get("agent_id") or payload.get("agentId") or ""
    agent_type = payload.get("agent_type") or payload.get("agentType") or ""
    if agent_id:
        actor = str(agent_id)[:8]
        if agent_type:
            actor = "%s~%s" % (str(agent_type)[:24], actor)
        cfg["agent_name"] = "%s/%s" % (cfg["agent_name"], actor)

    log("tool=%s session=%s agent=%s project=%s"
        % (tool_name, session, cfg["agent_name"], cfg["project_dir"]))

    try:
        paths = map_room.extract_paths(
            tool_name, tool_input, tool_response, cfg["project_dir"],
        )
        paths = map_room.to_repo_relative(paths, cfg["project_dir"])
    except Exception as exc:
        log("extract failed: %s" % exc)
        return 0

    log("paths=%r" % (paths,))
    if not paths:
        return 0

    token = map_room.read_token()

    # Cache-only in the parent: no git subprocess, no HTTP, no latency.
    map_room.bind_repo(cfg, token, allow_network=DEBUG)
    log("repo_id=%s slug=%s source=%s" % (
        cfg.get("repo_id"), cfg.get("repo_slug"), cfg.get("repo_id_source")))

    if not cfg.get("repo_id") and cfg.get("repo_id_source") != "deferred":
        # Known-unbound: no remote, or a remote nobody has indexed. Say so once
        # per session and then be completely silent.
        _hint(map_room, cfg, session)
        return 0

    log("duration_ms=%s tool_use_id=%s" % (duration_ms, tool_use_id))

    if DEBUG:
        print(map_room.report_touch_timed(
            cfg, token, session, tool_name, paths, duration_ms, tool_use_id))
        return 0

    _fire_and_forget(
        map_room, cfg, token, session, tool_name, paths, duration_ms, tool_use_id)
    return 0


def _hint(map_room, cfg, session) -> None:
    """One line, once per session, telling the user how to get a map."""
    text = map_room.index_hint(cfg, os.path.dirname(os.path.abspath(__file__)))
    if not text:
        return
    if not map_room.once("index-hint", "%s-%s" % (session, cfg.get("repo_slug"))):
        return
    log(text)
    if not DEBUG:
        print(json.dumps({"systemMessage": text, "suppressOutput": True}))


def _fire_and_forget(map_room, cfg, token, session, tool_name, paths,
                    duration_ms=0, tool_use_id="") -> None:
    """Detach so the agent's turn is never waiting on the network."""
    try:
        pid = os.fork()
    except Exception:
        # No fork on this platform: fall back to a bounded blocking call.
        try:
            map_room.report_touch_timed(
                cfg, token, session, tool_name, paths, duration_ms, tool_use_id)
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
        _resolve_and_report(
            map_room, cfg, token, session, tool_name, paths,
            duration_ms, tool_use_id)
    except Exception:
        pass
    os._exit(0)


def _resolve_and_report(map_room, cfg, token, session, tool_name, paths,
                        duration_ms=0, tool_use_id="") -> None:
    """Runs detached. Free to hit git and the network; nothing waits on it."""
    if not cfg.get("repo_id"):
        map_room.bind_repo(cfg, token, allow_network=True)
    if not cfg.get("repo_id"):
        _autoindex(map_room, cfg, token)
    if cfg.get("repo_id"):
        map_room.report_touch_timed(
            cfg, token, session, tool_name, paths, duration_ms, tool_use_id)


def _autoindex(map_room, cfg, token) -> None:
    """Opt-in (MAP_ROOM_AUTOINDEX=1). Builds the map for an un-indexed remote,
    once per slug, from inside the detached child. Off by default: indexing is
    a ~3 second write of a whole new repo graph into a shared database, and
    that should be a decision, not a side effect of opening a folder."""
    slug = cfg.get("repo_slug")
    if not (cfg.get("autoindex") and slug and cfg.get("repo_id_source") == "not-indexed"):
        return
    if not map_room.once("autoindex", slug):
        return
    map_room.index_repo(cfg, token, slug)
    map_room.clear_bind_cache(cfg.get("project_dir"))
    map_room.bind_repo(cfg, token, allow_network=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
