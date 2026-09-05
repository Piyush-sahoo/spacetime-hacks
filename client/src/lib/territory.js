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
 * Extensions the MODULE does not strip when it builds a qual (`SOURCE_EXTS` in
 * `module/src/index.ts`). A path it does not compile keeps its extension inside
 * the dotted qual, so `client/src/index.css` arrives as `client.src.index.css`
 * and a naive split would invent a directory called `client/src/index`.
 *
 * READ ONLY FOR NEW LAND. Survey files are still parsed exactly the way they
 * were, because reading one differently would move a block, and no block that
 * is already on the map is allowed to move.
 */
const EXT_TAIL = new Set([
  'md', 'markdown', 'rst', 'txt', 'css', 'scss', 'sass', 'less',
  'json', 'yaml', 'yml', 'toml', 'lock', 'html', 'htm', 'svg', 'csv',
  'vue', 'svelte', 'astro', 'sh', 'bash',
])

const tailExt = (p) => (p.length > 1 && EXT_TAIL.has(String(p[p.length - 1]).toLowerCase()) ? 1 : 0)

/** `client.src.index.css` -> `client/src` · `README.md` -> `/` */
export function landDir(mod) {
  const p = String(mod || '').split('.')
  const cut = p.length - 1 - tailExt(p)
  return cut <= 0 ? '/' : p.slice(0, cut).join('/')
}

/** `client.src.index.css` -> `index.css` */
export function landLabel(mod) {
  const p = String(mod || '').split('.')
  return p.slice(p.length - 1 - tailExt(p)).join('.')
}

/** `client.src.index.css` -> `client/src/index.css` */
export function landPath(mod) {
  const p = String(mod || '').split('.')
  return tailExt(p) ? `${p.slice(0, -1).join('/')}.${p[p.length - 1]}` : p.join('/')
}

/**
 * nodes -> { files, districts, byNode }
 *   files[i]  = { mod, path, label, district, ids, count, symbols, pick }
 *   byNode    = Map(nodeIdString -> file index)
 *   `pick` is the node id a click sends to `request_exploration`: the lowest id
 *   in the file, so every tab naming the same region names the same row.
 *
 * `count` is the number of GRAPH NODES in the file and stays that, because it
 * is the denominator every coverage fraction on screen divides by, and the
 * number the districts are packed and ordered on.
 *
 * `symbols` is what `enrich_repo` actually measured inside the file, and it is
 * `null` for a file nothing has enriched. It is a SEPARATE field for exactly
 * that reason: block height reads it, and nothing else does, so a file getting
 * taller can never move a footprint or re-scale a coverage bar.
 */
/**
 * Nodes minted by `report_touch` for a path the survey does not hold: a file
 * that did not exist when the map was indexed.
 *
 * They ARE part of the territory now — they were filtered out here, which meant
 * `byNode` had no cell for them and the blue state had nothing to stand on. A
 * file is admitted with a `newLand` flag and `iso.js` drops it into a cell its
 * district reserved in advance, so admitting one cannot move a single block
 * that is already on screen.
 */
export const NEW_LAND_KIND = 'NewLand'

/**
 * @param nodes      every `node` row, survey and new land alike
 * @param meta       `file_meta` by node id — what enrich_repo measured
 * @param landPaths  `new_land` node id -> the REAL repo-relative path. The
 *                   dotted qual has already thrown the extension away for
 *                   anything the module compiles, and `.jsx` is not recoverable
 *                   from `client.src.components.RightPanel`. Optional: the
 *                   table is only subscribed when the deployed module has it.
 */
export function buildTerritory(nodes, meta, landPaths) {
  const files = new Map()
  for (const n of nodes) {
    const isLand = n.kind === NEW_LAND_KIND
    const mod = moduleOf(n.qual)
    let f = files.get(mod)
    if (!f) {
      f = { mod, path: prettyPath(mod), label: labelOf(mod), district: districtOf(mod), dir: null, ids: [], count: 0, surveyed: 0, symbols: null, loc: 0, summary: '', role: '', importance: 0, pick: null, tests: 0, newLand: false, landPath: '' }
      files.set(mod, f)
    }
    f.ids.push(n.id)
    f.count += 1
    if (isLand) {
      if (!f.landPath && landPaths) f.landPath = String(landPaths.get(String(n.id)) || '')
    } else f.surveyed += 1
    if (n.kind === 'Test') f.tests += 1
  }

  const list = [...files.values()]
  const byNode = new Map()
  list.forEach((f, i) => {
    f.ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    f.pick = f.ids[0]
    for (const id of f.ids) byNode.set(String(id), i)
    // NEW GROUND is a file with no SURVEY node behind it at all. A file that has
    // one is ordinary territory however many parcels were later minted next to
    // it, so the test is `surveyed === 0` rather than "any NewLand node".
    if (f.surveyed > 0) return
    f.newLand = true
    if (f.landPath) {
      f.path = f.landPath
      const s = f.landPath.lastIndexOf('/')
      f.dir = s === -1 ? '/' : f.landPath.slice(0, s)
      f.label = s === -1 ? f.landPath : f.landPath.slice(s + 1)
    } else {
      f.path = landPath(f.mod)
      f.dir = landDir(f.mod)
      f.label = landLabel(f.mod)
    }
    f.district = f.dir === '/' ? '/' : f.dir.split('/').slice(0, 2).join('/')
  })

  // What `enrich_repo` read out of the file itself. Absent until somebody
  // deepens the map, and absent is `null` rather than 0 — a file nobody has
  // opened is UNKNOWN, and it stands at its node count, not on the floor.
  if (meta && meta.size > 0) {
    for (const f of list) {
      let sym = 0
      let loc = 0
      let have = false
      for (const id of f.ids) {
        const m = meta.get(String(id))
        if (!m) continue
        have = true
        sym += Number(m.symbols || 0)
        loc += Number(m.loc || 0)
        if (!f.summary && m.summary) {
          f.summary = m.summary
          f.role = m.role || ''
          f.importance = Number(m.importance || 0)
        }
      }
      if (have) { f.symbols = sym; f.loc = loc }
    }
  }

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
