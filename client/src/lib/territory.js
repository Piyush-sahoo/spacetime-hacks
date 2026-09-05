/**
 * The map itself.
 *
 * A repo is a territory. The atom of that territory is a FILE (the dotted
 * module path a node's `qual` carries before `::`), because a file is the unit
 * the agent actually touches — `report_touch` resolves one file path to every
 * node inside it. Files are grouped into DISTRICTS (package = first two path
 * segments) so the map has landmarks a human can navigate by, instead of 519
 * anonymous rectangles.
 *
 * Area is node count, so the map's shape is the repo's shape: the 225-symbol
 * admin_scripts test file is genuinely a tenth of the country. Coverage then
 * only has to change COLOUR — the geography stays put, so the eye tracks light
 * spreading across a fixed map rather than a layout reflowing under it.
 */

// Shipped quals are prefixed `data.repos.<repo>.` — that prefix is scaffolding
// from how the graphs were harvested, not part of the repo's own structure.
const SHIPPED_PREFIX = /^data\.repos\.[^.]+\./

export function moduleOf(qual) {
  const q = String(qual || '')
  const i = q.indexOf('::')
  const m = (i === -1 ? q : q.slice(0, i)).replace(SHIPPED_PREFIX, '')
  return m || 'unknown'
}

/** `django.core.management.base` → `django/core/management/base.py` */
export function prettyPath(mod) {
  return `${String(mod).split('.').join('/')}.py`
}

export function districtOf(mod) {
  const p = String(mod).split('.')
  if (p.length === 1) return p[0]
  return `${p[0]}/${p[1]}`
}

/**
 * nodes -> { files, districts, byNode }
 *   files[i]  = { mod, path, label, district, ids, count, pick }
 *   byNode    = Map(nodeIdString -> file index)
 *   `pick` is the node id a click sends to `request_exploration`: the lowest id
 *   in the file, so every tab naming the same region names the same row.
 */
export function buildTerritory(nodes) {
  const files = new Map()
  for (const n of nodes) {
    const mod = moduleOf(n.qual)
    let f = files.get(mod)
    if (!f) {
      f = { mod, path: prettyPath(mod), label: String(mod).split('.').pop(), district: districtOf(mod), ids: [], count: 0, pick: null, tests: 0 }
      files.set(mod, f)
    }
    f.ids.push(n.id)
    f.count += 1
    if (n.kind === 'Test') f.tests += 1
  }

  const list = [...files.values()]
  const byNode = new Map()
  list.forEach((f, i) => {
    f.ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    f.pick = f.ids[0]
    for (const id of f.ids) byNode.set(String(id), i)
  })

  const dm = new Map()
  list.forEach((f, i) => {
    let d = dm.get(f.district)
    if (!d) { d = { name: f.district, count: 0, files: [] }; dm.set(f.district, d) }
    d.count += f.count
    d.files.push(i)
  })
  const districts = [...dm.values()].sort((a, b) => b.count - a.count)
  for (const d of districts) d.files.sort((a, b) => list[b].count - list[a].count)

  return { files: list, districts, byNode, total: list.reduce((a, f) => a + f.count, 0) }
}

// ── squarified treemap ─────────────────────────────────────────────────────
// Bruls/Huizing/van Wijk. Rows are laid along the shorter side, which is what
// keeps cells close to square — a map of long thin slivers is unreadable at
// four metres, and four metres is the whole point.

const EPS = 1e-9

function worst(areas, rowArea, short) {
  let max = -Infinity, min = Infinity
  for (const a of areas) { if (a > max) max = a; if (a < min) min = a }
  if (min <= EPS) min = EPS
  const s2 = short * short
  const a2 = rowArea * rowArea
  return Math.max((s2 * max) / a2, a2 / (s2 * min))
}

/** items: [{ value, ...payload }] any order. rect: {x,y,w,h}. */
export function squarify(items, rect) {
  const out = []
  const src = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value)
  const total = src.reduce((a, b) => a + b.value, 0)
  let { x, y, w, h } = rect
  if (!src.length || total <= 0 || w <= 0 || h <= 0) return out

  const scale = (w * h) / total
  const areas = src.map((i) => i.value * scale)

  let i = 0
  while (i < src.length) {
    if (w <= EPS || h <= EPS) break
    const short = Math.min(w, h)
    let end = i + 1
    let rowArea = areas[i]
    let rowAreas = [areas[i]]
    while (end < src.length) {
      const nextAreas = rowAreas.concat(areas[end])
      const nextArea = rowArea + areas[end]
      if (worst(nextAreas, nextArea, short) <= worst(rowAreas, rowArea, short)) {
        rowAreas = nextAreas; rowArea = nextArea; end += 1
      } else break
    }

    const thick = rowArea / short
    let pos = 0
    for (let j = i; j < end; j += 1) {
      const len = areas[j] / thick
      if (w >= h) out.push({ ...src[j], x, y: y + pos, w: thick, h: len })
      else out.push({ ...src[j], x: x + pos, y, w: len, h: thick })
      pos += len
    }
    if (w >= h) { x += thick; w -= thick } else { y += thick; h -= thick }
    i = end
  }
  return out
}

/**
 * Two-level layout: districts over the whole canvas, files inside each.
 * Returns absolute pixel rects; the caller measured the container, so this is
 * recomputed on resize and the map is genuinely responsive rather than scaled.
 */
export function layoutTerritory(model, W, H) {
  if (!model || !model.districts.length || W <= 0 || H <= 0) return []
  const packed = squarify(model.districts.map((d) => ({ value: d.count, d })), { x: 0, y: 0, w: W, h: H })

  return packed.map((r) => {
    const pad = r.w > 26 && r.h > 26 ? 2 : 0.5
    const labelH = r.w > 78 && r.h > 34 ? 13 : 0
    const inner = {
      x: r.x + pad,
      y: r.y + pad + labelH,
      w: Math.max(0, r.w - pad * 2),
      h: Math.max(0, r.h - pad * 2 - labelH),
    }
    const cells = squarify(
      r.d.files.map((fi) => ({ value: model.files[fi].count, fi })),
      inner
    )
    return { name: r.d.name, count: r.d.count, x: r.x, y: r.y, w: r.w, h: r.h, labelH, cells }
  })
}
