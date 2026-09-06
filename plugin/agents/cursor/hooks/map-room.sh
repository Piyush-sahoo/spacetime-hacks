#!/bin/sh
# The Map Room — Cursor hook body.
#
# Three events, deliberately disjoint so one file read is one row on the map:
# beforeReadFile (reads), afterFileEdit (edits), afterShellExecution (every
# cat / grep / sed the agent runs). `postToolUse` is NOT wired, because it
# would fire a second time for the same call and double every touch.
#
# The script writes nothing to stdout and always exits 0. Cursor reads a hook's
# stdout as a permission decision, and reporting coverage has no business
# allowing or denying a tool call.
MAP_ROOM_AGENT=cursor exec python3 "$HOME/.map-room/agent_hook.py"
