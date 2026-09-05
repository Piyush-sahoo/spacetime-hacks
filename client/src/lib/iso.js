/**
 * THE PLATE — a repo drawn as an isometric city.
 *
 * system-atlas hand-authors every `gx, gy`. We cannot: the map is generated
 * from whatever repo someone indexed thirty seconds ago. So the placement is a
 * PURE, DETERMINISTIC FUNCTION of the file list:
 *
 *   1. files are grouped by their directory                    -> districts
 *   2. districts are packed onto the iso grid, largest first,
 *      spiralling out from the origin                          -> a city
 *   3. files sit on a local sub-grid inside their district,
 *      sorted by name                                          -> streets
 *
 * Two invariants hold this together and neither is negotiable:
 *
 *   · NOTHING IN HERE READS COVERAGE. Not once. The ground is cut from the
 *     graph alone, so an agent exploring can only ever change COLOUR — the map
 *     never moves under the audience mid-demo. `Atlas.jsx` asserts this by
 *     measuring a block's screen position across a coverage change (0.000000px).
 *   · The file list is re-sorted here rather than trusted. `buildTerritory`
 *     yields files in subscription-arrival order, which differs per tab; every
 *     tab must cut the same city, so ordering is imposed, not inherited.
 */

/** 2:1 dimetric. `z` is pixels subtracted from screen y — height, not depth. */
export const TW = 72
export const TH = 36
export const P = (gx, gy, z = 0) => [(gx - gy) * TW / 2, (gx + gy) * TH / 2 - z]
export const pts = (a) => a.map((p) => p.join(',')).join(' ')

/** Footprint side, and the pitch it is placed on (one unit of street). */
const BW = 2
const CELL = 3
/** Gap between district plates. */
const GAP = 2

/**
 * Above this many files the city is drawn one block PER DIRECTORY instead of
 * one per file. django/django is 2,974 files in 695 directories: as blocks
 * that is ~30k SVG nodes and a hairball, as districts it is a skyline you can
 * read and click into. The left index is the way down either way.
 */
export const FILE_CAP = 420

// ── roles ───────────────────────────────────────────────────────────────────
// The reference's own block primitives, chosen by what a directory IS.
const RE_TEST = /(^|\/)(tests?|spec|specs|__tests__|testing|e2e)(\/|$)/i
const RE_DATA = /(^|\/)(data|config|conf|configs|settings|migrations|fixtures|schema|schemas|db|sql|json|yaml|locale|locales|assets|static|module_bindings|bindings|vendor)(\/|$)/i
const RE_UI = /(^|\/)(ui|client|components?|web|views?|templates?|pages|screens|frontend|widgets|admin|app|styles)(\/|$)/i

export function kindOfDir(dir) {
  const d = String(dir || '')
  if (RE_TEST.test(d)) return 'cards'
  if (RE_DATA.test(d)) return 'store'
  if (RE_UI.test(d)) return 'screen'
  return 'box'
}

/** `client/src/lib/room` -> `client/src/lib`; a bare name -> `/` (repo root). */
export function dirOf(mod) {
  const p = String(mod || '').split('.')
  if (p.length <= 1) return '/'
  return p.slice(0, -1).join('/')
}

/** A, B, … Z, AA, AB, … — the letter key the left index and the top chip share. */
export function codeAt(i) {
  let n = i, s = ''
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}

/** Symbol count -> how tall the block stands. Log, or one file owns the sky. */
const heightOf = (count) => 16 + Math.min(66, Math.round(Math.log2(1 + Math.max(1, count)) * 13))

/**
 * What a block is a block OF.
 *
 * `symbols` is what `enrich_repo` counted inside the file; it is null until
 * somebody deepens the map, and then it is the node count — which is a real
 * per-function count on a seeded graph, and 1 on an indexed one, which is
 * precisely why every block on an indexed repo used to stand the same height.
 *
 * Height is the ONLY thing that reads it. Districts are packed on how many
 * FILES they hold and ordered alphabetically, both untouched by this, so a
 * file getting taller cannot move a single footprint.
 */
const sizeOf = (f) => Number(f.symbols ?? f.count ?? 0)

/**
 * Pack rectangles around the origin, biggest first, by growing a bounding box
 * outward one side at a time: right column, bottom row, left column, top row,
 * repeat. Deterministic, O(n), and it puts the repo's centre of mass in the
 * middle of the plate where the eye lands.
 */
