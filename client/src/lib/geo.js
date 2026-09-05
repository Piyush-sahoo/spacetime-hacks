/**
 * THE SURVEY.
 *
 * The map is drawn from two facts that are already in the data and disagree
 * with each other, which is the whole point of the product:
 *
 *   THE TREE   — `node.qual` carries a dotted module path before `::`.
 *                `django` -> `django.db` -> `django.db.models` -> a file -> its
 *                symbols. That is a real hierarchy and it is drawn as one: a
 *                radial tidy tree, root at the centre, districts fanning out
 *                into angular sectors, files on the outer ring, symbols as the
 *                fine hairs past them.
 *
 *   THE ROOTS  — `edge` rows connect symbols that sit in completely different
 *                branches of that tree. They do not respect the folders. Each
 *                call edge is drawn as a filament routed along the hierarchy
 *                (Holten's hierarchical edge bundling) and then STRAIGHTENED
 *                back toward the chord, so shared corridors braid together but
 *                the crossing is still plainly visible.
 *
 * Everything here is a pure function of `node` + `edge`. Names, not arrival
 * order, decide every angle — two tabs that received their rows in a different
 * order still compute a byte-identical map. Coverage never enters this file:
 * it can only ever change COLOUR. The ground does not move.
 */

const TAU = Math.PI * 2

// ── deterministic hash, for jitter that is the same in every tab ───────────
function hash01(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 8) / 16777216
}

// Angular breathing room between siblings, measured in leaf-slots. Districts
// get a real gutter so the sectors read as separate territories; twigs get
// almost none so a big file stays visibly big.
function gapAt(depth) {
  if (depth <= 1) return 11
  if (depth === 2) return 1.3
  if (depth === 3) return 0.55
  return 0.3
}

/**
 * @param territory  from buildTerritory(): { files, byNode, ... }
 * @param edges      raw edge rows [{ src, dst }]
 */
