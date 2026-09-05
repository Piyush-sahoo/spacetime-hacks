# The Map Room — Claude Code plugin

A human watches a live map of your repository. Every file the agent reads, edits
or searches lights up. Everything nobody has looked at stays dark. The human
clicks a dark region; that click arrives in the agent's next turn; the agent
sends a subagent to go look.

This plugin is the agent's half of that loop.

```
  agent  --PostToolUse hook-->  report_touch  -->  node_cov  -->  the map lights up
                                                                        |
  human  <-------------------- live subscription ------------------------
     |
     |  clicks a dark region
     v
  exploration_request (pending)
     |
     |  UserPromptSubmit hook injects it
     v
  agent  --claim_request--> subagent explores --> complete_request --> done, live
```

## What it installs

| Component | Event | What it does |
|---|---|---|
| `scripts/post_tool_use.py` | `PostToolUse` on `Read\|Edit\|Write\|Grep\|Glob` | Extracts file paths from the tool input (and, for `Grep`/`Glob`, from the result), makes them repo-relative, POSTs them to `report_touch`. |
| `scripts/user_prompt_submit.py` | `UserPromptSubmit` | Queries `exploration_request` for `pending` rows and injects them into the turn. Also sends `agent_heartbeat` so the agent shows up in the presence rail. |
| `skills/map-room/SKILL.md` | skill | The protocol: claim → spawn a scoped subagent → complete. |
| `scripts/map_room_cli.py` | CLI | `pending`, `claim`, `complete`, `coverage`, `doctor`. |

Both hooks are **fire-and-forget**. The network call happens in a forked,
detached child with a 2-second timeout; the hook process itself exits 0 in
about 100 ms. Every error path — no token, no network, database down, reducer
missing, malformed payload — returns exit 0 with no output. A broken Map Room
can slow your session by a fork, and nothing else.

## Install

Requires Python 3 (standard library only — no pip install) and a SpacetimeDB
login.

```bash
# 1. Log in to SpacetimeDB. This writes the bearer token the plugin reads
#    from ~/.config/spacetime/cli.toml.
spacetime login

# 2. From the root of this repository, register it as a plugin marketplace.
#    Use an absolute path.
claude plugin marketplace add "$(pwd)"

# 3. Install.
claude plugin install map-room@map-room

# 4. Confirm.
claude plugin details map-room@map-room
```

Expected output of step 4:

```
map-room 0.1.0
Component inventory
  Skills (1)  map-room
  Hooks (2)  PostToolUse, UserPromptSubmit  (harness-only — no model context cost)
```

Restart Claude Code (or `/reload-plugins`) so the hooks load.

### Check it works

```bash
python3 ~/.claude/plugins/.../map-room/scripts/map_room_cli.py doctor
```

or, from this repo:

```bash
python3 plugin/scripts/map_room_cli.py doctor
```

```
host        : https://maincloud.spacetimedb.com
database    : map-room
repo_id     : 1
agent_name  : claude
token       : found (534 chars)
sql /node   : ok, 12631 rows
sql /touch  : 6 rows
```

Then use Claude Code normally and watch the counter move:

```bash
spacetime sql map-room "SELECT COUNT(*) AS n FROM touch"
```

## Configuration

Everything has a working default. Override with a `.map-room.json` at the
project root, or with environment variables (env wins):

| Key | Env var | Default |
|---|---|---|
| `host` | `MAP_ROOM_HOST` | `https://maincloud.spacetimedb.com` |
| `db` | `MAP_ROOM_DB` | `map-room` |
| `repo_id` | `MAP_ROOM_REPO_ID` | `1` |
| `agent_name` | `MAP_ROOM_AGENT` | `claude` |
| — | `MAP_ROOM_TOKEN` | read from `~/.config/spacetime/cli.toml` |

```json
{ "repo_id": 1, "agent_name": "claude-opus" }
```

## Uninstall

```bash
claude plugin uninstall map-room@map-room
claude plugin marketplace remove map-room
```

## Wire protocol

```
POST {host}/v1/database/{db}/call/{reducer}
     Authorization: Bearer <token>
     Content-Type:  application/json
     body: positional JSON array

POST {host}/v1/database/{db}/sql
     Content-Type: text/plain
     body: the SQL string
```

Two things that will bite you if you write against this by hand:

- **`u64` arguments must be JSON numbers, not strings.** `["1", ...]` is
  rejected with `400 invalid type: string "1", expected u64`. See `_u64()` in
  `scripts/map_room.py`.
- **`paths_json` is double-encoded** — a JSON array *string* inside the
  positional array:
  ```json
  [1, "sess-abc", "claude", "Read", "[\"django/forms/fields.py\"]"]
  ```

SpacetimeDB SQL has no `GROUP BY`, no `LIKE`, and requires an alias on every
aggregate (`SELECT COUNT(*) AS n FROM touch`).

## Debugging

Both hooks take `--debug`, which makes them synchronous and loud:

```bash
echo '{"session_id":"s1","cwd":"'"$PWD"'","hook_event_name":"PostToolUse",
       "tool_name":"Read","tool_input":{"file_path":"'"$PWD"'/README.md"}}' \
  | python3 plugin/scripts/post_tool_use.py --debug
```

```
tool=Read session=s1 project=/path/to/repo
paths=['README.md']
```

An empty reducer response body means success.

## Notes

- Paths outside the project root are dropped, so a `Read` of `/etc/passwd` or a
  file in another repo is never reported.
- At most 40 paths per tool call, so a wide `Grep` cannot flood the database.
- A path that matches no node in the graph is still recorded as a `touch` with
  `node_id = 0`, so misses stay visible and countable rather than vanishing.
