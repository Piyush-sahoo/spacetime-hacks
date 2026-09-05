import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useRoom } from '../lib/room.jsx'
import { P, pts, boundsOf, gridRange, hopPath, pointAt } from '../lib/iso'
import { hopsOf } from '../lib/route'
import { NEUTRAL_SLOT, slotColor } from '../lib/actors'

/**
 * THE MAP — a repo as an isometric plate, and an agent's route across it.
 *
 * Two bugs are ported here on purpose, both of them the reference author's
 * hard-won findings, and both of them invisible until you hit them:
 *
 *  1. HIT-TESTING LIVES ON THE <svg>, NOT ON THE BLOCK. Any re-render while the
 *     pointer is down can detach the very <g> under the cursor between
 *     pointerdown and pointerup, and the browser then never synthesises a click
 *     on it — click-to-pin silently does nothing, intermittently, forever. So
 *     selection runs off pointerdown/pointerup with a 3px drag threshold, and
 *     the hover highlight is CSS `:hover` (see `.node > .hl` in index.css)
 *     rather than a state change.
 *  2. POINTER CAPTURE IS DEFERRED UNTIL A DRAG ACTUALLY STARTS. Capturing on
 *     pointerdown retargets the eventual click to the <svg>, away from the
 *     block, which is the same failure wearing a different hat.
 *
 * And one invariant: GEOMETRY IS A PURE FUNCTION OF THE GRAPH. `atlas` is
 * memoised on the territory alone. Coverage, touches and presence change only
 * fill, stroke and what is drawn ON the ground. `window.__atlas.probe()` exists
 * to prove it — a block's screen position across a coverage change must be
 * 0.000000px.
 */

const HALO_MS = 2400
const MIN_K = 0.35
const MAX_K = 3
const FIT_MIN = 0.2
const FIT_MAX = 1.5

// ── block primitives ────────────────────────────────────────────────────────
// All of them are the same `box(z0, z1, hatchTop)` three times over: left face,
// right face, top. Side faces always carry the 45° hatch; only slab and job
// hatch their tops.

function faces(b, z0, z1, hatchTop, fill, fillOpacity, sw, ghost, kk) {
  const { gx, gy, w, d } = b
  const dash = ghost ? '4 3' : undefined
  const quads = [
    [P(gx, gy + d, z0), P(gx + w, gy + d, z0), P(gx + w, gy + d, z1), P(gx, gy + d, z1)],
    [P(gx + w, gy, z0), P(gx + w, gy + d, z0), P(gx + w, gy + d, z1), P(gx + w, gy, z1)],
    [P(gx, gy, z1), P(gx + w, gy, z1), P(gx + w, gy + d, z1), P(gx, gy + d, z1)],
  ]
  const out = []
  quads.forEach((q, i) => {
    const p = pts(q)
    out.push(
      <polygon
        key={`${kk}f${i}`}
        points={p}
        fill={fill}
        fillOpacity={fillOpacity}
        stroke="var(--ink)"
        strokeWidth={sw}
        strokeLinejoin="round"
        strokeDasharray={dash}
      />
    )
    if (ghost) return
    const hatch = i < 2 ? 'hatch' : hatchTop
    if (hatch) {
      out.push(
        <polygon key={`${kk}h${i}`} points={p} fill={`url(#${hatch})`} style={{ color: 'var(--ink)' }} stroke="none" />
      )
    }
  })
  return out
}

