import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DbConnection } from '../module_bindings'
import { STDB_URI, STDB_MODULE } from '../lib/config'
import { buildTerritory } from '../lib/territory'
import { P, buildAtlas, boundsOf } from '../lib/iso'
import { stateColour } from '../lib/actors'
import { baseLink, isGithubSlug, millis } from '../lib/funnel'
import { HatchDefs, bodyOf } from './isoblocks.jsx'

/**
 * THE PREVIEWS — three real maps, drawn from the database.
 *
 * Not screenshots. Each plate below is the product's own renderer run over the
 * `node` rows of a repository that is on the map right now: the same
 * `buildTerritory` the room uses, the same `buildAtlas` packing, the same
 * blocks, and the same colours off the same `node_cov` tape. They cannot go
 * stale, because there is nothing to keep up to date — and every one of them is
 * a door into the room it is a picture of.
 *
 * TWO THINGS KEEP THIS OFF THE CRITICAL PATH.
 *
 *  1. NOTHING CONNECTS UNTIL THE SECTION IS NEARLY ON SCREEN. An
 *     `IntersectionObserver` with 300px of margin opens the socket; until then
 *     this component is three empty frames and costs nothing at all. The hero
 *     is above the fold and it does not wait behind a second subscription.
 *  2. A PREVIEW IS A SILHOUETTE. No tags, no chips, no hit surfaces, no route
 *     lines — and above 120 blocks it drops to one block per DIRECTORY, which
 *     is the level of detail the room itself uses on a large repo. A thumbnail
 *     of a city is a skyline.
 *
 * If the socket never opens, or a repository has no nodes yet, the frame says
 * so and the row underneath still carries the real counts. A preview that
 * cannot be drawn is never drawn as something else.
 */

/** The repositories worth showing first, if they are on the map. */
const WANTED = ['pallets/flask', 'honojs/hono', 'Piyush-sahoo/spacetime-hacks']
/** How many plates are drawn. Three is a range — tiny, small, and one of ours. */
const N = 3
/** Above this, a plate is drawn one block per directory rather than one per file. */
const DISTRICT_AT = 400
/** A repo has to be big enough to look like a city and small enough to be a thumbnail. */
const MIN_FILES = 20
const MAX_FILES = 700

/** How many repositories each `node_cov` row belongs to, counted once per feed. */
function covCounts(cov) {
  const out = new Map()
  for (const c of cov.values()) {
    const k = String(c.repoId ?? c.repo_id)
    out.set(k, (out.get(k) || 0) + 1)
  }
  return out
}

/**
 * WHICH REPOSITORIES GET DRAWN — one function, called in two places, because
 * the socket has to pick before it can ask for the nodes and the component has
 * to pick again to label them, and two copies of this rule would eventually
 * disagree about which plate is which.
 *
 * A PREVIEW NOBODY HAS WALKED IS NOT A PREVIEW. The frame exists to show the
 * thing the product does — blocks lighting as an agent reads them — so a
 * repository with no coverage at all draws as a field of empty boxes and says
 * the opposite. Explored repositories therefore come first, ahead of the wanted
 * list; an unexplored one is drawn only when there are not three explored ones
 * to draw, which is honest rather than empty.
 */
function choose(rows, counts) {
  const fits = rows.filter((r) => r.slug && r.n >= MIN_FILES && r.n <= MAX_FILES)
  const lit = (r) => (counts.get(r.id) || 0)
  const out = []
  const take = (r) => {
    if (r && out.length < N && !out.some((o) => o.id === r.id)) out.push(r)
  }
  for (const want of WANTED) {
    const hit = fits.find((r) => r.slug.toLowerCase() === want.toLowerCase())
    if (hit && lit(hit) > 0) take(hit)
  }
  const rest = [...fits].sort((a, b) => (
    ((lit(b) > 0) - (lit(a) > 0))
    || (isGithubSlug(b.slug) - isGithubSlug(a.slug))
    || (a.n - b.n)
  ))
  for (const r of rest) take(r)
  return out.slice(0, N)
}

/**
 * One socket, opened late, for the repositories being previewed.
 *
 * `repo` comes first because the slugs are known and the ids are not; the node
 * and coverage subscriptions are added once the ids arrive.
 */
