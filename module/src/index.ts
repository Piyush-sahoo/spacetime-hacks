/**
 * The Map Room — SpacetimeDB TypeScript module.
 *
 * Table names, column names and reducer names are fixed by CONTRACT.md.
 * Client + seeder build against exactly these.
 */
import { schema, table, t } from 'spacetimedb/server';
import type { ReducerCtx } from 'spacetimedb/server';

// ---------------------------------------------------------------- constants

/** Carried prior: arm B pooled test->fix recall, 72 hits over n=172 labelled fixes, 7 repos. */
const PRIOR_HITS = 72;
const PRIOR_N = 172;
const PRIOR_REPOS = 7;
/** The safe-skip bar. */
const THRESHOLD = 0.95;
/** One-sided 95% bound. */
const Z = 1.645;

/**
 * One-sided 95% Wilson score lower bound on a binomial proportion.
 *
 * The gate skips only when THIS clears the bar, never the point estimate alone,
 * so a perfect tiny sample (3/3) can never license a skip.
 */
function wilsonLb(hits: number, n: number, z: number = Z): number {
  if (n === 0) return 0.0;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (centre - margin) / denom;
}

// ------------------------------------------------------------------ tables

const repo = table(
  { name: 'repo', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    slug: t.string().index('btree'),
    label: t.string(),
    node_count: t.u32(),
    edge_count: t.u32(),
    reachability: t.f32(),
    status: t.string(), // "loading" | "ready"
  }
);

const node = table(
  { name: 'node', public: true },
  {
    id: t.u64().primaryKey(),
    repo_id: t.u64().index('btree'),
    kind: t.string().index('btree'), // Function | Class | File | Test | ConfigKey
    name: t.string(),
    qual: t.string(),
  }
);

const edge = table(
  { name: 'edge', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    repo_id: t.u64().index('btree'),
    src: t.u64().index('btree'),
    dst: t.u64().index('btree'), // the index the backwards walk rides
    kind: t.string(),
  }
);

const participant = table(
  { name: 'participant', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    repo_id: t.u64().index('btree'),
    focus_node: t.u64(),
    online: t.bool(),
  }
);

const walk = table(
  { name: 'walk', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    repo_id: t.u64().index('btree'),
    origin: t.u64(),
    k: t.u32(),
    hop: t.u32(),
    selected: t.u32(),
    graph_complete: t.bool(),
    done: t.bool(),
    started_by: t.identity(),
  }
);

const frontier = table(
  { name: 'frontier', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    walk_id: t.u64().index('btree'),
    hop: t.u32(),
    node_id: t.u64(),
    is_test: t.bool(),
  }
);

const verdict = table(
  { name: 'verdict', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    walk_id: t.u64().index('btree'),
    decision: t.string(),
    recall_prior: t.f32(),
    wilson_lb: t.f32(),
    threshold: t.f32(),
    reason: t.string(),
    missed_test: t.u64(),
  }
);

// ------------------------------------------------------- v2: coverage tables

/** Per-node coverage state. One row per node the agent has actually touched. */
const node_cov = table(
  { name: 'node_cov', public: true },
  {
    node_id: t.u64().primaryKey(),
    repo_id: t.u64().index('btree'),
    touches: t.u32(),
    last_tool: t.string(),
    last_session: t.string(),
    explored: t.bool(),
    last_at: t.timestamp(),
  }
);

/** Append-only event log: one row per (tool call, path) the agent reported. */
const touch = table(
  { name: 'touch', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    repo_id: t.u64().index('btree'),
    node_id: t.u64(), // 0 == the path resolved to nothing (a countable miss)
    path: t.string(),
    tool: t.string(),
    session: t.string(),
    agent_name: t.string(),
    at: t.timestamp(),
  }
);

/**
 * Per-tool-call detail that will not fit in `touch`.
 *
 * `touch` is populated and its shape is frozen — adding a column to it forces a
 * destructive republish, and the loaded graphs are not expendable. So the extra
 * per-call fields live in a SEPARATE table keyed on `touch.id`, which is an
 * additive change and publishes with `--delete-data=never`.
 *
 * `duration_ms` is how long the tool call itself took, straight off the
 * PostToolUse payload. 0 means the hook did not know.
 */
const touch_meta = table(
  { name: 'touch_meta', public: true },
  {
    touch_id: t.u64().primaryKey(),
    repo_id: t.u64().index('btree'),
    duration_ms: t.u32(),
    tool_use_id: t.string(),
  }
);

/** An agent presence row, so agents show up in the room next to humans. */
const agent_session = table(
  { name: 'agent_session', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    session: t.string().index('btree'),
    agent_name: t.string(),
    repo_id: t.u64(),
    online: t.bool(),
    touches: t.u32(),
    started_at: t.timestamp(),
    last_at: t.timestamp(),
  }
);

/** The return path: a human points at a dark region, the agent picks it up. */
const exploration_request = table(
  { name: 'exploration_request', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    repo_id: t.u64().index('btree'),
    node_id: t.u64(),
    path: t.string(),
    note: t.string(),
    status: t.string().index('btree'), // "pending" | "claimed" | "done"
    asked_by: t.identity(),
    claimed_by: t.string(),
    result: t.string(),
    at: t.timestamp(),
  }
);

/**
 * Memo table for path resolution. NOT part of the client contract (private).
 *
 * report_touch fires on every agent tool use against up to ~10k nodes, and
 * agents re-read the same handful of files over and over. Resolving a path is a
 * scan; resolving it twice is waste. Key is `<repo_id>|<raw path>`.
 */
const path_cache = table(
  { name: 'path_cache', public: false },
  {
    key: t.string().primaryKey(),
    repo_id: t.u64().index('btree'),
    node_ids: t.array(t.u64()),
  }
);

/**
 * Provenance for a repo that `index_repo` put on the map, straight from GitHub.
 *
 * `truncated` is the honest flag: GitHub's trees API caps a single response, and
 * a capped tree means the map is a PARTIAL map. It is recorded machine-readably
 * here AND stamped into `repo.label`, because a map that quietly lies about its
 * own edges is worse than no map.
 */
const repo_index = table(
  { name: 'repo_index', public: true },
  {
    repo_id: t.u64().primaryKey(),
    owner: t.string(),
    repo: t.string(),
    ref: t.string(),
    files_seen: t.u32(), // blobs GitHub returned
    files_indexed: t.u32(), // source files that became nodes
    truncated: t.bool(), // GitHub truncated the tree
    capped: t.bool(), // we hit our own MAX_INDEX_FILES fuse
    at: t.timestamp(),
  }
);

/**
 * One-sentence description of what a file does, written by an LLM.
 *
 * A SEPARATE TABLE, not a `node.summary` column, on purpose: adding a column to
 * a populated table forces a destructive republish, and the four loaded graphs
 * are not expendable. A new table is an additive migration.
 *
 * Descriptions only. The call graph is never LLM-derived — a hallucinated edge
 * would corrupt the exact relation this product measures.
 */
const node_summary = table(
  { name: 'node_summary', public: true },
  {
    node_id: t.u64().primaryKey(),
    repo_id: t.u64().index('btree'),
    summary: t.string(),
    model: t.string(),
    at: t.timestamp(),
  }
);

/**
 * NEW TERRITORY — a path the agent touched that the indexed tree does not hold.
 *
 * One map per repo, built from the default branch. A file that only exists on a
 * feature branch, or was created five minutes ago, or that the indexer simply
 * missed, resolves to nothing — and `report_touch` used to record the miss as
 * `node_id = 0`, which is countable but invisible. Instead it now MINTS a node
 * for that path (kind `NewLand`) so the work shows up on the map as new ground.
 *
 * This table is the idempotency key: `<repo_id>|<path>` -> the node that was
 * minted for it, so the same path touched a thousand times mints exactly once
 * even if the resolver's memo was dropped.
 */
const new_land = table(
  { name: 'new_land', public: true },
  {
    key: t.string().primaryKey(), // `${repo_id}|${path}`
    repo_id: t.u64().index('btree'),
    node_id: t.u64(),
    path: t.string(),
    actor: t.string(), // who found it first
    at: t.timestamp(),
  }
);

/** Ordinal counter for minted new-land ids, one row per repo. Private. */
const new_land_seq = table(
  { name: 'new_land_seq', public: false },
  {
    repo_id: t.u64().primaryKey(),
    next: t.u32(),
  }
);

/**
 * What is actually INSIDE the file behind a node. Written by `enrich_repo`.
 *
 * A SIDE TABLE, not columns on `node`, for the same reason `touch_meta` and
 * `node_summary` are side tables: `node` holds 16k+ rows across 13 loaded
 * graphs, and adding a column to a populated table forces a destructive
 * republish that would wipe every one of them. A new table is additive and
 * publishes with `--delete-data=never`.
 *
 * `symbols` and `loc` are MEASURED -- a regex count of named callables and a
 * line count, both reproducible from the file. They are what block height is
 * computed from, so they have to be checkable rather than plausible.
 *
 * `summary`, `role` and `importance` are the model's, and stay `''` / `''` / 0
 * when no model was asked or the model did not answer for that file. A blank
 * summary is honest; a guessed one is not.
 */
const file_meta = table(
  { name: 'file_meta', public: true },
  {
    node_id: t.u64().primaryKey(),
    repo_id: t.u64().index('btree'),
    symbols: t.u32(), // named callables / types found by regex
    loc: t.u32(), // lines in the file as fetched
    summary: t.string(), // one sentence, model-written; '' when unknown
    role: t.string(), // entry|config|model|view|controller|test|util|generated|''
    importance: t.u8(), // 1..5; 0 when unknown
    at: t.timestamp(),
  }
);

const spacetimedb = schema({
  repo,
  node,
  edge,
  participant,
  walk,
  frontier,
  verdict,
  node_cov,
  touch,
  touch_meta,
  agent_session,
  exploration_request,
  path_cache,
  repo_index,
  node_summary,
  new_land,
  new_land_seq,
  file_meta,
});
export default spacetimedb;

// ------------------------------------------------------------------ helpers

type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
/**
 * The table handle set. Identical inside a reducer and inside a procedure's
 * `withTx`, because `TransactionCtx extends ReducerCtx` — which is what lets
 * `index_repo` reuse the exact same row-writing code the seeder reducers use.
 */
type Db = Ctx['db'];

/** JSON numbers -> bigint, tolerating strings from the seeder. */
function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v.trim());
  return 0n;
}

function toStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function parseRows(rows_json: string): Record<string, unknown>[] {
  const parsed = JSON.parse(rows_json);
  if (!Array.isArray(parsed)) {
    throw new Error('rows_json must be a JSON array');
  }
  return parsed as Record<string, unknown>[];
}

// ------------------------------------------------------------------ reducers

/**
 * Create-or-reset the repo row for `slug` and hand back its id.
 *
 * Idempotent: re-running the seeder — or re-indexing a GitHub repo — must not
 * fork a second repo row. `create_repo` and `index_repo` both go through here,
 * so there is exactly one definition of what a repo row is.
 */
function upsertRepo(db: Db, slug: string, label: string): bigint {
  for (const existing of db.repo.slug.filter(slug)) {
    db.repo.id.update({ ...existing, label, status: 'loading' });
    return existing.id;
  }
  const row = db.repo.insert({
    id: 0n,
    slug,
    label,
    node_count: 0,
    edge_count: 0,
    reachability: 0.0,
    status: 'loading',
  });
  return row.id;
}

export const create_repo = spacetimedb.reducer(
  { name: 'create_repo' },
  { slug: t.string(), label: t.string() },
  (ctx, { slug, label }) => {
    upsertRepo(ctx.db, slug, label);
  }
);

export const ingest_nodes = spacetimedb.reducer(
  { name: 'ingest_nodes' },
  { repo_id: t.u64(), rows_json: t.string() },
  (ctx, { repo_id, rows_json }) => {
    const rows = parseRows(rows_json);
    let inserted = 0;
    for (const row of rows) {
      const id = toBig(row.id);
      if (id === 0n) continue;
      if (ctx.db.node.id.find(id) !== null) continue; // idempotent re-ingest
      ctx.db.node.insert({
        id,
        repo_id,
        kind: toStr(row.label ?? row.kind, 'Function'),
        name: toStr(row.name, ''),
        qual: toStr(row.qual, ''),
      });
      inserted += 1;
    }
    const r = ctx.db.repo.id.find(repo_id);
    if (r) {
      ctx.db.repo.id.update({ ...r, node_count: r.node_count + inserted });
    }
  }
);

export const ingest_edges = spacetimedb.reducer(
  { name: 'ingest_edges' },
  { repo_id: t.u64(), rows_json: t.string() },
  (ctx, { repo_id, rows_json }) => {
    const rows = parseRows(rows_json);
    let inserted = 0;
    for (const row of rows) {
      const src = toBig(row.src);
      const dst = toBig(row.dst);
      if (src === 0n || dst === 0n) continue;
      ctx.db.edge.insert({
        id: 0n,
        repo_id,
        src,
        dst,
        kind: toStr(row.type ?? row.kind, 'CALLS'),
      });
      inserted += 1;
    }
    const r = ctx.db.repo.id.find(repo_id);
    if (r) {
      ctx.db.repo.id.update({ ...r, edge_count: r.edge_count + inserted });
    }
  }
);

/** Recount, drop the stale path memo, flip the repo to "ready". */
function finishRepoRow(db: Db, repo_id: bigint, reachability: number): void {
  const r = db.repo.id.find(repo_id);
  if (!r) return;
  let nodes = 0;
  for (const _ of db.node.repo_id.filter(repo_id)) nodes += 1;
  let edges = 0;
  for (const _ of db.edge.repo_id.filter(repo_id)) edges += 1;
  // The node set just changed, so every memoised path resolution is stale.
  db.path_cache.repo_id.delete(repo_id);
  db.repo.id.update({
    ...r,
    node_count: nodes,
    edge_count: edges,
    reachability,
    status: 'ready',
  });
}

export const finish_repo = spacetimedb.reducer(
  { name: 'finish_repo' },
  { repo_id: t.u64(), reachability: t.f32() },
  (ctx, { repo_id, reachability }) => {
    finishRepoRow(ctx.db, repo_id, reachability);
  }
);

export const join_room = spacetimedb.reducer(
  { name: 'join_room' },
  { name: t.string(), repo_id: t.u64() },
  (ctx, { name, repo_id }) => {
    const existing = ctx.db.participant.identity.find(ctx.sender);
    if (existing) {
      ctx.db.participant.identity.update({
        ...existing,
        name,
        repo_id,
        online: true,
      });
    } else {
      ctx.db.participant.insert({
        identity: ctx.sender,
        name,
        repo_id,
        focus_node: 0n,
        online: true,
      });
    }
  }
);

export const set_focus = spacetimedb.reducer(
  { name: 'set_focus' },
  { node_id: t.u64() },
  (ctx, { node_id }) => {
    const p = ctx.db.participant.identity.find(ctx.sender);
    if (!p) return;
    ctx.db.participant.identity.update({ ...p, focus_node: node_id });
  }
);

export const start_walk = spacetimedb.reducer(
  { name: 'start_walk' },
  { repo_id: t.u64(), origin: t.u64(), k: t.u32() },
  (ctx, { repo_id, origin, k }) => {
    const originNode = ctx.db.node.id.find(origin);
    const isTest = originNode ? originNode.kind === 'Test' : false;

    const row = ctx.db.walk.insert({
      id: 0n,
      repo_id,
      origin,
      k,
      hop: 0,
      selected: isTest ? 1 : 0,
      graph_complete: false,
      done: false,
      started_by: ctx.sender,
    });

    ctx.db.frontier.insert({
      id: 0n,
      walk_id: row.id,
      hop: 0,
      node_id: origin,
      is_test: isTest,
    });

    // Degenerate k=0: nothing to expand, land the verdict immediately.
    if (k === 0) {
      const reached = new Set<bigint>([origin]);
      ctx.db.walk.id.update({
        ...row,
        done: true,
        graph_complete: false,
      });
      landVerdict(ctx, row.id, repo_id, reached, 0, isTest ? 1 : 0, false);
    }
  }
);

/**
 * Expand exactly ONE hop, along PREDECESSORS.
 *
 * Production code has no edge to the test guarding it, so the walk collects
 * `edge.src` where `edge.dst` is in the current frontier. A forward walk finds
 * nothing.
 */
export const step_walk = spacetimedb.reducer(
  { name: 'step_walk' },
  { walk_id: t.u64() },
  (ctx, { walk_id }) => {
    const w = ctx.db.walk.id.find(walk_id);
    if (!w || w.done) return;

    // Everything the walk has already touched, plus the leading edge.
    const reached = new Set<bigint>();
    const current: bigint[] = [];
    let tests = 0;
    for (const f of ctx.db.frontier.walk_id.filter(walk_id)) {
      reached.add(f.node_id);
      if (f.is_test) tests += 1;
      if (f.hop === w.hop) current.push(f.node_id);
    }

    const nextHop = w.hop + 1;
    const discovered: bigint[] = [];
    if (nextHop <= w.k) {
      for (const nodeId of current) {
        // PREDECESSORS: edges whose dst is this node, collect their src.
        for (const e of ctx.db.edge.dst.filter(nodeId)) {
          if (e.repo_id !== w.repo_id) continue;
          if (reached.has(e.src)) continue; // never revisit an earlier hop
          reached.add(e.src);
          discovered.push(e.src);
        }
      }
    }

    for (const nodeId of discovered) {
      const n = ctx.db.node.id.find(nodeId);
      const isTest = n ? n.kind === 'Test' : false;
      if (isTest) tests += 1;
      ctx.db.frontier.insert({
        id: 0n,
        walk_id,
        hop: nextHop,
        node_id: nodeId,
        is_test: isTest,
      });
    }

    const exhausted = discovered.length === 0;
    const hop = exhausted ? w.hop : nextHop;
    const done = exhausted || nextHop >= w.k;
    // Exhausting before the bound means the walk saw the whole reachable set.
    const graph_complete = exhausted;

    ctx.db.walk.id.update({
      ...w,
      hop,
      selected: tests,
      done,
      graph_complete,
    });

    if (done) {
      landVerdict(ctx, walk_id, w.repo_id, reached, hop, tests, graph_complete);
    }
  }
);

// ------------------------------------------------------------------ verdict

function landVerdict(
  ctx: Ctx,
  walk_id: bigint,
  repo_id: bigint,
  reached: Set<bigint>,
  hop: number,
  tests: number,
  graph_complete: boolean
): void {
  // Already landed? (a double step_walk on a done walk must not duplicate)
  for (const _ of ctx.db.verdict.walk_id.filter(walk_id)) return;

  const lb = wilsonLb(PRIOR_HITS, PRIOR_N);
  const recall = PRIOR_HITS / PRIOR_N;
  const decision = lb >= THRESHOLD ? 'SKIP_SAFE' : 'RUN_FULL';

  // A test this repo has that the walk never reached.
  let missed_test = 0n;
  for (const n of ctx.db.node.kind.filter('Test')) {
    if (n.repo_id !== repo_id) continue;
    if (reached.has(n.id)) continue;
    missed_test = n.id;
    break;
  }

  const dropped = Math.round((1.0 - recall) * 100);
  const reason =
    `recall is not computable on an unlabelled repo: this cites the measured ` +
    `prior across ${PRIOR_N} labelled fixes in ${PRIOR_REPOS} repos. ` +
    `Measured test->fix recall ${recall.toFixed(3)} (${PRIOR_HITS}/${PRIOR_N}) ` +
    `and its one-sided 95% Wilson lower bound ${lb.toFixed(3)} are both below ` +
    `the ${THRESHOLD.toFixed(2)} bar, so roughly ${dropped}% of tests known to ` +
    `guard their fix are not reachable and a skip would silently drop them. ` +
    `The backwards walk ${graph_complete ? `exhausted at hop ${hop}` : `hit the k bound at hop ${hop}`}, ` +
    `reaching ${reached.size} nodes and ${tests} tests.`;

  ctx.db.verdict.insert({
    id: 0n,
    walk_id,
    decision,
    recall_prior: recall,
    wilson_lb: lb,
    threshold: THRESHOLD,
    reason,
    missed_test,
  });
}

// ---------------------------------------------------------------- lifecycle

export const init = spacetimedb.init(_ctx => {});

export const identity_connected = spacetimedb.clientConnected(ctx => {
  const p = ctx.db.participant.identity.find(ctx.sender);
  if (p) {
    ctx.db.participant.identity.update({ ...p, online: true });
  }
});

export const identity_disconnected = spacetimedb.clientDisconnected(ctx => {
  const p = ctx.db.participant.identity.find(ctx.sender);
  if (p) {
    ctx.db.participant.identity.update({ ...p, online: false });
  }
});

