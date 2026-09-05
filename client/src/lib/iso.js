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
 * RESERVED SLACK — why a file appearing does not move the map.
 *
 * A district used to be sized for exactly the files it held, so the first file
 * an agent created grew its grid, re-cut its plate, and shifted every district
 * the spiral packer had placed after it. The one thing the map may never do.
 *
 * So a district is sized for a third again as many files as the SURVEY put in
 * it, and new ground is dropped into the cells that reserve left empty. The
 * sizing reads `base` — the indexed file count, which cannot change while the
 * room is open — so the whole pack is invariant under anything an agent does.
 *
 * A district that outgrows its reserve is re-cut, and that is a real reflow.
 * It is rare (512 parcels is the module's fuse for a whole repo) and it is
 * REPORTED rather than hidden: `overflowed` and `window.__atlas.diag()`.
 */
const SLACK = 1.35

/** District names that outgrew their reserve on the last cut. Empty is normal. */
export const overflowed = []

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

/**
 * Directories whose contents nobody wrote and nobody reads.
 *
 * On the demo repo `client/src/module_bindings` is 31 of 70 files — the single
 * largest district, dead centre, drawn as a dense grid of identical squares. It
 * is machine-generated SDK glue. Giving it the most real estate on a map of a
 * codebase is a lie about where the codebase is, so it collapses to one block
 * that says how many it stands for, and expands on a click.
 */
const RE_GENERATED = /(^|\/)(module_bindings|bindings|generated|gen|dist|build|out|target|node_modules|vendor|__pycache__|\.next|coverage)(\/|$)/i

export function isGeneratedDir(dir) {
  return RE_GENERATED.test(String(dir || ''))
}

/** Under this, a generated district draws in full — collapsing 3 files hides nothing worth hiding. */
const COLLAPSE_MIN = 6

/**
 * Which directories fold themselves the first time a repo is drawn.
 *
 * Only generated ones, and only when there is enough of them to be in the way.
 * Everything else starts open and folds only if somebody asks, because a map
 * that hides things nobody asked it to hide is not a map of the repository.
 */
export function defaultCollapsed(files) {
  const n = new Map()
  for (const f of files || []) {
    const dir = f.district || dirOf(f.mod)
    n.set(dir, (n.get(dir) || 0) + 1)
  }
  const out = new Set()
  for (const [dir, count] of n) {
    if (isGeneratedDir(dir) && count >= COLLAPSE_MIN) out.add(dir)
  }
  return out
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
export function buildAtlas(files, opts) {
  const list = files || []
  // Names the caller wants drawn as ONE block. Generated directories start in
  // here (see `defaultCollapsed`), and the eye on any index row adds or removes
  // any other — one mechanism, so a hand-collapsed directory and a
  // collapsed-by-default one behave identically.
  const collapsed = (opts && opts.collapsed) || new Set()

  // Impose an order. Never inherit one.
  const order = list.map((f, i) => i).sort((a, b) => {
    const A = String(list[a].mod), B = String(list[b].mod)
    return A < B ? -1 : A > B ? 1 : a - b
  })

  // ── districts ──────────────────────────────────────────────────────────
  const dm = new Map()
  for (const fi of order) {
    const f = list[fi]
    // New land carries its own directory, worked out from the real path rather
    // than from a dotted qual that has already lost the extension.
    const dir = f.dir || dirOf(f.mod)
    let d = dm.get(dir)
    if (!d) { d = { name: dir, files: [], fresh: [], count: 0, base: 0, symbols: 0 }; dm.set(dir, d) }
    if (f.newLand) d.fresh.push(fi)
    else { d.files.push(fi); d.base += 1 }
    d.count += 1
    d.symbols += sizeOf(f)
  }
  // ORDERED ON THE SURVEY, NEVER ON THE TOTAL. `base` is what the index put in
  // this district and it does not move while the room is open, so a file
  // arriving cannot reshuffle the pack. `spiralPack` places rect `i` from rects
  // `0..i-1` alone, so a wholly new directory — `base === 0`, and therefore last
  // — is APPENDED and cannot disturb anything already placed either.
  const districts = [...dm.values()].sort(
    (a, b) => (b.base - a.base) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )

  const byMod = (a, b) => {
    const A = String(list[a].mod), B = String(list[b].mod)
    return A < B ? -1 : A > B ? 1 : 0
  }
  overflowed.length = 0
  districts.forEach((d, i) => {
    d.code = codeAt(i)
    d.kind = kindOfDir(d.name)
    // A collapsed district occupies one cell and draws one block. It is still a
    // district — it keeps its plate, its letter and its name — so the left index
    // and the map agree about what exists.
    d.collapsed = collapsed.has(d.name) && (d.base + d.fresh.length) > 1
    if (d.collapsed) {
      d.cols = 1; d.rows = 1; d.cap = 1
      d.w = CELL + 1; d.h = CELL + 1
      d.files.sort(byMod); d.fresh.sort(byMod)
      d.files = d.files.concat(d.fresh)
      return
    }
    const reserve = Math.max(1, Math.ceil(Math.max(1, d.base) * SLACK))
    let cols = Math.max(1, Math.ceil(Math.sqrt(reserve)))
    let rows = Math.ceil(reserve / cols)
    d.overflow = d.base + d.fresh.length > cols * rows
    if (d.overflow) {
      const want = d.base + d.fresh.length
      cols = Math.max(1, Math.ceil(Math.sqrt(want)))
      rows = Math.ceil(want / cols)
      overflowed.push(d.name)
    }
    d.cols = cols
    d.rows = rows
    d.cap = cols * rows
    d.w = d.cols * CELL + 1
    d.h = d.rows * CELL + 1
    // Files inside a district read alphabetically, so the streets are an index —
    // the SURVEY does, at least. New ground is APPENDED after it rather than
    // filed alphabetically into it, because an alphabetical insertion would
    // shift every block after it by one cell, which is the reflow this whole
    // arrangement exists to prevent. It reads as new ground anyway: it is blue,
    // haloed and dashed.
    d.files.sort(byMod)
    d.fresh.sort(byMod)
    d.files = d.files.concat(d.fresh)
  })

  if (overflowed.length && typeof console !== 'undefined' && console.warn) {
    console.warn(
      `[atlas] ${overflowed.length} district(s) outgrew their reserved slack and were re-cut, `
      + `so the plate reflowed: ${overflowed.slice(0, 6).join(', ')}`
      + `${overflowed.length > 6 ? ` +${overflowed.length - 6} more` : ''}`
    )
  }

  spiralPack(districts)

  // ── one block per file ─────────────────────────────────────────────────
  const blocks = []
  const byFile = new Map()
  for (const d of districts) {
    if (d.collapsed) {
      // One block standing for the whole district. `fi` is its first file so a
      // click still has something to select, and `covers` is every file in it,
      // so coverage can be rolled up rather than lost.
      const first = d.files[0]
      const b = {
        id: `d${d.code}`,
        fi: first,
        collapsed: true,
        covers: d.files.slice(),
        district: d.name,
        code: d.code,
        gx: d.gx + 1,
        gy: d.gy + 1,
        w: BW,
        d: BW,
        h: heightOf(Math.max(4, d.files.length)),
        kind: 'cards',
        name: d.name,
        short: `${d.files.length} generated`,
        path: d.name,
      }
      // byFile holds an INDEX into `blocks`, not the block — every consumer
      // does `blocks[byFile.get(fi)]`. Storing the object here made that
      // `blocks[{...}]`, so drilling into a collapsed district rendered a scene
      // of `undefined` and the plate went blank.
      const at = blocks.length
      blocks.push(b)
      for (const fi of d.files) byFile.set(fi, at)
      continue
    }
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
        // Ground that did not exist when the map was cut. The fill is already
        // blue (`coverage.isNew`); this is what lets the plate keep drawing it
        // as NEW rather than as something that was always there.
        newLand: !!f.newLand,
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
      newLand: d.base === 0,
    }
  })

  // How much of the plate the SURVEY accounts for. The camera fits on this and
  // not on `blocks.length`, so a file appearing cannot trigger a refit — a refit
  // is a camera move, and a camera move is every block on screen moving.
  let surveyBlocks = 0
  for (const b of blocks) if (!b.newLand) surveyBlocks += 1
  let surveyDistricts = 0
  for (const d of districts) if (d.base > 0) surveyDistricts += 1

  return {
    files: list,
    order,
    districts,
    blocks,
    dblocks,
    byFile,
    byDistrict: new Map(districts.map((d, i) => [d.name, i])),
    full: blocks.length <= FILE_CAP,
    surveyBlocks,
    surveyDistricts,
    fresh: blocks.length - surveyBlocks,
    overflowed: [...overflowed],
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
