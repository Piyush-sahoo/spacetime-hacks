"""Shared helpers for The Map Room Claude Code plugin.

Standard library only. No third-party dependencies, no install step.

Everything in here is defensive: if anything at all goes wrong we return a
neutral value rather than raising. Hooks run inside the user's session and must
never be able to break it.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import urllib.error
import urllib.request

DEFAULT_HOST = "https://maincloud.spacetimedb.com"
DEFAULT_DB = "map-room"
DEFAULT_REPO_ID = 1
DEFAULT_AGENT_NAME = "claude"

# Hooks are fire-and-forget. Two seconds is already generous.
CALL_TIMEOUT = 2.0
SQL_TIMEOUT = 2.5

_SSL_CTX = ssl.create_default_context()


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------

def _project_dir() -> str:
    for key in ("CLAUDE_PROJECT_DIR", "MAP_ROOM_PROJECT_DIR"):
        value = os.environ.get(key)
        if value and os.path.isdir(value):
            return os.path.abspath(value)
    return os.path.abspath(os.getcwd())


def load_config(cwd: str | None = None) -> dict:
    """Config resolution order: env vars > .map-room.json in the project > defaults."""
    cfg = {
        "host": DEFAULT_HOST,
        "db": DEFAULT_DB,
        "repo_id": DEFAULT_REPO_ID,
        "agent_name": DEFAULT_AGENT_NAME,
        "project_dir": os.path.abspath(cwd) if cwd and os.path.isdir(cwd) else _project_dir(),
    }

    try:
        path = os.path.join(cfg["project_dir"], ".map-room.json")
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                fromfile = json.load(fh)
            for key in ("host", "db", "repo_id", "agent_name"):
                if key in fromfile:
                    cfg[key] = fromfile[key]
    except Exception:
        pass

    env_map = {
        "host": "MAP_ROOM_HOST",
        "db": "MAP_ROOM_DB",
        "repo_id": "MAP_ROOM_REPO_ID",
        "agent_name": "MAP_ROOM_AGENT",
    }
    for key, env in env_map.items():
        value = os.environ.get(env)
        if value:
            cfg[key] = value

    try:
        cfg["repo_id"] = int(cfg["repo_id"])
    except Exception:
        cfg["repo_id"] = DEFAULT_REPO_ID

    cfg["host"] = str(cfg["host"]).rstrip("/")
    return cfg


_TOKEN_RE = re.compile(r'^\s*spacetimedb_token\s*=\s*"([^"]+)"', re.MULTILINE)


def read_token() -> str | None:
    """Read the SpacetimeDB bearer token from the CLI config (or the env)."""
    env = os.environ.get("MAP_ROOM_TOKEN") or os.environ.get("SPACETIMEDB_TOKEN")
    if env:
        return env.strip()

    candidates = [
        os.path.expanduser("~/.config/spacetime/cli.toml"),
        os.path.expanduser("~/Library/Application Support/spacetime/cli.toml"),
    ]
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                match = _TOKEN_RE.search(fh.read())
            if match:
                return match.group(1)
        except Exception:
            continue
    return None


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _post(url: str, body: bytes, content_type: str, token: str | None, timeout: float) -> str | None:
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", content_type)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:  # keep the body for --debug callers
        try:
            return "HTTP %s: %s" % (exc.code, exc.read().decode("utf-8", "replace"))
        except Exception:
            return "HTTP %s" % exc.code
    except Exception as exc:
        return "ERROR: %s" % exc


def call_reducer(cfg: dict, token: str | None, reducer: str, args: list) -> str | None:
    """POST a positional JSON array to /v1/database/<db>/call/<reducer>."""
    url = "%s/v1/database/%s/call/%s" % (cfg["host"], cfg["db"], reducer)
    body = json.dumps(args).encode("utf-8")
    return _post(url, body, "application/json", token, CALL_TIMEOUT)


def _u64(value) -> int:
    """SpacetimeDB u64 params must be JSON numbers. Strings are rejected with a
    400 ("invalid type: string, expected u64"), so coerce every id here."""
    try:
        return int(value)
    except Exception:
        return 0


def report_touch(cfg: dict, token: str | None, session: str, tool: str, paths: list):
    """Positional args for report_touch(repo_id: u64, session, agent_name, tool,
    paths_json). paths_json is a JSON array *string* -- double-encoded on purpose."""
    return call_reducer(cfg, token, "report_touch", [
        _u64(cfg["repo_id"]),
        str(session),
        str(cfg["agent_name"]),
        str(tool),
        json.dumps(list(paths)),
    ])


def sql(cfg: dict, token: str | None, query: str, timeout: float = SQL_TIMEOUT):
    """POST a raw SQL string to /v1/database/<db>/sql. Returns list[dict] or None.

    Note: SpacetimeDB SQL has no GROUP BY and requires aliases on aggregates.
    """
    url = "%s/v1/database/%s/sql" % (cfg["host"], cfg["db"])
    raw = _post(url, query.encode("utf-8"), "text/plain", token, timeout)
    if not raw or raw.startswith("ERROR:") or raw.startswith("HTTP "):
        return None
    try:
        payload = json.loads(raw)
    except Exception:
        return None
    return _flatten_sql(payload)


def _flatten_sql(payload) -> list:
    """Turn SpacetimeDB's {schema:{elements:[...]}, rows:[[...]]} into dicts."""
    out: list = []
    if not isinstance(payload, list):
        payload = [payload]
    for block in payload:
        if not isinstance(block, dict):
            continue
        elements = (block.get("schema") or {}).get("elements") or []
        names = []
        for el in elements:
            name = el.get("name")
            if isinstance(name, dict):
                name = name.get("some")
            names.append(name if isinstance(name, str) else "col%d" % len(names))
        for row in block.get("rows") or []:
            if isinstance(row, list):
                out.append({names[i] if i < len(names) else "col%d" % i: v for i, v in enumerate(row)})
            elif isinstance(row, dict):
                out.append(row)
    return out


