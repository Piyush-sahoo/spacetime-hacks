"""Shared helpers for The Map Room Claude Code plugin.

Standard library only. No third-party dependencies, no install step.

Everything in here is defensive: if anything at all goes wrong we return a
neutral value rather than raising. Hooks run inside the user's session and must
never be able to break it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_HOST = "https://maincloud.spacetimedb.com"
DEFAULT_DB = "map-room"
# Where the map is watched. Overridable so a fork or a local `vite dev` prints
# its own links instead of the hosted ones.
DEFAULT_SITE = "https://map-room-beta.vercel.app"
# There is deliberately NO default repo id. An unbound checkout reports nothing
# rather than dumping its file reads onto somebody else's map.
DEFAULT_REPO_ID = None
DEFAULT_AGENT_NAME = "claude"

# Hooks are fire-and-forget. Two seconds is already generous.
CALL_TIMEOUT = 2.0
SQL_TIMEOUT = 2.5
GIT_TIMEOUT = 1.5
INDEX_TIMEOUT = 25.0

# How long a resolved binding is trusted before we look again. A hit basically
# never changes; a miss is re-checked often enough that indexing the repo takes
# effect within minutes.
BIND_TTL_HIT = 7 * 24 * 60 * 60
BIND_TTL_MISS = 10 * 60

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
    """Config resolution order: env vars > .map-room.json in the project > defaults.

    `repo_id` is the one key with no default. It is either pinned explicitly
    here (MAP_ROOM_REPO_ID / "repo_id") or derived from the git remote by
    `bind_repo()`. Unresolved means "report nothing" -- never "report to 1".
    """
    cfg = {
        "host": DEFAULT_HOST,
        "db": DEFAULT_DB,
        "repo_id": DEFAULT_REPO_ID,
        "repo_slug": None,
        "repo_id_source": "unset",
        "repo_bind_cached": False,
        "autoindex": False,
        "agent_name": DEFAULT_AGENT_NAME,
        "project_dir": os.path.abspath(cwd) if cwd and os.path.isdir(cwd) else _project_dir(),
    }

    try:
        path = os.path.join(cfg["project_dir"], ".map-room.json")
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                fromfile = json.load(fh)
            for key in ("host", "db", "repo_id", "agent_name", "autoindex"):
                if key in fromfile:
                    cfg[key] = fromfile[key]
    except Exception:
        pass

    env_map = {
        "host": "MAP_ROOM_HOST",
        "db": "MAP_ROOM_DB",
        "repo_id": "MAP_ROOM_REPO_ID",
        "agent_name": "MAP_ROOM_AGENT",
        "autoindex": "MAP_ROOM_AUTOINDEX",
    }
    for key, env in env_map.items():
        value = os.environ.get(env)
        if value:
            cfg[key] = value

    cfg["autoindex"] = str(cfg.get("autoindex") or "").strip().lower() in ("1", "true", "yes", "on")

    # "auto" / "" / absent all mean "derive it from the git remote".
    pinned = cfg["repo_id"]
    cfg["repo_id"] = None
    if pinned not in (None, "", "auto"):
        try:
            cfg["repo_id"] = int(pinned)
            cfg["repo_id_source"] = "config"
        except Exception:
            cfg["repo_id"] = None

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
# local state (binding cache, one-shot markers)
# --------------------------------------------------------------------------

def state_root() -> str:
    base = os.environ.get("MAP_ROOM_STATE_DIR")
    if not base:
        base = os.path.join(
            os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.expanduser("~/.claude"),
            "map-room",
        )
    return base


def _safe_key(value: str, limit: int = 100) -> str:
    out = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in str(value))
    return out[:limit] or "unknown"


def once(kind: str, key: str) -> bool:
    """True the first time this (kind, key) is asked for, False afterwards.

    Used to keep "this repo is not indexed" a one-line hint per session rather
    than a line per tool call. Best effort: if the marker cannot be written we
    return False so a broken state dir stays quiet instead of spamming.
    """
    try:
        directory = os.path.join(state_root(), "once", _safe_key(kind, 40))
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, _safe_key(key, 160))
        if os.path.exists(path):
            return False
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(str(int(time.time())))
        _sweep_dir(directory)
        return True
    except Exception:
        return False


ONCE_TTL = 7 * 24 * 60 * 60


def _sweep_dir(directory: str, ttl: float = ONCE_TTL) -> None:
    """Markers are per session, so drop the dead ones. Only ever runs on the
    rare path where a new marker was just created."""
    try:
        cutoff = time.time() - ttl
        for name in os.listdir(directory)[:500]:
            full = os.path.join(directory, name)
            try:
                if os.path.isfile(full) and os.path.getmtime(full) < cutoff:
                    os.remove(full)
            except Exception:
                continue
    except Exception:
        pass


# --------------------------------------------------------------------------
# repo binding -- whose map do these touches belong to?
# --------------------------------------------------------------------------
#
# Resolution order:
#   1. MAP_ROOM_REPO_ID / "repo_id" in .map-room.json     (explicit escape hatch)
#   2. `git remote get-url origin` -> owner/repo -> the `repo` row with that slug
#   3. nothing. Report nothing, exit 0, stay silent.
#
# Step 3 is the important one. Defaulting to a shared repo id means every
# unconfigured checkout lights up somebody else's map.

_SLUG_PART = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_REMOTE_RE = re.compile(
    r"^(?:(?:https?|ssh|git)://)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?/?$"
)


def parse_remote_slug(url: str | None) -> str | None:
    """`https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`
    -> `owner/repo`, which is exactly the slug `index_repo` writes."""
    url = (url or "").strip()
    if not url or len(url) > 400:
        return None
    match = _REMOTE_RE.match(url)
    if not match:
        return None
    path = match.group(2)
    parts = [p for p in path.split("/") if p and p not in (".", "..")]
    if len(parts) < 2:
        return None
    owner, repo = parts[-2], parts[-1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not (_SLUG_PART.match(owner) and _SLUG_PART.match(repo)):
        return None
    return "%s/%s" % (owner, repo)


def remote_host(url: str | None) -> str | None:
    match = _REMOTE_RE.match((url or "").strip())
    return match.group(1).lower() if match else None


def git_remote_url(project_dir: str) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", project_dir, "remote", "get-url", "origin"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=GIT_TIMEOUT,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    try:
        return proc.stdout.decode("utf-8", "replace").strip() or None
    except Exception:
        return None


def _bind_cache_path(project_dir: str) -> str | None:
    """Keyed by the checkout, but the remote slug is stored inside and the
    entry is invalidated whenever .git/config changes -- so switching remotes
    re-binds without anyone having to know the cache exists."""
    try:
        directory = os.path.join(state_root(), "bind")
        os.makedirs(directory, exist_ok=True)
        key = hashlib.sha1(os.path.abspath(project_dir).encode("utf-8")).hexdigest()[:16]
        return os.path.join(directory, "%s.json" % key)
    except Exception:
        return None


def _git_config_mtime(project_dir: str) -> float:
    for rel in (".git/config", ".git"):
        try:
            return round(os.path.getmtime(os.path.join(project_dir, rel)), 3)
        except Exception:
            continue
    return 0.0


def read_bind_cache(project_dir: str) -> dict | None:
    path = _bind_cache_path(project_dir)
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            entry = json.load(fh)
        if not isinstance(entry, dict):
            return None
        ttl = BIND_TTL_HIT if entry.get("repo_id") else BIND_TTL_MISS
        if time.time() - float(entry.get("at") or 0) > ttl:
            return None
        if entry.get("git_mtime") != _git_config_mtime(project_dir):
            return None
        return entry
    except Exception:
        return None


def write_bind_cache(project_dir: str, slug, repo_id, source: str) -> None:
    path = _bind_cache_path(project_dir)
    if not path:
        return
    try:
        tmp = "%s.%d.tmp" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({
                "slug": slug,
                "repo_id": repo_id,
                "source": source,
                "at": int(time.time()),
                "git_mtime": _git_config_mtime(project_dir),
            }, fh)
        os.replace(tmp, path)
    except Exception:
        pass


def clear_bind_cache(project_dir: str | None = None) -> int:
    """Invalidate. One file if given a checkout, the whole cache otherwise."""
    removed = 0
    try:
        if project_dir:
            targets = [_bind_cache_path(project_dir)]
        else:
            directory = os.path.join(state_root(), "bind")
            targets = [os.path.join(directory, n) for n in os.listdir(directory)]
        for path in targets:
            try:
                if path and os.path.isfile(path):
                    os.remove(path)
                    removed += 1
            except Exception:
                continue
    except Exception:
        pass
    return removed


def lookup_repo_id(cfg: dict, token: str | None, slug: str):
    """(repo_id | None, reached_the_database: bool).

    `repo_id = None` with `reached = True` means the slug is simply not indexed.
    `reached = False` means we could not tell, so nothing gets cached.
    """
    for candidate in (slug, slug.lower()):
        rows = sql(
            cfg, token,
            "SELECT id FROM repo WHERE slug = '%s'" % _sql_escape(candidate),
        )
        if rows is None:
            return None, False
        for row in rows:
            for value in row.values():
                try:
                    found = int(value)
                except Exception:
                    continue
                if found:
                    return found, True
        if candidate == slug.lower():
            break
    return None, True


def bind_repo(cfg: dict, token: str | None = None, allow_network: bool = True) -> dict:
    """Fill in cfg["repo_id"]. Mutates and returns cfg.

    cfg["repo_id_source"] afterwards is one of:
      config      pinned by env var or .map-room.json
      lookup      matched the git remote's slug against the `repo` table
      not-indexed valid remote, no `repo` row -- report nothing, hint once
      no-remote   no origin remote at all -- report nothing
      deferred    cache miss and we were told not to touch the network
      error       could not reach the database; nothing cached, try next time
    """
    if cfg.get("repo_id"):
        cfg["repo_id_source"] = "config"
        return cfg

    project_dir = cfg.get("project_dir") or os.getcwd()

    entry = read_bind_cache(project_dir)
    if entry is not None:
        cfg["repo_slug"] = entry.get("slug")
        cfg["repo_id"] = entry.get("repo_id") or None
        cfg["repo_id_source"] = str(entry.get("source") or "cache")
        cfg["repo_bind_cached"] = True
        return cfg

    if not allow_network:
        cfg["repo_id_source"] = "deferred"
        return cfg

    url = git_remote_url(project_dir)
    slug = parse_remote_slug(url)
    cfg["repo_slug"] = slug
    cfg["repo_host"] = remote_host(url)

    if not slug:
        cfg["repo_id_source"] = "no-remote"
        write_bind_cache(project_dir, None, None, "no-remote")
        return cfg

    repo_id, reached = lookup_repo_id(cfg, token, slug)
    if not reached:
        cfg["repo_id_source"] = "error"
        return cfg

    cfg["repo_id"] = repo_id or None
    cfg["repo_id_source"] = "lookup" if repo_id else "not-indexed"
    write_bind_cache(project_dir, slug, repo_id, cfg["repo_id_source"])
    return cfg


def index_repo(cfg: dict, token: str | None, slug: str):
    """Build the map for a GitHub repo. Runs inside SpacetimeDB (~3s for any
    repo size) and works unauthenticated. Far too slow for a hook: only ever
    call this from the CLI or from an already-detached child."""
    owner, _, repo = str(slug).partition("/")
    if not owner or not repo:
        return "ERROR: bad slug %r" % slug
    return call_reducer(
        cfg, token, "index_repo", [owner, repo, ""], timeout=INDEX_TIMEOUT,
    )


def index_hint(cfg: dict, script_dir: str | None = None) -> str | None:
    """The one line a human gets when their repo has no map yet."""
    slug = cfg.get("repo_slug")
    if not slug or cfg.get("repo_id_source") != "not-indexed":
        return None
    cli = os.path.join(script_dir or os.path.dirname(os.path.abspath(__file__)), "map_room_cli.py")
    return ("[The Map Room] %s has no map yet, so nothing is being reported. "
            "Index it once with: python3 %s index" % (slug, cli))


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


def call_reducer(cfg: dict, token: str | None, reducer: str, args: list,
                 timeout: float | None = None) -> str | None:
    """POST a positional JSON array to /v1/database/<db>/call/<reducer>."""
    url = "%s/v1/database/%s/call/%s" % (cfg["host"], cfg["db"], reducer)
    body = json.dumps(args).encode("utf-8")
    return _post(url, body, "application/json", token, timeout or CALL_TIMEOUT)


def _u64(value) -> int:
    """SpacetimeDB u64 params must be JSON numbers. Strings are rejected with a
    400 ("invalid type: string, expected u64"), so coerce every id here."""
    try:
        return int(value)
    except Exception:
        return 0


def report_touch(cfg: dict, token: str | None, session: str, tool: str, paths: list):
    """Positional args for report_touch(repo_id: u64, session, agent_name, tool,
    paths_json). paths_json is a JSON array *string* -- double-encoded on purpose.

    Returns None without calling anything if the repo is unbound. Last line of
    defence: a caller that forgets to check cannot pollute another repo's map."""
    if not cfg.get("repo_id"):
        return None
    return call_reducer(cfg, token, "report_touch", [
        _u64(cfg["repo_id"]),
        str(session),
        str(cfg["agent_name"]),
        str(tool),
        json.dumps(list(paths)),
    ])


