# Product PRD — The Map Room

*Plain language. No code, no schemas. What this is, who it's for, and what a person
actually does with it.*

---

## The one-liner

**For engineers running AI coding agents — paste your repo and watch, with your
team, the map your agent is actually using, and the roads it can't see.**

---

## Who it's for

**Primary:** engineering teams who let an AI agent decide what to verify. If you run
Claude Code, Cursor, Aider, or any autonomous agent against a repository, and that
agent chooses which tests to run, this is for you.

**Tonight's beachhead:** builders in this room. Every one of them is shipping
AI-written code they have not verified, on a repo that is four hours old.

**Not for:** people who want a better code-analysis tool. This does not make the map
better. It makes the map *visible*, and it refuses to pretend the map is good.

---

## Why anyone should care

When an AI agent works on your code, it doesn't read everything. That would be slow
and expensive. Instead it builds a **map of your code** — which function calls which
— and uses that map to decide what to look at and what to skip.

If the map is missing a road, the agent skips the test that would have caught the
bug. The bug ships. Nothing warns you, because from inside the tool everything
looked complete.

Somebody checked. Across **172 real bug fixes** in 7 well-known open-source
projects, the map found the test that catches the bug **42% of the time**. The
simpler map that most tools actually use: **31%**. On two of those projects: **zero
percent**.

That number has been in a table in a report. Nobody has ever *watched it happen*.

---

## What the product does

You open a room. Anyone with the link is inside it with you — no account, no
password, no email. You pick a change. Then everyone in the room watches the same
thing at the same time:

The map lights up outward from the change. One step, then the next, then the next —
the way the agent would explore it. It spreads, peaks, narrows, and stops.

And then you see what it never reached.

The test that catches this exact bug is sitting right there, unlit. Not because the
search gave up early — it finished, completely — but because in this map, there is
no path to it.

Everyone in the room sees that at the same moment.

---

## Features

| | Feature | What the user gets |
|---|---|---|
| **F1** | **Join by link** | Open a URL and you're in. No signup, no password, no email. A name is optional. |
| **F2** | **See who's here** | Everyone in the room appears live, and disappears when they leave. |
| **F3** | **Pick a change** | Choose the file or function that was changed. This is the starting point. |
| **F4** | **Watch it spread** | The search paints outward step by step, on **everyone's screen at once**. Nobody refreshes. Nobody clicks anything to keep up. |
| **F5** | **See where it stops** | The moment it runs out — and whether it ran out of *budget* or ran out of *map*. Those are very different, and the product says which. |
| **F6** | **See what it missed** | The test that guards this bug, lit red, unreached. |
| **F7** | **Get the verdict** | A plain answer: *don't let the agent skip here — run everything.* With the number behind it. |
| **F8** | **Straight talk about the number** | Where a number can't honestly be computed, the product says so instead of inventing one. |
| **F9** | **Works on a phone** | The whole thing, on the device you actually have. |

---

## What a person does, start to finish

### The judge / the curious stranger — under 60 seconds

1. Opens the link. Lands on one sentence explaining what this is.
2. Clicks **Watch a live room**. No form, no wait.
3. Sees a real repository's map, and other people already in the room.
4. Clicks a change. Watches it spread and stop.
5. Reads the verdict and sees the missed test.

They now understand the problem, having *watched* it rather than been told.

### The builder with a team

1. Shares the room link with two teammates.
2. All three are in the same room, visibly.
3. One of them starts a search. **All three watch the same animation.**
4. They argue about the missed test, looking at the same screen.

The point of the room is that this is a conversation, not a report someone reads
alone.

---

## What it deliberately does not do

- **It doesn't fix your map.** The map it shows is deliberately the same kind of map
  the measurement indicts. Making a better one is a different product, and the
  evidence says a better one doesn't help much anyway.
- **It doesn't approve anything.** There is a path where it says "yes, the agent can
  skip here." It has never been reachable on real data, and it isn't faked open.
- **It doesn't guess.** On a repository with no known answer to check against, it
  says the number can't be computed here and shows what was measured elsewhere.

---

## How someone would find this

**Positioning:** the seatbelt for agent autonomy. Before an agent decides what not
to verify, something should ask whether it has earned that.

**First users:** the room, tonight. Everyone here is running an agent on a repo and
none of them can tell you what it isn't checking.

**After that:** the communities where people are already uneasy about this — Claude
Code and Cursor users, teams that turned on AI test selection and quietly turned it
back off.

---

## How we'd know it worked

- Someone who has never seen it finishes a search and explains the problem back,
  correctly, without help.
- Two people in the same room see the same animation at the same moment, and neither
  of them refreshes.
- Someone looks at the missed test and says *"wait, that's the one that matters."*

That third one is the whole product.