function spiralPack(rects) {
  if (!rects.length) return
  const first = rects[0]
  first.gx = 0
  first.gy = 0
  const bb = { x0: 0, y0: 0, x1: first.w, y1: first.h }
  let side = 0        // 0 right · 1 bottom · 2 left · 3 top
  let cur = 0         // cursor along the current side
  let onSide = 0      // how many landed on this side since the last rotation
  let ext = 0         // the far edge reached on this side

  for (let i = 1; i < rects.length; i += 1) {
    const r = rects[i]
    for (let guard = 0; guard < 9; guard += 1) {
      if (side === 0) {
        const x = bb.x1 + GAP
        const y = onSide ? cur : bb.y0
        if (!onSide || y + r.h <= bb.y1) {
          r.gx = x; r.gy = y; cur = y + r.h + GAP
          ext = Math.max(ext, x + r.w); onSide += 1; break
        }
      } else if (side === 1) {
        const y = bb.y1 + GAP
        const x = (onSide ? cur : bb.x1) - r.w
        if (!onSide || x >= bb.x0) {
          r.gx = x; r.gy = y; cur = x - GAP
          ext = Math.max(ext, y + r.h); onSide += 1; break
        }
      } else if (side === 2) {
        const x = bb.x0 - GAP - r.w
        const y = (onSide ? cur : bb.y1) - r.h
        if (!onSide || y >= bb.y0) {
          r.gx = x; r.gy = y; cur = y - GAP
          ext = onSide ? Math.min(ext, x) : x; onSide += 1; break
        }
      } else {
        const y = bb.y0 - GAP - r.h
        const x = onSide ? cur : bb.x0
        if (!onSide || x + r.w <= bb.x1) {
          r.gx = x; r.gy = y; cur = x + r.w + GAP
          ext = onSide ? Math.min(ext, y) : y; onSide += 1; break
        }
      }
      // Side is full. Commit how far it reached, turn the corner.
      if (onSide) {
        if (side === 0) bb.x1 = ext
        else if (side === 1) bb.y1 = ext
        else if (side === 2) bb.x0 = ext
        else bb.y0 = ext
      }
      side = (side + 1) % 4
      onSide = 0
      ext = 0
    }
  }
}

/**
 * @param files territory.files — [{ mod, path, label, count, tests, pick, ids }]
 * @returns the whole city, cut once, memoised by the caller on `node`.
 */
