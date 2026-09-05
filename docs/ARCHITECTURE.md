# Architecture

**There is no backend.**

Not "a thin backend". Not "serverless functions". The database fetches your repository,
indexes it, serves every client, runs the graph traversal, tracks who is in the room,
and calls the AI. Every line of server logic is a reducer or a procedure inside
SpacetimeDB.

---

## The whole system

```mermaid
flowchart TB
    subgraph gh["GitHub"]
        API["trees API<br/>every file path, one call"]
        RAW["file contents"]
    end

    subgraph stdb["SpacetimeDB · map-room · Maincloud"]
        direction TB
        PROC["PROCEDURES<br/>index_repo · summarize_region<br/>(outbound HTTP)"]
        RED["REDUCERS<br/>report_touch · start_walk · step_walk<br/>request_exploration · claim · complete"]
        TBL[("TABLES<br/>node · edge · node_cov · touch<br/>walk · frontier · verdict<br/>participant · agent_session<br/>exploration_request")]
        PROC --> TBL
        RED <--> TBL
    end

    subgraph agent["The AI agent · local CLI"]
        HOOK1["PostToolUse hook"]
        HOOK2["UserPromptSubmit hook"]
        HOOK3["Stop hook"]
        SUB["scoped subagent"]
    end

    subgraph room["The room"]
        S1["your screen"]
        S2["teammate's laptop"]
        S3["phone"]
    end

    API -.->|"ctx.http.fetch"| PROC
    RAW -.->|"ctx.http.fetch"| PROC
    PROC -.->|"Gemini: what does this file do"| GEM["Gemini API"]

    HOOK1 -->|"report_touch"| RED
    RED -.->|"subscription push"| S1
    RED -.->|"subscription push"| S2
    RED -.->|"subscription push"| S3

    S1 -->|"click a dark region"| RED
    RED -.->|"pending request"| HOOK2
    RED -.->|"pending request"| HOOK3
    HOOK3 --> SUB
    SUB -->|"explores, reports touches"| HOOK1

    style TBL fill:#1e3a5f,color:#fff
    style PROC fill:#7c2d12,color:#fff
    style RED fill:#1e3a5f,color:#fff
```

---

## Three flows

### 1. Terrain — a repo becomes a map

```
paste github.com/owner/repo
   ↓
procedure index_repo(owner, repo, token)
   ctx.http.fetch("api.github.com/repos/{o}/{r}/git/trees/HEAD?recursive=1")
   ↓  one call returns EVERY file path in the repo
   ctx.withTx(tx => insert one node per source file)
   ↓
the map exists — dark, but real
```

No clone. No tarball. No parser. One HTTP request from inside the database, and a
repository of any language is on the map in seconds. `truncated: true` on very large
repos is recorded on the repo row and surfaced, never silently ignored.

**Measured, live:**

| repo | blobs | source files | wall time |
|---|---:|---:|---:|
| `django/django` | 7,087 | 2,975 | 3.6 s |
| `honojs/hono` | 486 | 356 | 3.2 s |
| `pallets/flask` | 236 | 83 | 3.3 s |
| `Piyush-sahoo/spacetime-hacks` | 214 | 70 | 3.5 s |

Time is dominated by the GitHub round trip, not repo size — 46 blobs and 7,087 blobs
both land around 3.3 s. It works **unauthenticated**, so an anonymous visitor can paste
a URL and get a map.

### 2. Light — the agent's attention becomes visible

```
agent Reads / Edits / Greps a file
   ↓  PostToolUse hook (fire-and-forget, ~99ms, errors swallowed)
report_touch(repo_id, session, agent_name, tool, paths_json)
   ↓  resolves the path to EVERY node in that file
node_cov rows → subscription → every screen lights up
```

The hook is the only thing that can see this. **`git diff` cannot** — it shows what
*changed*, and the product is about what was *looked at*, and above all what was never
opened at all. A file the agent read and dismissed leaves no trace in git. A file it
never opened leaves no trace anywhere.

### 3. Correction — a human steers the agent

```
you tap a dark region
   ↓
request_exploration(repo_id, node_id, note)     → pending, amber on every screen
   ↓
the agent finds out (three paths, below)
   ↓
claim_request                                    → claimed, cyan, "EXPLORING"
   ↓
subagent explores → fires the coverage hook      → the region lights up
   ↓
complete_request(result)                         → done, green, "REPORTED"
```

---

## How a click reaches a turn-based agent

An AI agent cannot hold a subscription — it works in turns. So the human → agent
direction is a **pull at turn boundaries**, three ways:

| Path | Fires when | Covers |
|---|---|---|
| `UserPromptSubmit` | you type anything | the agent is idle and you speak to it |
| `Stop` | the agent finishes a turn | **the agent is working, then goes quiet** |
| subscriber daemon | instantly, on insert | nobody is at the keyboard at all |

The `Stop` hook is the important one: without it, a request made while the agent is
mid-task is never seen, because the agent finishes and falls silent.

The agent → human direction is a **true push**. Coverage lands on every screen the
moment the reducer commits.

---

## What Gemini is and is not used for

| | |
|---|---|
| **Used for** | one-sentence summaries of a dark region — *"handles password reset token validation"* — so unexplored territory has meaning, not just a filename |
| **Never used for** | extracting the call graph |

