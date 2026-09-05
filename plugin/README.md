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
| `scripts/post_tool_use.py` | `PostToolUse` on `Read\|Edit\|Write\|Grep\|Glob\|Bash` | Extracts file paths from the tool input (for `Grep`/`Glob` also from the result, for `Bash` from the command string), makes them repo-relative, POSTs them to `report_touch`. |
| `scripts/user_prompt_submit.py` | `UserPromptSubmit` | Queries `exploration_request` for `pending` rows and injects them into the turn. Also sends `agent_heartbeat` so the agent shows up in the presence rail. |
| `skills/map-room/SKILL.md` | skill | The protocol: claim → spawn a scoped subagent → complete. |
| `scripts/stop.py` | `Stop` | Feeds a click that landed after the agent went idle back into the conversation, so the human does not have to type anything. |
| `scripts/map_room_cli.py` | CLI | `pending`, `claim`, `complete`, `coverage`, `doctor`, `index`, `rebind`. |

All three hooks are **fire-and-forget**. The network call happens in a forked,
detached child with a 2-second timeout; the hook process itself exits 0 in
about 100 ms. Every error path — no token, no network, database down, reducer
missing, malformed payload — returns exit 0 with no output. A broken Map Room
can slow your session by a fork, and nothing else.

## Which map do my touches go to?

The plugin binds a checkout to exactly one repo on the map, in this order:

1. **`MAP_ROOM_REPO_ID`**, or `repo_id` in `.map-room.json`. Explicit wins over
   everything — the escape hatch for a repo with no remote, a fork, or a
   deliberately shared map.
2. **The git remote.** `git remote get-url origin` → `owner/repo` (both
   `https://github.com/owner/repo.git` and `git@github.com:owner/repo.git`
   parse), looked up against `repo.slug` — which is exactly the slug
   `index_repo` writes.
3. **Nothing.** No remote, or a remote nobody has indexed: the plugin reports
   nothing at all and exits 0 silently.

There is deliberately **no default repo id**. Defaulting means every teammate who
installs without configuring lights up somebody else's map, and the leaderboard
stops meaning anything. Silence is the correct answer; a wrong map is not.

When the remote is a real GitHub repo with no map yet, you get one line, once per
session:

```
[The Map Room] you/your-repo has no map yet, so nothing is being reported.
Index it once with: python3 .../scripts/map_room_cli.py index
```

`index` runs entirely inside SpacetimeDB and takes about three seconds for any
repo size. It is idempotent: re-indexing an existing repo keeps its id and its
coverage.

Auto-indexing is **off by default** and opt-in with `MAP_ROOM_AUTOINDEX=1`.
Building a whole repo graph in a shared database should be a decision, not a
side effect of opening a folder. When it is on, it runs once per slug from the
already-detached child, so it still never blocks a turn.

### The binding cache

Resolution costs a `git` subprocess plus one SQL round trip, which is far too
much to pay per tool call, so the answer is cached in
`~/.claude/map-room/bind/<hash of the checkout>.json`:

```json
{"slug": "pallets/flask", "repo_id": 5, "source": "lookup",
 "at": 1788614063, "git_mtime": 1788609796.051}
```

- A hit is trusted for 7 days; a miss is re-checked after 10 minutes, so
  indexing your repo takes effect within minutes rather than requiring a purge.
- The entry is invalidated automatically when `.git/config` changes, so
  switching remotes re-binds without anyone knowing the cache exists.
- `map_room_cli.py rebind` clears it for the current checkout. Deleting
  `~/.claude/map-room/bind/` clears all of it.
- A cache **miss never blocks a turn**. `PostToolUse` only ever reads the cache;
  on a miss it hands the whole job — resolve, then report — to the detached
  child, so the first tool call in a fresh checkout is neither lost nor slow.
- A database that cannot be reached is never cached as "not indexed". It is
  simply retried next time.

## What gets reported from `Bash`

`Read`/`Edit`/`Write`/`Grep`/`Glob` are not how an agent actually reads most
files — `cat`, `grep`, `sed`, `head`, `rg` and `wc` are, and none of them used
to be visible. `Bash` is now matched and file paths are parsed out of the
command string.

The parser is biased in one direction on purpose: **a path it is not sure about
is dropped.** A missed touch leaves a region dark; an invented one lights up the
wrong part of somebody's map. Three filters, all of which must pass:

1. The token survives cleaning. Dropped: flags (`-n`, `--recursive`), globs it
   cannot resolve (`*.py`), URLs, `$VAR` and `` `subshells` ``, `FOO=bar`
   assignments, git refs and ranges (`HEAD:f.py`, `main..HEAD`), `~`, `/dev/*`,
   `/proc/*`, `/sys/*`. Quotes, `&&`/`||`/`|`/`;` chains and redirects are
   handled by a quote-aware lexer, so `cat a.py|grep x` comes apart correctly.
   Arguments of commands that only ever *name* a file — `echo`, `printf`,
   `curl`, `mkdir`, `cd` — are skipped entirely.