// ============================================================================
// v2 — the agent coverage loop
// ============================================================================

/** Hard caps so a chatty hook can never turn one tool call into a long scan. */
const MAX_PATHS_PER_CALL = 32;
/** Every shipped repo is < 10k nodes; this is a fuse, not a limit we expect to hit. */
const MAX_NODES_SCANNED = 60000;
/** How many progressively-shorter dotted suffixes we will try for one path. */
const MAX_CANDIDATES = 4;

const SOURCE_EXTS = [
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.cs', '.go', '.java', '.rb', '.kt', '.scala', '.php',
  '.c', '.h', '.cc', '.cpp', '.hpp',
];

/**
 * `django/forms/fields.py` -> `django.forms.fields`
 *
 * Strips the extension, normalises separators, drops leading `./` and `/`.
 * Returns '' when there is nothing usable left.
 */
function dottedPath(raw: string): string {
  let s = raw.trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  while (s.endsWith('/')) s = s.slice(0, -1);
  for (const ext of SOURCE_EXTS) {
    if (s.endsWith(ext)) {
      s = s.slice(0, s.length - ext.length);
      break;
    }
  }
  const segs = s.split('/').filter(seg => seg.length > 0 && seg !== '.' && seg !== '..');
  return segs.join('.');
}

/**
 * Progressively shorter dotted suffixes, longest first.
 *
 * The contract's rule is a plain endsWith against a repo-relative path. The
 * shorter candidates exist only as a fallback for when a hook hands us an
 * absolute path (`/Users/me/checkout/django/forms/fields.py`) — we only fall
 * back to a shorter suffix when the longer ones matched nothing at all, so a
 * correct repo-relative path always wins on the first candidate.
 */
function pathCandidates(dotted: string): string[] {
  if (dotted.length === 0) return [];
  const segs = dotted.split('.');
  const out: string[] = [];
  for (let start = 0; start < segs.length && out.length < MAX_CANDIDATES; start++) {
    const rest = segs.length - start;
    if (rest < 2 && out.length > 0) break; // never fall back to a bare filename
    out.push(segs.slice(start).join('.'));
  }
  return out;
}

/** endsWith, but only on a dot boundary, so `forms.fields` never eats `myforms.fields`. */
function suffixMatch(mod: string, cand: string): boolean {
  if (mod.length < cand.length) return false;
  if (!mod.endsWith(cand)) return false;
  const i = mod.length - cand.length;
  return i === 0 || mod.charCodeAt(i - 1) === 46; // '.'
}

/** The dotted module path a node lives in: everything before `::`. */
function nodeModule(qual: string): string {
  const i = qual.indexOf('::');
  return i >= 0 ? qual.slice(0, i) : qual;
}

/**
 * A node's module path turned back into a repo-relative file path, best effort.
 * `data.repos.django.django.forms.fields` -> `django/forms/fields.py`
 * Used to give an exploration_request something the agent can actually open.
 */
function moduleToPath(qual: string): string {
  let mod = nodeModule(qual);
  const PREFIX = 'data.repos.';
  if (mod.startsWith(PREFIX)) {
    const rest = mod.slice(PREFIX.length);
    const dot = rest.indexOf('.');
    mod = dot >= 0 ? rest.slice(dot + 1) : rest;
  }
  if (mod.length === 0) return '';
  const segs = mod.split('.');
  // Nodes written by `index_repo` carry the real filename after `::`
  // (`src.lib.auth::auth.ts`), so the extension is known rather than assumed.
  const symbol = qual.indexOf('::') >= 0 ? qual.slice(qual.indexOf('::') + 2) : '';
  for (const ext of SOURCE_EXTS) {
    if (symbol.endsWith(ext) && symbol.indexOf('/') === -1) {
      // A filename may itself contain dots (`postcss.config.js`), and the module
      // path was built by `dottedPath`, which turned every one of them into a
      // separator. So pop as many segments as the BASENAME contributed -- not
      // one -- or `client/postcss.config.js` comes back as
      // `client/postcss/postcss.config.js` and the fetch 404s.
      const eaten = dottedPath(symbol).split('.').filter(x => x.length > 0).length;
      for (let k = 0; k < eaten && segs.length > 0; k++) segs.pop();
      segs.push(symbol);
      return segs.join('/');
    }
  }
  // Shipped graphs are Python; `.py` is the honest default for them.
  return segs.join('/') + '.py';
}

/**
 * Resolve repo-relative paths to node ids.
 *
 * ONE pass over the repo's nodes handles every uncached path at once, so cost
 * is O(nodes) per call rather than O(nodes x paths). Already-seen paths are
 * served from `path_cache` by primary key and cost nothing.
 */
function resolvePaths(
  ctx: Ctx,
  repo_id: bigint,
  paths: string[]
): Map<string, bigint[]> {
  const out = new Map<string, bigint[]>();
  type Job = { path: string; cands: string[]; hits: bigint[][] };
  const pending: Job[] = [];

  for (const p of paths) {
    if (out.has(p)) continue;
    const key = `${repo_id}|${p}`;
    const cached = ctx.db.path_cache.key.find(key);
    if (cached) {
      out.set(p, cached.node_ids);
      continue;
    }
    const cands = pathCandidates(dottedPath(p));
    if (cands.length === 0) {
      out.set(p, []);
      continue;
    }
    pending.push({ path: p, cands, hits: cands.map(() => [] as bigint[]) });
  }

  if (pending.length === 0) return out;

  let scanned = 0;
  let truncated = false;
  for (const n of ctx.db.node.repo_id.filter(repo_id)) {
    if (scanned >= MAX_NODES_SCANNED) {
      truncated = true;
      break;
    }
    scanned += 1;
    const mod = nodeModule(n.qual);
    for (const job of pending) {
      for (let i = 0; i < job.cands.length; i++) {
        if (suffixMatch(mod, job.cands[i])) {
          job.hits[i].push(n.id);
          break; // longest candidate wins for this node
        }
      }
    }
  }

  for (const job of pending) {
    let picked: bigint[] = [];
    for (const bucket of job.hits) {
      if (bucket.length > 0) {
        picked = bucket;
        break; // longest suffix that matched anything at all
      }
    }
    out.set(job.path, picked);
    // Never memoise a fused/partial scan.
    if (!truncated) {
      ctx.db.path_cache.insert({
        key: `${repo_id}|${job.path}`,
        repo_id,
        node_ids: picked,
      });
    }
  }
  return out;
}

/**
 * THE ACTOR — which agent, of the several sharing one session, did this.
 *
 * Subagents INHERIT the parent's `session_id`; what distinguishes them is the
 * `agent_id` the hook payload carries only for a subagent. So the actor cannot
 * be read off `session` — it has to be reported.
 *
 * It is carried INSIDE the existing `agent_name` argument rather than as a new
 * reducer parameter: `claude` is the main agent, `claude/<actor>` is a subagent.
 * That keeps `report_touch`'s signature byte-identical, so every plugin already
 * installed out there keeps working and reports as the main agent — a new
 * parameter would have broken all of them until each one was updated.
 *
 * `<actor>` is opaque and stable per subagent. The plugin sends
 * `<agent_type>~<agent_id[:8]>` when it knows the type, and `<agent_id[:8]>`
 * when it does not; nothing here parses it, it is only ever an identity.
 */
function splitActor(agent_name: string): { base: string; actor: string } {
  const s = agent_name.trim();
  const i = s.indexOf('/');
  if (i < 0) return { base: s.length > 0 ? s : 'claude', actor: '' };
  const base = s.slice(0, i).trim();
  const actor = s.slice(i + 1).trim().slice(0, 48);
  return { base: base.length > 0 ? base : 'claude', actor };
}

/**
 * The key a report is filed under: the session for the main agent, and
 * `session/actor` for a subagent.
 *
 * This rides in the EXISTING `session` string columns (`touch.session`,
 * `node_cov.last_session`, `agent_session.session`) rather than in new columns,
 * for the same reason the actor rides in `agent_name`: adding a column to a
 * populated table is a destructive republish, and the loaded graphs are not
 * expendable. A plain session with no `/` is the main agent, which is exactly
 * what every row written before today already says.
 *
 * It also gives the presence rail its tree for free: the part before the `/` is
 * the parent session every subagent under it shares.
 */
function presenceKey(session: string, actor: string): string {
  return actor.length > 0 ? `${session}/${actor}` : session;
}

/** Node kind for territory that exists because an agent walked onto it. */
const NEW_LAND_KIND = 'NewLand';
/** Fuse: a repo can grow this much new ground before the map stops accepting it. */
const MAX_NEW_LAND = 512;

/** A path that names a FILE — has an extension on its last segment. */
function newLandable(path: string): boolean {
  const segs = path.split('/');
  const base = segs[segs.length - 1];
  if (base.length === 0) return false;
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1;
}

/**
 * Put an unresolvable path on the map as new ground, and hand back its node id.
 *
 * Ids come from the TOP of the repo's reserved band, counting DOWN, while
 * `index_repo` allots ordinals 1..N counting UP from the bottom. A billion ids
 * separate them against fuses of 4,000 and 512, so minted land can never
 * collide with indexed land even after the repo is re-indexed.
 *
 * Returns 0n when the path cannot be placed — the `node_id = 0` sentinel still
 * means exactly what it always meant.
 */
function mintNewLand(
  ctx: Ctx,
  repo_id: bigint,
  path: string,
  actor: string,
  now: Ctx['timestamp']
): bigint {
  if (!newLandable(path)) return 0n;
  const ck = `${repo_id}|${path}`;
  const seen = ctx.db.new_land.key.find(ck);
  if (seen) return seen.node_id;

  const seq = ctx.db.new_land_seq.repo_id.find(repo_id);
  const next = seq ? seq.next : 0;
  if (next >= MAX_NEW_LAND) return 0n;

  const id = idBand(repo_id) + INDEX_ID_STRIDE - 1n - BigInt(next);
  if (ctx.db.node.id.find(id)) return 0n; // never take ground that is already someone's

  const segs = path.split('/');
  ctx.db.node.insert({
    id,
    repo_id,
    kind: NEW_LAND_KIND,
    name: segs[segs.length - 1],
    qual: qualForPath(path),
  });
  ctx.db.new_land.insert({ key: ck, repo_id, node_id: id, path, actor, at: now });
  if (seq) ctx.db.new_land_seq.repo_id.update({ repo_id, next: next + 1 });
  else ctx.db.new_land_seq.insert({ repo_id, next: 1 });

  // The resolver memo has just cached "nothing" for this path. Teach it the
  // answer, or every later touch of the same file re-scans and misses again.
  const cached = ctx.db.path_cache.key.find(ck);
  if (cached) ctx.db.path_cache.key.update({ ...cached, node_ids: [id] });
  else ctx.db.path_cache.insert({ key: ck, repo_id, node_ids: [id] });

  return id;
}