def report_touch_timed(cfg: dict, token: str | None, session: str, tool: str,
                       paths: list, duration_ms=0, tool_use_id: str = ""):
    """`report_touch` plus how long the tool call took.

    Falls back to the plain 5-arg reducer when there is nothing extra to say, so
    a payload with no duration in it costs exactly what it always did. The extra
    fields land in the additive `touch_meta` table -- `touch` itself is
    populated and its shape is frozen.
    """
    try:
        ms = int(duration_ms or 0)
    except Exception:
        ms = 0
    if ms < 0:
        ms = 0
    ms = min(ms, 4294967295)
    tuid = str(tool_use_id or "")[:64]
    if ms == 0 and not tuid:
        return report_touch(cfg, token, session, tool, paths)
    if not cfg.get("repo_id"):
        return None
    args = [
        _u64(cfg["repo_id"]), str(session), str(cfg["agent_name"]), str(tool),
        json.dumps([str(p) for p in paths]), ms, tuid,
    ]
    return call_reducer(cfg, token, "report_touch_timed", args)


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

# Anything Bash reports must carry one of these. It is a deliberately closed
# list: a token with an unrecognised extension is dropped rather than guessed.
TRACKED_SUFFIXES = frozenset(SOURCE_SUFFIXES + (
    ".txt", ".cfg", ".ini", ".rst", ".mjs", ".cjs", ".xml", ".proto",
    ".ipynb", ".vue", ".svelte", ".graphql", ".lock", ".gradle", ".tf",
))

