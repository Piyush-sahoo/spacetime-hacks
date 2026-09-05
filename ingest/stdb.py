"""SpacetimeDB HTTP transport for the seeder.

API surface verified against the real docs before writing a line
(`npx ctx7@latest docs /clockworklabs/spacetimedb ...`), not guessed:

    POST /v1/database/:name_or_identity/call/:reducer
        Content-Type: application/json
        body: a JSON ARRAY of the reducer's arguments, positionally.
        Authorization: Bearer <token> — OPTIONAL. Without it the request is
        anonymous and the caller's identity is still passed to the reducer via
        ReducerContext, so an unauthenticated seed works when the database
        allows it.

    POST /v1/database/:name_or_identity/sql
        Content-Type: application/json
        body: the SQL text (statements separated by ';').
        Returns [{"schema": ProductType, "rows": [...]}] — rows are
        JSON-encoded ProductValues, i.e. positional arrays in schema order.
        Anonymous requests can read public tables, which every Map Room table is.

One httpx.Client, a Bearer header when a token is available, and the server's
own error text surfaced verbatim rather than reinterpreted — a seeder that
paraphrases the database's complaint costs more time than it saves.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import httpx

DEFAULT_HOST = "https://maincloud.spacetimedb.com"
CLI_CONFIG = Path.home() / ".config" / "spacetime" / "cli.toml"


class SpacetimeError(RuntimeError):
    """Raised with the server's own error text, unmodified."""


# --------------------------------------------------------------------------
# token discovery
# --------------------------------------------------------------------------

def discover_token(explicit: str | None = None,
                   config_path: Path = CLI_CONFIG) -> tuple[str | None, str]:
    """Find a Spacetime token. Returns (token, where_it_came_from).

    Order: explicit flag > SPACETIME_TOKEN / SPACETIMEDB_TOKEN env >
    ~/.config/spacetime/cli.toml > ~/.config/spacetime/token. Returns
    (None, "anonymous") when there is none — that is a supported mode, not an
    error, because the call and sql endpoints both accept anonymous requests.
    """
    if explicit:
        return explicit, "--token"
    for var in ("SPACETIME_TOKEN", "SPACETIMEDB_TOKEN"):
        val = os.environ.get(var)
        if val:
            return val.strip(), f"${var}"

    config_path = Path(config_path)
    if config_path.exists():
        text = config_path.read_text(encoding="utf-8")
        m = re.search(r'^\s*(?:spacetimedb_token|token)\s*=\s*"([^"]+)"',
                      text, re.MULTILINE)
        if m:
            return m.group(1), str(config_path)

    token_file = config_path.parent / "token"
    if token_file.exists():
        val = token_file.read_text(encoding="utf-8").strip()
        if val:
            return val, str(token_file)

    return None, "anonymous"


def default_host(config_path: Path = CLI_CONFIG) -> str:
    """Host from the CLI's `default_server`, falling back to maincloud."""
    config_path = Path(config_path)
    if not config_path.exists():
        return DEFAULT_HOST
    text = config_path.read_text(encoding="utf-8")
    m = re.search(r'^\s*default_server\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not m:
        return DEFAULT_HOST
    want = m.group(1)
    for block in text.split("[[server_configs]]")[1:]:
        nick = re.search(r'nickname\s*=\s*"([^"]+)"', block)
        host = re.search(r'host\s*=\s*"([^"]+)"', block)
        proto = re.search(r'protocol\s*=\s*"([^"]+)"', block)
        if nick and host and nick.group(1) == want:
            return f"{proto.group(1) if proto else 'https'}://{host.group(1)}"
    return DEFAULT_HOST


# --------------------------------------------------------------------------
# client
# --------------------------------------------------------------------------

class SpacetimeClient:
    def __init__(self, host: str, module: str, token: str | None = None,
                 timeout: float = 120.0, dry_run: bool = False) -> None:
        self.host = host.rstrip("/")
        self.module = module
        self.token = token
        self.dry_run = dry_run
        self._client = None if dry_run else httpx.Client(timeout=timeout)
        self.sent: list[tuple[str, int]] = []   # (reducer, arg payload bytes)

    # -- plumbing ----------------------------------------------------------

    @property
    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    @staticmethod
    def _error_text(resp: httpx.Response) -> str:
        try:
            data = resp.json()
        except Exception:  # noqa: BLE001 - non-JSON error body
            return resp.text.strip()
        if isinstance(data, dict):
            for key in ("error", "message"):
                val = data.get(key)
                if isinstance(val, str) and val:
                    return val
                if isinstance(val, dict) and val.get("message"):
                    return str(val["message"])
        return resp.text.strip()

    # -- API ---------------------------------------------------------------

    def call(self, reducer: str, args: list[Any]) -> Any:
        """POST /v1/database/<module>/call/<reducer> with positional JSON args."""
        body = json.dumps(args)
        self.sent.append((reducer, len(body)))
        if self.dry_run:
            return None
        url = f"{self.host}/v1/database/{self.module}/call/{reducer}"
        resp = self._client.post(url, headers=self._headers, content=body)
        if resp.status_code >= 400:
            raise SpacetimeError(
                f"{reducer} -> HTTP {resp.status_code}: {self._error_text(resp)}")
        if not resp.content:
            return None
        try:
            return resp.json()
        except Exception:  # noqa: BLE001
            return resp.text

    def sql(self, query: str) -> list[dict]:
        """POST /v1/database/<module>/sql; returns rows as dicts keyed by column.

        The response is `[{"schema": ProductType, "rows": [[...], ...]}]` — rows
        are positional ProductValues, so the column names come out of
        `schema.elements[*].name`, which is itself `{"some": "<name>"} | {"none": []}`.
        """
        if self.dry_run:
            return []
        url = f"{self.host}/v1/database/{self.module}/sql"
        resp = self._client.post(url, headers=self._headers, content=query)
        if resp.status_code >= 400:
            raise SpacetimeError(
                f"sql -> HTTP {resp.status_code}: {self._error_text(resp)}")
        payload = resp.json()
        blocks = payload if isinstance(payload, list) else [payload]
        out: list[dict] = []
        for block in blocks:
            names = _column_names(block.get("schema") or {})
            for row in block.get("rows") or []:
                if isinstance(row, list):
                    out.append({n: _unwrap(v) for n, v in zip(names, row)})
                elif isinstance(row, dict):
                    out.append({k: _unwrap(v) for k, v in row.items()})
        return out

    def ping(self) -> bool:
        """Is the module published and reachable? GET /v1/database/<m>/schema."""
        if self.dry_run:
            return True
        url = f"{self.host}/v1/database/{self.module}/schema?version=9"
        try:
            resp = self._client.get(url, headers=self._headers)
        except httpx.HTTPError as exc:
            raise SpacetimeError(str(exc)) from exc
        return resp.status_code < 400

    def close(self) -> None:
        if self._client is not None:
            self._client.close()


def _column_names(schema: dict) -> list[str]:
    names: list[str] = []
    for i, el in enumerate(schema.get("elements") or []):
        name = el.get("name")
        if isinstance(name, dict):
            name = name.get("some")
        names.append(name if isinstance(name, str) else f"col{i}")
    return names


def _unwrap(cell: Any) -> Any:
    """SATS-JSON scalars come through plain; u64 may arrive as a string."""
    if isinstance(cell, dict) and len(cell) == 1:
        return next(iter(cell.values()))
    return cell