/** Upsert the agent's presence row. Returns nothing; safe to call constantly. */
function bumpSession(
  ctx: Ctx,
  session: string,
  agent_name: string,
  repo_id: bigint,
  addTouches: number
): void {
  const now = ctx.timestamp;
  for (const s of ctx.db.agent_session.session.filter(session)) {
    ctx.db.agent_session.id.update({
      ...s,
      agent_name: agent_name.length > 0 ? agent_name : s.agent_name,
      repo_id,
      online: true,
      touches: s.touches + addTouches,
      last_at: now,
    });
    return;
  }
  ctx.db.agent_session.insert({
    id: 0n,
    session,
    agent_name,
    repo_id,
    online: true,
    touches: addTouches,
    started_at: now,
    last_at: now,
  });
}

/**
 * The coverage feed. Fired by the plugin's PostToolUse hook on every tool use.
 *
 * `paths_json` is a JSON array STRING of repo-relative file paths. Each path
 * gets exactly one `touch` row (the event), and every node in the matched file
 * gets a `node_cov` upsert (the state) — a file touch lights the whole file.
 * A path that resolves to nothing still gets its `touch` row with node_id = 0,
 * so misses stay countable.
 */
function applyTouch(
  ctx: Ctx,
  repo_id: bigint,
  session: string,
  agent_name: string,
  tool: string,
  paths_json: string,
  duration_ms: number,
  tool_use_id: string
): void {
    // A malformed payload from a hook must never fail the agent's turn.
    let raw: unknown;
    try {
      raw = JSON.parse(paths_json);
    } catch {
      raw = null;
    }
    if (!Array.isArray(raw)) return;

    const paths: string[] = [];
    const seen = new Set<string>();
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (s.length === 0 || seen.has(s)) continue;
      seen.add(s);
      paths.push(s);
      if (paths.length >= MAX_PATHS_PER_CALL) break;
    }
    // Which agent this is, and the key its reports are filed under.
    const { actor } = splitActor(agent_name);
    const skey = presenceKey(session, actor);

    if (paths.length === 0) {
      bumpSession(ctx, skey, agent_name, repo_id, 0);
      return;
    }

    const now = ctx.timestamp;
    const resolved = resolvePaths(ctx, repo_id, paths);

    for (const p of paths) {
      let ids = resolved.get(p) ?? [];
      // Off the map: a feature-branch file, a brand-new one, or one the indexer
      // missed. Mint it as new territory rather than losing it to the sentinel.
      if (ids.length === 0) {
        const minted = mintNewLand(ctx, repo_id, p, actor, now);
        if (minted !== 0n) ids = [minted];
      }

      const row = ctx.db.touch.insert({
        id: 0n,
        repo_id,
        node_id: ids.length > 0 ? ids[0] : 0n,
        path: p,
        tool,
        session: skey,
        agent_name,
        at: now,
      });

      // Only file a meta row when there is something in it. An untimed report
      // (an older plugin, or a payload with no duration) simply has no row,
      // and the reader treats a missing row as "not known" rather than as 0.
      if (row && (duration_ms > 0 || tool_use_id.length > 0)) {
        ctx.db.touch_meta.insert({
          touch_id: row.id,
          repo_id,
          duration_ms,
          tool_use_id: tool_use_id.slice(0, 64),
        });
      }

      for (const nodeId of ids) {
        const existing = ctx.db.node_cov.node_id.find(nodeId);
        if (existing) {
          ctx.db.node_cov.node_id.update({
            ...existing,
            touches: existing.touches + 1,
            last_tool: tool,
            last_session: skey,
            explored: true,
            last_at: now,
          });
        } else {
          ctx.db.node_cov.insert({
            node_id: nodeId,
            repo_id,
            touches: 1,
            last_tool: tool,
            last_session: skey,
            explored: true,
            last_at: now,
          });
        }
      }
    }

  bumpSession(ctx, skey, agent_name, repo_id, paths.length);
}

/**
 * The coverage feed as it has always been. Signature byte-identical, so every
 * plugin already installed out there keeps working untouched.
 */
export const report_touch = spacetimedb.reducer(
  { name: 'report_touch' },
  {
    repo_id: t.u64(),
    session: t.string(),
    agent_name: t.string(),
    tool: t.string(),
    paths_json: t.string(),
  },
  (ctx, { repo_id, session, agent_name, tool, paths_json }) => {
    applyTouch(ctx, repo_id, session, agent_name, tool, paths_json, 0, '');
  }
);

/**
 * The same feed, plus how long the tool call took.
 *
 * A NEW reducer rather than two more parameters on `report_touch`: the old
 * signature is frozen for compatibility, and a reducer cannot hand a touch id
 * back to the caller, so the only place that knows the id of the row it just
 * inserted is inside the reducer itself. Hence the meta row is written here,
 * in the same transaction as the touch it describes, and cannot orphan.
 */
export const report_touch_timed = spacetimedb.reducer(
  { name: 'report_touch_timed' },
  {
    repo_id: t.u64(),
    session: t.string(),
    agent_name: t.string(),
    tool: t.string(),
    paths_json: t.string(),
    duration_ms: t.u32(),
    tool_use_id: t.string(),
  },
  (ctx, { repo_id, session, agent_name, tool, paths_json, duration_ms, tool_use_id }) => {
    applyTouch(ctx, repo_id, session, agent_name, tool, paths_json, duration_ms, tool_use_id);
  }
);

/**
 * A session is over. Put its lamps out.
 *
 * Nothing else in this module ever writes `online: false` on an agent row --
 * `bumpSession` only ever writes `true`, and `identity_disconnected` speaks
 * only for `participant`, because a Claude Code hook is an HTTP caller with no
 * persistent connection to lose. So without this reducer an agent stays lit
 * forever and the map shows actor colour for nobody, which is exactly the bug
 * this fixes.
 *
 * A subagent's row is keyed `<session>/<actor>` (see `presenceKey`), so ending
 * the parent session must also end every child under it. Both spellings are
 * accepted as the argument: passing `<session>/<actor>` ends just that
 * subagent, passing `<session>` ends the whole tree.
 *
 * Idempotent, and a no-op for a session that was never seen. A hook that fires
 * twice, or fires for a session on another repo, costs nothing.
 */
export const end_session = spacetimedb.reducer(
  { name: 'end_session' },
  { session: t.string() },
  (ctx, { session }) => {
    const key = session.trim();
    if (key.length === 0) return;
    const prefix = `${key}/`;

    // The exact row, via the index.
    for (const s of ctx.db.agent_session.session.filter(key)) {
      if (s.online) ctx.db.agent_session.id.update({ ...s, online: false });
    }

    // Its subagents. `session` is indexed for equality, not for prefixes, so
    // this is a scan -- bounded by the number of agent rows, which is small
    // (one per session per actor) and never grows with repo size.
    for (const s of ctx.db.agent_session.iter()) {
      if (s.online && s.session.startsWith(prefix)) {
        ctx.db.agent_session.id.update({ ...s, online: false });
      }
    }
  }
);

/** Keeps an agent visible in the presence rail between tool calls. */
export const agent_heartbeat = spacetimedb.reducer(
  { name: 'agent_heartbeat' },
  { session: t.string(), agent_name: t.string(), repo_id: t.u64() },
  (ctx, { session, agent_name, repo_id }) => {
    const { actor } = splitActor(agent_name);
    bumpSession(ctx, presenceKey(session, actor), agent_name, repo_id, 0);
  }
);

// ------------------------------------------------------------ the return path

/** A human clicked a dark node. Ask the agent to go look at it. */
export const request_exploration = spacetimedb.reducer(
  { name: 'request_exploration' },
  { repo_id: t.u64(), node_id: t.u64(), note: t.string() },
  (ctx, { repo_id, node_id, note }) => {
    // Already asked and not yet answered — do nothing.
    for (const r of ctx.db.exploration_request.status.filter('pending')) {
      if (r.repo_id === repo_id && r.node_id === node_id) return;
    }
    const n = ctx.db.node.id.find(node_id);
    ctx.db.exploration_request.insert({
      id: 0n,
      repo_id,
      node_id,
      path: n ? moduleToPath(n.qual) : '',
      note,
      status: 'pending',
      asked_by: ctx.sender,
      claimed_by: '',
      result: '',
      at: ctx.timestamp,
    });
  }
);

/** pending -> claimed. No-op if the request is not pending. */
export const claim_request = spacetimedb.reducer(
  { name: 'claim_request' },
  { request_id: t.u64(), agent_name: t.string() },
  (ctx, { request_id, agent_name }) => {
    const r = ctx.db.exploration_request.id.find(request_id);
    if (!r || r.status !== 'pending') return;
    ctx.db.exploration_request.id.update({
      ...r,
      status: 'claimed',
      claimed_by: agent_name,
    });
  }
);

/** claimed -> done, carrying what the agent found back to every screen. */
export const complete_request = spacetimedb.reducer(
  { name: 'complete_request' },
  { request_id: t.u64(), result: t.string() },
  (ctx, { request_id, result }) => {
    const r = ctx.db.exploration_request.id.find(request_id);
    if (!r || r.status !== 'claimed') return;
    ctx.db.exploration_request.id.update({ ...r, status: 'done', result });
  }
);

/**
 * Wipe the coverage feed for ONE repo so a demo can be run again from dark.
 *
 * Touches only v2 tables — `node`, `edge`, `walk`, `frontier` and `verdict` are
 * never read or written here, so the loaded graphs and the v1 walk are safe.
 */
