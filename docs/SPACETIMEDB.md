# Where and how we use SpacetimeDB

The short answer: **the product is the database.** There is no application server,
no API layer, no WebSocket plumbing, and no separate cache. The graph is tables, the
algorithm is a reducer, and the UI is a subscription.

---

## The test that matters

Open two tabs. Click in one. Watch the other.

Nothing in tab 2 polls, refetches, or refreshes. Tab 2 never called a reducer. It is
subscribed to `frontier`, and the rows arrive as the walk in the module produces
them. The animation in tab 2 *is* the database changing.

```mermaid
flowchart TD
    T1["Tab 1 — clicks a node"] -->|"start_walk()"| R["step_walk reducer"]
    R -->|"one hop per call"| F[("frontier table")]
    F -.->|"subscription"| T1
    F -.->|"subscription"| T2["Tab 2 — clicked nothing"]
    F -.->|"subscription"| T3["Phone — clicked nothing"]

    style F fill:#1e3a5f,color:#fff
    style R fill:#1e3a5f,color:#fff
    style T2 fill:#166534,color:#fff
    style T3 fill:#166534,color:#fff
```

---

## 1. State lives in tables

The call graph is not a file we generate and serve. It is **rows**.

```
node   id · repo_id · kind · name · qual
edge   id · repo_id · src · dst · kind
```

`django__django-11292` is 2,272 node rows and 4,215 edge rows, resident in the
database. `django__django-10097` is 9,831 and 22,880. Anyone can subscribe to a
slice of them.

Because it's a real table, `edge.dst` carries a **btree index** — the column the
backwards walk rides. Without it, every hop is a full scan over 22,880 rows. This is
the part that would otherwise have been a graph database plus a cache plus an
invalidation strategy.

## 2. Logic lives in reducers

The walk is not a function in a Python process that returns a set. It is
`step_walk`, a reducer, executing **inside the database, in a transaction**:

```
next = { e.src | e.dst ∈ current_frontier } \ visited
```

One hop per call. Each hop writes its discovered nodes into `frontier` tagged with
the hop number. The verdict — the Wilson lower bound against the 0.95 bar — is
computed in the module and written to `verdict`.

Nothing about the decision happens client-side. A client that lied about the result
would be contradicted by the row everyone else can read.

## 3. Subscriptions drive the UI

The client renders from its local cache of subscribed rows. It does not fetch. When
`step_walk` inserts hop 3's nodes, every connected client's `frontier` cache gains
those rows and the UI repaints.

The verdict lands the same way — one row insert, N screens.

## 4. The agent writes to the same tables you read

This is the part that makes it a loop rather than a dashboard.

```
node_cov              what the agent has explored
touch                 every individual file it opened
agent_session         the agent, present in the room
exploration_request   a human pointing at a dark region
```

A `PostToolUse` hook in the agent's editor calls `report_touch` after every file
operation. A human clicks a dark node and calls `request_exploration`. **Neither side
knows the other exists** — they are both just clients of `map-room`, and the database
does the delivery.

The agent even appears in the presence rail, because `agent_session` is read the same
way `participant` is. It is in the room with you.

One honest constraint: an agent is turn-based and **cannot hold a subscription**, so
the human → agent direction is a pull at turn boundaries via a `UserPromptSubmit`
hook. The agent → human direction is a true push.

## 5. Presence is native

```
participant   identity · name · repo_id · focus_node · online
```

`identity_connected` and `identity_disconnected` are **lifecycle reducers** the
database calls for us. Who's in the room, and who just left, required no heartbeat,
no timeout sweeper, and no presence service.

`ctx.sender` gives the caller's identity inside every reducer, so `set_focus` knows
whose focus to update without the client asserting who it is.

## 6. The database fetches your repository itself

TypeScript modules support **procedures**, which can make outbound HTTP calls and then
write transactionally. So indexing does not need a backend — it happens inside the
database:

```typescript
export const indexRepo = spacetimedb.procedure(
  { owner: t.string(), repo: t.string(), token: t.string() }, t.string(),
  (ctx, { owner, repo, token }) => {
    const res = ctx.http.fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
    const tree = res.json();
    ctx.withTx(tx => { /* one node per source file */ });
  }
);
```

The GitHub trees API returns **every file path in the repository in a single call**.
No clone, no tarball, no parser — a repo of any language lands on the map in seconds.

The same mechanism calls Gemini for one-sentence summaries of dark regions, so
unexplored territory carries meaning rather than just a filename. The key is a
procedure argument, never stored.

