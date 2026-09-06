#!/bin/sh
# The Map Room — one command, any agent that is not Claude Code.
#
#   sh install.sh                 transport only
#   sh install.sh codex           transport + Codex hook + AGENTS.md
#   sh install.sh cursor          transport + Cursor hooks + .cursor rule
#   sh install.sh opencode        transport + opencode plugin + AGENTS.md
#
# The transport is three standard-library Python files. Nothing to pip install,
# no virtualenv, no daemon. Everything any agent needs is one command:
#
#     python3 ~/.map-room/map_room_cli.py report <path>...
#
# Hooks are written into the CURRENT REPOSITORY, because that is where all
# three tools look for project-scoped configuration. Nothing is installed
# globally except the transport itself.
#
# Claude Code is not handled here — it has a real plugin:
#     claude plugin marketplace add Piyush-sahoo/spacetime-hacks
#     claude plugin install map-room@map-room

set -e

AGENT="${1:-}"
SOURCE_REPO="${MAP_ROOM_SOURCE_REPO:-Piyush-sahoo/spacetime-hacks}"
BRANCH="${MAP_ROOM_SOURCE_BRANCH:-main}"
RAW="https://raw.githubusercontent.com/$SOURCE_REPO/$BRANCH/plugin"
DEST="${MAP_ROOM_HOME:-$HOME/.map-room}"
MARK="<!-- map-room -->"

say() { printf '[map-room] %s\n' "$*"; }

get() {
  # get <path under plugin/> <destination>
  mkdir -p "$(dirname "$2")"
  # Never silently overwrite somebody's own config. Keep a copy and say so.
  if [ -f "$2" ] && ! grep -q 'map-room' "$2" 2>/dev/null; then
    cp "$2" "$2.before-map-room"
    say "kept your existing $2 as $2.before-map-room"
  fi
  curl -fsSL "$RAW/$1" -o "$2"
  say "wrote $2"
}

append_agents_md() {
  # Codex and opencode both read AGENTS.md, and neither follows a file
  # reference inside it, so the text has to be inline. Idempotent on $MARK.
  if [ -f AGENTS.md ] && grep -qF "$MARK" AGENTS.md; then
    say "AGENTS.md already carries the Map Room section"
    return
  fi
  [ -f AGENTS.md ] && printf '\n' >> AGENTS.md
  printf '%s\n' "$MARK" >> AGENTS.md
  curl -fsSL "$RAW/agents/MAP-ROOM.md" >> AGENTS.md
  printf '%s\n' "$MARK" >> AGENTS.md
  say "appended the Map Room section to $(pwd)/AGENTS.md"
}

# ---------------------------------------------------------------- transport
mkdir -p "$DEST"
for f in map_room.py map_room_cli.py agent_hook.py; do
  curl -fsSL "$RAW/scripts/$f" -o "$DEST/$f"
done
curl -fsSL "$RAW/agents/MAP-ROOM.md" -o "$DEST/MAP-ROOM.md"
chmod +x "$DEST/map_room_cli.py" "$DEST/agent_hook.py"
say "transport installed at $DEST"

# ---------------------------------------------------------------- wiring
case "$AGENT" in
  codex)
    get "agents/codex/hooks.json" ".codex/hooks.json"
    append_agents_md
    say "ENFORCED: Codex runs this on PostToolUse."
    say "NEXT: run /hooks inside Codex and TRUST the hook — Codex will not run"
    say "      an untrusted hook definition, and editing it re-arms the prompt."
    ;;
  cursor)
    get "agents/cursor/hooks.json" ".cursor/hooks.json"
    get "agents/cursor/hooks/map-room.sh" ".cursor/hooks/map-room.sh"
    chmod +x .cursor/hooks/map-room.sh
    get "agents/cursor/map-room.mdc" ".cursor/rules/map-room.mdc"
    say "ENFORCED: beforeReadFile, afterFileEdit and afterShellExecution."
    say "NEXT: reload the Cursor window so it picks up .cursor/hooks.json."
    ;;
  opencode)
    get "agents/opencode/map-room.js" ".opencode/plugins/map-room.js"
    append_agents_md
    say "ENFORCED: the plugin's tool.execute.after runs on every tool call."
    say "NEXT: restart opencode — plugins are loaded at startup."
    ;;
  "")
    say "transport only. Pass codex, cursor or opencode to wire an agent up."
    say "Otherwise read $DEST/MAP-ROOM.md and call 'report' yourself."
    ;;
  *)
    say "unknown agent '$AGENT'. The transport is installed; read"
    say "$DEST/MAP-ROOM.md and wire it into whatever hook your tool has."
    ;;
esac

# ---------------------------------------------------------------- verify
say "checking what this checkout binds to"
python3 "$DEST/map_room_cli.py" doctor || true