export const reset_coverage = spacetimedb.reducer(
  { name: 'reset_coverage' },
  { repo_id: t.u64() },
  (ctx, { repo_id }) => {
    ctx.db.node_cov.repo_id.delete(repo_id);
    ctx.db.touch.repo_id.delete(repo_id);
    ctx.db.path_cache.repo_id.delete(repo_id);
    ctx.db.exploration_request.repo_id.delete(repo_id);
    // New ground was discovered BY the coverage feed, so it goes back with it.
    // Only the minted nodes are removed; indexed and seeded ones are untouched.
    const minted: bigint[] = [];
    for (const r of ctx.db.new_land.repo_id.filter(repo_id)) minted.push(r.node_id);
    ctx.db.new_land.repo_id.delete(repo_id);
    ctx.db.new_land_seq.repo_id.delete(repo_id);
    for (const id of minted) ctx.db.node.id.delete(id);
    const ids: bigint[] = [];
    for (const s of ctx.db.agent_session.iter()) {
      if (s.repo_id === repo_id) ids.push(s.id);
    }
    for (const id of ids) ctx.db.agent_session.id.delete(id);
  }
);

// ============================================================================
// v3 — GitHub indexing. Paste a repo URL, get a map. No backend, no build step.
// ============================================================================

/**
 * NODE ID ALLOCATION.
 *
 * `node.id` is a GLOBAL primary key, not scoped by repo, so two repos that mint
 * overlapping ids silently lose rows to each other (repo 3 in the live database
 * is already dark for exactly this reason). Every indexed repo therefore gets
 * its own reserved, non-overlapping band:
 *
 *     node.id = INDEX_ID_BASE + repo_id * INDEX_ID_STRIDE + ordinal
 *
 * with `ordinal` running 1..N inside the repo. Ordinal 0 is never issued,
 * because node_id 0 is the sentinel `report_touch` writes for an unresolved
 * path — a real node must never be able to wear it.
 *
 * The base sits three orders of magnitude above every id the shipped graphs use
 * (their maximum is under 1e12; verified with `SELECT id FROM node WHERE id >
 * 1000000000000`, which returns nothing), so an indexed repo can never collide
 * with a seeded one. The stride reserves a billion ids per repo against a fuse
 * of 4,000, so a repo can never bleed into its neighbour either. Re-indexing is
 * stable: the band is a pure function of repo_id, so the same repo re-indexed
 * reuses the same id space instead of orphaning its old nodes.
 */
const INDEX_ID_BASE = 4_000_000_000_000_000n;
const INDEX_ID_STRIDE = 1_000_000_000n;

function idBand(repo_id: bigint): bigint {
  return INDEX_ID_BASE + repo_id * INDEX_ID_STRIDE;
}

/** Fuse on nodes. django/django is ~10k source files; 4k is a demo-sized map. */
const MAX_INDEX_FILES = 4000;
/** Fuse on edges. Containment is ~2 edges per file, so this is slack, not a limit. */
const MAX_INDEX_EDGES = 16000;
/** Rows per transaction, so one repo is many small writes rather than one huge one. */
const INDEX_TX_CHUNK = 1000;

/** Extensions that become nodes. A strict subset of SOURCE_EXTS, so the
 *  extension `index_repo` strips is exactly the one `report_touch` strips. */
const INDEX_EXTS = [
  '.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.cs', '.go',
  '.java', '.rb', '.php', '.c', '.cpp', '.h',
];

/** Directories that are somebody else's code, or output, not the map. */
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', '.git', 'target', 'venv', '.venv',
]);

function hasIndexExt(path: string): boolean {
  for (const ext of INDEX_EXTS) {
    if (path.endsWith(ext)) return true;
  }
  return false;
}

/** `test`/`spec` anywhere in a path segment or the filename makes it a Test. */
function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const seg of lower.split('/')) {
    if (seg.includes('test') || seg.includes('spec')) return true;
  }
  return false;
}

/**
 * THE SEAM. `src/lib/auth.ts` -> `src.lib.auth`, byte-for-byte what
 * `dottedPath()` produces for the same path inside `report_touch`.
 *
 * This is the one thing that has to be right. If a node's qual does not match
 * what the touch resolver derives from a real file path, every touch resolves
 * to node_id 0, the map stays dark, and nothing anywhere reports a failure.
 * So it does not approximate `dottedPath` — it CALLS it.
 */
function qualForPath(path: string): string {
  const mod = dottedPath(path);
  const segs = path.split('/');
  const base = segs[segs.length - 1];
  return `${mod}::${base}`;
}

/** The directory a repo-relative path lives in. '' for a root-level file. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function parentDir(dir: string): string | null {
  if (dir === '') return null;
  const i = dir.lastIndexOf('/');
  return i === -1 ? '' : dir.slice(0, i);
}

type TreeEntry = { path: string; type: string };

/**
 * Put an arbitrary public GitHub repo on the shared map.
 *
 * Everything happens inside the database: one call to GitHub's trees API, the
 * filter, the node and edge rows, the repo row. There is no backend, no crawler
 * and no build step between a pasted URL and a live map every tab can see.
 *
 * `github_token` may be empty — unauthenticated GitHub allows 60 requests an
 * hour, which is plenty. A PAT raises the ceiling and reaches private repos.
 * It is an argument, never a constant: no credential is ever compiled in.
 */
export const indexRepo = spacetimedb.procedure(
  { name: 'index_repo' },
  { owner: t.string(), repo: t.string(), github_token: t.string() },
  t.string(),
  (ctx, { owner, repo, github_token }) => {
    const o = owner.trim();
    const r = repo.trim();
    if (o.length === 0 || r.length === 0) return 'error: owner and repo are required';

    // ---- 1. fetch the whole tree in one call --------------------------------
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'map-room',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (github_token.trim().length > 0) {
      headers.Authorization = `Bearer ${github_token.trim()}`;
    }

    const res = ctx.http.fetch(
      `https://api.github.com/repos/${o}/${r}/git/trees/HEAD?recursive=1`,
      { method: 'GET', headers }
    );
    if (res.status !== 200) {
      return `error: github returned ${res.status} for ${o}/${r}`;
    }

    let tree: TreeEntry[] = [];
    let truncated = false;
    let sha = '';
    try {
      const data = res.json() as { tree?: TreeEntry[]; truncated?: boolean; sha?: string };
      tree = Array.isArray(data.tree) ? data.tree : [];
      truncated = data.truncated === true;
      sha = typeof data.sha === 'string' ? data.sha : '';
    } catch {
      return `error: github returned unparseable JSON for ${o}/${r}`;
    }

    // ---- 2. filter to source files ------------------------------------------
    let blobs = 0;
    const files: string[] = [];
    let capped = false;
    for (const entry of tree) {
      if (!entry || entry.type !== 'blob' || typeof entry.path !== 'string') continue;
      blobs += 1;
      const path = entry.path;
      if (!hasIndexExt(path)) continue;
      let skipped = false;
      const segs = path.split('/');
      for (let i = 0; i < segs.length - 1; i++) {
        if (SKIP_DIRS.has(segs[i])) { skipped = true; break; }
      }
      if (skipped) continue;
      if (files.length >= MAX_INDEX_FILES) { capped = true; continue; }
      files.push(path);
    }
    if (files.length === 0) {
      return `error: no indexable source files in ${o}/${r} (${blobs} blobs seen)`;
    }

    // Sorting makes the id band deterministic: the same tree always yields the
    // same node id for the same file, so a re-index is an update, not a shuffle.
    files.sort();

    const slug = `${o}/${r}`;
    // A partial map must announce itself on the row a human actually reads.
    const label = truncated
      ? `${slug} — PARTIAL: GitHub truncated the tree`
      : capped
        ? `${slug} — PARTIAL: capped at ${MAX_INDEX_FILES} files`
        : slug;

    // ---- 3. repo row (fetch is done; only now do we take a transaction) -----
    let repo_id = 0n;
    let refused = '';
    ctx.withTx(tx => {
      repo_id = upsertRepo(tx.db, slug, label);
      // Never let an indexed repo bulldoze a seeded graph: seeded nodes live
      // far below the index band, and their ids are not ours to recycle.
      for (const n of tx.db.node.repo_id.filter(repo_id)) {
        if (n.id < INDEX_ID_BASE) {
          refused = `error: repo ${repo_id} (${slug}) holds seeded nodes; refusing to reindex`;
          break;
        }
      }
      if (refused.length === 0) {
        // Re-index is a replace, not an append.
        tx.db.node.repo_id.delete(repo_id);
        tx.db.edge.repo_id.delete(repo_id);
        tx.db.path_cache.repo_id.delete(repo_id);
        // Minted land pointed at nodes that just went away; its ordinals are
        // free again and the agent will rediscover whatever is still off-map.
        tx.db.new_land.repo_id.delete(repo_id);
        tx.db.new_land_seq.repo_id.delete(repo_id);
      }
    });
    if (refused.length > 0) return refused;

    const base = idBand(repo_id);

    // ---- 4. one node per source file ----------------------------------------
    const idOf = new Map<string, bigint>();
    type NodeRow = { id: bigint; repo_id: bigint; kind: string; name: string; qual: string };
    const nodeRows: NodeRow[] = [];
    for (let i = 0; i < files.length; i++) {
      const path = files[i];
      const id = base + BigInt(i + 1); // ordinal 0 is reserved for "unresolved"
      idOf.set(path, id);
      const segs = path.split('/');
      nodeRows.push({
        id,
        repo_id,
        kind: isTestPath(path) ? 'Test' : 'Function',
        name: segs[segs.length - 1],
        qual: qualForPath(path),
      });
    }

    for (let i = 0; i < nodeRows.length; i += INDEX_TX_CHUNK) {
      const chunk = nodeRows.slice(i, i + INDEX_TX_CHUNK);
      ctx.withTx(tx => {
        for (const row of chunk) tx.db.node.insert(row);
      });
    }

    // ---- 5. edges from directory containment, capped ------------------------
    //
    // A file-to-file mesh inside one directory is quadratic: a 500-file folder
    // alone would be 250,000 edges. So each directory elects a REPRESENTATIVE
    // (its alphabetically first file) and everything hangs off that star, with
    // representatives chained to their parent's representative. The result is
    // linear — about two edges per file — and still connects any file to any
    // other by a short path, which is what the backwards walk needs.
    //
    // Both directions are written, because the walk rides PREDECESSORS: a walk
    // starting at a leaf file must be able to climb to its representative.
    const repOf = new Map<string, bigint>();
    for (const path of files) {
      const dir = dirOf(path);
      if (!repOf.has(dir)) repOf.set(dir, idOf.get(path)!);
    }

    type EdgeRow = { id: bigint; repo_id: bigint; src: bigint; dst: bigint; kind: string };
    const edgeRows: EdgeRow[] = [];
    const pushEdge = (src: bigint, dst: bigint, kind: string): void => {
      if (edgeRows.length >= MAX_INDEX_EDGES) return;
      edgeRows.push({ id: 0n, repo_id, src, dst, kind });
    };

    for (const path of files) {
      const dir = dirOf(path);
      const rep = repOf.get(dir)!;
      const id = idOf.get(path)!;
      if (id === rep) continue;
      pushEdge(rep, id, 'CONTAINS');
      pushEdge(id, rep, 'IN_DIR');
    }

    for (const [dir, rep] of repOf) {
      // Climb to the nearest ancestor that actually elected a representative;
      // directories that hold only subdirectories have none.
      let up = parentDir(dir);
      while (up !== null && !repOf.has(up)) up = parentDir(up);
      if (up === null) continue;
      const parentRep = repOf.get(up)!;
      if (parentRep === rep) continue;
      pushEdge(parentRep, rep, 'CONTAINS');
      pushEdge(rep, parentRep, 'IN_DIR');
    }

    for (let i = 0; i < edgeRows.length; i += INDEX_TX_CHUNK) {
      const chunk = edgeRows.slice(i, i + INDEX_TX_CHUNK);
      ctx.withTx(tx => {
        for (const row of chunk) tx.db.edge.insert(row);
      });
    }

    // ---- 6. provenance + finish ---------------------------------------------
    const nFiles = files.length;
    const nEdges = edgeRows.length;
    ctx.withTx(tx => {
      const prov = {
        repo_id,
        owner: o,
        repo: r,
        ref: sha,
        files_seen: blobs,
        files_indexed: nFiles,
        truncated,
        capped,
        at: tx.timestamp,
      };
      if (tx.db.repo_index.repo_id.find(repo_id)) {
        tx.db.repo_index.repo_id.update(prov);
      } else {
        tx.db.repo_index.insert(prov);
      }
      // Reachability is not measurable on a containment graph, and inventing a
      // number here would be a lie the verdict later cites. 0 means "unknown".
      finishRepoRow(tx.db, repo_id, 0.0);
    });

    return (
      `ok repo_id=${repo_id} slug=${slug} blobs=${blobs} nodes=${nFiles} ` +
      `edges=${nEdges} truncated=${truncated} capped=${capped} ` +
      `id_band=[${base + 1n}..${base + BigInt(nFiles)}]`
    );
  }
);

