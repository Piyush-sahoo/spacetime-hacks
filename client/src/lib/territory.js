/**
 * The territory: what the map is a map OF.
 *
 * A repo is a country. The atom of that country is a FILE — the dotted module
 * path a node's `qual` carries before `::` — because a file is the unit the
 * agent actually touches: `report_touch` resolves one file path to every node
 * inside it. Files roll up into DISTRICTS (the first two path segments) so the
 * map has landmarks a human can navigate by rather than 519 anonymous cells.
 *
 * This module knows nothing about geometry; geo.js turns it into a place.
 * Nothing here reads coverage, which is what guarantees coverage can only ever
 * change COLOUR — the ground never moves under the audience.
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

// Python packages are full of files whose basename says nothing — `tests`,
// `models`, `base`, `__init__`. A map labelled with forty identical `tests` is
// not labelled. Carry the parent segment for those so each name is a place.
const GENERIC = new Set([
  'tests', 'test', 'models', 'base', 'utils', 'views', 'forms', 'admin',
  'apps', 'urls', 'main', 'core', 'common', 'helpers', 'fields', 'widgets',
  '__init__', 'settings', 'conf', 'compat', 'const', 'constants', 'types',
])

export function labelOf(mod) {
  const p = String(mod).split('.')
  const last = p[p.length - 1]
  if (p.length > 1 && GENERIC.has(last)) return `${p[p.length - 2]}/${last}`
  return last
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
      f = { mod, path: prettyPath(mod), label: labelOf(mod), district: districtOf(mod), ids: [], count: 0, pick: null, tests: 0 }
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