_MAX_PATHS = 40
_MAX_BASH_PATHS = 24

# Longer than this and we do not even tokenise: a multi-kilobyte heredoc or a
# generated one-liner is not exploration, and parsing it is pure latency.
BASH_MAX_COMMAND = 4096
_BASH_MAX_TOKENS = 400


def _looks_like_file(value: str) -> bool:
    if not value or not isinstance(value, str):
        return False
    if len(value) > 512 or "\n" in value:
        return False
    if any(ch in value for ch in "*?["):  # a glob pattern, not a file
        return False
    base = os.path.basename(value)
    return "." in base and base.rsplit(".", 1)[-1].isalnum()


# A shell command that WRITES rather than reads. Orange on the map means the
# agent changed a file, and an agent that edits with `sed -i` or a heredoc
# instead of the Edit tool was reporting those as plain Bash — indistinguishable
# from `cat`, so a real edit read as a glance. These are the forms that actually
# turn up in agent transcripts; anything not matched stays a read, because
# calling a read an edit is the worse error of the two.
_WRITEISH = re.compile(
    r"(?:^|[|&;]\s*)(?:sed\s+-[a-z]*i|tee|dd\b|truncate|install\b)"     # in-place editors
    r"|>>?\s*(?![&\d])"                                                    # redirect into a file
    r"|<<-?\s*['\"]?[A-Za-z_]"                                            # heredoc
    r"|(?:^|[|&;]\s*)(?:mv|cp|touch|ln)\s",                                # file creation / moves
    re.IGNORECASE,
)


