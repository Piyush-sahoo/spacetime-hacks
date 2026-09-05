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

HTTP surface (verified against the DEPLOYED module):
  POST https://maincloud.spacetimedb.com/v1/database/map-room/call/<reducer>
       body = positional JSON array.
       *** u64 ARGS MUST BE JSON NUMBERS, NOT STRINGS ***
       ["1", ...]  ->  400 invalid type: string "1", expected u64
       correct:    [2, "sess-id", "claude", "Read", "[\"django/forms/fields.py\"]"]
       paths_json / rows_json is DOUBLE-ENCODED: a JSON array *string*
       inside the positional array.
       ARG ORDER DIFFERS: report_touch(repo_id FIRST, ...) but
       agent_heartbeat(session, agent_name, repo_id LAST).
  POST https://maincloud.spacetimedb.com/v1/database/map-room/sql
  Auth: Bearer token from ~/.config/spacetime/cli.toml

## RULES
- Do NOT run `spacetime publish map-room -c` — it wipes the loaded graphs.
- Verify APIs with `npx ctx7@latest docs /clockworklabs/spacetimedb "<q>"`. Never guess.
- Never mention "substrate", "friction", "hydra" or "lineage" anywhere.
- Coverage before the return path. Ship what works.

---

## VERIFIED: procedures work on deployed Maincloud (tested, not assumed)

Proven with a throwaway module `proctest-piyush`:

```
spacetime call proctest-piyush fetch_tree '"django"' '"django"'
  -> "status=200 files=10361"     in 3.2 seconds, unauthenticated
```

The procedure fetched the GitHub trees API, parsed 10,361 file paths, and wrote a row
transactionally — all inside SpacetimeDB. **The no-backend architecture is real.**

### Facts learned, do not re-derive

1. **Procedure names are SNAKE_CASED on the wire.** `export const fetchTree` is called
   as `fetch_tree`. Same convention as reducers.
2. Signature that works:
   ```typescript
   export const fetchTree = spacetimedb.procedure(
     { owner: t.string(), repo: t.string() },   // args
     t.string(),                                 // return type
     (ctx, { owner, repo }) => {
       const res = ctx.http.fetch(url, { method:'GET', headers:{...} });
       const status = res.status;
       const data = res.json();
       ctx.withTx(tx => { tx.db.someTable.insert({...}); });
       return `...`;
     }
   );
   ```
3. `ctx.http.fetch(url, {method, headers, body, timeout})` — `res.status`, `res.json()`.
4. `ctx.withTx(tx => ...)` for the transactional write. Fetch FIRST, then withTx.
5. GitHub needs a `User-Agent` header. `Accept: application/vnd.github+json`.
6. Unauthenticated works fine (60 req/hr). Pass a PAT for headroom or private repos.
7. `spacetime build` prints "tsc not found in node_modules" as a WARNING and still
   succeeds — it is not an error, ignore it (or add typescript as a devDependency).
8. Publishing a NEW module needs `--yes` for the non-local-server confirmation.

### The GitHub trees API

```
GET https://api.github.com/repos/{owner}/{repo}/git/trees/HEAD?recursive=1
-> { tree: [{path, type:"blob"|"tree", sha, size}], truncated: bool }
```
One call = every file path in the repo. django/django = 10,361 entries in 3.2s.
`truncated: true` must be recorded and surfaced, never silently ignored.

---

## VERIFIED: hook payload fields, subagents, and the Bash blind spot

Measured by instrumenting the live hook and running a real subagent. Do not re-derive.

### PostToolUse payload — every field, confirmed

```
cwd  duration_ms  effort  hook_event_name  permission_mode  prompt_id
session_id  tool_input  tool_name  tool_response  tool_use_id  transcript_path
agent_id     <- PRESENT ONLY FOR SUBAGENTS
agent_type   <- PRESENT ONLY FOR SUBAGENTS  (e.g. "general-purpose")
```

### Subagents inherit the parent session_id

A subagent's tool calls fire the hook with the **same `session_id` as the parent**, plus
`agent_id` and `agent_type`. Verified: a subagent's three `Read` calls landed under the
parent session.

**So the discriminator is the presence of `agent_id`:**

| | main agent | subagent |
|---|---|---|
| `session_id` | parent | parent (same) |
| `agent_id` | absent | stable per-subagent id |
| `agent_type` | absent | e.g. `general-purpose` |

This is what makes "main agent one colour, each subagent its own colour" buildable: colour
by `agent_id`, with absence meaning the main agent.

### THE BASH BLIND SPOT — the biggest coverage gap

The hook matches `Read|Edit|Write|Grep|Glob`. **It does not match `Bash`.** Every `cat`,
`grep`, `sed`, `head` and `rg` an agent runs is invisible to the map.

Measured impact: a session whose subagents read hundreds of files recorded **8 touches**,
because the agents were using shell commands rather than the file tools.

Fixing this is worth more than any other coverage change. It means matching `Bash` and
parsing file paths out of the command string — imperfect, but the alternative is missing
most of an agent's real exploration.

### Repo binding

`repo_id` currently defaults to `1`. **This is dangerous at scale**: every teammate who
installs without config reports onto the django map, polluting everyone's coverage and
making the leaderboard meaningless.

Correct behaviour: derive the repo from `git remote get-url origin` -> `owner/repo`, which
is exactly the slug `index_repo` writes. If the remote is not indexed, stay silent rather
than defaulting to someone else's map.

### Branches

One map per repo; the branch is metadata. A file that exists on a feature branch but not
in the indexed tree resolves to `node_id = 0`. Rather than dropping it, it should be added
to the map as **new territory** in a distinct style -- which covers new files, PR additions
and index misses with one mechanism, and reads as new land appearing rather than a bug.
