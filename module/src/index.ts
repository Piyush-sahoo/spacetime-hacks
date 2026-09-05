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
    // The node set just changed, so every memoised path resolution is stale.
    ctx.db.path_cache.repo_id.delete(repo_id);
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
  '.rs', '.cs', '.go', '.java', '.rb', '.kt', '.scala',
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
  return mod.split('.').join('/') + '.py';
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
    if (paths.length === 0) {
      bumpSession(ctx, session, agent_name, repo_id, 0);
      return;
    }

    const now = ctx.timestamp;
    const resolved = resolvePaths(ctx, repo_id, paths);

    for (const p of paths) {
      const ids = resolved.get(p) ?? [];

      ctx.db.touch.insert({
        id: 0n,
        repo_id,
        node_id: ids.length > 0 ? ids[0] : 0n,
        path: p,
        tool,
        session,
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
            last_session: session,
            explored: true,
            last_at: now,
          });
        } else {
          ctx.db.node_cov.insert({
            node_id: nodeId,
            repo_id,
            touches: 1,
            last_tool: tool,
            last_session: session,
            explored: true,
            last_at: now,
          });
        }
      }
    }

    bumpSession(ctx, session, agent_name, repo_id, paths.length);
  }
);

/** Keeps an agent visible in the presence rail between tool calls. */
export const agent_heartbeat = spacetimedb.reducer(
  { name: 'agent_heartbeat' },
  { session: t.string(), agent_name: t.string(), repo_id: t.u64() },
  (ctx, { session, agent_name, repo_id }) => {
    bumpSession(ctx, session, agent_name, repo_id, 0);
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
