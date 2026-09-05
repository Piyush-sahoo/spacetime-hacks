# The Map Room — build contract (authoritative, do not deviate)

**One-liner:** For engineers running AI coding agents — paste your repo and watch,
with your team, the map your agent is actually using, and the roads it can't see.

**Deadline:** 19:00 IST today. Solo builder. Ship the vertical slice, cut everything else.

## The core loop (the ONLY thing that must work)
Two browser tabs open the same room. One clicks a changed file. A reducer runs a
bounded k=6 BACKWARDS walk over the call graph, writing each hop into a `frontier`
table. Both tabs watch the walk paint hop-by-hop. It exhausts. The verdict lands on
both screens: RUN_FULL, with the guarding test it never reached lit red.

## Lineage (reused from substrate-friction, already copied into this repo)
- `src/friction/gate.py` — `select_tests()` is the BFS being ported; `wilson_lb()` used verbatim
- `src/friction/loader.py` — batching pattern (clamp batches to <=1000)
- `data/shipped/arms/<instance>/{nodes,edges}.ndjson.gz` — the seed graphs
- `data/shipped/arms/manifest.jsonl` — carries `fix_site_ids` + `test_target_ids` (the labels)
- Measured priors to display: arm A pooled recall **0.314** (37/118), arm B **0.419** (72/172), n=172, 7 repos.

## Seed data format (verified)
nodes.ndjson: {"label":"Function","id":10000000000,"sid":"...","name":"setup","qual":"django.__init__::setup"}
  label is one of: Function | Class | File | Test | ConfigKey
edges.ndjson: {"src":10000000000,"dst":10000000001,"type":"CALLS","weight":1}
django__django-10097 arm_a = 20813 nodes, 40039 edges.

## Module schema (TypeScript, spacetimedb/server) — THE CONTRACT
Table names and column names below are FINAL. Client and seeder both depend on them.

repo:        id u64 pk autoInc, slug string, label string, node_count u32,
             edge_count u32, reachability f32, status string   // "loading"|"ready"
node:        id u64 pk, repo_id u64, kind string, name string, qual string
edge:        id u64 pk autoInc, repo_id u64, src u64, dst u64, kind string
participant: identity identity pk, name string, repo_id u64, focus_node u64,
             online bool
walk:        id u64 pk autoInc, repo_id u64, origin u64, k u32, hop u32,
             selected u32, graph_complete bool, done bool, started_by identity
frontier:    id u64 pk autoInc, walk_id u64, hop u32, node_id u64, is_test bool
verdict:     id u64 pk autoInc, walk_id u64, decision string, recall_prior f32,
             wilson_lb f32, threshold f32, reason string, missed_test u64

All tables public: true.

## Reducers (names FINAL)
create_repo(slug, label)                -> inserts repo row, status "loading"
ingest_nodes(repo_id, rows_json)        -> rows_json is a JSON array string, batch insert
ingest_edges(repo_id, rows_json)        -> same
finish_repo(repo_id, reachability)      -> status "ready", sets counts
join_room(name, repo_id)                -> upsert participant, online true
set_focus(node_id)                      -> update caller's participant.focus_node
start_walk(repo_id, origin, k)          -> insert walk (hop 0), seed frontier hop 0
step_walk(walk_id)                      -> expand ONE hop over predecessors, insert
                                           frontier rows, bump walk.hop. When the
                                           frontier is empty OR hop==k: set done,
                                           graph_complete, and INSERT THE VERDICT.
Lifecycle: identity_connected / identity_disconnected -> flip participant.online

## The walk (port of select_tests, direction matters)
Production code has NO edge to the test that guards it, so the walk runs along
PREDECESSORS (edge.dst == current, collect edge.src). Bound k=6. `graph_complete`
is true when the frontier exhausts BEFORE hitting k.

## The verdict
threshold = 0.95. Use wilson_lb(hits, n) with z=1.645 on the CARRIED PRIOR
(72 hits, 172 n -> lb ~= 0.355). 0.355 < 0.95 -> RUN_FULL, always, today.
reason must say: recall is not computable on an unlabelled repo; this cites the
measured prior across 172 labelled fixes in 7 repos.
missed_test = a node from the instance's `test_target_ids` that the walk never reached.

## Verified SpacetimeDB API facts (do NOT guess, these are checked)
TypeScript module:
```ts
import { schema, table, t } from 'spacetimedb/server';
const score_record = table({ name: 'score_record', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  owner: t.identity(),
  value: t.u32(),
});
const spacetimedb = schema({ score_record });   // ONE object, not spread args
export default spacetimedb;
export const addRecord = spacetimedb.reducer({ value: t.u32() }, (ctx, { value }) => {
  ctx.db.score_record.insert({ id: 0n, owner: ctx.sender, value });
});
```
Scaffold:  spacetime init --lang typescript --project-path ./module map-room
Publish:   spacetime publish map-room
Bindings:  spacetime generate --lang typescript --out-dir client/src/module_bindings
HTTP:      POST /v1/database/<name>/call/<reducer>   (args = positional JSON array)
           GET  /v1/database/<name>/schema
           POST /v1/database/<name>/sql
WS:        new WebSocket(url, 'v1.json.spacetimedb')   // text SATS-JSON protocol
NOTE: TypeScript (V8) modules do NOT support procedures, column defaults, or
row-level security. Do not use them.

## Rules
- ALWAYS verify SpacetimeDB API against real docs before writing code:
  `npx ctx7@latest docs /clockworklabs/spacetimedb "<question>"`
  Do not invent API surface. If unsure, check.
- Cut scope before you miss the deadline. The core loop beats every feature.
