import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P, pts, boundsOf, hopPath, pointAt, codeAt, kindOfDir, shortLabel } from '../lib/iso'
import { STATE_LIVE, STATE_COLD, STATE_NEW, STATE_EDITED, MAIN_COLOR } from '../lib/actors'
import { HatchDefs, bodyOf, roofOf, ringOf, FACE_CLASS, HATCH_CLASS } from './isoblocks.jsx'

/**
 * THE HERO — a map, lighting up.
 *
 * WHERE THE GROUND COMES FROM, said plainly, because the page says it too:
 * this is a DEMONSTRATION, not a live feed. The geography is real — every path
 * below is a file in this repository, in the directory it actually lives in,
 * standing at a height taken from its real line count — and the walk over it is
 * scripted. A live map is one click away in the gallery and one paste away in
 * the form; neither can be relied on to be *doing something* in the three
 * seconds a visitor looks at the top of a page, and a map that never moves
 * would argue against the product rather than for it.
 *
 * So: real geography, scripted illumination, and a caption that says exactly
 * that. Nothing here is captioned as live.
 *
 * WHAT IT COSTS. One `requestAnimationFrame` loop, and it does not exist unless
 * the map is on screen: an `IntersectionObserver` starts it on entry and
 * cancels it on exit, and `visibilitychange` cancels it for a backgrounded tab.
 * Inside the loop nothing re-renders — React draws the city once and the walk
 * writes attributes onto the handful of nodes whose state actually changed,
 * gated on a per-block signature. Colour is quantised to twelve steps so a
 * cooling block writes twelve times over five seconds instead of three hundred.
 * A typical frame is two attribute writes and one transform.
 *
 * `prefers-reduced-motion` never starts the loop at all. It paints the end of
 * the walk once, statically, and every state the legend names is on the plate.
 */

// ── the ground ──────────────────────────────────────────────────────────────
// Real directories, real filenames, real line counts. A district is a plate of
// `cols × rows` cells on a pitch of 3 grid units, and a cell may be empty —
// which is what the map's own reserved slack looks like.
const PITCH = 3
const FOOT = 2
/** Padding around the plate, in screen units, so no tag or chip is clipped. */
const PAD = 40

/** Line count -> how tall it stands. The map's own rule: log, or one file owns the sky. */
const heightOf = (loc) => Math.max(22, Math.min(78, Math.round(14 + (Math.log2(1 + loc) - 5) * 9)))

const D_LIB = {
  dir: 'client/src/lib', cols: 2, rows: 2,
  cells: [['actors.js', 233], ['iso.js', 514], ['live.js', 488], ['room.jsx', 763]],
}
const D_COMPONENTS = {
  dir: 'client/src/components', cols: 3, rows: 2,
  cells: [
    ['Atlas.jsx', 1275], ['Landing.jsx', 354], ['Projects.jsx', 131],
    ['Room.jsx', 292], null, ['HeroMap.jsx', 430, true],
  ],
}
const D_BINDINGS = {
  dir: 'client/src/module_bindings', cols: 2, rows: 2,
  cells: [['node_cov_table.ts', 21], ['repo_table.ts', 21], ['touch_table.ts', 22]],
}
const D_HOOKS = {
  dir: 'plugin/scripts', cols: 2, rows: 2,
  cells: [['map_room.py', 1008], ['post_tool_use.py', 242], ['stop.py', 249]],
}

/** Four districts, packed round the origin the way the map packs a repo. */
const CITY_WIDE = [
  { ...D_LIB, gx: 0, gy: 0 },
  { ...D_COMPONENTS, gx: 10.5, gy: 0 },
  { ...D_BINDINGS, gx: 0, gy: 10.5 },
  { ...D_HOOKS, gx: 10.5, gy: 10.5 },
]

/**
 * THE SAME MAP, AT A PHONE'S SCALE.
 *
 * An isometric plate is 2:1 by construction, so the full city on a 390px screen
 * puts every block at 26 screen pixels and the letters come off. That is not a
 * hero, it is a thumbnail of one. So a narrow viewport gets fewer districts on
 * the same grid at the same pitch — the map's own level-of-detail answer, and
 * the one the room already uses when it draws a 695-district repo as a skyline.
 * Nothing is squashed and nothing is cropped: there is simply less city, and
 * every block on it is a third bigger.
 */