// ---------------------------------------------------------- region summaries

const GEMINI_MODEL = 'gemini-2.0-flash';
/** Enough of a file to say what it does; keeps the prompt and the latency small. */
const MAX_FILE_CHARS = 12000;

/**
 * Repo-relative file path for a node, exact for indexed repos.
 * `src.lib.auth::auth.ts` -> `src/lib/auth.ts`
 */
function pathOfNode(qual: string): string {
  return moduleToPath(qual);
}

/** `owner/repo` for a repo row, falling back to the seeded `owner__repo-1234` shape. */
function ownerRepoOf(db: Db, repo_id: bigint): { owner: string; repo: string } | null {
  const prov = db.repo_index.repo_id.find(repo_id);
  if (prov) return { owner: prov.owner, repo: prov.repo };
  const r = db.repo.id.find(repo_id);
  if (!r) return null;
  const slug = r.slug;
  const slash = slug.indexOf('/');
  if (slash > 0) return { owner: slug.slice(0, slash), repo: slug.slice(slash + 1) };
  const dunder = slug.indexOf('__');
  if (dunder > 0) {
    const owner = slug.slice(0, dunder);
    let rest = slug.slice(dunder + 2);
    const dash = rest.lastIndexOf('-');
    if (dash > 0) rest = rest.slice(0, dash);
    return { owner, repo: rest };
  }
  return null;
}

/**
 * Say, in one sentence, what the file behind a node actually does.
 *
 * Fetches the file from GitHub, asks Gemini to describe it, stores the answer on
 * `node_summary` so a dark region on the map reads "validates password reset
 * tokens" instead of `auth.ts`.
 *
 * `api_key` is an ARGUMENT. It is never stored, never logged, never a constant.
 *
 * Deliberately NOT used to extract the call graph: parsing stays deterministic,
 * because a hallucinated edge would corrupt the exact relation this product
 * measures. The model writes prose about a file; it never asserts a relation.
 */
export const summarizeRegion = spacetimedb.procedure(
  { name: 'summarize_region' },
  { node_id: t.u64(), api_key: t.string() },
  t.string(),
  (ctx, { node_id, api_key }) => {
    const key = api_key.trim();
    if (key.length === 0) return 'error: api_key is required (it is never stored)';

    // Read what we need, then drop the transaction before touching the network.
    let path = '';
    let name = '';
    let owner = '';
    let ghRepo = '';
    let repo_id = 0n;
    ctx.withTx(tx => {
      const n = tx.db.node.id.find(node_id);
      if (!n) return;
      repo_id = n.repo_id;
      name = n.name;
      path = pathOfNode(n.qual);
      const or = ownerRepoOf(tx.db, n.repo_id);
      if (or) {
        owner = or.owner;
        ghRepo = or.repo;
      }
    });
    if (repo_id === 0n) return `error: no node ${node_id}`;
    if (owner.length === 0 || path.length === 0) {
      return `error: cannot map node ${node_id} back to a GitHub file`;
    }

    const raw = ctx.http.fetch(
      `https://raw.githubusercontent.com/${owner}/${ghRepo}/HEAD/${path}`,
      { method: 'GET', headers: { 'User-Agent': 'map-room' } }
    );
    if (raw.status !== 200) {
      return `error: github returned ${raw.status} for ${owner}/${ghRepo}/${path}`;
    }
    const body = raw.text().slice(0, MAX_FILE_CHARS);

    const prompt =
      `You are labelling a map of a codebase. In ONE sentence of at most 20 ` +
      `words, say what this file does. Start with a verb. No preamble, no ` +
      `markdown, no filename.\n\nFile: ${path}\n\n${body}`;

    const gem = ctx.http.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'map-room' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (gem.status !== 200) return `error: gemini returned ${gem.status}`;

    let summary = '';
    try {
      const data = gem.json() as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === 'string') summary += part.text;
      }
    } catch {
      return 'error: gemini returned unparseable JSON';
    }
    summary = summary.trim().replace(/\s+/g, ' ');
    if (summary.length === 0) return 'error: gemini returned no text';
    if (summary.length > 400) summary = summary.slice(0, 400);

    const captured = summary;
    const rid = repo_id;
    ctx.withTx(tx => {
      const row = {
        node_id,
        repo_id: rid,
        summary: captured,
        model: GEMINI_MODEL,
        at: tx.timestamp,
      };
      if (tx.db.node_summary.node_id.find(node_id)) {
        tx.db.node_summary.node_id.update(row);
      } else {
        tx.db.node_summary.insert(row);
      }
    });

    return `ok ${name}: ${summary}`;
  }
);

// ------------------------------------------------------- enrichment: the fix
//
// `index_repo` puts a repo on the map in 3.4 seconds by reading only its file
// TREE. That is why it is instant, and it is also why the map it produces is
// thin: one node per file, and the only edges are directory containment. Every
// block stands at the same height because every file holds exactly one node,
// and the impact walk traverses FOLDERS because folders are the only relation
// there is.
//
// `enrich_repo` is the second, opt-in pass that reads the file CONTENTS. It is
// deliberately separate from indexing: pasting a URL must stay instant, and
// nobody who pastes django/django (2,975 files) should silently spend tokens.
//
// The division of labour is the whole point:
//
//   EDGES come from a REGEX and only from a regex. The model is never asked
//   whether one file imports another. A hallucinated import would corrupt the
//   exact relation this product measures, and "how do you know that edge is
//   real" has to have an answer: it is a line in the file, and you can go read
//   it. An import that resolves to nothing is DROPPED, counted and reported --
//   never guessed into place.
//
//   PROSE comes from the model, because a sentence cannot corrupt a graph.

/** The cheap, fast, non-reasoning tier -- lowest latency for a batched call.
 *  Verified from https://developers.openai.com/api/docs/models/gpt-4.1-nano
 *  ("fastest and most cost-efficient version of GPT-4.1 ... without a
 *  reasoning step"), fetched via ctx7, not recalled. */
const OPENAI_MODEL = 'gpt-4.1-nano';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Files per call. The client drives batches and resumes on `offset`. */
const MAX_ENRICH_LIMIT = 40;
/** Enough of a file to find every import and count every symbol. */
const ENRICH_FILE_CHARS = 80000;
/** Per-file slice sent to the model. 40 x this is the whole prompt. */
const LLM_FILE_CHARS = 3500;
/** An import that lands on more files than this is ambiguous, not resolved. */
const MAX_IMPORT_FANOUT = 8;
/** Per-file cap on written IMPORTS edges, so one generated file cannot flood. */
const MAX_IMPORTS_PER_FILE = 60;

type Lang = 'py' | 'js' | 'rs' | 'go' | 'jvm' | 'c' | 'other';

function langOf(path: string): Lang {
  const p = path.toLowerCase();
  if (p.endsWith('.py')) return 'py';
  if (
    p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') ||
    p.endsWith('.jsx') || p.endsWith('.mjs') || p.endsWith('.cjs')
  ) return 'js';
  if (p.endsWith('.rs')) return 'rs';
  if (p.endsWith('.go')) return 'go';
  if (
    p.endsWith('.java') || p.endsWith('.cs') || p.endsWith('.kt') ||
    p.endsWith('.scala')
  ) return 'jvm';
  if (
    p.endsWith('.c') || p.endsWith('.h') || p.endsWith('.cc') ||
    p.endsWith('.cpp') || p.endsWith('.hpp')
  ) return 'c';
  return 'other';
}

/**
 * The import statements in a file, as WRITTEN. No inference, no model.
 *
 * Returns the raw specifier text (`./store`, `django.forms.fields`,
 * `crate::graph::walk`, `"utils.h"`), which `resolveImportSpec` then tries to
 * turn into a file in THIS repo. Anything that is not one of these shapes is
 * simply not an import as far as this module is concerned.
 */