function bodyOf(b, fill, fillOpacity, sw, ghost) {
  const { gx, gy, w, d, h, kind } = b
  if (kind === 'store') {
    // three stacked drums — data, config, bindings
    const L = 3, gap = 3, lh = (h - gap * (L - 1)) / L
    const out = []
    for (let i = 0; i < L; i += 1) out.push(...faces(b, i * (lh + gap), i * (lh + gap) + lh, null, fill, fillOpacity, sw, ghost, `s${i}`))
    return out
  }
  if (kind === 'cards') {
    // a deck of five thin slabs — a directory of tests
    const L = 5, lh = h / L
    const out = []
    for (let i = 0; i < L; i += 1) out.push(...faces(b, i * lh, (i + 1) * lh, null, fill, fillOpacity, sw, ghost, `c${i}`))
    return out
  }
  if (kind === 'slab') return faces(b, 0, h, 'hatchLight', fill, fillOpacity, sw, ghost, 'sl')
  if (kind === 'job') return faces(b, 0, h, 'hatchLight', fill, fillOpacity, sw, ghost, 'jb')
  if (kind === 'screen') {
    const out = faces(b, 0, h, null, fill, fillOpacity, sw, ghost, 'sc')
    if (ghost) return out
    const inset = 0.3
    const scr = [
      P(gx + inset, gy + inset, h), P(gx + w - inset, gy + inset, h),
      P(gx + w - inset, gy + d - inset, h), P(gx + inset, gy + d - inset, h),
    ]
    out.push(<polygon key="scr" points={pts(scr)} fill="var(--paper)" stroke="var(--ink)" strokeWidth={0.9} />)
    for (let i = 1; i <= 3; i += 1) {
      const a = P(gx + inset + 0.2, gy + inset + i * 0.4, h)
      const c = P(gx + w - inset - 0.4 - (i === 3 ? 0.5 : 0), gy + inset + i * 0.4, h)
      out.push(<line key={`sl${i}`} x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="var(--ink)" strokeWidth={0.8} opacity={0.7} />)
    }
    return out
  }
  if (kind === 'gate') {
    const out = faces(b, 0, h, null, fill, fillOpacity, sw, ghost, 'gt')
    if (ghost) return out
    const z0 = h * 0.55, z1 = h * 0.75
    const band = [
      [P(gx, gy + d, z0), P(gx + w, gy + d, z0), P(gx + w, gy + d, z1), P(gx, gy + d, z1)],
      [P(gx + w, gy, z0), P(gx + w, gy + d, z0), P(gx + w, gy + d, z1), P(gx + w, gy, z1)],
    ]
    band.forEach((q, i) => out.push(<polygon key={`bd${i}`} points={pts(q)} fill="var(--ink)" opacity={0.85} stroke="none" />))
    return out
  }
  if (kind === 'tall') {
    const out = faces(b, 0, h, null, fill, fillOpacity, sw, ghost, 'tl')
    if (ghost) return out
    const a = P(gx, gy + d, h), c = P(gx + w, gy, h)
    out.push(<line key="ridge" x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="var(--ink)" strokeWidth={0.8} opacity={0.5} />)
    return out
  }
  return faces(b, 0, h, null, fill, fillOpacity, sw, ghost, 'bx')
}

/**
 * One block.
 *
 * Memoised on primitives only, so a coverage tick re-renders the handful of
 * blocks that actually changed and walks past the other 2,973.
 */
const Block = memo(function Block({ b, lit, colour, sel, fresh }) {
  const ghost = !lit
  const sw = sel ? 2 : 1.2
  const fill = ghost ? 'none' : (colour || 'var(--face)')
  const fo = ghost ? 1 : (colour ? 0.42 : 1)
  const { gx, gy, w, d, h } = b
  const top = [P(gx, gy, h), P(gx + w, gy, h), P(gx + w, gy + d, h), P(gx, gy + d, h)]
  const c = P(gx + w / 2, gy + d / 2, h)
  return (
    <g className={`node${sel ? ' sel' : ''}`} data-id={b.id} style={{ cursor: 'pointer' }}>
      {bodyOf(b, fill, fo, sw, ghost)}
      <polygon
        className="hl"
        points={pts(top)}
        fill={sel ? 'var(--ink)' : 'none'}
        opacity={sel ? 0.12 : 1}
        stroke="var(--ink)"
        strokeWidth={sel ? 2.5 : 1.8}
      />
      {fresh && !sel && (
        <polygon
          className="halo"
          points={pts([P(gx - 0.35, gy - 0.35, 0), P(gx + w + 0.35, gy - 0.35, 0), P(gx + w + 0.35, gy + d + 0.35, 0), P(gx - 0.35, gy + d + 0.35, 0)])}
          fill="none"
          stroke={colour || 'var(--ink)'}
          strokeWidth={1.6}
          strokeDasharray="4 3"
        />
      )}
      <rect x={c[0] - 8} y={c[1] - 8} width={16} height={14} fill={sel ? 'var(--hi-bg)' : 'var(--paper)'} stroke="var(--ink)" strokeWidth={1} />
      <text x={c[0]} y={c[1] + 3} textAnchor="middle" fontSize="9" fill={sel ? 'var(--hi-fg)' : 'var(--ink)'} fontWeight="600">
        {b.code}
      </text>
    </g>
  )
})