export function buildAtlas(files) {
  const list = files || []

  // Impose an order. Never inherit one.
  const order = list.map((f, i) => i).sort((a, b) => {
    const A = String(list[a].mod), B = String(list[b].mod)
    return A < B ? -1 : A > B ? 1 : a - b
  })

  // ── districts ──────────────────────────────────────────────────────────
  const dm = new Map()
  for (const fi of order) {
    const dir = dirOf(list[fi].mod)
    let d = dm.get(dir)
    if (!d) { d = { name: dir, files: [], count: 0, symbols: 0 }; dm.set(dir, d) }
    d.files.push(fi)
    d.count += 1
    d.symbols += sizeOf(list[fi])
  }
  const districts = [...dm.values()].sort(
    (a, b) => (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )

  districts.forEach((d, i) => {
    d.code = codeAt(i)
    d.kind = kindOfDir(d.name)
    d.cols = Math.max(1, Math.ceil(Math.sqrt(d.count)))
    d.rows = Math.ceil(d.count / d.cols)
    d.w = d.cols * CELL + 1
    d.h = d.rows * CELL + 1
    // Files inside a district read alphabetically, so the streets are an index.
    d.files.sort((a, b) => {
      const A = String(list[a].mod), B = String(list[b].mod)
      return A < B ? -1 : A > B ? 1 : 0
    })
  })

  spiralPack(districts)

  // ── one block per file ─────────────────────────────────────────────────
  const blocks = []
  const byFile = new Map()
  for (const d of districts) {
    d.files.forEach((fi, i) => {
      const f = list[fi]
      const col = i % d.cols
      const row = Math.floor(i / d.cols)
      const b = {
        id: `f${fi}`,
        fi,
        district: d.name,
        code: d.code,
        gx: d.gx + 1 + col * CELL,
        gy: d.gy + 1 + row * CELL,
        w: BW,
        d: BW,
        h: heightOf(sizeOf(f)),
        kind: kindOfDir(d.name),
        name: f.label || f.mod,
        short: shortLabel(f.label || f.mod),
        path: f.path,
        mod: f.mod,
        // The tooltip says "N symbols", so it has to BE the symbol count once
        // one is known. Coverage fractions read territory's `f.count`, which
        // is still the node count, so nothing that divides is touched.
        count: sizeOf(f),
        nodes: Number(f.count || 0),
        loc: Number(f.loc || 0),
        summary: f.summary || '',
        role: f.role || '',
      }
      byFile.set(fi, blocks.length)
      blocks.push(b)
    })
  }

  // ── one block per district, standing where that district stands ────────
  // Same coordinates, coarser grain: zooming out is a level of detail, never
  // a different map, so drilling in never teleports anything.
  const dblocks = districts.map((d, di) => {
    const w = Math.min(6, Math.max(2, d.w - 2))
    const h = Math.min(6, Math.max(2, d.h - 2))
    return {
      id: `d${di}`,
      di,
      district: d.name,
      code: d.code,
      gx: d.gx + Math.round((d.w - w) / 2),
      gy: d.gy + Math.round((d.h - h) / 2),
      w,
      d: h,
      h: 18 + Math.min(78, Math.round(Math.log2(1 + d.symbols) * 15)),
      kind: d.kind,
      name: d.name,
      short: shortLabel(d.name.split('/').pop() || d.name),
      path: d.name,
      count: d.count,
    }
  })

  return {
    files: list,
    order,
    districts,
    blocks,
    dblocks,
    byFile,
    byDistrict: new Map(districts.map((d, i) => [d.name, i])),
    full: blocks.length <= FILE_CAP,
  }
}

/** The reference caps its name tags at 14 characters; so does this. */
export function shortLabel(s) {
  const t = String(s || '').replace(/\.(py|js|jsx|ts|tsx|rs|cs|go|java|rb|md|json|toml|yaml|yml)$/i, '')
  return t.length > 14 ? `${t.slice(0, 13)}…` : t
}

/** Footprint centre, in grid units — where routes start and end. */
export const centreOf = (b) => [b.gx + b.w / 2, b.gy + b.d / 2]

/**
 * One hop, as the reference draws it: a ground-plane polyline with exactly one
 * right-angle bend. `'xy'` turns at [bx, ay]; `'yx'` turns at [ax, by]. A hop
 * that retraces one already drawn takes the other bend, so the outbound and
 * the return are two visible lines instead of one.
 */
export function hopPath(a, b, bend) {
  const [ax, ay] = centreOf(a)
  const [bx, by] = centreOf(b)
  const mid = bend === 'xy' ? [bx, ay] : [ax, by]
  const grid = [[ax, ay], mid, [bx, by]].filter(
    (p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]
  )
  const scr = grid.map((p) => P(p[0], p[1], 0))
  const seg = []
  let len = 0
  for (let i = 1; i < scr.length; i += 1) {
    const l = Math.hypot(scr[i][0] - scr[i - 1][0], scr[i][1] - scr[i - 1][1])
    seg.push(l)
    len += l
  }
  return { grid, scr, seg, len }
}

/** Arc-length parameterised point along a hop — what the packet rides. */
export function pointAt(path, t) {
  let dd = t * path.len
  for (let i = 0; i < path.seg.length; i += 1) {
    if (dd <= path.seg[i] || i === path.seg.length - 1) {
      const u = path.seg[i] ? Math.min(1, dd / path.seg[i]) : 1
      const a = path.scr[i], b = path.scr[i + 1]
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
    }
    dd -= path.seg[i]
  }
  return path.scr[0]
}

/** Screen-space bounds of a set of blocks, tops and footprints included. */
export function boundsOf(blocks) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
  for (const n of blocks) {
    const ps = [
      P(n.gx, n.gy, n.h), P(n.gx + n.w, n.gy, n.h),
      P(n.gx + n.w, n.gy + n.d, -26), P(n.gx, n.gy + n.d, 0), P(n.gx, n.gy, 0),
    ]
    for (const p of ps) {
      if (p[0] < x0) x0 = p[0]
      if (p[1] < y0) y0 = p[1]
      if (p[0] > x1) x1 = p[0]
      if (p[1] > y1) y1 = p[1]
    }
  }
  if (x0 > x1) return { x0: 0, y0: 0, x1: 1, y1: 1 }
  return { x0, y0, x1, y1 }
}

/** The grid lines under everything, sized to what is actually on the plate. */
export function gridRange(blocks) {
  let a = 1e9, b = -1e9
  for (const n of blocks) {
    a = Math.min(a, n.gx, n.gy)
    b = Math.max(b, n.gx + n.w, n.gy + n.d)
  }
  if (a > b) return [-4, 26]
  return [Math.floor(a) - 3, Math.ceil(b) + 3]
}
