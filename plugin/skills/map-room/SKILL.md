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

### 3. Complete it

Write the findings back. Keep it to a tight paragraph or a few lines; it renders
on the human's map, not in a terminal.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/scripts/map_room_cli.py" complete <request_id> "findings text"
```

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
- **The user's own prompt still comes first.** A pending request is not an
  interrupt. If the user asked for something else, mention the request and ask
  whether to handle it now.
- **Never call `report_touch` manually.** The hook owns coverage. Hand-written
  touches would report regions nobody read.