/** The paper-backed name tag under the front corner. Doubled labelling: the
 *  code chip says which district, the tag says which file. */
const Tag = memo(function Tag({ b, lit, sel }) {
  const p = P(b.gx + b.w, b.gy + b.d, 0)
  const txt = String(b.short || b.name).toUpperCase()
  const w = txt.length * 6.6 + 10
  const y = p[1] + 9
  const dim = !lit
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={p[0] - w / 2} y={y} width={w} height={14}
        fill={sel ? 'var(--hi-bg)' : 'var(--paper)'}
        stroke={dim ? 'var(--ghost)' : 'var(--ink)'}
        strokeWidth={0.9}
        strokeDasharray={dim ? '3 2' : undefined}
      />
      <text
        x={p[0]} y={y + 10.5} textAnchor="middle" fontSize="9" letterSpacing=".06em"
        fill={sel ? 'var(--hi-fg)' : (dim ? 'var(--ink-2)' : 'var(--ink)')} fontWeight="500"
      >
        {txt}
      </text>
    </g>
  )
})

// ── the component ───────────────────────────────────────────────────────────

export default function Atlas({
  handle, scope, selected, onSelect, onDrill, playing, cursor, onStepPick,
}) {
  const { atlas, coverage, territory, routes, timeline, requestsByFile } = useRoom()
  const svgRef = useRef(null)
  const worldRef = useRef(null)
  const pktRef = useRef(null)
  const tipRef = useRef(null)
  const cam = useRef({ tx: 0, ty: 0, k: 1 })
  const tween = useRef(null)
  const rafRef = useRef(0)
  const packets = useRef([])
  const stats = useRef({ paints: 0, ms: 0, max: 0, ticks: 0 })
  const frameRef = useRef(() => {})
  const [box, setBox] = useState({ w: 0, h: 0 })

  // ── what is on the plate ──────────────────────────────────────────────────
  const scene = useMemo(() => {
    if (scope && atlas.byDistrict.has(scope)) {
      const di = atlas.byDistrict.get(scope)
      const d = atlas.districts[di]
      return {
        level: 'file',
        blocks: d.files.map((fi) => atlas.blocks[atlas.byFile.get(fi)]),
        plates: [d],
      }
    }
    if (atlas.full) return { level: 'file', blocks: atlas.blocks, plates: atlas.districts }
    // Too many files to draw one block each: the same city at a coarser grain.
    // Same coordinates, so drilling in never teleports anything.
    return { level: 'district', blocks: atlas.dblocks, plates: [] }
  }, [atlas, scope])

  /** file index -> the block that stands for it in THIS scene. */
  const blockByFile = useMemo(() => {
    const m = new Int32Array(atlas.files.length).fill(-1)
    if (scene.level === 'file') {
      scene.blocks.forEach((b, i) => { m[b.fi] = i })
    } else {
      scene.blocks.forEach((b, i) => { for (const fi of atlas.districts[b.di].files) m[fi] = i })
    }
    return m
  }, [scene, atlas])

  const indexById = useMemo(() => new Map(scene.blocks.map((b, i) => [b.id, i])), [scene])

  const nodeToBlock = useCallback((nodeId) => {
    const fi = territory.byNode.get(String(nodeId))
    if (fi === undefined) return null
    const bi = blockByFile[fi]
    return bi < 0 ? null : scene.blocks[bi]
  }, [territory, blockByFile, scene])

  // ── coverage, possibly rewound ────────────────────────────────────────────
  // Scrubbing the timeline back un-lights whatever was lit after that step.
  // Still read entirely off subscribed rows — the cursor only chooses how much
  // of the same tape to believe.
  const rewound = useMemo(() => {
    if (cursor == null) return null
    const allow = new Set()
    const touched = new Set()
    timeline.forEach((s, i) => {
      const fi = territory.byNode.get(s.nodeId)
      if (fi === undefined) return
      touched.add(fi)
      if (i < cursor) allow.add(fi)
    })
    return { allow, touched }
  }, [cursor, timeline, territory])

  /** per-scene-block: is it lit, whose colour, when did it light. */
  const paint = useMemo(() => {
    const n = scene.blocks.length
    const lit = new Uint8Array(n)
    const slot = new Int8Array(n).fill(NEUTRAL_SLOT)
    const at = new Float64Array(n)
    const asked = new Uint8Array(n)
    const seen = (fi) => {
      if (!coverage.lit[fi]) return false
      if (!rewound) return true
      return rewound.allow.has(fi) || !rewound.touched.has(fi)
    }
    for (let fi = 0; fi < atlas.files.length; fi += 1) {
      const bi = blockByFile[fi]
      if (bi < 0) continue
      if (requestsByFile.has(fi) && requestsByFile.get(fi).status !== 'done') asked[bi] = 1
      if (!seen(fi)) continue
      lit[bi] = 1
      if (coverage.at[fi] > at[bi]) { at[bi] = coverage.at[fi]; slot[bi] = coverage.slot[fi] }
    }
    return { lit, slot, at, asked }
  }, [scene, blockByFile, coverage, rewound, atlas, requestsByFile])

  // The one hue. `slotColor` returns null for the neutral slot, and the neutral
  // slot is the only thing an offline session can ever resolve to.
  const colourOfSlot = slotColor

  // ── new this moment ───────────────────────────────────────────────────────
  // A block that lit within the last couple of seconds wears a pulsing dashed
  // halo. It has to expire, so the newest ignition schedules exactly one timer.
  const [nowMs, setNow] = useState(() => Date.now())
  const newest = useMemo(() => {
    let m = 0
    for (let i = 0; i < paint.at.length; i += 1) if (paint.at[i] > m) m = paint.at[i]
    return m
  }, [paint])
  useEffect(() => {
    setNow(Date.now())
    const left = newest + HALO_MS - Date.now()
    if (left <= 0) return undefined
    const t = setTimeout(() => setNow(Date.now()), left + 40)
    return () => clearTimeout(t)
  }, [newest])

  // ── routes ────────────────────────────────────────────────────────────────
  const drawn = useMemo(() => {
    const cut = cursor == null ? Infinity : cursor
    const keep = new Set(timeline.slice(0, cut === Infinity ? timeline.length : cut).map((s) => s.id))
    return routes.map((r) => {
      const clipped = cursor == null ? r : { ...r, steps: r.steps.filter((s) => keep.has(s.id)) }
      const hops = hopsOf(clipped, (s) => nodeToBlock(s.nodeId))
      const paths = hops.map((h) => ({ ...h, path: hopPath(h.from, h.to, h.bend) }))
      return { route: r, hops: paths }
    }).filter((x) => x.hops.length)
  }, [routes, timeline, cursor, nodeToBlock])

  const liveDrawn = useMemo(() => drawn.filter((d) => d.route.slot >= 0), [drawn])

  // ── camera ────────────────────────────────────────────────────────────────
  const applyView = useCallback(() => {
    const c = cam.current
    worldRef.current?.setAttribute('transform', `translate(${c.tx},${c.ty}) scale(${c.k})`)
  }, [])

  /**
   * The wake.
   *
   * The draw loop is not a loop: `frame` re-arms itself only while a camera
   * tween or a packet is still moving, and otherwise lets the chain end. A map
   * nobody is touching and nothing is animating must cost the machine nothing —
   * idle CPU was 63% before this discipline existed. Anything that changes what
   * should be on screen calls `wake()`, including a subscription arrival, so a
   * touch landing paints without waiting for a mouse move.
   */
  const wake = useCallback(() => {
    if (rafRef.current === 0) rafRef.current = requestAnimationFrame(frameRef.current)
  }, [])

  const setView = useCallback((tx, ty, k, anim) => {
    tween.current = null
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (anim && !reduce) {
      tween.current = { a: { ...cam.current }, b: { tx, ty, k }, t0: performance.now(), dur: 520 }
      wake()
    } else {
      cam.current = { tx, ty, k }
      applyView()
    }
  }, [applyView, wake])

  const fit = useCallback((anim, blocks) => {
    const list = blocks || scene.blocks
    if (!box.w || !list.length) return
    const b = boundsOf(list)
    const pad = 44
    const k = Math.min((box.w - pad * 2) / Math.max(1, b.x1 - b.x0), (box.h - pad * 2) / Math.max(1, b.y1 - b.y0))
    if (!Number.isFinite(k) || k <= 0) return
    const kk = Math.max(FIT_MIN, Math.min(k, FIT_MAX))
    setView(box.w / 2 - ((b.x0 + b.x1) / 2) * kk, box.h / 2 - ((b.y0 + b.y1) / 2) * kk + 8, kk, anim)
  }, [box, scene, setView])

  const zoomAt = useCallback((f, cx, cy) => {
    tween.current = null
    const c = cam.current
    const nk = Math.max(MIN_K, Math.min(MAX_K, c.k * f))
    c.tx = cx - (cx - c.tx) * (nk / c.k)
    c.ty = cy - (cy - c.ty) * (nk / c.k)
    c.k = nk
    applyView()
  }, [applyView])

  const focusBlock = useCallback((b, anim = true) => {
    if (!b || !box.w) return
    const c = P(b.gx + b.w / 2, b.gy + b.d / 2, b.h / 2)
    setView(box.w / 2 - c[0] * cam.current.k, box.h / 2 - c[1] * cam.current.k, cam.current.k, anim)
  }, [box, setView])

  // ── measure ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = svgRef.current?.parentElement
    if (!el) return undefined
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBox({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setBox({ w: Math.round(r.width), h: Math.round(r.height) })
    return () => ro.disconnect()
  }, [])

  // Fit once per (scene, box) — never on a coverage tick, or the ground moves.
  const fitTag = `${scope || ''}|${scene.level}|${scene.blocks.length}|${box.w}x${box.h}`
  const fitted = useRef('')
  useEffect(() => {
    if (!box.w || !scene.blocks.length) return
    if (fitted.current === fitTag) return
    const first = fitted.current === ''
    fitted.current = fitTag
    fit(!first)
  }, [fitTag, box, scene, fit])

  // ── packets: the agent, riding its own route ──────────────────────────────
  // One per LIVE route only. A route nobody is walking any more is a drawn line,
  // not a moving dot — which is also what lets the rAF chain park.
  useEffect(() => {
    packets.current = liveDrawn.map((d) => ({ key: d.route.key, hop: 0, t: 0, speed: 0.55, pause: 0.4 }))
  }, [liveDrawn])

  const drawPackets = useCallback(() => {
    const g = pktRef.current
    if (!g) return
    const kids = g.childNodes
    packets.current.forEach((p, i) => {
      const d = liveDrawn[i]
      const node = kids[i]
      if (!d || !node) return
      const h = d.hops[p.hop % d.hops.length]
      if (!h) return
      const [x, y] = pointAt(h.path, p.t)
      node.setAttribute('transform', `translate(${x},${y})`)
      const lbl = node.querySelector('text')
      if (lbl && lbl.textContent !== h.step.tool) lbl.textContent = h.step.tool
    })
  }, [liveDrawn])

  const lastTs = useRef(0)
  useEffect(() => {
    frameRef.current = (ts) => {
      rafRef.current = 0
      stats.current.ticks += 1
      const dt = Math.min(0.05, (ts - lastTs.current) / 1000 || 0)
      lastTs.current = ts

      const tw = tween.current
      if (tw) {
        let u = Math.min(1, (performance.now() - tw.t0) / tw.dur)
        u = 1 - (1 - u) ** 3
        cam.current = {
          tx: tw.a.tx + (tw.b.tx - tw.a.tx) * u,
          ty: tw.a.ty + (tw.b.ty - tw.a.ty) * u,
          k: tw.a.k + (tw.b.k - tw.a.k) * u,
        }
        applyView()
        if (u >= 1) tween.current = null
      }

      let moving = false
      if (playing) {
        packets.current.forEach((p, i) => {
          const d = liveDrawn[i]
          if (!d || !d.hops.length) return
          moving = true
          if (p.pause > 0) { p.pause -= dt; return }
          const h = d.hops[p.hop % d.hops.length]
          p.t += dt * p.speed * (320 / Math.max(120, h.path.len))
          if (p.t >= 1) {
            p.t = 0
            p.hop = (p.hop + 1) % d.hops.length
            p.pause = p.hop === 0 ? 1.2 : 0.35
          }
        })
        if (moving) drawPackets()
      }

      if (tween.current || moving) rafRef.current = requestAnimationFrame(frameRef.current)
    }
    // A subscription arrival, a resize, a scene change: paint now, do not wait
    // for a mouse move.
    drawPackets()
    wake()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [playing, liveDrawn, drawPackets, applyView, wake])

  useEffect(() => { applyView() }, [applyView, scene])

  // ── pointer ───────────────────────────────────────────────────────────────
  const drag = useRef(null)
  const lastTap = useRef({ id: null, t: 0 })

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    tween.current = null
    const hit = e.target.closest ? e.target.closest('g.node,g.pkt') : null
    const isPkt = !!hit && hit.classList.contains('pkt')
    drag.current = {
      x: e.clientX, y: e.clientY, tx: cam.current.tx, ty: cam.current.ty,
      moved: false, pid: e.pointerId,
      pkt: isPkt ? Number(hit.dataset.i) : null,
      id: hit && !isPkt ? hit.dataset.id : null,
    }
  }, [])

  const onPointerMove = useCallback((e) => {
    const d = drag.current
    const svg = svgRef.current
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (!d.moved) {
        if (Math.hypot(dx, dy) <= 3) return
        d.moved = true
        svg.classList.add('dragging')
        // Deferred on purpose: capturing on pointerdown retargets the click.
        try { svg.setPointerCapture(d.pid) } catch { /* not captureable */ }
        tipRef.current.style.display = 'none'
      }
      cam.current.tx = d.tx + dx
      cam.current.ty = d.ty + dy
      applyView()
      return
    }
    // Tooltip is imperative: a hover must never re-render the canvas.
    const hit = e.target.closest ? e.target.closest('g.node') : null
    const tip = tipRef.current
    if (!hit) { tip.style.display = 'none'; return }
    const bi = indexById.get(hit.dataset.id)
    if (bi === undefined) { tip.style.display = 'none'; return }
    const b = scene.blocks[bi]
    const lit = paint.lit[bi]
    const n = scene.level === 'district'
      ? `${b.count} files`
      : `${b.count} symbol${b.count === 1 ? '' : 's'}`
    tip.textContent = `${b.name} — ${lit ? 'explored' : 'never opened'} · ${n}`
    tip.style.display = 'block'
    const r = svgRef.current.getBoundingClientRect()
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14
    if (x + 290 > r.width) x -= 300
    if (y + 60 > r.height) y -= 70
    tip.style.left = `${x}px`
    tip.style.top = `${y}px`
  }, [applyView, scene, paint, indexById])

  const onPointerUp = useCallback(() => {
    const d = drag.current
    drag.current = null
    svgRef.current?.classList.remove('dragging')
    if (!d || d.moved) return // a pan, not a tap
    if (d.pkt != null) {
      const dd = liveDrawn[d.pkt]
      const p = packets.current[d.pkt]
      if (dd && p) onStepPick?.(dd.hops[p.hop % dd.hops.length].step)
      return
    }
    if (d.id == null) { onSelect?.(null); return }
    const now = performance.now()
    if (scene.level === 'district' && lastTap.current.id === d.id && now - lastTap.current.t < 400) {
      lastTap.current = { id: null, t: 0 }
      const b = scene.blocks[indexById.get(d.id) ?? -1]
      if (b) { onDrill?.(b.district); return }
    }
    lastTap.current = { id: d.id, t: now }
    onSelect?.(d.id)
  }, [liveDrawn, onSelect, onDrill, onStepPick, scene, indexById])

  const onWheel = useCallback((e) => {
    e.preventDefault()
    const r = svgRef.current.getBoundingClientRect()
    zoomAt(e.deltaY < 0 ? 1.1 : 0.9, e.clientX - r.left, e.clientY - r.top)
  }, [zoomAt])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return undefined
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // ── the handle the shell drives ───────────────────────────────────────────
  useImperativeHandle(handle, () => ({
    fit: (anim = true) => fit(anim),
    zoom: (f) => zoomAt(f, box.w / 2, box.h / 2),
    focusDistrict: (name) => {
      if (scene.level === 'district') {
        const b = scene.blocks.find((x) => x.district === name)
        focusBlock(b)
      } else {
        const di = atlas.byDistrict.get(name)
        if (di == null) return
        fit(true, atlas.districts[di].files.map((fi) => atlas.blocks[atlas.byFile.get(fi)]))
      }
    },
    focusNode: (nodeId) => focusBlock(nodeToBlock(nodeId)),
    blockOfNode: nodeToBlock,
  }), [fit, zoomAt, box, scene, atlas, focusBlock, nodeToBlock])

  // ── the drawing ───────────────────────────────────────────────────────────
  const t0 = performance.now()
  const [ga, gb] = useMemo(() => gridRange(scene.blocks), [scene])
  const grid = useMemo(() => {
    const out = []
    for (let i = ga; i <= gb; i += 2) {
      const a = P(i, ga), b = P(i, gb)
      out.push(<line key={`v${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--grid)" strokeWidth={0.6} />)
      const c = P(ga, i), d = P(gb, i)
      out.push(<line key={`h${i}`} x1={c[0]} y1={c[1]} x2={d[0]} y2={d[1]} stroke="var(--grid)" strokeWidth={0.6} />)
    }
    return out
  }, [ga, gb])

  const painterOrder = useMemo(
    () => scene.blocks.map((b, i) => i).sort((a, b) => {
      const A = scene.blocks[a], B = scene.blocks[b]
      return (A.gx + A.gy + A.w + A.d) - (B.gx + B.gy + B.w + B.d)
    }),
    [scene]
  )

  useEffect(() => {
    const ms = performance.now() - t0
    stats.current.paints += 1
    stats.current.ms += ms
    if (ms > stats.current.max) stats.current.max = ms
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__atlas = {
      /** THE STABILITY PROOF. Screen position of a block, to six decimals. */
      probe: (idOrPath) => {
        const i = scene.blocks.findIndex(
          (x) => x.id === idOrPath || x.path === idOrPath || x.name === idOrPath || x.district === idOrPath
        )
        if (i < 0) return null
        const b = scene.blocks[i]
        const c = cam.current
        const p = P(b.gx + b.w / 2, b.gy + b.d / 2, b.h)
        return {
          id: b.id, name: b.name, gx: b.gx, gy: b.gy, h: b.h,
          sx: p[0] * c.k + c.tx, sy: p[1] * c.k + c.ty,
          lit: paint.lit[i], slot: paint.slot[i], k: c.k,
        }
      },
      diag: () => ({
        parked: rafRef.current === 0,
        level: scene.level,
        blocks: scene.blocks.length,
        districts: atlas.districts.length,
        routes: routes.length,
        liveRoutes: liveDrawn.length,
        steps: timeline.length,
        hops: drawn.reduce((a, d) => a + d.hops.length, 0),
        lit: paint.lit.reduce((a, x) => a + x, 0),
        ticks: stats.current.ticks,
        paints: stats.current.paints,
        avgMs: stats.current.paints ? stats.current.ms / stats.current.paints : 0,
        maxMs: stats.current.max,
        k: cam.current.k, box,
      }),
      reset: () => { stats.current = { paints: 0, ms: 0, max: 0, ticks: 0 } },
      wake,
    }
  })

  const selBlock = selected && selected.kind === 'block' ? selected.id : null
  const showTags = scene.blocks.length <= 700

  return (
    <>
      <svg
        ref={svgRef}
        id="svg"
        xmlns="http://www.w3.org/2000/svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { if (tipRef.current) tipRef.current.style.display = 'none' }}
      >
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1.1" />
          </pattern>
          <pattern id="hatchLight" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="currentColor" strokeWidth=".8" opacity=".55" />
          </pattern>
        </defs>
        <g id="world" ref={worldRef}>
          <g opacity={0.55}>{grid}</g>

          {/* district plates — dashed, because a district is a boundary, not a thing */}
          <g>
            {scene.plates.map((d) => {
              const q = [P(d.gx, d.gy), P(d.gx + d.w, d.gy), P(d.gx + d.w, d.gy + d.h), P(d.gx, d.gy + d.h)]
              const a = P(d.gx, d.gy)
              return (
                <g key={d.name} style={{ pointerEvents: 'none' }}>
                  <polygon points={pts(q)} fill="none" stroke="var(--ink)" strokeWidth={0.9} opacity={0.5} strokeDasharray="5 4" />
                  <text x={a[0]} y={a[1] - 6} textAnchor="middle" fontSize="9.5" letterSpacing=".14em" fill="var(--ink-2)">
                    {`${d.code} · ${String(d.name).toUpperCase()}`}
                  </text>
                </g>
              )
            })}
          </g>

          {/* the route, on the ground plane, under everything that stands up */}
          <g>
            {drawn.map((d) => {
              const col = d.route.colour || 'var(--ink)'
              const dead = d.route.slot < 0
              return (
                <g key={d.route.key}>
                  {d.hops.map((h) => (
                    <g key={`${h.i}-${h.from.id}-${h.to.id}`}>
                      <polyline
                        points={pts(h.path.scr)}
                        fill="none"
                        stroke={col}
                        strokeWidth={dead ? 1 : 1.8}
                        opacity={dead ? 0.45 : 1}
                        strokeDasharray={dead ? '3 3' : undefined}
                      />
                      {h.path.scr.slice(1, -1).map((p, j) => (
                        <polygon
                          key={j}
                          points={pts([[p[0], p[1] - 3.5], [p[0] + 3.5, p[1]], [p[0], p[1] + 3.5], [p[0] - 3.5, p[1]]])}
                          fill={col}
                          opacity={dead ? 0.45 : 1}
                        />
                      ))}
                    </g>
                  ))}
                </g>
              )
            })}
          </g>

          {/* blocks, painter's order: back of the plate first */}
          <g>
            {painterOrder.map((i) => {
              const b = scene.blocks[i]
              return (
                <Block
                  key={b.id}
                  b={b}
                  lit={!!paint.lit[i]}
                  colour={colourOfSlot(paint.slot[i])}
                  sel={selBlock === b.id}
                  fresh={paint.at[i] > 0 && nowMs - paint.at[i] < HALO_MS}
                />
              )
            })}
          </g>

          {/* labels above every block, so a tag is never buried by a neighbour */}
          {showTags && (
            <g>
              {scene.blocks.map((b, i) => (
                <Tag key={b.id} b={b} lit={!!paint.lit[i]} sel={selBlock === b.id} />
              ))}
            </g>
          )}

          {/* asked-for regions: dashed ink ring on the ground */}
          <g style={{ pointerEvents: 'none' }}>
            {scene.blocks.map((b, i) => (paint.asked[i] ? (
              <polygon
                key={`a${b.id}`}
                className="halo"
                points={pts([P(b.gx - 0.6, b.gy - 0.6, 0), P(b.gx + b.w + 0.6, b.gy - 0.6, 0), P(b.gx + b.w + 0.6, b.gy + b.d + 0.6, 0), P(b.gx - 0.6, b.gy + b.d + 0.6, 0)])}
                fill="none"
                stroke="var(--ink)"
                strokeWidth={1.2}
                strokeDasharray="2 3"
              />
            ) : null))}
          </g>

          {/* the packets. THE PACKET IS THE AGENT. */}
          <g ref={pktRef}>
            {liveDrawn.map((d, i) => (
              <g key={d.route.key} className="pkt lbl-on" data-i={i} style={{ cursor: 'pointer' }}>
                <circle r={5.5} fill={d.route.colour || 'var(--ink)'} stroke="var(--paper)" strokeWidth={1.6} />
                <g className="lbl">
                  <rect x={7} y={-19} width={64} height={14} fill="var(--paper)" stroke="var(--ink)" strokeWidth={0.8} />
                  <text x={10} y={-8} fontSize="10" fill="var(--ink)" fontWeight="500">·</text>
                </g>
              </g>
            ))}
          </g>
        </g>
      </svg>
      <div id="tip" ref={tipRef} />
    </>
  )
}