def bash_wrote(command: str) -> bool:
    """Did this shell command change a file, as best we can tell from its text?

    Deliberately conservative. `git diff > /dev/null` and `echo x >&2` are not
    edits, and neither is anything we do not recognise.
    """
    c = str(command or "")
    if not c or len(c) > 4096:
        return False
    # A redirect to a device or a discard is not a file edit.
    stripped = re.sub(r">>?\s*/dev/\w+", " ", c)
    return bool(_WRITEISH.search(stripped))


def extract_paths(tool_name: str, tool_input, tool_response=None, cwd: str | None = None) -> list:
    """Pull concrete file paths out of a tool's input (and, for search tools,
    out of its response, since that is where the matched files live)."""
    if tool_name == "Bash":
        # Bash is handled entirely from the command string. Its *output* is
        # never scanned: a `find` or a `grep -r` would name hundreds of files
        # the agent never actually looked at.
        command = ""
        if isinstance(tool_input, dict):
            command = tool_input.get("command") or ""
        elif isinstance(tool_input, str):
            command = tool_input
        return extract_bash_paths(command, cwd)

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
# Bash: the biggest coverage gap
# --------------------------------------------------------------------------
#
# Every `cat`, `grep`, `sed`, `head` and `rg` an agent runs is real exploration
# that the file tools never see. Parsing it out of a command string is
# necessarily imperfect, so the whole parser is biased one way: a path we are
# not sure about is dropped. A missed touch leaves a region dark; an invented
# one lights up the wrong part of somebody's map.
#
# Three filters, all of which must pass:
#   1. the token survives cleaning  (not a flag, glob, URL, ref, variable, ...)
#   2. its extension is in TRACKED_SUFFIXES  -- or it has no extension at all
#      and the command it belongs to is a known reader (`cat Makefile`)
#   3. the file actually exists on disk. This is what stops us inventing paths.