const CITY_NARROW = [
  { ...D_LIB, gx: 0, gy: 0 },
  // Placed so its centre sits on the same screen column as the district above
  // it: on a portrait screen the plate wants to be square, and two districts on
  // the iso diagonal are not. `gy = gx + 1.5` is what puts them nose to tail.
  { ...D_COMPONENTS, gx: 7, gy: 8.5 },
]

/**
 * The walk. What an agent asked to change this very page would actually read:
 * in at the landing component, out through the live wire into the room, down
 * into the projection, across to the hook that reports the tool calls, and back
 * to write the new file and edit the page that shows it.
 */
const WALK_WIDE = [
  ['client/src/components/Landing.jsx', 'read'],
  ['client/src/lib/live.js', 'read'],
  ['client/src/lib/room.jsx', 'read'],
  ['client/src/module_bindings/repo_table.ts', 'read'],
  ['client/src/lib/iso.js', 'read'],
  ['client/src/components/Atlas.jsx', 'read'],
  ['client/src/module_bindings/node_cov_table.ts', 'read'],
  ['plugin/scripts/post_tool_use.py', 'read'],
  ['plugin/scripts/map_room.py', 'read'],
  ['client/src/lib/actors.js', 'read'],
  ['client/src/components/HeroMap.jsx', 'new'],
  ['client/src/components/Landing.jsx', 'edit'],
]

const WALK_NARROW = [
  ['client/src/components/Landing.jsx', 'read'],
  ['client/src/lib/live.js', 'read'],
  ['client/src/lib/room.jsx', 'read'],
  ['client/src/lib/iso.js', 'read'],
  ['client/src/components/Atlas.jsx', 'read'],
  ['client/src/lib/actors.js', 'read'],
  ['client/src/components/HeroMap.jsx', 'new'],
  ['client/src/components/Landing.jsx', 'edit'],
]

const STEP_MS = 620
/** How long the packet takes to cross one hop — under a step, so it arrives and waits. */
const HOP_MS = 400
/** Green to red. The map's real clock is fifteen minutes; a demonstration cannot wait. */
const COOL_MS = 5000
/** The ignition ring on a block that has only just been read. */
const HALO_MS = 900
/** How long the finished walk is held before the plate goes dark and it runs again. */
const HOLD_MS = 2800
/** Colour is quantised so a cooling block repaints twelve times, not three hundred. */
const FADE_STEPS = 12

const LIVE_RGB = [34, 197, 94]
const COLD_RGB = [239, 68, 68]
/** Built once, read every frame. */
const COOL = Array.from({ length: FADE_STEPS + 1 }, (_, i) => {
  const u = i / FADE_STEPS
  const c = LIVE_RGB.map((a, j) => Math.round(a + (COLD_RGB[j] - a) * u))
  return `rgb(${c[0]},${c[1]},${c[2]})`
})