function watchPreviews(onChange) {
  let conn = null
  let dead = false
  const repos = new Map()
  const nodes = new Map()
  const cov = new Map()
  let asked = false
  let ready = false
  let raf = 0
  let live = null

  // Rows arrive one insert at a time — thousands of them for a subscription
  // this size — so the emit is coalesced onto a frame instead of re-rendering
  // three plates per row.
  const emit = () => {
    if (dead || raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      if (dead) return
      ask()
      // Same habit as `window.__atlas.diag()`: what actually arrived, askable
      // from a console rather than guessed at.
      window.__previews = { repos: repos.size, nodes: nodes.size, cov: cov.size, asked }
      onChange({ repos: [...repos.values()], nodes, cov })
    })
  }

  const bind = (handle, store, keyOf) => {
    if (!handle) return
    handle.onInsert?.((_c, row) => { store.set(keyOf(row), row); emit() })
    handle.onUpdate?.((_c, _o, row) => { store.set(keyOf(row), row); emit() })
    handle.onDelete?.((_c, row) => { store.delete(keyOf(row)); emit() })
  }

  /**
   * Ask for the nodes, once, as soon as the roster can name three plates.
   *
   * NOT straight off the subscription's `onApplied`. The row inserts and the
   * applied callback do not have a guaranteed order, and when applied lands
   * first the pick runs against an empty table, finds nothing to draw and never
   * asks again — three dashed frames, no error, forever. `onApplied` therefore
   * only raises `ready`; the pick itself happens in the coalescing frame, by
   * which point every row delivered in that tick is already in hand.
   *
   * `ready` also has to mean COVERAGE has arrived, not just the repo list.
   * `choose` sorts explored repositories to the front, and picking before the
   * `node_cov` rows land would sort against an empty tape — the exact bug the
   * ordering note above describes, one table over. Both are in one
   * subscription, so one `onApplied` covers both.
   */
  const ask = () => {
    if (asked || !live || !ready) return
    const rows = [...repos.values()].map((r) => ({
      id: String(r.id),
      slug: String(r.slug || ''),
      n: Number(r.nodeCount ?? r.node_count ?? 0),
    }))
    const chosen = choose(rows, covCounts(cov))
    if (!chosen.length) return
    asked = true
    // Only the nodes. The coverage for every repository is already here — it is
    // one row per file anybody has ever opened, across the whole database, and
    // that is a smaller table than one mid-sized repo's file list.
    const q = chosen.map((c) => `SELECT * FROM node WHERE repo_id = ${c.id}`)
    try {
      live.subscriptionBuilder().onApplied(emit).onError(emit).subscribe(q)
    } catch { /* the frames stay dashed, which is what they mean */ }
  }

  let token
  try { token = localStorage.getItem('map-room-token') || undefined } catch { token = undefined }

  try {
    conn = DbConnection.builder()
      .withUri(STDB_URI)
      .withDatabaseName(STDB_MODULE)
      .withToken(token)
      .onConnect((connection, _identity, tok) => {
        if (dead) { try { connection.disconnect() } catch { /* noop */ } ; return }
        try { if (tok) localStorage.setItem('map-room-token', tok) } catch { /* private mode */ }
        bind(connection.db?.repo, repos, (r) => String(r.id))
        live = connection
        bind(connection.db?.node, nodes, (r) => String(r.id))
        bind(connection.db?.nodeCov || connection.db?.node_cov, cov, (r) => String(r.nodeId ?? r.node_id))

        connection.subscriptionBuilder()
          .onApplied(() => { ready = true; emit() })
          // A tape that never arrives must not leave three dashed frames
          // forever: pick without it rather than not at all.
          .onError(() => { ready = true; emit() })
          .subscribe(['SELECT * FROM repo', 'SELECT * FROM node_cov'])
      })
      .onConnectError(() => emit())
      .build()
  } catch {
    emit()
  }

  return () => {
    dead = true
    if (raf) cancelAnimationFrame(raf)
    try { conn?.disconnect?.() } catch { /* noop */ }
  }
}

export default function PreviewMaps() {
  const hostRef = useRef(null)
  const [near, setNear] = useState(false)
  const [feed, setFeed] = useState(null)

  // Nothing connects until the section is nearly on screen.
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return undefined }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { setNear(true); io.disconnect() }
    }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!near) return undefined
    return watchPreviews(setFeed)
  }, [near])

  const cards = useMemo(() => {
    if (!feed) return []
    const rows = feed.repos.map((r) => ({
      id: String(r.id),
      slug: String(r.slug || ''),
      n: Number(r.nodeCount ?? r.node_count ?? 0),
      e: Number(r.edgeCount ?? r.edge_count ?? 0),
    }))
    return choose(rows, covCounts(feed.cov))
  }, [feed])

  return (
    <div className="fn-previews" ref={hostRef}>
      {(cards.length ? cards : [null, null, null]).map((c, i) => (
        <Preview key={c ? c.id : `p${i}`} card={c} feed={feed} />
      ))}
    </div>
  )
}

