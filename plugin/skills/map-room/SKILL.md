---
name: map-room
description: Handle exploration requests from the human watching The Map Room coverage map. Use when a turn opens with "[The Map Room] The human ... has asked you to explore these regions", when the user says to check/handle/answer map room requests or pending exploration requests, when asked what regions are dark or unexplored, or when asked to report coverage to the map.
---

# The Map Room — exploration request protocol

A human is watching a live map of this repository. Every file you read, edit or
search lights up. Everything you have not touched stays dark. When they want to
know what is behind a dark region they click it, and that click arrives here.

Your job is to answer those clicks: claim the request, go look, report back.

## The loop

```
human clicks a dark node
        |
        v
exploration_request  (status: pending)
        |
        |  UserPromptSubmit hook injects it into your context
        v
YOU:  claim_request  ->  spawn a scoped subagent  ->  complete_request
        |                          |
        |                          v
        |                   PostToolUse hook -> report_touch -> the region lights up
        v
status: done, with your findings, live on the human's screen
```

## What is already automatic

- **Coverage.** The `PostToolUse` hook reports every Read / Edit / Write / Grep /
  Glob to `report_touch`. You never call it by hand. Just doing the work lights
  the map.
- **Delivery.** The `UserPromptSubmit` hook injects pending requests at the top
  of the turn. If you see no such block, there is nothing pending.

What is *not* automatic is claiming, exploring, and completing. That is you.

## Handling a request

### 1. Claim it first

Claim before exploring, so the human sees the node flip from `requested` to
`claimed` immediately and knows you picked it up.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/scripts/map_room_cli.py" claim <request_id>
```

### 2. Explore with a scoped subagent

Spawn a subagent with the Task/Agent tool, scoped to that one path. Use the
`Explore` subagent type for read-only reconnaissance. Two reasons this is a
subagent and not you: the exploration stays out of your main context, and the
subagent's own Reads fire the coverage hook, so the region lights up while it
works.

Give the subagent a prompt shaped like this:

> Explore `<path>` in this repository. Report: what this file/module is for, its
> main entry points and exported names, what it depends on, what depends on it,
> and anything surprising or risky. Read the file itself and enough of its
> neighbours to be accurate. Do not modify anything.

If the request carries a note, the note is the human's actual question — answer
*that* specifically, not just the generic summary.

The subagent gathers the technical detail. You do not pass that detail through —
you translate it in step 3.

### 3. Complete it — 2-3 plain-language lines, never more

The person reading this does not write code. They are looking at a narrow column
next to a dozen other rows, and they have about five seconds. Your job is not to
prove you read the file. It is to tell them what the file is *for*.

Write **2 or 3 short lines. Never more.** One idea per line, each starting with a
verb. One newline between lines — the line breaks ARE the structure, and the
panel splits on them. No preamble, no markdown headings, no bullet characters
(the panel adds its own).

- **Line 1** — what this file is for, in one sentence.
- **Line 2** — the one thing worth knowing about it.
- **Line 3** — only if it genuinely earns its place: a risk or a surprise, in
  plain words. Two good lines beat three with filler.

**Plain language, strictly.** No function or API names, no config keys, no file
sizes, no line counts, no framework or tooling jargon, no acronyms. If a term
would not survive being read aloud to someone who does not code, it does not go
in. Say what it is FOR, not what it contains: "sets up how the app is built"
beats "one defineConfig call, no conditionals".

Keep each line under about 100 characters.

This is the shape:

```
Sets up how the app gets built and served.
Written so the site works from any web address without extra setup.
Ships the whole app as one big file, which makes the first load slower than it needs to be.
```

Not this shape — too technical, and too long:

```
Read client/vite.config.js — 9 lines, one defineConfig call, no conditionals.
Loads only @vitejs/plugin-react; nothing else touches the build.
Sets base './' so dist/ works from any path, which is why the Vercel deploy needs no rewrite rules.
Opens server and preview with host: true — that is what lets a phone on the LAN hit the dev server.
Risk: no build.outDir or manualChunks, so the 429 kB bundle ships as one chunk and stays unsplit.
```

Five lines is a wall, and `defineConfig`, `manualChunks` and `429 kB` are noise
to the person reading. Same file, same truth — the good version just says it in
words they already know.

Pass it with a real newline in the string. A quoted heredoc keeps the breaks
intact through the shell:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/scripts/map_room_cli.py" complete <request_id> "$(cat <<'EOF'
Sets up how the app gets built and served.
Written so the site works from any web address without extra setup.
Ships the whole app as one big file, which makes the first load slower than it needs to be.
EOF
)"
```

A single line is fine when there is only one thing worth saying. What does not
work is three ideas welded into one line, or a third line that adds nothing.

### 4. Tell the user

Say in your reply which regions you explored and the headline finding. The map
shows status; your reply carries the substance.

## Multiple requests

Claim them all up front, then explore. Independent paths can go to parallel
subagents in a single message — that is the good case, and the map lights up in
several places at once.

## Checking by hand

```bash
python3 "$CLAUDE_PLUGIN_ROOT/scripts/map_room_cli.py" pending     # what is waiting
python3 "$CLAUDE_PLUGIN_ROOT/scripts/map_room_cli.py" coverage    # explored vs dark
```

## Rules

- **Claim before you explore.** An unclaimed request looks ignored on the map.
- **Always complete what you claimed.** A stuck `claimed` row is worse than a
  pending one. If you cannot explore it — path gone, out of scope — complete it
  saying exactly that.
- **Never fabricate findings.** Read the code. The whole point of the map is
  that it distinguishes what was actually looked at from what was not.
- **Report in plain language, 2-3 lines, never more.** One idea per line,
  newline separated. No jargon, no API names, no file sizes — the reader does
  not write code. The panel splits on the newlines.
- **The user's own prompt still comes first.** A pending request is not an
  interrupt. If the user asked for something else, mention the request and ask
  whether to handle it now.
- **Never call `report_touch` manually.** The hook owns coverage. Hand-written
  touches would report regions nobody read.