2. Its extension is one the map tracks — or it has no extension at all and the
   command is a known reader, which is what picks up `cat Makefile`.
3. **The file exists on disk.** This is the filter that stops paths being
   invented.

| command | reported |
|---|---|
| `cat src/flask/app.py` | `src/flask/app.py` |
| `grep -n import a.py b.py` | `a.py`, `b.py` |
| `sed -n '1,10p' tests/conftest.py` | `tests/conftest.py` |
| `cat a.py \| grep -c def && wc -l b.py` | `a.py`, `b.py` |
| `git log --oneline -5 -- src/app.py` | `src/app.py` |
| `cat Makefile` | `Makefile` |
| `rg -n --glob "*.py" TODO src/` | nothing — an unresolved glob and a directory |
| `git show HEAD:src/app.py` | nothing — a git ref, not a path |
| `curl -sL https://x.dev/app.py -o /tmp/app.py` | nothing — a URL and a file outside the repo |
| `echo "src/app.py"` | nothing — naming a file is not reading it |
| `for f in *.py; do head -1 $f; done` | nothing — unexpanded |
| `cat src/does_not_exist.py` | nothing — no such file |

Bounds: commands longer than 4 KB are not parsed at all, at most 400 tokens are
scanned, and at most 24 paths are reported per call. Extraction costs about
0.02 ms for a typical command and 0.7 ms for a 4 KB one; the hook still exits in
about 100 ms, the same as before.

`Bash` *output* is never scanned. A `find` or a `grep -r` would name hundreds of
files the agent never actually looked at.

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
map-room 0.3.0
Component inventory
  Skills (1)  map-room
  Hooks (3)  PostToolUse, UserPromptSubmit, Stop  (harness-only — no model context cost)
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
repo_id     : 5  (lookup)
repo_slug   : pallets/flask
git remote  : git@github.com:pallets/flask.git
agent_name  : claude
project_dir : /Users/you/src/flask
token       : found (534 chars)
sql /node   : ok, 16075 rows
sql /touch  : 79 rows
```

`repo_id : UNBOUND -- reporting nothing (not-indexed)` means exactly that: the
remote is real but has no map, so nothing is being sent. Run
`map_room_cli.py index`.

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
| `repo_id` | `MAP_ROOM_REPO_ID` | derived from the git remote — see above |
| `agent_name` | `MAP_ROOM_AGENT` | `claude` |
| `autoindex` | `MAP_ROOM_AUTOINDEX` | `false` |
| — | `MAP_ROOM_TOKEN` | read from `~/.config/spacetime/cli.toml` |
| — | `MAP_ROOM_STATE_DIR` | `~/.claude/map-room` (binding cache, markers) |

```json
{ "repo_id": 5, "agent_name": "claude-opus" }
```

`"repo_id": "auto"` (or leaving it out) means "derive it from the git remote".

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

`post_tool_use.py` takes `--debug`, which makes the reducer call synchronous
and prints what it extracted. `user_prompt_submit.py` always prints its JSON,
so just pipe a payload into it:

```bash
echo '{"session_id":"s1","cwd":"'"$PWD"'","hook_event_name":"PostToolUse",
       "tool_name":"Read","tool_input":{"file_path":"'"$PWD"'/README.md"}}' \
  | python3 plugin/scripts/post_tool_use.py --debug
```

```
tool=Read session=s1 project=/path/to/repo
paths=['README.md']
repo_id=5 slug=pallets/flask source=lookup
```

`--debug` resolves the binding synchronously, which is the quickest way to see
why a repo is or is not bound. A `Bash` payload works the same way:

```bash
echo '{"session_id":"s1","cwd":"'"$PWD"'","hook_event_name":"PostToolUse",
       "tool_name":"Bash","tool_input":{"command":"grep -n def src/app.py"}}' \
  | python3 plugin/scripts/post_tool_use.py --debug
```

An empty reducer response body means success.

## Notes

- Paths outside the project root are dropped, so a `Read` of `/etc/passwd` or a
  file in another repo is never reported.
- At most 40 paths per tool call (24 for `Bash`), so a wide `Grep` cannot flood
  the database.
- A checkout that is not bound to a repo sends nothing — not a heartbeat, not a
  touch, not a request query.
- A path that matches no node in the graph is still recorded as a `touch` with
  `node_id = 0`, so misses stay visible and countable rather than vanishing.
