import { Graph, layout as dagreLayout } from '@dagrejs/dagre'

/**
 * THE GRAPH — a layered node-link diagram of the repo, laid out like `dot`.
 *
 * Ranks flow left to right. Every item is a circle with a label under it and a
 * directed arrow to whatever it points at. Nothing here reads coverage: the
 * geometry is a pure function of `node` + `edge`, which is the whole reason a
 * touch landing mid-demo can only ever change a colour.
 *
 * Two jobs live in this file:
 *
 *   scope   — a repo of 2,975 files is not 2,975 circles. `pickScope` finds the
 *             deepest directory depth that still fits under CAP, and clicking a
 *             directory pushes a prefix and re-scopes underneath it.
 *   layout  — dagre does the part that is genuinely hard (rank assignment and
 *             the median/transpose crossing reduction). Coordinates are ours,
 *             because dagre will happily put 45 siblings in one column and a
 *             rank that tall is unreadable at any zoom. Wide ranks wrap into
 *             sub-columns instead, which is what keeps the aspect ratio near
 *             the viewport's and the labels legible at fit.
 */

// Past this many circles a screen stops being a diagram and starts being a
// texture. The demo repo (70) and flask (83) are comfortably under it.
export const CAP = 260

const SHIPPED_PREFIX = /^data\.repos\.[^.]+\./

export function moduleOf(qual) {
  const q = String(qual || '')
  const i = q.indexOf('::')
  const m = (i === -1 ? q : q.slice(0, i)).replace(SHIPPED_PREFIX, '')
  return m || 'unknown'
}

/**
 * `client.src.components.ConnBadge` + `ConnBadge.jsx` -> `client/src/components/ConnBadge.jsx`
 *
 * The module path is dot-joined, so a filename that already contains dots came
 * in split across several segments: `client.postcss.config` + `postcss.config.js`.
 * Rejoining those blindly gives `client/postcss/postcss.config.js`, so the tail
 * segments that merely respell the filename are dropped first.
 */
export function filePath(mod, name) {
  const segs = String(mod).split('.')
  const isFile = name && /\.[a-z0-9]+$/i.test(name)
  const base = isFile ? name : segs[segs.length - 1]
  let cut = segs.length - 1
  if (isFile) {
    const stem = String(name).replace(/\.[a-z0-9]+$/i, '')
    for (let i = 0; i < segs.length; i += 1) {
      if (segs.slice(i).join('.') === stem) { cut = i; break }
    }
  }
  const dir = segs.slice(0, cut).join('/')
  return dir ? `${dir}/${base}` : base
}

const MAX_LABEL = 19
export function short(s) {
  const t = String(s || '')
  return t.length <= MAX_LABEL ? t : `${t.slice(0, MAX_LABEL - 1)}…`
}

/**
 * Every graph node, normalised once: which module it lives in, what to call it,
 * and whether it is ground the survey never had.
 */
