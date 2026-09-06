// The Map Room — opencode plugin.
//
// `tool.execute.after` is run by the opencode runtime after every tool call.
// The model is not consulted and cannot opt out, which is what makes the
// coverage number mean something: a file that is dark on the map was not read.
//
// Docs: https://opencode.ai/docs/plugins/
//
// Install: this file goes at `.opencode/plugins/map-room.js` (project) or
// `~/.config/opencode/plugins/map-room.js` (every project you open).

import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const CLI =
  process.env.MAP_ROOM_CLI || join(homedir(), ".map-room", "map_room_cli.py")

// opencode's tool names -> the names the map already stores, so one repository's
// history does not fragment by which agent produced it.
const TOOL = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  patch: "Edit",
  multiedit: "Edit",
}

/**
 * Fire and forget. A detached child means the turn never waits on the network,
 * and a failure here can never fail the tool call that triggered it.
 */
function report(args, sessionID, cwd) {
  try {
    const child = spawn("python3", [CLI, "report", ...args, "--quiet"], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MAP_ROOM_SESSION: sessionID || "", MAP_ROOM_AGENT: "opencode" },
    })
    child.unref()
  } catch {
    // Never break a turn over coverage reporting.
  }
}

export const MapRoom = async ({ directory, worktree }) => {
  const root = worktree || directory

  return {
    "tool.execute.after": async (input) => {
      try {
        const tool = String(input?.tool || "").toLowerCase()
        const args = input?.args || {}

        // Shell is where most real reading happens — cat, grep, sed, head, rg.
        // The command string goes to the same parser the Claude Code hook uses:
        // it drops any token it is unsure about and checks the file exists, so
        // a missed touch leaves a region dark rather than lighting a wrong one.
        if (tool === "bash" && typeof args.command === "string") {
          report(["--bash", args.command], input.sessionID, root)
          return
        }

        const path = args.filePath || args.file_path
        if (typeof path !== "string" || !path) return
        report([path, "--tool", TOOL[tool] || "Read"], input.sessionID, root)
      } catch {
        // Same contract: silence beats a broken turn.
      }
    },
  }
}