function extractImports(text: string, lang: Lang): string[] {
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (s.length > 0 && s.length < 300) out.push(s);
  };

  if (lang === 'js') {
    // `import x from '…'` / `export … from '…'` / `import '…'`
    // `require('…')` / dynamic `import('…')`
    const pats = [
      /\bfrom\s*['"]([^'"\n]+)['"]/g,
      /\bimport\s*['"]([^'"\n]+)['"]/g,
      /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    ];
    for (const re of pats) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) push(m[1]);
    }
    return out;
  }

  if (lang === 'c') {
    // Quoted includes only. `<stdio.h>` is a system header, never a repo file.
    const re = /^[ \t]*#[ \t]*include[ \t]+"([^"\n]+)"/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) push(m[1]);
    return out;
  }

  const lines = text.split('\n');

  if (lang === 'py') {
    for (const raw of lines) {
      const line = raw.trim();
      const from = /^from\s+([.\w]+)\s+import\b/.exec(line);
      if (from) { push(from[1]); continue; }
      const imp = /^import\s+(.+)$/.exec(line);
      if (!imp) continue;
      for (const part of imp[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_.][\w.]*$/.test(name)) push(name);
      }
    }
    return out;
  }

  if (lang === 'rs') {
    for (const raw of lines) {
      const line = raw.trim();
      const use = /^(?:pub\s+)?use\s+([A-Za-z_][\w:]*)/.exec(line);
      if (use) { push(use[1].replace(/:+$/, '')); continue; }
      const mod = /^(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(line);
      if (mod) push(mod[1]);
    }
    return out;
  }

  if (lang === 'go') {
    let inBlock = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!inBlock) {
        if (/^import\s*\($/.test(line)) { inBlock = true; continue; }
        const one = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(line);
        if (one) push(one[1]);
        continue;
      }
      if (line.startsWith(')')) { inBlock = false; continue; }
      const inner = /^(?:[\w.]+\s+)?"([^"]+)"/.exec(line);
      if (inner) push(inner[1]);
    }
    return out;
  }

  if (lang === 'jvm') {
    for (const raw of lines) {
      const line = raw.trim();
      const imp = /^import\s+(?:static\s+)?([\w.]+)\s*;/.exec(line);
      if (imp) { push(imp[1]); continue; }
      // C# `using X;` and `using Alias = X;` -- never `using (` or `using var`.
      const usg = /^using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([\w.]+)\s*;/.exec(line);
      if (usg) push(usg[1]);
    }
    return out;
  }

  return out;
}

/** `client/src/lib` + `../util` -> `client/src/util`. '' if it climbs out. */
function joinPath(dir: string, rel: string): string {
  const segs = dir.length > 0 ? dir.split('/') : [];
  for (const s of rel.split('/')) {
    if (s.length === 0 || s === '.') continue;
    if (s === '..') {
      if (segs.length === 0) return '';
      segs.pop();
      continue;
    }
    segs.push(s);
  }
  return segs.join('/');
}

/**
 * Every dotted suffix of `dotted`, longest first, down to TWO segments.
 *
 * Never down to one. `import json` in a Python file is the standard library,
 * and a repo that happens to hold `plugin/hooks/hooks.json` would otherwise
 * turn it into an edge -- a wrong answer that looks exactly like a right one.
 * A one-segment specifier is handled separately, as a same-directory sibling.
 */
function importCandidates(dotted: string): string[] {
  if (dotted.length === 0) return [];
  const segs = dotted.split('.').filter(s => s.length > 0);
  if (segs.length < 2) return [];
  const out: string[] = [];
  for (let start = 0; start <= segs.length - 2; start++) {
    out.push(segs.slice(start).join('.'));
  }
  return out;
}

/** The dotted module path of every node in a repo, scanned once per call. */
type ModIndex = { id: bigint; mod: string }[];

type Resolution = { ids: bigint[]; how: 'exact' | 'suffix' | 'ambiguous' | 'none' };

/**
 * An import specifier -> the node ids of the repo file it names, or nothing.
 *
 * TWO shapes, and both end at the SAME rule `report_touch` uses -- `dottedPath`
 * for the normalisation and `suffixMatch` for the comparison. One
 * implementation, so the resolver a human reads about in the tooltip and the
 * resolver a touch goes through cannot drift apart.
 *
 *   RELATIVE (`./store`, `../lib/util`, `from .models import`, `#include "x.h"`)
 *     is joined against the importing file's own directory, so it names exactly
 *     one file and is matched at full length. A bare directory also tries
 *     `<dir>/index`, which is what a JS resolver does.
 *
 *   PACKAGE (`django.forms.fields`, `crate::graph::walk`, `com.acme.Thing`)
 *     is matched by longest dotted suffix, because the repo's own prefix
 *     (`src/`, a Go module path, a Java source root) is not in the specifier.
 *
 * Nothing is guessed. A specifier that matches no file, or that matches more
 * than MAX_IMPORT_FANOUT files and is therefore not evidence of anything, is
 * dropped and counted.
 */
function resolveImportSpec(
  spec: string,
  importerPath: string,
  lang: Lang,
  mods: ModIndex
): Resolution {
  const hit = (cand: string): bigint[] => {
    const ids: bigint[] = [];
    for (const m of mods) if (suffixMatch(m.mod, cand)) ids.push(m.id);
    return ids;
  };

  const dir = dirOf(importerPath);

  // ---- relative -----------------------------------------------------------
  let relBase: string | null = null;
  if (lang === 'py' && spec.startsWith('.')) {
    let ups = 0;
    while (ups < spec.length && spec.charAt(ups) === '.') ups += 1;
    let d = dir;
    for (let i = 1; i < ups; i++) {
      const up = parentDir(d);
      if (up === null) { d = ''; break; }
      d = up;
    }
    const rest = spec.slice(ups).split('.').join('/');
    relBase = rest.length > 0 ? joinPath(d, rest) : d;
  } else if (lang === 'rs' && (spec === 'super' || spec.startsWith('super.') || spec.startsWith('super:'))) {
    const up = parentDir(dir);
    const rest = spec.replace(/^super(?:::|\.)?/, '').split(/::|\./).join('/');
    relBase = up === null ? '' : joinPath(up, rest);
  } else if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    relBase = joinPath(dir, spec);
  } else if (lang === 'c') {
    // A quoted include is relative to the includer first, then to any root.
    relBase = joinPath(dir, spec);
  }

  if (relBase !== null) {
    for (const cand of [dottedPath(relBase), dottedPath(`${relBase}/index`)]) {
      if (cand.length === 0) continue;
      const ids = hit(cand);
      if (ids.length > 0 && ids.length <= MAX_IMPORT_FANOUT) return { ids, how: 'exact' };
      if (ids.length > MAX_IMPORT_FANOUT) return { ids: [], how: 'ambiguous' };
    }
    // A quoted C include also legitimately names a file by a repo-root path.
    if (lang !== 'c') return { ids: [], how: 'none' };
  }

  // ---- package style ------------------------------------------------------
  //
  // A bare JS specifier with no slash (`react`, `lodash`) is a node_modules
  // package by definition, and matching it against a file that happens to be
  // called `react.js` would invent an edge. Skipped, not guessed.
  if (lang === 'js' && spec.indexOf('/') === -1) return { ids: [], how: 'none' };

  let norm = spec.split('::').join('.').split('/').join('.');
  if (lang === 'rs') norm = norm.replace(/^(?:crate|self)\./, '');
  const dotted = dottedPath(norm.split('.').join('/'));

  // A ONE-SEGMENT specifier (`import map_room`, `import json`) is only a file
  // in this repo if that file is sitting right next to the importer. Matched
  // repo-wide it would catch anything whose module happens to end in that
  // word, which is how `import json` became an edge to `hooks.json`.
  if (dotted.indexOf('.') === -1) {
    const sib = dottedPath(joinPath(dir, dotted));
    if (sib.length === 0) return { ids: [], how: 'none' };
    const ids = hit(sib);
    if (ids.length === 0) return { ids: [], how: 'none' };
    if (ids.length > MAX_IMPORT_FANOUT) return { ids: [], how: 'ambiguous' };
    return { ids, how: 'exact' };
  }

  for (const cand of importCandidates(dotted)) {
    const ids = hit(cand);
    if (ids.length === 0) continue;
    if (ids.length > MAX_IMPORT_FANOUT) return { ids: [], how: 'ambiguous' };
    return { ids, how: 'suffix' };
  }
  return { ids: [], how: 'none' };
}

// A named callable, class or top-level binding. This is what block height is
// a function of, so it is a LINE YOU CAN GO AND LOOK AT, not an estimate.
const SYM_PATTERNS: RegExp[] = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$]/,
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$]/,
  /^(?:export\s+)?(?:declare\s+)?(?:interface|enum|struct|trait|impl)\s+[A-Za-z_$]/,
  /^(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*[=<]/,
  /^(?:async\s+)?def\s+[A-Za-z_]/,
  /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+[A-Za-z_]/,
  /^func\s*(?:\([^)]*\)\s*)?[A-Za-z_]/,
  /^(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>\[\],. ]+\s+[A-Za-z_]\w*\s*\(/,
];
/** `export const x = …`, or a top-level `const x = …` at column 0. */
const SYM_BINDING = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*[=:]/;

function countSymbols(text: string): number {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    if (line.startsWith('#') && !line.startsWith('#[')) continue;
    let matched = false;
    for (const re of SYM_PATTERNS) {
      if (re.test(line)) { matched = true; break; }
    }
    // A binding only counts at the top level -- otherwise every local in every
    // function body would be a "symbol" and height would measure verbosity.
    if (!matched && SYM_BINDING.test(line) && (raw.charAt(0) !== ' ' && raw.charAt(0) !== '\t')) {
      matched = true;
    }
    if (matched) n += 1;
  }
  return n;
}

/** The strict schema. `additionalProperties:false` and full `required` throughout. */
function fileFactsSchema(): unknown {
  return {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            summary: { type: 'string' },
            role: {
              type: 'string',
              enum: ['entry', 'config', 'model', 'view', 'controller', 'test', 'util', 'generated'],
            },
            symbols: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  line: { type: 'integer' },
                  kind: { type: 'string' },
                },
                required: ['name', 'line', 'kind'],
                additionalProperties: false,
              },
            },
            importance: { type: 'integer', minimum: 1, maximum: 5 },
          },
          required: ['path', 'summary', 'role', 'symbols', 'importance'],
          additionalProperties: false,
        },
      },
    },
    required: ['files'],
    additionalProperties: false,
  };
}

type LlmFact = { summary: string; role: string; importance: number; symbols: number };

/** Clamp to what the column can hold, so a long answer truncates rather than throws. */
function clampSummary(s: string): string {
  const one = String(s || '').trim().replace(/\s+/g, ' ');
  return one.length > 300 ? one.slice(0, 300) : one;
}