Parsing stays deterministic and is never delegated to a model: a hallucinated call edge
would corrupt the exact relation this product measures.

## 7. Loading a prepared corpus over the HTTP API

The Python loader never opens a socket or learns a wire format. It POSTs:

```
POST /v1/database/map-room/call/ingest_nodes
Authorization: Bearer <token from ~/.config/spacetime/cli.toml>
["1", "[{\"id\":...,\"kind\":\"Function\",...}]"]
```

Batches of ≤1000 rows, ~700 node rows/s and ~2,000 edge rows/s. A full instance
loads in ~30 s across 35 calls.

It reads state back the same way, because reducers return nothing:

```
POST /v1/database/map-room/sql
SELECT id FROM repo WHERE slug = 'django__django-11292'
```

## 8. Introspection without bindings

Any client can read a module's shape at runtime:

```
GET /v1/database/map-room/schema     → every table and reducer signature
```

And subscribe over a raw socket with no generated code at all:

```js
new WebSocket(url, 'v1.json.spacetimedb')   // text SATS-JSON protocol
```

We use the generated TypeScript bindings for the app, but the zero-bindings path is
what makes a universal inspector possible at all.

---

## Features used, concretely

| SpacetimeDB feature | Used for |
|---|---|
| Tables as primary state | the call graph, walks, frontier, verdicts, presence, **agent coverage**, **exploration requests** |
| Reducers | the bounded backwards BFS; the verdict; ingest; **`report_touch` path resolution** |
| Transactions | one hop = one atomic state change every client sees identically |
| btree indexes | `edge.dst` for the walk; `frontier.walk_id` for the paint |
| Subscriptions | the entire UI — no polling anywhere |
| `identity_connected` / `identity_disconnected` | presence, for free |
| `ctx.sender` | attributing focus and walk ownership without client claims |
| `autoInc` primary keys | walk / frontier / verdict / edge ids |
| **Procedures + `ctx.http.fetch`** | **fetching and indexing a GitHub repo, and calling Gemini — with no backend anywhere** |
| HTTP `call/<reducer>` | the bulk loader |
| HTTP `/sql` | reading ids back |
| Maincloud | hosting; nothing else is deployed server-side |

---

## What we did **not** have to build

This is the honest measure of what the database bought:

- a WebSocket server, and a reconnect/resume story
- a pub/sub layer and a fan-out strategy
- a presence service with heartbeats and timeouts
- a REST API in front of the graph
- a cache, and its invalidation
- a job queue to run the walk asynchronously
- a way to push each hop to N clients in order
- a service to clone and index repositories
- any deployed backend at all

The module *is* all of that.

---

## Why this product can't exist without it

Not "would be harder without" — **cannot exist**.

The product is several people **and an AI agent** watching one map at the same
moment. The unit of value is the shared observation and the shared correction: you
see the agent's attention spread, you see where it stopped, you point — and it goes.

Strip the database out and ask what remains. The agent could log to a file; you could
read the file; you could message the agent. All of that exists already and none of it
is this product, because the value is the **simultaneity** — light spreading while
several people watch, and a tap everyone sees land.

A single-player version of this is a static picture. It's already been published as
a number in a table, and nobody looked. The thing that makes it land is watching it
happen, together — and that is exactly and only what live shared state provides.

The walk is also genuinely *in* the database rather than in front of it. The
frontier isn't a broadcast of a result computed elsewhere; it's the intermediate
state of an algorithm running in transactions, which is why every client sees the
same hops in the same order.

---

## Verify it yourself

```bash
spacetime sql map-room "SELECT id, slug, node_count, edge_count FROM repo"
spacetime sql map-room "SELECT id, hop, selected, graph_complete, done FROM walk"
spacetime sql map-room "SELECT COUNT(*) AS n FROM frontier WHERE walk_id = 6 AND hop = 2"
spacetime sql map-room "SELECT decision, wilson_lb, threshold, missed_test FROM verdict"
```

Live results at time of writing:

```
walk 6, origin 20220000873, k=6
  hop 0:   1    hop 2: 389    hop 4:  11
  hop 1:  58    hop 3:  57    → 416 nodes, frontier exhausted

  graph_complete = true      ← ran out of graph, not out of hops
  verdict        = RUN_FULL
  wilson_lb      = 0.35845506   threshold 0.95
  missed_test    = DateTimeFieldTest#test_datetimefield_1()
```