/** One repository, drawn. */
function Preview({ card, feed }) {
  const plate = useMemo(() => {
    if (!card || !feed) return null
    const mine = []
    for (const n of feed.nodes.values()) if (String(n.repoId ?? n.repo_id) === card.id) mine.push(n)
    if (mine.length < 4) return null

    const territory = buildTerritory(mine, new Map(), null)
    const atlas = buildAtlas(territory.files)
    const district = atlas.blocks.length > DISTRICT_AT
    const drawn = district ? atlas.dblocks : atlas.blocks
    if (!drawn.length) return null

    // Coverage, rolled up to whatever a block stands for. A district is as warm
    // as the most recently read file in it, which is the same rule the room's
    // own zoomed-out level uses.
    const now = Date.now()
    const atOf = new Array(drawn.length).fill(0)
    for (const c of feed.cov.values()) {
      if (String(c.repoId ?? c.repo_id) !== card.id) continue
      const fi = territory.byNode.get(String(c.nodeId ?? c.node_id))
      if (fi == null) continue
      const bi = district ? atlas.byDistrict.get(territory.files[fi].district) : atlas.byFile.get(fi)
      if (bi == null) continue
      const t = millis(c.lastAt ?? c.last_at)
      if (t > atOf[bi]) atOf[bi] = t
    }

    const b = boundsOf(drawn)
    const order = drawn.map((_, i) => i).sort((x, y) => (drawn[x].gx + drawn[x].gy) - (drawn[y].gx + drawn[y].gy))

    /**
     * WHERE THE PREVIEW LOOKS.
     *
     * A whole repo fitted into a thumbnail is a field of two-pixel specks — the
     * shape is there and nothing is readable, which is the opposite of what a
     * preview is for. So the frame is a CAMERA, the way the room's own camera
     * is: it sits over the part of the plate the agent has actually been on,
     * and it is close enough that a block is a block. The rest of the city runs
     * off the edges, which is a fair thing for a window onto a map to do — the
     * whole plate is one click away.
     */
    let cx = 0, cy = 0, n = 0
    for (let i = 0; i < drawn.length; i += 1) {
      if (!atOf[i]) continue
      const bl = drawn[i]
      const c = P(bl.gx + bl.w / 2, bl.gy + bl.d / 2, 0)
      cx += c[0]; cy += c[1]; n += 1
    }
    if (n) { cx /= n; cy /= n } else { cx = (b.x0 + b.x1) / 2; cy = (b.y0 + b.y1) / 2 }
    // A FIXED window, not a fraction of the plate: every preview is drawn at the
    // same zoom, so a block in flask is the same size as a block in hono and the
    // three frames can be compared by eye. What differs between them is how much
    // city runs off the edge, which is the honest way to show a size difference.
    const fullW = b.x1 - b.x0
    const w = Math.min(fullW + 60, 1900)
    const h = w * 0.75
    // Never look off the edge of the plate when the plate is bigger than the frame.
    cx = Math.min(Math.max(cx, b.x0 + w / 2), Math.max(b.x0 + w / 2, b.x1 - w / 2))
    cy = Math.min(Math.max(cy, b.y0 + h / 2), Math.max(b.y0 + h / 2, b.y1 - h / 2))

    return {
      drawn,
      order,
      atOf,
      now,
      lit: atOf.filter((t) => t > 0).length,
      district,
      view: `${cx - w / 2} ${cy - h / 2} ${w} ${h}`,
    }
  }, [card, feed])

  const open = useCallback(() => { if (card) window.location.href = baseLink(card.slug) }, [card])

  if (!card) return <div className="fn-preview fn-pending" aria-hidden="true"><div className="fn-plate" /></div>

  return (
    <button type="button" className="fn-preview" onClick={open}>
      <div className="fn-plate">
        {plate ? (
          <svg viewBox={plate.view} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <HatchDefs ns={`pv${card.id}`} />
            {plate.order.map((i) => {
              const bl = plate.drawn[i]
              const at = plate.atOf[i]
              const colour = at ? stateColour(at, false, plate.now, false) : null
              return (
                <g key={bl.id}>
                  {bodyOf(bl, {
                    ns: `pv${card.id}`,
                    sw: 1.1,
                    ghost: !colour,
                    fill: colour || 'none',
                    fillOpacity: colour ? 0.58 : 1,
                  })}
                </g>
              )
            })}
          </svg>
        ) : (
          <span className="fn-plate-wait">reading the graph…</span>
        )}
      </div>
      <span className="fn-slug">{card.slug}</span>
      <span className="fn-facts">
        <span className="fn-num">{card.n.toLocaleString()} files</span>
        <span className="fn-num">{card.e.toLocaleString()} edges</span>
        {plate && plate.lit > 0 && (
          <span className="fn-num">{plate.lit.toLocaleString()} {plate.district ? 'directories' : 'files'} explored</span>
        )}
      </span>
    </button>
  )
}