_READER_COMMANDS = frozenset((
    "cat", "bat", "head", "tail", "sed", "awk", "gawk", "grep", "egrep", "fgrep",
    "rg", "ag", "ack", "less", "more", "nl", "wc", "cut", "sort", "uniq", "tee",
    "diff", "cmp", "strings", "file", "stat", "md5", "md5sum", "shasum", "jq",
    "yq", "python", "python3", "node", "ruby", "perl", "php", "go", "cargo",
    "code", "vim", "nvim", "emacs", "nano", "open", "touch", "cp", "mv", "rm",
    "ls", "wc", "xxd", "od", "pbcopy", "source", ".",
))

# Prefixes that stand in front of the real command: skip them and treat the
# next token as the command name.
_WRAPPERS = frozenset((
    "sudo", "env", "time", "nohup", "nice", "xargs", "command", "exec", "then",
    "do", "!", "builtin",
))

# Commands whose arguments are never files being looked at, even when the
# argument happens to name one. `echo "src/app.py"` is not a read.
_SKIP_COMMANDS = frozenset((
    "echo", "printf", "export", "alias", "cd", "mkdir", "rmdir", "which",
    "type", "read", "set", "unset", "history", "man", "curl", "wget", "ssh",
))

_OPERATOR_CHARS = set("|&;()<>")
_FALLBACK_TOKENS = re.compile(r"[^\s|&;<>()'\"]+")
_GIT_RANGE = re.compile(r"\w\.\.\w")


def _bash_tokens(command: str) -> list:
    """Quote-aware tokens, with shell operators as tokens of their own.

    `punctuation_chars=True` is what makes `cat a.py|grep x` come apart
    properly; without it `a.py|grep` is a single token. A malformed command
    (unbalanced quote) falls back to a dumb split rather than raising.
    """
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = []
        for token in lexer:
            tokens.append(token)
            if len(tokens) >= _BASH_MAX_TOKENS:
                break
        return tokens
    except Exception:
        return _FALLBACK_TOKENS.findall(command)[:_BASH_MAX_TOKENS]


def _is_operator(token: str) -> bool:
    return bool(token) and all(ch in _OPERATOR_CHARS for ch in token)


def _clean_bash_token(token: str) -> str | None:
    """Drop everything that is not plausibly a path. Returns the path or None."""
    token = token.strip().strip(",")
    if not token or len(token) > 400:
        return None

    if token.startswith("-"):
        # `--file=x.py` carries a path; a bare flag does not.
        if "=" in token:
            token = token.split("=", 1)[1]
        else:
            return None
    if not token or token.startswith("-"):
        return None

    # unexpanded expansions, globs we cannot resolve, subshells, quoting junk
    if any(ch in token for ch in "*?[]{}$`!\\\\\n\t\"'"):
        return None
    if "=" in token:            # FOO=bar env assignment
        return None
    if "://" in token or token.startswith("www."):
        return None
    if ":" in token:            # git refs (HEAD:f.py), host:path, file:line
        return None
    if _GIT_RANGE.search(token):  # main..HEAD
        return None
    if token.startswith("~"):   # we do not expand it, so we do not guess it
        return None
    if token in (".", "..") or token.endswith("/"):
        return None
    for prefix in ("/dev/", "/proc/", "/sys/"):
        if token.startswith(prefix):
            return None
    return token


def _bash_accept(token: str, project_dir: str, reader: bool) -> str | None:
    base = os.path.basename(token)
    if "." in base and not base.startswith("."):
        suffix = "." + base.rsplit(".", 1)[1].lower()
        if suffix not in TRACKED_SUFFIXES:
            return None
    elif not reader:
        # An extension-less token is only a path if a reader was asked to read
        # it -- `cat Makefile` yes, `git status` no.
        return None

    full = token if os.path.isabs(token) else os.path.join(project_dir, token)
    try:
        if not os.path.isfile(full):
            return None
    except Exception:
        return None
    return token


