# The Map Room v2 — the agent loop (authoritative addendum to CONTRACT.md)

CONTRACT.md still holds. Nothing in it changes. This ADDS the bidirectional loop.

## The idea in one line

The AI agent publishes what it explores; the human sees the dark regions and clicks
one; that click reaches the agent, which spawns a subagent to go look.

```
agent  --(PostToolUse hook)-->  report_touch      -->  node_cov table
                                                        |  subscription
human  <----------------------------------------------- |
human  --(click a dark node)-->  request_exploration -->  exploration_request table
agent  <--(UserPromptSubmit hook injects pending)------- |
agent  --(spawns subagent, explores)--> report_touch / complete_request
```

## PRIORITY ORDER — build in this order, ship whatever is done

1. **Coverage** — the agent's touches land in SpacetimeDB, the client lights explored
   nodes and leaves the rest dark. THIS ALONE IS A COMPLETE DEMO. Protect it.
2. **The return path** — click a dark node -> request row -> agent picks it up.
3. Anything else.

## NEW TABLES (names FINAL)

```
node_cov      node_id u64 pk · repo_id u64 · touches u32 · last_tool string
              · last_session string · explored bool · last_at timestamp
touch         id u64 pk autoInc · repo_id u64 · node_id u64 · path string
              · tool string · session string · agent_name string · at timestamp
agent_session id u64 pk autoInc · session string · agent_name string · repo_id u64
              · online bool · touches u32 · started_at timestamp · last_at timestamp
exploration_request
              id u64 pk autoInc · repo_id u64 · node_id u64 · path string
              · note string · status string · asked_by identity
              · claimed_by string · result string · at timestamp
```
`exploration_request.status` is one of: `pending` | `claimed` | `done`.
All tables `public: true`. Index: `node_cov.repo_id`, `touch.repo_id`,
`exploration_request.repo_id`, `exploration_request.status`, `agent_session.session`.

## NEW REDUCERS (names FINAL)

```
report_touch(repo_id: u64, session: string, agent_name: string,
             tool: string, paths_json: string)
    paths_json is a JSON array STRING of repo-relative file paths.
    For each path: resolve to node ids (see PATH RESOLUTION), insert a `touch`,
    and upsert `node_cov` (touches += 1, explored = true, last_tool, last_at).
    Also upsert `agent_session` (online = true, touches += n, last_at).
    Must be cheap and idempotent-safe: called on EVERY agent tool use.

request_exploration(repo_id: u64, node_id: u64, note: string)
    Inserts an exploration_request with status "pending", asked_by = ctx.sender.
    If an identical pending request already exists for that node, do nothing.

claim_request(request_id: u64, agent_name: string)
    pending -> claimed, sets claimed_by. No-op if not pending.

complete_request(request_id: u64, result: string)
    claimed -> done, sets result.

agent_heartbeat(session: string, agent_name: string, repo_id: u64)
    Upserts agent_session, online = true, last_at = now.
```

## PATH RESOLUTION — the one tricky part

Nodes carry `qual` shaped like:
    data.repos.django.tests.forms_tests.field_tests.test_datetimefield::DateTimeFieldTest#test_datetimefield_1()
The part before `::` is a dotted module path.

Given a repo-relative file path `django/forms/fields.py`:
  1. strip a trailing `.py` / `.ts` / `.rs` / `.cs`
  2. replace `/` with `.`  ->  `django.forms.fields`
  3. match every node whose `qual` (before `::`) ENDS WITH that dotted path
     (endsWith, because shipped quals are prefixed with `data.repos.`)
Match ALL nodes in that file, not just one. A file touch lights the whole file.

If nothing matches, insert the `touch` row anyway with node_id = 0 so the miss is
visible and countable. Do not silently drop.

## CLIENT

- Every node renders in one of two states: **explored** (has a node_cov row with
  explored = true) or **dark**. This must update LIVE from the subscription as the
  agent works. That live spread is the money shot.
- A coverage summary: "N of M explored" plus a bar. Live.
- The agent appears in the presence rail as a participant (from `agent_session`),
  visibly distinct from humans.
- **Click a dark node -> call `request_exploration`.** The node immediately shows a
  "requested" state for everyone. When status flips to claimed, then done, that
  reflects live on every screen.
- Keep the existing walk/verdict UI working. Do not regress it.

## THE CLAUDE CODE PLUGIN

A real installable plugin at `plugin/` in this repo:
- `PostToolUse` hook on Read|Edit|Write|Grep|Glob -> extract file paths from the
  tool input, POST to `report_touch`. Must never block or fail the agent's turn:
  fire-and-forget, short timeout, swallow errors.
- `UserPromptSubmit` hook -> query pending `exploration_request` rows over the SQL
  endpoint and inject them into context as: "The human has asked you to explore
  these regions: ...". Only inject when there ARE pending rows.
- A SKILL that documents the protocol for the agent: claim a request, spawn a
  subagent scoped to that path, report findings, complete the request.

HTTP surface (already verified):
  POST https://maincloud.spacetimedb.com/v1/database/map-room/call/<reducer>
       body = positional JSON array; note rows_json / paths_json is a JSON STRING
  POST https://maincloud.spacetimedb.com/v1/database/map-room/sql
  Auth: Bearer token from ~/.config/spacetime/cli.toml

## RULES
- Do NOT run `spacetime publish map-room -c` — it wipes the loaded graphs.
- Verify APIs with `npx ctx7@latest docs /clockworklabs/spacetimedb "<q>"`. Never guess.
- Never mention "substrate", "friction", "hydra" or "lineage" anywhere.
- Coverage before the return path. Ship what works.
