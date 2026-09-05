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

const spacetimedb = schema({
  repo,
  node,
  edge,
  participant,
  walk,
  frontier,
  verdict,
});
export default spacetimedb;

// ------------------------------------------------------------------ helpers

type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;

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

export const create_repo = spacetimedb.reducer(
  { name: 'create_repo' },
  { slug: t.string(), label: t.string() },
  (ctx, { slug, label }) => {
    // Idempotent: re-running the seeder must not fork a second repo row.
    for (const existing of ctx.db.repo.slug.filter(slug)) {
      ctx.db.repo.id.update({ ...existing, label, status: 'loading' });
      return;
    }
    ctx.db.repo.insert({
      id: 0n,
      slug,
      label,
      node_count: 0,
      edge_count: 0,
      reachability: 0.0,
      status: 'loading',
    });
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

export const finish_repo = spacetimedb.reducer(
  { name: 'finish_repo' },
  { repo_id: t.u64(), reachability: t.f32() },
  (ctx, { repo_id, reachability }) => {
    const r = ctx.db.repo.id.find(repo_id);
    if (!r) return;
    let nodes = 0;
    for (const _ of ctx.db.node.repo_id.filter(repo_id)) nodes += 1;
    let edges = 0;
    for (const _ of ctx.db.edge.repo_id.filter(repo_id)) edges += 1;
    ctx.db.repo.id.update({
      ...r,
      node_count: nodes,
      edge_count: edges,
      reachability,
      status: 'ready',
    });
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