def extract_bash_paths(command, cwd: str | None = None) -> list:
    """File paths a shell command plausibly read or wrote.

    Relative tokens resolve against `cwd` (the hook payload's cwd, which is the
    directory the command ran in). The result is capped well under the
    reducer's own limit so one pathological command cannot flood the map.
    """
    if not isinstance(command, str):
        return []
    command = command.strip()
    if not command or len(command) > BASH_MAX_COMMAND:
        return []

    project_dir = os.path.abspath(cwd) if cwd and os.path.isdir(cwd) else os.getcwd()

    out: list = []
    reader = False
    skip = False
    at_command = True
    for token in _bash_tokens(command):
        if not token:
            continue
        if _is_operator(token):
            at_command, reader, skip = True, False, False
            continue
        if at_command:
            name = os.path.basename(token)
            if name in _WRAPPERS:
                continue          # still at a command position
            at_command = False
            if name in _SKIP_COMMANDS:
                skip = True
                continue
            skip = False
            reader = name in _READER_COMMANDS
            # fall through: `./manage.py` is both the command and a repo file

        if skip:
            continue

        candidate = _clean_bash_token(token)
        if not candidate:
            continue
        accepted = _bash_accept(candidate, project_dir, reader)
        if accepted and accepted not in out:
            out.append(accepted)
            if len(out) >= _MAX_BASH_PATHS:
                break
    return out


# --------------------------------------------------------------------------
# the return path: what the human has asked for
# --------------------------------------------------------------------------

def _sql_escape(value: str) -> str:
    return str(value).replace("'", "''")


def heartbeat(cfg: dict, token: str | None, session: str):
    if not cfg.get("repo_id"):
        return None
    return call_reducer(
        cfg, token, "agent_heartbeat",
        [str(session), str(cfg["agent_name"]), _u64(cfg["repo_id"])],
    )


# --------------------------------------------------------------------------
# exploration requests — the return path
# --------------------------------------------------------------------------

def pending_requests(cfg: dict, token: str | None, limit: int = 50) -> list:
    """Every request the human has raised that no agent has claimed yet."""
    if not cfg.get("repo_id"):
        return []
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


# --------------------------------------------------------------------------
# session lifecycle -- so the lamps can go out
# --------------------------------------------------------------------------

def end_session(cfg: dict, token: str | None, session: str):
    """Mark a session (and every subagent under it) offline.

    Nothing else ever writes `online: false` on an agent row: a hook is an HTTP
    caller with no connection for the database to notice dropping. Without this
    call an agent stays lit forever and the map paints actor colour for somebody
    who went home. Idempotent and safe for a session the map never saw.
    """
    key = str(session or "").strip()
    if not key:
        return None
    return call_reducer(cfg, token, "end_session", [key])


# --------------------------------------------------------------------------
# the two links
# --------------------------------------------------------------------------

def site(cfg: dict | None = None) -> str:
    base = (
        os.environ.get("MAP_ROOM_SITE")
        or (cfg or {}).get("site")
        or DEFAULT_SITE
    )
    return str(base).rstrip("/")


def repo_ref(cfg: dict) -> str | None:
    """What to put after `?repo=`.

    The slug when we resolved one from the git remote, and the numeric repo id
    otherwise -- the page accepts either, so a repo pinned by `.map-room.json`
    with no remote still gets a working link instead of no link.
    """
    slug = (cfg.get("repo_slug") or "").strip()
    if slug:
        return slug
    rid = cfg.get("repo_id")
    return str(rid) if rid else None


def base_link(cfg: dict) -> str | None:
    """Everything every agent has ever explored in this repo."""
    ref = repo_ref(cfg)
    if not ref:
        return None
    return "%s/?repo=%s" % (site(cfg), urllib.parse.quote(ref, safe="/"))


def session_link(cfg: dict, session: str) -> str | None:
    """This one session's route, and nothing else.

    `session` is Claude Code's own `session_id`, which is already written into
    every `touch` row and into `agent_session.session`, so the link needs no new
    data at all -- it is derivable the moment the session has an id.
    """
    base = base_link(cfg)
    key = str(session or "").strip()
    if not base or not key or key == "unknown-session":
        return None
    return "%s&session=%s" % (base, urllib.parse.quote(key, safe=""))