export function buildEntries(nodes) {
  const out = new Array(nodes.length)
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]
    const mod = moduleOf(n.qual)
    out[i] = {
      id: typeof n.id === 'bigint' ? n.id.toString() : String(n.id),
      raw: n.id,
      mod,
      segs: mod.split('.'),
      name: String(n.name || mod.split('.').pop()),
      kind: String(n.kind || ''),
      isNew: n.kind === 'NewLand',
      isTest: n.kind === 'Test',
    }
  }
  // Sorted by id, so every tab builds the identical model from the identical
  // rows no matter what order the subscription delivered them in.
  out.sort((a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

const underPrefix = (e, prefix) => {
  for (let i = 0; i < prefix.length; i += 1) if (e.segs[i] !== prefix[i]) return false
  return true
}

/**
 * How deep to cut under `prefix`.
 *
 * Deeper is always more informative, so take the deepest cut that still fits
 * under CAP — and when everything under the prefix fits, stop grouping and draw
 * the actual graph nodes.
 */
export function pickScope(entries, prefix) {
  const under = entries.filter((e) => underPrefix(e, prefix))
  if (!under.length) return { prefix, depth: 0, full: true, n: 0 }
  if (under.length <= CAP) return { prefix, depth: 0, full: true, n: under.length }
  let maxSeg = 0
  for (const e of under) if (e.segs.length > maxSeg) maxSeg = e.segs.length
  let best = prefix.length + 1
  for (let d = prefix.length + 1; d <= maxSeg; d += 1) {
    const keys = new Set()
    for (const e of under) keys.add(e.segs.slice(0, d).join('.'))
    if (keys.size > CAP) break
    best = d
  }
  return { prefix, depth: best, full: false, n: under.length }
}

/**
 * The items on screen at one scope, plus the arrows between them.
 *
 * A group's arrows are its members' arrows with the ends re-pointed at the
 * group, edges inside a group dropped, and the rest counted — so a thick "×12"
 * between two directories is twelve real calls, not a guess.
 */
export function buildLevel(entries, edges, scope) {
  const { prefix, depth, full } = scope
  const under = entries.filter((e) => underPrefix(e, prefix))
  const items = []
  const byKey = new Map()
  const itemOfNode = new Map()

  for (const e of under) {
    const key = full ? e.id : e.segs.slice(0, depth).join('.')
    let it = byKey.get(key)
    if (!it) {
      const isLeafKey = full || depth >= e.segs.length
      it = {
        key,
        kind: full ? 'sym' : isLeafKey ? 'file' : 'dir',
        label: full ? e.name : (e.segs[depth - 1] || e.segs[e.segs.length - 1] || key),
        sub: '',
        mod: e.mod,
        ids: [],
        rawIds: [],
        count: 0,
        tests: 0,
        news: 0,
        pick: e.raw,
        path: full ? filePath(e.mod, e.name) : key.split('.').join('/'),
      }
      byKey.set(key, it)
      items.push(it)
    }
    it.ids.push(e.id)
    it.rawIds.push(e.raw)
    it.count += 1
    if (e.isTest) it.tests += 1
    if (e.isNew) it.news += 1
    itemOfNode.set(e.id, it)
  }

  // Stable ordering: by key. Index assignment must not depend on row arrival.
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  items.forEach((it, i) => {
    it.i = i
    it.isNew = it.news === it.count && it.count > 0
    if (!full && it.kind === 'file' && it.count > 1) it.sub = `${it.count}`
    if (it.kind === 'dir') it.sub = `${it.count}`
  })
  for (const it of items) for (const id of it.ids) itemOfNode.set(id, it)

  // ── arrows ────────────────────────────────────────────────────────────────
  const pairs = new Map()
  for (const e of edges) {
    const s = itemOfNode.get(typeof e.src === 'bigint' ? e.src.toString() : String(e.src))
    const t = itemOfNode.get(typeof e.dst === 'bigint' ? e.dst.toString() : String(e.dst))
    if (!s || !t || s === t) continue
    const k = `${s.i}>${t.i}`
    let p = pairs.get(k)
    if (!p) { p = { s: s.i, t: t.i, w: 0, kind: String(e.kind || '') }; pairs.set(k, p) }
    p.w += 1
  }
  // A CONTAINS with an IN_DIR pointing straight back is one relationship drawn
  // twice. Collapse the pair and mark it, rather than printing two arrowheads
  // on top of each other on every single edge in the graph.
  const links = []
  const seen = new Set()
  for (const [k, p] of [...pairs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (seen.has(k)) continue
    const back = pairs.get(`${p.t}>${p.s}`)
    if (back) { seen.add(`${p.t}>${p.s}`); p.bidi = true; p.w += back.w }
    seen.add(k)
    links.push(p)
  }
  const kinds = new Set(links.map((l) => l.kind).filter(Boolean))
  return { items, links, itemOfNode, full, prefix, depth, multiKind: kinds.size > 1 }
}

// ── geometry constants ──────────────────────────────────────────────────────
export const R_NODE = 9.5
const LABEL_PX = 12
// Geist Mono advance at 12px. Measured in the browser (6.6001px at 11px),
// not guessed — this number is what reserves the column a label sits in, and
// if it is short the labels of adjacent sub-columns run into each other.
const CHAR_W = 7.21
const LABEL_GAP = 6
const LABEL_H = 13
const ROW_PITCH = 48
const RANK_GAP = 44
const COL_GAP = 18

/**
 * The shape we are drawing INTO.
 *
 * A rank layout left to itself comes out as a ribbon — 70 nodes over 5 ranks
 * is 1890x391, and fitting a 4.8:1 ribbon into a 1.4:1 plate throws away two
 * thirds of the height and shrinks the type to 5px. So the wrap is chosen to
 * maximise the scale the drawing fits the plate at, which is what buys the
 * type enough pixels to be read.
 *
 * It is a CONSTANT, not the live element size: the geometry must not depend on
 * the viewport, or a window resize would be able to move the ground.
 */
const TARGET_ASPECT = 1.39

const labelW = (it) => Math.max(2 * R_NODE + 8, short(it.label).length * CHAR_W + 6)

/**
 * Rank, order, place.
 *
 * dagre gets a graph of unit-sized boxes: all we want from it is the ranking
 * and the within-rank order it spent its crossing-reduction budget on. The
 * coordinates are assigned here so a rank of forty-five can wrap into four
 * readable sub-columns instead of one 2,000px column nobody can read.
 */
export function layoutLevel(level) {
  const { items, links } = level
  const n = items.length
  if (!n) return { nodes: [], edges: [], w: 1, h: 1, x0: 0, y0: 0, ranks: 0 }

  const g = new Graph({ directed: true, multigraph: false, compound: false })
  g.setGraph({ rankdir: 'LR', ranksep: 24, nodesep: 12, edgesep: 8, marginx: 0, marginy: 0, ranker: 'network-simplex' })
  g.setDefaultEdgeLabel(() => ({}))
  for (let i = 0; i < n; i += 1) g.setNode(String(i), { width: 10, height: 10 })
  for (const l of links) if (l.s !== l.t) g.setEdge(String(l.s), String(l.t), { weight: 1 })
  dagreLayout(g)

  // dagre in LR mode puts every node of a rank on the same rank axis, so the
  // distinct x values ARE the ranks and y is the order inside one.
  const placed = []
  for (let i = 0; i < n; i += 1) {
    const nd = g.node(String(i))
    placed.push({ i, x: nd ? nd.x : 0, y: nd ? nd.y : 0 })
  }
  const rankOf = new Map()
  const xs = [...new Set(placed.map((p) => Math.round(p.x * 100) / 100))].sort((a, b) => a - b)
  xs.forEach((x, r) => rankOf.set(x, r))
  const ranks = []
  for (const p of placed) {
    const r = rankOf.get(Math.round(p.x * 100) / 100) ?? 0
    if (!ranks[r]) ranks[r] = []
    ranks[r].push(p)
  }
  for (const r of ranks) r.sort((a, b) => (a.y - b.y) || (a.i - b.i))

  // Wrap wide ranks. How tall a rank may grow before it spills into a second
  // sub-column decides the whole aspect ratio, so rather than guess it, measure
  // every candidate and keep the one the plate fits at the largest scale —
  // which is exactly the one whose labels end up with the most pixels.
  const colWOf = (bucket) => Math.max(...bucket.map((p) => labelW(items[p.i])))
  const measure = (rowCap) => {
    let w = 0
    let block = 0
    for (const bucket of ranks) {
      if (!bucket || !bucket.length) continue
      const cols = Math.max(1, Math.ceil(bucket.length / rowCap))
      const rows = Math.ceil(bucket.length / cols)
      w += cols * colWOf(bucket) + (cols - 1) * COL_GAP + RANK_GAP
      if (rows * ROW_PITCH > block) block = rows * ROW_PITCH
    }
    // The same bounds the caller reports, so the choice is made on the real
    // extent rather than on an approximation of it.
    return [
      Math.max(1, w - RANK_GAP + 2 * R_NODE + 8),
      Math.max(1, block - ROW_PITCH + 2 * R_NODE + LABEL_GAP + LABEL_H + 18),
    ]
  }
  let widest = 1
  for (const bucket of ranks) if (bucket && bucket.length > widest) widest = bucket.length
  let maxRows = widest
  let bestScore = Infinity
  for (let cap = 1; cap <= widest; cap += 1) {
    const [w, h] = measure(cap)
    // Fitting w x h into an A:1 plate scales by min(A/w, 1/h); maximising that
    // is minimising max(w/A, h).
    const score = Math.max(w / TARGET_ASPECT, h)
    // Strictly-better only, so the smallest cap wins a tie and every tab builds
    // the identical array.
    if (score < bestScore - 1e-9) { bestScore = score; maxRows = cap }
  }

  const nodes = new Array(n)
  let cursor = 0
  let minY = Infinity
  let maxY = -Infinity
  for (let r = 0; r < ranks.length; r += 1) {
    const bucket = ranks[r] || []
    if (!bucket.length) continue
    const cols = Math.max(1, Math.ceil(bucket.length / maxRows))
    const rows = Math.ceil(bucket.length / cols)
    const colW = Math.max(...bucket.map((p) => labelW(items[p.i])))
    const blockH = rows * ROW_PITCH
    for (let j = 0; j < bucket.length; j += 1) {
      const c = Math.floor(j / rows)
      const row = j % rows
      // The last column may be short; centre it against the full block.
      const inCol = Math.min(rows, bucket.length - c * rows)
      const y = -blockH / 2 + ROW_PITCH / 2 + row * ROW_PITCH + ((rows - inCol) * ROW_PITCH) / 2
      const x = cursor + c * (colW + COL_GAP) + colW / 2
      const it = items[bucket[j].i]
      nodes[bucket[j].i] = { i: bucket[j].i, x, y, rank: r, col: c, w: colW, it }
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    cursor += cols * colW + (cols - 1) * COL_GAP + RANK_GAP
  }

  const x0 = -R_NODE - 4
  const x1 = cursor - RANK_GAP + R_NODE + 4
  const y0 = minY - R_NODE - 10
  const y1 = maxY + R_NODE + LABEL_GAP + LABEL_H + 8

  // ── arrows ────────────────────────────────────────────────────────────────
  const edges = links.map((l) => {
    const a = nodes[l.s]
    const b = nodes[l.t]
    if (!a || !b) return null
    const dx = b.x - a.x
    const dy = b.y - a.y
    const forward = dx > 1
    let c1x; let c1y; let c2x; let c2y
    if (forward) {
      const k = Math.max(26, Math.min(dx * 0.5, 150))
      c1x = a.x + k; c1y = a.y
      c2x = b.x - k; c2y = b.y
    } else {
      // A back edge has to be visibly a back edge: bow it clear of the rank.
      const bow = 46 + Math.min(120, Math.abs(dy) * 0.25)
      const side = dy >= 0 ? 1 : -1
      c1x = a.x + 70; c1y = a.y + side * bow
      c2x = b.x - 70; c2y = b.y + side * bow
    }
    return { s: l.s, t: l.t, w: l.w, kind: l.kind, bidi: !!l.bidi, back: !forward, ax: a.x, ay: a.y, bx: b.x, by: b.y, c1x, c1y, c2x, c2y }
  }).filter(Boolean)

  return {
    nodes, edges, x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0),
    ranks: ranks.length, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    R: R_NODE, labelGap: LABEL_GAP, labelPx: LABEL_PX,
  }
}

/** Point on a cubic at t, and the tangent there — for placing an arrowhead. */
export function cubicAt(e, t) {
  const mt = 1 - t
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
  const x = a * e.ax + b * e.c1x + c * e.c2x + d * e.bx
  const y = a * e.ay + b * e.c1y + c * e.c2y + d * e.by
  const ta = 3 * mt * mt, tb = 6 * mt * t, tc = 3 * t * t
  const dx = ta * (e.c1x - e.ax) + tb * (e.c2x - e.c1x) + tc * (e.bx - e.c2x)
  const dy = ta * (e.c1y - e.ay) + tb * (e.c2y - e.c1y) + tc * (e.by - e.c2y)
  return [x, y, dx, dy]
}