export function buildGeography(territory, edges) {
  const files = territory.files
  const nFiles = files.length
  if (!nFiles) return null

  const totalSymbols = files.reduce((a, f) => a + f.ids.length, 0)

  // World size scales with the graph so arc-length per symbol stays constant:
  // repo 1 and repo 2 are the same map at different sizes, not the same
  // rectangle at different densities.
  const RMAX = Math.max(1500, 2.05 * totalSymbols)
  const RFILE = RMAX * 0.855
  const R0 = RMAX * 0.085

  // ── trie over the dotted module paths ───────────────────────────────────
  const T = []
  const mk = (name, full, depth, parent) => {
    const i = T.length
    T.push({
      i, name, full, depth, parent,
      kids: [], fi: -1, deep: depth,
      slot0: 0, slot1: 0, symSlot0: 0, symSlot1: 0,
      ang: 0, a0: 0, a1: 0, r: 0, x: 0, y: 0, leaves: 0,
    })
    return i
  }
  const ROOT = mk('', '', 0, -1)
  const byFull = new Map([['', ROOT]])

  for (let fi = 0; fi < nFiles; fi += 1) {
    const parts = String(files[fi].mod).split('.')
    let cur = ROOT
    let full = ''
    for (let d = 0; d < parts.length; d += 1) {
      full = d === 0 ? parts[0] : `${full}.${parts[d]}`
      let nx = byFull.get(full)
      if (nx === undefined) {
        nx = mk(parts[d], full, d + 1, cur)
        byFull.set(full, nx)
        T[cur].kids.push(nx)
      }
      cur = nx
    }
    T[cur].fi = fi
  }

  // Sorting by NAME is what makes this reproducible across tabs.
  for (const n of T) n.kids.sort((a, b) => (T[a].name < T[b].name ? -1 : T[a].name > T[b].name ? 1 : 0))

  // ── angular slots, one per symbol, allotted by a depth-first walk ───────
  const leafFile = new Int32Array(totalSymbols)
  const leafNode = new Array(totalSymbols)
  const leafSlot = new Float64Array(totalSymbols)
  let nLeaf = 0
  let cursor = 0

  const assign = (ni) => {
    const n = T[ni]
    n.slot0 = cursor
    if (n.fi >= 0) {
      const ids = files[n.fi].ids
      n.symSlot0 = cursor
      files[n.fi].leaf0 = nLeaf
      for (let k = 0; k < ids.length; k += 1) {
        leafFile[nLeaf] = n.fi
        leafNode[nLeaf] = ids[k]
        leafSlot[nLeaf] = cursor
        cursor += 1
        nLeaf += 1
      }
      files[n.fi].leaf1 = nLeaf
      n.symSlot1 = cursor
      if (n.kids.length) cursor += gapAt(n.depth + 1)
    }
    for (let k = 0; k < n.kids.length; k += 1) {
      if (k > 0 || n.fi >= 0) cursor += gapAt(T[n.kids[k]].depth)
      assign(n.kids[k])
    }
    n.slot1 = cursor
    n.leaves = 0
  }
  assign(ROOT)

  const totalSlots = Math.max(1, cursor)
  const D = TAU / totalSlots
  // Start the survey at due north and run clockwise, like a compass rose.
  const ROT = -Math.PI / 2

  // ── depth of the deepest file under each node, bottom-up ────────────────
  const order = []
  const stack = [ROOT]
  while (stack.length) {
    const ni = stack.pop()
    order.push(ni)
    for (const k of T[ni].kids) stack.push(k)
  }
  for (let z = order.length - 1; z >= 0; z -= 1) {
    const n = T[order[z]]
    let deep = n.fi >= 0 ? n.depth : 0
    let lv = n.fi >= 0 ? files[n.fi].ids.length : 0
    for (const k of n.kids) {
      if (T[k].deep > deep) deep = T[k].deep
      lv += T[k].leaves
    }
    n.deep = Math.max(deep, n.depth)
    n.leaves = lv
  }

  // ── polar positions ─────────────────────────────────────────────────────
  for (const n of T) {
    n.a0 = n.slot0 * D + ROT
    n.a1 = n.slot1 * D + ROT
    n.ang = (n.a0 + n.a1) / 2
    // A node sits at the fraction of the way from the taproot to the ring that
    // its own depth represents along its deepest branch. Files land on the
    // ring; everything above them tidies inward.
    n.r = n.depth === 0 ? 0 : R0 + (RFILE - R0) * Math.pow(n.depth / Math.max(1, n.deep), 0.92)
    n.x = Math.cos(n.ang) * n.r
    n.y = Math.sin(n.ang) * n.r
  }

  // File anchors (label + hit target live here).
  for (let fi = 0; fi < nFiles; fi += 1) {
    const f = files[fi]
    const n = T[byFull.get(f.mod)]
    f.gx = n.x; f.gy = n.y; f.gang = n.ang; f.gr = n.r
    f.ga0 = (n.symSlot0 || n.slot0) * D + ROT
    f.ga1 = (n.symSlot1 || n.slot1) * D + ROT
    f.tnode = n.i
  }

  // Symbol positions on the outer ring, jittered deterministically so the
  // coastline reads as surveyed ground and not as a machined circle.
  const lx = new Float32Array(nLeaf)
  const ly = new Float32Array(nLeaf)
  const lr = new Float32Array(nLeaf)
  const la = new Float32Array(nLeaf)
  const leafIndexById = new Map()
  for (let i = 0; i < nLeaf; i += 1) {
    const ang = (leafSlot[i] + 0.5) * D + ROT
    const h = hash01(String(leafNode[i]))
    const r = RMAX * (0.975 + 0.045 * h)
    la[i] = ang; lr[i] = r
    lx[i] = Math.cos(ang) * r
    ly[i] = Math.sin(ang) * r
    leafIndexById.set(String(leafNode[i]), i)
  }

  // ── the branch skeleton, one Path2D-able polyline per tree edge ─────────
  // Interpolating in POLAR space bows each branch along its own arc, which is
  // what makes the skeleton read as a growing thing rather than a star chart.
  const skeleton = []            // per depth: array of flat point runs
  const maxDepth = T.reduce((m, n) => Math.max(m, n.depth), 0)
  for (let d = 0; d <= maxDepth + 1; d += 1) skeleton.push([])
  const BSEG = 9
  for (const n of T) {
    if (n.parent < 0) continue
    const p = T[n.parent]
    const run = new Float32Array((BSEG + 1) * 2)
    let da = n.ang - p.ang
    while (da > Math.PI) da -= TAU
    while (da < -Math.PI) da += TAU
    for (let s = 0; s <= BSEG; s += 1) {
      const t = s / BSEG
      // ease the sweep so the turn happens near the parent, like a real fork
      const ta = t * t * (3 - 2 * t)
      const a = p.ang + da * ta
      const r = p.r + (n.r - p.r) * t
      run[s * 2] = Math.cos(a) * r
      run[s * 2 + 1] = Math.sin(a) * r
    }
    skeleton[n.depth].push(run)
  }

  // Hairs: file anchor -> each of its symbols. Kept apart from the skeleton so
  // the level-of-detail can drop them wholesale when zoomed out.
  const hairs = new Float32Array(nLeaf * 4)
  for (let i = 0; i < nLeaf; i += 1) {
    const f = files[leafFile[i]]
    hairs[i * 4] = f.gx; hairs[i * 4 + 1] = f.gy
    hairs[i * 4 + 2] = lx[i]; hairs[i * 4 + 3] = ly[i]
  }

  // ── the root system: bundled call filaments ─────────────────────────────
  const SAMPLES = nLeaf > 6000 ? 13 : 19
  const BETA = 0.78 // 1 = hug the hierarchy, 0 = a straight chord

  const anc = (ni) => {
    const out = []
    let c = ni
    while (c >= 0) { out.push(c); c = T[c].parent }
    return out
  }
  const ancCache = new Map()
  const ancOf = (ni) => {
    let a = ancCache.get(ni)
    if (!a) { a = anc(ni); ancCache.set(ni, a) }
    return a
  }

  const fPts = []
  const fSrc = []
  const fDst = []
  const fSrcFile = []
  const fDstFile = []
  const cx = new Float64Array(24)
  const cy = new Float64Array(24)
  const qx = new Float64Array(32)
  const qy = new Float64Array(32)

  const seen = new Set()
  for (const e of edges) {
    const su = leafIndexById.get(String(e.src))
    const sv = leafIndexById.get(String(e.dst))
    if (su === undefined || sv === undefined) continue
    if (leafFile[su] === leafFile[sv]) continue // a call inside one file is not a road
    const kk = su < sv ? `${su}:${sv}` : `${sv}:${su}`
    if (seen.has(kk)) continue
    seen.add(kk)

    const au = ancOf(files[leafFile[su]].tnode)
    const av = ancOf(files[leafFile[sv]].tnode)
    // ancestors run leaf -> root on both sides; the LCA is the first shared one
    let iu = au.length - 1
    let iv = av.length - 1
    while (iu >= 0 && iv >= 0 && au[iu] === av[iv]) { iu -= 1; iv -= 1 }
    const lca = au[iu + 1]

    let n = 0
    cx[n] = lx[su]; cy[n] = ly[su]; n += 1
    for (let k = 0; k <= iu; k += 1) { cx[n] = T[au[k]].x; cy[n] = T[au[k]].y; n += 1 }

    // The LCA is the corridor this call has to travel through. Textbook
    // bundling puts the control point exactly on it — but the root of a repo
    // with two top-level packages (`django`, `tests`) is ONE point at the
    // origin, so every crossing filament would funnel through it and the map
    // becomes a single knot. Dive under the centre on each filament's OWN
    // bearing instead: the crossings braid into a rosette, which is both
    // readable and what a root cross-section actually looks like.
    if (T[lca].depth === 0) {
      let d = la[sv] - la[su]
      while (d > Math.PI) d -= TAU
      while (d < -Math.PI) d += TAU
      const mid = la[su] + d / 2
      // A wider crossing dives deeper, so long-haul roots run under the middle
      // and short ones skim it. That reads as depth.
      const rr = R0 * (0.30 + 0.52 * (1 - Math.abs(d) / Math.PI))
      cx[n] = Math.cos(mid) * rr; cy[n] = Math.sin(mid) * rr; n += 1
    } else {
      cx[n] = T[lca].x; cy[n] = T[lca].y; n += 1
    }

    for (let k = iv; k >= 0; k -= 1) { cx[n] = T[av[k]].x; cy[n] = T[av[k]].y; n += 1 }
    cx[n] = lx[sv]; cy[n] = ly[sv]; n += 1

    // Braid: nudge the interior control points off the corridor centreline by a
    // deterministic per-filament amount. Without this every call sharing a
    // corridor collapses onto one line and a hundred roots read as one; with
    // it a corridor has thickness and you can see it is a bundle.
    const jit = hash01(`${leafNode[su]}~${leafNode[sv]}`) * 2 - 1
    for (let k = 1; k < n - 1; k += 1) {
      const rr = Math.hypot(cx[k], cy[k])
      if (rr < 1e-6) continue
      const a = Math.atan2(cy[k], cx[k]) + jit * 0.030
      const s = rr * (1 + jit * 0.030)
      cx[k] = Math.cos(a) * s
      cy[k] = Math.sin(a) * s
    }

    // Holten straightening: pull the routed path back toward the chord.
    const x0 = cx[0], y0 = cy[0], x1 = cx[n - 1], y1 = cy[n - 1]
    for (let k = 0; k < n; k += 1) {
      const t = k / (n - 1)
      cx[k] = BETA * cx[k] + (1 - BETA) * (x0 + (x1 - x0) * t)
      cy[k] = BETA * cy[k] + (1 - BETA) * (y0 + (y1 - y0) * t)
    }

    // clamp the cubic B-spline to its endpoints by tripling them
    let m = 0
    qx[m] = cx[0]; qy[m] = cy[0]; m += 1
    qx[m] = cx[0]; qy[m] = cy[0]; m += 1
    for (let k = 0; k < n; k += 1) { qx[m] = cx[k]; qy[m] = cy[k]; m += 1 }
    qx[m] = cx[n - 1]; qy[m] = cy[n - 1]; m += 1
    qx[m] = cx[n - 1]; qy[m] = cy[n - 1]; m += 1

    const segs = m - 3
    const out = new Float32Array(SAMPLES * 2)
    for (let s = 0; s < SAMPLES; s += 1) {
      const u = (s / (SAMPLES - 1)) * segs
      let i = Math.floor(u)
      if (i > segs - 1) i = segs - 1
      const t = u - i
      const t2 = t * t, t3 = t2 * t
      const b0 = (1 - 3 * t + 3 * t2 - t3) / 6
      const b1 = (4 - 6 * t2 + 3 * t3) / 6
      const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6
      const b3 = t3 / 6
      out[s * 2] = b0 * qx[i] + b1 * qx[i + 1] + b2 * qx[i + 2] + b3 * qx[i + 3]
      out[s * 2 + 1] = b0 * qy[i] + b1 * qy[i + 1] + b2 * qy[i + 2] + b3 * qy[i + 3]
    }
    fPts.push(out)
    fSrc.push(su); fDst.push(sv)
    fSrcFile.push(leafFile[su]); fDstFile.push(leafFile[sv])
  }

  // Filaments sorted longest-first: when the level-of-detail has to cap how
  // many are drawn, the ones that cross the most territory survive, and those
  // are exactly the ones that make the point.
  const nFil = fPts.length
  const flen = new Float32Array(nFil)
  for (let i = 0; i < nFil; i += 1) {
    const p = fPts[i]
    const dx = p[p.length - 2] - p[0]
    const dy = p[p.length - 1] - p[1]
    flen[i] = Math.hypot(dx, dy)
  }
  const ordFil = Array.from({ length: nFil }, (_, i) => i).sort((a, b) => flen[b] - flen[a])

  // Which filaments touch a given file — used to ignite the roots a newly
  // explored region travelled along.
  const filByFile = new Map()
  const push = (fi, i) => { let a = filByFile.get(fi); if (!a) { a = []; filByFile.set(fi, a) } a.push(i) }
  for (let i = 0; i < nFil; i += 1) { push(fSrcFile[i], i); push(fDstFile[i], i) }

  // ── districts: the named territory you see before you zoom in ───────────
  // Depth 1 is the continent (django / tests), depth 2 the district. Both are
  // kept; the renderer labels whichever the current scale can carry.
  const districts = []
  for (const n of T) {
    if (n.depth < 1 || n.depth > 2) continue
    if (n.leaves < 1) continue
    districts.push({
      i: n.i, depth: n.depth, name: n.depth === 1 ? n.name : n.full.replace('.', '/'),
      full: n.full, a0: n.a0, a1: n.a1, ang: n.ang, r: n.r, x: n.x, y: n.y,
      leaves: n.leaves,
    })
  }
  districts.sort((a, b) => b.leaves - a.leaves)

  // Every symbol's district (depth-2 where one exists, else depth-1), so the
  // zoomed-out choropleth can be rolled up in one pass.
  const districtIndex = new Map()
  districts.forEach((d, k) => districtIndex.set(d.i, k))
  const leafDistrict = new Int32Array(nLeaf).fill(-1)
  for (let i = 0; i < nLeaf; i += 1) {
    let c = files[leafFile[i]].tnode
    let best = -1
    while (c >= 0) {
      const k = districtIndex.get(c)
      if (k !== undefined && (best === -1 || districts[k].depth === 2)) best = k
      c = T[c].parent
    }
    leafDistrict[i] = best
  }

  // ── spatial index over the symbols, for hit-testing under pan/zoom ──────
  const CELL = RMAX / 90
  const grid = new Map()
  const gkey = (gx, gy) => gx * 100003 + gy
  for (let i = 0; i < nLeaf; i += 1) {
    const gx = Math.floor(lx[i] / CELL)
    const gy = Math.floor(ly[i] / CELL)
    const k = gkey(gx, gy)
    let a = grid.get(k)
    if (!a) { a = []; grid.set(k, a) }
    a.push(i)
  }

  function pick(wx, wy, radius) {
    const rg = Math.max(1, Math.ceil(radius / CELL))
    const gx = Math.floor(wx / CELL)
    const gy = Math.floor(wy / CELL)
    let best = -1
    let bestD = radius * radius
    for (let a = -rg; a <= rg; a += 1) {
      for (let b = -rg; b <= rg; b += 1) {
        const arr = grid.get(gkey(gx + a, gy + b))
        if (!arr) continue
        for (const i of arr) {
          const dx = lx[i] - wx, dy = ly[i] - wy
          const d = dx * dx + dy * dy
          if (d < bestD) { bestD = d; best = i }
        }
      }
    }
    return best
  }

  return {
    RMAX, RFILE, R0, maxDepth, ROT, TAU,
    tree: T, root: ROOT,
    nLeaf, lx, ly, lr, la, leafFile, leafNode, leafDistrict, leafIndexById,
    files, nFiles,
    skeleton, hairs,
    filaments: { n: nFil, pts: fPts, src: fSrc, dst: fDst, srcFile: fSrcFile, dstFile: fDstFile, order: ordFil, byFile: filByFile, samples: SAMPLES },
    districts,
    pick,
  }
}
