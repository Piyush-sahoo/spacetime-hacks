/**
 * THE BLAST RADIUS — if I change this file, what else is in it?
 *
 * `enrich_repo` already wrote `IMPORTS` edges by reading the actual import
 * statements out of each file, and the client already mirrors the whole `edge`
 * table. So this asks nothing new of the server: it is a re-index of rows that
 * are already on the wire.
 *
 * FILE GRANULARITY, ON PURPOSE. `edge.src` and `edge.dst` are node ids, and
 * `territory.byNode` maps a node to the file it lives in. The map's atom is a
 * file, so the adjacency is built in file indices and every lookup downstream is
 * an array index rather than a scan.
 *
 * BUILT ONCE. `edges.filter()` per selection is fine on a 98-edge repo and
 * stutters on django/django's 22,880 — so the whole thing is inverted a single
 * time, memoised on the edge list, and a selection is two Map lookups.
 */

import { key } from './util'

/** How many related blocks get a line drawn to them before the rest is a count. */
export const MAX_DRAWN = 10
/** How many get a row in the panel before the rest is a `+N more`. */
export const MAX_LISTED = 6

const EMPTY = { kind: 'none', out: [], in: [], near: [], total: 0 }

function add(m, a, b) {
  let s = m.get(a)
  if (!s) { s = new Set(); m.set(a, s) }
  s.add(b)
}

/**
 * @param edges  raw `edge` rows off the subscription
 * @param byNode Map(nodeIdString -> file index), from `buildTerritory`
 * @returns { out, in: inn, near, imports } — three Map(fileIndex -> Set(fileIndex))
 *
 * `out`/`in` are IMPORTS and mean a real dependency. `near` is the CONTAINS /
 * IN_DIR star the indexer writes to keep the graph connected: it says two files
 * sit in the same directory and NOTHING about whether one uses the other, which
 * is why it is kept in a separate map and labelled structural everywhere it is
 * drawn.
 */
export function buildAdjacency(edges, byNode) {
  const out = new Map()
  const inn = new Map()
  const near = new Map()
  let imports = 0
  for (const e of edges || []) {
    const s = byNode.get(key(e.src))
    if (s === undefined) continue
    const d = byNode.get(key(e.dst))
    if (d === undefined || d === s) continue
    if (e.kind === 'IMPORTS') {
      add(out, s, d)
      add(inn, d, s)
      imports += 1
    } else {
      // CONTAINS and IN_DIR are written as an exact mirror of each other, so
      // collapsing them into one undirected set is lossless and halves the fan.
      add(near, s, d)
      add(near, d, s)
    }
  }
  return { out, in: inn, near, imports }
}

/**
 * What selecting file `fi` lights up.
 *
 * IMPORTS WINS. A file with even one import edge is answered entirely in real
 * dependencies; the structural star is offered only to a file that has none at
 * all, and then it comes back tagged `structural` so the caller can say out
 * loud that it is a directory fact, not a dependency.
 */
export function blastOf(adj, fi) {
  if (!adj || fi == null || fi < 0) return EMPTY
  const o = adj.out.get(fi)
  const i = adj.in.get(fi)
  const no = o ? o.size : 0
  const ni = i ? i.size : 0
  if (no || ni) {
    return {
      kind: 'imports',
      out: o ? [...o] : [],
      in: i ? [...i] : [],
      near: [],
      total: no + ni,
    }
  }
  const n = adj.near.get(fi)
  if (n && n.size) return { kind: 'structural', out: [], in: [], near: [...n], total: n.size }
  return EMPTY
}