# --------------------------------------------------------------------------
# path extraction
# --------------------------------------------------------------------------

SOURCE_SUFFIXES = (
    ".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".cs", ".go", ".java", ".rb",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".php", ".swift", ".kt", ".scala",
    ".md", ".json", ".toml", ".yaml", ".yml", ".html", ".css", ".sql", ".sh",
)

_MAX_PATHS = 40


def _looks_like_file(value: str) -> bool:
    if not value or not isinstance(value, str):
        return False
    if len(value) > 512 or "\n" in value:
        return False
    if any(ch in value for ch in "*?["):  # a glob pattern, not a file
        return False
    base = os.path.basename(value)
    return "." in base and base.rsplit(".", 1)[-1].isalnum()


def extract_paths(tool_name: str, tool_input, tool_response=None) -> list:
    """Pull concrete file paths out of a tool's input (and, for search tools,
    out of its response, since that is where the matched files live)."""
    found: list = []

    def add(value):
        if _looks_like_file(value) and value not in found:
            found.append(value)

    if isinstance(tool_input, dict):
        for key in ("file_path", "filePath", "path", "notebook_path", "notebookPath"):
            value = tool_input.get(key)
            if isinstance(value, str):
                add(value)
        # MultiEdit-style batched edits
        edits = tool_input.get("edits")
        if isinstance(edits, list):
            for edit in edits:
                if isinstance(edit, dict):
                    for key in ("file_path", "filePath", "path"):
                        if isinstance(edit.get(key), str):
                            add(edit[key])

    # Grep / Glob: the interesting paths are the ones that matched.
    if tool_name in ("Grep", "Glob") and tool_response is not None:
        for value in _response_paths(tool_response):
            add(value)

    return found[:_MAX_PATHS]


