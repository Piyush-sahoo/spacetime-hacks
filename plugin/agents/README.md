# The Map Room — four agents

The map does not care which agent lit it. What differs between tools is only
*how the reporting command gets called*, so nothing here reimplements the
transport: every integration shells out to the same two standard-library Python
files that the Claude Code plugin uses.

```
  any agent  ──►  map_room_cli.py report / agent_hook.py
                        │
                        ▼
              report_touch (SpacetimeDB)  ──►  the map lights up
                        ▲
  human clicks a dark region  ──►  exploration_request  ──►  claim / complete
```

## Enforced or cooperative

**Enforced** means the tool itself runs a command on a lifecycle event. The
model is never asked and cannot opt out, so a region that is dark on the map
really was not read. **Cooperative** means the agent has been *instructed* to
report and can simply forget. Both write identical rows; only one of them is a
guarantee, and the difference is worth saying out loud.

| Agent | Coverage | Mechanism | Docs |
|---|---|---|---|
| **Claude Code** | **Enforced** | `PostToolUse` hook on `Read\|Edit\|Write\|Grep\|Glob\|Bash`, plus `UserPromptSubmit`, `Stop`, `SessionEnd`, `SubagentStop` | [hooks](https://docs.claude.com/en/docs/claude-code/hooks) |
| **Codex** | **Enforced** | `PostToolUse` in `.codex/hooks.json`. Needs a one-time trust via `/hooks` | [hooks](https://developers.openai.com/codex/hooks) |
| **Cursor** | **Enforced** | `beforeReadFile`, `afterFileEdit`, `afterShellExecution` in `.cursor/hooks.json` | [hooks](https://cursor.com/docs/hooks) |
| **opencode** | **Enforced** | plugin `tool.execute.after` in `.opencode/plugins/map-room.js` | [plugins](https://opencode.ai/docs/plugins/) |
| *anything else* | **Cooperative** | the agent calls `map_room_cli.py report <path>...` itself | — |

**Answering the human's clicks is cooperative on all four.** No hook can read a
file for you: claiming a request, exploring the path and writing the finding is
the model's job everywhere. Claude Code gets pending requests *delivered* by a
`UserPromptSubmit` hook; the other three are told to run `pending` themselves,
from `AGENTS.md` or a Cursor rule.

## Install

Everything below assumes Python 3 (standard library only — nothing to pip
install) and a SpacetimeDB login:

```bash
spacetime login        # writes the token into ~/.config/spacetime/cli.toml
```

### Claude Code — a real plugin

```bash
claude plugin marketplace add Piyush-sahoo/spacetime-hacks
claude plugin install map-room@map-room
# restart Claude Code, or /reload-plugins — hooks load at session start
```

Details in [`claude-code/README.md`](claude-code/README.md) and the full notes
in [`../README.md`](../README.md).

### Codex

```bash
cd /path/to/your/repo
curl -fsSL https://raw.githubusercontent.com/Piyush-sahoo/spacetime-hacks/main/plugin/agents/install.sh | sh -s -- codex
```

Writes `.codex/hooks.json` and appends the protocol to `AGENTS.md`.

Then, **inside Codex, run `/hooks` and trust the hook.** Codex will not run a
hook definition it has not been told to trust, and editing the file re-arms that
prompt. This is the one manual step in the whole set, and it is a good one: a
hook is a command, and a tool that ran arbitrary commands out of a file somebody
curled would be a worse tool.

Codex hooks can also be disabled wholesale with `[features] hooks = false` in
`config.toml`. If nothing is arriving, check that first.

### Cursor

```bash
cd /path/to/your/repo
curl -fsSL https://raw.githubusercontent.com/Piyush-sahoo/spacetime-hacks/main/plugin/agents/install.sh | sh -s -- cursor
```

Writes `.cursor/hooks.json`, the hook body at `.cursor/hooks/map-room.sh`, and
an always-applied rule at `.cursor/rules/map-room.mdc`. Reload the window.

Three events, chosen to be **disjoint**: `beforeReadFile`, `afterFileEdit` and
`afterShellExecution`. `postToolUse` is deliberately not wired — it fires for the
same calls and would double every touch. The hook body writes nothing to stdout
and always exits 0: Cursor parses a hook's stdout as a permission decision, and
coverage reporting has no business allowing or denying a tool call.

### opencode

```bash
cd /path/to/your/repo
curl -fsSL https://raw.githubusercontent.com/Piyush-sahoo/spacetime-hacks/main/plugin/agents/install.sh | sh -s -- opencode
```

Writes `.opencode/plugins/map-room.js` and appends the protocol to `AGENTS.md`.
Restart opencode — plugins load at startup. For every project rather than one,
move the file to `~/.config/opencode/plugins/map-room.js`.

### Anything else

```bash
curl -fsSL https://raw.githubusercontent.com/Piyush-sahoo/spacetime-hacks/main/plugin/agents/install.sh | sh
```

Transport only. Read `~/.map-room/MAP-ROOM.md`, wire it into whatever hook your
tool has, or hand the file to the agent and let it report itself:

```bash
python3 ~/.map-room/map_room_cli.py report src/app.py tests/test_app.py --quiet
python3 ~/.map-room/map_room_cli.py report --bash "grep -n TODO src/app.py"
```

An agent that reports itself is a real integration. It is just a cooperative
one, and the README says so rather than pretending otherwise.

## What the installer puts where

| File | Goes to | Why there |
|---|---|---|
| `../scripts/map_room.py` | `~/.map-room/` | the transport: binding, reporting, requests |
| `../scripts/map_room_cli.py` | `~/.map-room/` | `report`, `pending`, `claim`, `complete`, `doctor`, `index` |
| `../scripts/agent_hook.py` | `~/.map-room/` | one hook body that speaks Codex's and Cursor's payload dialects |
| `MAP-ROOM.md` | `~/.map-room/`, and into `AGENTS.md` | the protocol, as instructions |
| `codex/hooks.json` | `<repo>/.codex/hooks.json` | project-scoped, so it is reviewable in the diff |
| `cursor/hooks.json` | `<repo>/.cursor/hooks.json` | same |
| `cursor/hooks/map-room.sh` | `<repo>/.cursor/hooks/map-room.sh` | Cursor project hooks run from the repo root |
| `cursor/map-room.mdc` | `<repo>/.cursor/rules/map-room.mdc` | `alwaysApply: true` |
| `opencode/map-room.js` | `<repo>/.opencode/plugins/map-room.js` | opencode scans that directory at startup |

An existing file that does not already mention `map-room` is copied to
`<name>.before-map-room` before it is replaced. `AGENTS.md` is appended to, not
overwritten, and the appended block is fenced with `<!-- map-room -->` so
re-running the installer is a no-op.

## Checking it

```bash
python3 ~/.map-room/map_room_cli.py doctor      # what did this checkout bind to?
python3 ~/.map-room/map_room_cli.py coverage    # explored versus dark
```

`repo_id : UNBOUND -- reporting nothing (not-indexed)` is not a failure. There is
deliberately **no default repository id**: a checkout whose remote nobody has
indexed reports nothing at all rather than dumping its file reads onto somebody
else's map. Build the map with `map_room_cli.py index`, then `rebind`.

## What every integration shares

- **Stdlib Python only.** No pip, no virtualenv, no daemon.
- **Fire and forget.** The network call happens in a detached child with a
  two-second timeout. A Map Room that is down costs a fork and nothing else.
- **Silent on every error path.** No token, no network, database down, malformed
  payload: exit 0, no output.
- **Paths outside the repository root are dropped**, and a path the `Bash`
  parser is unsure about is dropped too. A missed touch leaves a region dark; an
  invented one lights up the wrong part of somebody's map.
