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
  agent_session,
  exploration_request,
  path_cache,
  repo_index,
  node_summary,
  new_land,
  new_land_seq,
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
      segs.pop();
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

      ctx.db.touch.insert({
        id: 0n,
        repo_id,
        node_id: ids.length > 0 ? ids[0] : 0n,
        path: p,
        tool,
        session: skey,
        agent_name,
        at: now,
      });

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
