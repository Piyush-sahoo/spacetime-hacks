#!/usr/bin/env python3
"""One hook body for every agent that is not Claude Code.

Codex and Cursor both run hooks the same way Claude Code does — a command, a
JSON object on stdin — they just spell the payload differently. Rather than
maintain a script per tool, this normalises whatever arrives and hands it to
the transport that already exists.

    Codex   .codex/hooks.json   PostToolUse
            {"session_id", "cwd", "tool_name", "tool_input": {...}}

    Cursor  .cursor/hooks.json  afterFileEdit / beforeReadFile /
                                afterShellExecution / postToolUse
            {"conversation_id", "workspace_roots", "file_path", "edits": [...]}
            {"conversation_id", "command", "cwd"}

Contract, same as the Claude Code hook and just as non-negotiable:

  * exit 0, always, on every path — a broken Map Room must never break a turn;
  * write NOTHING to stdout. Cursor parses a hook's stdout as a permission
    decision, and this script has no business allowing or denying anything.
    Silence leaves the tool call exactly as it was;
  * do the network call in a detached child, so the turn never waits on it.

Run with --debug to do it synchronously and print what it worked out.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEBUG = "--debug" in sys.argv

# Whatever each tool calls "run a shell command" or "apply a patch". All of it
# is a command string, so all of it goes through the Bash path — the parser
# that drops any token it is not sure about and checks the file exists on disk.
_SHELLISH = frozenset((
    "bash", "shell", "local_shell", "exec_command", "run_terminal_cmd",
    "terminal", "apply_patch", "applypatch", "patch", "shellcommand",
))

# Tool names that mean the same thing in different tools, mapped onto the names
# the map already stores so one repo's history does not fragment by vendor.
_ALIASES = {
    "read": "Read", "read_file": "Read", "readfile": "Read", "view": "Read",
    "edit": "Edit", "edit_file": "Edit", "str_replace": "Edit",
    "write": "Write", "write_file": "Write", "create": "Write",
    "grep": "Grep", "search": "Grep", "ripgrep": "Grep", "codebase_search": "Grep",
    "glob": "Glob", "list_dir": "Glob", "file_search": "Glob",
}


def log(msg: str) -> None:
    if DEBUG:
        print(msg, file=sys.stderr)


def _first(payload: dict, *keys):
    for key in keys:
        value = payload.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _cwd(payload: dict):
    """Where the repository is. Cursor sends a list of workspace roots."""
    value = _first(payload, "cwd", "workspace_root", "directory", "worktree")
    if isinstance(value, str):
        return value
    roots = payload.get("workspace_roots")
    if isinstance(roots, list) and roots and isinstance(roots[0], str):
        return roots[0]
    return os.environ.get("MAP_ROOM_PROJECT_DIR") or os.getcwd()


def _tool_and_input(payload: dict):
    """(tool_name, tool_input) out of any of the three payload dialects."""
    raw = str(_first(payload, "tool_name", "toolName", "tool") or "")
    tool_input = _first(payload, "tool_input", "toolInput", "arguments", "args")
    if not isinstance(tool_input, dict):
        tool_input = {}

    # Cursor's file and shell hooks put the interesting field at the top level
    # and never send a tool name at all.
    if not tool_input:
        flat = {}
        for key in ("file_path", "filePath", "path", "command", "edits"):
            if key in payload:
                flat[key] = payload[key]
        if flat:
            tool_input = flat
            if not raw:
                raw = "Bash" if "command" in flat else (
                    "Edit" if "edits" in flat else "Read")

    lowered = raw.lower()
    if lowered in _SHELLISH or (not raw and "command" in tool_input):
        return "Bash", tool_input
    if lowered in _ALIASES:
        return _ALIASES[lowered], tool_input
    return raw or "Read", tool_input


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

    tool_name, tool_input = _tool_and_input(payload)
    session = str(_first(
        payload, "session_id", "sessionId", "sessionID",
        "conversation_id", "conversationId", "thread-id", "thread_id",
    ) or "unknown-session")
    cwd = _cwd(payload)

    cfg = map_room.load_config(cwd)
    log("event=%s tool=%s session=%s project=%s"
        % (payload.get("hook_event_name"), tool_name, session, cfg["project_dir"]))

    try:
        paths = map_room.extract_paths(tool_name, tool_input, None, cfg["project_dir"])
        paths = map_room.to_repo_relative(paths, cfg["project_dir"])
    except Exception as exc:
        log("extract failed: %s" % exc)
        return 0

    log("paths=%r" % (paths,))
    if not paths:
        return 0

    token = map_room.read_token()
    map_room.bind_repo(cfg, token, allow_network=DEBUG)
    log("repo_id=%s slug=%s source=%s"
        % (cfg.get("repo_id"), cfg.get("repo_slug"), cfg.get("repo_id_source")))

    if not cfg.get("repo_id") and cfg.get("repo_id_source") != "deferred":
        # No remote, or a remote nobody has indexed. Report nothing, on purpose.
        return 0

    if DEBUG:
        print(map_room.report_touch(cfg, token, session, tool_name, paths),
              file=sys.stderr)
        return 0

    _detach(map_room, cfg, token, session, tool_name, paths)
    return 0


def _detach(map_room, cfg, token, session, tool_name, paths) -> None:
    try:
        pid = os.fork()
    except Exception:
        try:
            if not cfg.get("repo_id"):
                map_room.bind_repo(cfg, token, allow_network=True)
            if cfg.get("repo_id"):
                map_room.report_touch(cfg, token, session, tool_name, paths)
        except Exception:
            pass
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
        if not cfg.get("repo_id"):
            map_room.bind_repo(cfg, token, allow_network=True)
        if cfg.get("repo_id"):
            map_room.report_touch(cfg, token, session, tool_name, paths)
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    # Never anything but 0, and never anything on stdout.
    sys.exit(0)