/** A whole scene: the ground, the walk over it, and the box it is drawn in. */
function makeScene(city, walk) {
  const blocks = []
  const plates = []
  city.forEach((d, di) => {
    const code = codeAt(di)
    const kind = kindOfDir(d.dir)
    plates.push({
      name: d.dir, code, gx: d.gx, gy: d.gy,
      w: d.cols * PITCH + 1, h: d.rows * PITCH + 1,
    })
    d.cells.forEach((cell, i) => {
      if (!cell) return
      const [name, loc, isNew] = cell
      blocks.push({
        id: `${d.dir}/${name}`,
        district: d.dir,
        code,
        kind,
        name,
        short: shortLabel(name),
        newLand: !!isNew,
        gx: d.gx + 0.5 + (i % d.cols) * PITCH,
        gy: d.gy + 0.5 + Math.floor(i / d.cols) * PITCH,
        w: FOOT,
        d: FOOT,
        h: heightOf(loc),
      })
    })
  })
  // Painter's order: back of the plate first, so a block in front overlaps the
  // one behind it rather than the other way round.
  const order = blocks.map((_, i) => i)
    .sort((a, b) => (blocks[a].gx + blocks[a].gy) - (blocks[b].gx + blocks[b].gy))

  const byPath = new Map(blocks.map((x, i) => [x.id, i]))
  const steps = walk.map(([path, act]) => ({ i: byPath.get(path), act })).filter((s) => s.i != null)
  // The hop each step rides in on — the same path builder the map's routes use,
  // so a hero's wire and a room's route can never disagree about how one bends.
  const hops = steps.map((s, n) => {
    if (n === 0) return null
    const from = blocks[steps[n - 1].i]
    const to = blocks[s.i]
    return from === to ? null : hopPath(from, to, n % 2 ? 'xy' : 'yx')
  })

  // The box the plate is drawn in. It has to hold three things, and leaving any
  // of them out crops something a viewer can see go missing: the blocks; the
  // district letters, which sit on the plate's east corner — the one bit of open
  // ground every district is guaranteed to have, since the reserved slack is
  // always at the end of the grid; and the hops, whose right-angle bend is a
  // corner of a grid rectangle and therefore lands OUTSIDE the screen-space
  // diamond its two endpoints span.
  const LABEL_M = 30
  const b = boundsOf(blocks)
  let x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1
  for (const pl of plates) {
    const a = P(pl.gx + pl.w, pl.gy)
    x0 = Math.min(x0, a[0] - LABEL_M); x1 = Math.max(x1, a[0] + LABEL_M)
    y0 = Math.min(y0, a[1] - LABEL_M); y1 = Math.max(y1, a[1] + LABEL_M)
  }
  for (const hop of hops) {
    if (!hop) continue
    for (const p of hop.scr) {
      x0 = Math.min(x0, p[0] - 8); x1 = Math.max(x1, p[0] + 8)
      y0 = Math.min(y0, p[1] - 8); y1 = Math.max(y1, p[1] + 8)
    }
  }
  const view = { x: x0 - PAD, y: y0 - PAD, w: (x1 - x0) + PAD * 2, h: (y1 - y0) + PAD * 2 + 16 }
  const walkMs = steps.length * STEP_MS
  return { blocks, plates, order, view, steps, hops, walkMs, cycleMs: walkMs + HOLD_MS }
}

const SCENES = {
  wide: makeScene(CITY_WIDE, WALK_WIDE),
  narrow: makeScene(CITY_NARROW, WALK_NARROW),
}