_PATHISH = re.compile(r"(?:^|\s)((?:/|\./|[\w.\-]+/)[\w./\-]+\.[A-Za-z0-9]{1,8})")


def _response_paths(tool_response) -> list:
    out: list = []
    try:
        if isinstance(tool_response, dict):
            for key in ("filenames", "files", "paths"):
                value = tool_response.get(key)
                if isinstance(value, list):
                    out.extend(v for v in value if isinstance(v, str))
            text = tool_response.get("content") or tool_response.get("stdout") or ""
        elif isinstance(tool_response, list):
            for item in tool_response:
                if isinstance(item, str):
                    out.append(item)
                elif isinstance(item, dict) and isinstance(item.get("text"), str):
                    out.extend(_scan_text(item["text"]))
            text = ""
        else:
            text = tool_response if isinstance(tool_response, str) else ""
        if text:
            out.extend(_scan_text(text))
    except Exception:
        return out[:_MAX_PATHS]
    return out[:_MAX_PATHS]


def _scan_text(text: str) -> list:
    out = []
    for line in text.splitlines()[:_MAX_PATHS * 3]:
        line = line.strip()
        if _looks_like_file(line) and ":" not in line:
            out.append(line)
            continue
        match = _PATHISH.search(line)
        if match:
            out.append(match.group(1))
    return out


def to_repo_relative(paths, project_dir: str) -> list:
    """Make every path relative to the project root, dropping anything outside it."""
    project_dir = os.path.abspath(project_dir)
    out: list = []
    for raw in paths:
        try:
            candidate = raw
            if not os.path.isabs(candidate):
                candidate = os.path.join(project_dir, candidate)
            candidate = os.path.abspath(candidate)
            if os.path.isdir(candidate):
                continue
            rel = os.path.relpath(candidate, project_dir)
            if rel.startswith(".."):
                continue
            rel = rel.replace(os.sep, "/")
            if rel and rel not in out:
                out.append(rel)
        except Exception:
            continue
    return out


# --------------------------------------------------------------------------
# the return path: what the human has asked for
# --------------------------------------------------------------------------

def _sql_escape(value: str) -> str:
    return str(value).replace("'", "''")


def heartbeat(cfg: dict, token: str | None, session: str):
    return call_reducer(
        cfg, token, "agent_heartbeat",
        [str(session), str(cfg["agent_name"]), _u64(cfg["repo_id"])],
    )


# --------------------------------------------------------------------------
# exploration requests — the return path
# --------------------------------------------------------------------------

def pending_requests(cfg: dict, token: str | None, limit: int = 50) -> list:
    """Every request the human has raised that no agent has claimed yet."""
    query = (
        "SELECT * FROM exploration_request "
        "WHERE status = 'pending' AND repo_id = %d" % int(cfg["repo_id"])
    )
    rows = sql(cfg, token, query) or []
    return rows[:limit]


def request_line(row: dict) -> str:
    """One-line human/agent readable rendering of an exploration_request row."""
    line = "  - request #%s  path: %s  node_id: %s" % (
        row.get("id", "?"),
        row.get("path") or "(unknown path)",
        row.get("node_id", "?"),
    )
    note = (row.get("note") or "").strip()
    if note:
        line += '  note: "%s"' % note[:200]
    status = row.get("status")
    if status and status != "pending":
        line += "  [%s]" % status
    return line


def claim_request(cfg: dict, token: str | None, request_id, agent_name: str | None = None):
    # request_id is u64: it must cross the wire as a JSON number. A string is
    # rejected with 400 "invalid type: string, expected u64".
    args = [_u64(request_id), str(agent_name or cfg["agent_name"])]
    return call_reducer(cfg, token, "claim_request", args)


def complete_request(cfg: dict, token: str | None, request_id, result: str):
    args = [_u64(request_id), str(result)]
    return call_reducer(cfg, token, "complete_request", args)