/**
 * Deepen an indexed repo: real import edges, and a real size for every block.
 *
 * Resumable and idempotent. `offset`/`limit` walk the repo's file nodes in id
 * order -- which `index_repo` made deterministic by sorting the tree -- so the
 * client can drive batches, stop halfway, and pick up exactly where it left
 * off. Re-running a batch replaces that batch's IMPORTS edges rather than
 * doubling them.
 *
 * `api_key` is an ARGUMENT. It is never stored, never logged and never a
 * constant. Passing '' is supported and does something useful: the regex half
 * still runs, so imports and block heights land WITHOUT any model at all. The
 * model is only ever asked for prose.
 *
 * Returns `ok offset= done= total= skipped= imports=` plus the resolution
 * counters, because "how many imports did you throw away" is a question this
 * has to be able to answer out loud.
 */
export const enrichRepo = spacetimedb.procedure(
  { name: 'enrich_repo' },
  { repo_id: t.u64(), offset: t.u32(), limit: t.u32(), api_key: t.string() },
  t.string(),
  (ctx, { repo_id, offset, limit, api_key }) => {
    const key = api_key.trim();
    const want = Math.max(1, Math.min(MAX_ENRICH_LIMIT, Number(limit) || 0));
    const from = Math.max(0, Number(offset) || 0);

    // ---- 1. read the repo out of the database, then let the tx go ----------
    let owner = '';
    let ghRepo = '';
    let total = 0;
    let batch: { id: bigint; path: string }[] = [];
    const mods: ModIndex = [];
    let bad = '';

    ctx.withTx(tx => {
      const r = tx.db.repo.id.find(repo_id);
      if (!r) { bad = `error: no repo ${repo_id}`; return; }
      const or = ownerRepoOf(tx.db, repo_id);
      if (!or) { bad = `error: repo ${repo_id} (${r.slug}) has no owner/repo to fetch from`; return; }
      owner = or.owner;
      ghRepo = or.repo;

      const filesInRepo: { id: bigint; path: string }[] = [];
      for (const n of tx.db.node.repo_id.filter(repo_id)) {
        mods.push({ id: n.id, mod: nodeModule(n.qual) });
        // Only nodes `index_repo` minted are one-node-per-file, which is what
        // makes "fetch this node's file" a sane thing to do. Seeded graphs are
        // per-FUNCTION: enriching them would fetch the same file hundreds of
        // times. NewLand is a path with no file behind it yet.
        if (n.id < INDEX_ID_BASE) continue;
        if (n.kind === 'NewLand') continue;
        const path = pathOfNode(n.qual);
        if (path.length === 0) continue;
        filesInRepo.push({ id: n.id, path });
      }
      if (filesInRepo.length === 0) {
        bad =
          `error: repo ${repo_id} (${r.slug}) holds no index_repo file nodes; ` +
          `enrich_repo only deepens maps built by index_repo`;
        return;
      }
      filesInRepo.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      total = filesInRepo.length;
      batch = filesInRepo.slice(from, from + want);
    });
    if (bad.length > 0) return bad;
    if (batch.length === 0) {
      return `ok offset=${from} done=0 total=${total} skipped=0 imports=0 note=past-the-end`;
    }

    // ---- 2. fetch each file (no transaction is open) -----------------------
    type Fetched = { id: bigint; path: string; text: string; loc: number; symbols: number };
    const got: Fetched[] = [];
    let skipped = 0;
    const misses: string[] = [];
    for (const f of batch) {
      let res;
      try {
        res = ctx.http.fetch(
          `https://raw.githubusercontent.com/${owner}/${ghRepo}/HEAD/${f.path}`,
          { method: 'GET', headers: { 'User-Agent': 'map-room' } }
        );
      } catch {
        skipped += 1;
        if (misses.length < 3) misses.push(`${f.path}:fetch-threw`);
        continue;
      }
      if (res.status !== 200) {
        skipped += 1;
        if (misses.length < 3) misses.push(`${f.path}:${res.status}`);
        continue;
      }
      const text = res.text().slice(0, ENRICH_FILE_CHARS);
      got.push({
        id: f.id,
        path: f.path,
        text,
        loc: text.split('\n').length,
        symbols: countSymbols(text),
      });
    }

    // ---- 3. imports: regex, resolve, and count what was thrown away --------
    type Pair = { src: bigint; dst: bigint };
    const pairs: Pair[] = [];
    const seenPair = new Set<string>();
    let seen = 0;
    let resolved = 0;
    let unresolved = 0;
    let ambiguous = 0;

    for (const f of got) {
      const lang = langOf(f.path);
      const specs = extractImports(f.text, lang);
      let written = 0;
      const done = new Set<string>();
      for (const spec of specs) {
        if (done.has(spec)) continue;
        done.add(spec);
        seen += 1;
        if (written >= MAX_IMPORTS_PER_FILE) continue;
        const r = resolveImportSpec(spec, f.path, lang, mods);
        if (r.how === 'ambiguous') { ambiguous += 1; continue; }
        if (r.ids.length === 0) { unresolved += 1; continue; }
        resolved += 1;
        for (const dst of r.ids) {
          if (dst === f.id) continue; // a file does not import itself
          const k = `${f.id}|${dst}`;
          if (seenPair.has(k)) continue;
          seenPair.add(k);
          pairs.push({ src: f.id, dst });
          written += 1;
        }
      }
    }

    // ---- 4. one batched model call, for prose only -------------------------
    const facts = new Map<string, LlmFact>();
    let llm = 'skipped';
    let modelSymbols = 0;
    if (key.length > 0 && got.length > 0) {
      const blocks: string[] = [];
      for (const f of got) {
        blocks.push(
          `=== FILE: ${f.path} (${f.loc} lines) ===\n${f.text.slice(0, LLM_FILE_CHARS)}`
        );
      }
      const system =
        'You label files on a map of a codebase. For every file you are given, ' +
        'return exactly one object, echoing its path back VERBATIM. Never invent ' +
        'a file that was not given to you. summary: one sentence, start with a ' +
        'verb, at most 20 words, no markdown, no filename. role: the single best ' +
        'fit. symbols: the top-level named functions, classes and exported ' +
        'constants, at most 12 per file, with the 1-based line each is declared ' +
        'on. importance: 1 = incidental, 5 = the file you would read first.';

      let llmRes;
      try {
        llmRes = ctx.http.fetch(OPENAI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'User-Agent': 'map-room',
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: blocks.join('\n\n') },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'file_facts', strict: true, schema: fileFactsSchema() },
            },
          }),
        });
      } catch {
        llmRes = null;
      }

      if (!llmRes) {
        llm = 'unreachable';
      } else if (llmRes.status !== 200) {
        // The status is the honest answer. 401 means the key is wrong, and that
        // is a fact worth surfacing rather than swallowing into "0 summaries".
        llm = `http-${llmRes.status}`;
      } else {
        let content = '';
        try {
          const data = llmRes.json() as {
            choices?: { message?: { content?: string } }[];
          };
          content = data.choices?.[0]?.message?.content ?? '';
        } catch {
          content = '';
        }
        if (content.length === 0) {
          llm = 'empty';
        } else {
          try {
            const parsed = JSON.parse(content) as {
              files?: {
                path?: string; summary?: string; role?: string;
                importance?: number; symbols?: unknown[];
              }[];
            };
            const rows = Array.isArray(parsed.files) ? parsed.files : [];
            for (const row of rows) {
              const p = typeof row.path === 'string' ? row.path.trim() : '';
              if (p.length === 0) continue;
              const syms = Array.isArray(row.symbols) ? row.symbols.length : 0;
              modelSymbols += syms;
              facts.set(p, {
                summary: clampSummary(row.summary ?? ''),
                role: typeof row.role === 'string' ? row.role : '',
                importance: Math.max(0, Math.min(5, Math.trunc(Number(row.importance) || 0))),
                symbols: syms,
              });
            }
            llm = `${OPENAI_MODEL}:${facts.size}/${got.length}`;
          } catch {
            llm = 'unparseable';
          }
        }
      }
    }

    // ---- 5. write: edges, then file_meta -----------------------------------
    let edgesWritten = 0;
    let edgesDropped = 0;
    ctx.withTx(tx => {
      // Re-running a batch REPLACES its import edges. CONTAINS / IN_DIR are
      // untouched: they are a weaker structural layer that still answers
      // "what is near this" when a file imports nothing at all.
      const stale: bigint[] = [];
      for (const f of got) {
        for (const e of tx.db.edge.src.filter(f.id)) {
          if (e.kind === 'IMPORTS') stale.push(e.id);
        }
      }
      for (const id of stale) {
        tx.db.edge.id.delete(id);
        edgesDropped += 1;
      }

      for (const p of pairs) {
        tx.db.edge.insert({ id: 0n, repo_id, src: p.src, dst: p.dst, kind: 'IMPORTS' });
        edgesWritten += 1;
      }

      for (const f of got) {
        const fact = facts.get(f.path);
        const row = {
          node_id: f.id,
          repo_id,
          symbols: f.symbols,
          loc: f.loc,
          summary: fact ? fact.summary : '',
          role: fact ? fact.role : '',
          importance: fact ? fact.importance : 0,
          at: tx.timestamp,
        };
        if (tx.db.file_meta.node_id.find(f.id)) {
          tx.db.file_meta.node_id.update(row);
        } else {
          tx.db.file_meta.insert(row);
        }
      }

      // The repo's edge count is a number a human reads off the gallery card;
      // leaving it at the index-time value would make the map look unchanged.
      const r = tx.db.repo.id.find(repo_id);
      if (r) {
        let n = 0;
        for (const _e of tx.db.edge.repo_id.filter(repo_id)) n += 1;
        tx.db.repo.id.update({ ...r, edge_count: n });
      }
    });

    const rate = seen > 0 ? Math.round((resolved / seen) * 100) : 0;
    return (
      `ok offset=${from} done=${got.length} total=${total} skipped=${skipped} ` +
      `imports=${edgesWritten} seen=${seen} resolved=${resolved} rate=${rate}% ` +
      `unresolved=${unresolved} ambiguous=${ambiguous} replaced=${edgesDropped} ` +
      `sym_regex=${got.reduce((a, f) => a + f.symbols, 0)} sym_model=${modelSymbols} ` +
      `llm=${llm} next=${from + batch.length}` +
      (misses.length > 0 ? ` misses=${misses.join(',')}` : '')
    );
  }
);