Parsing is deterministic and must stay that way. A hallucinated call edge would corrupt
the exact thing this product measures. The API key is passed as a procedure argument
and is never written to a file or committed.

---

## The leaderboard

Ranked by **human saves** — completed exploration requests. How many times someone
pointed at a dark region and the agent found something there.

Deliberately *not* ranked by coverage percentage. A coverage leaderboard rewards an
agent that reads everything, which wastes context and contradicts the measurement this
product is built on: at 400 kept identifiers a repo map reaches 2/44 guarding tests,
so *more reading* is not the fix. It is also incomparable across repo sizes — 80% of a
20-file project is not 80% of django.

Human saves is a real count, comparable across any repo, and climbing it requires using
the loop.

---

## What we did not have to build

| Normally | Here |
|---|---|
| REST API in front of the graph | reducers |
| WebSocket server + reconnect logic | subscriptions |
| Pub/sub fan-out (Redis, Kafka) | subscriptions |
| Presence service with heartbeats | `identity_connected` / `identity_disconnected` |
| A job runner for the graph walk | `step_walk`, one hop per call |
| A backend to fetch and index repos | procedures with `ctx.http.fetch` |
| A cache and its invalidation | the tables are the state |
| Any deployed server process | none |

The client is a static bundle. The plugin is four Python scripts. Everything else is
the database.

---

## Verified constraints

| Constraint | Consequence |
|---|---|
| Procedures cannot hold a transaction while fetching | fetch first, then `ctx.withTx` |
| `ctx.http.fetch` default 30s timeout, max 180s | large repos need the tree API, not a clone |
| `node.id` is a **global** primary key, not per-repo | every indexed repo needs its own id band, or nodes collide and vanish |
| SpacetimeDB SQL has no `GROUP BY`, aggregates need aliases | roll up client-side from subscribed rows |
| Browsers cannot set `Authorization` on a WebSocket | public tables, or a token via query param |
| u64 reducer args must be JSON **numbers**, not strings | `["1", …]` → `400 invalid type` |
| GitHub unauthenticated is 60 req/hr | fine for a room; a PAT raises it to 5,000 |

---

## The integration seam most likely to break

The indexer writes `node.qual`; `report_touch` resolves a touched file path by dotting
it and matching nodes whose `qual` ends with that dotted path:

```
src/lib/auth.ts   →  strip extension  →  src/lib/auth
                  →  slashes to dots  →  src.lib.auth
                  →  match nodes whose qual ends with it
```

If the indexer and the resolver disagree by so much as a leading `./`, **every touch
resolves to `node_id = 0`, the map stays dark, and every component reports success.**

**Solved by construction:** `index_repo` does not reimplement the rule — it calls the
same `dottedPath()` function the resolver uses. There is one implementation, so the two
sides cannot drift. Verified end to end against freshly indexed repos: real paths resolve
to real node ids, and a deliberate miss still writes `node_id = 0` so it stays countable.

## Repo binding — how a checkout finds its map

The plugin resolves which map to report to, in this order:

1. `MAP_ROOM_REPO_ID` env var or `repo_id` in `.map-room.json` — the escape hatch.
2. `git remote get-url origin` → `owner/repo` → look up the repo with that slug. This is
   exactly the slug `index_repo` writes, so the two sides match with **zero configuration**.
3. Otherwise: **report nothing and stay silent.** There is no fallback default — a
   default would mean every unconfigured install polluting someone else's map.

Cached per checkout, invalidated when `.git/config` changes, and resolved off the hot
path so a tool call is never blocked.

## What the hook can and cannot see

The `PostToolUse` hook matches `Read | Edit | Write | Grep | Glob | Bash`.

`Bash` matters more than it looks: an agent that explores with `cat`, `grep` and `sed`
is invisible without it. Measured before the fix — a session whose subagents read
hundreds of files recorded **8 touches**.

Bash paths are extracted conservatively: the token must survive quote-aware parsing,
carry a tracked extension (or be a known extensionless read like `cat Makefile`), and
**exist on disk**. Globs, URLs, git refs (`HEAD:file.py`) and `echo`-style mentions are
dropped. Under-reporting is preferred to inventing a path, because a wrong touch lights
the wrong region of someone's map.

## Who touched it — main agent vs subagents

Subagent tool calls fire the hook with the **parent's `session_id`**, plus `agent_id` and
`agent_type` which are absent for the main agent. That absence is the discriminator.

The actor is encoded into the existing string columns as `session/actor` rather than
added as a new column — adding a column to a populated table forces a destructive
republish, and the loaded graphs are not expendable. A row with no `/` is the main agent,
which is every row written before the feature existed, so it is backwards compatible by
construction.

## New territory

A file on a feature branch that is not in the indexed tree cannot resolve. Rather than
vanishing, it is minted as a node and drawn as **new ground** in a distinct style —
covering new files, PR additions and index misses with one mechanism.

New land is allotted from the top of the repo's id band counting down, while `index_repo`
allots from the bottom counting up, a billion ids apart against fuses of 4,000 and 512 —
so they cannot collide. Geography does not reflow when it appears: measured at
**0.000000px** movement of existing nodes.