/** The ground grid, drawn once per scene. */
function gridLines() {
  const out = []
  const lo = -6, hi = 26
  for (let g = lo; g <= hi; g += 2) {
    const a = P(g, lo), b = P(g, hi), c = P(lo, g), e = P(hi, g)
    out.push(<line key={`gx${g}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--grid)" strokeWidth={1} />)
    out.push(<line key={`gy${g}`} x1={c[0]} y1={c[1]} x2={e[0]} y2={e[1]} stroke="var(--grid)" strokeWidth={1} />)
  }
  return out
}
const GRID = gridLines()

const NARROW_Q = '(max-width: 620px)'

export default function HeroMap() {
  const wrapRef = useRef(null)
  const svgRef = useRef(null)
  const pktRef = useRef(null)
  const wireRef = useRef(null)
  const nodesRef = useRef(null)
  const sigRef = useRef([])
  const rafRef = useRef(0)
  const startRef = useRef(0)
  const [arrived, setArrived] = useState(false)
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(NARROW_Q).matches
  )
  // The label scale. Tags and chips are drawn at a constant SIZE ON SCREEN
  // rather than a constant size in world units, which is the only way a 390px
  // phone and a 1200px desktop both get a legible map out of one plate.
  const [k, setK] = useState(1)

  const still = useMemo(() => (
    typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ), [])

  const scene = narrow ? SCENES.narrow : SCENES.wide
  const { blocks, plates, order, view, steps, hops, walkMs, cycleMs } = scene

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia(NARROW_Q)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  /** Collect the nodes the walk writes to. Done once per scene, after it mounts. */
  const collect = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return null
    const out = blocks.map((b) => {
      const g = svg.querySelector(`g.hm-b[data-id="${CSS.escape(b.id)}"]`)
      if (!g) return null
      return {
        faces: g.querySelectorAll(`.${FACE_CLASS}`),
        hatch: g.querySelectorAll(`.${HATCH_CLASS}`),
        edge: g.querySelector('.hm-edge'),
        halo: g.querySelector('.hm-halo'),
        land: g.querySelectorAll('.hm-land'),
        tag: svg.querySelector(`g.hm-tag[data-id="${CSS.escape(b.id)}"]`),
      }
    })
    nodesRef.current = out
    sigRef.current = []
    return out
  }, [blocks])

  /**
   * Paint one block into one state. Called only when its signature changed — a
   * block that has been red for two seconds costs nothing.
   */
  const paint = useCallback((i, st) => {
    const n = nodesRef.current?.[i]
    if (!n) return
    for (const f of n.faces) {
      f.setAttribute('fill', st.fill)
      f.setAttribute('fill-opacity', st.fo)
      if (st.dark) f.setAttribute('stroke-dasharray', '4 3')
      else f.removeAttribute('stroke-dasharray')
    }
    for (const h of n.hatch) h.setAttribute('opacity', st.dark ? '0' : '1')
    if (n.edge) n.edge.setAttribute('opacity', st.standing ? '1' : '0')
    if (n.halo) {
      n.halo.setAttribute('opacity', st.halo ? '1' : '0')
      if (st.halo) n.halo.setAttribute('stroke', st.fill)
    }
    for (const l of n.land) l.setAttribute('opacity', st.land ? '1' : '0')
    if (n.tag) n.tag.setAttribute('class', st.dark ? 'hm-tag' : 'hm-tag on')
  }, [])

  /** Everything the plate looks like at `t` ms into the cycle. */
  const frame = useCallback((t) => {
    if (!(nodesRef.current || collect())) return
    const upto = Math.min(steps.length, Math.floor(t / STEP_MS))
    const last = new Array(blocks.length).fill(-1)
    const edited = new Array(blocks.length).fill(false)
    const born = new Array(blocks.length).fill(false)
    for (let n = 0; n < upto; n += 1) {
      const s = steps[n]
      last[s.i] = n * STEP_MS
      if (s.act === 'edit') edited[s.i] = true
      if (s.act === 'new') born[s.i] = true
    }
    const standing = upto > 0 ? steps[upto - 1].i : -1

    for (let i = 0; i < blocks.length; i += 1) {
      const at = last[i]
      let st
      if (at < 0) {
        st = { fill: 'none', fo: 1, dark: true, standing: false, halo: false, land: false }
      } else {
        const age = t - at
        // Blue beats orange beats the clock — the map's own precedence. New
        // ground is a fact about the FILE; cooling is a fact about attention.
        const fill = born[i] ? STATE_NEW
          : edited[i] ? STATE_EDITED
            : COOL[Math.min(FADE_STEPS, Math.floor((age / COOL_MS) * FADE_STEPS))]
        st = {
          fill,
          fo: 0.58,
          dark: false,
          standing: i === standing && t < walkMs + 400,
          halo: age < HALO_MS,
          land: born[i],
        }
      }
      const sig = `${st.fill}|${st.dark}|${st.standing}|${st.halo}|${st.land}`
      if (sigRef.current[i] !== sig) {
        sigRef.current[i] = sig
        paint(i, st)
      }
    }

    // The packet. THE PACKET IS THE AGENT: it rides the hop between the file
    // just read and the one being read now, on the ground plane, in the main
    // agent's ember.
    const pkt = pktRef.current
    const wire = wireRef.current
    const hop = upto > 0 ? hops[upto - 1] : null
    if (pkt && wire) {
      if (!hop || t >= walkMs) {
        pkt.setAttribute('opacity', '0')
        wire.setAttribute('opacity', '0')
      } else {
        const u = Math.min(1, (t - (upto - 1) * STEP_MS) / HOP_MS)
        const p = pointAt(hop, u)
        pkt.setAttribute('opacity', '1')
        pkt.setAttribute('transform', `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`)
        wire.setAttribute('points', pts(hop.scr))
        wire.setAttribute('opacity', (1 - u * 0.55).toFixed(2))
      }
    }
  }, [blocks.length, collect, hops, paint, steps, walkMs])

  const tick = useCallback(() => {
    const now = performance.now()
    if (!startRef.current) startRef.current = now
    frame((now - startRef.current) % cycleMs)
    rafRef.current = requestAnimationFrame(tick)
  }, [cycleMs, frame])

  // ── the loop, and where it parks ─────────────────────────────────────────
  useEffect(() => {
    collect()
    if (still) {
      // Legible and still. The end of the walk, painted once: every state the
      // legend names is on the plate, and nothing moves.
      frame(walkMs + HOLD_MS - 1)
      setArrived(true)
      return undefined
    }
    frame(0)

    let running = false
    const start = () => {
      if (running || document.hidden) return
      running = true
      // The walk restarts from the top when it comes back into view — somebody
      // scrolling back up is asking to see it again.
      startRef.current = 0
      rafRef.current = requestAnimationFrame(tick)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }

    let visible = false
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting)
      if (visible) { setArrived(true); start() } else stop()
    }, { threshold: 0.08 })
    if (wrapRef.current) io.observe(wrapRef.current)

    const onVis = () => { if (document.hidden) stop(); else if (visible) start() }
    document.addEventListener('visibilitychange', onVis)

    // Proof, for anybody who wants it, that the loop is not running when the
    // map is not on screen.
    if (typeof window !== 'undefined') window.__hero = { running: () => running }

    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      stop()
    }
  }, [collect, frame, still, tick, walkMs])

  // ── label scale ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setK(w / view.w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [view.w])

  // Level of detail, exactly as the map does it: at a scale where a file tag
  // would sit on top of its neighbour, it is not drawn. The district letters
  // never go — they are the key, and the key is printed under the plate — so a
  // 390px phone gets a map it can read rather than a shrunken one.
  const showTags = k >= 0.42
  const inv = 1 / Math.max(k, 0.0001)

  return (
    <div
      ref={wrapRef}
      className={`hm${arrived ? ' in' : ''}${still ? ' still' : ''}`}
      role="img"
      aria-label={
        'An isometric map of this repository. Every file is a block; blocks light '
        + 'green as an agent reads them and fade to red as they fall out of its context.'
      }
    >
      <svg
        ref={svgRef}
        key={narrow ? 'n' : 'w'}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="hm-svg"
      >
        <HatchDefs ns="hm" />
        <g opacity={0.5}>{GRID}</g>

        {/* district plates — dashed, because a district is a boundary, not a thing */}
        <g>
          {plates.map((d) => (
            <polygon
              key={d.name}
              points={pts([P(d.gx, d.gy), P(d.gx + d.w, d.gy), P(d.gx + d.w, d.gy + d.h), P(d.gx, d.gy + d.h)])}
              fill="none" stroke="var(--ink)" strokeWidth={0.9} opacity={0.45} strokeDasharray="5 4"
            />
          ))}
        </g>

        {/* the hop the agent is on, on the ground plane, under everything standing */}
        <polyline
          ref={wireRef} className="hm-wire" points="" fill="none"
          stroke={MAIN_COLOR} strokeWidth={1.8} opacity={0}
        />

        {/* the city */}
        <g className="hm-city">
          {order.map((i, n) => {
            const b = blocks[i]
            const roof = roofOf(b)
            return (
              <g key={b.id} className="hm-b" data-id={b.id} style={{ animationDelay: `${Math.min(620, n * 42)}ms` }}>
                {bodyOf(b, { ns: 'hm', sw: 1.2, ghost: true, fill: 'none', fillOpacity: 1 })}
                {/* WHO — the actor's edge, drawn on the roof in the main agent's
                    ember while it is standing here. Colour on this map means an
                    agent, and nothing else. */}
                <polygon
                  className="hm-edge" points={pts(roof)} fill="none"
                  stroke={MAIN_COLOR} strokeWidth={2.2} strokeLinejoin="round" opacity={0}
                />
                {/* the ignition halo — a ring on the ground for the moment of the read */}
                <polygon
                  className="hm-halo" points={pts(ringOf(b, 0.35))} fill="none"
                  stroke="var(--ink)" strokeWidth={1.6} strokeDasharray="4 3" opacity={0}
                />
                {/* NEW GROUND KEEPS ITS OWN MARK — dashed, because it is a parcel
                    rather than a building, and unlike the halo it does not expire. */}
                <polygon
                  className="hm-land" points={pts(roof)} fill="none"
                  stroke={STATE_NEW} strokeWidth={1.6} strokeDasharray="3 2.5" opacity={0}
                />
                <polygon
                  className="hm-land" points={pts(ringOf(b, 0.55))} fill="none"
                  stroke={STATE_NEW} strokeWidth={1.4} strokeDasharray="4 3" opacity={0}
                />
              </g>
            )
          })}
        </g>

        {/* the packet. THE PACKET IS THE AGENT. */}
        <g ref={pktRef} className="hm-pkt" opacity={0}>
          <circle r={5} fill={MAIN_COLOR} stroke="var(--paper)" strokeWidth={1.6} />
        </g>

        {/* Labels, at a constant size on screen. Drawn above every block, so a
            tag is never buried by the neighbour standing in front of it. */}
        <g className="hm-labels">
          {plates.map((d) => {
            const a = P(d.gx + d.w, d.gy)
            return (
              <g key={d.name} transform={`translate(${a[0]},${a[1]}) scale(${inv})`}>
                <rect x={-9} y={-8} width={18} height={15} fill="var(--paper)" stroke="var(--ink)" strokeWidth={1.2} />
                <text y={3} textAnchor="middle" fontSize="10" fill="var(--ink)" fontWeight="600">{d.code}</text>
              </g>
            )
          })}
          {showTags && order.map((i) => {
            const b = blocks[i]
            const p = P(b.gx + b.w, b.gy + b.d, 0)
            const txt = String(b.short).toUpperCase()
            const w = txt.length * 6.6 + 10
            return (
              <g
                key={`t${b.id}`} className="hm-tag" data-id={b.id}
                transform={`translate(${p[0]},${p[1]}) scale(${inv})`}
              >
                <rect x={-w / 2} y={7} width={w} height={14} strokeWidth={0.9} />
                <text y={17.5} textAnchor="middle" fontSize="9" letterSpacing=".06em" fontWeight="500">{txt}</text>
              </g>
            )
          })}
        </g>
      </svg>

      {/* The key. Ordnance-survey doubled labelling: a letter on the plate and
          the same letter under it, so a district is identifiable at any scale —
          including the one a phone gets, where a full path drawn on the plate
          would sit on top of its neighbour. */}
      <ul className="hm-key">
        {plates.map((d) => (<li key={d.name}><b>{d.code}</b>{d.name}</li>))}
      </ul>
    </div>
  )
}

/**
 * WHAT THE COLOURS MEAN — the legend, drawn with real blocks.
 *
 * Words alone cannot say what "dashed" looks like, so every row is an actual
 * extruded block from the same primitives the map uses, in the state it names.
 */
const LEGEND = [
  { key: 'dark', fill: null, label: 'Never opened', why: 'Dashed, and hollow. Nobody has looked at it.' },
  { key: 'live', fill: STATE_LIVE, label: 'In context', why: 'Read in the last five minutes.' },
  { key: 'cold', fill: STATE_COLD, label: 'Out of context', why: 'Read, and fallen out of the window since.' },
  { key: 'edit', fill: STATE_EDITED, label: 'Changed', why: 'The agent wrote to it. This one never fades.' },
  { key: 'new', fill: STATE_NEW, label: 'New ground', why: 'Did not exist when the map was cut.' },
]

export function MapLegend() {
  const b = { gx: 0, gy: 0, w: 2, d: 2, h: 34, kind: 'box' }
  const vb = boundsOf([b])
  const view = `${vb.x0 - 6} ${vb.y0 - 6} ${(vb.x1 - vb.x0) + 12} ${(vb.y1 - vb.y0) - 14}`
  return (
    <ul className="hm-legend">
      {LEGEND.map((l) => (
        <li key={l.key}>
          <svg viewBox={view} className="hm-chip" aria-hidden="true">
            <HatchDefs ns={`lg-${l.key}`} />
            {bodyOf(b, {
              ns: `lg-${l.key}`,
              sw: 1.4,
              ghost: !l.fill,
              fill: l.fill || 'none',
              fillOpacity: l.fill ? 0.58 : 1,
            })}
            {l.fill === STATE_NEW && (
              <polygon points={pts(roofOf(b))} fill="none" stroke={STATE_NEW} strokeWidth={1.6} strokeDasharray="3 2.5" />
            )}
          </svg>
          <span className="hm-l-name">{l.label}</span>
          <span className="hm-l-why">{l.why}</span>
        </li>
      ))}
    </ul>
  )
}
